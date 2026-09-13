#!/usr/bin/env node
/**
 * RPC driver for the pi-plans benchmark (I-001/D-013).
 *
 * Reads the task instruction from stdin, spawns `pi --mode rpc` with the
 * given flags, sends the instruction as a prompt, and waits for the agent to
 * settle (no retry/compaction/queued continuation left) before exiting.
 * Unlike `--print --mode json`, RPC mode lets extension-driven continuations
 * (the treatment arm's post-execution refinement loop) actually run — the
 * treatment would otherwise be silently under-dosed (PLAN_v3 C-F006).
 *
 * Every JSON event line is mirrored to --out (pi.txt-compatible: harbor's
 * populate_context_post_run parses message_end usage lines from it).
 * After the agent settles, subagent usage is snapshotted from every run's
 * subagents.jsonl under the pi-plans state root into --subagent-usage.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import * as path from "node:path";

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const provider = arg("--provider");
const model = arg("--model");
const outPath = arg("--out", "pi.txt");
const usagePath = arg("--subagent-usage");
const idleTimeoutMs = Number(arg("--idle-timeout-ms", String(45 * 60 * 1000)));

let instruction = readFileSync(0, "utf8").trim();

const DRIVER_FLAGS = [
  "--provider", "--model", "--out", "--subagent-usage", "--idle-timeout-ms", "--skill-first", "--plans-dir",
];
const extra = process.argv.slice(2).filter((a, i, arr) => !DRIVER_FLAGS.includes(a) && !DRIVER_FLAGS.includes(arr[i - 1]));

const args = ["--mode", "rpc", "--provider", provider, "--model", model, ...extra];
const child = spawn("pi", args, { stdio: ["pipe", "pipe", "inherit"] });

const out = [];
let settled = false;
let sawPromptAccepted = false;

let timer = setTimeout(onIdleTimeout, idleTimeoutMs);
function resetIdleTimer() {
  clearTimeout(timer);
  timer = setTimeout(onIdleTimeout, idleTimeoutMs);
}
function onIdleTimeout() {
  process.stderr.write(`[rpc-driver] idle timeout after ${idleTimeoutMs}ms of no events; killing\n`);
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5000);
}

child.stdout.setEncoding("utf8");
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    resetIdleTimer();
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    // Skip the streaming flood: harbor's post-run parser only needs
    // message_end lines; keeping 25k deltas per run bloats archives.
    if (event.type === "message_update") continue;
    out.push(line + "\n");
    if (event.type === "response" && event.command === "prompt") {
      if (event.success) sawPromptAccepted = true;
      else if (/already processing/i.test(event.error ?? "")) {
        // Planning continuations (pre-plan compaction resume, refinement
        // rounds) keep the agent busy; queue instead of dropping the prompt.
        process.stderr.write("[rpc-driver] agent busy; re-queueing as followUp\n");
      } else {
        process.stderr.write(`[rpc-driver] prompt rejected: ${JSON.stringify(event)}\n`);
        child.kill("SIGTERM");
      }
    }
    // agent_settled: the run is fully settled — no automatic retry, compaction
    // retry, or queued continuation remains (pi rpc.md). The treatment arm's
    // refinement loop uses queued follow-ups, so this is the ONLY safe stop.
    if (event.type === "turn_end") turnEnds += 1;
    if (event.type === "tool_execution_start") toolCallsSinceSettle += 1;
    if (event.type === "agent_settled") {
      settleCount += 1;
      if (toolCallsSinceSettle > 0 || settleCount >= 3) {
        if (!settled) endStdin();
        settled = true;
      } else {
        // Interim settle (skill interview / planning pause) — keep stdin open;
        // the extension's queued continuation will keep the run going.
        process.stderr.write("[rpc-driver] interim settle; waiting for continuation\n");
        toolCallsSinceSettle = 0;
      }
    }

    // Fallback for dialog UI requests (extension_ui_request): under
    // PI_PLANS_AUTO_APPROVE=1 pi-plans dialogs are answered in-process, so any
    // dialog reaching the driver is unexpected — confirm=true,
    // select=recommended-or-first, input=cancel. Fire-and-forget methods are
    // ignored per protocol.
    if (
      event.type === "extension_ui_request" && event.method && event.id &&
      process.env.PI_PLANS_BENCH_ARM === "treatment"
    ) {
      let response;
      if (event.method === "select") {
        const opts = event.options ?? [];
        const rec = opts.find((o) => /recommended/i.test(o)) ?? opts[0];
        response = { type: "extension_ui_response", id: event.id, value: rec };
      } else if (event.method === "confirm") {
        response = { type: "extension_ui_response", id: event.id, confirmed: true };
      } else {
        response = { type: "extension_ui_response", id: event.id, cancelled: true };
      }
      child.stdin.write(JSON.stringify(response) + "\n");
    }
  }
});

function endStdin() {
  try { child.stdin.end(); } catch {}
}

child.on("exit", (code) => {
  clearTimeout(timer);
  clearInterval(keepAlive);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, out.join(""), "utf8");
  snapshotSubagentUsage(usagePath);
  snapshotPlanArtifacts(arg("--plans-dir"));
  try {
    writeFileSync(
      outPath.replace(/[^/]*$/, "") + "driver-meta.json",
      JSON.stringify({ turns: turnEnds, settled, promptAccepted: sawPromptAccepted }, null, 2),
    );
  } catch {}
  if (!settled) {
    process.stderr.write("[rpc-driver] agent did not settle before exit\n");
  }
  process.exitCode = sawPromptAccepted && settled && code === 0 ? 0 : code === 0 ? 1 : code;
});

// Keep stdin OPEN: RPC treats stdin EOF as shutdown, which would kill the
// agent mid-run. The stream is ended only after agent_settled / exit.
//
// D-014 (treatment arm): the task instruction goes FIRST (verbatim, C-003),
// immediately followed by the planning trigger "/skill:plan-big" queued with
// streamingBehavior:"followUp" — mirroring real usage (user states the
// request, then invokes plan mode) so plan-big plans ON the actual request
// instead of inventing a target. Baseline sends the task directly.
const skillFirst = arg("--skill-first");
let turnEnds = 0;
let pending = [];
// Settle disambiguation: pi-plans' planning/refinement loop settles between
// phases and wakes itself via queued follow-ups, so agent_settled alone does
// NOT mean "finished". A settle is final only when real work (tool calls)
// happened since the previous settle, or as a bounded fallback (3rd settle).
let settleCount = 0;
let toolCallsSinceSettle = 0;
function sendPrompt(prompt) {
  child.stdin.write(JSON.stringify({ type: "prompt", id: prompt.id, message: prompt.message }) + "\n");
}
function sendFollowUp(prompt) {
  child.stdin.write(
    JSON.stringify({ type: "prompt", id: prompt.id, message: prompt.message, streamingBehavior: "followUp" }) + "\n",
  );
}
const keepAlive = setInterval(() => child.stdin.write(""), 15_000);
child.on("exit", () => clearInterval(keepAlive));
sendPrompt({ id: "bench-1", message: instruction });
if (skillFirst) sendFollowUp({ id: "bench-0", message: `/skill:${skillFirst}` });

function snapshotPlanArtifacts(dest) {
  if (!dest) return;
  // Plan artifact locations: the seeded artifact root (/tmp/pi-plans-bench/docs)
  // and pi-plans' own fallbacks — the repo-local docs/pi-plans and the state
  // root .git/pi_plans/docs (where run plans actually land).
  const roots = [
    "/tmp/pi-plans-bench/docs",
    path.join(process.cwd(), "docs", "pi-plans"),
    path.join(process.cwd(), ".git", "pi_plans", "docs"),
  ];
  try {
    mkdirSync(dest, { recursive: true });
    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { recursive: true })) {
        const src = path.join(root, entry);
        if (!fs.statSync(src).isFile() || !entry.endsWith(".md")) continue;
        const content = readFileSync(src, "utf8");
        const name = entry.split(path.sep).join("__");
        writeFileSync(path.join(dest, name), content, "utf8");
      }
    }
  } catch (error) {
    process.stderr.write(`[rpc-driver] plan artifact snapshot failed: ${error?.message}\n`);
  }
}

function snapshotSubagentUsage(dest) {
  if (!dest) return;
  // pi-plans state root convention: <workdir>/.git/pi_plans/runs/<id>/subagents.jsonl
  const stateRoots = [path.join(process.cwd(), ".git", "pi_plans", "runs")];
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, children: 0 };
  try {
    for (const root of stateRoots) {
      if (!existsSync(root)) continue;
      for (const runId of readdirSync(root)) {
        const file = path.join(root, runId, "subagents.jsonl");
        if (!existsSync(file)) continue;
        for (const line of readFileSync(file, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            const u = entry.usage;
            if (!u) continue;
            totals.input += u.input || 0;
            totals.output += u.output || 0;
            totals.cacheRead += u.cache_read || 0;
            totals.cacheWrite += u.cache_write || 0;
            totals.cost += u.cost || 0;
            totals.children += 1;
          } catch {}
        }
      }
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, JSON.stringify({ totals }, null, 2));
  } catch (error) {
    process.stderr.write(`[rpc-driver] subagent usage snapshot failed: ${error?.message}\n`);
  }
}
