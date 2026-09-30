import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseChecklist, parsePlanTasks } from "../src/plan.ts";
import { after, before, describe, it } from "node:test";

import { getExecution, startExecution, stopExecution } from "../src/exec.ts";
import { setMessagingApi } from "../src/messaging.ts";

let tmpRoot: string;

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-execute-test-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function mkWorkdir(name: string): string {
	const dir = path.join(tmpRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

describe("execute handoff", () => {
	it("rejects an inconsistent task tree at the handoff gate (lint hard-reject)", async () => {
		const workdir = mkWorkdir("lint-gate");
		const planPath = path.join(workdir, "PLAN_v1.md");
		fs.writeFileSync(
			planPath,
			"## Tasks\n\n- Task-1: a — files: src/a.ts; wave: 1\n- Task-2: b — deps: Task-9\n\n## Verification Checks\n\n- [ ] \\`VC-001\\` covers \\`Task-1\\`; pass condition: x\n",
			"utf8",
		);
		const { executeHandoff } = await import("../tools/execute-plan.ts");
		const ctx = { cwd: workdir, hasUI: false } as never;
		setMessagingApi(ctx);
		const outcome = await executeHandoff(ctx, planPath);
		assert.equal(outcome.status, "error");
		assert.match(outcome.message, /consistency gate/);
		assert.match(outcome.message, /deps 引用未知任务/);
	});

	it("starts execution without switching models", async () => {
		const workdir = mkWorkdir("handoff");
		const recorded = {
			messages: [] as string[],
			entries: [] as Array<{ customType: string; data: unknown }>,
		};
		const ctx = {
			cwd: workdir,
			ui: {
				setStatus: () => {},
				theme: {
					fg: (_kind: string, text: string) => text,
					bold: (text: string) => text,
				},
			},
		} as any;
		setMessagingApi({
			appendEntry: (customType: string, data: unknown) => {
				recorded.entries.push({ customType, data });
			},
			sendMessage: (message: { customType: string; content: string }) => {
				recorded.messages.push(message.content);
			},
			sendUserMessage: async () => {},
		});

		const planPath = path.join(workdir, "PLAN_v1.md");
		fs.writeFileSync(
			planPath,
			"## Tasks\n\n- Task-1: first — files: src/a.ts; wave: 1\n\n## Verification Checks\n\n- [ ] \\`VC-001\\` covers \\`Task-1\\`; pass condition: first item\n",
			"utf8",
		);
		await startExecution(ctx, {
			planPath,
			planTasks: parsePlanTasks(fs.readFileSync(planPath, "utf8")),
			items: parseChecklist(fs.readFileSync(planPath, "utf8")),
		});
		const execution = getExecution();
		assert.ok(execution);
		assert.equal(execution!.tasks.length, 1);
		assert.match(recorded.messages.at(-1) ?? "", /plans_update_task/);

		await stopExecution(ctx, "cleanup");
		assert.equal(getExecution(), null);
	});
});
