# Changelog

## [0.7.0] - 2026-09-30

**Breaking changes**（reviewer 角色配置整体迁移到全局文件；旧 workspace 配置读容忍并自动迁移）：

- **全局 ReviewConfig（全局唯一真相）**：reviewer 角色块（mode、model_selector、thinking_level、name_prefix、confirmed_at）迁移到 `~/.pi/pi-plans/config.json`（`PI_PLANS_GLOBAL_DIR` 可覆盖目录；测试/CI/bench 隔离依赖此变量），一次确认、全部仓库生效。workspace `.git/pi-plans/config.json` 不再写 reviewer 键：legacy 块读容忍——首个变更类调用把“带用户意图”（已确认/显式 selector/非默认 mode）的块播种到全局（先到先得，其余仓库一次性“已忽略”通知；confirmed-inherit 降级为未确认，下次 refine 重问一次），纯脚手架块静默丢弃，随后下次写盘剥离；只读路径（gate/show）内存解析 effective reviewer（global ?? legacy）绝不写盘；全局文件坏 JSON/错 schema → 默认值+通知且永不覆盖；`set-role` 只写全局、绝不触发 auto git-init，且会机会性剥离 legacy workspace 键。
- **首次使用改为原生面板（TUI gate 直弹）**：refine/analyze_refs 在 delegated 模式未确认时直接弹 /model 式可搜索模型面板（复用 pi 导出 `ModelSelectorComponent`；ModelRuntime 主路径=公共 `modelRegistry` 四方法适配器 getAvailable/find/getError/refresh，私有 `.runtime` cast 降为二级，构造异常回落菜单）→ /thinking 式 effort 面板（薄自建变体：DynamicBorder+SelectList+Input+过滤，首行 Default 哨兵，其余档位来自所选模型 thinkingLevelMap，复用 pi-ai `getSupportedThinkingLevels`）；两面板全部完成才一次性落盘（model + thinkingLevel + confirmed），当次调用直接用返回值续跑。Esc 任一面板=取消整个 gate：不落盘、model 选择作废，返回独立错误（`details.cancelled` 语义：禁止 ask_choice 重问、禁止自动重试，提示 /config-pi-plans）；廉价校验（planPath、refs）先于面板。hasUI 非 TUI（RPC/ACP）→ 原生 `ctx.ui.select` 菜单（模型列表→档位列表，与回落菜单共用）；!hasUI → 保留 ask_choice 文本流（文案内嵌可用 selector 清单与精确 set-role 参数，自动化可直接预写全局文件）。
- **移除 inherit 项**：确认后 `model_selector` 必为具体 `provider/model`。`reviewerReady(role)` = current-session 直接过 / delegated 需 confirmed + 具体 selector（confirmed-inherit 不再可表达：`set-role confirmed:true` 无具体 selector 直接拒绝；`modelSelector: "inherit"` 重置 selector 与 confirmed_at）。`thinkingLevel` 参数新增（`off|minimal|low|medium|high|xhigh|max` 或 `default`→null）；`null`（Default）= 不传 `--thinking`（子进程 pi 自解析默认链：per-model settings → defaultThinkingLevel → medium，再按模型钳制；与显式 `off` 语义不同）；换模型未带档位时档位重置。子代理 spawn：`--model` 固定具体值 + 条件 `--thinking`；overlay/ledger 标签 `provider/model:level`；`subagents.jsonl` 新增 `thinking_level` 字段；spawn 前 `registry.find` 校验（缺失→TUI 重开面板/非 TUI 指名 selector 精确报错）。
- **确认 gate 仅限 delegated-subagent**（决策 10）：current-session 模式无需模型确认直过 gate。`analyze_refs` 不再参考 mode（Q-4=B：天然 spawn-only，current-session 仍出 spawn 车道并附一次性“mode 已忽略”通知，模型确认照旧）；删除“切换到 delegated”补救文案。
- **`/config-pi-plans` 向导同步**：reviewer 步改为“保留当前（provider/model · level）/更改”入口菜单（Q-3=A）；current-session 整步跳过且不清除已有 selector；更改流 TUI 复用同一套原生面板、非 TUI 菜单（含 Other 手输校验）；Esc=保留当前并继续向导（不再丢弃此前全部回答）；mode 切换与模型更改即时写全局、全局写失败显式报错并说明 workspace 部分仍写入；summarize 显示全局 reviewer（mode / model · level）。
- **bench/测试隔离**：`scripts/run-tests.ts` 注入一次性 mkdtemp 作为 `PI_PLANS_GLOBAL_DIR` 默认值；受影响测试（state/analyze-refs/refine-resume/config-command）全部改为全局隔离 + 语义更新；bench 适配器播种全局文件（具体 provider/model、thinking_level null、无 criticizer 键）；`scripts/validate.ts` 守卫改指 `src/global-state.ts` 并删除 effort 子串禁令。
- **文档**：`references/state-and-config.md`（全局文件/迁移/面板/Default 语义/PI_PLANS_GLOBAL_DIR 章节，删除“intentionally no effort”旧决策段）、`references/pi-planning-workflow.md` 首用段、`README.md` 工具表与状态位置、`skills/debug-and-plan/SKILL.md` 同步；完成审计器不受 reviewer 角色约束的说明入档。

## [0.6.1] - 2026-09-30

**Breaking changes**（0.x 段内按用户指定以 0.6.1 发布，下列条目均为不兼容变更，升级前请阅读迁移说明）：

- **计划格式简化为两节**：`PLAN_vN.md` 正文收敛为元数据头 + `## Tasks` + `## Verification Checks`。任务 ID 为 `Task-1, Task-2, …`（一级子任务 `Task-3.1`），行内结构化字段 `— deps: Task-1, Task-2; files: src/a.ts, src/b.ts; wave: 2`（字段分隔 `;`、多值分隔 `,`，容错全/半角标点），`## Tasks` 内的 `### Execution Waves` 子节显式给出 multi-agent 可并行的文件修改顺序（wave → 任务集；波内文件集不相交、deps 指向更早波，冲突以子节为准并 lint 提示）。VC 行改为 `VC-### covers Task-N`（支持多目标与 `Task-N.M`）。**兼容读取**：无 `## Tasks` 时回退解析 `## Implementation Items`（`I-001` → `Task-1`；仅 checklist 的更旧工件按每 VC 合成串行任务），执行交接检测到回退解析时提示升级；`lintPlanIntoNotices` 新增任务树一致性 lint（编号连续、deps 可达、波内文件不相交、covers 引用存在、子任务层级≤1）。
- **Reviewer 与 Criticizer 合并为单一 Reviewer**：reviewer 同轮输出 findings（`F-###`，severity/evidence/impact/fix/disposition）与最多 5 个待裁问题（`Q-1..Q-5`），工具说明强制主代理用 `ask_choice` 问完全部问题再改稿并记录答案。`refine` 工具移除 `role` 参数与 `target="implementation"`；`agents/criticizer.md` 删除；config.json 的 `criticizer` 键读入时忽略并出一次性迁移提示（下次写配置自动落盘为单 reviewer 形状）；`/config-pi-plans` 向导、`plans set-role`、refine overlay、`scripts/validate.ts` 断言同步收敛（`ref-analyst` 记录标签保留）。技能文档精化默认序列更新：plan-big 为 3 并发 Reviewer 单轮（含提问），plan-normal/plan-small 为 1 轮 Reviewer。
- **执行阶段重写为任务树驱动（standalone）**：进度改由新工具 `plans_update_task` 上报（`taskId` + `status: complete|skipped` + `evidence`/`skipReason`；状态闭合后不可变，回退仅由执行核心在完成审计流程内执行并以 checkpoint `audit` 字段记账，任务工具自身无回退路径），替代 `[DONE:VC-xxx]`/`[I-###]` 文本标记扫描。新任务仪表盘：紧凑 aboveEditor 部件（当前任务 ▸、进度条、✓/· 计数、VC 通过数、wave 指示、暂停态、审计失败行）+ `Ctrl+Shift+T` 展开树视图（全任务树 ✓/▸/~/· 标记、当前任务锚定、VC 列表与审计状态、窄/宽宽度自适应），替换原固定七行面板。每轮注入"当前 wave + 剩余任务 + VC 摘要"。全部任务终态后由**独立完成审计子代理**按 VC 逐条验收：失败 VC（含审计报告未覆盖的检查——fail-closed）的 covers 任务（含子任务级联、skipped 重开）回退 pending 并注入审计报告；审计轮次上限 3，超限暂停待用户（auto-approve/headless 下有界失败终止，run 置 stopped 不挂死）；含 skipped 任务的覆盖（其余 covers 任务全 complete）记 skipped-pass；无 covers 的 VC 不参与审计（lint 提示）。停滞看门狗替代原 goal-wait：连续 3 个 settled 轮次无任务状态变化自动暂停并提示。
- **移除的旧执行机器**：`[DONE:VC]` 标记扫描、goal-wait 等待/唤醒词法、委托执行器（delegated executor 运行时提问、`agents/executor.md`、`executor_timeout_minutes` 生效路径）、执行后 amelioration（implementation-review）循环（`termination-prompt.ts`、workflow-state 相位写入、`ask_choice` 的 `trailing: auto-refine-loop` 入口、`/resume-plans` 的循环恢复路径）。`applyExecutionCompleted` 审计通过后直达 `completed` 终态。**0.6.0 在途 run 兼容续跑**：delegate 孤儿 → 拒绝直接恢复并要求重新过交接批准门（C-006）；paused goal-wait → 恢复即清除暂停态按任务树重建；impl-review 相位 → 映射为执行完成（run 置 done，历史验收结论保留）；0.6.0 在途 checkpoint 无任务进度映射（`tasks` 缺失）时任务按 pending 重建、已验 VC 记录保留为证据（近似重跑语义）；checkpoint 的 `reverifyAll` 重定义为"任务状态作废重跑"、`originWorktree` 照旧保留。执行期 VCC 压缩词汇任务树化（`Current task:`/`Plan tasks:`/`Remaining verification checks:`）。
- **其他**：README 特性表与 CONTRIBUTING 对应段落、`references/plan-artifact-template.md`（两节新格式规范与示例）、`references/pi-planning-workflow.md`、`references/state-and-config.md`（单 Reviewer 协议）与全部 6 个技能文档同步改写；全量测试（node:test）与 `scripts/validate.ts` 一致性检查通过。

**Fixes**：

- **会话替换后 stale ctx 崩溃**（`execute_plan`/`/plans-execute` 等在 newSession/fork/switchSession 或 reload 后报 "This extension ctx is stale…"；长会话压缩后伴随的会话切换亦在此列）：全仓消除注册时捕获的 `ExtensionAPI`/ctx（旧 `tools/execute-plan.ts` 模块级 `currentApi`、`src/autocomplete.ts` 模块级 `api`、`tools/plans.ts` run-start appender 闭包、index.ts 命令闭包），并消除全部 `pi: ExtensionAPI` 形参（约 15 处，统一改收每次调用的 `ExtensionContext`）。SDK 审计结论：`appendEntry`/`sendMessage`/`sendUserMessage` 仅存在于工厂拿到的 `pi`，per-call ctx 没有这三个方法；会话替换 = 旧 session `dispose()`（invalidate + 退订）+ 新 session 新 runner **重跑全部工厂**。故新增 `src/messaging.ts` 模块级消息面，由扩展工厂首行 `setMessagingApi(pi)` 在每次加载/重建时刷新——替换后新会话自动拿到新消息面（“自动重注册”由工厂重跑天然满足）；替换后、新工厂跑完前的窄竞态窗会抛 stale 错，重试即恢复（`tests/stale-ctx.test.ts` 固化三路径 + 竞态窗行为）。

### Fixed

- **执行期目标面板排版**：标题行改为 `┌─ π-plans: <计划名> ───┐`，品牌 `π-plans` 用 accent 色（与输入框同色系）、计划名与其余边框用 muted 灰；计数行独立成行并改为 `Tasks 3/10 · Verification checks 1/6 · 00:04:12 ███░░░░░░░░`（`tasks`→`Tasks`、`VC`→`Verification checks` 全文），同一行依次为已用时与进度条。宽度不足时按**进度条 → 已用时**的顺序丢弃，计数永不降级为缩写；`renderDashboardLines` / `renderDashboardTreeLines` 新增可选 `theme` 参数自行上色（此前由 `exec.ts` 对整行包一层 muted，内嵌 accent 会被 `[39m` 复位冲掉），配色按**并列**的平衡 span 输出而非嵌套。`formatElapsed` 移入 `src/dashboard.ts` 并导出（`exec.ts` 改为导入，去掉重复实现）。

- **状态目录与计划产物默认路径改为 `.git/pi-plans`**：`STATE_DIRNAME` 由 `pi_plans` 改为 `pi-plans`（`src/state.ts`），计划产物默认根由 `./docs/pi-plans` 改为 `./.git/pi-plans/plans`——计划与状态同处 git 目录，默认私有、不被跟踪、不随 clone 传播；需要计划公开并随仓库提交时把 `artifact_root` 设为 `./docs/pi-plans`（`references/state-and-config.md` 的首选提问、`/config-pi-plans` 向导的选项顺序、`README.md`、6 个技能文档与 `plans` 工具 schema 描述同步改为新默认）。**不迁移旧目录**：已有的 `.git/pi_plans/`（ImageGen-Studio、Novel-Studio、pi-plans、Deliberate）保持原样，新默认值仅对后续使用生效。代码 / 技能 / references / README / 测试共 44 文件 112 处 `pi_plans` → `pi-plans`；`scripts/bench/` 的 bench 标识符（`pi_plans_bench` 模块、`pi_plans_driver` / `pi_plans_subagent_usage` 元数据）不属于状态目录，保持不变，仅其中的 `.git/pi_plans` 路径字面量随迁。**随默认根内移而修的两处真实缺陷**：(1) 写入守卫此前把整个 `stateRoot` 列为可写，产物根内移后会连带放开**其他 run** 的计划目录——现改为对其他 run 的 `artifact_dir` 显式拒绝（无论产物根写在哪），"未绑定会话不可改他人计划"的保护恢复；(2) 产物根按 workdir 朴素 `path.resolve`，而 linked worktree 的 `<workdir>/.git` 是 `gitdir:` 指针**文件**——新增 `resolveArtifactRoot`，`.git/` 前缀一律按 git **common dir** 解析，跨 worktree 下默认产物根正确落在共享状态目录（与 D-007 迁移的"共享位置不再搬移"语义一致）。测试：`tests/state.test.ts` 增 `.git/` 前缀解析与 linked worktree 默认根落点两项；`tests/resume.test.ts` 两项跨 worktree 迁移用例显式钉住 per-worktree 产物根（它们本就只针对工作树内根，默认根下应保持不动）；`scripts/validate.ts` 的 6 技能 / references 路径断言随迁。

- **执行仪表盘行宽回归导致整个 TUI 会话崩溃**（`Rendered line 157 exceeds terminal width (231 > 230)`，2026-09-30，pi 0.99.1）：`src/dashboard.ts` 的紧凑面板行按 `content.padEnd(width).slice(0, width) + 边框` 构造——先截到恰好 `width` 个 UTF-16 单元再补一个右边框——**每一行恒为 `width + 1` 列**；且宽度计算用 `.length`/`slice`/`padEnd` 统计 UTF-16 单元，CJK 字符一个单元占两列，中文计划标题的溢出远超一列。宿主 widget 渲染器对任何超宽行抛 uncaughtException，直接终止会话（实测 230 列 → 231 列，与崩溃记录一致；`~/.pi/agent/crashes.json` 中 113 列 → 114 列的三次崩溃同源）。回归成因：0.6.1 用 `src/dashboard.ts` 替换旧固定面板 `src/panel.ts` 时，丢掉了旧实现经 `src/refine-ui-helpers.ts` 的 `visibleWidth`/`truncateToWidth` 做的按列裁剪；展开树视图（`Ctrl+Shift+T`）此前则完全不裁剪任何一行。修复：仪表盘全部宽度计算改走仓库内已有的按列 `visibleWidth`/`truncateToWidth`（依赖零、grapheme 与 ANSI 感知），新增 `boxRow`（左边框 + 按列裁剪正文 + 填充 + 右边框 = 精确 `width` 列）与 `clampLines` 兜底；头部先扣除进度条预算再裁剪标题，长 topic 下进度条不再被挤掉；展开树每行统一 clamp 到 `width`。测试：`tests/dashboard.test.ts` 新增 `width invariant (TUI crash regression)` 组，**用宿主 pi-tui 的 `visibleWidth` 而非本地复刻度量**，在 22 个宽度（含 1/2/3 退化宽）× 4 种状态（running / paused / all-terminal / audit-failed）下断言紧凑与展开两视图均不超宽、紧凑行恰好等于 `width`，并锁定仪表盘所用全部字形上本地 helper 与宿主一致——任何朝"本地小于宿主"方向的静默偏差都会在此被拦下，而不是在用户终端里崩掉。
- **同 workdir 多 run 并存（v0.6.0 核心演进）**：废除共享单指针 `active.json`（并发会话最后写入者胜出、跨 worktree 竞态），改为**文件系统派生的 run 注册表**：`listRuns` 扫描 `runs/<run-id>/run.json`（按 `updated_at` 降序，同秒内以 run.json 的纳秒 mtime 决胜，损坏目录跳过不抛错），无新增共享可变文件；未绑定会话的回退解析 = 最新非终态 run（全部终态时为 null，写入不再被误拦）。`start-run` 并行不再写指针；同日同主题 run 的 artifact 目录自动加后缀避免合并；`/plans-abandon`、`/plans-execute`、`/resume-plans` 改为**绑定优先 + 候选>1 时弹描述性选择表单**（★ 推荐项置顶，主题·状态·skill·时间），单候选路径与 0.5.7 完全一致；`/resume-plans` 移除 active 指针自动胜出；`/plans` 现列出全部 run（最新在前，标记会话绑定，上限 50）并附 active.json 弃用提示；执行状态栏在全部终态时仍显示最新 run 的 done/abandoned 结果与存活 impl-review 循环；旧 `active.json` 仅在 `runs/` 扫描为空时作一次性迁移回退读取。
- **Execute 后可选切换模型执行（delegated executor）**：执行批准后新增运行时选择——① 使用当前会话（推荐，行为与 0.5.7 一致）② 切换至其他模型（列出 ≥3 个 `provider/model` 切换目标：会话可见模型 + 模型注册表去重、排除当前；不足时提供 Other 自由输入）。切换后由**单个 executor 子代理**跑完整个计划：原生写工具（read/write/edit/bash/grep/find/ls，钉在 SDK ToolName 并集）、`--model` 指定模型、`PI_PLANS_EXECUTOR=1` + `PI_PLANS_RUN_ID` 钉定 run；父会话阻塞式等待并以 Executor overlay 直播进度，从子代理**全文消息事件**解析 `[DONE:VC-xxx]`/`[I-###]` 标记镜像进检查点与状态栏；Esc（工具信号贯通）或 `/plans-stop` 终止子代理并置 stopped（可续，已完成 VC 不重问）；超时可配（config.json `executor_timeout_minutes`，默认 60，0=默认）；子代理退出后父会话校验剩余项——全部完成走正常完成流，有剩余保持 executing 可续；崩溃重启后孤儿 delegate 检测提示。安全隔离：写保护与 graph 感知写工具对 `PI_PLANS_EXECUTOR=1` 旁路（原生落盘，不受另一会话 planning run 拦截、不做 DB-first 暂存），`ask_choice` 在 executor 子进程内拒绝执行（自主决策）；auto-approve / 无 UI 时跳过提问（当前会话 + `[auto-approve]` 记录），决策记入 decisions.jsonl。`execute_plan` 工具与 `/plans-execute` 命令路径统一（多 run 先选 run 再选运行时）。
- **每个 AI 写的 ask question item 都写清优势 & drawbacks**：`ask_choice` 的每个由 AI 撰写的选项（含最终 scope 确认、合并的 accept/execute 交接、implementation-review 配置问题）必须在既有 `description` 字符串里写出 `✓ <advantage> / ✗ <drawback>`——**按 workspace 配置语言（`language.tag`）书写**、每半句控制在 ~8 词。用户因此能横向比较每个选项"得到什么 / 付出什么"，而不是只看标签。约定落在 `Option.description` 的 schema 描述（`tools/ask-choice.ts`）、工具 `description`、新增第三条 `promptGuidelines`、单问与批量两条 `options` 数组描述，并同步 `references/pi-planning-workflow.md`（options 条款 + 交接 + impl-review 段）、全部 6 个 `skills/*/SKILL.md`、`README.md` 特性表。由工具自动追加的固定尾项（`Other…` / `Auto-complete` / `Auto-refine loop`）不在此列。**无 UI、无 schema、无状态改动**：两条渲染路径本来就输出 `1. <label> — ${description}`（`tools/ask-choice.ts:479`、`:766`、`src/ask-form.ts:273`），`decisions.jsonl` 记录格式不变；代价是描述变长会让单问面板更早进入 `fitAskChoicePanel` 的"剥离描述"降级档（既有优雅降级，非缺陷），故措辞要求简洁。
- **plan-normal / plan-big 可选参考检索**：两技能的 web 研究规则扩写——完成仓库调研后可选地检索 1–2 个具名参考（论文/工程博客/其他仓库均可），在计划 Evidence 节引用 URL；明确可选、不计入提问限额、无需下载分析（那是 plan-with-refs 的职责）。
- **plan-with-refs 参考不限 GitHub**：论文（arXiv 等）、工程博客、文档站成为一等参考，**理论参考与实现参考同等有效**；按介质定义合格下载（仓库=克隆；论文=全文（HTML 优先，PDF 提取文本；仅摘要不合格）；博客/文档站=整篇可读 markdown；每参考一目录，`analyze_refs` 只接受目录）；新增明确多样性规则：≥3 个合格参考且 ≥2 个不同来源；`refs.jsonl` 的 kind 值约定为 `project | paper | article | docs`；ref-analyst 提示词与 `buildRefAnalystTask` 任务简报同步泛化（按介质深读；证据=代码 file:line / 论文章节·定理·表号+短引 / 博客标题+引文，七段结构不变）。

### Changed

- `agents/executor.md` 新增（delegated executor 系统提示：自主整计划实施、逐消息标记、结构化收尾总结）；normative 文档 `references/state-and-config.md`（目录布局、注册表语义、弃用说明、run-id 钉定）与 `references/pi-planning-workflow.md`（运行时选择、任意介质参考、可选参考检索）同步更新；`collectModelSelectors`/`modelSelectorOf` 从 config-command 导出复用。
- 测试：新增 `tests/multi-run.test.ts`（注册表排序/容错、readActive 回退、终端态空解析、并行 start-run 目录唯一、PI_PLANS_RUN_ID 钉定、guard executor 旁路、picker 候选与标签、子代理 env 标记、标记镜像）与 `tests/ask-choice-pros-cons.test.ts`（契约文案 × 8：Option/工具 description/promptGuidelines/批量与单问 options 数组、6 个技能、normative 文档条款、**formRender 渲染实证**、schema 回归）；`tests/resume.test.ts` 两处 picking 断言按 v0.6.0 绑定优先语义更新（多候选不再自动胜出）。`scripts/validate.ts` 的 `validateSkill()` 追加 `drawback` 必需词，6 个技能在 pack 期静态兜底。全量 **549 测试全绿**（526 存量 + 15 多 run + 8 pros/cons）。

## [0.5.7] - 2026-09-24

### Changed

- **UI chrome 跟随 workspace 语言（issue #3，致谢 @Griznah）**：批量表单与状态面板等界面文案此前硬编码简体中文，无视 `plans set-language` 配置——英文 workspace 里中文注入，且 `language.tag` 未设置时同样中文。现全部用户可见 chrome 统一由 `src/ui-language.ts` 双语表驱动：
  - **新增 `src/ui-language.ts`**：`UiLanguage` + `uiLanguageFromTag`（BCP47 主语言子标签回落，RFC 4647：`zh-Hant-CN` → `zh-Hant` → `zh`，非字符串/未设置一律 `en`）+ `resolveUiLanguage(workdir)`（无 git root / config 缺失 / JSON 损坏 / 类型异常均回落 `en`，永不抛错）+ 四组 chrome 表（`formChrome` / `refineChrome` / `panelChrome` / `execChrome`）；
  - **批量表单**：自定义答案行、提交 chip、tabs 后缀、选项页/编辑页/提交页页脚与标题、`(未作答)` 占位共 10 条文案随语言切换（`createFormState` / `runQuestionForm` 新增可选 `lang`，默认 `en`；`tools/ask-choice.ts` 在表单即将打开处解析配置）；
  - **refine / refs overlay 页脚**：`Esc 关闭` 等 4 条随语言切换，refine 复用已加载 config、analyze_refs 在构造点解析（两处构造点同步收口）；
  - **状态面板与执行状态行**：`⚠ I 解析 0 项` 三条面板警告与 goal-wait 状态行随语言切换；panel render 与状态栏签名不变（语言经 `PanelModel`/`ExecState` 承载，构造期解析，不引入每帧读盘），`plans set-language` 成功后会立即重绘（`refreshUiLanguage`），跨会话恢复在恢复当刻重新解析、不依赖快照字段；
  - **行为变更**：`language.tag` 未设置或不可读时，上述 chrome 由原来的中文改为 **英文**（与插件其余界面一致；`interface` 历史行为请显式 `plans set-language --tag zh-Hans`）；
  - **已知残留**：`src/plan.ts` 的 lint 诊断文本（agent 面向，经 notices 透出）仍为中文，未在本次语言化范围内；
  - 新增/改造测试 40+ 项（tag 映射与四路径回退、四组 chrome 表 verbatim、表单三页×窄/宽的 en 无 CJK 断言、overlay 两构造点含 fake-TUI 捕获、panel/exec 双语与 set-language 刷新），全量 526 测试全绿。

### Fixed

- **npm 发布包体积修复：209MB → 1.8MB**：0.4.1–0.5.5 已发布版本的 tarball 异常膨胀至 **209MB / 6330+ 条目**（0.1.0–0.3.3 正常为 0.19–1.00MB）。根因：`package.json` 的 `files` 含目录条目 `"scripts/"`，npm 会递归收录整目录，而**根级 `.gitignore`/`.npmignore` 对 `files` 显式列出的目录内部无效**（npm 文档语义）——本地私有、已 gitignore 的 benchmark harness（`scripts/bench/vendor/`，harbor，磁盘约 570MB）与跑分产物（`scripts/bench/results/`）因此随包发布（vendor 占 99.1%，其中 126MB 为 harness 自带 results；300MB 的 `.venv` 因 harbor 自带子目录 `.gitignore` 侥幸排除）。修复：
  - `files` 增加负模式 `!scripts/bench/vendor`、`!scripts/bench/results`（受控实验验证 `!` 负模式与子目录 ignore 均有效；根级 ignore 无效）；实测 **6343 → 136 条目、unpacked 209.38MB → 1.77MB、packed 86.09MB → 0.70MB**；
  - **新增包体守卫**（`scripts/validate.ts`，随 `prepack` 与 CI 自动生效）：静态断言 `files` 含两条负模式；动态运行 `npm pack --dry-run --json --ignore-scripts`（必须带 `--ignore-scripts`，否则内层 pack 会重入 `prepack` 递归），断言 unpacked < 5MiB、packed < 3MiB、无 `scripts/bench/vendor|results` 条目、关键条目（index.ts / skills / agents / references / tools / src / scripts）在位；
  - 说明：0.4.1 / 0.5.1 / 0.5.5 三个已发布版本均带此缺陷（各 209MB），registry 已发布 tarball 无法追溯修改；0.5.7 起恢复代码量级。

## [0.5.6] - 2026-09-23

### Fixed

- **批量表单在 kitty / application-cursor 终端下按键全死（issue #2，致谢 @Griznah）**：`formHandleKey` 用裸字符串比较匹配 legacy CSI 序列，而 pi-tui 会把原始 stdin 直接交给聚焦组件——协商 kitty keyboard protocol 后所有键变 CSI-u（Enter=`\x1b[13u`、Tab=`\x1b[9u`、Esc=`\x1b[27u`、方向键=`\x1b[57417..57420u`），裸比较全部落空、表单 100% 不可操作；application-cursor（SS3 `\x1bOA`…）下方向键同样死。现统一迁移到键归一化：
  - 新增共享 `src/terminal-keys.ts`：pi-tui 可解析时委托 `parseKey` / `matchesKey` / `decodeKittyPrintable`，不可解析时本地 fallback（legacy + SS3 + kitty CSI-u + 修饰键，与 pi-tui 语义逐项对齐：修饰键命名序、shifted 字母身份、功能码点等价表、printable 过滤）；
  - `formHandleKey` 改为归一化判键；编辑分支支持 kitty 文本（含 CJK/Shift）与 kitty Backspace，非文本序列（方向键、ctrl 组合）不插入，非 kitty 原始 UTF-8（IME）直通，且一个 chunk 内的多个 CSI-u 序列全部解码；
  - `refine-ui.ts` 同步迁移（生产路径本已走 `matchesKey`；fallback 键表补 kitty 形态，并修掉「任意 CSI 都算 Esc」的旧缺陷）；`refine-ui-helpers.matchesEscape` 随之删除；
  - 附带修复 wrap 公式 off-by-one：UP from 首行 / DOWN from 末行会算出非法行 `total`（Enter 静默 noop），改为显式钳位换行（`-1` 未选中位参与循环）；
  - 新增 17 项测试（terminal-keys loaded/fallback 与 pi-tui 的 parity 表、chunk 解码、kitty/SS3 全键表、编辑分支、wrap 四边界、refine-ui 双侧），全量 506 测试全绿。

## [0.5.5] - 2026-09-20

### Fixed

- **非 git 目录启动崩溃修复**：在非 git worktree（如 `~/Documents`）启动 pi 时，`session_start` → `restartWatcherIfEnabled` → `resolveCanonicalWorktree` 抛出的 `PathError` 以 unhandled rejection 形式被 pi 判为扩展 bind 失败，pi-plans 在非 git 目录完全不可用（skills/ask_choice/plans 全灭）。同类暴露：`session_shutdown` → `stopGraphWatcher`、`/disable-graph` → `disableWatcher`。现三入口统一静默降级（`tryResolveLifecyclePaths`：仅捕 `PathError` → 正常工况 no-op，其他异常照常抛出；非 git 目录无 `.git/pi_plans`，marker/lock/watcher 本就无从谈起）；`paths.ts` 的 fail-loud 语义与命令行路径不变。

## [0.5.4] - 2026-09-20

### Added

- **implementation-review 并行 reviewer 支持**：此前每轮恒用 1 个 reviewer——能力层 `refine` 的 `reviewers`(1-3) 本就对两种 target 一视同仁，但所有引导文本（工具 description、完成续跑提示词、workflow 文档）都把 3 并行只绑定在 big-plan 的 PLAN 评审上，agent 进循环后从不传参。现全链路收口：
  - **默认随 skill**：plan-big / plan-with-refs → 3，其余 → 1（`defaultImplReviewers`，控制 subagent 成本）；
  - **每 run 可调**：终止条件问题后追加 reviewer-count 问题（questionId `impl-review-reviewer-count`，纯数字标签 1/2/3 + ★ 推荐位，`allowOther: false`），两答合并一次 `record-checkpoint` 持久化（`ImplementationReviewState.reviewerCount`，整数 1-3 校验）；
  - **工具兑底（D-4）**：`refine` 在 implementation 轮省略 `reviewers` 时自动读 checkpoint 配置值——重启/worktree 迁移后 2/3 不会静默回落 1（`applyMigration` 同步保留字段）；
  - **崩溃窗口恢复（D-5）**：两答已落 decisions.jsonl、合并写之前的窗口，`/resume-plans` 从台账重建已答部分、只补问缺失题（`resolveImplReviewConfig` 纯函数，latest-entry-wins）；
  - **面板循环盒（D-3）**：loop 期间（run done + checkpoint phase=implementation-review）widget 保活渲染紧凑盒（round 数 + reviewer 数或 config pending + 终止条件），状态行同源镜像（D-015）；completed 后注销回落 `(done)`；渲染时活读 checkpoint，回合末刷新永不滞后（D-8）；
  - **双 lane 合并契约统一（D-7）**：`refine` 结果文案的 source-reviewer 标注由 `count === 3` 改为 `count > 1`，2 lane 同样保留来源与 ≤5 高优上限；
  - 新增 21 项测试（termination-prompt 映射/选项、workflow-state 校验/迁移/重放守卫、plans schema/透传、refine 兑底/覆盖/count=2 文案、panel 循环盒三态与窄宽度、loop widget 生命周期、ask_choice trailing 双问、resume 三态恢复），全量 485 测试全绿。

## [0.5.3] - 2026-09-19

### Fixed

- **批量表单首选项静默丢失（fail-open 校验缺位）**：畸形批量 `ask_choice` 调用（首选项的 label/description 被序列化到题目层级、`recommended` 键丢失，RCA 见 PROBLEM_ANALYSIS E2 原始 toolCall 证据）此前静默通过并渲染出"缺首选项的表单"。现工具入口双保险：
  - `Option` / `BatchQuestionParams` / `AskChoiceParams` 三 schema 对象 `additionalProperties: false`——任意层级杂散键在 TypeBox Check 处响亮报错，模型重发；
  - 批量每题强制至少一个 `recommended: true`（D-4 至少一个契约，不锁位置），报错文案含自诊断提示（"did the first option's label/description get hoisted to the question level?"）；
  - 校验先于任何 decisions/checkpoint 记录与 auto-approve 短路（D-7 无副作用断言钉死）；
  - 新增 `tests/ask-choice-schema.test.ts` 10 项负例/正例（E2 实案回放），全量 464 测试全绿。

All notable changes to **pi-plans** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [0.5.2] - 2026-09-18

### Fixed

- **执行面板末两行图例去重**：0.4.0 的 boxFooter 内嵌图例与自有 `markers:` 内容行语义撞车（且无内容级断言盯防），三个 I 状态 marker 各显示两遍。现在 marker 语法唯一由执行注入提示教学（`exec.ts` 原有文本，零损失），底边框回归纯 `╰───╯` 装饰（与窄模式分支对齐）。
- **`restoreFromSession` 重绑 run 身份**：恢复执行快照后 `executionRunId` 保持 null 直到下一次 `startExecution`——面板活动行无法解析 run.json。恢复路径现在通过 `resolveActiveRun` + `bindRun` 重绑（CQ1 指出的接线缺口）。

### Changed

- **第 6 行改活动行**：`markers:` 图例行替换为 `<status> · since MM-DD HH:mm`（如 `executing · since 09-18 15:02`），由 `RunInfo.status` + `updated_at` 派生。诚实语义：`updated_at` 是状态变更时间（执行 turn 只写 checkpoint 不写 run.json），故标注 `since` 而非"最近活动"；run 记录缺失时回退纯 phase 词，永不 `undefined`。新增 `formatActivityTime`（空/非法 ISO → `--`）。
- `PanelModel.activity` 为必填字符串（回退收敛在 `derivePanelModel` 内部）；测试新增内容级断言（活动行三态、末行无 `▸`/`[I-`、整面板无 `markers:`）防止图例回流。

## [0.5.1] - 2026-09-18

### Fixed

- **Execution panel no longer shows a fake "I 0/0"** (counts always come from real parsed state). `parseImplItems` now accepts top-level `` `I-00N` `` items with a half-width colon, full-width colon, or plain-space separator (indented child bullets and `- [ ] VC-…` checklist lines never match); a new `lintImplItems` returns a warning when the Implementation Items section exists but parses to zero items.
- **Durable plan-lint notices.** `RunInfo.notices` persists in `run.json` (legacy files without the field read as `[]`; `appendRunNotice` dedupes by source+text). The lint runs at three entries — `plans record-checkpoint` (plan-written), the execute handoff, and the automatic plan-written path after a plan write.
- **Panel format-warning line.** When the lint hits, the I-count row is replaced by an explicit `⚠ plan 格式：Implementation Items 解析 0 项` line (7-line envelope and narrow 3-line badge preserved); the warning is derived on the live handoff path and persisted in the exec snapshot, and both restore paths (checkpoint and session) re-parse + re-lint from the plan file so a stale empty snapshot self-heals instead of freezing the fake count.
- **Batch question form no longer shows fake-answered chips.** `FormState.confirmed` separates the cursor from the answer: chips read `□` until the user presses Enter (or commits a custom answer), moving the cursor un-confirms the tab, Esc mid-edit keeps prior answers, the submit page labels unconfirmed rows `(未作答)` and blocks submit, and `formAnswers` returns confirmed-only answers — a pre-positioned recommended option is never auto-submitted.
- **Uniform-gray frame borders.** The exec widget now themes only the span between the `│` borders (new `themePanelLines`; borders and box chrome stay muted gray on every line, wide and narrow modes) and the question form's `─` borders are muted; every rendered line asserts SGR open/close parity so no border inherits a dangling line color.

## [0.5.0] - 2026-09-17

### Added

- **Trust: read-time validation and self-healing.** Every graph read (digest, get-function, screening) validates the owning file against the disk first — stat fast path (v3 `files.last_size/last_mtime`), full-hash fallback, and the already-read disk buffer is served directly. Genuinely stale files return the fresh disk text with a `[graph: stale — fell back to disk read; reindexed]` marker and synchronously rebuild that one file (single-flight; read-only refiner sessions validate but never rebuild). Files with staged DB-first edits (the intentional "DB ahead" state) serve the staged text with a pending marker instead — no fallback, no rebuild, staged edits are never destroyed.
- **Cross-file call/import edges with confidence labels.** The v1 regex resolver (everything unresolved) is replaced by a two-phase extractor: a module graph over DB snapshots + in-batch overrides (exports, imports per language), then per-function resolution — same-file calls are `EXTRACTED`, cross-file bindings are `INFERRED`, ambiguous imports stay `ambiguous`, and unresolvable heads on external modules plus JS/Python builtins are dropped as noise (unresolved dangling edges dropped from 22,291 to ~4,300 on this repo). Import edges resolve relative specifiers with extension probing (`EXTRACTED`) and barrel probing (`INFERRED`). Edge data lives in the existing `call_edges` table (schema v3 adds `confidence`; the `function_records` view and screening filters are updated, old DBs migrate in place).
- **Graph query actions.** `code_graph` gains `query` (keywords → node match → BFS/DFS expansion under a chars/4 token budget, deterministic expansion order), `path A B` (shortest call path, exactly two selectors), `explain <fn>` (location, community, in/out degrees, typed neighbor lists), and `impact <fn>` (reverse call closure with affected files). All pure-algorithm, resolved-edges-only by default (`includeUnresolved` opts in), each answering in <100ms at this repo's scale.
- **Communities, god nodes, and GRAPH_REPORT.md.** Label propagation (deterministic iteration order, ≤20 rounds) runs after every index; community labels derive from the dominant directory segment; god nodes are the top-10 by resolved degree. `/init-graph` and `/update-graph` write `.git/pi_plans/graph/GRAPH_REPORT.md` (edge stats by confidence/resolution, community table, god nodes, suggested queries).
- **Richer digests.** Function digests now carry signature slices plus `→calls:`/`←called-by:` lists (top-3 + `+N`, resolved edges only) and a `§community` tag — the summary carries both directions of the call graph so whole-file `full:true` escapes are needed less often.
- **Freshness automation.** Three triggers feed one shared incremental reindex: `apply` (materialized set), `plans final-commit` (pre-commit dirty snapshot), and graph-aware edit/write (parse-merge of the staged text — derived rows refresh without touching `source_text`/`pending_kind`). `/watch-graph` adds a 300ms-debounced recursive watcher (PID+heartbeat single-writer lock per worktree, pending files skipped, refiners refused) that stops on `session_shutdown` and auto-restarts on `session_start` when previously enabled; `/unwatch-graph` and `disable-graph` stop it.

### Changed

- `vendor/` directories are excluded from discovery (this repo's vendored benchmark tree was 90% of the old index); schema version 3 with idempotent step migrations for legacy databases (legacy edge rows survive populated migrations); graph prompt blocks teach the new semantics (self-healing reads, digest link tags, query actions before grepping).

### Fixed

- **Edge-matrix hardening (implementation review r1).** `export { x } from` and `export * from` now resolve through to the DEFINING module (transitive barrels included — call edges target real function nodes, never phantom barrel entries); same-name exports across modules classify as `ambiguous` instead of unresolvable noise; dynamic `import('./x')` emits an import edge (resolved for in-repo targets, dangling for externals); `const { a } = require('./x')` binds the NAMED export (only brace-less require binds the default); import bindings are consulted before the same-name method heuristic and that heuristic is demoted to `INFERRED` (a local `readFile` can no longer hijack `fs.readFile(...)`); Python `import x.y` binds the head module and `from . import x` resolves the package `__init__`.
- **Full-rebuild pending guard.** `runIndex` fails closed: a full rebuild (`/init-graph`) skips files with staged DB-first edits instead of overwriting them — staged text survives until `apply` materializes it.
- **Watch hardening.** An `fs.watch` error event stops the watcher cleanly (with a `watch.failed` hint) instead of crashing the host; the lock is claimed atomically (`wx`) with stale-lock cleanup and ownership-checked release; repeated reindex failures (10+) stop the watcher and point at `/update-graph`; pending-file detection fails closed on store read errors.
- **`code_graph status` surface.** Now reports the total edge count and the kind × resolution × confidence distribution (AC-003); `query`/`impact` results carry `shown`/`omitted` counts alongside `truncated`; `includeUnresolved`'s description states its actual semantics (target-less dangling edges never enter traversal).
## [0.4.1] - 2026-09-17

### Fixed

- **No more duplicated （推荐） markers in the batch form.** Agents sometimes authored option labels that already ended with `（推荐）`/`(recommended)`; the renderer then appended its own marker and the option displayed the tag twice. Labels are now normalized (`stripRecommendedMarker`) wherever they render — form options, submit page, transcript `renderCall`, and both sequential-select fallbacks — and the recommended indicator is a single colored `★` instead of a `(推荐)` text suffix. `formAnswers` strips the marker from recommended answers so the returned label stays clean; the tool schema now tells agents never to embed the marker in labels.
- **Themed batch form.** `formRender` accepts an optional theme (the host already injects the pi Theme into the custom-dialog factory; it was previously ignored). With it, the question tab renders a themed frame: accent top/bottom borders, a tabs row whose active chip gets the `selectedBg` background (■ answered / □ pending, ✓ 提交 dims until every question is answered), the question line in accent, selected options in accent with `→ `, unselected in text, `★` in success color, and dim key hints. The submit page uses an accent bold header with warning/success status, the editing page an accent header. The F-001 rows-budget degradation is preserved and extends to the new frame: descriptions strip first, then blank separators, then the borders (the selectedBg chips row survives), then the question text; options are only capped behind a `… +N more` indicator as a last resort and the footer always survives. All lines stay width-safe under real ANSI styling (visibleWidth skips escape sequences).
## [0.4.0] - 2026-09-17

### Added

- **Batch multiple-choice question form.** `ask_choice` now accepts `questions: [...]` (2-8 items): instead of asking one question at a time, the tool opens ONE tabbed multiple-choice form in the terminal — one tab per question with all options visible in the first frame, the recommended option preselected, a "✏️ 自定义答案…" row per tab that switches into a Focusable single-line input (CURSOR_MARKER + hardware cursor, so zh-Hans IME composition works), and a final submit page listing every Q/A. Phased questioning stays agent-driven: submit a batch, think about the answers, follow up in later calls. Esc returns the answered subset as partial answers (recorded with a batch-level cancelled row; `disableAutoComplete` side effect matches the single-question cancel). Answers are recorded per question in decisions.jsonl (questionId passthrough for cross-session dedupe) and in the checkpoint via the new `pendingQuestions` batch field, so `/resume-plans` replays only unanswered questions. Gates: auto-approve and auto-complete short-circuit the whole batch with recommended options; print/json auto-completes every question; RPC hosts without `ctx.ui.custom` degrade to one sequential `ctx.ui.select` per question. Safety red line: batches reject `autoComplete: false` items and the reserved scope/handoff question ids — the final scope confirmation and execution handoff are always single-question calls. The tool description and prompt guidelines teach the batch protocol, and all six planning skills (planning, plan-small, plan-normal, plan-big, plan-with-refs, debug-and-plan) instruct batched rounds (≤8 per call) with follow-up phases.
- **Fixed execution status panel.** While a plan executes, a fixed `╭─ pi-plans ─ <run topic> ──╮` tasks panel renders above the editor (7 rows at ≥30 columns, a 3-row badge below): phase and goal-wait counters, remaining implementation items with a progress bar, the current implementation item (marker-backed or inferred, inference never persisted), a Next action line, and VC progress. The panel, the bottom status-bar summary line, and the execution injection text all derive from one pure model (`src/panel.ts`) — what the panel shows is exactly what the agent is told. Rendering is a width-aware component (`render(width)` reads the live width and theme; every line is truncated to width including CJK, so resizes never wrap rows) with a fixed row count so the terminal buffer height never changes (no scrollback churn, no timers). The panel registers on execution start/approve, refreshes from marker updates and turn ends through the existing `updateStatusWidget` call sites (including `restoreFromSession` rebuilds), and unregisters on completion, stop, or abort with the status summary cleared.

## [0.3.3] - 2026-09-08

### Added

- **Pre-plan compaction.** When `plans start-run` creates a new planning run, the extension now proactively requests one VCC compaction (internal hint `pi-plans planning pre-plan compact`) from the `plans` `tool_result` hook — after the run lands, before the first planning question — so every new plan starts on a lean context (LLM reasoning degrades with longer input; Chroma "Context Rot" 2025, Liu et al. "Lost in the Middle" TACL 2024). Pi's manual compaction never continues the interrupted turn, so the hook resumes planning with exactly one hidden `pi-plans-preplan-resume` message on success and failure alike, filtered out of the model context payload; stats notifications reuse the existing VCC reporter. Small sessions ("nothing to compact" / "already compacted"), aborts, and older Pi builds without the extension compact action skip silently with an info notice and still resume. The trigger respects the run-status planning gate and is disabled while an execution is active. New repo-private config key `prePlanCompact` (default `true`) in `.git/pi_plans/pi-vcc-config.json`; set it to `false` to restore the old behavior.
- **`/resume-plans`.** A new interactive command resumes the repository's working plan in the current session, across restarts and sessions: unfinished planning (pending question, answered decisions), reviewing (per-round/per-lane state with successful outputs reused, never re-run), execution (durable approval evidence: plan digest + HEAD + verified VC/I set), and the post-execution implementation review (termination condition + completed-round count). Run-level `checkpoint.json` state lives under `.git/pi_plans/runs/<run-id>/` with explicit validation, atomic writes, monotonic revisions, and separate files for full review outputs; corrupt checkpoints are reported, never silently overwritten. The `plans` tool gains a whitelisted `record-checkpoint` action for model-driven boundaries (plan-written, review-consolidated, implementation-review-configured, implementation-round-finished, completed) that cannot forge approval or terminal states, and `ask_choice` accepts `questionId`/`purpose` so questions deduplicate across sessions (an answered ledger entry always wins over a stale pending one). `refine` records rounds and lane outputs durably and supports `resumeRoundId` for lane-level resume.
- **Session-bound run attribution + run ownership.** Each session binds to the run it starts/executes/resumes (restored from `pi-plans-run-start` entries on the current branch); tools, the planning write guard, autocomplete, execution bookkeeping, and the code-graph apply gate attribute through the binding first, falling back to the shared `active.json` pointer for legacy sessions. A per-run owner lease (host + pid + process start time + token + generation, atomic acquire, conservative refusal on foreign hosts, live owners, and PID reuse) keeps two live sessions from owning one run; checkpoint writes can require ownership. Cross-worktree resumes migrate artifacts without overwriting, reset approval and VC validity, and keep the termination condition while restarting round counts. Execution approval records the HEAD at approval; on resume, an unchanged plan digest with a changed HEAD keeps the authorization but re-verifies previously verified VCs first, and loading execution from a checkpoint writes an immediate session snapshot so session restore cannot clear it.

### Fixed

- **Single-reviewer refine rounds record correctly.** `tools/refine.ts` mapped `reviewerLanes(1)`'s `lens: null` into the review-round spec, which the checkpoint schema rejects (`lanes[0].lens: expected a string`), so every one-lane reviewer round with an active run checkpoint failed before spawning. The tool now maps the missing lens to `undefined`. Found while running the preplan-compact implementation-review loop; intentional deviation from that plan's declared paths (review-loop enablement repair).

## [0.3.2] - 2026-09-07

### Fixed

- **Goal-wait lifecycle.** In TUI/RPC, continuation now waits for
  `agent_settled` and rechecks execution, idle, pending-input, and compaction
  state before sending one hidden message with the latest checklist.
  Tool turns no longer queue duplicate reminders or consume the 3/6
  no-progress/waiting guard rounds. Completion, stop, and session changes
  invalidate wake identity; user interruption and final model errors pause
  continuation until genuine user input or `/plans-execute` resumes it.
  Same-plan command resumes preserve verified progress; `execute_plan`
  retains explicit approval. Print/JSON single-shot sessions keep marker
  tracking without automatic wakes. Regression tests include the real Pi
  agent loop with an offline deterministic model and the full extension.

## [0.3.1] - 2026-09-06

### Added

- **Per-reference analysis subagents.** plan-with-refs now runs one
  independent read-only subagent per downloaded reference (cwd = the ref's
  own directory, batches of at most 3 under a `Refs` overlay) via the new
  `analyze_refs` tool: it reuses the reviewer role gates and model, returns
  structured per-reference sections (overview / mechanisms / adoptable
  ideas / pitfalls / citations / coverage / gaps) for `REF_ANALYSIS.md`, and
  records spawns best-effort in `subagents.jsonl`. Reference downloads are
  config-driven: a new `refs_root` (asked once per workspace via
  `plans set-refs-root` — recommended `.git/pi-plans/refs/`, second
  `./refs/`, third `~/.cache/pi-plans/refs/`), honored by the planning write
  guard, `/config-pi-plans`, and the plan-with-refs flow (manual structured
  reads are replaced by the tool).
- **Agent-side graph materialization.** The `code_graph` tool gains an
  `apply` action that materializes DB-first staged edits into the worktree
  without the TUI: same hard gates as `/apply-graph` (refused while the
  active run is `planning`/`accepted`, plus a `PI_PLANS_REFINER` env-marker
  refusal that keeps read-only refiner subagents write-free), a stable
  three-state JSON result (`{ok:false,reason}` / `{ok:true,report:{counts,
  files}}` with a post-apply drift summary), and no run-status side effects.
  All agent-facing guidance now teaches the `staged → code_graph apply →
  drift` loop; `/apply-graph` stays the user-facing command over the same
  shared core.

## [0.3.0] - 2026-09-05

### Added

- **Code graph.** A Tree-sitter function graph now lives in
  `.git/pi_plans/code_graph.db` and backs planning, refinement, and
  execution. `/init-graph` indexes the worktree (function descriptions,
  call edges, provenance), `/update-graph` reindexes changed paths
  incrementally, `/apply-graph` materializes DB-first edits back to source,
  `/graph-drift` checks convergence, and `/enable-graph` / `/disable-graph`
  toggle the mode (plus `/graph-status`). When enabled: `read`/`write`/`edit`
  become graph-aware for indexed source files — `read` returns a capped
  function digest instead of whole files (with `full: true` as the only
  whole-file exit), `write`/`edit` stage DB-first mutations until
  `/apply-graph`, and the loop ends with a reindex so the graph stays
  authoritative. The `code_graph` tool provides read-only screening,
  `get-function`, and `manifest` queries plus DB-first mutation actions
  (`update-function`, `update-file`, `delete-file`, `list-pending`);
  planner/refiner/executor prompts
  hard-require function-level reads, and refiner/criticizer subagents get
  `code_graph` in their allowlist. The tree-sitter parser packages are
  optional: install them where pi runs (`npm i tree-sitter
  tree-sitter-javascript tree-sitter-typescript tree-sitter-python`) to
  enable the graph; without them everything else works unchanged.
- **`/config-pi-plans`.** Interactive workspace configuration wizard that
  re-asks every pi-plans default: language, planning docs root, code graph
  toggle, and reviewer/criticizer mode and model. Model pickers aggregate
  the session model, scoped models, and the registry with `Other…` for
  exact selectors; cancellation and invalid input write nothing, and an
  active run's snapshot stays untouched.
- **Goal-running continuation.** After execution completes, interactive
  sessions automatically enter an implementation-review loop: the
  termination condition is asked once (1/2/3 rounds or until no
  high-severity finding, hard cap 5), then `refine` reviewer rounds run
  against the implemented worktree without further prompting — accepting
  evidence-backed findings, applying fixes, and re-running tests each round.
- **Overflow-safe ask_choice panels.** Choice prompts sanitize newlines,
  cap every option at three rendered lines (`..` marker), and enforce a
  hard panel-height ceiling below the terminal height with tiered shrink
  (strip descriptions → one-line labels → truncate the question). Fixed
  tail labels keep their routing prefixes, tiny terminals surface a
  one-time warning instead of failing, and ledgers keep the raw labels.

### Changed

- Subagent default timeout raised from 15 to 60 minutes so long refinement
  rounds no longer terminate mid-review.
- Refiner and criticizer subagents receive `code_graph` in their tool
  allowlist whenever the workspace has the code graph enabled.

## [0.2.0] - 2026-08-31

### Added

- **VCC compact.** Planning and execution compaction now use a deterministic,
  no-LLM VCC-style summary when Pi core emits manual `/compact`, threshold,
  or overflow events. Summaries contain `[Session Goal]`, `[Files And Changes]`,
  `[Commits]`, `[Outstanding Context]`, `[User Preferences]`, and a ranked
  brief transcript; pi-plans maps active run, plan path, current `I-###`,
  implementation IDs, and remaining `VC-###` checklist context into those
  sections. The repo-private `.git/pi_plans/pi-vcc-config.json` defaults to
  `overrideDefaultCompaction:true`, `smartKeepTail:true`,
  `continueAfterThresholdCompact:true`, and `debug:false`; global pi-vcc config
  and `PI_VCC_CONFIG_PATH` are ignored. Manual `keep:N`, follow-up prompts,
  unsafe-cut cancel/fallback behavior, compact stats, and Pi-version-gated
  continuation are covered by tests.
- **Visible Refiner overlay.** Delegated reviewer/criticizer rounds now
  surface a named public `Reviewer`/`Criticizer` overlay in the Pi TUI with
  per-lane tool progress, bounded output preview, and clean cancelled/
  timed-out vs completed terminal states. The overlay opens at round start
  and closes before the tool result returns to the main session. Built on
  Pi's public `pi-tui` primitives — no `pi-btw` dependency.
- **Auto-complete mode.** `ask_choice` routes eligible planning and refinement
  questions through a run-scoped Auto-complete mode. Use
  `/plans-autocomplete-stop` to take back control; Auto-complete is never
  offered for execution approval, installs, publishing, deployment, merge,
  push, or credential use.
- **Planning write guard with `set-artifact-root`.** While a run is
  `planning`/`accepted`, `edit`/`write` is blocked outside `.git/pi_plans/`,
  the run's artifact directory, and `~/.cache/pi-plans/`. The artifact root
  is configurable through the new `set-artifact-root` action.

### Changed

- README now links directly to the [Pi coding agent](https://github.com/earendil-works/pi)
  and documents VCC compact and Visible Refiner overlay behavior.
- Subagent invocation moved to a minimal JSONL-driven runner; the renderer no
  longer depends on `pi-btw` or any third-party view package.

### Removed

- Old current-I proactive compaction scheduling and model-generated compaction
  summaries have been replaced by Pi-core-triggered VCC compact hooks.
- Legacy execution model snapshot/selection helpers
  (`setExecutionModel`, `chooseExecutionModelSelection`,
  `snapshotCurrentModelSelector`, `ensureExecutionModelActive`,
  `restorePlanningModel`).
- Standalone execution-list widget and `/plans-list` toggle; progress lives in
  the bottom status bar throughout.

[0.1.1] - 2026-08-25

- Initial published npm release of the planning workflow.

[0.1.0] - 2026-08-20

- Initial planning workflow, skills, agents, and tests.