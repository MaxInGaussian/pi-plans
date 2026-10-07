/** Chrome language tables and tag resolution (issue #3). */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	formChrome,
	hugeChrome,
	fleetChrome,
	resolveUiLanguage,
	uiLanguageFromTag,
} from "../src/ui-language.ts";
import { initState, setLanguage } from "../src/state.ts";

let tmpRoot: string;

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plans-ui-language-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function freshWorkdir(name: string): string {
	const dir = path.join(tmpRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function gitInit(dir: string): void {
	spawnSync("git", ["init"], { cwd: dir });
	spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
	spawnSync("git", ["config", "user.name", "T"], { cwd: dir });
}

const CJK = /[\u4e00-\u9fff]/;

describe("uiLanguageFromTag (RFC 4647 primary-subtag fallback)", () => {
	it("maps every zh form to zh", () => {
		for (const tag of ["zh", "zh-Hans", "zh-Hant", "zh-Hant-CN", "zh_CN", "  ZH-hans  "]) {
			assert.equal(uiLanguageFromTag(tag), "zh", `tag ${JSON.stringify(tag)}`);
		}
	});

	it("maps everything else (including non-strings) to en", () => {
		for (const tag of ["en", "EN", "en-US", "fr", "", "  ", null, undefined, 123, {}, [], true]) {
			assert.equal(uiLanguageFromTag(tag), "en", `tag ${JSON.stringify(tag)}`);
		}
	});
});

describe("resolveUiLanguage (best-effort config read)", () => {
	it("returns zh for a zh-Hans config", () => {
		const workdir = freshWorkdir("cfg-zh");
		gitInit(workdir);
		initState(workdir);
		setLanguage(workdir, "zh-Hans", "user");
		assert.equal(resolveUiLanguage(workdir), "zh");
	});

	it("returns en when the tag is null", () => {
		const workdir = freshWorkdir("cfg-null");
		gitInit(workdir);
		initState(workdir);
		assert.equal(resolveUiLanguage(workdir), "en");
	});

	it("returns en for a corrupt config without throwing", () => {
		const workdir = freshWorkdir("cfg-corrupt");
		gitInit(workdir);
		const stateRoot = path.join(workdir, ".git", "pi-plans");
		fs.mkdirSync(stateRoot, { recursive: true });
		fs.writeFileSync(path.join(stateRoot, "config.json"), "{ not json", "utf8");
		assert.equal(resolveUiLanguage(workdir), "en");
	});

	it("returns en when no pi-plans state exists", () => {
		const workdir = freshWorkdir("cfg-none");
		gitInit(workdir);
		assert.equal(resolveUiLanguage(workdir), "en");
	});

	it("returns en for a non-git workdir without throwing", () => {
		const workdir = freshWorkdir("cfg-non-git");
		assert.equal(resolveUiLanguage(workdir), "en");
	});
});

describe("chrome tables", () => {
	it("keeps the zh form strings byte-identical to 0.5.6", () => {
		const zh = formChrome("zh");
		assert.equal(zh.customLabel, "✏️ 自定义答案…");
		assert.equal(zh.submitChip, " ✓ 提交 ");
		assert.equal(zh.tabsSubmit, " 提交");
		assert.equal(zh.optionsHint, "[↑/↓] 选择  [Enter] 选定  [Tab] 下一题  [Esc] 取消");
		assert.equal(zh.editingHeader(1, 2, "Question 1?"), "输入答案 — Q1/2: Question 1?");
		assert.equal(zh.editingHint, "[Enter] 确认  [Esc] 放弃输入");
		assert.equal(zh.unanswered, "(未作答)");
		assert.equal(zh.submitHeader(2), "提交 — 全部 2 题答案确认");
		assert.equal(
			zh.blockedSubmitHint([0, 1]),
			"[Enter] 提交（还差 2 题未作答: Q1/Q2）  [←→] 返回修改  [Esc] 取消",
		);
		assert.equal(zh.submitAllHint, "[Enter] 提交全部  [←→] 返回修改  [Esc] 取消");
	});

	it("keeps the zh overlay footer strings and localizes the subagent list", () => {
		const fleet = fleetChrome("zh");
		assert.equal(fleet.close, "Esc 关闭");
		assert.equal(fleet.scroll, "↑/↓ 滚动");
		assert.equal(fleet.page, "PgUp/PgDn 翻页");
		assert.equal(fleet.switchAgent, "Tab & Shift + Tab 切换子代理");
		assert.equal(fleet.browseHint, "↓ 浏览子代理");
		assert.equal(fleet.listHint, "↑/↓ 选择 · Enter 查看 · Esc 返回");
	});

	it("keeps the huge chrome tables paired and localized", () => {
		const zh = hugeChrome("zh");
		const en = hugeChrome("en");
		assert.equal(zh.progress("v0.1.0", 2, 3, "规划中"), "huge v0.1.0 2/3 · 规划中");
		assert.equal(en.progress("v0.1.0", 2, 3, "planning"), "huge v0.1.0 2/3 · planning");
		assert.equal(zh.statusLabel("executing"), "执行中");
		assert.equal(en.statusLabel("executing"), "executing");
		assert.equal(zh.statusLabel("done"), "已完成");
		assert.equal(en.statusLabel("done"), "done");
		assert.match(zh.versionLine("v0.1.0", "已完成", 2), /第 2 轮/);
		assert.match(en.versionLine("v0.1.0", "done", 2), /round 2/);
		for (const status of ["pending", "planning", "reviewing", "executing", "verifying", "done"]) {
			assert.notEqual(zh.statusLabel(status), status, `zh label missing for ${status}`);
			assert.equal(en.statusLabel(status).includes(status), true);
		}
		assert.equal(en.statusLabel("unknown-status"), "unknown-status");
	});

	it("keeps every en string free of CJK", () => {
		const groups: string[][] = [];
		const f = formChrome("en");
		groups.push([
			f.customLabel,
			f.submitChip,
			f.tabsSubmit,
			f.optionsHint,
			f.editingHeader(1, 2, "Q?"),
			f.editingHint,
			f.unanswered,
			f.submitHeader(2),
			f.blockedSubmitHint([0]),
			f.submitAllHint,
		]);
		const r = fleetChrome("en");
		groups.push([r.title, r.browseHint, r.listHint, r.running, r.done, r.queued, r.idle, r.tools, r.more, r.close, r.scroll, r.page, r.switchAgent, r.stop, r.stopArmed, r.reopen, r.noAgents]);
		const h = hugeChrome("en");
		groups.push([
			h.progress("v0.1.0", 2, 3, h.statusLabel("executing")),
			h.versionLine("v0.1.0", h.statusLabel("done"), 2),
			...["pending", "planning", "reviewing", "executing", "verifying", "done"].map((status) => h.statusLabel(status)),
		]);
		for (const group of groups) {
			for (const text of group) {
				assert.ok(!CJK.test(text), `CJK leaked in en chrome: ${text}`);
			}
		}
	});
});