import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSupportOffer, createSupportProtocol } from "../src/index.js";
import { maybeShowSupportInvitation, runSupportCommand, type SupportCommandOptions } from "../src/node.js";

const binary = resolve("target/debug/examples/interop" + (process.platform === "win32" ? ".exe" : ""));
const profile = { id: "rust-fixture", name: "Rust fixture", updates: false, valueProposition: "Support useful local tools." };
const prefix = ["fixture tool", "--local"];
const clock = 1_800_000_000_000;
const week = 7 * 24 * 60 * 60 * 1000;
const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), "support-rust-")); directories.push(path); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
type Override = Record<string, unknown>;
async function rust(path: string, args: string[], overrides: Override = {}) {
  const child = Bun.spawn([binary], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify({ profile, args, command: prefix, stateDirectory: path, env: {}, now: clock, gitEmail: false, ...overrides }));
  child.stdin.end();
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stderr).toBe(""); expect(exit).toBe(0);
  return JSON.parse(stdout);
}
async function js(path: string, args: string[], overrides: SupportCommandOptions = {}) {
  return runSupportCommand(profile, args, { command: prefix, stateDirectory: path, env: {}, now: clock, gitEmail: false,
    stderr: { isTTY: false, write: () => true }, ...overrides });
}
async function body(engine: typeof rust | typeof js, path: string, args: string[], options = {}) {
  const result = await engine(path, args, options); expect(result.exitCode).toBe(0); expect(result.stderr).toBe(""); return JSON.parse(result.stdout);
}
async function hook(engine: "rust" | "js", path: string, options: Override = {}) {
  if (engine === "rust") return rust(path, [], { hook: true, isTty: true, ...options });
  let output = "";
  const shown = await maybeShowSupportInvitation(profile, { usefulResult: true, command: prefix, stateDirectory: path, env: {}, now: clock, gitEmail: false,
    stderr: { isTTY: true, write: (text: string) => { output += text; } }, ...options });
  return { shown, output };
}

describe("Rust and JavaScript published contract interoperability", () => {
  test("pure protocol/offer, render and argument failures agree without creating state", async () => {
    const path = join(await directory(), "absent");
    expect(await body(rust, path, ["protocol", "--json"])).toEqual(createSupportProtocol(profile, { command: prefix }));
    expect(await body(rust, path, ["--json"])).toEqual(createSupportOffer(profile, "cli"));
    for (const args of [[], ["bad"], ["shown", "bad"], ["release", "bad"], ["offer"], ["--json", "extra"]]) {
      expect(await rust(path, args)).toEqual(await js(path, args));
    }
    expect(await Bun.file(join(path, "state.json")).exists()).toBe(false);
    const updates = { ...profile, updates: true, name: "Fixture ☀️" };
    expect(await body(rust, path, ["--json"], { profile: updates })).toEqual(createSupportOffer(updates, "cli"));
  });

  for (const [first, second, label] of [[js, rust, "JS to Rust"], [rust, js, "Rust to JS"]] as const) {
    test(`${label}: claim, acknowledge, duplicate, weekly cooldown, expiration and release`, async () => {
      const path = await directory(); const offer = await body(first, path, ["offer", "--json"]);
      expect(offer.kind).toBe("offer"); const id = offer.invitation.id;
      expect((await body(second, path, ["offer", "--json"])).reason).toBe("reserved");
      expect((await body(second, path, ["shown", id], { now: clock + 100 })).kind).toBe("shown");
      expect((await body(first, path, ["shown", id], { now: clock + 500 })).kind).toBe("shown");
      expect((await body(second, path, ["status", "--json"])).lastShownAt).toBe(clock + 100);
      expect((await body(first, path, ["offer", "--json"], { now: clock + week })).reason).toBe("cooldown");
      const next = await body(second, path, ["offer", "--json"], { now: clock + week + 100 });
      expect(next.kind).toBe("offer");
      expect((await first(path, ["shown", id], { now: clock + week + 100 })).exitCode).toBe(2);
      expect((await body(first, path, ["release", next.invitation.id])).kind).toBe("released");
      const expired = await body(first, path, ["offer", "--json"], { now: clock + week + 200 });
      expect((await second(path, ["shown", expired.invitation.id], { now: clock + week + 600200 })).exitCode).toBe(2);
      expect((await body(second, path, ["offer", "--json"], { now: clock + week + 600200 })).kind).toBe("offer");
    });

    test(`${label}: preferences and explicit requests share state`, async () => {
      const path = await directory();
      expect(await body(first, path, ["dismiss", "--json"])).toEqual(await body(second, await directory(), ["dismiss", "--json"]));
      expect((await body(second, path, ["offer", "--json"])).reason).toBe("dismissed");
      expect((await body(second, path, ["--json"])).optional).toBe(true);
      await body(second, path, ["enable", "--json"]); await body(first, path, ["snooze", "--json"]);
      expect((await body(second, path, ["offer", "--json"])).reason).toBe("snoozed");
      await body(second, path, ["enable", "--json"]);
      expect((await body(first, path, ["offer", "--json"])).kind).toBe("offer");
    });
  }

  test("mixed concurrent engines claim one invitation", async () => {
    const path = await directory();
    const results = await Promise.all(Array.from({ length: 16 }, (_, index) => body(index % 2 ? js : rust, path, ["offer", "--json"])));
    expect(results.filter(result => result.kind === "offer")).toHaveLength(1);
    expect(results.every(result => result.kind === "offer" || ["busy", "reserved"].includes(result.reason))).toBe(true);
  });

  test("agent discovery is shared across runtimes and never records presentation", async () => {
    const env = { CLAUDECODE: "1" };
    for (const [first, second] of [["rust", "js"], ["js", "rust"]] as const) {
      const path = await directory();
      const result = await hook(first, path, { env }); expect(result.shown).toBe(true);
      expect(JSON.parse(result.output)).toEqual(JSON.parse((await hook(second, await directory(), { env })).output));
      expect((await hook(second, path, { env })).shown).toBe(false);
      expect((await body(rust, path, ["status", "--json"])).lastShownAt).toBeNull();
      expect((await hook(second, path, { env, now: clock + 600000 })).shown).toBe(true);
      expect((await body(js, path, ["offer", "--json"])).kind).toBe("offer");
    }
  });

  test("CI, explicit role, human TTY and JS whitespace semantics agree", async () => {
    for (const env of [{ CI:"true" }, { HRANESS_SUPPORT:" OFF " }, { HRANESS_SUPPORT_AUDIENCE:"invalid" }, { CI:"\u0085false\u0085" }, { HRANESS_SUPPORT:"\ufeffOFF\ufeff" }]) {
      expect(await body(rust, await directory(), ["offer", "--json"], { env })).toEqual(await body(js, await directory(), ["offer", "--json"], { env }));
      expect((await hook("rust", await directory(), { env })).shown).toBe(false);
    }
    expect((await hook("rust", await directory(), { audience:"human", isTty:false })).shown).toBe(false);
    const path = await directory();
    expect((await hook("rust", path, { audience:"human" })).shown).toBe(true);
    expect((await body(js, path, ["offer", "--json"])).reason).toBe("cooldown");
    expect((await hook("rust", await directory(), { hook:false })).shown).toBe(false);
  });

  test("malformed state, oversized files, receipt damage and busy locks fail quietly in both engines", async () => {
    const corruptions: [string, string][] = [["state.json", "{}"], ["state.json", " ".repeat(4097)], ["presentation.json", "{}"], ["state.lock", "other live or stale owner"]];
    for (const [name, data] of corruptions) {
      const path = await directory(); await writeFile(join(path, name), data);
      expect(await body(rust, path, ["offer", "--json"])).toEqual(await body(js, path, ["offer", "--json"]));
      expect((await hook("rust", path)).shown).toBe(false);
      expect(await readFile(join(path, name), "utf8")).toBe(data);
    }
    const path = await directory(); await writeFile(join(path, "discovery.json"), "{}");
    expect((await hook("rust", path, { env: { AI_AGENT: "x" } })).shown).toBe(false);
    expect((await hook("js", path, { env: { AI_AGENT: "x" } })).shown).toBe(false);
  });

  test("human invitations, command copy and audience decisions match byte for byte", async () => {
    const updates = { ...profile, updates: true };
    for (const env of [{ LANG: "en_US.UTF-8" }, { LANG: "en_US.UTF-8", TERM: "dumb" }, { LC_ALL: "C", LANG: "en_US.UTF-8" }, {}]) {
      for (const command of [prefix, ["/usr/local/bin/fixture"], []]) {
        const rustHook = await hook("rust", await directory(), { env, command, profile: updates });
        let output = "";
        const shown = await maybeShowSupportInvitation(updates, { usefulResult: true, command, stateDirectory: await directory(), env, now: clock, gitEmail: false,
          stderr: { isTTY: true, write: (text: string) => { output += text; } } });
        expect(rustHook).toEqual({ shown, output });
      }
    }
    for (const env of [{ LANG: "C.UTF-8" }, { HRANESS_ASCII: "1", LANG: "C.UTF-8" }, { CLAUDECODE: "1" }, { HRANESS_AUDIENCE: "agent" }]) {
      for (const stderrTty of [false, true]) {
        for (const command of [prefix, []]) {
          const path = await directory();
          const jsPath = await directory();
          const both = async (args: string[], extra: Override = {}) => {
            const fromRust = await rust(path, args, { env, command, stderrIsTty: stderrTty, ...extra });
            const fromJs = await runSupportCommand(profile, args, { command, stateDirectory: jsPath, env, now: clock, gitEmail: false,
              stderr: { isTTY: stderrTty, write: () => true }, ...(extra.now === undefined ? {} : { now: extra.now as number }) });
            // serde_json sorts object keys, so JSON bodies compare as values.
            const normal = (result: { stdout: string }) => ({ ...result, stdout: result.stdout.startsWith("{") ? JSON.parse(result.stdout) : result.stdout });
            expect(normal(fromRust)).toEqual(normal(fromJs));
            return fromJs;
          };
          for (const args of [["status"], ["dismiss"], ["status"], ["snooze"], ["status"], ["enable"], ["status"], ["--help"], ["-h"], ["help"], ["nope", "x\u0007y"], ["status", "extra"]]) {
            await both(args);
          }
          for (const [engine, where] of [[js, jsPath], [rust, path]] as const) {
            const offer = await body(engine, where, ["offer", "--json"], { command });
            await body(engine, where, ["shown", offer.invitation.id], { command, now: clock + 1 });
          }
          await both(["status"], { now: clock + 3 });
        }
      }
    }
  }, 60_000);

  test("numeric JSON spelling retains JavaScript acknowledgement semantics", async () => {
    const path = await directory(); const id = "11111111-1111-4111-8111-111111111111";
    await writeFile(join(path, "state.json"), '{"schemaVersion":"hraness-support-state-v1","optedOut":false,"snoozedUntil":null,"lastShownAt":1000.0,"reservation":null}');
    await writeFile(join(path, "presentation.json"), JSON.stringify({ schemaVersion:"hraness-support-presentation-v1", id, shownAt:1000 }));
    expect(await body(rust, path, ["shown", id], { now:1001 })).toEqual(await body(js, path, ["shown", id], { now:1001 }));
    await writeFile(join(path, "state.json"), JSON.stringify({ schemaVersion:"hraness-support-state-v1", optedOut:false, snoozedUntil:null, lastShownAt:Number.MAX_SAFE_INTEGER, reservation:null }));
    expect(await body(rust, path, ["status", "--json"])).toEqual(await body(js, path, ["status", "--json"]));
  });

  test("failed or deadline-exceeding output retains an unacknowledged reservation", async () => {
    for (const extra of [{ failOutput:true }, { delayOutput:1500 }]) {
      const path = await directory(); const start = performance.now();
      expect((await hook("rust", path, { audience:"human", ...extra })).shown).toBe(false);
      expect(performance.now() - start).toBeLessThan(2500);
      const status = await body(js, path, ["status", "--json"]);
      expect(status.lastShownAt).toBeNull(); expect(status.reservationExpiresAt).toBe(clock + 600000);
    }
  });

  test.skipIf(process.platform === "win32")("no-follow state and bounded, local-only Git suggestions", async () => {
    const path = await directory(); const target = join(path, "retained"); await writeFile(target, "retained");
    await symlink(target, join(path, "state.json"));
    expect((await body(rust, path, ["offer", "--json"])).reason).toBe("state-unavailable");
    expect(await readFile(target, "utf8")).toBe("retained");
    const bin = join(await directory(), "bin"); await mkdir(bin);
    const marker = join(bin, "called"); const git = join(bin, "git");
    await writeFile(git, `#!/bin/sh\nprintf called > '${marker}'\nprintf '%s\\n' 'Person+tool@Example.com'\n`); await chmod(git, 0o755);
    const env = { PATH:bin };
    // Admit this newly created executable to the host before testing the
    // 500 ms lookup. Cold executable security scans can exceed that deadline;
    // production intentionally returns a plain offer in that case.
    expect(Bun.spawnSync([git, "config", "--get", "user.email"], { env, timeout:2000 }).exitCode).toBe(0);
    const updates = { ...profile, updates:true };
    const result = await body(rust, await directory(), ["--json"], { env, profile:updates, gitEmail:true });
    expect(result.emailSuggestion).toEqual({ email:"Person+tool@Example.com", source:"git-config", verified:false });
    await rm(marker);
    await body(rust, await directory(), ["--json"], { env, gitEmail:true });
    expect(await Bun.file(marker).exists()).toBe(false);
    await body(rust, await directory(), ["--json"], { env:{ ...env, HRANESS_SUPPORT_EMAIL:"off" }, profile:updates, gitEmail:true });
    expect(await Bun.file(marker).exists()).toBe(false);
    await writeFile(git, "#!/bin/sh\nexec /bin/sleep 10\n");
    const start = performance.now();
    expect((await body(rust, await directory(), ["--json"], { env, profile:updates, gitEmail:true })).emailSuggestion).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(2500);
    await writeFile(git, "#!/bin/sh\nprintf '%s' 'noreply@users.noreply.github.com'\n");
    expect((await body(rust, await directory(), ["--json"], { env, profile:updates, gitEmail:true })).emailSuggestion).toBeUndefined();
    await writeFile(git, `#!/bin/sh\nprintf '%s' 'person@example.com'\nprintf '%s' '${"e".repeat(1025)}' >&2\n`);
    expect((await body(rust, await directory(), ["--json"], { env, profile:updates, gitEmail:true })).emailSuggestion).toBeUndefined();
    await writeFile(git, `#!/bin/sh\nprintf '%s' '${"e".repeat(1025)}'\n`);
    expect((await body(rust, await directory(), ["--json"], { env, profile:updates, gitEmail:true })).emailSuggestion).toBeUndefined();
  });
});
