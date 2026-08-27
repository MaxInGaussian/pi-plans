/**
 * Minimal read-only subagent runner: spawns a `pi --mode json -p --no-session`
 * subprocess with a delegated system prompt and restricted tools, mirrors the
 * official subagent example's invocation and JSON event parsing.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SubagentOptions {
	systemPrompt: string;
	task: string;
	cwd: string;
	/** Exact "provider/model" selector; omit to inherit the dispatching session's model. */
	model?: string;
	/** Tool allowlist for the child process. Defaults to read-only tools. */
	tools?: string[];
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface SubagentResult {
	ok: boolean;
	output: string;
	model?: string;
	errorMessage?: string;
	stderr: string;
	turns: number;
}

/** Strip YAML frontmatter from an agent definition file. */
export function stripFrontmatter(text: string): string {
	if (!text.startsWith("---\n")) return text;
	const end = text.indexOf("\n---\n", 3);
	if (end < 0) return text;
	return text.slice(end + 5).trimStart();
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

interface MessageLike {
	role: string;
	content: Array<{ type: string; text?: string }>;
	model?: string;
}

function finalOutput(messages: MessageLike[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			const text = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n")
				.trim();
			if (text) return text;
		}
	}
	return "";
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export async function runPiSubagent(options: SubagentOptions): Promise<SubagentResult> {
	const tools = options.tools ?? ["read", "grep", "find", "ls"];
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-subagent-"));
	const promptFile = path.join(tmpDir, "system-prompt.md");
	fs.writeFileSync(promptFile, options.systemPrompt, { encoding: "utf8", mode: 0o600 });

	const args: string[] = ["--mode", "json", "-p", "--no-session", "--tools", tools.join(",")];
	if (options.model) args.push("--model", options.model);
	args.push("--append-system-prompt", promptFile);
	args.push(`Task: ${options.task}`);

	const messages: MessageLike[] = [];
	let stderr = "";
	let wasAborted = false;

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: { type?: string; message?: MessageLike };
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
					messages.push(event.message);
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});
			proc.on("error", () => resolve(1));

			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					try {
						if (!proc.killed) proc.kill("SIGKILL");
					} catch {
						/* already gone */
					}
				}, 5000);
			};

			const timer = setTimeout(killProc, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			const onAbort = () => killProc();
			if (options.signal) {
				if (options.signal.aborted) killProc();
				else options.signal.addEventListener("abort", onAbort, { once: true });
			}
			proc.on("close", () => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
			});
		});

		if (wasAborted) {
			return {
				ok: false,
				output: finalOutput(messages),
				stderr,
				turns: messages.filter((m) => m.role === "assistant").length,
				errorMessage: "Subagent was aborted",
			};
		}
		if (exitCode !== 0) {
			return {
				ok: false,
				output: finalOutput(messages),
				stderr,
				turns: messages.filter((m) => m.role === "assistant").length,
				errorMessage: `pi exited with code ${exitCode}`,
			};
		}
		const output = finalOutput(messages);
		if (!output) {
			return {
				ok: false,
				output: "",
				stderr,
				turns: messages.filter((m) => m.role === "assistant").length,
				errorMessage: "subagent produced no final output",
			};
		}
		return {
			ok: true,
			output,
			model: [...messages].reverse().find((m) => m.role === "assistant" && m.model)?.model,
			stderr,
			turns: messages.filter((m) => m.role === "assistant").length,
		};
	} finally {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}
