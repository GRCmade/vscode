# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).

## Commit and push

- After each completed change, run the applicable checks. Stage only the paths for the current task, review `git diff --cached`, and run `git diff --cached --check` before committing. Keep unrelated work, credentials, ignored files, and local build output out of the commit.
- Push to the Studio fork's intended development branch. Keep an existing checkout on its confirmed tracked development branch (`dev` or `steamharness-dev`); for a fresh detached submodule, confirm the target with the owning Studio repo before committing. In a linked worktree, create a task branch if needed and reuse it for follow-up work. Follow explicit user instructions about the branch or whether to commit or push. Do not force-push or bypass branch protection.
- Verify that the commit is available on the fork before committing the kernel pointer separately in the parent repo. Report the commit, checks, and any push failure; a local commit is not a successful push.
