/** Scriptable stand-in for an SDK agent session (test helper, not a test file). */

import { __setSessionFactoryForTests, type SessionLike } from "../src/agent-session.ts";

export interface FakeApi {
	/** Emit a raw session event to subscribers. */
	emit(event: unknown): void;
	/** Append a finished assistant message (and emit its message_end). */
	say(text: string, extra?: Record<string, unknown>): void;
	/** Messages steered into the session so far. */
	steered: string[];
	/** Resolves once abort() was called (never rejects). */
	aborted: Promise<void>;
	isAborted(): boolean;
	sleep(ms: number): Promise<void>;
	/** Prompt text of this run. */
	prompt: string;
}

export type FakeBehavior = (api: FakeApi) => Promise<void> | void;

export class FakeSession implements SessionLike {
	readonly messages: unknown[] = [];
	readonly prompts: string[] = [];
	readonly steered: string[] = [];
	disposed = false;
	isStreaming = false;
	private listeners = new Set<(event: unknown) => void>();
	private abortFlag = false;
	private abortResolve: () => void = () => undefined;
	private abortedPromise: Promise<void>;

	private readonly behavior: FakeBehavior;

	constructor(behavior: FakeBehavior) {
		this.behavior = behavior;
		this.abortedPromise = new Promise<void>((resolve) => {
			this.abortResolve = resolve;
		});
	}

	subscribe(listener: (event: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: unknown): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		this.isStreaming = true;
		this.abortFlag = false;
		this.abortedPromise = new Promise<void>((resolve) => {
			this.abortResolve = resolve;
		});
		this.messages.push({ role: "user", content: [{ type: "text", text }] });
		const api: FakeApi = {
			emit: (event) => this.emit(event),
			say: (reply, extra = {}) => {
				const message = { role: "assistant", model: "fake/model", content: [{ type: "text", text: reply }], ...extra };
				this.messages.push(message);
				this.emit({ type: "message_end", message });
			},
			steered: this.steered,
			aborted: this.abortedPromise,
			isAborted: () => this.abortFlag,
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			prompt: text,
		};
		try {
			await this.behavior(api);
		} finally {
			this.isStreaming = false;
		}
	}

	steer(text: string): void {
		this.steered.push(text);
	}

	abort(): void {
		this.abortFlag = true;
		this.abortResolve();
	}

	dispose(): void {
		this.disposed = true;
	}
}

export interface FakeAgentRequest {
	cwd: string;
	prompt: string;
	systemPrompt: string;
	options: Record<string, unknown>;
}

/**
 * Route every in-process agent session to a fake that answers each prompt with
 * `respond(...)`. Returns the restore function.
 */
export function installFakeAgents(respond: (request: FakeAgentRequest) => string | Promise<string>): () => void {
	__setSessionFactoryForTests(async (options) => ({
		session: new FakeSession(async (api) => {
			api.say(await respond({ cwd: String(options.cwd), prompt: api.prompt, systemPrompt: String(options.systemPrompt), options }));
		}),
	}));
	return () => __setSessionFactoryForTests(null);
}

/** Minimal registry for ctx fixtures: every "provider/id" resolves. */
export const fakeModelRegistry = {
	find: (provider: string, id: string) => ({ provider, id }),
};
