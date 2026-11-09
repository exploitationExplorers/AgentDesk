#!/usr/bin/env bash
set -euo pipefail
# 仅限制进入 AgentDesk 网段的新转发连接，宿主 Nginx 和已建立的出站连接不受影响。
directory=$(realpath -e "${1:?deployment directory}")
python3 "$(dirname "$0")/verify-bridge.py" "$directory"
cd "$directory"
network_data=$(docker compose config --format json | python3 -c 'import json,sys,ipaddress; n=json.load(sys.stdin)["networks"]["agentdesk"]; print(n.get("driver_opts",{}).get("com.docker.network.bridge.name",""),ipaddress.ip_network(n["ipam"]["config"][0]["subnet"]))')
read -r bridge_name subnet <<< "$network_data"
[[ "$bridge_name" == ad-cloud ]] || { printf '%s\n' 'Expected dedicated ad-cloud bridge' >&2; exit 1; }
rule=(-d "$subnet" ! -i "$bridge_name" -m conntrack --ctstate NEW -m comment --comment agentdesk-cloud-isolation -j DROP)
if ! iptables -C DOCKER-USER "${rule[@]}" 2>/dev/null; then
  iptables -I DOCKER-USER 1 "${rule[@]}"
fi
iptables -C DOCKER-USER "${rule[@]}"
printf 'AgentDesk forwarding restriction verified for %s on %s\n' "$subnet" "$bridge_name"
