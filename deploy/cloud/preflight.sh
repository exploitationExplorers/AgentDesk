#!/bin/sh
# 只读预检，不安装软件、不更改站点、不创建配置或密钥。
set -eu

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
warn() { printf 'WARN: %s\n' "$1" >&2; }
[ "$(uname -s)" = Linux ] || fail 'Linux is required'
[ "$(uname -m)" = x86_64 ] || fail 'The first release supports linux/amd64 only'
command -v getconf >/dev/null || fail 'getconf is required to verify glibc'
getconf GNU_LIBC_VERSION || fail 'A supported glibc distribution is required'
command -v docker >/dev/null || fail 'Install a supported Docker Engine and Compose v2 first'
docker version --format '{{.Server.Version}}'
docker compose version
docker info --format 'Docker platform: {{.OSType}}/{{.Architecture}}; CPUs: {{.NCPU}}; memory: {{.MemTotal}}'
docker_version=$(docker version --format '{{.Server.Version}}')
docker_major=${docker_version%%.*}
case "$docker_major" in ''|*[!0-9]*) fail 'Cannot determine Docker server major version' ;; esac
case "${1:-}" in
  '')
    [ "$docker_major" -ge 28 ] || fail 'Docker >= 28 is required for the localhost port publishing fix; use a verified bridge deployment on Docker 26/27'
    ;;
  --bridge)
    [ "$#" -eq 2 ] || fail 'Usage: preflight.sh --bridge DEPLOY_DIRECTORY'
    [ "$docker_major" -ge 26 ] || fail 'Bridge deployment requires Docker >= 26 and Compose >= 2.24.4'
    python3 "$(dirname "$0")/verify-bridge.py" "$2" || fail 'Bridge deployment configuration is unsafe or invalid'
    ;;
  *) fail 'Usage: preflight.sh [--bridge DEPLOY_DIRECTORY]' ;;
esac
memory_kb=$(awk '/MemTotal:/ {print $2}' /proc/meminfo)
[ "$memory_kb" -ge 3500000 ] || warn 'Less than approximately 4 GiB total memory; verify existing website load before deployment'
inspection_path=${AGENTDESK_PREFLIGHT_PATH:-/srv}
[ -d "$inspection_path" ] || fail 'AGENTDESK_PREFLIGHT_PATH must name an existing directory'
df -Pk "$inspection_path"
available_kb=$(df -Pk "$inspection_path" | awk 'END {print $4}')
[ "$available_kb" -ge 20971520 ] || warn 'Less than 20 GiB available for images, workspaces and backups'
if command -v ss >/dev/null; then
  if ss -ltn | awk '{print $4}' | grep -Eq ':(17892|17893)$'; then
    warn 'Port 17892 or 17893 is already in use; inspect its owner before deploying'
  fi
fi
printf '%s\n' 'Local prerequisites inspected. Domain, TLS, SMTP delivery, external ports and production workload still require deployment validation.'
