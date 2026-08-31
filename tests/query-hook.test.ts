import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	consumeOrdinaryQuery,
	isOrdinaryExternalQuery,
	QUERY_INTERVIEW_MESSAGE,
	QUERY_INTERVIEW_MESSAGE_CUSTOM_TYPE,
	recordOrdinaryQuery,
	registerQueryInterviewHooks,
	resetOrdinaryQueryState,
} from "../src/query-hook.ts";

function context(sessionManager: object): any {
	return { cwd: process.cwd(), sessionManager };
}

function registeredHooks(): { pi: any; handlers: Map<string, Function[]> } {
	const handlers = new Map<string, Function[]>();
	const pi = {
		on(name: string, handler: Function) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	};
	return { pi, handlers };
}

const ordinaryInput = { text: "implement the requested change", source: "interactive" as const };

describe("query interview hook", () => {
	it("accepts only idle external non-slash input", () => {
		assert.equal(isOrdinaryExternalQuery(ordinaryInput), true);
		assert.equal(isOrdinaryExternalQuery({ ...ordinaryInput, source: "rpc" }), true);
		assert.equal(isOrdinaryExternalQuery({ ...ordinaryInput, source: "extension" }), false);
		assert.equal(isOrdinaryExternalQuery({ ...ordinaryInput, streamingBehavior: "followUp" }), false);
		assert.equal(isOrdinaryExternalQuery({ ...ordinaryInput, streamingBehavior: "steer" }), false);
		assert.equal(isOrdinaryExternalQuery({ ...ordinaryInput, text: "   " }), false);
		assert.equal(isOrdinaryExternalQuery({ ...ordinaryInput, text: "/planning clarify this" }), false);
		assert.equal(isOrdinaryExternalQuery({ ...ordinaryInput, text: "/skill:plan-small implement this" }), false);
		assert.equal(isOrdinaryExternalQuery({ ...ordinaryInput, text: "/unknown-command" }), false);
	});

	it("queues multiple queries, consumes one at a time, and isolates sessions", () => {
		const first = context({});
		const second = context({});
		assert.equal(recordOrdinaryQuery(first, ordinaryInput), true);
		assert.equal(recordOrdinaryQuery(first, { ...ordinaryInput, text: "verify the change" }), true);
		assert.equal(consumeOrdinaryQuery(second), false);
		assert.equal(consumeOrdinaryQuery(first), true);
		assert.equal(consumeOrdinaryQuery(first), true);
		assert.equal(consumeOrdinaryQuery(first), false);
		resetOrdinaryQueryState(first);
		assert.equal(consumeOrdinaryQuery(first), false);
	});

	it("registers one hidden message per ordinary query and consumes suppressed queries", async () => {
		const { pi, handlers } = registeredHooks();
		let suppressed = false;
		registerQueryInterviewHooks(pi, () => suppressed);
		const session = {};
		const ctx = context(session);
		const input = handlers.get("input")![0]!;
		const beforeAgentStart = handlers.get("before_agent_start")![0]!;
		const sessionStart = handlers.get("session_start")![0]!;

		await input({ ...ordinaryInput }, ctx);
		const first = await beforeAgentStart({ type: "before_agent_start", prompt: ordinaryInput.text }, ctx);
		assert.equal(first?.message.customType, QUERY_INTERVIEW_MESSAGE_CUSTOM_TYPE);
		assert.equal(first?.message.display, false);
		assert.equal(first?.message.content, QUERY_INTERVIEW_MESSAGE);
		assert.equal(await beforeAgentStart({ type: "before_agent_start", prompt: ordinaryInput.text }, ctx), undefined);

		await input({ ...ordinaryInput, text: "a query inside the planning workflow" }, ctx);
		suppressed = true;
		assert.equal(await beforeAgentStart({ type: "before_agent_start", prompt: "expanded workflow prompt" }, ctx), undefined);
		suppressed = false;
		assert.equal(await beforeAgentStart({ type: "before_agent_start", prompt: "later ordinary prompt" }, ctx), undefined);

		await input({ ...ordinaryInput, text: "stale input" }, ctx);
		await sessionStart({ type: "session_start" }, ctx);
		assert.equal(await beforeAgentStart({ type: "before_agent_start", prompt: "new session" }, ctx), undefined);
	});
});
