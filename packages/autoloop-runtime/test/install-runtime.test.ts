import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installRuntime, verifyRuntimeArchive } from "../scripts/install-runtime.mjs";

test("安装前拒绝损坏归档和未锁定架构", async () => {
  assert.throws(() => verifyRuntimeArchive(Buffer.from("tampered"), "linux-x64"), /checksum/);
  assert.throws(() => verifyRuntimeArchive(Buffer.from("tampered"), "linux-arm64"), /No locked/);
  await assert.rejects(installRuntime({ target: "unknown" }), /No locked/);
});

test("已有运行时不匹配时不覆盖，离线归档校验失败不创建目标目录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-install-test-"));
  try {
    writeFileSync(join(dir, "node"), "existing-runtime");
    await assert.rejects(
      installRuntime({ target: "linux-x64", output: dir }),
      /destination exists/,
    );
    const archive = join(dir, "bad.tar.gz");
    writeFileSync(archive, "bad");
    await assert.rejects(
      installRuntime({ target: "linux-x64", output: join(dir, "new"), archive }),
      /checksum/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
