import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("verify_bridge", SOURCE / "verify-bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BridgeDeploymentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="agentdesk-bridge-check-")
        root = Path(cls.temporary.name)
        (root / "config").mkdir()
        for name in ("gateway", "runner"):
            (root / "config" / (name + ".env")).write_text("")
        env = dict(os.environ, DEPLOY_ROOT=str(root), AGENTDESK_RELEASE="network-test")
        command = ["docker", "compose", "-f", str(SOURCE / "compose.yaml")]
        cls.published = json.loads(subprocess.check_output(command + ["config", "--format", "json"], env=env))
        cls.bridge = json.loads(subprocess.check_output(command + ["-f", str(SOURCE / "compose.bridge.yaml"), "config", "--format", "json"], env=env))

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_real_compose_removes_published_port(self):
        self.assertTrue(self.published["services"]["gateway"]["ports"])
        self.assertFalse(self.bridge["services"]["gateway"].get("ports"))
        self.assertEqual(module.verify(self.bridge), "172.30.98.10")

    def test_published_configuration_is_rejected(self):
        with self.assertRaises(ValueError):
            module.verify(self.published)

    def test_publishing_either_service_is_rejected(self):
        for name in ("gateway", "runner"):
            with self.subTest(service=name):
                config = copy.deepcopy(self.bridge)
                config["services"][name]["ports"] = [{"target": 3000, "published": "17892"}]
                with self.assertRaises(ValueError):
                    module.verify(config)

    def test_host_network_and_privileged_are_rejected(self):
        for key, value in (("network_mode", "host"), ("privileged", True)):
            config = copy.deepcopy(self.bridge)
            config["services"]["runner"][key] = value
            with self.assertRaises(ValueError):
                module.verify(config)

    def test_external_network_and_driver_overrides_are_rejected(self):
        for key, value in (("external", True), ("driver", "macvlan"), ("driver_opts", {"com.docker.network.bridge.gateway_mode_ipv4": "nat-unprotected"})):
            config = copy.deepcopy(self.bridge)
            config["networks"]["agentdesk"][key] = value
            with self.assertRaises(ValueError):
                module.verify(config)

    def test_invalid_gateway_addresses_are_rejected(self):
        for value in ("172.21.0.10", "172.30.98.0", "172.30.98.255", "172.30.98.1"):
            config = copy.deepcopy(self.bridge)
            config["services"]["gateway"]["networks"]["agentdesk"]["ipv4_address"] = value
            with self.assertRaises(ValueError):
                module.verify(config)


if __name__ == "__main__":
    unittest.main()
