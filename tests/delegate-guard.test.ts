import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import piPlansExtension from "../index.ts";
import { getExecution, startExecution, stopExecution } from "../src/exec.ts";
import { parseChecklist, parsePlanTasks } from "../src/plan.ts";
import { setMessagingApi } from "../src/messaging.ts";
import { __setSessionFactoryForTests } from "../src/agent-session.ts";
import { fleet } from "../src/agent-fleet.ts";
import { fleetUi } from "../src/fleet-ui.ts";
import { FakeSession } from "./fake-agent-session.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

/** Load the extension against a recording pi and return its handlers by event. */
function loadExtension(): Map<string, Handler[]> {
	const handlers = new Map<string, Handler[]>();
	const pi = new Proxy(
		{
			on: (event: string, handler: Handler) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		},
		{ get: (target, key) => (key in target ? (target as never)[key] : () => undefined) },
	);
	piPlansExtension(pi as never);
	return handlers;
}

const PLAN = `# PLAN_v1 - guard fixture

## Tasks

- Task-1: a — files: lib/a.js; wave: 1

## Verification Checks

- [ ] \`VC-001\` covers \`Task-1\`; pass condition: ok; evidence: tests; metric: green.
`;

let root = "";

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-guard-"));
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

afterEach(async () => {
	__setSessionFactoryForTests(null);
	if (getExecution()) await stopExecution(ctxFor(root), "teardown");
	fleetUi.detach();
	fleet.clear();
});

function ctxFor(workdir: string) {
	setMessagingApi({ appendEntry: () => {}, sendMessage: () => {} } as never);
	return {
		cwd: workdir,
		sessionManager: {},
		hasUI: true,
		mode: "tui",
		model: { provider: "fake", id: "main" },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t } },
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as never;
}

async function run(executor: { mode: "delegated"; workers: number; model_selector: string; thinking_level: null } | undefined) {
	const workdir = path.join(root, `repo-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(workdir, { recursive: true });
	const planPath = path.join(workdir, "PLAN_v1.md");
	fs.writeFileSync(planPath, PLAN);
	__setSessionFactoryForTests(async () => ({
		session: new FakeSession(async (api) => {
			await api.aborted;
		}),
	}));
	const ctx = ctxFor(workdir);
	await startExecution(ctx, { planPath, planTasks: parsePlanTasks(PLAN), items: parseChecklist(PLAN), executor });
	return ctx;
}

describe("main-session write guard while execution is delegated", () => {
	it("blocks edit and write from the supervising session, but not reads", async () => {
		const ctx = await run({ mode: "delegated", workers: 1, model_selector: "fake/worker", thinking_level: null });
		const handlers = loadExtension().get("tool_call") ?? [];
		const results = [];
		for (const toolName of ["edit", "write", "read", "bash"]) {
			for (const handler of handlers) {
				const result = (await handler({ toolName, input: { path: "lib/a.js" } }, ctx)) as { block?: boolean; reason?: string } | undefined;
				if (result?.block) results.push({ toolName, reason: result.reason });
			}
		}
		assert.deepEqual(results.map((r) => r.toolName), ["edit", "write"]);
		assert.match(results[0]!.reason!, /delegated workers/);
	});

	it("leaves the current session free to edit during a normal execution", async () => {
		const ctx = await run(undefined);
		const handlers = loadExtension().get("tool_call") ?? [];
		for (const handler of handlers) {
			const result = (await handler({ toolName: "edit", input: { path: "lib/a.js" } }, ctx)) as { block?: boolean } | undefined;
			assert.notEqual(result?.block, true);
		}
	});
});
