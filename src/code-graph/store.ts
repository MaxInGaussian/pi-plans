/**
 * SQLite handle, prepared statements and BEGIN IMMEDIATE write transactions
 * for the code-graph module.
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";
import { CURRENT_SCHEMA_VERSION, FUNCTION_RECORDS_VIEW, SCHEMA_STATEMENTS } from "./schema.ts";
import { PathError } from "./paths.ts";
import type { CodeGraphSnapshot, GraphMeta } from "./types.ts";

export interface StoreOptions {
	dbPath: string;
	worktreeRoot: string;
	gitCommonDir: string;
	parserVersions?: Record<string, string>;
	readonly?: boolean;
}

export class Store {
	readonly db: DatabaseSync;
	readonly dbPath: string;
	readonly worktreeRoot: string;
	readonly gitCommonDir: string;

	private prepared: Map<string, StatementSync> = new Map();
	private readonly mode: "rw" | "ro";

	constructor(opts: StoreOptions, sqlite: typeof import("node:sqlite")) {
		this.dbPath = opts.dbPath;
		this.worktreeRoot = opts.worktreeRoot;
		this.gitCommonDir = opts.gitCommonDir;
		this.mode = opts.readonly ? "ro" : "rw";
		this.db = new sqlite.DatabaseSync(opts.dbPath, {
			open: true,
			readOnly: opts.readonly === true,
			enableForeignKeyConstraints: true,
		});
		this.bootstrap(opts);
	}

	private bootstrap(opts: StoreOptions): void {
		this.db.exec("PRAGMA foreign_keys = ON");
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA busy_timeout = 5000");
		const existing = this.db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='graph_meta'")
			.get();
		if (!existing) {
			this.applyMigrations();
			this.upsertMeta({
				schemaVersion: CURRENT_SCHEMA_VERSION,
				worktreeRoot: opts.worktreeRoot,
				gitCommonDir: opts.gitCommonDir,
				parserVersions: opts.parserVersions ?? {},
				updatedAt: new Date().toISOString(),
			});
			return;
		}
		const row = this.db.prepare("SELECT MAX(schema_version) AS v FROM graph_meta").get() as { v: number } | undefined;
		const version = row?.v ?? 0;
		if (version < CURRENT_SCHEMA_VERSION) {
			this.applyIncrementalMigrations(version, opts);
			this.upsertMeta({
				schemaVersion: CURRENT_SCHEMA_VERSION,
				worktreeRoot: opts.worktreeRoot,
				gitCommonDir: opts.gitCommonDir,
				parserVersions: opts.parserVersions ?? {},
				updatedAt: new Date().toISOString(),
			});
		}
	}

	/** Step-level idempotent incremental migration: each step checks its target
	 *  artifact (PRAGMA table_info / sqlite_master) before applying, so a crash
	 *  mid-upgrade can be safely re-entered. schema_version advances only after
	 *  all steps complete. */
	private applyIncrementalMigrations(fromVersion: number, opts: StoreOptions): void {
		this.tx(() => {
			if (fromVersion < 2) {
				const snapshotTable = this.db
					.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='code_graph_snapshot'")
					.get();
				if (!snapshotTable) {
					this.db.exec(
						`CREATE TABLE code_graph_snapshot (
						id INTEGER PRIMARY KEY AUTOINCREMENT,
						head_commit TEXT NOT NULL,
						uncommitted_paths TEXT NOT NULL,
						recorded_at TEXT NOT NULL
					)`,
					);
				}
				const columns = this.db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
				if (!columns.some((column) => column.name === "pending_kind")) {
					this.db.exec("ALTER TABLE files ADD COLUMN pending_kind TEXT");
				}
				const initialSnapshot = this.db
					.prepare("SELECT COUNT(*) AS c FROM code_graph_snapshot")
					.get() as { c: number };
				if (initialSnapshot.c === 0) {
					this.db
						.prepare(
							`INSERT INTO code_graph_snapshot (head_commit, uncommitted_paths, recorded_at)
							 VALUES (?, ?, ?)`,
						)
						.run("", "[]", new Date().toISOString());
				}
			}
			void opts;
		});
	}

	private applyMigrations(): void {
		for (const stmt of SCHEMA_STATEMENTS) this.db.exec(stmt);
		this.db.exec(FUNCTION_RECORDS_VIEW);
		this.db
			.prepare(
				`INSERT INTO graph_meta (schema_version, worktree_root, git_common_dir, parser_versions, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(schema_version) DO UPDATE SET
					worktree_root = excluded.worktree_root,
					git_common_dir = excluded.git_common_dir,
					parser_versions = excluded.parser_versions,
					updated_at = excluded.updated_at`,
			)
			.run(
				CURRENT_SCHEMA_VERSION,
				this.worktreeRoot,
				this.gitCommonDir,
				JSON.stringify({}),
				new Date().toISOString(),
			);
	}

	upsertMeta(meta: GraphMeta): void {
		this.db
			.prepare(
				`INSERT INTO graph_meta (schema_version, worktree_root, git_common_dir, parser_versions, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(schema_version) DO UPDATE SET
					worktree_root = excluded.worktree_root,
					git_common_dir = excluded.git_common_dir,
					parser_versions = excluded.parser_versions,
					updated_at = excluded.updated_at`,
			)
			.run(
				meta.schemaVersion,
				meta.worktreeRoot,
				meta.gitCommonDir,
				JSON.stringify(meta.parserVersions),
				meta.updatedAt,
			);
	}

	upsertSnapshot(headCommit: string, uncommittedPaths: string[]): void {
		this.tx(() => {
			this.db
				.prepare(
					`INSERT INTO code_graph_snapshot (head_commit, uncommitted_paths, recorded_at)
					 VALUES (?, ?, ?)`,
				)
				.run(headCommit, JSON.stringify(uncommittedPaths), new Date().toISOString());
		});
	}

	readLatestSnapshot(): CodeGraphSnapshot | null {
		const row = this.db
			.prepare(
					`SELECT id, head_commit, uncommitted_paths, recorded_at
				 FROM code_graph_snapshot ORDER BY id DESC LIMIT 1`,
			)
			.get() as
			| { id: number; head_commit: string; uncommitted_paths: string; recorded_at: string }
			| undefined;
		if (!row) return null;
		return {
			id: row.id,
			headCommit: row.head_commit,
			uncommittedPaths: JSON.parse(row.uncommitted_paths) as string[],
			recordedAt: row.recorded_at,
		};
	}

	readMeta(): GraphMeta | null {
		const row = this.db
			.prepare(
				`SELECT schema_version, worktree_root, git_common_dir, parser_versions, updated_at
				 FROM graph_meta ORDER BY schema_version DESC LIMIT 1`,
			)
			.get() as {
			schema_version: number;
			worktree_root: string;
			git_common_dir: string;
			parser_versions: string;
			updated_at: string;
		} | undefined;
		if (!row) return null;
		return {
			schemaVersion: row.schema_version,
			worktreeRoot: row.worktree_root,
			gitCommonDir: row.git_common_dir,
			parserVersions: JSON.parse(row.parser_versions) as Record<string, string>,
			updatedAt: row.updated_at,
		};
	}

	checkWorktree(currentWorktreeRoot: string, currentGitCommonDir: string): void {
		const meta = this.readMeta();
		if (!meta) return;
		if (meta.worktreeRoot !== currentWorktreeRoot || meta.gitCommonDir !== currentGitCommonDir) {
			throw new PathError(
				`code_graph.db belongs to ${meta.worktreeRoot} (${meta.gitCommonDir}); current worktree is ${currentWorktreeRoot} (${currentGitCommonDir}). Refusing to share the DB across worktrees.`,
			);
		}
	}

	/** Run a function inside a write transaction. Uses BEGIN IMMEDIATE so that
	 * reads cannot later upgrade to writes and bypass busy timeouts. */
	tx<T>(fn: () => T): T {
		if (this.mode === "ro") throw new Error("store is opened read-only; cannot begin a write transaction");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				/* rollback failure is non-fatal after a write error */
			}
			throw error;
		}
	}

	read<T>(fn: () => T): T {
		this.db.exec("BEGIN");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				/* ignore */
			}
			throw error;
		}
	}

	prepare(key: string, sql: string): StatementSync {
		let stmt = this.prepared.get(key);
		if (!stmt) {
			stmt = this.db.prepare(sql);
			this.prepared.set(key, stmt);
		}
		return stmt;
	}

	close(): void {
		try {
			this.db.close();
		} catch {
			/* best effort */
		}
	}

	exists(): boolean {
		return true;
	}
}

/** Helper for tests: run a function inside a fresh in-memory store. */
export async function openStore(opts: StoreOptions): Promise<Store> {
	const sqlite = await import("node:sqlite");
	return new Store(opts, sqlite);
}
