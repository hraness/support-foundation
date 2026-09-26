import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supportMenuItem, supportMenuUrl } from "../src/index.js";
import { runSupportCommand, type SupportCommandOptions } from "../src/node.js";

const profile = { id: "sponge", name: "Sponge", updates: true, valueProposition: "Support research tools." } as const;
const NOW = Date.UTC(2026, 8, 26, 12);
const DAY = 86_400_000;
let directory: string;
let options: SupportCommandOptions;
const tty = { isTTY: true, write: () => true };
const pipe = { isTTY: false, write: () => true };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "support-human-"));
  options = { command: ["sponge"], stateDirectory: join(directory, "state"), env: { LANG: "en_US.UTF-8" }, gitEmail: false, now: NOW, stderr: tty };
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const run = (args: string[], overrides: SupportCommandOptions = {}) => runSupportCommand(profile, args, { ...options, ...overrides });

describe("support command for people", () => {
  test("--help, -h and help print grouped help to stdout and exit 0", async () => {
    const golden = [
      "Usage: sponge support [command]",
      "",
      "See optional product updates and paid support for Sponge.",
      "",
      "Commands",
      "  (none)      Show the links for updates and support",
      "  status      Show whether invitations are on",
      "  dismiss     Stop showing invitations on this device",
      "  snooze      Hide invitations for 30 days",
      "  enable      Show invitations again",
      "",
      "Options",
      "  --json      Print machine-readable output",
      "  -h, --help  Show this help",
      "",
    ].join("\n");
    for (const flag of ["--help", "-h", "help"]) {
      expect(await run([flag])).toEqual({ exitCode: 0, stdout: golden, stderr: "" });
    }
    const help = (await run(["--help"])).stdout;
    expect(help).not.toContain("protocol");
    expect(help).not.toContain("shown");
    expect(help.split("\n").every(line => line.length <= 80)).toBe(true);
  });

  test("dismiss, snooze and enable print one line and a hint at a terminal", async () => {
    expect(await run(["dismiss"])).toEqual({
      exitCode: 0,
      stdout: "✓ Support invitations are off on this device.\n",
      stderr: "Turn them back on: sponge support enable\n",
    });
    expect(await run(["status"])).toEqual({
      exitCode: 0,
      stdout: "○ Support invitations are off on this device.\n",
      stderr: "Turn them back on: sponge support enable\n",
    });
    expect(await run(["snooze"])).toEqual({
      exitCode: 0,
      stdout: "✓ Support invitations are hidden for 30 days.\n",
      stderr: "Turn them back on: sponge support enable\n",
    });
    expect(await run(["enable"])).toEqual({
      exitCode: 0,
      stdout: "✓ Support invitations are on. You'll see at most one a week.\n",
      stderr: "Turn them off: sponge support dismiss\n",
    });
    expect(await run(["status"])).toEqual({
      exitCode: 0,
      stdout: "● Support invitations are on. You'll see at most one a week.\n",
      stderr: "Turn them off: sponge support dismiss\n",
    });
  });

  test("status names the date for a snooze and for the weekly pause", async () => {
    await run(["snooze"]);
    expect((await run(["status"])).stdout).toBe("○ Support invitations are hidden until 2026-10-26.\n");
    await run(["enable"]);
    const offer = JSON.parse((await run(["offer", "--json"])).stdout);
    await run(["shown", offer.invitation.id], { now: NOW + 1 });
    expect((await run(["status"], { now: NOW + DAY })).stdout).toBe("● Support invitations are on. The next one can appear after 2026-10-03.\n");
    expect((await run(["status"], { env: { LANG: "en_US.UTF-8", CI: "1" } })).stdout).toBe("○ Support invitations are turned off in this environment.\n");
  });

  test("pipes get the same text without hints, and never JSON unless asked", async () => {
    expect(await run(["dismiss"], { stderr: pipe })).toEqual({
      exitCode: 0, stdout: "✓ Support invitations are off on this device.\n", stderr: "",
    });
    const json = await run(["dismiss", "--json"], { stderr: tty });
    expect(JSON.parse(json.stdout)).toEqual({ schemaVersion: "hraness-support-result-v1", kind: "dismissed" });
    expect(json.stderr).toBe("");
    expect(JSON.parse((await run(["status", "--json"])).stdout).optedOut).toBe(true);
  });

  test("detected agents keep JSON by default; HRANESS_AUDIENCE=human turns it back into text", async () => {
    const agent = await run(["enable"], { env: { CLAUDECODE: "1" }, stderr: pipe });
    expect(JSON.parse(agent.stdout).kind).toBe("enabled");
    const human = await run(["enable"], { env: { CLAUDECODE: "1", HRANESS_AUDIENCE: "human", LANG: "C.UTF-8" }, stderr: tty });
    expect(human.stdout).toBe("✓ Support invitations are on. You'll see at most one a week.\n");
  });

  test("NO_COLOR changes nothing because the output has no color, and plain terminals get ASCII", async () => {
    expect((await run(["dismiss"], { env: { LANG: "en_US.UTF-8", NO_COLOR: "1" } })).stdout).toBe("✓ Support invitations are off on this device.\n");
    expect((await run(["dismiss"], { env: { LANG: "en_US.UTF-8", TERM: "dumb" } })).stdout).toBe("OK Support invitations are off on this device.\n");
    expect((await run(["status"], { env: {} })).stdout).toBe("o Support invitations are off on this device.\n");
    // LC_ALL overrides LANG, so a C locale stays ASCII even with a UTF-8 LANG.
    expect((await run(["status"], { env: { LC_ALL: "C", LANG: "en_US.UTF-8" } })).stdout).toBe("o Support invitations are off on this device.\n");
    expect((await run(["status"], { env: { LC_ALL: "", LC_CTYPE: "UTF-8", LANG: "C" } })).stdout).toBe("○ Support invitations are off on this device.\n");
    expect((await run(["enable"], { env: { LANG: "en_US.UTF-8", HRANESS_ASCII: "1" } })).stderr).toBe("Turn them off: sponge support dismiss\n");
  });

  test("an unknown command says what happened and points at help, exit 2", async () => {
    expect(await run(["stauts"])).toEqual({
      exitCode: 2, stdout: "", stderr: "✗ Unknown support command \"stauts\".\n→ sponge support --help\n",
    });
    expect((await run(["x\u001b[31m", "y"])).stderr).toBe("✗ Unknown support command \"x[31m y\".\n→ sponge support --help\n");
    expect((await run(["a".repeat(80)])).stderr).toContain(`"${"a".repeat(40)}"`);
    expect((await run(["stauts"], { command: undefined })).stderr).toBe("✗ Unknown support command \"stauts\".\n→ support --help\n");
    expect((await run(["stauts"], { command: ["/opt/bin/sponge", "--profile", "work"] })).stderr).toContain("→ sponge --profile work support --help");
  });

  test("a busy preference file reads as a sentence, and JSON keeps the old reason", async () => {
    await run(["status"]);
    await Bun.write(join(options.stateDirectory!, "state.lock"), "other");
    expect(await run(["dismiss"])).toEqual({ exitCode: 1, stdout: "", stderr: "✗ Another support command is running. Try again in a moment.\n" });
    expect((await run(["dismiss", "--json"])).stderr).toBe("Support preferences are unavailable (busy).\n");
  });
});

describe("support menu row", () => {
  test("is a menu kit v2 action that opens the browser", () => {
    expect(supportMenuItem()).toEqual({ kind: "action", id: "support.open", label: "Help & support", symbol: "action.support", opens: "browser" });
    expect(supportMenuItem({ id: "help", alternate: { id: "help.copy", label: "Copy diagnostics", symbol: "action.copy" } })).toEqual({
      kind: "action", id: "help", label: "Help & support", symbol: "action.support", opens: "browser",
      alternate: { id: "help.copy", label: "Copy diagnostics", symbol: "action.copy" },
    });
    expect(Object.isFrozen(supportMenuItem())).toBe(true);
  });

  test("rejects reserved, duplicate or malformed IDs", () => {
    for (const options of [
      { id: "foundation.login" }, { id: "" }, { id: "has space" },
      { alternate: { id: "support.open", label: "Copy" } },
      { alternate: { id: "foundation.x", label: "Copy" } },
      { alternate: { id: "ok", label: "" } },
      { alternate: { id: "ok", label: "Copy", symbol: "action.open" as never } },
    ]) {
      expect(() => supportMenuItem(options)).toThrow(TypeError);
    }
  });

  test("the row opens the product's support page with both choices", () => {
    expect(supportMenuUrl(profile)).toBe("https://account.hraness.com/support?product=sponge&source=desktop");
    expect(supportMenuUrl({ ...profile, updates: false })).toBe("https://account.hraness.com/support?product=sponge&source=desktop");
  });
});
