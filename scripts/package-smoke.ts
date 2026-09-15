import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "support-package-"));
function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error?.message}`);
  return result.stdout;
}
try {
  const archive = join(scratch, "support.tgz");
  run(process.execPath, ["pm", "pack", "--filename", archive, "--ignore-scripts", "--quiet"], root);
  const members = run("tar", ["-tzf", archive], scratch).trim().split("\n");
  if (members.some(member => !member.startsWith("package/") || member.includes("..")
    || /(^|\/)(node_modules|\.env|tests)(\/|$)/u.test(member))) {
    throw new Error("Unexpected packed file.");
  }
  const installed = join(scratch, "node_modules", "@hraness", "support-foundation");
  await mkdir(installed, { recursive: true });
  run("tar", ["-xzf", archive, "--strip-components=1", "-C", installed], scratch);
  const entry = join(scratch, "consumer.mjs");
  await writeFile(entry, `
import assert from 'node:assert/strict';
import { createSupportOffer } from '@hraness/support-foundation';
import { runSupportCommand } from '@hraness/support-foundation/node';
const profile = {id:'wrench',name:'Ghostget',valueProposition:'Support ongoing development.',updates:true};
assert.equal(createSupportOffer(profile,'web').actions.length,2);
const result = await runSupportCommand(profile,['--json'],{stateDirectory:${JSON.stringify(join(scratch, "preferences"))},gitEmail:false});
assert.equal(result.exitCode,0);
assert.equal(JSON.parse(result.stdout).optional,true);
`);
  run("node", [entry], scratch);
  const browser = await Bun.build({ entrypoints: [join(installed, "dist/index.js")], target: "browser" });
  if (!browser.success) throw new Error("Root must remain browser portable.");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  if (Object.keys(manifest.dependencies ?? {}).length !== 0) throw new Error("Unexpected runtime dependency.");
  process.stdout.write("Packed Node consumer and browser-safe root passed.\n");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
