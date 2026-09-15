import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createSupportOffer, renderSupportOffer, type SupportProfile } from "./index.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1_000;
const RESERVATION_MS = 10 * 60 * 1_000;
const STATE_SCHEMA = "hraness-support-state-v1";
const RESULT_SCHEMA = "hraness-support-result-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface SupportCommandOptions {
  readonly stateDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Epoch milliseconds; useful for deterministic hosts and tests. */
  readonly now?: number;
}

export interface SupportCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SupportInvitationOptions extends SupportCommandOptions {
  /** Set only for a completed, useful operation, never help, probes, or failures. */
  readonly usefulResult: boolean;
  readonly stderr?: {
    readonly isTTY?: boolean;
    write(text: string): unknown;
  };
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
  if (["off", "false", "0"].includes(env.HRANESS_SUPPORT?.trim().toLowerCase() ?? "")) return true;
  return ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "TF_BUILD", "BUILD_NUMBER", "TEAMCITY_VERSION", "JENKINS_URL"]
    .some((name) => {
      const value = env[name]?.trim().toLowerCase();
      return value !== undefined && value !== "" && value !== "false" && value !== "0";
    });
}

async function readState(path: string): Promise<SupportState> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4_096) throw new Error("Invalid support state file.");
    return parseState(JSON.parse(await handle.readFile("utf8")) as unknown);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return initialState();
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeState(directory: string, state: SupportState): Promise<void> {
  const temporary = join(directory, `state.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await rename(temporary, join(directory, "state.json"));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** One nonblocking local lock; never steal a lock whose owner may still be alive. */
async function withState<T>(
  options: SupportCommandOptions,
  action: (state: SupportState) => { value: T; changed?: boolean },
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
    const state = await readState(join(directory, "state.json"));
    const result = action(state);
    if (result.changed) await writeState(directory, state);
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

async function claimInvitation(options: SupportCommandOptions): Promise<Claim> {
  if (environmentSuppresses(options)) return { kind: "quiet", reason: "environment" };
  let now: number;
  try { now = currentTime(options); } catch { return { kind: "quiet", reason: "state-unavailable" }; }
  const result = await withState<Claim>(options, (state) => {
    if (state.optedOut) return { value: { kind: "quiet", reason: "dismissed" } };
    if (state.snoozedUntil !== null && now < state.snoozedUntil) return { value: { kind: "quiet", reason: "snoozed" } };
    if (state.lastShownAt !== null && now < state.lastShownAt + WEEK_MS) return { value: { kind: "quiet", reason: "cooldown" } };
    if (state.reservation !== null && now < state.reservation.expiresAt) return { value: { kind: "quiet", reason: "reserved" } };
    const id = randomUUID();
    state.reservation = { id, createdAt: now, expiresAt: now + RESERVATION_MS };
    return { value: { kind: "offer", id }, changed: true };
  });
  return result.ok ? result.value : { kind: "quiet", reason: result.reason };
}

async function acknowledgeInvitation(id: string, options: SupportCommandOptions): Promise<StateResult<boolean>> {
  const now = currentTime(options);
  return withState(options, (state) => {
    const reservation = state.reservation;
    if (state.optedOut || reservation === null || reservation.id !== id
      || now < reservation.createdAt || now >= reservation.expiresAt) return { value: false };
    state.lastShownAt = now;
    state.reservation = null;
    return { value: true, changed: true };
  });
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
    const offer = createSupportOffer(profile, args[0] === "offer" ? "agent" : "cli");
    if (args.length === 0) return { exitCode: 0, stdout: `${renderSupportOffer(offer).trimEnd()}\n`, stderr: "" };
    if (args.length === 1 && args[0] === "--json") return success(offer);
    if (args.length === 2 && args[0] === "offer" && args[1] === "--json") {
      const claim = await claimInvitation(options);
      return success(claim.kind === "offer"
        ? { schemaVersion: RESULT_SCHEMA, kind: "offer", invitation: { id: claim.id, ...offer } }
        : { schemaVersion: RESULT_SCHEMA, ...claim });
    }
    if (args.length === 2 && args[0] === "shown") {
      if (!UUID.test(args[1] ?? "")) return failure("Support invitation is invalid or expired.", 2);
      const result = await acknowledgeInvitation(args[1]!, options);
      if (!result.ok) return failure(`Support preferences are unavailable (${result.reason}).`);
      if (!result.value) return failure("Support invitation is invalid or expired.", 2);
      return success({ schemaVersion: RESULT_SCHEMA, kind: "shown" });
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
    return failure("Usage: support [--json | offer --json | shown <id> | dismiss | snooze | enable | status --json]", 2);
  } catch {
    return failure("Support configuration is invalid or unavailable.", 2);
  }
}

/** Best-effort post-success notice. Never call this for failed or merely diagnostic work. */
export async function maybeShowSupportInvitation(
  profile: SupportProfile,
  options: SupportInvitationOptions,
): Promise<boolean> {
  const stderr = options.stderr ?? process.stderr;
  if (!options.usefulResult || stderr.isTTY !== true || environmentSuppresses(options)) return false;
  try {
    const offer = createSupportOffer(profile, "cli");
    const message = `${renderSupportOffer(offer).trimEnd()}\n`;
    const claim = await claimInvitation(options);
    if (claim.kind !== "offer") return false;
    const acknowledged = await acknowledgeInvitation(claim.id, options);
    if (!acknowledged.ok || !acknowledged.value) return false;
    stderr.write(message);
    return true;
  } catch {
    return false;
  }
}
