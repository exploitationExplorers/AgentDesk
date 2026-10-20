import type { ProviderApi, ProviderCandidate, ProviderSource } from "@agentdesk/shared";

/** 导入器内部结果，包含明文 key；只在 sidecar 进程内流转，返回 UI 前必须 toPublicCandidate。 */
export interface RawProviderCandidate {
  candidateId: string;
  name: string;
  api: ProviderApi;
  baseUrl: string;
  model?: string;
  apiKey: string;
  source: ProviderSource;
  origin: string;
}

export function maskSecret(secret: string): string {
  if (secret.length <= 10) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}

export function toPublicCandidate(raw: RawProviderCandidate): ProviderCandidate {
  const { apiKey, ...rest } = raw;
  return { ...rest, maskedKey: maskSecret(apiKey) };
}
