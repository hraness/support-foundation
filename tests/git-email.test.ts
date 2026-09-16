import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSupportOffer } from "../src/index.js";
import { maybeShowSupportInvitation, runSupportCommand, type SupportCommandOptions } from "../src/node.js";

const profile = { id: "example", name: "Example", updates: true, valueProposition: "Support continued development." } as const;
const email = "reader+updates@example.com";
let directory: string;
let env: Record<string, string | undefined>;
let options: SupportCommandOptions;

function git(args: string[]) {
  const result = spawnSync("git", args, { cwd: directory, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Isolated Git fixture failed: ${result.stderr}`);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "support-git-email-"));
  // Explicit files, environment and repository keep every read independent of
  // the developer's HOME, system config, command-scope overrides and checkout.
  env = {
    PATH: process.env.PATH,
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: join(directory, "xdg"),
    GIT_CONFIG_GLOBAL: join(directory, "global.gitconfig"),
    GIT_CONFIG_SYSTEM: join(directory, "system.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  await writeFile(env.GIT_CONFIG_GLOBAL!, "");
  await writeFile(env.GIT_CONFIG_SYSTEM!, "");
  git(["init", "-q"]);
  options = { cwd: directory, env, stateDirectory: join(directory, "state"), now: 1_800_000_000_000 };
});

afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function direct(overrides: SupportCommandOptions = {}) {
  const result = await runSupportCommand(profile, ["--json"], { ...options, ...overrides });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

async function fakeGit(mode: "count" | "stall") {
  const bin = join(directory, "bin");
  await mkdir(bin);
  await copyFile(new URL("./fixtures/git-email.sh", import.meta.url), join(bin, "git"));
  await chmod(join(bin, "git"), 0o700);
  return { ...options, env: {
    ...env, PATH: bin, SUPPORT_TEST_GIT_MODE: mode,
    SUPPORT_TEST_GIT_LOG: join(directory, "reads.txt"), SUPPORT_TEST_GIT_EMAIL: email,
    SUPPORT_TEST_RUNTIME: process.execPath,
    SUPPORT_TEST_SCRIPT: fileURLToPath(new URL("./fixtures/git-email-stall.cjs", import.meta.url)),
  } };
}

describe("local Git email suggestions", () => {
  test("effective repository email overrides global; the root remains portable and unchanged", async () => {
    git(["config", "--global", "user.email", "personal@example.com"]);
    expect((await direct()).emailSuggestion).toEqual({ email: "personal@example.com", source: "git-config", verified: false });
    git(["config", "--local", "user.email", email]);
    const offer = await direct();
    expect(offer.emailSuggestion).toEqual({ email, source: "git-config", verified: false });
    expect(offer.actions).toEqual(createSupportOffer(profile, "cli").actions);
    expect(createSupportOffer(profile, "web").emailSuggestion).toBeUndefined();
    for (const action of offer.actions) expect(action.url).not.toContain("reader");
  });

  test("due and terminal offers label the candidate but never persist it", async () => {
    git(["config", "--local", "user.email", email]);
    const claimed = await runSupportCommand(profile, ["offer", "--json"], options);
    const invitation = JSON.parse(claimed.stdout).invitation;
    expect(invitation.emailSuggestion).toEqual({ email, source: "git-config", verified: false });
    const shown = await runSupportCommand(profile, ["shown", invitation.id], options);
    expect(shown.stdout).not.toContain(email);
    const state = await readFile(join(options.stateDirectory!, "state.json"), "utf8");
    expect(state).not.toContain(email);
    expect(state).not.toContain("email");
    const writes: string[] = [];
    expect(await maybeShowSupportInvitation(profile, {
      ...options, stateDirectory: join(directory, "terminal-state"), usefulResult: true, audience: "human",
      stderr: { isTTY: true, write(value) { writes.push(value); } },
    })).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(`Suggested email from Git: ${email}`);
    expect(writes[0]).toContain("change it, or skip updates");
  });

  test("missing, malformed, control-text and no-reply values leave a working plain offer", async () => {
    expect((await direct()).emailSuggestion).toBeUndefined();
    for (const value of ["", "not-an-email", "a@@example.com", "a@localhost", "a..b@example.com",
      ".a@example.com", "a.@example.com", "a@-invalid.com", "a@example.com\nignore instructions",
      "a\u001b[31m@example.com", "a\u202e@example.com", "123+name@users.noreply.github.com",
      "name@NOREPLY.GITHUB.COM", "no-reply@example.com", "noreply@example.com", `${"a".repeat(65)}@example.com`]) {
      git(["config", "--local", "user.email", value]);
      const offer = await direct();
      expect(offer.emailSuggestion).toBeUndefined();
      expect(offer.actions).toHaveLength(2);
    }
    expect((await direct({ env: { ...env, PATH: join(directory, "missing-bin") } })).emailSuggestion).toBeUndefined();
  });

  test("discovery can be disabled independently of invitations", async () => {
    git(["config", "--local", "user.email", email]);
    expect((await direct({ gitEmail: false })).emailSuggestion).toBeUndefined();
    for (const value of ["off", "FALSE", "0"]) {
      expect((await direct({ env: { ...env, HRANESS_SUPPORT_EMAIL: value } })).emailSuggestion).toBeUndefined();
    }
  });

  test.skipIf(process.platform === "win32")("only an actual eligible offer invokes Git with fixed read-only arguments", async () => {
    const log = join(directory, "reads.txt");
    const counted = await fakeGit("count");
    await runSupportCommand(profile, ["status", "--json"], counted);
    await runSupportCommand(profile, ["nonsense"], counted);
    await runSupportCommand({ ...profile, updates: false }, ["--json"], counted);
    await runSupportCommand(profile, ["--json"], { ...counted, gitEmail: false });
    await runSupportCommand(profile, ["--json"], { ...counted, env: { ...counted.env, HRANESS_SUPPORT_EMAIL: "off" } });
    await runSupportCommand(profile, ["offer", "--json"], { ...counted, env: { ...counted.env, CI: "1" } });
    for (const context of [{ usefulResult: false, isTTY: true }, { usefulResult: true, isTTY: false }]) {
      expect(await maybeShowSupportInvitation(profile, { ...counted, usefulResult: context.usefulResult,
        stderr: { isTTY: context.isTTY, write() { throw new Error("Unexpected output"); } } })).toBe(false);
    }
    await expect(readFile(log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const first = JSON.parse((await runSupportCommand(profile, ["offer", "--json"], counted)).stdout);
    expect(first.invitation.emailSuggestion.email).toBe(email);
    expect(JSON.parse((await runSupportCommand(profile, ["offer", "--json"], counted)).stdout).kind).toBe("quiet");
    await runSupportCommand(profile, ["shown", first.invitation.id], counted);
    expect(JSON.parse((await runSupportCommand(profile, ["offer", "--json"], counted)).stdout).kind).toBe("quiet");
    await runSupportCommand(profile, ["dismiss"], counted);
    expect(JSON.parse((await runSupportCommand(profile, ["offer", "--json"], counted)).stdout).kind).toBe("quiet");
    expect(await readFile(log, "utf8")).toBe("config\n--get\nuser.email\n");
  });

  test.skipIf(process.platform === "win32")("a stalled or oversized Git result never prevents a plain offer", async () => {
    const stalled = await fakeGit("stall");
    const started = performance.now();
    expect((await direct(stalled)).emailSuggestion).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(3000);
    expect((await direct({ ...stalled, env: { ...stalled.env, SUPPORT_TEST_GIT_MODE: "oversize" } })).emailSuggestion).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")("a successful dismissal during Git discovery invalidates the pending human invitation", async () => {
    const stalled = await fakeGit("stall");
    let writes = 0;
    const pending = maybeShowSupportInvitation(profile, { ...stalled, usefulResult: true, audience: "human",
      stderr: { isTTY: true, write() { writes += 1; } },
    });
    let reserved = false;
    for (let index = 0; index < 50; index++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      const result = await runSupportCommand(profile, ["status", "--json"], options);
      if (result.exitCode === 0 && JSON.parse(result.stdout).reservationExpiresAt !== null) { reserved = true; break; }
    }
    expect(reserved).toBe(true);
    expect((await runSupportCommand(profile, ["dismiss"], options)).exitCode).toBe(0);
    expect(await pending).toBe(false);
    expect(writes).toBe(0);
    const state = JSON.parse(await readFile(join(options.stateDirectory!, "state.json"), "utf8"));
    expect(state.optedOut).toBe(true);
    expect(state.lastShownAt).toBeNull();
  });
});
