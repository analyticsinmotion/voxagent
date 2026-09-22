# CLAUDE.md

Instructions for Claude Code sessions working in this repository.

## Project

voxagent is a Node.js command-line tool published to npm. It captures speech with decibri, transcribes it locally with whisper.cpp through `@kutalia/whisper-node-addon`, sends the text to a local Ollama server through the `ollama` package, and prints the reply.

| Path | Contents |
| --- | --- |
| `bin/voxagent.js` | Executable entry point |
| `lib/` | Modules for capture, transcription, model download, the Ollama client and terminal output |
| `docs/` | The static website, served through GitHub Pages |
| `.github/workflows/` | CI and publishing workflows |

The code is CommonJS JavaScript with no build step. The supported Node versions are those in the `engines` field of `package.json`. What is published to npm is controlled by the `files` field of `package.json`.

## Commands

| Task | Command |
| --- | --- |
| Install | `npm ci` |
| Run | `npm start` or `node bin/voxagent.js` |
| Check the published file list | `npm pack --dry-run` |

## Git

- Work on the `development` branch. Confirm the branch with `git rev-parse --abbrev-ref HEAD` before making any change, and stop if it is anything else.
- Never commit, push, tag or merge.
- Stage each change by explicit path. Never use `git add -A` or `git add .`.
- Never put a git write operation inside a compound command.
- Never use `git checkout --` or `git restore` on work that has been staged.
- Commit messages follow Conventional Commits, with `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:` or `build(deps):` and an optional scope.
- No `Co-Authored-By` line and no AI-attribution trailer in any commit message, pull request or file.

## Scope

- Change only this repository. Other repositories may be read but not written to, built or run.
- Only one session works in this checkout at a time. If a file changes that the current session did not touch, stop and report.
- Remove every scratch directory, build output and temporary file the session created before finishing.

## Written output in tracked files

Everything tracked in this repository is public. Code comments, test names, log and error messages, commit messages, pull request text and every tracked file follow these rules.

- State what the code does and why, technically, and nothing else.
- No narrative about how the work was done, what was tried or what an earlier version did.
- No commercial or strategic material, such as usage figures, customer names, pricing or plans.
- No names of other products offered as comparisons, and no comparisons with the names removed. Naming a dependency or a file format the code uses is allowed.
- No benchmark of this project against another project.
- No personal names, machine names, account identifiers, device serials or file paths that contain a person's name.
- No em dashes and no contractions.

## Documentation

- Changes to `README.md` and `CHANGELOG.md` are drafted and handed over for review, not staged.
- Every README example must actually run and produce the output shown.

## Environment

- The primary development shell is PowerShell on Windows. Use PowerShell commands unless another shell is named.
- JavaScript files use LF line endings, enforced by `.gitattributes`.
