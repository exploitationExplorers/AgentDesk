#!/usr/bin/env python3
"""检查实际 Compose 配置，保证 bridge 模式没有发布端口或使用宿主网络。"""
import ipaddress
import json
from pathlib import Path
import subprocess
import sys


def verify(config):
    services = config.get("services", {})
    if set(services) != {"gateway", "runner"}:
        raise ValueError("bridge deployment must contain exactly gateway and runner")
    for name, service in services.items():
        if service.get("ports") or service.get("network_mode") or service.get("privileged"):
            raise ValueError(name + " must not publish ports, override network mode or run privileged")
        if set(service.get("networks", {})) != {"agentdesk"}:
            raise ValueError(name + " must use only the dedicated agentdesk network")
    network = config.get("networks", {}).get("agentdesk", {})
    if network.get("external") or network.get("driver", "bridge") != "bridge":
        raise ValueError("agentdesk must be a dedicated Docker bridge")
    options = network.get("driver_opts", {})
    if options not in ({}, {"com.docker.network.bridge.name": "ad-cloud"}):
        raise ValueError("custom bridge driver options require a separate network review")
    if network.get("enable_ipv6"):
        raise ValueError("IPv6 requires a separately verified firewall configuration")
    ip = ipaddress.ip_address(services["gateway"]["networks"]["agentdesk"]["ipv4_address"])
    ranges = network.get("ipam", {}).get("config", [])
    if len(ranges) != 1:
        raise ValueError("exactly one dedicated bridge subnet is required")
    subnet = ipaddress.ip_network(ranges[0]["subnet"])
    if ip.version != 4 or ip not in subnet or ip in (subnet.network_address, subnet.broadcast_address):
        raise ValueError("gateway must use a valid fixed IPv4 address in its bridge subnet")
    if str(ip) == ranges[0].get("gateway"):
        raise ValueError("gateway container cannot use the bridge router address")
    return str(ip)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: verify-bridge.py DEPLOY_DIRECTORY")
    directory = Path(sys.argv[1]).resolve(strict=True)
    result = subprocess.run(["docker", "compose", "config", "--format", "json"], cwd=str(directory),
                            check=True, stdout=subprocess.PIPE, universal_newlines=True)
    address = verify(json.loads(result.stdout))
    print("Bridge configuration verified: no published ports; Nginx upstream " + address + ":3000")
