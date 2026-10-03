# PLAN_v2 - lattice-code v0.4 host/daemon migration (trimmed fixture)

This file is a TRIM of the real plan at
`lattice-code/.git/pi-plans/plans/2026-10-02-v0-4-ts-host-python-daemon/PLAN_v2.md`:
only the tasks covered by execution-review round 1's failed checks, and those
check lines, are kept verbatim. The run's checkpoint slices live in `state.json`.

## Tasks

- `Task-2`: S37 host 脚手架、隔离层与双栈门 — deps: Task-1; files: package.json, bun.lock, packages/host/package.json, packages/host/tsconfig.json, packages/host/src/cli.ts, packages/host/src/env.ts, packages/host/src/providers.ts, packages/host/src/gate.ts, packages/host/test/env.test.ts, Makefile, catalog/catalog_v1.json, tools/catalog/build.py, src/lattice/llm/catalog/resolver.py, tests/isolation/; wave: 2
  - `Task-2.1`: 根 Bun workspace + `packages/host` 脚手架；三库锁版本安装；tsc `--noEmit` strict；`Makefile` 新增 `lint-ts`/`test-ts`/`gate`（pytest + `bun test` + `bun install --frozen-lockfile`）——自本步起每个提交双栈门禁
  - `Task-2.2`: 隔离层：`$LATTICE_HOME` 布局（`pi-compat/`、`sessions/`、`daemon-venv/`、`bin/`、`logs/`）；启动即设六个 `PI_*` 环境变量（定位为纵深防御）；自管 `auth.json`（0600+原子写）显式 `apiKey` 注入 pi-ai；spawn 子进程环境清除一切 `*_API_KEY` 形态变量（杜绝 pi-ai 的 env 回退）；v0.4 不注册 OAuth 型 provider；pi-tui 构造显式传 `logDirectory: $LATTICE_HOME/logs`（该参数属 app 装配，本步先立约定与测试钩子）
  - `Task-2.3`: catalog 中立迁移为基座：`catalog_v1.json`（context_window + effort 矩阵 + disabled_levels/disabled_reason）迁至仓库根 `catalog/`；`make catalog` 与 `tools/catalog/build.py` 重指向；冻结期 `llm/catalog/resolver.py` 改读新路径（保持 S46 删除前可用）；TS `providers.ts` overlay 合并以 `catalog/` 为基座（字段级合并/同 id 替换/自定 provider 透传），pi-ai `builtinModels()` 为未覆盖模型的次级补充
  - `Task-2.4`: `tests/isolation/`：全 HOME 递归 manifest diff（path+size+mtime+sha256，排除 `$LATTICE_HOME`，复用 `util/hash.py` 的 sha256 语义）为唯一硬证明；wave-2 范围 = `bun run packages/host/src/cli.ts` 引导链路 + 六变量注入断言 + 预置非空 pi 后复跑（Task-10 后对编译二进制复跑同一套件）
- `Task-3`: S38 pi-tui 界面重建 — deps: Task-2; files: packages/host/src/ui/app.ts, packages/host/src/ui/theme.ts, packages/host/src/ui/banner.ts, packages/host/src/ui/rail.ts, packages/host/src/ui/statusbar.ts, packages/host/src/ui/input.ts, packages/host/src/ui/cards.ts, packages/host/src/ui/panels.ts, packages/host/test/ui/; wave: 3
  - `Task-3.1`: `app.ts` 四区装配（Planning box / Execution tasks / 卡片流 / 输入框）+ `theme.ts` 语义 token → pi-tui theme（四色彩模式；宽度计算复用 pi-tui 导出的 `visibleWidth`，不自建第二宽度引擎）
  - `Task-3.2`: banner 三档梯子阈值即数据（full ≥60 / wordmark ≥14 / single <14；58 列对齐）+ 双 `⌗` 差异化（rail 与输入框前缀 token 不同、单色下字形不同）
  - `Task-3.3`: rail 六态（色+单色字形）+ 扇出段（`N/M · K leases`）+ 路由段（`→ role`）；statusbar 弹性三段（plan title 吸收剩余宽度、model 段贴右误差 ≤1、定宽防抖；Ctx 段数据源 `catalog/`）
  - `Task-3.4`: 输入框 + 卡片三态 + >24 行折叠标注；纯函数 + `render(width)` 行宽不变量（Lattice 侧义务：8–130 列扫描断言 `visibleWidth(line) <= width`）+ 多行样式逐行重应用；bun test 快照用例
- `Task-4`: S39 daemon 与 JSONL 协议（含幂等对账） — deps: Task-2; files: schema/protocol.json, tools/gen_protocol_ts.mjs, tools/gen_protocol_py.py, packages/host/src/protocol.ts, packages/host/src/daemon.ts, packages/host/src/gen/protocol.gen.ts, packages/host/test/daemon.test.ts, src/lattice/daemon/__init__.py, src/lattice/daemon/server.py, src/lattice/daemon/dispatch.py, src/lattice/daemon/__main__.py, src/lattice/daemon/protocol_gen.py, src/lattice/graph/writer.py, src/lattice/graph/facts.py, tests/test_daemon_protocol.py, tests/test_daemon_crash.py; wave: 3
  - `Task-4.1`: 冻结前穷举 daemon op 面：图读（`cmds/read.py:build_table` 全条目）、magics 只读视图、会话 create/exec/close（含握手帧携带 role/caps/write_paths）、写 op、lease/commit、snapshot/restore、health/version；`schema/protocol.json`（JSON Schema + `schema_version` + durable `request_id` 字段 + replayable 标记）；双侧现成生成器（json-schema-to-typescript / datamodel-code-generator）+ 提交产物 + 再生成 diff 零一致性用例
  - `Task-4.2`: Python `daemon/`：`__main__.py --stdio --schema-version N` 为唯一 spawn 契约；stdio JSONL 服务端（stdout 仅帧）；分派按会话解析 per-agent `GraphHandle`（`assembly.py` ensure_agents），一切 op 走 handle 公共方法、绝不直投 `writer.submit`；test/gate op 强制走两阶段提交缝（`commit_prepare` 离环执行 + `commit_finalize`），不阻塞读循环与心跳；durable request_id 贯穿 `PendingItem` 与 facts（`_persist_intent`/`_persist_done` 均落 id），启动时对账开放 id、重复 id 返回已记录结果；租约重建语义写入协议文档；`_apply_one()` 保持无 `await`
  - `Task-4.3`: `daemon.ts` 客户端：spawn、请求 id 生成与幂等、超时与未确认队列、SIGKILL 后重启 + 按 request_id 对账重放、背压上限；冷启动计时埋点（含 snapshot 恢复）；RTT 预算限定读类帧（机器/采样法入 evidence）
- `Task-5`: S40 agent loop 与 plan 链上移 — deps: Task-3, Task-4; files: packages/host/src/loop.ts, packages/host/src/chain.ts, packages/host/src/roles.ts, packages/host/src/transport/record_replay.ts, packages/host/src/ui/cards.ts, packages/host/test/loop.test.ts, packages/host/test/chain.test.ts, packages/host/test/fixtures/cassettes/; wave: 4
  - `Task-5.1`: `loop.ts`：基于 pi-agent-core 的工具调用循环 + daemon 工具桥（图读经协议；权限由 Python 侧 handle 强制）
  - `Task-5.2`: `chain.ts`：plan 链 revision 生命周期（envelope.json 由 TS 直写 `.lattice/plans/<id>/`；reviewer 冷启动不含自己上一轮原文、跨 revision `must_survive` 仍被引用）；`roles.ts` 承接 ROLE_NAMES
  - `Task-5.3`: 真实 provider 录制装置：录制缝 = pi-ai transport shim；以现有 `tests/cassettes/chain.json` 形状为 cassette schema 种子；fixtures 默认合成、真实转录提交前脱敏扫描（无凭据/无绝对家路径/无 org id）；revision 闭环用例跑在录制 cassette 上
  - `Task-5.4`: cards 接线真实 chain 数据（wave 状态接线归 Task-6）
- `Task-6`: S41 扇出调度与预算 — deps: Task-5; files: packages/host/src/schedule.ts, packages/host/src/budget.ts, packages/host/src/ui/panels.ts, packages/host/test/schedule.test.ts; wave: 5
  - `Task-6.1`: 波次划分：同 wave 文件集两两不相交；N executor 生命周期（spawn/回收/失败隔离）；panels 接线 wave/budget 真状态
  - `Task-6.2`: 三类硬预算（token / 时长 / 写次数）越限即停；`budget.ts` 承接预算超限错误类型
  - `Task-6.3`: 越界写拒绝：租约与乐观 hash 校验留 Python 侧经 daemon 强制（改未租约文件被拒并回错误帧）；TS 只发请求不做本地放行
- `Task-7`: S42 picker 与键位 — deps: Task-3; files: packages/host/src/ui/picker.ts, packages/host/src/keys.ts, packages/host/test/picker.test.ts; wave: 4
  - `Task-7.1`: `/login` 两级屏（认证方式 → (provider, method) 行 + 凭据徽章）对接自管 auth；完成登录仅在未设或已是该 provider 时落 `default` 角色；仅列出免 OAuth 的认证方式
  - `Task-7.2`: 模型选择器两级（provider 页 → model 页，type-to-filter；`←→` 调 effort、`Tab` 循环 role、`Ctrl+P` 唤起；effort 草稿 Enter 提交 Esc 丢弃）；数据源 `catalog/`（context_window + effort 矩阵）
  - `Task-7.3`: 禁用态带原因（`disabled_levels`/`disabled_reason`）；键位冲突表为零
- `Task-9`: S44 会话持久化与 resume — deps: Task-8; files: packages/host/src/session.ts, packages/host/src/ui/resume.ts, packages/host/src/cli.ts, packages/host/test/session.test.ts; wave: 6
  - `Task-9.1`: 会话 JSONL 落 `$LATTICE_HOME/sessions/`，定位为**纯重放 transcript（非权威）**：envelope.json + 图 snapshot 是唯一权威；恢复时对话从 transcript 重放、plan/图状态从权威源重建
  - `Task-9.2`: `lattice resume` 列表选择恢复（cli.ts 注册）；断言单改 transcript 不改变恢复结果；重启后图等价
- `Task-10`: S45 打包与分发 — deps: Task-6, Task-8, Task-9; files: scripts/build-binaries.sh, scripts/install.sh, scripts/bootstrap-python.sh, Makefile, package.json, pyproject.toml, README.md, tests/isolation/; wave: 7
  - `Task-10.1`: `bun build --compile` 五平台（darwin-arm64/x64、linux-arm64/x64、windows-x64；x64 走 baseline target；pi-tui 原生加速器为可选件缺失即 JS 回退，不内嵌 `.node`）
  - `Task-10.2`: sidecar wheel：`pyproject.toml` bump 0.4.0，`uv build` 产 wheel 随二进制入 dist；bootstrap：首启检测 `python3.11+` → 引导 uv 至 `$LATTICE_HOME` → `uv venv $LATTICE_HOME/daemon-venv` + 离线安装 sidecar wheel；`kernel_version` 握手协商，不匹配给类型化明确报错
  - `Task-10.3`: 安装脚本：二进制+sidecar 落 `$LATTICE_HOME/bin`，打印 PATH 建议不自动改；干净机器（无 Node/Bun/pi）验证；isolation 套件对编译二进制复跑；README 安装文档改写与形态一致

## Verification Checks

- [ ] `VC-095` covers `Task-4`; pass condition: daemon 被 SIGKILL 后 host 重启并按 request_id 对账重放——无重复应用（受影响文件 sha256 不变 + fact 计数不变），重复 id 返回已记录结果，租约重建语义有文档与用例；evidence: `tests/test_daemon_crash.py`（含 fsync 后 SIGKILL 场景）；metric: ≥2 用例通过。
- [ ] `VC-102` covers `Task-3`; pass condition: rail 与输入框前缀颜色 token 不同、单色下字形不同；evidence: 快照 + 断言；metric: 彩色/单色各 ≥1。
- [ ] `VC-104` covers `Task-3`; pass condition: status bar 弹性三段在 8–130 列 model 段贴右误差 ≤1、定宽防抖、Ctx 段数据源 `catalog/`；evidence: 宽度扫描用例；metric: 0 溢出 + 误差 ≤1 列。
- [ ] `VC-106` covers `Task-5`; pass condition: 真实 provider 录制 cassette 下完整 revision 闭环；reviewer 冷启动不含自己上一轮原文；跨 revision `must_survive` 仍被引用；evidence: `bun test` 链路用例 + cassette fixture；metric: 三项各 ≥1。
- [ ] `VC-107` covers `Task-6`; pass condition: 同 wave 文件集运行时两两不相交（executor 预检拒绝交集）；N=3 真并发（`wall < 0.6 × Σ`）；三类预算超限即停；改未租约文件被拒（经 daemon 校验回错误帧）；evidence: `bun test` + daemon 拒绝帧断言；metric: 四项各 ≥1。
- [ ] `VC-111` covers `Task-9`; pass condition: transcript 为纯重放（单改 transcript 不改变恢复结果）；resume 后对话与图状态等价；evidence: resume 往返用例 + 图等价断言；metric: 两项各 ≥1 用例。
- [ ] `VC-118` covers `Task-4`; pass condition: `writer._dispatch` 每分支与 `cmds/read.py:build_table` 每条目均映射到 schema 帧（op 面无缺口）；evidence: 映射完备性检查用例（工作树可判）；metric: 0 缺口。
- [ ] `VC-119` covers `Task-5`; pass condition: 提交的 cassette 无凭据、无绝对家路径、无 org id；evidence: 脱敏扫描用例；metric: 0 命中。
- [ ] `VC-121` covers `Task-10`; pass condition: bootstrap 离线安装 sidecar wheel 后 `kernel_version` 握手匹配且 daemon 可用；evidence: 干净 venv 安装 + 握手用例；metric: ≥1 用例。
- [ ] `VC-122` covers `Task-2` and `Task-7`; pass condition: picker 列出的每个模型都有 `context_window` 与 effort 矩阵，且 ≥1 可见禁用级（含原因）；evidence: `bun test` 数据完备性用例（对 `catalog/` 全量断言）；metric: 0 缺失。
- [ ] `VC-123` covers `Task-10`; pass condition: README 安装文档与新分发形态（二进制 + sidecar + uv 自举）一致；evidence: 文档审读 + 安装步骤复跑；metric: 0 处失配。
