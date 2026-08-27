#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const testDir = resolve("tests");
if (!existsSync(testDir)) {
  console.error(`Missing test directory: ${testDir}`);
  process.exit(1);
}

const tests = readdirSync(testDir)
  .filter((entry) => entry.endsWith(".test.ts"))
  .sort()
  .map((entry) => join(testDir, entry));

if (tests.length === 0) {
  console.error(`No test files found in ${testDir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...tests], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
