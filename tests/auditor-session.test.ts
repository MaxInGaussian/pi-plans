/**
 * `runCompletionAudit` on the real in-process session path (the exec-loop
 * tests replace it through a seam, so nothing else exercised it): the
 * reviewer session gets the execution-reviewer prompt, the pinned model and
 * effort, and read-only tools, and its report is parsed into an outcome.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, before, describe, it } from "node:test";
import { __setSessionFactoryForTests } from "../src/agent-session.ts";
import { runCompletionAudit } from "../src/auditor.ts";
import { setMessagingApi } from "../src/messaging.ts";
import { parsePlanTasks, type CheckItem } from "../src/plan.ts";
import { buildTaskView } from "../src/tasks.ts";
import { FakeSession, fakeModelRegistry } from "./fake-agent-session.ts";

const PLAN = `## Tasks

- Task-1: parser — files: src/a.ts; wave: 1
- Task-2: tool — files: src/b.ts; wave: 1

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\`; pass condition: parser ok
- [ ] \`VC-002\` covers \`Task-2\`; pass condition: tool ok
`;

const checklist: CheckItem[] = [
	{ id: "VC-001", text: "covers `Task-1`; pass condition: parser ok", done: false },
	{ id: "VC-002", text: "covers `Task-2`; pass condition: tool ok", done: false },
];

const tasks = () =>
	buildTaskView(parsePlanTasks(PLAN), { "Task-1": { status: "complete" }, "Task-2": { status: "complete" } });

let workdir = "";

before(() => {
	workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-auditor-session-"));
	setMessagingApi({ appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: async () => {} });
});

afterEach(() => {
	__setSessionFactoryForTests(null);
});

const ctx = () => ({ cwd: workdir, model: { provider: "main", id: "session" }, modelRegistry: fakeModelRegistry }) as never;

const baseOptions = () => ({ planPath: path.join(workdir, "PLAN_v1.md"), checklist, tasks: tasks(), round: 1 });

describe("runCompletionAudit on in-process sessions", () => {
	it("runs the execution reviewer read-only on the pinned model and parses its verdicts", async () => {
		const seen: Array<Record<string, unknown>> = [];
		__setSessionFactoryForTests(async (options) => {
			seen.push(options);
			return {
				session: new FakeSession(async (api) => {
					api.say("- `VC-001` — verdict: pass; evidence: src/a.ts; note: ok\n- `VC-002` — verdict: fail; evidence: src/b.ts; note: missing\n");
				}),
			};
		});
		const outcome = await runCompletionAudit(ctx(), { ...baseOptions(), model: "fake/reviewer", thinkingLevel: "high" });
		assert.ok(outcome && !("cancelled" in outcome));
		assert.deepEqual(outcome.passed, ["VC-001"]);
		assert.deepEqual(outcome.failed, ["VC-002"]);
		assert.equal(seen.length, 1);
		assert.deepEqual(seen[0]!.model, { provider: "fake", id: "reviewer" });
		assert.equal(seen[0]!.thinkingLevel, "high");
		assert.deepEqual(seen[0]!.tools, ["read", "grep", "find", "ls"], "the execution reviewer is read-only");
		assert.match(String(seen[0]!.systemPrompt), /execution reviewer in the pi-plans workflow/);
		assert.equal(seen[0]!.cwd, workdir);
	});

	it("inherits the dispatching session's model when no role model is pinned", async () => {
		const seen: Array<Record<string, unknown>> = [];
		__setSessionFactoryForTests(async (options) => {
			seen.push(options);
			return { session: new FakeSession((api) => api.say("- `VC-001` — verdict: pass\n- `VC-002` — verdict: pass\n")) };
		});
		const outcome = await runCompletionAudit(ctx(), baseOptions());
		assert.ok(outcome && !("cancelled" in outcome));
		assert.deepEqual(outcome.passed, ["VC-001", "VC-002"]);
		assert.deepEqual(seen[0]!.model, { provider: "main", id: "session" });
		assert.equal("thinkingLevel" in seen[0]!, false);
	});

	it("an unreadable report leaves the checks undeterminable rather than failed", async () => {
		__setSessionFactoryForTests(async () => ({ session: new FakeSession((api) => api.say("I looked around and it seems fine.")) }));
		const outcome = await runCompletionAudit(ctx(), baseOptions());
		assert.ok(outcome && !("cancelled" in outcome));
		assert.deepEqual(outcome.failed, []);
		assert.deepEqual(outcome.passed, []);
		assert.deepEqual(outcome.undeterminable.sort(), ["VC-001", "VC-002"]);
	});

	it("a failed session is a null round; an aborted one is cancelled", async () => {
		__setSessionFactoryForTests(async () => ({
			session: new FakeSession(() => {
				throw new Error("provider down");
			}),
		}));
		assert.equal(await runCompletionAudit(ctx(), baseOptions()), null);

		__setSessionFactoryForTests(async () => ({ session: new FakeSession(async (api) => void (await api.aborted)) }));
		const controller = new AbortController();
		const pending = runCompletionAudit(ctx(), { ...baseOptions(), signal: controller.signal });
		setTimeout(() => controller.abort(), 20);
		assert.deepEqual(await pending, { cancelled: true });
	});

	it("an unknown pinned model makes the round fail instead of silently using another model", async () => {
		__setSessionFactoryForTests(async () => ({ session: new FakeSession((api) => api.say("- `VC-001` — verdict: pass")) }));
		const noRegistry = { cwd: workdir, model: { provider: "main", id: "session" }, modelRegistry: { find: () => undefined } } as never;
		assert.equal(await runCompletionAudit(noRegistry, { ...baseOptions(), model: "nope/missing" }), null);
	});
});
