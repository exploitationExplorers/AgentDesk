import { describe, expect, it } from "vitest";
import { inspectEnvironment } from "../src/agents/environment";

describe("environment.inspect", () => {
  it("检查本机程序时不执行用户提供的命令", async () => {
    const result = await inspectEnvironment(["node", "not-installed-agentdesk-tool"]);
    expect(result.python).toBeNull();
    expect(result.programs["not-installed-agentdesk-tool"]).toBe(false);
    expect(typeof result.programs.node).toBe("boolean");
  });

  it("拒绝包含命令语法的名称", async () => {
    await expect(inspectEnvironment(["node; echo unsafe"])).rejects.toThrow();
    await expect(inspectEnvironment([], ["os.system('unsafe')"])).rejects.toThrow();
    await expect(inspectEnvironment([], [], undefined, ["../../script"])).rejects.toThrow();
  });

  it("解析模块是否存在，不加载模块，并返回可选输出目录", async () => {
    const result = await inspectEnvironment([], [], undefined, [
      "fs",
      "agentdesk-package-does-not-exist",
    ]);
    expect(result.nodeModules).toEqual({ fs: true, "agentdesk-package-does-not-exist": false });
    expect(result.homeDirectory).toBeTruthy();
    expect(result.workingDirectory).toBe(process.cwd());
  });
});
