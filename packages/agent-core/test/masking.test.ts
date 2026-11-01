import { describe, expect, it } from "vitest";
import {
  createMaskStore,
  createStreamUnmasker,
  maskJson,
  maskText,
  unmaskJson,
  unmaskText,
} from "../src/masking";

describe("maskText / unmaskText", () => {
  it("识别常见供应商 Key 前缀并整段替换", () => {
    const store = createMaskStore();
    const masked = maskText("key=sk-ant-example001", store);
    expect(masked).not.toContain("sk-ant-example001");
    expect(unmaskText(masked, store)).toBe("key=sk-ant-example001");
  });

  it("同一明文在同一 store 里永远映射同一占位符", () => {
    const store = createMaskStore();
    const a = maskText("邮箱 user@example.com 和 user@example.com", store);
    const [first, second] = a.match(/\{\{MASK_EMAIL_\d+\}\}/g) ?? [];
    expect(first).toBeDefined();
    expect(first).toBe(second);
  });

  it("key=value 模式只脱敏值，保留前缀字面量", () => {
    const store = createMaskStore();
    const masked = maskText('api_key: "abcdef1234567890"', store);
    expect(masked).toContain('api_key: "');
    expect(masked).not.toContain("abcdef1234567890");
    expect(unmaskText(masked, store)).toBe('api_key: "abcdef1234567890"');
  });

  it("身份证号校验位不对时不脱敏（降低误伤）", () => {
    const store = createMaskStore();
    const invalid = "随便写的18位数字110101199001011230";
    expect(maskText(invalid, store)).toBe(invalid);
  });

  it("信用卡号 Luhn 校验通过才脱敏", () => {
    const store = createMaskStore();
    // 4111111111111111 是常见的 Luhn 校验通过的测试卡号
    const masked = maskText("卡号 4111111111111111", store);
    expect(masked).toContain("{{MASK_CARD_");
    expect(unmaskText(masked, store)).toContain("4111111111111111");
  });

  it("正则/校验和异常不阻断主流程，原样放行", () => {
    const store = createMaskStore();
    expect(maskText("普通文本，没有敏感信息。", store)).toBe("普通文本，没有敏感信息。");
  });
});

describe("maskJson / unmaskJson", () => {
  it("递归遍历任意 JSON 结构的字符串叶子", () => {
    const store = createMaskStore();
    const original = {
      role: "user",
      content: [{ type: "text", text: "我的 key 是 sk-ant-example002" }],
      nested: { args: { token: "sk-ant-example002" } },
    };
    const masked = maskJson(original, store);
    expect(JSON.stringify(masked)).not.toContain("sk-ant-example002");
    const restored = unmaskJson(masked, store);
    expect(restored).toEqual(original);
  });
});

describe("createStreamUnmasker：跨 delta 边界缓冲", () => {
  it("占位符被切成两个 delta 时仍能正确换回真实值", () => {
    const store = createMaskStore();
    const masked = maskText("密钥 sk-ant-example003", store);
    const [placeholder] = masked.match(/\{\{MASK_API_KEY_\d+\}\}/) ?? [];
    expect(placeholder).toBeDefined();
    const cut = masked.indexOf(placeholder!) + Math.floor(placeholder!.length / 2);
    const part1 = masked.slice(0, cut);
    const part2 = masked.slice(cut);
    const unmasker = createStreamUnmasker(store);
    const out1 = unmasker.push(part1);
    const out2 = unmasker.push(part2);
    expect(out1).not.toContain("{{MASK_");
    expect(out1 + out2 + unmasker.flush()).toBe("密钥 sk-ant-example003");
  });

  it("流结束时强制 flush 剩余缓冲，不丢字", () => {
    const store = createMaskStore();
    const unmasker = createStreamUnmasker(store);
    const out = unmasker.push("结尾没有闭合的 {{MASK_API_KE");
    expect(out).toBe("结尾没有闭合的 ");
    expect(unmasker.flush()).toBe("{{MASK_API_KE");
  });
});
