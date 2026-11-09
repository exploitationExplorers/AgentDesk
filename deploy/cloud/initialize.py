#!/usr/bin/env python3
"""在 Linux 新目录中初始化专用实例，不覆盖已有配置，不输出密钥。"""
import argparse
import base64
import getpass
import os
from pathlib import Path
import secrets
import shutil
import uuid
from urllib.parse import urlparse


def initialize(args):
    root = Path(args.root).resolve()
    network_mode = getattr(args, "network_mode", "published")
    if network_mode not in ("published", "bridge"):
        raise ValueError("unsupported network mode")
    origin = urlparse(args.origin)
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.path not in ("", "/") or origin.query or origin.fragment:
        raise ValueError("origin must be an exact HTTPS origin")
    for value in (args.origin, args.owner, args.smtp_host, args.smtp_user, args.release, str(root)):
        if any(c in value for c in "\n\r\x00'\"$#"):
            raise ValueError("configuration contains unsupported env-file characters")
    if root.exists():
        raise ValueError("destination must not exist; initialization never overwrites data")
    if os.name != "posix" or os.geteuid() != 0:
        raise ValueError("run as root on Linux to set the dedicated container ownership")
    password = getpass.getpass("SMTP password (stored in a private file): ")
    if not password:
        raise ValueError("SMTP password is required")
    os.umask(0o077)
    root.mkdir(mode=0o700)
    for name, uid in (("config", 0), ("deploy", 0), ("data/gateway", 10001), ("data/runner", 10002), ("workspaces", 10002), ("home/runner", 10002), ("backups", 0), ("secrets/gateway", 10001), ("secrets/runner", 10002), ("secrets/shared", 0)):
        path = root / name
        path.mkdir(parents=True, mode=0o700)
        os.chown(path, uid, 10000)
    os.chmod(root / "secrets/shared", 0o750)
    for name, content, uid, mode in (
        ("gateway/session", secrets.token_hex(32), 10001, 0o400),
        ("gateway/otp", secrets.token_hex(32), 10001, 0o400),
        ("gateway/smtp", password, 10001, 0o400),
        ("shared/remote", secrets.token_hex(32), 0, 0o440),
        ("runner/master", base64.b64encode(secrets.token_bytes(32)).decode(), 10002, 0o400),
    ):
        path = root / "secrets" / name
        path.write_text(content + "\n", encoding="utf8")
        os.chown(path, uid, 10000)
        os.chmod(path, mode)
    owner_id = str(uuid.uuid4())
    gateway = {
        "PUBLIC_ORIGIN": args.origin.rstrip("/"), "OWNER_EMAIL": args.owner, "CLOUD_OWNER_USER_ID": owner_id,
        "GATEWAY_DATA_DIR": "/data", "CLOUD_RUNNER_URL": "http://runner:17893", "TRUSTED_PROXY_CIDRS": "172.30.98.1/32",
        "SESSION_SECRET_FILE": "/run/secrets/gateway/session", "OTP_PEPPER_FILE": "/run/secrets/gateway/otp",
        "REMOTE_SHARED_TOKEN_FILE": "/run/secrets/shared/remote", "SMTP_PASSWORD_FILE": "/run/secrets/gateway/smtp",
        "SMTP_HOST": args.smtp_host, "SMTP_PORT": "465", "SMTP_SECURE": "true", "SMTP_USER": args.smtp_user, "SMTP_FROM": args.owner,
    }
    runner = {"AGENTDESK_DATA_DIR": "/data", "WORKSPACE_ROOT": "/workspaces", "CLOUD_OWNER_USER_ID": owner_id,
              "AGENTDESK_MASTER_KEY_FILE": "/run/secrets/runner/master", "REMOTE_SHARED_TOKEN_FILE": "/run/secrets/shared/remote"}
    for name, values in (("gateway", gateway), ("runner", runner)):
        (root / "config" / (name + ".env")).write_text("".join(f"{k}={v}\n" for k, v in values.items()), encoding="utf8")
    source = Path(__file__).resolve().parent
    for name in ("compose.yaml", "nginx.conf.example", "backup.sh", "restore.py", "smoke.mjs"):
        shutil.copyfile(source / name, root / "deploy" / name)
    compose_files = "compose.yaml"
    if network_mode == "bridge":
        shutil.copyfile(source / "compose.bridge.yaml", root / "deploy/compose.bridge.yaml")
        compose_files += ":compose.bridge.yaml"
        nginx = root / "deploy/nginx.conf.example"
        nginx.write_text(nginx.read_text().replace("127.0.0.1:17892", "172.30.98.10:3000"), encoding="utf8")
    (root / "deploy/.env").write_text(f"DEPLOY_ROOT={root}\nAGENTDESK_RELEASE={args.release}\nCOMPOSE_FILE={compose_files}\n", encoding="utf8")
    print(f"Initialized {root}. Review SMTP configuration, image tags and Nginx before starting.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for option in ("root", "origin", "owner", "smtp-host", "smtp-user", "release"):
        parser.add_argument("--" + option, required=True)
    parser.add_argument("--network-mode", choices=("published", "bridge"), default="published")
    initialize(parser.parse_args())
