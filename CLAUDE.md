# AgentDesk — repo instructions for Claude Code

See `AGENTS.md` first — it's the canonical, tool-agnostic convention file
for this repo and applies to Claude Code too.

The one thing worth restating here because it conflicts with a common
global default: **git commit messages and PR titles/descriptions for this
repo must be in English**, Conventional Commits format. If your own
user-level `CLAUDE.md` says to write commits in Chinese, that's a
general-purpose default — this repo-scoped file overrides it for commits
and PRs made here. Everything else (conversational replies to the person,
code comments, `docs/*.md`) is unaffected and can stay in whatever
language is otherwise appropriate.

`docs/` is intentionally git-ignored (local-only engineering notes, same
policy as other root `*.md` files besides `README.md`). If you have it on
disk, `docs/engineering-standards.md` has the actual architecture/coding
conventions — read it before a non-trivial change.
