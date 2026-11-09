import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorTaskName, connectorTaskXml } from "../src/connect/autostart.js";

test("Windows connector task stays per-user and quotes paths without embedding credentials", () => {
  const xml = connectorTaskXml(
    "C:/Users/Test & Owner/data",
    "C:/Program Files/AgentDesk/worker.mjs",
    "S-1-5-21-123-456-789-1001",
    "C:/Program Files/node.exe",
  );
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /Test &amp; Owner/);
  assert.match(xml, /&quot;.*index.mjs&quot; connect monitor --data-dir &quot;/);
  assert.doesNotMatch(xml, /--password|--token|--secret|<Password>/i);
  assert.equal(connectorTaskName("C:/data/one"), connectorTaskName("C:/data/one"));
  assert.notEqual(connectorTaskName("C:/data/one"), connectorTaskName("C:/data/two"));
  assert.throws(() => connectorTaskXml("x", "y", "S-1-5-1</UserId>"));
});
