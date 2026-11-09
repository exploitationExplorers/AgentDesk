"""在临时目录验证初始化、真实 age 加密、停写恢复及恶意归档拒绝。"""
import importlib.util
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
from unittest.mock import patch


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


initialize, restore = module("initialize"), module("restore")
with tempfile.TemporaryDirectory(prefix="agentdesk-backup-test-") as temporary:
    directory = Path(temporary)
    root = directory / "instance"
    args = SimpleNamespace(root=str(root), origin="https://agent.example.test", owner="owner@example.test", smtp_host="smtp.example.test", smtp_user="owner@example.test", release="test")
    with patch("getpass.getpass", return_value="smtp-test-secret"):
        initialize.initialize(args)
    assert (root / "data/runner").stat().st_uid == 10002
    assert (root / "secrets/runner/master").stat().st_mode & 0o777 == 0o400
    (root / "workspaces/uncommitted.txt").write_text("uncommitted change\n")
    (root / "data/runner/test.db-wal").write_bytes(b"fixture-wal")
    (root / "data/runner/codex/tmp").mkdir(parents=True)
    (root / "data/runner/codex/tmp/ephemeral").write_text("discard")
    identity = directory / "age-key.txt"
    subprocess.run(["age-keygen", "-o", str(identity)], check=True, capture_output=True)
    recipient = subprocess.check_output(["age-keygen", "-y", str(identity)], text=True).strip()
    fake = directory / "bin"
    fake.mkdir()
    log = directory / "docker.log"
    docker = fake / "docker"
    docker.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$BACKUP_TEST_LOG"\ncase "$*" in *"ps --services --status running"*) test "${BACKUP_TEST_DOCKER_FAIL:-}" != 1 || exit 42; printf "gateway\\n";; esac\n')
    docker.chmod(0o700)
    env = {**os.environ, "PATH": str(fake) + ":" + os.environ["PATH"], "BACKUP_TEST_LOG": str(log)}
    failed_backup = directory / "failed.age"
    failed = subprocess.run(["bash", str(Path(__file__).with_name("backup.sh")), str(root), recipient, str(failed_backup)],
                            env={**env, "BACKUP_TEST_DOCKER_FAIL": "1"}, capture_output=True)
    assert failed.returncode != 0
    assert not failed_backup.exists(), "backup proceeded without confirming running services"
    backup = directory / "backup.age"
    subprocess.run(["bash", str(Path(__file__).with_name("backup.sh")), str(root), recipient, str(backup)], env=env, check=True)
    lines = log.read_text().splitlines()
    assert any(line.endswith("stop gateway") for line in lines)
    assert any(line.endswith("start gateway") for line in lines)
    assert not any(line.endswith("start runner") for line in lines)
    destination = directory / "restored"
    restore.restore(SimpleNamespace(backup=str(backup), destination=str(destination), identity=str(identity)))
    assert (destination / "workspaces/uncommitted.txt").read_text() == "uncommitted change\n"
    assert (destination / "data/runner/test.db-wal").read_bytes() == b"fixture-wal"
    assert (destination / "secrets/runner/master").read_bytes() == (root / "secrets/runner/master").read_bytes()
    assert not (destination / "data/runner/codex/tmp").exists()
    assert f"DEPLOY_ROOT={destination}" in (destination / "deploy/.env").read_text()
    try:
        restore.restore(SimpleNamespace(backup=str(backup), destination=str(destination), identity=str(identity)))
    except ValueError:
        pass
    else:
        raise AssertionError("existing destination accepted")
    for name, kind, link in [("../escape", tarfile.REGTYPE, ""), ("data/link", tarfile.SYMTYPE, "/etc/passwd"), ("data/socket", tarfile.FIFOTYPE, "")]:
        entry = tarfile.TarInfo(name)
        entry.type, entry.linkname = kind, link
        try:
            restore.validate([entry])
        except ValueError:
            pass
        else:
            raise AssertionError("unsafe archive entry accepted")
    backup.write_bytes(backup.read_bytes() + b"tamper")
    try:
        restore.restore(SimpleNamespace(backup=str(backup), destination=str(directory / "bad-restore"), identity=str(identity)))
    except ValueError:
        pass
    else:
        raise AssertionError("tampered backup accepted")
print("Deployment initialization and encrypted backup/restore checks passed; Docker lifecycle is a fixture")
