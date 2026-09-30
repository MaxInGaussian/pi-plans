#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDir = resolve("tests");
if (!existsSync(testDir)) {
  console.error(`Missing test directory: ${testDir}`);
  process.exit(1);
}

// Safety net (F-002): unless the caller pinned one, point the pi-plans
// GLOBAL config at a throwaway directory so concurrent test files can never
// clobber the developer's real ~/.pi/pi-plans/config.json. Individual suites
// may still override per-test with their own PI_PLANS_GLOBAL_DIR.
const env = { ...process.env };
if (!env.PI_PLANS_GLOBAL_DIR) {
  env.PI_PLANS_GLOBAL_DIR = mkdtempSync(join(tmpdir(), "pi-plans-global-"));
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
  env,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
