import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createSupportOffer, createSupportProtocol, renderSupportOffer, type SupportOffer, type SupportProfile } from "./index.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1_000;
const RESERVATION_MS = 10 * 60 * 1_000;
const DISCOVERY_MS = 10 * 60 * 1_000;
const OUTPUT_TIMEOUT_MS = 500;
const pendingOutputs = new WeakMap<SupportOutput, symbol>();
const STATE_SCHEMA = "hraness-support-state-v1";
const RESULT_SCHEMA = "hraness-support-result-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface SupportCommandOptions {
  /** Product-owned executable and fixed prefix arguments before `support`. */
  readonly command?: readonly string[];
  /** Explicit host role wins over HRANESS_SUPPORT_AUDIENCE; off/invalid suppress incidental work. */
  readonly audience?: SupportAudience;
  readonly stateDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Epoch milliseconds; useful for deterministic hosts and tests. */
  readonly now?: number;
  /** Directory whose effective Git configuration supplies the optional suggestion. */
  readonly cwd?: string;
  /** Disable local Git-email suggestions without disabling support invitations. */
  readonly gitEmail?: boolean;
}

export type SupportAudience = "agent" | "human" | "off";

export interface SupportOutput {
  readonly isTTY?: boolean;
  write(text: string, callback?: (error?: Error | null) => void): unknown;
  on?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}

export interface SupportCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SupportInvitationOptions extends SupportCommandOptions {
  /** Set only for a completed, useful operation, never help, probes, or failures. */
  readonly usefulResult: boolean;
  /** Unknown callers, including PTYs, receive discovery. TTY alone never implies a human. */
  readonly stderr?: SupportOutput;
}

interface Reservation {
  id: string;
  createdAt: number;
  expiresAt: number;
}

interface SupportState {
  schemaVersion: typeof STATE_SCHEMA;
  optedOut: boolean;
  snoozedUntil: number | null;
  lastShownAt: number | null;
  reservation: Reservation | null;
}

type QuietReason = "environment" | "dismissed" | "snoozed" | "cooldown" | "reserved" | "busy" | "state-unavailable";
type StateResult<T> = { ok: true; value: T } | { ok: false; reason: "busy" | "state-unavailable" };
type Claim = { kind: "offer"; id: string } | { kind: "quiet"; reason: QuietReason };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseState(value: unknown): SupportState {
  if (!record(value)
    || Object.keys(value).sort().join(",") !== "lastShownAt,optedOut,reservation,schemaVersion,snoozedUntil"
    || value.schemaVersion !== STATE_SCHEMA
    || typeof value.optedOut !== "boolean"
    || (value.snoozedUntil !== null && !timestamp(value.snoozedUntil))
    || (value.lastShownAt !== null && !timestamp(value.lastShownAt))) {
    throw new Error("Invalid support preference state.");
  }
  const reservation = value.reservation;
  if (reservation !== null && (!record(reservation)
    || Object.keys(reservation).sort().join(",") !== "createdAt,expiresAt,id"
    || typeof reservation.id !== "string" || !UUID.test(reservation.id)
    || !timestamp(reservation.createdAt) || !timestamp(reservation.expiresAt)
    || reservation.expiresAt !== reservation.createdAt + RESERVATION_MS)) {
    throw new Error("Invalid support invitation reservation.");
  }
  return value as unknown as SupportState;
}

function initialState(): SupportState {
  return { schemaVersion: STATE_SCHEMA, optedOut: false, snoozedUntil: null, lastShownAt: null, reservation: null };
}

function errorCode(error: unknown): string | undefined {
  return record(error) && typeof error.code === "string" ? error.code : undefined;
}

function currentTime(options: SupportCommandOptions): number {
  const now = options.now ?? Date.now();
  if (!timestamp(now) || now > Number.MAX_SAFE_INTEGER - SNOOZE_MS) throw new Error("Invalid support clock.");
  return now;
}

function stateDirectory(options: SupportCommandOptions): string {
  if (options.stateDirectory !== undefined) return options.stateDirectory;
  const env = options.env ?? process.env;
  const xdg = env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state"), "hraness", "support");
}

function environmentSuppresses(options: SupportCommandOptions): boolean {
  const env = options.env ?? process.env;
  if (audience(options) === "off") return true;
  if (["off", "false", "0"].includes(env.HRANESS_SUPPORT?.trim().toLowerCase() ?? "")) return true;
  return ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "TF_BUILD", "BUILD_NUMBER", "TEAMCITY_VERSION", "JENKINS_URL"]
    .some((name) => {
      const value = env[name]?.trim().toLowerCase();
      return value !== undefined && value !== "" && value !== "false" && value !== "0";
    });
}

function audience(options: SupportCommandOptions): SupportAudience {
  const value = options.audience ?? (options.env ?? process.env).HRANESS_SUPPORT_AUDIENCE;
  if (value === undefined) return "agent";
  return value === "agent" || value === "human" || value === "off" ? value : "off";
}

/** Git configuration is only a convenient default; it does not verify ownership. */
async function withGitEmailSuggestion(offer: SupportOffer, options: SupportCommandOptions): Promise<SupportOffer> {
  const env = options.env ?? process.env;
  if (!offer.actions.some(action => action.kind === "updates") || options.gitEmail === false
    || ["off", "false", "0"].includes(env.HRANESS_SUPPORT_EMAIL?.trim().toLowerCase() ?? "")) return offer;
  const email = await new Promise<string | null>((resolve) => {
    execFile("git", ["config", "--get", "user.email"], {
      cwd: options.cwd,
      env,
      encoding: "utf8",
      timeout: 500,
      killSignal: "SIGKILL",
      maxBuffer: 1_024,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) { resolve(null); return; }
      const candidate = stdout.trim();
      const parts = candidate.split("@");
      const local = parts[0] ?? "";
      const domain = parts[1]?.toLowerCase() ?? "";
      const valid = parts.length === 2 && candidate.length <= 254 && local.length <= 64
        && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u.test(local)
        && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..")
        && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u.test(domain)
        && domain !== "noreply.github.com" && !domain.endsWith(".noreply.github.com")
        && !/^(?:no-?reply|do-?not-?reply)$/iu.test(local);
      resolve(valid ? candidate : null);
    });
  }).catch(() => null);
  return email === null ? offer : Object.freeze({
    ...offer,
    emailSuggestion: Object.freeze({ email, source: "git-config" as const, verified: false as const }),
  });
}

async function readLocalJson(path: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4_096) throw new Error("Invalid support state file.");
    const buffer = Buffer.alloc(4_097);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > 4_096) throw new Error("Oversized support state file.");
    return JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeLocalJson(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(directory, name));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** One nonblocking local lock; never steal a lock whose owner may still be alive. */
async function withState<T>(
  options: SupportCommandOptions,
  action: (state: SupportState, directory: string) => { value: T; changed?: boolean } | Promise<{ value: T; changed?: boolean }>,
): Promise<StateResult<T>> {
  let lock;
  let lockPath: string | undefined;
  try {
    const directory = stateDirectory(options);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    lockPath = join(directory, "state.lock");
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      return { ok: false, reason: errorCode(error) === "EEXIST" ? "busy" : "state-unavailable" };
    }
    const raw = await readLocalJson(join(directory, "state.json"));
    const state = raw === undefined ? initialState() : parseState(raw);
    const result = await action(state, directory);
    if (result.changed) await writeLocalJson(directory, "state.json", state);
    return { ok: true, value: result.value };
  } catch {
    return { ok: false, reason: "state-unavailable" };
  } finally {
    if (lock !== undefined) {
      await lock.close().catch(() => {});
      if (lockPath !== undefined) await unlink(lockPath).catch(() => {});
    }
  }
}

function suppression(state: SupportState, now: number): QuietReason | null {
  if (state.optedOut) return "dismissed";
  if (state.snoozedUntil !== null && now < state.snoozedUntil) return "snoozed";
  if (state.lastShownAt !== null && now < state.lastShownAt + WEEK_MS) return "cooldown";
  if (state.reservation !== null && now < state.reservation.expiresAt) return "reserved";
  return null;
}

async function claimInvitation(options: SupportCommandOptions): Promise<Claim> {
  if (environmentSuppresses(options)) return { kind: "quiet", reason: "environment" };
  let now: number;
  try { now = currentTime(options); } catch { return { kind: "quiet", reason: "state-unavailable" }; }
  const result = await withState<Claim>(options, async (state, directory) => {
    const reason = suppression(state, now);
    if (reason !== null) return { value: { kind: "quiet", reason } };
    await readPresentationReceipt(directory);
    const id = randomUUID();
    state.reservation = { id, createdAt: now, expiresAt: now + RESERVATION_MS };
    return { value: { kind: "offer", id }, changed: true };
  });
  return result.ok ? result.value : { kind: "quiet", reason: result.reason };
}

async function acknowledgeInvitation(id: string, options: SupportCommandOptions): Promise<StateResult<boolean>> {
  const now = currentTime(options);
  return withState(options, (state, directory) => acknowledgeState(state, directory, id, now));
}

async function readPresentationReceipt(directory: string): Promise<{ id: string; shownAt: number } | undefined> {
    const receipt = await readLocalJson(join(directory, "presentation.json"));
    if (receipt !== undefined && (!record(receipt)
      || Object.keys(receipt).sort().join(",") !== "id,schemaVersion,shownAt"
      || receipt.schemaVersion !== "hraness-support-presentation-v1"
      || typeof receipt.id !== "string" || !UUID.test(receipt.id)
      || !timestamp(receipt.shownAt))) throw new Error("Invalid presentation receipt.");
    return receipt as { id: string; shownAt: number } | undefined;
}

async function acknowledgeState(state: SupportState, directory: string, id: string, now: number): Promise<{ value: boolean; changed?: boolean }> {
    const receipt = await readPresentationReceipt(directory);
    const reservation = state.reservation;
    if (state.optedOut || (state.snoozedUntil !== null && now < state.snoozedUntil)) return { value: false };
    if (reservation === null) {
      return { value: receipt !== undefined && receipt.id === id && receipt.shownAt === state.lastShownAt
        && timestamp(receipt.shownAt) && now >= receipt.shownAt && now < receipt.shownAt + WEEK_MS };
    }
    if (reservation.id !== id
      || now < reservation.createdAt || now >= reservation.expiresAt) return { value: false };
    // A receipt is authoritative only while its timestamp matches committed
    // state. Writing it first makes interrupted two-file updates fail closed.
    await writeLocalJson(directory, "presentation.json", {
      schemaVersion: "hraness-support-presentation-v1", id, shownAt: now,
    });
    state.lastShownAt = now;
    state.reservation = null;
    return { value: true, changed: true };
}

async function presentInvitation(id: string, message: string, sink: SupportOutput, options: SupportCommandOptions): Promise<boolean> {
  const now = currentTime(options);
  let output = false;
  await withState(options, async (state, directory) => {
    const reservation = state.reservation;
    if (state.optedOut || (state.snoozedUntil !== null && now < state.snoozedUntil)
      || reservation?.id !== id || now < reservation.createdAt || now >= reservation.expiresAt) return { value: false };
    await readPresentationReceipt(directory);
    // Revalidate after Git discovery, then hold the same lock across bounded
    // output and its receipt. A successful concurrent preference change wins.
    output = await writeOutput(sink, message);
    if (!output) return { value: false };
    return acknowledgeState(state, directory, id, now);
  });
  return output;
}

async function releaseInvitation(id: string, options: SupportCommandOptions): Promise<StateResult<boolean>> {
  return withState(options, state => {
    if (state.reservation?.id !== id) return { value: false };
    state.reservation = null;
    return { value: true, changed: true };
  });
}

async function claimDiscovery(options: SupportCommandOptions): Promise<boolean> {
  const now = currentTime(options);
  const result = await withState(options, async (state, directory) => {
    if (suppression(state, now) !== null) return { value: false };
    await readPresentationReceipt(directory);
    const discovery = await readLocalJson(join(directory, "discovery.json"));
    if (discovery !== undefined) {
      if (!record(discovery) || Object.keys(discovery).sort().join(",") !== "lastAttemptAt,schemaVersion"
        || discovery.schemaVersion !== "hraness-support-discovery-state-v1"
        || !timestamp(discovery.lastAttemptAt)) throw new Error("Invalid discovery state.");
      if (now < discovery.lastAttemptAt + DISCOVERY_MS) return { value: false };
    }
    // This is a delivery-attempt throttle, never a presentation receipt.
    await writeLocalJson(directory, "discovery.json", {
      schemaVersion: "hraness-support-discovery-state-v1", lastAttemptAt: now,
    });
    return { value: true };
  });
  return result.ok && result.value;
}

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function success(value: unknown): SupportCommandResult {
  return { exitCode: 0, stdout: json(value), stderr: "" };
}

function failure(message: string, exitCode = 1): SupportCommandResult {
  return { exitCode, stdout: "", stderr: `${message}\n` };
}

/** Explicit offers always work independently of local preferences; no action opens a browser or pays. */
export async function runSupportCommand(
  profile: SupportProfile,
  args: readonly string[] = [],
  options: SupportCommandOptions = {},
): Promise<SupportCommandResult> {
  try {
    if (args.length === 2 && args[0] === "protocol" && args[1] === "--json") {
      return success(createSupportProtocol(profile, { command: options.command ?? [] }));
    }
    const offer = createSupportOffer(profile, args[0] === "offer" ? "agent" : "cli");
    if (args.length === 0) return { exitCode: 0, stdout: renderSupportOffer(await withGitEmailSuggestion(offer, options)), stderr: "" };
    if (args.length === 1 && args[0] === "--json") return success(await withGitEmailSuggestion(offer, options));
    if (args.length === 2 && args[0] === "offer" && args[1] === "--json") {
      const claim = await claimInvitation(options);
      return success(claim.kind === "offer"
        ? { schemaVersion: RESULT_SCHEMA, kind: "offer", invitation: { id: claim.id, ...await withGitEmailSuggestion(offer, options) } }
        : { schemaVersion: RESULT_SCHEMA, ...claim });
    }
    if (args.length === 2 && args[0] === "shown") {
      if (!UUID.test(args[1] ?? "")) return failure("Support invitation is invalid or expired.", 2);
      const result = await acknowledgeInvitation(args[1]!, options);
      if (!result.ok) return failure(`Support preferences are unavailable (${result.reason}).`);
      if (!result.value) return failure("Support invitation is invalid or expired.", 2);
      return success({ schemaVersion: RESULT_SCHEMA, kind: "shown" });
    }
    if (args.length === 2 && args[0] === "release") {
      if (!UUID.test(args[1] ?? "")) return failure("Support invitation is invalid or expired.", 2);
      const result = await releaseInvitation(args[1]!, options);
      if (!result.ok) return failure(`Support preferences are unavailable (${result.reason}).`);
      if (!result.value) return failure("Support invitation is invalid or expired.", 2);
      return success({ schemaVersion: RESULT_SCHEMA, kind: "released" });
    }
    if (args.length === 2 && args[0] === "status" && args[1] === "--json") {
      const result = await withState(options, (state) => ({ value: {
        schemaVersion: RESULT_SCHEMA,
        kind: "status",
        environmentSuppressed: environmentSuppresses(options),
        optedOut: state.optedOut,
        snoozedUntil: state.snoozedUntil,
        lastShownAt: state.lastShownAt,
        cooldownUntil: state.lastShownAt === null ? null : state.lastShownAt + WEEK_MS,
        reservationExpiresAt: state.reservation?.expiresAt ?? null,
      } }));
      return result.ok ? success(result.value) : failure(`Support preferences are unavailable (${result.reason}).`);
    }
    const command = args[0];
    if (args.length === 1 && (command === "dismiss" || command === "snooze" || command === "enable")) {
      const now = currentTime(options);
      const result = await withState(options, (state) => {
        state.reservation = null;
        if (command === "dismiss") state.optedOut = true;
        else if (command === "snooze") state.snoozedUntil = now + SNOOZE_MS;
        else { state.optedOut = false; state.snoozedUntil = null; }
        return { value: { schemaVersion: RESULT_SCHEMA, kind: command === "dismiss" ? "dismissed" : command === "snooze" ? "snoozed" : "enabled" }, changed: true };
      });
      return result.ok ? success(result.value) : failure(`Support preferences are unavailable (${result.reason}).`);
    }
    return failure("Usage: support [--json | protocol --json | offer --json | shown <id> | release <id> | dismiss | snooze | enable | status --json]", 2);
  } catch {
    return failure("Support configuration is invalid or unavailable.", 2);
  }
}

/** A stream callback reports accepted output, never human reading or consent. */
async function writeOutput(sink: SupportOutput, message: string): Promise<boolean> {
  if (pendingOutputs.has(sink)) return false;
  const operation = Symbol();
  pendingOutputs.set(sink, operation);
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const stream = typeof sink.on === "function" && typeof sink.removeListener === "function";
    const cleanup = () => {
      try { sink.removeListener?.("error", onError); } catch { /* Host output cleanup is best effort. */ }
      try { sink.removeListener?.("close", onClose); } catch { /* Preserve the useful command result. */ }
      if (pendingOutputs.get(sink) === operation) pendingOutputs.delete(sink);
    };
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const finished = (ok: boolean) => {
      settle(ok);
      // Node invokes failed-write callbacks before emitting `error`. Keep the
      // listener through that turn so a broken pipe cannot escape this hook.
      if (stream) setTimeout(cleanup, 0).unref();
      else cleanup();
    };
    const onError = () => finished(false);
    const onClose = () => finished(false);
    timer = setTimeout(() => {
      settle(false);
      // An in-flight stream may emit later. Its one error listener remains
      // until its callback/error/close, without extending this hook's deadline.
    }, OUTPUT_TIMEOUT_MS);
    try {
      if (stream) {
        sink.on!("error", onError);
        sink.on!("close", onClose);
        sink.write(message, error => finished(!error));
      } else {
        const result = sink.write(message);
        Promise.resolve(result).then(value => finished(value !== false), () => finished(false));
      }
    } catch {
      finished(false);
    }
  });
}

/** Best-effort post-success notice. Never call this for failed or merely diagnostic work. */
export async function maybeShowSupportInvitation(
  profile: SupportProfile,
  options: SupportInvitationOptions,
): Promise<boolean> {
  try {
    const stderr = options.stderr ?? process.stderr;
    const target = audience(options);
    if (!options.usefulResult || target === "off" || environmentSuppresses(options)) return false;
    if (target === "agent") {
      const protocol = createSupportProtocol(profile, { command: options.command ?? [] });
      if (!await claimDiscovery(options)) return false;
      return await writeOutput(stderr, json({
        schemaVersion: "hraness-support-discovery-v1",
        optional: true,
        product: protocol.offer.product,
        protocol: protocol.commands.protocol,
        message: `${protocol.offer.actions.some(action => action.kind === "updates") ? "Optional product updates and support are available." : "Optional support is available."} Run the protocol command to see the choices and links; this does not change the current task.`,
      }));
    }
    if (stderr.isTTY !== true) return false;
    const offer = createSupportOffer(profile, "cli");
    const claim = await claimInvitation(options);
    if (claim.kind !== "offer") return false;
    const message = renderSupportOffer(await withGitEmailSuggestion(offer, options));
    return await presentInvitation(claim.id, message, stderr, options);
  } catch {
    return false;
  }
}
