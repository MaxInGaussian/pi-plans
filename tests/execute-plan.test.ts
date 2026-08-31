import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { getExecution, startExecution, stopExecution } from "../src/exec.ts";

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
	it("starts execution without switching models", async () => {
		const workdir = mkWorkdir("handoff");
		const recorded = {
			messages: [] as string[],
			entries: [] as Array<{ customType: string; data: unknown }>,
			setModelCalls: 0,
		};
		const pi = {
			appendEntry: (customType: string, data: unknown) => {
				recorded.entries.push({ customType, data });
			},
			sendMessage: (message: { customType: string; content: string }) => {
				recorded.messages.push(message.content);
			},
			setModel: async () => {
				recorded.setModelCalls += 1;
				return true;
			},
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

		await startExecution(pi as any, ctx, path.join(workdir, "PLAN_v1.md"), [
			{ id: "VC-001", text: "first item", done: false },
		] as any);
		assert.equal(recorded.setModelCalls, 0);
		assert.ok(getExecution());

		await stopExecution(pi as any, ctx, "cleanup");
		assert.equal(getExecution(), null);
	});
});
