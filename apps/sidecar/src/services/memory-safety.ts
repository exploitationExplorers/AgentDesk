/** 普通记忆不接收凭据和明显的指令注入；写入前检查未截断的原文。 */
export function containsSensitiveMemory(text: string): boolean {
  return [
    /-----BEGIN[\w\s]*PRIVATE KEY-----/i,
    /\b(?:sk|pk)[-_](?:proj[-_])?[a-z0-9_-]{12,}/i,
    /\b(?:gh[pousr]_[a-z0-9]{15,}|github_pat_[a-z0-9_]{15,}|AKIA[A-Z0-9]{16})\b/i,
    /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/i,
    /(?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|authorization|password|passwd|secret|cookie|private[ _-]?key|ssh[ _-]?key|密码|密钥|私钥|口令)\s*(?:是|为|[:=：])\s*\S{3,}/i,
    /\bBearer\s+[a-z0-9._~+/-]{8,}/i,
    /https?:\/\/[^\s/:]+:[^\s/@]+@/i,
  ].some((pattern) => pattern.test(text));
}

export function containsMemoryInstructionAttack(text: string): boolean {
  return [
    /ignore\s+(?:all\s+)?(?:previous|prior|system)\s+(?:instructions|rules|prompts)/i,
    /(?:忽略|无视|覆盖|绕过|关闭|禁用).{0,16}(?:系统提示|系统指令|审批规则|安全规则|权限检查|工具审批)/,
    /(?:disable|bypass|override).{0,20}(?:approval|guardrail|permission|safety)/i,
    /<(?:system|developer)>/i,
  ].some((pattern) => pattern.test(text));
}
