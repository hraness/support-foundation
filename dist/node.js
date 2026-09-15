// src/index.ts
var SOURCES = ["cli", "agent", "web", "desktop", "skill"];
var ACCOUNT_ORIGIN = "https://account.hraness.com";
var UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function plainText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !UNSAFE_TEXT.test(value);
}
function parseSupportProfile(value) {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "id,name,updates,valueProposition" || typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(value.id) || !plainText(value.name, 80) || !plainText(value.valueProposition, 240) || typeof value.updates !== "boolean")
    return null;
  return Object.freeze({
    id: value.id,
    name: value.name,
    valueProposition: value.valueProposition,
    updates: value.updates
  });
}
function createSupportOffer(profile, source) {
  const parsed = parseSupportProfile(profile);
  if (parsed === null || !SOURCES.includes(source)) {
    throw new TypeError("Invalid support profile or source.");
  }
  const destination = new URL("/support", ACCOUNT_ORIGIN);
  destination.searchParams.set("product", parsed.id);
  destination.searchParams.set("source", source);
  const actions = [];
  if (parsed.updates) {
    actions.push(Object.freeze({
      kind: "updates",
      label: `Get free ${parsed.name} product updates`,
      url: `${destination.href}#updates`
    }));
  }
  actions.push(Object.freeze({
    kind: "support",
    label: "Explore optional paid support",
    url: `${destination.href}#support`
  }));
  return Object.freeze({
    schemaVersion: "hraness-support-offer-v1",
    optional: true,
    product: Object.freeze({ id: parsed.id, name: parsed.name }),
    valueProposition: parsed.valueProposition,
    actions: Object.freeze(actions)
  });
}
function renderSupportOffer(offer) {
  return [
    `Optional: ${offer.valueProposition}`,
    ...offer.actions.map((action) => `${action.label}: ${action.url}`),
    ...offer.emailSuggestion ? [
      `Suggested email from Git: ${offer.emailSuggestion.email}. You can use it, change it, or skip updates.`
    ] : [],
    "Payment is optional. Review any recurring price and confirm in your browser."
  ].join(`
`) + `
`;
}

// src/node.ts
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
var WEEK_MS = 7 * 24 * 60 * 60 * 1000;
var SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
var RESERVATION_MS = 10 * 60 * 1000;
var STATE_SCHEMA = "hraness-support-state-v1";
var RESULT_SCHEMA = "hraness-support-result-v1";
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function timestamp(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function parseState(value) {
  if (!record(value) || Object.keys(value).sort().join(",") !== "lastShownAt,optedOut,reservation,schemaVersion,snoozedUntil" || value.schemaVersion !== STATE_SCHEMA || typeof value.optedOut !== "boolean" || value.snoozedUntil !== null && !timestamp(value.snoozedUntil) || value.lastShownAt !== null && !timestamp(value.lastShownAt)) {
    throw new Error("Invalid support preference state.");
  }
  const reservation = value.reservation;
  if (reservation !== null && (!record(reservation) || Object.keys(reservation).sort().join(",") !== "createdAt,expiresAt,id" || typeof reservation.id !== "string" || !UUID.test(reservation.id) || !timestamp(reservation.createdAt) || !timestamp(reservation.expiresAt) || reservation.expiresAt !== reservation.createdAt + RESERVATION_MS)) {
    throw new Error("Invalid support invitation reservation.");
  }
  return value;
}
function initialState() {
  return { schemaVersion: STATE_SCHEMA, optedOut: false, snoozedUntil: null, lastShownAt: null, reservation: null };
}
function errorCode(error) {
  return record(error) && typeof error.code === "string" ? error.code : undefined;
}
function currentTime(options) {
  const now = options.now ?? Date.now();
  if (!timestamp(now) || now > Number.MAX_SAFE_INTEGER - SNOOZE_MS)
    throw new Error("Invalid support clock.");
  return now;
}
function stateDirectory(options) {
  if (options.stateDirectory !== undefined)
    return options.stateDirectory;
  const env = options.env ?? process.env;
  const xdg = env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state"), "hraness", "support");
}
function environmentSuppresses(options) {
  const env = options.env ?? process.env;
  if (["off", "false", "0"].includes(env.HRANESS_SUPPORT?.trim().toLowerCase() ?? ""))
    return true;
  return ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "TF_BUILD", "BUILD_NUMBER", "TEAMCITY_VERSION", "JENKINS_URL"].some((name) => {
    const value = env[name]?.trim().toLowerCase();
    return value !== undefined && value !== "" && value !== "false" && value !== "0";
  });
}
async function withGitEmailSuggestion(offer, options) {
  const env = options.env ?? process.env;
  if (!offer.actions.some((action) => action.kind === "updates") || options.gitEmail === false || ["off", "false", "0"].includes(env.HRANESS_SUPPORT_EMAIL?.trim().toLowerCase() ?? ""))
    return offer;
  const email = await new Promise((resolve) => {
    execFile("git", ["config", "--get", "user.email"], {
      cwd: options.cwd,
      env,
      encoding: "utf8",
      timeout: 500,
      killSignal: "SIGKILL",
      maxBuffer: 1024,
      windowsHide: true
    }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const candidate = stdout.trim();
      const parts = candidate.split("@");
      const local = parts[0] ?? "";
      const domain = parts[1]?.toLowerCase() ?? "";
      const valid = parts.length === 2 && candidate.length <= 254 && local.length <= 64 && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u.test(local) && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..") && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u.test(domain) && domain !== "noreply.github.com" && !domain.endsWith(".noreply.github.com") && !/^(?:no-?reply|do-?not-?reply)$/iu.test(local);
      resolve(valid ? candidate : null);
    });
  }).catch(() => null);
  return email === null ? offer : Object.freeze({
    ...offer,
    emailSuggestion: Object.freeze({ email, source: "git-config", verified: false })
  });
}
async function readState(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096)
      throw new Error("Invalid support state file.");
    return parseState(JSON.parse(await handle.readFile("utf8")));
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return initialState();
    throw error;
  } finally {
    await handle?.close();
  }
}
async function writeState(directory, state) {
  const temporary = join(directory, `state.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 384);
    try {
      await handle.writeFile(`${JSON.stringify(state)}
`, "utf8");
    } finally {
      await handle.close();
    }
    await rename(temporary, join(directory, "state.json"));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
async function withState(options, action) {
  let lock;
  let lockPath;
  try {
    const directory = stateDirectory(options);
    await mkdir(directory, { recursive: true, mode: 448 });
    lockPath = join(directory, "state.lock");
    try {
      lock = await open(lockPath, "wx", 384);
    } catch (error) {
      return { ok: false, reason: errorCode(error) === "EEXIST" ? "busy" : "state-unavailable" };
    }
    const state = await readState(join(directory, "state.json"));
    const result = action(state);
    if (result.changed)
      await writeState(directory, state);
    return { ok: true, value: result.value };
  } catch {
    return { ok: false, reason: "state-unavailable" };
  } finally {
    if (lock !== undefined) {
      await lock.close().catch(() => {});
      if (lockPath !== undefined)
        await unlink(lockPath).catch(() => {});
    }
  }
}
async function claimInvitation(options) {
  if (environmentSuppresses(options))
    return { kind: "quiet", reason: "environment" };
  let now;
  try {
    now = currentTime(options);
  } catch {
    return { kind: "quiet", reason: "state-unavailable" };
  }
  const result = await withState(options, (state) => {
    if (state.optedOut)
      return { value: { kind: "quiet", reason: "dismissed" } };
    if (state.snoozedUntil !== null && now < state.snoozedUntil)
      return { value: { kind: "quiet", reason: "snoozed" } };
    if (state.lastShownAt !== null && now < state.lastShownAt + WEEK_MS)
      return { value: { kind: "quiet", reason: "cooldown" } };
    if (state.reservation !== null && now < state.reservation.expiresAt)
      return { value: { kind: "quiet", reason: "reserved" } };
    const id = randomUUID();
    state.reservation = { id, createdAt: now, expiresAt: now + RESERVATION_MS };
    return { value: { kind: "offer", id }, changed: true };
  });
  return result.ok ? result.value : { kind: "quiet", reason: result.reason };
}
async function acknowledgeInvitation(id, options) {
  const now = currentTime(options);
  return withState(options, (state) => {
    const reservation = state.reservation;
    if (state.optedOut || reservation === null || reservation.id !== id || now < reservation.createdAt || now >= reservation.expiresAt)
      return { value: false };
    state.lastShownAt = now;
    state.reservation = null;
    return { value: true, changed: true };
  });
}
function json(value) {
  return `${JSON.stringify(value)}
`;
}
function success(value) {
  return { exitCode: 0, stdout: json(value), stderr: "" };
}
function failure(message, exitCode = 1) {
  return { exitCode, stdout: "", stderr: `${message}
` };
}
async function runSupportCommand(profile, args = [], options = {}) {
  try {
    const offer = createSupportOffer(profile, args[0] === "offer" ? "agent" : "cli");
    if (args.length === 0)
      return { exitCode: 0, stdout: renderSupportOffer(await withGitEmailSuggestion(offer, options)), stderr: "" };
    if (args.length === 1 && args[0] === "--json")
      return success(await withGitEmailSuggestion(offer, options));
    if (args.length === 2 && args[0] === "offer" && args[1] === "--json") {
      const claim = await claimInvitation(options);
      return success(claim.kind === "offer" ? { schemaVersion: RESULT_SCHEMA, kind: "offer", invitation: { id: claim.id, ...await withGitEmailSuggestion(offer, options) } } : { schemaVersion: RESULT_SCHEMA, ...claim });
    }
    if (args.length === 2 && args[0] === "shown") {
      if (!UUID.test(args[1] ?? ""))
        return failure("Support invitation is invalid or expired.", 2);
      const result = await acknowledgeInvitation(args[1], options);
      if (!result.ok)
        return failure(`Support preferences are unavailable (${result.reason}).`);
      if (!result.value)
        return failure("Support invitation is invalid or expired.", 2);
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
        reservationExpiresAt: state.reservation?.expiresAt ?? null
      } }));
      return result.ok ? success(result.value) : failure(`Support preferences are unavailable (${result.reason}).`);
    }
    const command = args[0];
    if (args.length === 1 && (command === "dismiss" || command === "snooze" || command === "enable")) {
      const now = currentTime(options);
      const result = await withState(options, (state) => {
        state.reservation = null;
        if (command === "dismiss")
          state.optedOut = true;
        else if (command === "snooze")
          state.snoozedUntil = now + SNOOZE_MS;
        else {
          state.optedOut = false;
          state.snoozedUntil = null;
        }
        return { value: { schemaVersion: RESULT_SCHEMA, kind: command === "dismiss" ? "dismissed" : command === "snooze" ? "snoozed" : "enabled" }, changed: true };
      });
      return result.ok ? success(result.value) : failure(`Support preferences are unavailable (${result.reason}).`);
    }
    return failure("Usage: support [--json | offer --json | shown <id> | dismiss | snooze | enable | status --json]", 2);
  } catch {
    return failure("Support configuration is invalid or unavailable.", 2);
  }
}
async function maybeShowSupportInvitation(profile, options) {
  const stderr = options.stderr ?? process.stderr;
  if (!options.usefulResult || stderr.isTTY !== true || environmentSuppresses(options))
    return false;
  try {
    const offer = createSupportOffer(profile, "cli");
    const claim = await claimInvitation(options);
    if (claim.kind !== "offer")
      return false;
    const message = renderSupportOffer(await withGitEmailSuggestion(offer, options));
    const acknowledged = await acknowledgeInvitation(claim.id, options);
    if (!acknowledged.ok || !acknowledged.value)
      return false;
    stderr.write(message);
    return true;
  } catch {
    return false;
  }
}
export {
  runSupportCommand,
  maybeShowSupportInvitation
};
