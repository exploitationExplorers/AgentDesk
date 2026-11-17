const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI = new RegExp(`${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}]*(?:${BEL}|${ESC}\\\\))`, "g");

function stripControls(value: string): string {
  let text = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x7f || (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d))
      continue;
    text += char;
  }
  return text;
}

/** 共享记录只做补充过滤；本机仍需显式授权共享，并避免输出项目秘密。 */
export function teamExecutionText(value: string, secrets: string[] = []): string {
  let text = value.replace(ANSI, "");
  for (const secret of secrets)
    if (secret.length >= 8) text = text.split(secret).join("[已隐藏密钥]");
  // 以整行过滤赋值和认证内容，避免仅遮住凭证的一部分。
  let privateKey = false;
  return stripControls(
    text
      .split(/\r?\n/)
      .map((line) => {
        if (/-----BEGIN .*PRIVATE KEY-----/.test(line)) privateKey = true;
        const hide =
          privateKey ||
          /(?:sk-[\w-]{16,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|\beyJ[\w-]{10,}\.[\w-]+\.[\w-]+|(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*["']?\s*[:=]\s*\S|https?:\/\/[^\s/]+:[^\s/]+@)/i.test(
            line,
          );
        if (/-----END .*PRIVATE KEY-----/.test(line)) privateKey = false;
        return hide ? "[已隐藏可能包含凭据的内容]" : line;
      })
      .join("\n"),
  )
    .slice(0, 4000)
    .trim();
}
