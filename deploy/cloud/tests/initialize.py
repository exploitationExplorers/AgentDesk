import argparse
import getpass
import os
from pathlib import Path
import shutil
import subprocess
import sys
sys.path.insert(0, "/checks")
from initialize import initialize
getpass.getpass = lambda _: "fixture-password"
initialize(argparse.Namespace(root="/validation/original", origin="https://fixture:8443", owner="owner@example.test", smtp_host="fixture", smtp_user="fixture", release="local-validation"))
root = Path("/validation/original")
gateway = root / "config/gateway.env"
gateway.write_text(gateway.read_text().replace("SMTP_PORT=465", "SMTP_PORT=2465").replace("TRUSTED_PROXY_CIDRS=172.30.98.1/32", "TRUSTED_PROXY_CIDRS=172.29.197.10/32") + "NODE_EXTRA_CA_CERTS=/fixture/cert.pem\n")
fixture = Path("/validation/fixture")
fixture.mkdir(mode=0o755)
fixture.chmod(0o755)
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(fixture/"key.pem"), "-out", str(fixture/"cert.pem"), "-days", "1", "-subj", "/CN=fixture", "-addext", "subjectAltName=DNS:fixture"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
os.chown(fixture/"key.pem", 10002, 10000)
os.chmod(fixture/"key.pem", 0o400)
os.chmod(fixture/"cert.pem", 0o444)
for name in ("fixture.mjs", "client.mjs"):
    shutil.copyfile("/checks/tests/"+name, fixture/name)
    (fixture/name).chmod(0o444)
Path("/outputs/config").mkdir()
for file in (root/"config").iterdir():
    shutil.copyfile(file, Path("/outputs/config")/file.name)
workspace = root/"workspaces/example"
workspace.mkdir()
for args in (["init", "-b", "main"], ["config", "user.name", "Fixture"], ["config", "user.email", "owner@example.test"]):
    subprocess.run(["git", "-C", str(workspace), *args], check=True, stdout=subprocess.DEVNULL)
(workspace/"pending.txt").write_text("uncommitted fixture content\n")
subprocess.run(["chown", "-R", "10002:10000", str(workspace)], check=True)
