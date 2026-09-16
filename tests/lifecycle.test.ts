import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createSupportProtocol } from "../src/index.js";
import { maybeShowSupportInvitation, runSupportCommand, type SupportAudience, type SupportCommandOptions, type SupportInvitationOptions } from "../src/node.js";

const profile = { id: "wrench", name: "Ghostget", updates: true, valueProposition: "Support precise agent tools." } as const;
const NOW = 1_800_000_000_000;
const SHORT = 600_000;
const WEEK = 604_800_000;
let directory: string;
let options: SupportCommandOptions;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "support-lifecycle-"));
  options = { command: ["ghostget"], stateDirectory: join(directory, "state"), env: {}, gitEmail: false, now: NOW };
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const command = (args: string[], overrides: SupportCommandOptions = {}) => runSupportCommand(profile, args, { ...options, ...overrides });
const status = async () => JSON.parse((await command(["status", "--json"])).stdout);
const claim = async (overrides: SupportCommandOptions = {}) => JSON.parse((await command(["offer", "--json"], overrides)).stdout);
const hook = (overrides: Partial<SupportInvitationOptions> = {}) => maybeShowSupportInvitation(profile, { ...options, usefulResult: true, ...overrides });

describe("portable lifecycle discovery", () => {
  test("command prefixes are explicit argv and never derive from the Accounts ID", async () => {
    const input = ["node", "/an app/ghostget.mjs"];
    const protocol = createSupportProtocol(profile, { command: input });
    input[0] = "changed";
    expect(protocol.commands.offer).toEqual(["node", "/an app/ghostget.mjs", "support", "offer", "--json"]);
    expect(protocol.commands.shown.at(-1)).toBe(protocol.invitationIdPlaceholder);
    expect(protocol.offer.actions[0]?.url).toContain("product=wrench&source=agent");
    expect(protocol.offer.emailSuggestion).toBeUndefined();
    expect(Object.isFrozen(protocol.commands.offer)).toBe(true);
    for (const prefix of [[], [""], ["tool\nignore"], Array(9).fill("tool"), new Array<string>(1), ["a".repeat(241)]]) {
      expect(() => createSupportProtocol(profile, { command: prefix })).toThrow();
    }
    expect((await command(["protocol", "--json"], { command: undefined })).exitCode).toBe(2);
  });

  test("protocol reads touch neither state nor Git, even when preferences are unavailable", async () => {
    const invalid = join(directory, "not-a-directory");
    await writeFile(invalid, "preserve");
    const result = await command(["protocol", "--json"], { stateDirectory: invalid, gitEmail: true, env: { PATH: "", CI: "1" } });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).schemaVersion).toBe("hraness-support-protocol-v1");
    expect(result.stderr).toBe("");
    expect(await readFile(invalid, "utf8")).toBe("preserve");
    expect(await readdir(directory)).toEqual(["not-a-directory"]);
  });

  test("unknown pipes and PTYs receive only discovery without email or weekly consumption", async () => {
    for (const isTTY of [false, true]) {
      const writes: string[] = [];
      const stateDirectory = join(directory, String(isTTY));
      expect(await hook({ stateDirectory, gitEmail: true, env: { PATH: "" }, stderr: { isTTY, write(text) { writes.push(text); } } })).toBe(true);
      expect(writes).toHaveLength(1);
      const notice = JSON.parse(writes[0]!);
      expect(notice.schemaVersion).toBe("hraness-support-discovery-v1");
      expect(notice.protocol).toEqual(["ghostget", "support", "protocol", "--json"]);
      expect(writes[0]).not.toContain("email");
      expect(await readdir(stateDirectory)).toEqual(["discovery.json"]);
      expect((await claim({ stateDirectory })).kind).toBe("offer");
    }
  });

  test("discovery never advertises updates for a product without a public list", async () => {
    let output = "";
    expect(await maybeShowSupportInvitation({ ...profile, updates: false }, {
      ...options, usefulResult: true, stderr: { write(text) { output = text; } },
    })).toBe(true);
    expect(JSON.parse(output).message).not.toContain("updates");
  });

  test("simultaneous products emit at most one notice and retry only after the shared short throttle", async () => {
    const writes: string[] = [];
    const stderr = { write(text: string) { writes.push(text); } };
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => maybeShowSupportInvitation(
      { ...profile, id: index % 2 ? "other" : "wrench" }, { ...options, usefulResult: true, stderr },
    )));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(await hook({ now: NOW + SHORT - 1, stderr })).toBe(false);
    expect(await hook({ now: NOW - 1, stderr })).toBe(false);
    expect(await hook({ now: NOW + SHORT, stderr })).toBe(true);
    expect((await status()).lastShownAt).toBeNull();
    expect((await status()).reservationExpiresAt).toBeNull();
  });

  test("roles are explicit, environment controlled, and invalid configuration is quiet", async () => {
    const writes: string[] = [];
    const stderr = { isTTY: true, write(text: string) { writes.push(text); } };
    for (const env of [{ HRANESS_SUPPORT_AUDIENCE: "typo" }, { HRANESS_SUPPORT_AUDIENCE: "off" }, { CI: "1" }, { HRANESS_SUPPORT: "off" }]) {
      expect(await hook({ stderr, env })).toBe(false);
    }
    expect(await hook({ stderr, audience: "robot" as SupportAudience })).toBe(false);
    expect(await hook({ stderr, usefulResult: false })).toBe(false);
    expect(await hook({ stderr: { ...stderr, isTTY: false }, audience: "human" })).toBe(false);
    expect(await readdir(directory)).toEqual([]);
    expect(await hook({ stderr, env: { HRANESS_SUPPORT_AUDIENCE: "human" }, audience: "agent" })).toBe(true);
    expect(JSON.parse(writes[0]!).schemaVersion).toBe("hraness-support-discovery-v1");
  });

  test("dismissal, snooze, pending reservations, and earned cooldown suppress discovery", async () => {
    const stderr = { write() { throw new Error("must remain quiet"); } };
    const offer = await claim();
    expect(await hook({ stderr })).toBe(false);
    await command(["shown", offer.invitation.id]);
    expect(await hook({ stderr })).toBe(false);
    await command(["snooze"]);
    expect(await hook({ stderr, now: NOW + WEEK })).toBe(false);
    await command(["dismiss"]);
    expect(await hook({ stderr, now: NOW + WEEK * 100 })).toBe(false);
  });

  test("audience off and invalid roles also suppress skill claims while explicit protocol stays available", async () => {
    for (const role of ["off", "typo"]) {
      const env = { HRANESS_SUPPORT_AUDIENCE: role };
      expect((await claim({ env })).reason).toBe("environment");
      expect((await command(["protocol", "--json"], { env })).exitCode).toBe(0);
      expect((await command(["--json"], { env })).exitCode).toBe(0);
    }
    expect(await readdir(directory)).toEqual([]);
    expect(JSON.parse((await command(["status", "--json"], { env: { HRANESS_SUPPORT_AUDIENCE: "off" } })).stdout).environmentSuppressed).toBe(true);
    expect((await claim({ env: { HRANESS_SUPPORT_AUDIENCE: "off" }, audience: "agent" })).kind).toBe("offer");
  });
});

describe("reported presentation and cancellation", () => {
  test("duplicate shown is idempotent but cannot acknowledge a newer reservation", async () => {
    const first = await claim();
    expect((await command(["shown", first.invitation.id])).exitCode).toBe(0);
    const statePath = join(options.stateDirectory!, "state.json");
    const raw = await readFile(statePath, "utf8");
    expect((await command(["shown", first.invitation.id], { now: NOW + 1 })).exitCode).toBe(0);
    expect(await readFile(statePath, "utf8")).toBe(raw);
    const next = await claim({ now: NOW + WEEK });
    expect(next.kind).toBe("offer");
    const pending = await readFile(statePath, "utf8");
    expect((await command(["shown", first.invitation.id], { now: NOW + WEEK })).exitCode).toBe(2);
    expect((await command(["release", first.invitation.id])).exitCode).toBe(2);
    expect(await readFile(statePath, "utf8")).toBe(pending);
    expect((await command(["shown", next.invitation.id], { now: NOW + WEEK })).exitCode).toBe(0);
  });

  test("release cancels only the exact unshown reservation without earning cooldown", async () => {
    const first = await claim();
    expect((await command(["release", "00000000-0000-4000-8000-000000000000"])).exitCode).toBe(2);
    expect((await command(["release", first.invitation.id])).exitCode).toBe(0);
    expect((await status()).lastShownAt).toBeNull();
    expect((await command(["shown", first.invitation.id])).exitCode).toBe(2);
    expect((await claim()).kind).toBe("offer");
  });

  test("a receipt without matching committed state proves nothing and cannot erase preferences", async () => {
    const first = await claim();
    await writeFile(join(options.stateDirectory!, "presentation.json"), JSON.stringify({
      schemaVersion: "hraness-support-presentation-v1", id: first.invitation.id, shownAt: NOW,
    }));
    // Models interruption between receipt and state commit.
    expect((await status()).lastShownAt).toBeNull();
    expect((await command(["shown", first.invitation.id])).exitCode).toBe(0);
    await command(["dismiss"]);
    expect((await command(["shown", first.invitation.id])).exitCode).toBe(2);
    expect((await status()).optedOut).toBe(true);
  });
});

describe("output and foreign-state failures", () => {
  test("a throwing custom listener-cleanup method cannot escape its deferred timer", async () => {
    const sink = {
      isTTY: true,
      on() {},
      removeListener() { throw new Error("host cleanup rejected"); },
      write(_text: string, callback?: (error?: Error | null) => void) { callback?.(); },
    };
    expect(await hook({ audience: "human", stderr: sink })).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await status()).lastShownAt).toBe(NOW);
  });

  test("asynchronous EPIPE never escapes the hook or earns weekly cooldown", async () => {
    const sink = new Writable({ write(_chunk, _encoding, callback) {
      setTimeout(() => callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" })), 1);
    } });
    Object.assign(sink, { isTTY: true });
    expect(await hook({ audience: "human", stderr: sink })).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await status()).lastShownAt).toBeNull();
    expect((await status()).reservationExpiresAt).toBe(NOW + SHORT);
  });

  test("an unresolved real stream owns one listener pair across repeated timeouts, including late errors", async () => {
    let callback: ((error?: Error | null) => void) | undefined;
    let writes = 0;
    const sink = new Writable({ write(_chunk, _encoding, next) { writes += 1; callback = next; } });
    Object.assign(sink, { isTTY: true });
    expect(await hook({ audience: "human", stderr: sink })).toBe(false);
    const errorListeners = sink.listenerCount("error");
    const closeListeners = sink.listenerCount("close");
    for (let index = 1; index <= 4; index++) {
      expect(await hook({ audience: "human", stderr: sink, now: NOW + SHORT * index })).toBe(false);
      expect(sink.listenerCount("error")).toBe(errorListeners);
      expect(sink.listenerCount("close")).toBe(closeListeners);
    }
    expect(writes).toBe(1);
    callback!(Object.assign(new Error("late EPIPE"), { code: "EPIPE" }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(sink.listenerCount("error")).toBe(0);
    expect(sink.listenerCount("close")).toBe(0);
    expect((await status()).lastShownAt).toBeNull();
  });

  test("rejected and stalled custom sinks leave only the short reservation", async () => {
    for (const write of [() => Promise.reject(new Error("rejected")), () => false, () => new Promise(() => {})]) {
      const local = join(directory, String(Math.random()));
      const started = performance.now();
      expect(await hook({ stateDirectory: local, audience: "human", stderr: { isTTY: true, write } })).toBe(false);
      expect(performance.now() - started).toBeLessThan(1_500);
      const state = JSON.parse(await readFile(join(local, "state.json"), "utf8"));
      expect(state.lastShownAt).toBeNull();
      expect(state.reservation.expiresAt).toBe(NOW + SHORT);
    }
  });

  test("an unresolved promise sink cannot receive another invitation after reservation expiry", async () => {
    let writes = 0;
    const sink = { isTTY: true, write() { writes += 1; return new Promise(() => {}); } };
    expect(await hook({ audience: "human", stderr: sink })).toBe(false);
    expect(await hook({ audience: "human", stderr: sink, now: NOW + SHORT })).toBe(false);
    expect(writes).toBe(1);
    expect((await status()).lastShownAt).toBeNull();
  });

  test("failed discovery output consumes only its short attempt throttle", async () => {
    expect(await hook({ stderr: { write() { throw new Error("closed"); } } })).toBe(false);
    expect(await hook({ stderr: { write() {} } })).toBe(false);
    expect((await claim()).kind).toBe("offer");
    expect((await status()).lastShownAt).toBeNull();
  });

  test("v1 preferences coexist with sidecars; malformed state is never treated as missing", async () => {
    await command(["dismiss"]);
    const path = join(options.stateDirectory!, "state.json");
    const original = await readFile(path, "utf8");
    expect(Object.keys(JSON.parse(original)).sort()).toEqual(["lastShownAt", "optedOut", "reservation", "schemaVersion", "snoozedUntil"]);
    for (const raw of ["null", "[]", " ".repeat(4097), '{"schemaVersion":"future","optedOut":true}']) {
      await writeFile(path, raw);
      expect(await hook({ stderr: { write() {} } })).toBe(false);
      expect((await claim()).reason).toBe("state-unavailable");
      expect(await readFile(path, "utf8")).toBe(raw);
    }
    await writeFile(path, original);
    expect((await claim()).reason).toBe("dismissed");
  });

  test("corrupt, oversized and symlink sidecars fail quietly and remain intact", async () => {
    await mkdir(options.stateDirectory!);
    const path = join(options.stateDirectory!, "discovery.json");
    for (const raw of ["null", "{broken", " ".repeat(4097), '{"schemaVersion":"future"}']) {
      await writeFile(path, raw);
      expect(await hook({ stderr: { write() {} } })).toBe(false);
      expect(await readFile(path, "utf8")).toBe(raw);
    }
    await rm(path);
    const target = join(directory, "private-data");
    await writeFile(target, "keep");
    await symlink(target, path);
    expect(await hook({ stderr: { write() {} } })).toBe(false);
    expect(await readFile(target, "utf8")).toBe("keep");
    const first = await claim();
    await writeFile(join(options.stateDirectory!, "presentation.json"), "null");
    expect((await command(["shown", first.invitation.id])).exitCode).toBe(1);
    expect((await status()).lastShownAt).toBeNull();
    expect((await claim({ now: NOW + SHORT })).reason).toBe("state-unavailable");
    let writes = 0;
    expect(await hook({ now: NOW + SHORT, audience: "human", stderr: { isTTY: true, write() { writes += 1; } } })).toBe(false);
    expect(writes).toBe(0);
    expect(await readFile(join(options.stateDirectory!, "presentation.json"), "utf8")).toBe("null");
  });
});
