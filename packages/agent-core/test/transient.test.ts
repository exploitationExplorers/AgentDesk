import { describe, expect, it } from "vitest";
import { isTransient } from "../src";

describe("isTransient", () => {
  it("识别中转站常见的瞬时错误", () => {
    expect(isTransient("Our servers are currently overloaded. Please try again later.")).toBe(true);
    expect(
      isTransient(
        "server_error: An error occurred while processing your request. You can retry your request",
      ),
    ).toBe(true);
    expect(isTransient("429 Too Many Requests")).toBe(true);
    expect(isTransient("Request timed out.")).toBe(true);
  });

  it("不重试配置类错误", () => {
    expect(isTransient("400 当前分组不支持模型 claude-x")).toBe(false);
    expect(isTransient("401 Invalid API key")).toBe(false);
  });
});
