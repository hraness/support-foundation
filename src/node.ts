import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  SUPPORT_ASCII_SYMBOLS, SUPPORT_HUMAN_COPY, createSupportOffer, createSupportProtocol, renderSupportOffer,
  type SupportOffer, type SupportProfile,
} from "./index.js";

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
  /**
   * Explicit host role. It wins over HRANESS_AUDIENCE and HRANESS_SUPPORT_AUDIENCE;
   * off/quiet suppress incidental work. Unset, agent markers select agent,
   * an interactive stderr selects human, and anything else stays quiet.
   */
  readonly audience?: SupportAudience;
  /** The stream whose TTY state decides between human and quiet. Defaults to process.stderr. */
  readonly stderr?: SupportOutput;
  readonly stateDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Epoch milliseconds; useful for deterministic hosts and tests. */
  readonly now?: number;
  /** Directory whose effective Git configuration supplies the optional suggestion. */
  readonly cwd?: string;
  /** Disable local Git-email suggestions without disabling support invitations. */
  readonly gitEmail?: boolean;
}

export type SupportAudience = "agent" | "human" | "off" | "quiet";

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
  if (explicitAudience(options) === "off") return true;
  // Products set the support-only variable to off for their own child processes;
  // only an explicit host option overrides that.
  const legacy = env.HRANESS_SUPPORT_AUDIENCE;
  if (options.audience === undefined && legacy !== undefined && legacy !== "agent" && legacy !== "human") return true;
  if (["off", "false", "0"].includes(env.HRANESS_SUPPORT?.trim().toLowerCase() ?? "")) return true;
  return ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "TF_BUILD", "BUILD_NUMBER", "TEAMCITY_VERSION", "JENKINS_URL"]
    .some((name) => {
      const value = env[name]?.trim().toLowerCase();
      return value !== undefined && value !== "" && value !== "false" && value !== "0";
    });
}

type Role = "agent" | "human" | "off";

// TODO(df-0.8): use detectAudience from @hraness/desktop-foundation. This copy
// follows the shared Hraness CLI contract verbatim, because this package must
// not depend on desktop-foundation. Only exact names count as agent markers.
const AGENT_MARKERS = ["AI_AGENT", "CLAUDECODE", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CURSOR_AGENT", "GEMINI_CLI"] as const;

/** A role the host or environment chose on purpose, or undefined to infer one. */
function explicitAudience(options: SupportCommandOptions): Role | undefined {
  const role = (value: string): Role => value === "agent" || value === "human" ? value : "off";
  if (options.audience !== undefined) return role(options.audience);
  const env = options.env ?? process.env;
  const shared = env.HRANESS_AUDIENCE;
  if (shared === "human" || shared === "agent" || shared === "quiet" || shared === "off") return role(shared);
  // Older hosts set the support-only variable; invalid values stay quiet.
  const legacy = env.HRANESS_SUPPORT_AUDIENCE;
  return legacy === undefined ? undefined : role(legacy);
}

/** Explicit role, then agent markers, then human at an interactive stderr, else quiet (off). */
function audience(options: SupportCommandOptions, stderr: SupportOutput = options.stderr ?? process.stderr): Role {
  const explicit = explicitAudience(options);
  if (explicit !== undefined) return explicit;
  const env = options.env ?? process.env;
  if (AGENT_MARKERS.some(name => (env[name] ?? "") !== "")) return "agent";
  return stderr.isTTY === true ? "human" : "off";
}

function asciiOnly(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.HRANESS_ASCII === "1" || env.TERM === "dumb") return true;
  // The first nonempty of LC_ALL, LC_CTYPE, LANG is the effective character locale.
  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(value => (value ?? "") !== "") ?? "";
  return !/utf-?8/iu.test(locale);
}

function symbols(text: string, options: SupportCommandOptions): string {
  if (!asciiOnly(options.env ?? process.env)) return text;
  return Array.from(text, character => SUPPORT_ASCII_SYMBOLS[character] ?? character).join("");
}

function commandText(options: SupportCommandOptions): string {
  const command = options.command ?? [];
  return command.map((part, index) => index === 0 ? part.split(/[\\/]/u).at(-1)! : part).join(" ");
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  // Without a product prefix the command is plain `support …`.
  return (values.command === "" ? template.replaceAll("{command} ", "") : template).replace(/\{(command|product|date|argument)\}/gu, (match, key: string) => values[key] ?? match);
}

function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function supportLine(template: string, profile: SupportProfile, options: SupportCommandOptions, values: Readonly<Record<string, string>> = {}): string {
  return symbols(fill(template, { command: commandText(options), product: profile.name, ...values }), options);
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

type Human = (template: string, values?: Readonly<Record<string, string>>) => string;

/** Human text on stdout; the hint goes to stderr only for a person at a terminal. */
function said(line: string, hint: string | undefined, role: Role): SupportCommandResult {
  return { exitCode: 0, stdout: `${line}\n`, stderr: hint !== undefined && role === "human" ? `${hint}\n` : "" };
}

function stateFailure(reason: "busy" | "state-unavailable", jsonOutput: boolean, human: Human): SupportCommandResult {
  if (jsonOutput) return failure(`Support preferences are unavailable (${reason}).`);
  return failure(human(reason === "busy" ? SUPPORT_HUMAN_COPY.busy : SUPPORT_HUMAN_COPY.unavailable));
}

function argumentText(value: string): string {
  const visible = Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")).slice(0, 40).join("");
  return visible === "" ? "?" : visible;
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
    const human: Human = (template, values) => supportLine(template, profile, options, values);
    if (args.length === 0) return { exitCode: 0, stdout: renderSupportOffer(await withGitEmailSuggestion(offer, options)), stderr: "" };
    if (args.length === 1 && ["-h", "--help", "help"].includes(args[0]!)) {
      return { exitCode: 0, stdout: `${human(SUPPORT_HUMAN_COPY.help)}\n`, stderr: "" };
    }
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
    const command = args[0];
    const flagged = args.length === 2 && args[1] === "--json";
    if ((args.length === 1 || flagged) && (command === "status" || command === "dismiss" || command === "snooze" || command === "enable")) {
      // `--json` always wins; otherwise agents keep JSON and people get one line.
      const role = audience(options);
      const jsonOutput = flagged || role === "agent";
      if (command === "status") {
        const now = currentTime(options);
        const suppressed = environmentSuppresses(options);
        const result = await withState(options, (state) => ({ value: state }));
        if (!result.ok) return stateFailure(result.reason, jsonOutput, human);
        const state = result.value;
        if (jsonOutput) {
          return success({
            schemaVersion: RESULT_SCHEMA,
            kind: "status",
            environmentSuppressed: suppressed,
            optedOut: state.optedOut,
            snoozedUntil: state.snoozedUntil,
            lastShownAt: state.lastShownAt,
            cooldownUntil: state.lastShownAt === null ? null : state.lastShownAt + WEEK_MS,
            reservationExpiresAt: state.reservation?.expiresAt ?? null,
          });
        }
        if (suppressed) return said(human(SUPPORT_HUMAN_COPY.statusEnvironment), undefined, role);
        if (state.optedOut) return said(human(SUPPORT_HUMAN_COPY.statusOff), human(SUPPORT_HUMAN_COPY.hintEnable), role);
        if (state.snoozedUntil !== null && now < state.snoozedUntil) {
          return said(human(SUPPORT_HUMAN_COPY.statusSnoozed, { date: isoDate(state.snoozedUntil) }), human(SUPPORT_HUMAN_COPY.hintEnable), role);
        }
        if (state.lastShownAt !== null && now < state.lastShownAt + WEEK_MS) {
          return said(human(SUPPORT_HUMAN_COPY.statusCooldown, { date: isoDate(state.lastShownAt + WEEK_MS) }), human(SUPPORT_HUMAN_COPY.hintDismiss), role);
        }
        return said(human(SUPPORT_HUMAN_COPY.statusOn), human(SUPPORT_HUMAN_COPY.hintDismiss), role);
      }
      const now = currentTime(options);
      const result = await withState(options, (state) => {
        state.reservation = null;
        if (command === "dismiss") state.optedOut = true;
        else if (command === "snooze") state.snoozedUntil = now + SNOOZE_MS;
        else { state.optedOut = false; state.snoozedUntil = null; }
        return { value: { schemaVersion: RESULT_SCHEMA, kind: command === "dismiss" ? "dismissed" : command === "snooze" ? "snoozed" : "enabled" }, changed: true };
      });
      if (!result.ok) return stateFailure(result.reason, jsonOutput, human);
      if (jsonOutput) return success(result.value);
      if (command === "dismiss") return said(human(SUPPORT_HUMAN_COPY.dismissed), human(SUPPORT_HUMAN_COPY.hintEnable), role);
      if (command === "snooze") return said(human(SUPPORT_HUMAN_COPY.snoozed), human(SUPPORT_HUMAN_COPY.hintEnable), role);
      return said(human(SUPPORT_HUMAN_COPY.enabled), human(SUPPORT_HUMAN_COPY.hintDismiss), role);
    }
    return failure(human(SUPPORT_HUMAN_COPY.unknown, { argument: argumentText(args.join(" ")) }), 2);
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

/** The incidental human invitation: a rule, the offer, and how to hide these. */
function renderInvitation(profile: SupportProfile, offer: SupportOffer, options: SupportCommandOptions): string {
  const optOut = commandText(options) === "" ? SUPPORT_HUMAN_COPY.optOutEnvironment : SUPPORT_HUMAN_COPY.optOut;
  return symbols(`\n${SUPPORT_HUMAN_COPY.rule}\n${renderSupportOffer(offer)}`, options) + `${supportLine(optOut, profile, options)}\n`;
}

/**
 * Best-effort post-success notice. Never call this for failed or merely
 * diagnostic work. People at an interactive stderr get the human invitation,
 * detected agents get one discovery line, and everyone else gets nothing.
 */
export async function maybeShowSupportInvitation(
  profile: SupportProfile,
  options: SupportInvitationOptions,
): Promise<boolean> {
  try {
    const stderr = options.stderr ?? process.stderr;
    const target = audience(options, stderr);
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
    const message = renderInvitation(profile, await withGitEmailSuggestion(offer, options), options);
    return await presentInvitation(claim.id, message, stderr, options);
  } catch {
    return false;
  }
}
