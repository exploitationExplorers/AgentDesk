import type { FeedTag } from "@agentdesk/shared";
import type { RawFeedItem } from "./types";

const RULES: Array<{ tag: FeedTag; pattern: RegExp }> = [
  {
    tag: "ai",
    pattern:
      /\b(ai|llm|gpt|agent|agents|rag|diffusion|transformer|embedding|inference|model|models|vlm|multimodal|claude|gemini|mcp|prompt|neural|lora|text-generation|image-to|text-to)\b/i,
  },
  {
    tag: "frontend",
    pattern:
      /\b(react|vue|svelte|angular|css|tailwind|frontend|ui|component|next\.?js|nuxt|vite|browser|web ?app|typescript|javascript)\b/i,
  },
  {
    tag: "backend",
    pattern:
      /\b(api|server|backend|database|sql|postgres|redis|kafka|microservice|grpc|spring|django|fastapi|go|golang|rust|java|orm)\b/i,
  },
  {
    tag: "devops",
    pattern:
      /\b(docker|kubernetes|k8s|devops|ci\/cd|terraform|deploy|observability|monitoring|linux|shell)\b/i,
  },
  { tag: "mobile", pattern: /\b(ios|android|flutter|react native|swift|kotlin|mobile)\b/i },
];

const LANGUAGE_TAGS: Record<string, FeedTag> = {
  typescript: "frontend",
  javascript: "frontend",
  vue: "frontend",
  css: "frontend",
  html: "frontend",
  go: "backend",
  java: "backend",
  rust: "backend",
  "c#": "backend",
  kotlin: "mobile",
  swift: "mobile",
  dart: "mobile",
};

/** 规则分类，作为 LLM 分类不可用时的兜底。 */
export function classifyFeedItem(
  item: Pick<RawFeedItem, "title" | "description" | "language" | "source">,
): FeedTag[] {
  if (item.source === "huggingface") return ["ai"];
  const text = `${item.title} ${item.description}`;
  const tags = new Set<FeedTag>(RULES.filter((r) => r.pattern.test(text)).map((r) => r.tag));
  const lang = item.language?.toLowerCase();
  if (lang && LANGUAGE_TAGS[lang] && tags.size === 0) tags.add(LANGUAGE_TAGS[lang]);
  if (tags.size === 0) tags.add("other");
  return [...tags].slice(0, 3);
}
