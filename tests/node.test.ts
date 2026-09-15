import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeShowSupportInvitation, runSupportCommand, type SupportCommandOptions } from "../src/node.js";
import type { SupportProfile } from "../src/index.js";

const profile: SupportProfile = {
  id: "example",
  name: "Example",
  updates: true,
  valueProposition: "Help keep Example available and improving.",
};
const otherProfile: SupportProfile = { ...profile, id: "other", name: "Other" };
const NOW = Date.UTC(2026, 8, 15);
const WEEK = 7 * 24 * 60 * 60 * 1_000;
const MONTH = 30 * 24 * 60 * 60 * 1_000;
const RESERVATION = 10 * 60 * 1_000;

let directory: string;
let options: SupportCommandOptions;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "hraness-support-test-"));
  options = { stateDirectory: join(directory, "state"), env: {}, now: NOW };
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function command(args: readonly string[], overrides: SupportCommandOptions = {}, product = profile) {
  return runSupportCommand(product, args, { ...options, ...overrides });
}

async function claim(overrides: SupportCommandOptions = {}, product = profile) {
  const result = await command(["offer", "--json"], overrides, product);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

describe("explicit support commands", () => {
  test("direct offers remain available after opt-out and do not access preference storage", async () => {
    expect((await command(["dismiss"])).exitCode).toBe(0);
    const direct = await command([]);
    expect(direct.exitCode).toBe(0);
    expect(direct.stderr).toBe("");
    expect(direct.stdout).toContain("Get free Example product updates");
    expect(direct.stdout).toContain("source=cli#support");
    const invalidDirectory = join(directory, "regular-file");
    await writeFile(invalidDirectory, "untouched");
    const structured = await command(["--json"], { stateDirectory: invalidDirectory, env: { CI: "1", HRANESS_SUPPORT: "off" } });
    expect(structured.exitCode).toBe(0);
    expect(JSON.parse(structured.stdout).schemaVersion).toBe("hraness-support-offer-v1");
    expect(await readFile(invalidDirectory, "utf8")).toBe("untouched");
  });

  test("unknown arguments fail without reserving an invitation", async () => {
    expect((await command(["charge"])).exitCode).toBe(2);
    expect((await command(["offer"])).exitCode).toBe(2);
    expect((await command(["dismiss", "extra"])).exitCode).toBe(2);
    expect((await claim()).kind).toBe("offer");
  });
});

describe("suite-wide presentation receipts", () => {
  test("first offer reserves once; only shown acknowledgment starts the weekly cooldown", async () => {
    const first = await claim();
    expect(first.schemaVersion).toBe("hraness-support-result-v1");
    expect(first.kind).toBe("offer");
    expect(first.invitation.optional).toBe(true);
    expect(first.invitation.actions[0].url).toContain("source=agent#updates");
    expect((await claim({}, otherProfile)).reason).toBe("reserved");
    const pending = JSON.parse((await command(["status", "--json"])).stdout);
    expect(pending.lastShownAt).toBeNull();
    expect(pending.reservationExpiresAt).toBe(NOW + RESERVATION);
    expect((await command(["shown", first.invitation.id], { now: NOW + 1_000 })).exitCode).toBe(0);
    expect((await claim({ now: NOW + WEEK }, otherProfile)).reason).toBe("cooldown");
    expect((await claim({ now: NOW + WEEK + 1_000 }, otherProfile)).kind).toBe("offer");
  });

  test("unshown reservations expire without consuming a week", async () => {
    const first = await claim();
    const second = await claim({ now: NOW + RESERVATION });
    expect(second.kind).toBe("offer");
    expect(second.invitation.id).not.toBe(first.invitation.id);
    expect((await command(["shown", first.invitation.id], { now: NOW + RESERVATION })).exitCode).toBe(2);
    expect((await command(["shown", second.invitation.id], { now: NOW + RESERVATION })).exitCode).toBe(0);
  });

  test("forged, duplicate, expired, and pre-reservation acknowledgments cannot alter the cooldown", async () => {
    expect((await command(["shown", "invalid"])).exitCode).toBe(2);
    const first = await claim();
    expect((await command(["shown", "00000000-0000-4000-8000-000000000000"])).exitCode).toBe(2);
    expect((await command(["shown", first.invitation.id], { now: NOW - 1 })).exitCode).toBe(2);
    expect((await command(["shown", first.invitation.id], { now: NOW + RESERVATION })).exitCode).toBe(2);
    const status = JSON.parse((await command(["status", "--json"])).stdout);
    expect(status.lastShownAt).toBeNull();
    expect((await command(["shown", first.invitation.id])).exitCode).toBe(0);
    expect((await command(["shown", first.invitation.id])).exitCode).toBe(2);
  });

  test("concurrent products reserve at most one invitation", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => claim({}, index % 2 ? profile : otherProfile)));
    expect(results.filter(result => result.kind === "offer")).toHaveLength(1);
    expect(results.filter(result => result.kind === "quiet")).toHaveLength(11);
    for (const result of results.filter(result => result.kind === "quiet")) {
      expect(["reserved", "busy"]).toContain(result.reason);
    }
    expect(JSON.parse((await command(["status", "--json"])).stdout).lastShownAt).toBeNull();
  });
});

describe("persistent user preferences", () => {
  test("dismissal is suite-wide and invalidates a pending invitation until explicitly enabled", async () => {
    const first = await claim();
    expect((await command(["dismiss"])).exitCode).toBe(0);
    expect((await claim({ now: NOW + MONTH * 12 }, otherProfile)).reason).toBe("dismissed");
    expect((await command(["shown", first.invitation.id])).exitCode).toBe(2);
    expect((await command(["enable"])).exitCode).toBe(0);
    expect((await claim()).kind).toBe("offer");
  });

  test("snooze lasts 30 days and does not override a durable dismissal", async () => {
    expect((await command(["snooze"])).exitCode).toBe(0);
    expect((await claim({ now: NOW + MONTH - 1 }, otherProfile)).reason).toBe("snoozed");
    expect((await claim({ now: NOW + MONTH }, otherProfile)).kind).toBe("offer");
    await command(["dismiss"]);
    await command(["snooze"]);
    expect((await claim({ now: NOW + MONTH })).reason).toBe("dismissed");
  });

  test("enable clears opt-out and snooze while retaining an earned cooldown", async () => {
    const first = await claim();
    await command(["shown", first.invitation.id]);
    await command(["dismiss"]);
    await command(["snooze"]);
    await command(["enable"]);
    expect((await claim()).reason).toBe("cooldown");
  });

  test("XDG state is shared independently of the product and contains no identity data", async () => {
    const xdg = join(directory, "xdg");
    const shared = { stateDirectory: undefined, env: { XDG_STATE_HOME: xdg, EXAMPLE_TOKEN: "never-store-this" } };
    const first = await claim(shared);
    expect((await claim(shared, otherProfile)).reason).toBe("reserved");
    await command(["shown", first.invitation.id], shared);
    const raw = await readFile(join(xdg, "hraness", "support", "state.json"), "utf8");
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["lastShownAt", "optedOut", "reservation", "schemaVersion", "snoozedUntil"]);
    expect(raw).not.toContain("Example");
    expect(raw).not.toContain("never-store-this");
    expect((await stat(join(xdg, "hraness", "support", "state.json"))).mode & 0o777).toBe(0o600);
  });
});

describe("fail-harmlessly behavior", () => {
  test("corrupt state is preserved and suppresses incidental offers", async () => {
    await mkdir(options.stateDirectory!, { recursive: true });
    const path = join(options.stateDirectory!, "state.json");
    await writeFile(path, "{broken");
    expect((await claim()).reason).toBe("state-unavailable");
    expect((await command(["dismiss"])).exitCode).toBe(1);
    expect(await readFile(path, "utf8")).toBe("{broken");
    expect((await command([])).exitCode).toBe(0);
  });

  test("unknown state versions and oversized state are never reset", async () => {
    await mkdir(options.stateDirectory!, { recursive: true });
    const path = join(options.stateDirectory!, "state.json");
    const future = JSON.stringify({ schemaVersion: "future", optedOut: true });
    await writeFile(path, future);
    expect((await claim()).reason).toBe("state-unavailable");
    expect(await readFile(path, "utf8")).toBe(future);
    await writeFile(path, " ".repeat(4_097));
    expect((await claim()).reason).toBe("state-unavailable");
  });

  test.skipIf(process.platform === "win32")("a FIFO state path returns promptly without waiting for a writer", async () => {
    await mkdir(options.stateDirectory!, { recursive: true });
    const path = join(options.stateDirectory!, "state.json");
    const fifo = spawnSync("mkfifo", [path], { encoding: "utf8" });
    expect(fifo.status).toBe(0);
    // Bound the regression in a child process: an ordinary read-only open on
    // this FIFO would otherwise keep the test process waiting indefinitely.
    const module = new URL("../src/node.ts", import.meta.url).href;
    const script = `const { runSupportCommand } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(await runSupportCommand(${JSON.stringify(profile)}, ["offer", "--json"], ${JSON.stringify(options)})));`;
    const child = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 1_500 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).reason).toBe("state-unavailable");
    expect((await stat(path)).isFIFO()).toBe(true);
  });

  test("an existing lock is never stolen or deleted", async () => {
    await mkdir(options.stateDirectory!, { recursive: true });
    const path = join(options.stateDirectory!, "state.lock");
    await writeFile(path, "another process");
    expect((await claim()).reason).toBe("busy");
    expect(await readFile(path, "utf8")).toBe("another process");
    expect((await command([])).exitCode).toBe(0);
  });

  test("unwritable storage suppresses invitations without breaking direct support", async () => {
    const path = join(directory, "not-a-directory");
    await writeFile(path, "preserve");
    expect((await claim({ stateDirectory: path })).reason).toBe("state-unavailable");
    expect((await command([], { stateDirectory: path })).exitCode).toBe(0);
    expect(await readFile(path, "utf8")).toBe("preserve");
  });

  test("CI and explicit environment suppression do not read or create state", async () => {
    for (const env of [{ CI: "1" }, { GITHUB_ACTIONS: "true" }, { HRANESS_SUPPORT: "off" }]) {
      expect((await claim({ env })).reason).toBe("environment");
    }
    await expect(stat(options.stateDirectory!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("post-success terminal hook", () => {
  test("only useful interactive work prints; shared cooldown prevents another product printing", async () => {
    const writes: string[] = [];
    const stderr = { isTTY: true, write(text: string) { writes.push(text); } };
    expect(await maybeShowSupportInvitation(profile, { ...options, usefulResult: false, stderr })).toBe(false);
    expect(await maybeShowSupportInvitation(profile, { ...options, usefulResult: true, stderr: { ...stderr, isTTY: false } })).toBe(false);
    expect(await maybeShowSupportInvitation(profile, { ...options, usefulResult: true, env: { CI: "1" }, stderr })).toBe(false);
    expect(writes).toHaveLength(0);
    expect(await maybeShowSupportInvitation(profile, { ...options, usefulResult: true, stderr })).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("source=cli#support");
    expect(await maybeShowSupportInvitation(otherProfile, { ...options, usefulResult: true, stderr })).toBe(false);
    expect(writes).toHaveLength(1);
    expect(JSON.parse((await command(["status", "--json"])).stdout).lastShownAt).toBe(NOW);
  });

  test("write failures and invalid profiles never fail the host operation", async () => {
    expect(await maybeShowSupportInvitation(profile, { ...options, usefulResult: true, stderr: { isTTY: true, write() { throw new Error("closed"); } } })).toBe(false);
    expect(JSON.parse((await command(["status", "--json"])).stdout).lastShownAt).toBe(NOW);
    expect(await maybeShowSupportInvitation({ ...profile, name: "bad\u001b[31m" }, { ...options, usefulResult: true, stderr: { isTTY: true, write() {} } })).toBe(false);
  });

  test("a terminal notice is printed only after its cooldown is committed", async () => {
    let printed = false;
    expect(await maybeShowSupportInvitation(profile, {
      ...options,
      usefulResult: true,
      stderr: {
        isTTY: true,
        write() {
          const state = JSON.parse(readFileSync(join(options.stateDirectory!, "state.json"), "utf8"));
          expect(state.lastShownAt).toBe(NOW);
          expect(state.reservation).toBeNull();
          printed = true;
        },
      },
    })).toBe(true);
    expect(printed).toBe(true);
  });

  test("a competing lock between reservation and acknowledgment suppresses terminal output", async () => {
    let clockReads = 0;
    let printed = false;
    const lockPath = join(options.stateDirectory!, "state.lock");
    const shown = await maybeShowSupportInvitation(profile, {
      ...options,
      // The second clock read is the acknowledgment boundary. Simulate an
      // independent process holding the lock after reservation has completed.
      get now() {
        clockReads += 1;
        if (clockReads === 2) writeFileSync(lockPath, "another process", { flag: "wx" });
        return NOW;
      },
      usefulResult: true,
      stderr: { isTTY: true, write() { printed = true; } },
    });
    expect(shown).toBe(false);
    expect(printed).toBe(false);
    expect(await readFile(lockPath, "utf8")).toBe("another process");
    const state = JSON.parse(await readFile(join(options.stateDirectory!, "state.json"), "utf8"));
    expect(state.lastShownAt).toBeNull();
  });
});
