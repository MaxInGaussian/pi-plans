/**
 * Run-level workflow checkpoints for /resume-plans (I-001).
 *
 * A checkpoint is the durable, workspace-owned state of one planning run:
 * logical phase, next action, plan identity, pending/answered questions,
 * review rounds, execution approval evidence, and ownership metadata. Pi
 * session entries keep per-branch execution snapshots; `checkpoint.json` is
 * the cross-session authority that survives session switches and restarts.
 *
 * Contract highlights (PLAN_v2):
 * - Explicit validation: unknown schema versions, malformed shapes, and
 *   unexpected keys are rejected — data is never blind-cast into an
 *   execution approval.
 * - Missing and corrupt checkpoints are distinct; corrupt files are never
 *   silently overwritten.
 * - Writes are atomic (tmp + rename) with monotonic revisions and optional
 *   optimistic-concurrency checks.
 * - Review outputs are stored as separate files; the checkpoint keeps only
 *   references. All ids are sanitized and resolved strictly inside the run
 *   directory.
 * - State-machine reducers enforce whitelisted transitions (e.g. `completed`
 *   requires termination evidence) so model-driven `record-checkpoint` calls
 *   cannot forge approval or terminal states.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { StateError, atomicWriteJson, resolveStateRootOrNull, runGit, runDirPath, utcNow } from "./state.ts";
import { assertOwnership, heldOwnershipRecord } from "./run-ownership.ts";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const CHECKPOINT_SCHEMA = 1;

export type WorkflowPhase =
	| "planning"
	| "reviewing"
	| "executing"
	| "implementation-review"
	| "completed";

export type NextAction =
	| "ask-question"
	| "continue-planning"
	| "run-review"
	| "consolidate-review"
	| "revise-plan"
	| "accept-execute"
	| "execute-items"
	| "apply-review-fixes"
	| "verify-review-fixes"
	| "finish-review"
	| "none";

export type QuestionSource = "user" | "auto-complete" | "other";

export interface PendingQuestion {
	questionId: string;
	question: string;
	options: string[];
	purpose?: string;
	allowOther?: boolean;
	autoComplete?: boolean;
	askedAt: string;
}

export interface AnsweredQuestionRef {
	questionId: string;
	answer: string;
	source: QuestionSource;
	answeredAt: string;
}

export interface PlanIdentity {
	/** Absolute path of the exact PLAN_vN.md this state refers to. */
	path: string;
	/** N parsed from the file name. */
	version: number;
	/** SHA-256 of the full file bytes. */
	sha256: string;
}

export type LaneStatus = "pending" | "running" | "complete" | "failed";

export interface ReviewLaneState {
	laneId: string;
	lens?: string;
	status: LaneStatus;
	/** Path relative to the run directory; only for complete lanes. */
	resultFile?: string;
	startedAt?: string;
	completedAt?: string;
}

export interface ReviewRoundState {
	roundId: string;
	role: "reviewer" | "criticizer";
	target: "plan" | "implementation";
	planSha256?: string;
	focus?: string;
	context?: string;
	reviewers: number;
	lanes: ReviewLaneState[];
	consolidated: boolean;
	dispositionArtifact?: string;
	startedAt: string;
	completedAt?: string;
	/** True when this round ran in a different (origin) worktree than the current one. */
	originWorktree?: string;
}

export interface ImplementationReviewState {
	/** Serialized termination condition chosen by the user; undefined = not yet asked. */
	terminationCondition?: string;
	/** Whole rounds fully disposed in the CURRENT worktree (source-worktree rounds are history only). */
	completedRounds: number;
	currentRoundId?: string;
}

export interface ExecutionApproval {
	plan: PlanIdentity;
	/** Absolute worktree root where the approval was given. */
	worktree: string;
	/** `git rev-parse HEAD` at approval time; null = unresolvable (unverifiable code state). */
	headAtApproval: string | null;
	approvedAt: string;
}

export interface ExecutionCheckpoint {
	approval: ExecutionApproval | null;
	doneVcIds: string[];
	implStatus: Record<string, string>;
	currentI?: string;
	usage: { inToks: number; outToks: number };
	pausedReason?: string;
	/** Set when the code state changed after approval: keep authorization, re-verify old VCs first. */
	reverifyAll?: boolean;
	/** True when this approval/progress was produced in a different (origin) worktree. */
	originWorktree?: string;
}

export interface OwnerInfo {
	host: string;
	pid: number;
	sessionId?: string | null;
	processToken: string;
	generation: number;
	acquiredAt: string;
}

export interface MigrationInfo {
	fromWorktree: string;
	migratedAt: string;
}

export interface WorkflowCheckpoint {
	schema: number;
	runId: string;
	/** Monotonic per-write counter. */
	revision: number;
	/** Monotonic ownership epoch; bumped when the active owner changes. */
	generation: number;
	updatedAt: string;
	phase: WorkflowPhase;
	nextAction: NextAction;
	originWorkdir: string;
	workdir: string;
	worktreeRoot: string;
	commonDir: string;
	plan: PlanIdentity | null;
	pendingQuestion: PendingQuestion | null;
	answeredQuestions: AnsweredQuestionRef[];
	reviewRounds: ReviewRoundState[];
	implementationReview?: ImplementationReviewState;
	execution?: ExecutionCheckpoint;
	autoComplete?: boolean;
	owner?: OwnerInfo | null;
	migration?: MigrationInfo | null;
}

const PHASES = new Set<WorkflowPhase>([
	"planning",
	"reviewing",
	"executing",
	"implementation-review",
	"completed",
]);

const NEXT_ACTIONS = new Set<NextAction>([
	"ask-question",
	"continue-planning",
	"run-review",
	"consolidate-review",
	"revise-plan",
	"accept-execute",
	"execute-items",
	"apply-review-fixes",
	"verify-review-fixes",
	"finish-review",
	"none",
]);

const LANE_STATUSES = new Set<LaneStatus>(["pending", "running", "complete", "failed"]);
const QUESTION_SOURCES = new Set<QuestionSource>(["user", "auto-complete", "other"]);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_ID_RE = /^\d{8}T\d{6}Z-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Validation helpers (explicit, no blind casts)
// ---------------------------------------------------------------------------

class CheckpointValidationError extends StateError {}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new CheckpointValidationError(`${label}: expected an object`);
	}
	return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new CheckpointValidationError(`${label}: expected a string`);
	return value;
}

function asOptionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	return asString(value, label);
}

function asTimestamp(value: unknown, label: string): string {
	const text = asString(value, label);
	if (!TIMESTAMP_RE.test(text)) throw new CheckpointValidationError(`${label}: malformed UTC timestamp`);
	return text;
}

function asInt(value: unknown, label: string, min: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
		throw new CheckpointValidationError(`${label}: expected an integer >= ${min}`);
	}
	return value;
}

function asEnum<T extends string>(value: unknown, allowed: Set<T>, label: string): T {
	const text = asString(value, label);
	if (!allowed.has(text as T)) {
		throw new CheckpointValidationError(`${label}: unknown value "${text}"`);
	}
	return text as T;
}

function asBool(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new CheckpointValidationError(`${label}: expected a boolean`);
	return value;
}

function asStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new CheckpointValidationError(`${label}: expected an array`);
	return value.map((entry, index) => asString(entry, `${label}[${index}]`));
}

function asRecordMap(value: unknown, label: string): Record<string, string> {
	const record = asRecord(value, label);
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(record)) out[key] = asString(entry, `${label}.${key}`);
	return out;
}

function rejectExtraKeys(record: Record<string, unknown>, expected: Set<string>, label: string): void {
	for (const key of Object.keys(record)) {
		if (!expected.has(key)) throw new CheckpointValidationError(`${label}: unexpected key "${key}"`);
	}
}

function asId(value: unknown, label: string): string {
	const text = asString(value, label);
	if (!ID_RE.test(text) || text.includes("..")) throw new CheckpointValidationError(`${label}: invalid id`);
	return text;
}

function asRunId(value: unknown, label: string): string {
	const text = asString(value, label);
	if (!RUN_ID_RE.test(text) || text.includes("..")) throw new CheckpointValidationError(`${label}: invalid run id`);
	return text;
}

function asOptionalId(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	return asId(value, label);
}

function asPlanIdentity(value: unknown, label: string): PlanIdentity {
	const record = asRecord(value, label);
	rejectExtraKeys(record, new Set(["path", "version", "sha256"]), label);
	const plan: PlanIdentity = {
		path: asString(record.path, `${label}.path`),
		version: asInt(record.version, `${label}.version`, 1),
		sha256: asString(record.sha256, `${label}.sha256`),
	};
	if (!path.isAbsolute(plan.path)) throw new CheckpointValidationError(`${label}.path: must be absolute`);
	if (!SHA256_RE.test(plan.sha256)) throw new CheckpointValidationError(`${label}.sha256: malformed digest`);
	return plan;
}

function asPendingQuestion(value: unknown, label: string): PendingQuestion {
	const record = asRecord(value, label);
	rejectExtraKeys(
		record,
		new Set(["questionId", "question", "options", "purpose", "allowOther", "autoComplete", "askedAt"]),
		label,
	);
	const question: PendingQuestion = {
		questionId: asId(record.questionId, `${label}.questionId`),
		question: asString(record.question, `${label}.question`),
		options: asStringArray(record.options, `${label}.options`),
		askedAt: asTimestamp(record.askedAt, `${label}.askedAt`),
	};
	const purpose = asOptionalString(record.purpose, `${label}.purpose`);
	if (purpose !== undefined) question.purpose = purpose;
	if (record.allowOther !== undefined) question.allowOther = asBool(record.allowOther, `${label}.allowOther`);
	if (record.autoComplete !== undefined) question.autoComplete = asBool(record.autoComplete, `${label}.autoComplete`);
	return question;
}

function asAnsweredQuestion(value: unknown, label: string): AnsweredQuestionRef {
	const record = asRecord(value, label);
	rejectExtraKeys(record, new Set(["questionId", "answer", "source", "answeredAt"]), label);
	return {
		questionId: asId(record.questionId, `${label}.questionId`),
		answer: asString(record.answer, `${label}.answer`),
		source: asEnum(record.source, QUESTION_SOURCES, `${label}.source`),
		answeredAt: asTimestamp(record.answeredAt, `${label}.answeredAt`),
	};
}

function asReviewLane(value: unknown, label: string): ReviewLaneState {
	const record = asRecord(value, label);
	rejectExtraKeys(record, new Set(["laneId", "lens", "status", "resultFile", "startedAt", "completedAt"]), label);
	const lane: ReviewLaneState = {
		laneId: asId(record.laneId, `${label}.laneId`),
		status: asEnum(record.status, LANE_STATUSES, `${label}.status`),
	};
	const lens = asOptionalString(record.lens, `${label}.lens`);
	if (lens !== undefined) lane.lens = lens;
	const resultFile = asOptionalString(record.resultFile, `${label}.resultFile`);
	if (resultFile !== undefined) {
		if (lane.status !== "complete") {
			throw new CheckpointValidationError(`${label}.resultFile: only complete lanes carry results`);
		}
		lane.resultFile = safeRelativePath(resultFile, `${label}.resultFile`);
	}
	if (record.startedAt !== undefined) lane.startedAt = asTimestamp(record.startedAt, `${label}.startedAt`);
	if (record.completedAt !== undefined) lane.completedAt = asTimestamp(record.completedAt, `${label}.completedAt`);
	return lane;
}

function asReviewRound(value: unknown, label: string): ReviewRoundState {
	const record = asRecord(value, label);
	rejectExtraKeys(
		record,
		new Set([
			"roundId", "role", "target", "planSha256", "focus", "context",
			"reviewers", "lanes", "consolidated", "dispositionArtifact", "startedAt", "completedAt", "originWorktree",
		]),
		label,
	);
	const role = asEnum(record.role, new Set(["reviewer", "criticizer"]), `${label}.role`) as ReviewRoundState["role"];
	const target = asEnum(record.target, new Set(["plan", "implementation"]), `${label}.target`) as ReviewRoundState["target"];
	const round: ReviewRoundState = {
		roundId: asId(record.roundId, `${label}.roundId`),
		role,
		target,
		reviewers: asInt(record.reviewers, `${label}.reviewers`, 1),
		lanes: Array.isArray(record.lanes) ? record.lanes.map((lane, i) => asReviewLane(lane, `${label}.lanes[${i}]`)) : [],
		consolidated: asBool(record.consolidated, `${label}.consolidated`),
		startedAt: asTimestamp(record.startedAt, `${label}.startedAt`),
	};
	if (record.planSha256 !== undefined) {
		const sha = asString(record.planSha256, `${label}.planSha256`);
		if (!SHA256_RE.test(sha)) throw new CheckpointValidationError(`${label}.planSha256: malformed digest`);
		round.planSha256 = sha;
	}
	if (record.focus !== undefined) round.focus = asString(record.focus, `${label}.focus`);
	if (record.context !== undefined) round.context = asString(record.context, `${label}.context`);
	if (record.dispositionArtifact !== undefined) {
		round.dispositionArtifact = safeRelativePath(
			asString(record.dispositionArtifact, `${label}.dispositionArtifact`),
			`${label}.dispositionArtifact`,
		);
	}
	if (record.completedAt !== undefined) round.completedAt = asTimestamp(record.completedAt, `${label}.completedAt`);
	if (record.originWorktree !== undefined) round.originWorktree = asString(record.originWorktree, `${label}.originWorktree`);
	return round;
}

function asImplementationReview(value: unknown, label: string): ImplementationReviewState {
	const record = asRecord(value, label);
	rejectExtraKeys(record, new Set(["terminationCondition", "completedRounds", "currentRoundId"]), label);
	const state: ImplementationReviewState = {
		completedRounds: asInt(record.completedRounds, `${label}.completedRounds`, 0),
	};
	if (record.terminationCondition !== undefined) {
		state.terminationCondition = asString(record.terminationCondition, `${label}.terminationCondition`);
	}
	if (record.currentRoundId !== undefined) {
		state.currentRoundId = asOptionalId(record.currentRoundId, `${label}.currentRoundId`);
	}
	return state;
}

function asExecutionApproval(value: unknown, label: string): ExecutionApproval {
	const record = asRecord(value, label);
	rejectExtraKeys(record, new Set(["plan", "worktree", "headAtApproval", "approvedAt"]), label);
	if (record.headAtApproval !== null && record.headAtApproval !== undefined) {
		asString(record.headAtApproval, `${label}.headAtApproval`);
	}
	return {
		plan: asPlanIdentity(record.plan, `${label}.plan`),
		worktree: asString(record.worktree, `${label}.worktree`),
		headAtApproval: record.headAtApproval === null ? null : (record.headAtApproval as string | undefined) ?? null,
		approvedAt: asTimestamp(record.approvedAt, `${label}.approvedAt`),
	};
}

function asExecution(value: unknown, label: string): ExecutionCheckpoint {
	const record = asRecord(value, label);
	rejectExtraKeys(
		record,
		new Set(["approval", "doneVcIds", "implStatus", "currentI", "usage", "pausedReason", "reverifyAll", "originWorktree"]),
		label,
	);
	const execution: ExecutionCheckpoint = {
		approval: record.approval === null || record.approval === undefined
			? null
			: asExecutionApproval(record.approval, `${label}.approval`),
		doneVcIds: asStringArray(record.doneVcIds ?? [], `${label}.doneVcIds`),
		implStatus: asRecordMap(record.implStatus ?? {}, `${label}.implStatus`),
		usage: (() => {
			const usage = asRecord(record.usage ?? { inToks: 0, outToks: 0 }, `${label}.usage`);
			rejectExtraKeys(usage, new Set(["inToks", "outToks"]), `${label}.usage`);
			return {
				inToks: asInt(usage.inToks, `${label}.usage.inToks`, 0),
				outToks: asInt(usage.outToks, `${label}.usage.outToks`, 0),
			};
		})(),
	};
	if (record.currentI !== undefined) execution.currentI = asString(record.currentI, `${label}.currentI`);
	if (record.pausedReason !== undefined) execution.pausedReason = asString(record.pausedReason, `${label}.pausedReason`);
	if (record.reverifyAll !== undefined) execution.reverifyAll = asBool(record.reverifyAll, `${label}.reverifyAll`);
	if (record.originWorktree !== undefined) execution.originWorktree = asString(record.originWorktree, `${label}.originWorktree`);
	return execution;
}

function asOwner(value: unknown, label: string): OwnerInfo {
	const record = asRecord(value, label);
	rejectExtraKeys(record, new Set(["host", "pid", "sessionId", "processToken", "generation", "acquiredAt"]), label);
	const owner: OwnerInfo = {
		host: asString(record.host, `${label}.host`),
		pid: asInt(record.pid, `${label}.pid`, 1),
		processToken: asId(record.processToken, `${label}.processToken`),
		generation: asInt(record.generation, `${label}.generation`, 1),
		acquiredAt: asTimestamp(record.acquiredAt, `${label}.acquiredAt`),
	};
	if (record.sessionId !== null && record.sessionId !== undefined) {
		owner.sessionId = asString(record.sessionId, `${label}.sessionId`);
	}
	return owner;
}

/**
 * Validate an unknown payload as a {@link WorkflowCheckpoint}. Throws
 * {@link StateError} with a specific message on any violation; never
 * blind-casts, and rejects unknown schema versions and unexpected keys.
 */
export function validateCheckpoint(data: unknown): WorkflowCheckpoint {
	const record = asRecord(data, "checkpoint");
	const allowed = new Set([
		"schema", "runId", "revision", "generation", "updatedAt", "phase", "nextAction",
		"originWorkdir", "workdir", "worktreeRoot", "commonDir", "plan", "pendingQuestion",
		"answeredQuestions", "reviewRounds", "implementationReview", "execution",
		"autoComplete", "owner", "migration",
	]);
	rejectExtraKeys(record, allowed, "checkpoint");
	const schema = asInt(record.schema, "checkpoint.schema", 1);
	if (schema !== CHECKPOINT_SCHEMA) {
		throw new CheckpointValidationError(`checkpoint.schema: unsupported version ${schema} (expected ${CHECKPOINT_SCHEMA})`);
	}
	const phase = asEnum(record.phase, PHASES, "checkpoint.phase");
	const nextAction = asEnum(record.nextAction, NEXT_ACTIONS, "checkpoint.nextAction");
	const checkpoint: WorkflowCheckpoint = {
		schema,
		runId: asRunId(record.runId, "checkpoint.runId"),
		revision: asInt(record.revision, "checkpoint.revision", 1),
		generation: asInt(record.generation, "checkpoint.generation", 1),
		updatedAt: asTimestamp(record.updatedAt, "checkpoint.updatedAt"),
		phase,
		nextAction,
		originWorkdir: asString(record.originWorkdir, "checkpoint.originWorkdir"),
		workdir: asString(record.workdir, "checkpoint.workdir"),
		worktreeRoot: asString(record.worktreeRoot, "checkpoint.worktreeRoot"),
		commonDir: asString(record.commonDir, "checkpoint.commonDir"),
		plan: record.plan === null || record.plan === undefined ? null : asPlanIdentity(record.plan, "checkpoint.plan"),
		pendingQuestion:
			record.pendingQuestion === null || record.pendingQuestion === undefined
				? null
				: asPendingQuestion(record.pendingQuestion, "checkpoint.pendingQuestion"),
		answeredQuestions: Array.isArray(record.answeredQuestions)
			? record.answeredQuestions.map((entry, i) => asAnsweredQuestion(entry, `checkpoint.answeredQuestions[${i}]`))
			: [],
		reviewRounds: Array.isArray(record.reviewRounds)
			? record.reviewRounds.map((entry, i) => asReviewRound(entry, `checkpoint.reviewRounds[${i}]`))
			: [],
	};
	if (record.implementationReview !== undefined) {
		checkpoint.implementationReview = asImplementationReview(record.implementationReview, "checkpoint.implementationReview");
	}
	if (record.execution !== undefined) {
		checkpoint.execution = asExecution(record.execution, "checkpoint.execution");
	}
	if (record.autoComplete !== undefined) checkpoint.autoComplete = asBool(record.autoComplete, "checkpoint.autoComplete");
	if (record.owner !== undefined && record.owner !== null) {
		checkpoint.owner = asOwner(record.owner, "checkpoint.owner");
	}
	if (record.migration !== undefined && record.migration !== null) {
		const migration = asRecord(record.migration, "checkpoint.migration");
		rejectExtraKeys(migration, new Set(["fromWorktree", "migratedAt"]), "checkpoint.migration");
		checkpoint.migration = {
			fromWorktree: asString(migration.fromWorktree, "checkpoint.migration.fromWorktree"),
			migratedAt: asTimestamp(migration.migratedAt, "checkpoint.migration.migratedAt"),
		};
	}
	if (phase === "completed" && nextAction !== "none") {
		throw new CheckpointValidationError("checkpoint: completed phase must use nextAction \"none\"");
	}
	return checkpoint;
}

// ---------------------------------------------------------------------------
// Safe paths and file digests
// ---------------------------------------------------------------------------

/**
 * Validate a checkpoint-relative path: relative, no traversal, no absolute
 * escape. Returns the normalized POSIX-style relative path.
 */
export function safeRelativePath(value: string, label: string): string {
	if (value === "" || value.includes("\0")) throw new CheckpointValidationError(`${label}: empty or NUL path`);
	if (path.isAbsolute(value)) throw new CheckpointValidationError(`${label}: must be relative`);
	const segments = value.split(/[\\/]/);
	for (const segment of segments) {
		if (segment === "" || segment === "." || segment === "..") {
			throw new CheckpointValidationError(`${label}: path traversal is not allowed`);
		}
	}
	return segments.join("/");
}

/** Resolve `relative` inside `root`, verifying containment on the real filesystem. */
export function safeResolveInside(root: string, relative: string, label: string): string {
	const normalized = safeRelativePath(relative, label);
	const resolved = path.resolve(root, normalized);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
		throw new CheckpointValidationError(`${label}: escapes the run directory`);
	}
	if (existsSync(resolved)) {
		const realRoot = fs.realpathSync(root);
		const realResolved = fs.realpathSync(resolved);
		if (realResolved !== realRoot && !realResolved.startsWith(`${realRoot}${path.sep}`)) {
			throw new CheckpointValidationError(`${label}: symlink escapes the run directory`);
		}
	}
	return resolved;
}

/** SHA-256 over the full file bytes; throws StateError when unreadable. */
export function sha256File(absolutePath: string): string {
	try {
		return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
	} catch (error) {
		throw new StateError(`cannot hash ${absolutePath}: ${(error as Error).message}`);
	}
}

/** `git rev-parse HEAD` at `workdir`, or null when unresolvable (no commits / no git). */
export function resolveHeadAt(workdir: string): string | null {
	const result = runGit(workdir, "rev-parse", "HEAD");
	if (result.code !== 0) return null;
	const head = result.stdout.trim();
	return head === "" ? null : head;
}

/** `git rev-parse --show-toplevel` at `workdir`, or null when unresolvable. */
export function resolveWorktreeRoot(workdir: string): string | null {
	const result = runGit(workdir, "rev-parse", "--show-toplevel");
	if (result.code !== 0) return null;
	const top = result.stdout.trim();
	return top === "" ? null : path.resolve(workdir, top);
}

/** Build a plan identity from an absolute PLAN_vN.md path. */
export function planIdentityOf(planPath: string, version: number): PlanIdentity {
	if (!path.isAbsolute(planPath)) throw new StateError(`plan path must be absolute: ${planPath}`);
	const match = /PLAN_v(\d+)\.md$/.exec(path.basename(planPath));
	const resolvedVersion = match ? Number.parseInt(match[1]!, 10) : version;
	return { path: planPath, version: resolvedVersion, sha256: sha256File(planPath) };
}

// ---------------------------------------------------------------------------
// Storage: load / create / mutate
// ---------------------------------------------------------------------------

export type CheckpointLoadResult =
	| { status: "ok"; checkpoint: WorkflowCheckpoint }
	| { status: "missing" }
	| { status: "corrupt"; error: string };

export function checkpointFilePath(workdir: string, runId: string): string | null {
	const runDir = runDirPath(workdir, runId);
	return runDir === null ? null : path.join(runDir, "checkpoint.json");
}

export function loadCheckpoint(workdir: string, runId: string): CheckpointLoadResult {
	const filePath = checkpointFilePath(workdir, runId);
	if (filePath === null) return { status: "missing" };
	if (!existsSync(filePath)) return { status: "missing" };
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		return { status: "corrupt", error: `invalid JSON: ${(error as Error).message}` };
	}
	try {
		return { status: "ok", checkpoint: validateCheckpoint(data) };
	} catch (error) {
		return { status: "corrupt", error: (error as Error).message };
	}
}

export interface CreateCheckpointInput {
	runId: string;
	originWorkdir: string;
	workdir: string;
}

function gitContext(workdir: string): { worktreeRoot: string; commonDir: string } {
	const stateRoot = resolveStateRootOrNull(workdir);
	if (stateRoot === null) throw new StateError("no pi-plans state found; run init first");
	const worktreeRoot = resolveWorktreeRoot(workdir) ?? path.resolve(workdir);
	return { worktreeRoot, commonDir: path.dirname(stateRoot) };
}

/** Create the initial checkpoint for a run. Refuses to overwrite existing files. */
export function createCheckpoint(workdir: string, input: CreateCheckpointInput): WorkflowCheckpoint {
	const runDir = runDirPath(workdir, input.runId);
	if (runDir === null) throw new StateError(`run does not exist: ${input.runId}`);
	const filePath = path.join(runDir, "checkpoint.json");
	if (existsSync(filePath)) throw new StateError(`checkpoint already exists for ${input.runId}; use mutateCheckpoint`);
	const { worktreeRoot, commonDir } = gitContext(input.workdir);
	const checkpoint: WorkflowCheckpoint = {
		schema: CHECKPOINT_SCHEMA,
		runId: input.runId,
		revision: 1,
		generation: 1,
		updatedAt: utcNow(),
		phase: "planning",
		nextAction: "continue-planning",
		originWorkdir: path.resolve(input.originWorkdir),
		workdir: path.resolve(input.workdir),
		worktreeRoot,
		commonDir,
		plan: null,
		pendingQuestion: null,
		answeredQuestions: [],
		reviewRounds: [],
	};
	validateCheckpoint(checkpoint);
	atomicWriteJson(filePath, checkpoint);
	return checkpoint;
}

export class StaleCheckpointError extends StateError {}

export interface MutateOptions {
	/** Fail when the on-disk revision moved before the mutator runs. */
	expectRevision?: number;
	/** When set, the write is refused unless this session still owns the run. */
	owner?: { processToken: string; generation: number };
}

/**
 * Read-modify-write the checkpoint atomically. The mutator receives a deep
 * copy and returns the next state; revision and updatedAt are bumped here.
 * Corrupt files are never overwritten — mutate throws instead.
 */
export function mutateCheckpoint(
	workdir: string,
	runId: string,
	mutator: (current: WorkflowCheckpoint) => WorkflowCheckpoint,
	options?: MutateOptions,
): WorkflowCheckpoint {
	const runDir = runDirPath(workdir, runId);
	if (runDir === null) throw new StateError(`run does not exist: ${runId}`);
	const filePath = path.join(runDir, "checkpoint.json");
	const load = loadCheckpoint(workdir, runId);
	if (load.status === "missing") throw new StateError(`no checkpoint for ${runId}; create it first`);
	if (load.status === "corrupt") {
		throw new StateError(
			`checkpoint for ${runId} is corrupt (${load.error}); refusing to overwrite — repair or remove it explicitly`,
		);
	}
	if (options?.expectRevision !== undefined && load.checkpoint.revision !== options.expectRevision) {
		throw new StaleCheckpointError(
			`checkpoint revision moved: expected ${options.expectRevision}, found ${load.checkpoint.revision}`,
		);
	}
	// F-005 (implementation review): whenever THIS process holds the run lease,
	// every advance re-verifies it — a takeover elsewhere fails the write here.
	const heldOwner = options?.owner ?? heldOwnershipRecord(workdir, runId);
	if (heldOwner) assertOwnership(workdir, runId, heldOwner);
	const next = mutator(structuredClone(load.checkpoint));
	next.revision = load.checkpoint.revision + 1;
	next.updatedAt = utcNow();
	if (next.generation < load.checkpoint.generation) next.generation = load.checkpoint.generation;
	validateCheckpoint(next);
	atomicWriteJson(filePath, next);
	return next;
}

// ---------------------------------------------------------------------------
// Review output files
// ---------------------------------------------------------------------------

/**
 * Persist one lane's full review output under `reviews/` in the run
 * directory. Returns the checkpoint-relative reference path.
 */
export function writeReviewOutput(
	workdir: string,
	runId: string,
	roundId: string,
	laneId: string,
	content: string,
): string {
	const runDir = runDirPath(workdir, runId);
	if (runDir === null) throw new StateError(`run does not exist: ${runId}`);
	const safeRound = asId(roundId, "roundId");
	const safeLane = asId(laneId, "laneId");
	const reviewsDir = path.join(runDir, "reviews");
	mkdirSync(reviewsDir, { recursive: true });
	const fileName = `${safeRound}__${safeLane}.md`;
	const target = safeResolveInside(runDir, path.join("reviews", fileName), "review output");
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, target);
	return path.posix.join("reviews", fileName);
}

/** Read a review output referenced by a checkpoint lane. */
export function readReviewOutput(workdir: string, runId: string, relativePath: string): string {
	const runDir = runDirPath(workdir, runId);
	if (runDir === null) throw new StateError(`run does not exist: ${runId}`);
	const target = safeResolveInside(runDir, relativePath, "review output");
	return readFileSync(target, "utf8");
}

// ---------------------------------------------------------------------------
// State-machine reducers (whitelisted transitions only)
// ---------------------------------------------------------------------------

function questionPhases(cp: WorkflowCheckpoint): boolean {
	return cp.phase === "planning" || cp.phase === "reviewing" || cp.phase === "implementation-review";
}

/** F-005: an answered ledger entry always wins over a same-id pending question. */
export function reconcilePendingWithAnswered(cp: WorkflowCheckpoint): WorkflowCheckpoint {
	if (cp.pendingQuestion === null) return cp;
	if (cp.answeredQuestions.some((entry) => entry.questionId === cp.pendingQuestion?.questionId)) {
		return { ...cp, pendingQuestion: null };
	}
	return cp;
}

export function applyQuestionAsked(cp: WorkflowCheckpoint, question: Omit<PendingQuestion, "askedAt">, askedAt?: string): WorkflowCheckpoint {
	if (!questionPhases(cp)) throw new StateError(`cannot ask a question in phase "${cp.phase}"`);
	if (cp.answeredQuestions.some((entry) => entry.questionId === question.questionId)) {
		throw new StateError(`question ${question.questionId} is already answered; do not re-ask`);
	}
	if (cp.pendingQuestion !== null && cp.pendingQuestion.questionId !== question.questionId) {
		throw new StateError(`another question is pending: ${cp.pendingQuestion.questionId}`);
	}
	return {
		...cp,
		pendingQuestion: { ...question, askedAt: askedAt ?? utcNow() },
		nextAction: "ask-question",
	};
}

export function applyQuestionAnswered(
	cp: WorkflowCheckpoint,
	questionId: string,
	answer: string,
	source: QuestionSource,
): WorkflowCheckpoint {
	if (cp.pendingQuestion?.questionId !== questionId) {
		throw new StateError(`no pending question ${questionId}`);
	}
	return {
		...cp,
		pendingQuestion: null,
		answeredQuestions: [
			...cp.answeredQuestions,
			{ questionId, answer, source, answeredAt: utcNow() },
		],
	};
}

export function applyPlanWritten(cp: WorkflowCheckpoint, plan: PlanIdentity): WorkflowCheckpoint {
	if (cp.phase !== "planning" && cp.phase !== "reviewing") {
		throw new StateError(`cannot record a plan version in phase "${cp.phase}"`);
	}
	return { ...cp, plan };
}

export function applyReviewRoundStarted(cp: WorkflowCheckpoint, round: Omit<ReviewRoundState, "startedAt" | "consolidated" | "lanes"> & { lanes: Array<Omit<ReviewLaneState, "status">> }): WorkflowCheckpoint {
	if (cp.phase !== "planning" && cp.phase !== "reviewing" && cp.phase !== "implementation-review") {
		throw new StateError(`cannot start a review round in phase "${cp.phase}"`);
	}
	if (cp.reviewRounds.some((entry) => entry.roundId === round.roundId)) {
		throw new StateError(`review round ${round.roundId} already exists`);
	}
	if (round.target === "plan") {
		if (cp.plan === null) throw new StateError("plan-target review requires a recorded plan identity");
	}
	if (round.target === "implementation") {
		if (cp.phase !== "implementation-review") {
			throw new StateError("implementation review rounds require phase \"implementation-review\"");
		}
		if (cp.implementationReview?.terminationCondition === undefined) {
			throw new StateError("implementation review requires a recorded termination condition first");
		}
	}
	const started: ReviewRoundState = {
		...round,
		consolidated: false,
		startedAt: utcNow(),
		lanes: round.lanes.map((lane) => ({ ...lane, status: "pending" as LaneStatus, startedAt: utcNow() })),
	};
	const next: WorkflowCheckpoint = { ...cp, reviewRounds: [...cp.reviewRounds, started] };
	if (round.target === "implementation" && cp.implementationReview) {
		next.implementationReview = { ...cp.implementationReview, currentRoundId: round.roundId };
	}
	return next;
}

export function applyLaneResult(
	cp: WorkflowCheckpoint,
	roundId: string,
	laneId: string,
	result: { ok: boolean; resultFile?: string; error?: string },
): WorkflowCheckpoint {
	const round = cp.reviewRounds.find((entry) => entry.roundId === roundId);
	if (!round) throw new StateError(`unknown review round: ${roundId}`);
	const lane = round.lanes.find((entry) => entry.laneId === laneId);
	if (!lane) throw new StateError(`unknown lane ${laneId} in round ${roundId}`);
	if (lane.status === "complete") {
		if (lane.resultFile === result.resultFile) return cp; // idempotent replay
		throw new StateError(`lane ${laneId} is already complete with a different result`);
	}
	const nextLane: ReviewLaneState = {
		...lane,
		status: result.ok ? "complete" : "failed",
		completedAt: utcNow(),
	};
	if (result.ok) {
		if (!result.resultFile) throw new StateError("successful lanes must reference a persisted result file");
		nextLane.resultFile = result.resultFile;
	}
	const nextRound: ReviewRoundState = { ...round, lanes: round.lanes.map((entry) => (entry.laneId === laneId ? nextLane : entry)) };
	return { ...cp, reviewRounds: cp.reviewRounds.map((entry) => (entry.roundId === roundId ? nextRound : entry)) };
}

export function applyReviewConsolidated(cp: WorkflowCheckpoint, roundId: string, dispositionArtifact?: string): WorkflowCheckpoint {
	const round = cp.reviewRounds.find((entry) => entry.roundId === roundId);
	if (!round) throw new StateError(`unknown review round: ${roundId}`);
	if (round.consolidated) return cp; // idempotent
	if (round.lanes.length === 0 || !round.lanes.every((lane) => lane.status === "complete" || lane.status === "failed")) {
		throw new StateError(`round ${roundId} still has non-terminal lanes`);
	}
	if (round.role === "reviewer" && !round.lanes.some((lane) => lane.status === "complete")) {
		throw new StateError(`round ${roundId} has no successful lane to consolidate`);
	}
	const nextRound: ReviewRoundState = {
		...round,
		consolidated: true,
		completedAt: utcNow(),
	};
	if (dispositionArtifact !== undefined) nextRound.dispositionArtifact = dispositionArtifact;
	return { ...cp, reviewRounds: cp.reviewRounds.map((entry) => (entry.roundId === roundId ? nextRound : entry)) };
}

/** F-004: `completed` requires explicit evidence; approval cannot be forged by state writes. */
export function applyCompleted(cp: WorkflowCheckpoint, evidence: string): WorkflowCheckpoint {
	if (cp.phase !== "implementation-review") {
		throw new StateError(`cannot complete from phase "${cp.phase}"`);
	}
	const review = cp.implementationReview;
	if (!review || review.terminationCondition === undefined) {
		throw new StateError("cannot complete without a recorded termination condition");
	}
	if (evidence.trim() === "") throw new StateError("completion requires non-empty evidence");
	return { ...cp, phase: "completed", nextAction: "none" };
}

export function applyExecutionApproved(cp: WorkflowCheckpoint, approval: ExecutionApproval): WorkflowCheckpoint {
	// F-007 (implementation review): terminal and review phases cannot approve
	// execution; a re-approval (stop/migration reset approval to null) is legal
	// only while execution is still the owning phase or planning/reviewing.
	if (cp.phase === "implementation-review" || cp.phase === "completed") {
		throw new StateError(`cannot approve execution from phase "${cp.phase}"`);
	}
	if (cp.nextAction !== "accept-execute") {
		throw new StateError(`execution approval requires nextAction "accept-execute" (found "${cp.nextAction}")`);
	}
	if (cp.plan !== null && cp.plan.sha256 !== approval.plan.sha256) {
		throw new StateError("approved plan does not match the checkpoint's recorded plan");
	}
	return {
		...cp,
		phase: "executing",
		nextAction: "execute-items",
		plan: approval.plan,
		execution: {
			approval,
			doneVcIds: [],
			implStatus: {},
			usage: { inToks: 0, outToks: 0 },
		},
	};
}

export interface ExecutionProgressInput {
	doneVcIds?: string[];
	implStatus?: Record<string, string>;
	currentI?: string;
	usage?: { inToks: number; outToks: number };
	pausedReason?: string | null;
}

export function applyExecutionProgress(cp: WorkflowCheckpoint, progress: ExecutionProgressInput): WorkflowCheckpoint {
	if (cp.phase !== "executing" || !cp.execution) throw new StateError("execution progress requires phase \"executing\"");
	const execution: ExecutionCheckpoint = { ...cp.execution };
	if (progress.doneVcIds !== undefined) execution.doneVcIds = progress.doneVcIds;
	if (progress.implStatus !== undefined) execution.implStatus = progress.implStatus;
	if (progress.currentI !== undefined) execution.currentI = progress.currentI;
	if (progress.usage !== undefined) {
		execution.usage = {
			inToks: execution.usage.inToks + progress.usage.inToks,
			outToks: execution.usage.outToks + progress.usage.outToks,
		};
	}
	if (progress.pausedReason === null) delete execution.pausedReason;
	else if (progress.pausedReason !== undefined) execution.pausedReason = progress.pausedReason;
	return { ...cp, execution };
}

/** D-011/F-001: code state changed under an unchanged plan — keep authorization, re-verify first. */
export function applyExecutionHeadChanged(cp: WorkflowCheckpoint): WorkflowCheckpoint {
	if (cp.phase !== "executing" || !cp.execution) throw new StateError("requires phase \"executing\"");
	return { ...cp, execution: { ...cp.execution, reverifyAll: true } };
}

export function applyExecutionCompleted(cp: WorkflowCheckpoint): WorkflowCheckpoint {
	if (cp.phase !== "executing" || !cp.execution) throw new StateError("requires phase \"executing\"");
	return {
		...cp,
		phase: "implementation-review",
		nextAction: "ask-question",
		execution: { ...cp.execution, pausedReason: undefined },
	};
}

export function applyImplementationReviewConfigured(cp: WorkflowCheckpoint, terminationCondition: string): WorkflowCheckpoint {
	if (cp.phase !== "implementation-review") throw new StateError("requires phase \"implementation-review\"");
	if (cp.implementationReview?.terminationCondition !== undefined) {
		throw new StateError("termination condition already configured; do not re-ask");
	}
	return {
		...cp,
		implementationReview: {
			terminationCondition,
			completedRounds: cp.implementationReview?.completedRounds ?? 0,
		},
		nextAction: "run-review",
	};
}

export function applyImplementationRoundFinished(cp: WorkflowCheckpoint): WorkflowCheckpoint {
	if (cp.phase !== "implementation-review" || !cp.implementationReview) {
		throw new StateError("requires phase \"implementation-review\"");
	}
	const review = cp.implementationReview;
	if (review.currentRoundId === undefined) throw new StateError("no current round to finish");
	const round = cp.reviewRounds.find((entry) => entry.roundId === review.currentRoundId);
	if (!round || !round.consolidated) throw new StateError("current round is not consolidated");
	return {
		...cp,
		implementationReview: { ...review, completedRounds: review.completedRounds + 1, currentRoundId: undefined },
	};
}

/**
 * F-003/D-007: migrate a run into the current worktree. The termination
 * condition survives; completed rounds, approval, and VC validity do not.
 */
export function applyMigration(
	cp: WorkflowCheckpoint,
	target: { workdir: string; worktreeRoot: string; commonDir: string },
): WorkflowCheckpoint {
	return {
		...cp,
		workdir: path.resolve(target.workdir),
		worktreeRoot: target.worktreeRoot,
		commonDir: target.commonDir,
		migration: { fromWorktree: cp.worktreeRoot, migratedAt: utcNow() },
		execution: cp.execution
			? {
					approval: null,
					doneVcIds: [],
					implStatus: {},
					usage: cp.execution.usage,
					originWorktree: cp.execution.originWorktree ?? cp.worktreeRoot,
				}
			: undefined,
		implementationReview: cp.implementationReview
			? { terminationCondition: cp.implementationReview.terminationCondition, completedRounds: 0 }
			: undefined,
		nextAction: migrationNextAction(cp),
	};
}

/** F-007 (implementation review): migration must not hand accept-execute to phases that still owe review work. */
function migrationNextAction(cp: WorkflowCheckpoint): NextAction {
	if (cp.phase === "implementation-review") return "run-review";
	if (cp.phase === "executing") return cp.plan !== null ? "accept-execute" : cp.nextAction;
	return cp.nextAction;
}

/** Mark a paused stop without erasing the last phase (D-008). */
export function applyExecutionStopped(cp: WorkflowCheckpoint, reason: string): WorkflowCheckpoint {
	if (cp.phase !== "executing" || !cp.execution) throw new StateError("requires phase \"executing\"");
	return { ...cp, execution: { ...cp.execution, pausedReason: reason } };
}

// ---------------------------------------------------------------------------
// Review-round orchestration helpers (refine tool integration, I-004)
// ---------------------------------------------------------------------------

export interface RoundSpec {
	roundId: string;
	role: "reviewer" | "criticizer";
	target: "plan" | "implementation";
	reviewers: number;
	lanes: Array<{ laneId: string; lens?: string }>;
	/** Absolute PLAN path; recorded when the checkpoint has no plan identity yet. */
	planPath?: string;
	focus?: string;
	context?: string;
}

/**
 * Create the round in the checkpoint, or resume an existing one idempotently.
 * Resuming validates the plan digest: lanes from a different plan version are
 * never silently reused.
 */
export function startReviewRound(workdir: string, runId: string, spec: RoundSpec): WorkflowCheckpoint {
	const load = loadCheckpoint(workdir, runId);
	if (load.status === "missing") throw new StateError(`no checkpoint for ${runId}; create it first`);
	if (load.status === "corrupt") throw new StateError(`checkpoint for ${runId} is corrupt (${load.error}); refusing to use it`);
	const existing = load.checkpoint.reviewRounds.find((round) => round.roundId === spec.roundId);
	if (existing) {
		if (existing.role !== spec.role || existing.target !== spec.target) {
			throw new StateError(`round ${spec.roundId} exists with a different role/target; use a new round id`);
		}
		const specLanes = spec.lanes.map((lane) => lane.laneId).sort().join(",");
		const existingLanes = existing.lanes.map((lane) => lane.laneId).sort().join(",");
		if (specLanes !== existingLanes) {
			throw new StateError(`round ${spec.roundId} exists with different lanes; use a new round id`);
		}
		if (spec.planPath) {
			const sha = sha256File(spec.planPath);
			if (existing.planSha256 !== undefined && existing.planSha256 !== sha) {
				throw new StateError(
					`round ${spec.roundId} was recorded against a different plan version; start a new round`,
				);
			}
		}
		return load.checkpoint;
	}
	return mutateCheckpoint(workdir, runId, (cp) => {
		let next = cp;
		if (spec.target === "plan" && spec.planPath && next.plan === null) {
			next = applyPlanWritten(next, planIdentityOf(spec.planPath, 1));
		}
		const planSha = spec.planPath ? sha256File(spec.planPath) : next.plan?.sha256;
		return applyReviewRoundStarted(next, {
			roundId: spec.roundId,
			role: spec.role,
			target: spec.target,
			reviewers: spec.reviewers,
			planSha256: planSha,
			focus: spec.focus,
			context: spec.context,
			lanes: spec.lanes,
		});
	});
}

/**
 * Persist one lane outcome: successful outputs are written to a result file
 * BEFORE the checkpoint references them; failures only mark the lane.
 */
export function recordLaneOutcome(
	workdir: string,
	runId: string,
	roundId: string,
	laneId: string,
	result: { ok: boolean; output?: string; error?: string },
): { resultFile?: string } {
	if (result.ok) {
		if (!result.output) throw new StateError("successful lanes must carry output to persist");
		const resultFile = writeReviewOutput(workdir, runId, roundId, laneId, result.output);
		mutateCheckpoint(workdir, runId, (cp) => applyLaneResult(cp, roundId, laneId, { ok: true, resultFile }));
		return { resultFile };
	}
	mutateCheckpoint(workdir, runId, (cp) =>
		applyLaneResult(cp, roundId, laneId, { ok: false, error: result.error }),
	);
	return {};
}

/** Lanes whose persisted outputs can be reused for a resumed round. */
export function reusableLaneOutputs(cp: WorkflowCheckpoint, roundId: string): Array<{ laneId: string; resultFile: string }> {
	const round = cp.reviewRounds.find((entry) => entry.roundId === roundId);
	if (!round) return [];
	return round.lanes
		.filter((lane) => lane.status === "complete" && lane.resultFile !== undefined)
		.map((lane) => ({ laneId: lane.laneId, resultFile: lane.resultFile! }));
}

export function newProcessToken(): string {
	return randomUUID().replace(/-/g, "");
}
