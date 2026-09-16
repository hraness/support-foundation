import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import { createSupportOffer, createSupportProtocol, renderSupportOffer } from "../src/index.js";

// JavaScript remains the authoritative published contract. Parse only the
// declared literal/arithmetic constants; a changed expression fails this gate
// until explicitly reviewed, rather than evaluating arbitrary source text.
const wanted = new Set(["WEEK_MS", "SNOOZE_MS", "RESERVATION_MS", "DISCOVERY_MS", "OUTPUT_TIMEOUT_MS", "STATE_SCHEMA", "RESULT_SCHEMA"]);
function literal(node: ts.Expression): number | string {
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll("_", ""));
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
    const left = literal(node.left), right = literal(node.right);
    assert.equal(typeof left, "number"); assert.equal(typeof right, "number");
    return Number(left) * Number(right);
  }
  throw new Error("Unsupported Rust-contract policy expression");
}
const source = ts.createSourceFile("node.ts", await readFile(new URL("../src/node.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const policy: Record<string, number | string> = {};
for (const statement of source.statements) {
  if (!ts.isVariableStatement(statement)) continue;
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name) && wanted.has(declaration.name.text)) {
      assert.ok(declaration.initializer);
      policy[declaration.name.text] = literal(declaration.initializer);
    }
  }
}
assert.deepEqual(Object.keys(policy).sort(), [...wanted].sort());
const profile = { id: "contract-product", name: "PRODUCT_NAME", updates: true, valueProposition: "VALUE_PROPOSITION" };
const offer = createSupportOffer(profile, "cli");
const rendered = renderSupportOffer({ ...offer, emailSuggestion: { email: "EMAIL_ADDRESS", source: "git-config", verified: false } }).trimEnd().split("\n");
const contract = JSON.stringify({
  schemaVersion: "hraness-support-rust-contract-v1",
  policy,
  protocol: createSupportProtocol({ id: "contract-product", name: "Contract product", updates: false, valueProposition: "Contract value proposition." }, { command: ["SUPPORT_COMMAND"] }),
  presentation: {
    heading: rendered[0],
    updatesLabel: offer.actions[0]?.label,
    emailSuggestion: rendered.at(-2),
    payment: rendered.at(-1),
  },
}, null, 2) + "\n";
const output = new URL("../rust/src/contract-v1.json", import.meta.url);
if (process.argv.includes("--check")) assert.equal(await readFile(output, "utf8"), contract, "Rust contract drifted from the published JavaScript protocol/policy");
else { await mkdir(new URL("../rust/src/", import.meta.url), { recursive: true }); await writeFile(output, contract); }
