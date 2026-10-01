# AGENTS.md

Authoritative conventions for AI agents and human contributors working in this
repository. Where another document disagrees with this one on **documentation
language** or **commit messages**, this file wins.

## Documentation language

**All prose documentation in this repository is written in English.** This
applies to every Markdown file that ships in the package — `CHANGELOG.md`,
`README.md`, `CONTRIBUTING.md`, this file, everything under `references/`,
`skills/`, and `agents/`.

- `CHANGELOG.md` is **entirely English**, including text inside inline code
  spans. When an entry documents a Chinese-locale UI string, restate it
  semantically in English rather than quoting the Chinese literal.
- Identifiers stay verbatim regardless of the surrounding language: file
  paths, function and type names, CLI flags, environment variables, error
  messages, config keys, run ids, and version numbers are copied byte-for-byte
  and never translated.
- `scripts/validate.ts` enforces "no CJK ideographs and no full-width CJK
  punctuation in `CHANGELOG.md`". If that check ever blocks a legitimate
  entry, the rule is wrong — fix the rule deliberately rather than widening
  the regex ad hoc.

### Not documentation

The localized UI strings in `src/ui-language.ts` and the CJK fixtures in
`tests/` are **features, not prose**. Chinese is a supported UI locale and the
i18n tables must keep their `zh` entries; test fixtures assert on real Chinese
strings. Do not "translate" either of them.

## Commit messages

**Both the subject and the body must be English.**

Follow the existing style: `type: short imperative description` (a scope is
optional, e.g. `fix(form): ...`).

- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation
- `refactor:` no behavior change
- `perf:` performance
- `test:` tests only
- `chore:` housekeeping
- `ci:` CI changes

Use the imperative mood ("fix race in ...", not "fixed ..."), keep the subject
short, and use the body for motivation and evidence. Do not add generator or
`Co-Authored-By` trailers.

## Edit authority

This file governs **language and commit-message conventions only**. It grants no
permission to modify any file. Who may edit what — in particular the
`CHANGELOG.md` rule — is defined in `CONTRIBUTING.md`, which remains
authoritative on that point.