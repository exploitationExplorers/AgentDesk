# AgentDesk — Agent Conventions

These conventions apply to any AI coding assistant working in this repository
(Claude Code, Codex, Cursor, or others) and to human contributors. They take
precedence over an assistant's own default/global preferences for this repo
specifically — a repo-scoped rule is more specific than a general one.

## Commit messages and PR text: English only

- Git commit subject and body **must be in English**, following Conventional
  Commits (`type(scope): description`), enforced by `commitlint.config.js`.
- Pull request titles and descriptions **must be in English**.
- This repository is open source; commit history and PRs are public-facing
  and should be readable by contributors who don't read Chinese.
- Scope: this rule covers **git-facing text only** — commit messages, PR
  titles/descriptions, and code review comments posted to GitHub. It does
  **not** cover in-repo documentation (`docs/*.md`), code comments, or an
  assistant's conversational replies to the person it's working with — those
  may stay in whatever language is otherwise appropriate.
- If an assistant's own user/global instructions say to write commits in
  Chinese, that's a general default; this file is the repo-specific override
  and wins for commits/PRs made in this repository.

## `docs/` is local-only

`.gitignore` excludes `docs/` (same policy as root-level `*.md` files other
than `README.md`): internal engineering notes, architecture research, and
parity/comparison writeups stay on the contributor's machine and are not
part of the public repository. Don't remove this `.gitignore` entry and
don't try to force-add files under `docs/` unless explicitly asked to.

## Where the engineering rules live

`docs/engineering-standards.md` (local-only, see above) has the actual
coding/architecture conventions for this repo — directory layout, TypeScript
style, the permission/risk model, etc. Read it before a non-trivial change if
you have access to it on this machine.
