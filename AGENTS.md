# AGENTS.md

## Project

OpenWispr is a macOS voice-dictation app. The desktop app uses Electron, TypeScript,
and React under `src/`; native helpers and local model engines use Swift under `native/`.

## Commands

- `make lint`: type-check the TypeScript app
- `make test`: run the Vitest suite
- `make build`: build the Electron app and Swift executables
- `make check`: run all three

Run `make lint` and `make test` before saying a change works. Building the complete app
requires macOS 26 and Xcode 26 because the model executable targets Swift 6.2.

## How to work

- Keep each pull request focused on one task and avoid unrelated refactors.
- Follow nearby naming, structure, and style before introducing new patterns.
- Add or update tests for behavior changes.
- Ask when requirements are ambiguous instead of inventing them.
- Never commit secrets, credentials, or `.env` files.

## Pull requests

- Use a conventional-commit title with one of these types: `feat`, `fix`, `refactor`,
  `perf`, `test`, `docs`, `build`, `ci`, `chore`, or `revert`.
- Complete every section of `.github/pull_request_template.md`.
- Under Verification, list commands and observed results rather than only saying tests pass.
- Link the issue with `Closes #<number>`.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `jtdelia/openwispr`, using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
