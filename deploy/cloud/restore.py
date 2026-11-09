#!/usr/bin/env python3
"""Decrypt and verify into a NEW directory; never replace a running deployment."""
import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import posixpath
import subprocess
import tarfile
import tempfile


def validate(members):
    allowed = {"deploy", "config", "secrets", "data", "home", "workspaces"}
    for member in members:
        name = PurePosixPath(member.name)
        if name.is_absolute() or ".." in name.parts or not name.parts or name.parts[0] not in allowed:
            raise ValueError("archive contains an unsafe path")
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise ValueError("archive contains a special file")
        if member.issym() or member.islnk():
            link = member.linkname
            joined = posixpath.normpath(posixpath.join(str(name.parent) if member.issym() else "", link))
            if link.startswith("/") or joined == ".." or joined.startswith("../") or PurePosixPath(joined).parts[0] not in allowed:
                raise ValueError("archive contains a link outside the restored tree")


def restore(args):
    archive, root = Path(args.backup).resolve(), Path(args.destination).resolve()
    if root.exists():
        raise ValueError("restore destination must not exist")
    if os.name != "posix" or os.geteuid() != 0:
        raise ValueError("run as root on Linux to restore dedicated container ownership")
    expected = Path(str(archive) + ".sha256").read_text().split()[0]
    with archive.open("rb") as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError("encrypted backup checksum does not match")
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="agentdesk-restore-", dir=root.parent) as temporary:
        plain = Path(temporary) / "snapshot.tar"
        subprocess.run(["age", "--decrypt", "-i", args.identity, "-o", str(plain), str(archive)], check=True)
        with tarfile.open(plain) as tar:
            validate(tar.getmembers())
        root.mkdir(mode=0o700)
        # 经过路径与类型校验；GNU tar 额外阻止通过先前 symlink 写出目标目录。
        subprocess.run(["tar", "--numeric-owner", "--same-owner", "-xf", str(plain), "-C", str(root)], check=True)
    env = root / "deploy/.env"
    lines = env.read_text().splitlines()
    env.write_text("\n".join(f"DEPLOY_ROOT={root}" if line.startswith("DEPLOY_ROOT=") else line for line in lines) + "\n")
    print(f"Restored to {root}. Inspect release tag, network and database integrity before starting.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for option in ("backup", "destination", "identity"):
        parser.add_argument("--" + option, required=True)
    restore(parser.parse_args())
