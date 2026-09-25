# Contributing to pi-plans

Thanks for wanting to improve pi-plans. This guide covers the full path from a fresh clone to a merged pull request.

## Expectations

pi-plans is maintained by a single person in their spare time. Review may take a few days, and not every pull request gets merged — that is normal. Small fixes (typos, docs, tests, one-file bug fixes) are welcome as direct pull requests. For larger changes — new concepts, public API changes, or workflow changes — please open an issue first so we can agree on the approach before you invest time.

## Ways to contribute

You do not have to write code:

- Reproduce a bug and post exact steps, versions, and logs in an issue
- Fix or improve documentation (`README.md`, `references/`)
- Improve skill copy or prompts (`skills/`, `agents/`)
- Add or sharpen test cases (`tests/`)
- Verify behavior on your platform (macOS, Linux, different terminals, kitty/SSH)

Issues labeled `good first issue` are a good starting point.

## Orientation

```
pi-plans/
├── index.ts        # Extension entry: tools, commands, guard, execution loop
├── tools/          # plans, ask-choice, refine, execute-plan, code-graph tools
├── src/            # state, guard, plan parsing, subagent runner, refine UI, exec loop
│   └── code-graph/ # SQLite schema/store, parsers, indexer, summary, materialize
├── skills/         # Planning router plus five specialist planning skills
├── references/     # Shared workflow, state/config, plan template (normative)
├── agents/         # reviewer.md / criticizer.md subagent prompts (read-only)
├── scripts/        # validate.ts (structure + package artifact guard), run-tests.ts
└── tests/          # node:test suite
```

`npm run validate` enforces several invariants, so keep them intact:

- every directory under `skills/` has a `SKILL.md` with frontmatter (`name` matching the directory, routing language in `description`) and the required phrases (`ask_choice`, `refine`, `.git/pi_plans`, ...)
- `agents/*.md` declare read-only tools and state the read-only contract
- the npm artifact stays code-sized: no `scripts/bench/vendor|results` entries, unpacked < 5 MiB, packed < 3 MiB, and key entries present
- `package.json` metadata (license, `pi-package` keyword, engines, scripts, required `files`) stays as asserted

## Development setup

Requirements: Node.js >= 22.6 (the suite runs with `--experimental-strip-types`).

```bash
git clone https://github.com/MaxInGaussian/pi-plans
cd pi-plans
npm install          # devDependencies only; nothing ships at runtime
npm run validate     # structure + package artifact guard
npm test             # node:test suite
```

There are no runtime dependencies, but `npm install` is still required: two lifecycle tests import `@earendil-works/pi-*` packages at runtime.

To try the extension against a real session: `pi -e /path/to/pi-plans`.

## Before you submit

Run both checks locally — CI runs exactly these:

```bash
npm run validate
npm test
```

Documentation duty: if your change alters behavior or the public API, update `README.md` or the relevant file under `references/` in the same pull request.

## Commit messages

Follow the existing style: `type: short imperative description` (a scope is optional, e.g. `fix(form): ...`).

- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation
- `refactor:` no behavior change
- `perf:` performance
- `test:` tests only
- `chore:` housekeeping
- `ci:` CI changes

Use the imperative mood ("fix race in ...", not "fixed ..."), keep the subject short, and use the body for motivation and evidence. Do not add generator or `Co-Authored-By` trailers.

## Issues and pull requests

- Small fixes, docs, and tests: open the pull request directly.
- Larger changes (new concepts, public API or workflow changes): open an issue first and wait for a maintainer response.
- Bug fixes: reference the issue in the title, e.g. `fix: handle empty plan path (fix #12)`.
- Fill in the pull request template: Summary, Test Plan, and Docs sections.
- Keep one logical change per PR when you can; multiple small commits are fine (they are squashed on merge).

## Tests

Every new behavior or bug fix must come with an executable test in `tests/` that fails without your change and passes with it. Tests run on `node:test` — no extra test framework is needed.

## Dependencies

pi-plans ships zero runtime dependencies on purpose. Before adding a dependency:

- prefer a small, well-maintained package with no large transitive tree
- add it to `devDependencies` unless it is genuinely required at runtime
- explain in the pull request why it is needed and what you considered instead

## Changelog

Do not edit `CHANGELOG.md` — maintainers write release entries when publishing.

## AI and agents

Using AI assistance is fine, and most contributors here do. Two rules:

- You must understand your change: be able to explain what it does and how it interacts with the rest of the system. Pull requests that cannot be explained will be closed.
- Disclose AI assistance in the pull request (which tool, and to what extent). A real person must be behind every issue and PR; fully automated submissions with no human involvement may be closed.

Please write pull request descriptions and review replies yourself — short and specific beats long and generated.

## Code of conduct

Be kind and constructive. This project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
