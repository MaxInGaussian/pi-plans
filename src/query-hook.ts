import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";

export const QUERY_INTERVIEW_MESSAGE_CUSTOM_TYPE = "pi-plans-query-interview";
export const QUERY_INTERVIEW_MESSAGE =
	"Before implementing a new user request, if any requirement, constraint, expected behavior, or acceptance criterion is unclear, interview the user with focused clarification questions and confirm the answers before making changes. If the request is clear, proceed directly with the implementation.";

interface QueryHookState {
	pendingQueries: number;
}

type QueryHookSession = { __piPlansQueryHook?: QueryHookState };

function sessionCarrier(ctx: ExtensionContext): QueryHookSession | undefined {
	return ctx.sessionManager as unknown as QueryHookSession | undefined;
}

function ensureState(ctx: ExtensionContext): QueryHookState | undefined {
	const session = sessionCarrier(ctx);
	if (!session) return undefined;
	return (session.__piPlansQueryHook ??= { pendingQueries: 0 });
}

export function isOrdinaryExternalQuery(
	input: Pick<InputEvent, "text" | "source" | "streamingBehavior">,
): boolean {
	const text = input.text.trim();
	return (
		(input.source === "interactive" || input.source === "rpc")
		&& input.streamingBehavior === undefined
		&& text.length > 0
		&& !text.startsWith("/")
	);
}

export function recordOrdinaryQuery(
	ctx: ExtensionContext,
	input: Pick<InputEvent, "text" | "source" | "streamingBehavior">,
): boolean {
	if (!isOrdinaryExternalQuery(input)) return false;
	const state = ensureState(ctx);
	if (!state) return false;
	state.pendingQueries += 1;
	return true;
}

export function consumeOrdinaryQuery(ctx: ExtensionContext): boolean {
	const session = sessionCarrier(ctx);
	const state = session?.__piPlansQueryHook;
	if (!state || state.pendingQueries <= 0) return false;
	state.pendingQueries -= 1;
	if (state.pendingQueries === 0) delete session.__piPlansQueryHook;
	return true;
}

export function resetOrdinaryQueryState(ctx: ExtensionContext): void {
	const session = sessionCarrier(ctx);
	if (session) delete session.__piPlansQueryHook;
}

export function registerQueryInterviewHooks(
	pi: ExtensionAPI,
	suppressForWorkflow: (ctx: ExtensionContext) => boolean,
): void {
	pi.on("input", async (event, ctx) => {
		recordOrdinaryQuery(ctx, event);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!consumeOrdinaryQuery(ctx) || suppressForWorkflow(ctx)) return;
		return {
			message: {
				customType: QUERY_INTERVIEW_MESSAGE_CUSTOM_TYPE,
				content: QUERY_INTERVIEW_MESSAGE,
				display: false,
			},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		resetOrdinaryQueryState(ctx);
	});
}
