// The one page there is: a card at its own link, for channels that can only send words. A plain form, so it needs no
// script, no sign-in and nothing else from the hub. An Agent wrote what it shows after reading other people's words:
// all of it is escaped, and the only thing the page may load is its own style.
import { createHash } from "node:crypto";
import type { cardView } from "./query.ts";

const STYLE = `:root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif}
body{max-width:34rem;margin:0 auto;padding:32px 16px;overflow-wrap:anywhere}
h1{font-size:1.25rem;line-height:1.4;margin:0 0 12px}
p{white-space:pre-wrap;margin:0 0 20px}
form{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}
button,input{font:inherit;min-height:44px;border-radius:8px;border:1px solid GrayText;padding:0 16px;\
background:Canvas;color:CanvasText}
button.best{background:CanvasText;color:Canvas;border-color:CanvasText}
input{flex:1 1 12rem;min-width:0}`;

const STYLE_SHA = createHash("sha256").update(STYLE).digest("base64");
const POLICY =
  `default-src 'none'; style-src 'sha256-${STYLE_SHA}'; ` +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": POLICY,
};

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escaped = (words: string) => words.replace(/[&<>"']/g, (char) => ENTITIES[char]);

const shell = (title: string, content: string) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaped(title)}</title>` +
  `<style>${STYLE}</style></head><body>${content}</body></html>`;

export const wordsPage = (words: string) => shell(words, `<p>${escaped(words)}</p>`);

export function cardPage(card: ReturnType<typeof cardView>) {
  const words = `<h1>${escaped(card.title)}</h1>${card.text ? `<p>${escaped(card.text)}</p>` : ""}`;
  if (card.state === "open") {
    const button = (option: string, index: number) => {
      const best = index === card.recommend ? ' class="best"' : "";
      return `<button name="choice" value="${index}"${best}>${escaped(option)}</button>`;
    };
    // Its own form: Enter in the box mustn't press the first option.
    // A notice can take a line on how it was handled: optional, and kept with the closing.
    const notice = card.kind === "notice";
    const box = notice
      ? `<input name="text" placeholder="我实际怎么处理的（可不填）" aria-label="处理说明">`
      : `<input name="text" placeholder="别的想法" aria-label="别的想法" required>`;
    const other = `<form method="post">${box}<button>${notice ? "记录并结案" : "发送"}</button></form>`;
    return shell(card.title, `${words}<form method="post">${card.options.map(button).join("")}</form>${other}`);
  }
  const chosen = card.kind === "ask" ? (card.choice !== null ? card.options[card.choice] : card.answer) : null;
  const outcome = [chosen ? `你选了「${chosen}」` : "", card.result ?? ""].filter(Boolean).join("。");
  const settled = card.kind === "notice" && card.answer ? `<p>处理说明：${escaped(card.answer)}</p>` : "";
  return shell(card.title, `${words}${outcome ? `<p>${escaped(outcome)}</p>` : ""}${settled}`);
}
