#!/usr/bin/env bash
set -euo pipefail
# 用法：sudo bash backup.sh /srv/agentdesk age1... /safe/backup.age
root=$(realpath -e "${1:?deployment root}")
recipient=${2:?age recipient public key}
output=$(realpath -m "${3:?new encrypted backup file}")
test -f "$root/deploy/compose.yaml"
test ! -e "$output"
command -v age >/dev/null
command -v docker >/dev/null
umask 077
compose=(docker compose --project-directory "$root/deploy" -f "$root/deploy/compose.yaml")
# 同时停写两个 SQLite 数据库、工作区和 Codex home，连同 WAL/SHM 一起备份。
mapfile -t running < <("${compose[@]}" ps --services --status running)
if ((${#running[@]})); then
  trap '"${compose[@]}" start "${running[@]}" >/dev/null' EXIT
  "${compose[@]}" stop "${running[@]}"
fi
tar --numeric-owner --exclude=data/runner/codex/tmp -C "$root" -cf - deploy config secrets data home workspaces \
  | age -r "$recipient" -o "$output"
sha256sum "$output" > "$output.sha256"
printf 'Encrypted backup: %s\n' "$output"
