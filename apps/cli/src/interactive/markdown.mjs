import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

let configured = false;

function ensureConfigured() {
  if (configured) return;
  marked.use(markedTerminal());
  configured = true;
}

/** 一轮对话结束后对最终文本做一次性 ANSI 渲染；流式阶段直接显示原始文本，避免半截 markdown 渲染错乱。 */
export function renderMarkdown(text, { color = true } = {}) {
  if (!color || !text) return text;
  ensureConfigured();
  const rendered = marked.parse(text, { async: false });
  return typeof rendered === "string" ? rendered.replace(/\n+$/, "") : text;
}
