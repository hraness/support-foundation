import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";

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
  // Compile a detached strict consumer with the same NODE_ENV augmentation
  // used by Next.js. Dependency implementations must not be re-typechecked
  // under the consumer's ambient declarations; only emitted .d.ts are public.
  await cp(join(root, "node_modules/@types/node"), join(scratch, "node_modules/@types/node"), { recursive: true, dereference: true });
  await cp(join(root, "node_modules/undici-types"), join(scratch, "node_modules/undici-types"), { recursive: true, dereference: true });
  await writeFile(join(scratch, "package.json"), JSON.stringify({ private:true, type:"module" }));
  await writeFile(join(scratch, "consumer.ts"), `
import { createSupportOffer, createSupportProtocol, type SupportProfile } from '@hraness/support-foundation';
import { runSupportCommand, maybeShowSupportInvitation } from '@hraness/support-foundation/node';
declare global { namespace NodeJS { interface ProcessEnv { readonly NODE_ENV: 'development' | 'production' | 'test'; } } }
const profile: SupportProfile = {id:'wrench',name:'Ghostget',valueProposition:'Support development.',updates:true};
createSupportOffer(profile,'web');
createSupportProtocol(profile,{command:['ghostget']});
runSupportCommand(profile,['protocol','--json'],{command:['ghostget'],env:{}});
maybeShowSupportInvitation(profile,{command:['ghostget'],usefulResult:true,env:{}});
`);
  await writeFile(join(scratch, "tsconfig.json"), JSON.stringify({ compilerOptions:{ target:"ES2022", module:"NodeNext", moduleResolution:"NodeNext", strict:true, skipLibCheck:false, noEmit:true, types:["node"] }, include:["consumer.ts"] }));
  run("node", [join(root, "node_modules/typescript/bin/tsc"), "--project", join(scratch, "tsconfig.json")], scratch);
  const entry = join(scratch, "consumer.mjs");
  await writeFile(entry, `
import assert from 'node:assert/strict';
import { createSupportOffer, createSupportProtocol } from '@hraness/support-foundation';
import { maybeShowSupportInvitation, runSupportCommand } from '@hraness/support-foundation/node';
const profile = {id:'wrench',name:'Ghostget',valueProposition:'Support ongoing development.',updates:true};
assert.equal(createSupportOffer(profile,'web').actions.length,2);
const result = await runSupportCommand(profile,['--json'],{stateDirectory:${JSON.stringify(join(scratch, "preferences"))},gitEmail:false});
assert.equal(result.exitCode,0);
assert.equal(JSON.parse(result.stdout).optional,true);
assert.deepEqual(createSupportProtocol(profile,{command:['ghostget']}).commands.offer,['ghostget','support','offer','--json']);
const options = {command:['ghostget'],stateDirectory:${JSON.stringify(join(scratch, "protocol-preferences"))},gitEmail:false,env:{}};
const protocol = await runSupportCommand(profile,['protocol','--json'],options);
assert.equal(JSON.parse(protocol.stdout).schemaVersion,'hraness-support-protocol-v1');
const writes=[];
assert.equal(await maybeShowSupportInvitation(profile,{...options,usefulResult:true,stderr:{isTTY:true,write(text){writes.push(text)}}}),true);
assert.equal(JSON.parse(writes[0]).schemaVersion,'hraness-support-discovery-v1');
`);
  run("node", [entry], scratch);
  const brokenPipe = join(scratch, "broken-pipe.mjs");
  await writeFile(brokenPipe, `
import {readFile} from 'node:fs/promises';
import {maybeShowSupportInvitation} from '@hraness/support-foundation/node';
Object.defineProperty(process.stderr,'isTTY',{value:true});
const stateDirectory=${JSON.stringify(join(scratch, "broken-pipe-state"))};
const shown=await maybeShowSupportInvitation({id:'wrench',name:'Ghostget',valueProposition:'Support development.',updates:true},{command:['ghostget'],stateDirectory,gitEmail:false,env:{},audience:'human',usefulResult:true});
const state=JSON.parse(await readFile(stateDirectory+'/state.json','utf8'));
process.stdout.write(JSON.stringify({shown,lastShownAt:state.lastShownAt}));
`);
  const child = spawn("node", [brokenPipe], { cwd: scratch, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.destroy();
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, "a real closed stderr pipe must not crash the installed Node host");
  assert.deepEqual(JSON.parse(stdout), { shown: false, lastShownAt: null });
  const browser = await Bun.build({ entrypoints: [join(installed, "dist/index.js")], target: "browser" });
  if (!browser.success) throw new Error("Root must remain browser portable.");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  if (Object.keys(manifest.dependencies ?? {}).length !== 0) throw new Error("Unexpected runtime dependency.");
  assert.equal(manifest.exports["."].types, "./dist/index.d.ts");
  assert.equal(manifest.exports["./node"].types, "./dist/node.d.ts");
  process.stdout.write("Packed strict TypeScript/Node consumers and browser-safe root passed.\n");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
