# Changelog

AgentDesk product changes are listed by release. CLI packages follow a separate release schedule.

## Unreleased

- Explore disk usage in a treemap and drill into folders to find large files. Show repository status and explain what it takes to rebuild common development artifacts.
- Preview the action for each selected item before cleanup. Report estimated deletion size, the size of items moved to the recycle bin, and the measured change in free space.
- Bind web and Bot cleanup approvals to the scan, selected items, and removal actions. Invalidate approval when the scan or cleanup plan changes.

## [1.0.0-alpha.1] - 2026-11-18

First product alpha source release, displayed as **v1.0.0 (Alpha)** and recorded under tag `v1.0.0-alpha.1`.

- Add light trails for tool calls, results, and deliveries in the coding collaboration view. Highlight running nodes and respect pause controls, page visibility, and reduced-motion preferences.
- Show events as they move from a team member's local runner to the current task, changed files, and checks.
- Deduplicate animations by event ID and keep history still when opening a view or resuming motion.
- Improve the contrast of inline code in light chat bubbles and adjust the spacing and width of long replies, lists, and code blocks.
- Render Chinese bold text with trailing spaces correctly while preserving literal Markdown markers inside code.
- Support group discussions with quoted replies, mentions, research, verification, summaries, and user decisions.
- Invite team members to a project and pair their local agents. Claim, withdraw, stop, or retry tasks from the web, work in isolated checkouts, and submit results for the project owner's review.
- Report execution stages from local runners and retain the 240 most recent records. Enable `shareExecution` to include visible replies, tool output, and check output with common credential formats filtered.
- Add execution reporting to the lightweight team connector source build `0.1.2-preview.20261118`.
- Include the local workbench, persistent coding tasks, approvals, file diffs, automations, learning tools, and interview practice.
- Add `release:check` to check product version consistency and `release:tag` to create an annotated tag from a clean commit.

Team execution requires each member's computer to be online and running the local runner. Credentials stay on that computer, and detailed output sharing is opt-in. Messages and mentions are for discussion. Task execution and tool approvals require local confirmation, and merging or deployment is a separate step.

Task leases and isolated checkouts govern task and file ownership. Operating system access stays under the runner's account. The team site uses project sessions, with account recovery still pending.

Browser and local protocol checks cover this source release. Live model providers, signed installers, and native behavior across platforms require separate validation. The desktop update endpoint requires publisher configuration. CLI packages, desktop installers, and server deployments follow separate release steps.

## CLI release history

- Retain `cli-v0.1.0` and `cli-v0.1.1` as milestones in the separate CLI release history. [CLI documentation](apps/cli/README.md)
