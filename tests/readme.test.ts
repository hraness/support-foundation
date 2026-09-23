import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repositoryRoot = new URL("../", import.meta.url);
const readme = readFileSync(new URL("README.md", repositoryRoot), "utf8");
const manifest = JSON.parse(readFileSync(new URL("package.json", repositoryRoot), "utf8")) as {
  readonly version: string;
};

describe("README facts", () => {
  test("pins the current release tag in the install snippet", () => {
    expect(readme).toContain(`github:hraness/support-foundation#v${manifest.version}`);
  });

  test("pins no other release tag", () => {
    for (const match of readme.matchAll(/#v(\d+\.\d+\.\d+)/gu)) {
      expect(match[1], "README pins a tag that is not the package version").toBe(manifest.version);
    }
  });
});
