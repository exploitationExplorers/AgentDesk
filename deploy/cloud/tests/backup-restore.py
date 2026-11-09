import argparse
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
sys.path.insert(0, "/checks")
from restore import restore
root=Path("/validation")
subprocess.run(["age-keygen","-o",str(root/"identity")],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
recipient=subprocess.check_output(["age-keygen","-y",str(root/"identity")],text=True).strip()
# 宿主已停止真实容器，脚本内 ps 返回空列表，防止重复启动。
shim=root/"bin";shim.mkdir()
(shim/"docker").write_text("#!/bin/sh\nexit 0\n");(shim/"docker").chmod(0o700)
env={**os.environ,"PATH":str(shim)+":"+os.environ["PATH"]}
subprocess.run(["bash","/checks/backup.sh",str(root/"original"),recipient,str(root/"backup.age")],env=env,check=True)
restore(argparse.Namespace(backup=str(root/"backup.age"),identity=str(root/"identity"),destination=str(root/"restored")))
for db in (root/"restored/data").rglob("*.db"):
    with sqlite3.connect(db) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone()[0]=="ok"
assert (root/"restored/workspaces/example/pending.txt").read_text()=="uncommitted fixture content\n"
assert (root/"original/secrets/runner/master").read_bytes()==(root/"restored/secrets/runner/master").read_bytes()
print("Encrypted restore: database integrity, pending workspace and master key preserved")
