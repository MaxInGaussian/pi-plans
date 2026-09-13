"""Terminal-Bench/harbor agent adapter for the pi-plans A/B benchmark (I-001).

PLAN_v3 (run 20260909T103956Z-pi-plans-bench). Two arms driven by the
PI_PLANS_BENCH_ARM environment variable (injected per-process by the runner,
never exported in the host shell):

- ``baseline``: stock pi, task instruction verbatim. No pi-plans, no injected
  prompt, no auto-approve. Functionally equivalent to harbor's built-in ``pi``
  agent (RPC driver used for symmetry).
- ``treatment``: pi-plans extension loaded (``-e /opt/pi-plans/index.ts``),
  skills registered into ``~/.agents/skills``, system-prompt injection
  ("Before implementing, load and follow skills/plan-big/SKILL.md" per D-014),
  ``PI_PLANS_AUTO_APPROVE=1`` (D-004/D-019 lifecycle whitelist), and a seeded
  pi-plans config (D-015: language=en, roles pre-confirmed on the same model,
  graph off, artifact root outside the graded workspace).

Both arms run pi in RPC mode behind ``rpc_driver.mjs`` (D-013: print/json has
no wakes, which would silently drop the post-execution refinement loop in the
treatment arm; the driver waits for ``agent_settled`` instead).

Usage with harbor::

    harbor run --dataset terminal-bench@2.0 \\
        --agent-import pi_plans_bench:PiPlansBench ...   # exact flag per smoke

Fairness (D-010/D-020): both arms share one container image; the only
difference is the agent-level configuration above. Seeded evaluation state
lives under ``.git/pi_plans/`` with the artifact root pointed OUTSIDE the
graded tree (``/tmp/pi-plans-bench``); the pre-registered pre-oracle
snapshot-diff restore was NOT implemented in this run — recorded as a
limitation (TB oracles read /app artifacts only, so scoring impact is
negligible), see tech-note §Fairness disclosure.
"""

from __future__ import annotations

import base64
import json
import shlex
import tempfile
from pathlib import Path
from typing import override

from harbor.agents.installed.pi import (
    _PI_CONFIG_DIR_ENV,
    _REMOTE_PI_CONFIG_DIR,
    Pi,
)
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

ADAPTER_DIR = Path(__file__).resolve().parent

PI_PLANS_REMOTE_DIR = "/opt/pi-plans"
BENCH_CONFIG_DIR = "/tmp/pi-plans-bench"

# D-014: model-side mechanism is loading the SKILL.md, not a composer slash command.
TREATMENT_SYSTEM_PROMPT = (
    "Before implementing, load and follow the instructions in "
    "skills/plan-big/SKILL.md (relative to the pi-plans checkout at "
    f"{PI_PLANS_REMOTE_DIR}). Plan first, get the plan accepted, then execute "
    "it step by step with the verifier checklist."
)

# D-015 seeded config: deterministic, no first-use Q&A rounds, flash roles,
# graph off, artifact root outside the graded workspace.
SEEDED_CONFIG = {
    "schema": 1,
    "artifact_root": "/tmp/pi-plans-bench/docs",
    "artifact_root_source": "user",
    "language": {"tag": "en", "source": "user"},
    "reviewer": {
        "mode": "delegated-subagent",
        "model_selector": None,  # None => inherit the main agent's model (flash)
        "confirmed_at": "1970-01-01T00:00:00Z",
    },
    "criticizer": {
        "mode": "delegated-subagent",
        "model_selector": None,
        "confirmed_at": "1970-01-01T00:00:00Z",
    },
    "graph_enabled": False,
}


def _read_text(name: str) -> str:
    return (ADAPTER_DIR / name).read_text(encoding="utf-8")


class PiPlansBench(Pi):
    """pi agent with A/B arm handling for the pi-plans benchmark."""

    @staticmethod
    @override
    def name() -> str:
        return "pi-plans-bench"

    @override
    def version(self) -> str:
        return "pi-plans-bench/0.1.0"

    @property
    def arm(self) -> str:
        arm = (self._get_env("PI_PLANS_BENCH_ARM") or "baseline").strip().lower()
        if arm not in ("baseline", "treatment"):
            raise ValueError(f"PI_PLANS_BENCH_ARM must be baseline|treatment, got {arm!r}")
        return arm

    async def _upload_pi_credentials(self, environment: BaseEnvironment) -> None:
        """Mirror the host pi auth/models config into the container so the
        container pi authenticates exactly like the host pi (zai key included).
        Files are private (600) under /tmp/harbor-pi-agent (PI_CODING_AGENT_DIR)."""
        pi_agent_dir = Path.home() / ".pi" / "agent"
        await self.exec_as_agent(
            environment,
            command=f"mkdir -p {shlex.quote(_REMOTE_PI_CONFIG_DIR.as_posix())} && chmod 700 {shlex.quote(_REMOTE_PI_CONFIG_DIR.as_posix())}",
        )
        for filename in ("auth.json", "models.json"):
            local = pi_agent_dir / filename
            if not local.exists():
                continue
            await self._upload_config_text(
                environment,
                content=local.read_text(encoding="utf8"),
                remote_path=(_REMOTE_PI_CONFIG_DIR / filename).as_posix(),
                filename=filename,
            )
        await self.exec_as_agent(
            environment,
            command=(
                f"chmod 600 {shlex.quote(_REMOTE_PI_CONFIG_DIR.as_posix())}/auth.json "
                f"{shlex.quote(_REMOTE_PI_CONFIG_DIR.as_posix())}/models.json 2>/dev/null || true"
            ),
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        """Self-contained install that avoids every GFW-flaky endpoint:
        apt via Tsinghua mirror, Node via npmmirror's node distribution,
        npm packages via npmmirror registry. No nvm, no githubusercontent."""
        await self.exec_as_agent(
            environment,
            command=(
                "sed -i 's|archive.ubuntu.com|mirrors.tuna.tsinghua.edu.cn|g; "
                "s|security.ubuntu.com|mirrors.tuna.tsinghua.edu.cn|g' "
                "/etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null || true; "
                "apt-get update -qq && apt-get install -y -qq git curl xz-utils > /dev/null 2>&1"
            ),
        )
        node_ver = "v22.12.0"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"curl -fsSL https://npmmirror.com/mirrors/node/{node_ver}/node-{node_ver}-linux-x64.tar.xz "
                "-o /tmp/node.tar.xz && "
                "tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && "
                "node --version && npm --version && "
                "npm config set registry https://registry.npmmirror.com && "
                "npm install -g --ignore-scripts @earendil-works/pi-coding-agent && "
                "pi --version"
            ),
        )
        await self._upload_pi_credentials(environment)
        if self.arm != "treatment":
            return
        bundle = ADAPTER_DIR / "pi-plans-bundle.tar.gz"
        if not bundle.exists():
            raise FileNotFoundError(
                f"{bundle} missing — run `node scripts/bench/run-ab.ts --prepare` first"
            )
        remote_bundle = "/tmp/pi-plans-bundle.tar.gz"
        with tempfile.NamedTemporaryFile(suffix=".tar.gz") as staged:
            staged.write(bundle.read_bytes())
            staged.flush()
            await environment.upload_file(Path(staged.name), remote_bundle)
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"mkdir -p {shlex.quote(PI_PLANS_REMOTE_DIR)} && "
                f"tar -xzf {shlex.quote(remote_bundle)} -C {shlex.quote(PI_PLANS_REMOTE_DIR)} && "
                f"rm -f {shlex.quote(remote_bundle)}"
            ),
        )
        await self.exec_as_agent(
            environment,
            command=(
                "mkdir -p $HOME/.agents/skills && "
                f"cp -r {PI_PLANS_REMOTE_DIR}/skills/* $HOME/.agents/skills/ 2>/dev/null || true"
            ),
        )
        prompt_path = f"{PI_PLANS_REMOTE_DIR}/.bench-system-prompt.md"
        await self._upload_config_text(
            environment,
            content=TREATMENT_SYSTEM_PROMPT,
            remote_path=prompt_path,
            filename=".bench-system-prompt.md",
        )

    async def _seed_pi_plans_config(self, environment: BaseEnvironment) -> None:
        """Write the deterministic pi-plans config into the trial workdir (D-015).

        The config lives under ``.git/pi_plans/`` (diff-allowlist path, removed
        before oracle scoring) with the artifact root pointed at
        ``/tmp/pi-plans-bench`` so plan artifacts never land in the graded tree.
        """
        config = json.dumps(SEEDED_CONFIG, indent=2)
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "mkdir -p .git/pi_plans " f"{BENCH_CONFIG_DIR} && "
                f"printf {shlex.quote(config)} > .git/pi_plans/config.json"
            ),
        )

    @override
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        escaped_instruction = shlex.quote(instruction)
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")
        provider, model_id = self.model_name.split("/", 1)

        if self.arm == "treatment":
            await self._seed_pi_plans_config(environment)

        # printf interprets backslash escapes; ship sources base64-encoded so
        # the driver/task bytes survive verbatim.
        driver_b64 = base64.b64encode(_read_text("rpc_driver.mjs").encode()).decode()
        task_b64 = base64.b64encode(instruction.encode()).decode()
        driver = shlex.quote(driver_b64)
        escaped_instruction = shlex.quote(task_b64)
        flags = ""
        if self.arm == "treatment":
            flags = (
                f"-e {PI_PLANS_REMOTE_DIR}/index.ts "
                f"--append-system-prompt {PI_PLANS_REMOTE_DIR}/.bench-system-prompt.md "
            )
        auto_env = "PI_PLANS_AUTO_APPROVE=1 " if self.arm == "treatment" else ""
        skill_first = "--skill-first plan-big " if self.arm == "treatment" else ""

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                ". ~/.nvm/nvm.sh && npm install -g --ignore-scripts typescript@latest >/dev/null 2>&1 || true; "
                f"printf %s {escaped_instruction} | base64 -d > /tmp/.bench-task.txt && "
                f"printf %s {driver} | base64 -d > /tmp/.bench-rpc-driver.mjs && "
                f"{_PI_CONFIG_DIR_ENV}={shlex.quote(_REMOTE_PI_CONFIG_DIR.as_posix())} "
                f"PI_PLANS_BENCH_ARM={self.arm} {auto_env}"
                f"node /tmp/.bench-rpc-driver.mjs "
                f"--provider {provider} --model {model_id} {skill_first}{flags}"
                f"--session-dir /logs/agent/pi/sessions "
                f"--plans-dir /logs/agent/pi-plans/plans "
                f"--out /logs/agent/{self._OUTPUT_FILENAME} "
                f"--subagent-usage /logs/agent/pi-plans/subagent-usage.json "
                f"< /tmp/.bench-task.txt"
            ),
            env=dict(self.model_connection.env),
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        """Main-process usage from pi.txt (parent logic) + subagent usage from
        the driver's snapshot, so benchmark cost accounting covers parent +
        children (F-001/C-F001)."""
        super().populate_context_post_run(context)

        usage_file = self.logs_dir / "pi-plans" / "subagent-usage.json"
        subagent_usage = None
        if usage_file.exists():
            try:
                subagent_usage = json.loads(usage_file.read_text())
            except json.JSONDecodeError:
                subagent_usage = None

        meta_file = self.logs_dir / "driver-meta.json"
        driver_meta = None
        if meta_file.exists():
            try:
                driver_meta = json.loads(meta_file.read_text())
            except json.JSONDecodeError:
                driver_meta = None

        metadata = dict(context.metadata or {})
        metadata["pi_plans_arm"] = self.arm
        if driver_meta is not None:
            metadata["pi_plans_driver"] = driver_meta
        if subagent_usage is not None:
            metadata["pi_plans_subagent_usage"] = subagent_usage
            # Fold child tokens/cost into the top-level accounting so treatment
            # totals are comparable (the extension's reviewer/criticizer calls).
            totals = subagent_usage.get("totals") or {}
            context.n_input_tokens = (context.n_input_tokens or 0) + int(totals.get("input", 0))
            context.n_output_tokens = (context.n_output_tokens or 0) + int(totals.get("output", 0))
            context.n_cache_tokens = (context.n_cache_tokens or 0) + int(totals.get("cacheRead", 0))
            child_cost = float(totals.get("cost", 0.0) or 0.0)
            if child_cost:
                context.cost_usd = (context.cost_usd or 0.0) + child_cost
        context.metadata = metadata
