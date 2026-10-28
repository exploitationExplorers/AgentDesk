import { setTimeout as delay } from "node:timers/promises";
import type { CliValues } from "./args.js";
import type * as Prompts from "@voidzero-dev/vite-plus-prompts";
import {
  SPINNER_FRAMES,
  STATUS_MARKS,
  icon as themeIcon,
  mark as themeMark,
  paint as themePaint,
  resolveAccessibility,
  wordmarkCharacters,
} from "./interactive/theme.js";

export type UiSettings = Pick<CliValues, "plain" | "no-color" | "no-motion" | "no-emoji">;
export interface OutputStream {
  write(text: string): unknown;
  isTTY?: boolean;
}
let preferences: UiSettings = {};
let promptModule: Promise<typeof Prompts> | undefined;

export function configureUi(values: UiSettings = {}) {
  preferences = values;
  if (values["no-color"] || values.plain) process.env.NO_COLOR = "1";
}

export async function loadPrompts() {
  promptModule ??= import("@voidzero-dev/vite-plus-prompts").then((prompts) => {
    prompts.SELECT_INSTRUCTIONS.splice(
      0,
      prompts.SELECT_INSTRUCTIONS.length,
      "↑/↓ 选择",
      "Enter 确认",
      "Esc 取消",
    );
    return prompts;
  });
  return promptModule;
}

export function createUi({
  stream = process.stderr,
  env = process.env,
  ...options
}: UiSettings & { stream?: OutputStream; env?: NodeJS.ProcessEnv } = {}) {
  const settings = { ...preferences, ...options };
  const { interactive, color, motion, emoji } = resolveAccessibility({
    tty: stream.isTTY,
    env,
    settings,
  });
  const paint = (code: string, text: string) => themePaint(color, code, text);
  const write = (text = "") => stream.write(`${text}\n`);
  const mark = (code: string, text: string, fallback: string) =>
    themeMark(color, interactive, code, text, fallback);
  const icon = (text: string, fallback = "") => themeIcon(emoji, text, fallback);
  const wordmark = (offset = 0) =>
    wordmarkCharacters(offset)
      .map(({ character, code }) => paint(code, character))
      .join("");
  const animate = async (render: (frame: number) => string, frames: number) => {
    if (!motion) return;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    try {
      for (let frame = 0; frame < frames; frame++) {
        stream.write(`\r\x1b[2K${render(frame)}`);
        await delay(28, undefined, { signal: controller.signal });
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error("已取消配置。");
      throw error;
    } finally {
      stream.write("\r\x1b[2K");
      process.removeListener("SIGINT", cancel);
    }
  };
  return {
    interactive,
    motion,
    paint,
    icon,
    async welcome(subtitle: string, version = "") {
      if (!interactive) {
        write(`AgentDesk${version ? ` v${version}` : ""} · ${subtitle}`);
        return;
      }
      write();
      await animate((frame) => `   ${paint("95", frame % 2 ? "✦" : "✧")}  ${wordmark(frame)}`, 8);
      write(
        `   ${paint("95", "✦")}  ${wordmark()}  ${paint("90", version ? `v${version}` : "CLI")}`,
      );
      write();
      write(`   ${icon("👋")}${paint("1", "欢迎使用 AgentDesk")}`);
      write(`   ${paint("90", "把想法交给 Agent，让灵感变成行动。")}`);
      write(`   ${paint("90", "你的模型 · 你的工作台 · 你的节奏")}`);
      write();
      write(`${paint("90", "┌")}  ${icon("🚀")}${paint("1", subtitle)}`);
    },
    async advance(completed: number, total: number, label: string) {
      if (!interactive) return;
      const rail = (spark = -1) =>
        Array.from({ length: total }, (_, index) => {
          const dot = index < completed ? paint("95", "●") : paint("90", "○");
          const link =
            index < total - 1
              ? paint(
                  index === spark ? "96" : index < completed - 1 ? "35" : "90",
                  index === spark ? "━›" : "━━",
                )
              : "";
          return dot + link;
        }).join("");
      await animate(
        (frame) =>
          `${paint("90", "│")}  ${rail(frame % Math.max(1, total - 1))}  ${paint("90", `${completed}/${total}`)}`,
        6,
      );
      write(`${paint("90", "│")}  ${rail()}  ${paint("90", `${completed}/${total} · ${label}`)}`);
    },
    header(subtitle: string, version = "") {
      write();
      write(
        `${paint("90", "┌")}  ${paint("1;45;97", " AgentDesk ")} ${paint("90", version ? `v${version}` : "CLI")}`,
      );
      write(`${paint("90", "│")}  ${subtitle}`);
    },
    outro(message: string, { cancelled = false } = {}) {
      write(`${paint("90", "│")}`);
      write(
        `${paint("90", "└")}  ${cancelled ? "" : icon("🎉")}${paint(cancelled ? "90" : "32", message)}\n`,
      );
    },
    note(text: string) {
      write(`${paint("90", "│")}  ${paint("90", text)}`);
    },
    success(text: string) {
      write(`${mark("32", STATUS_MARKS.success.text, STATUS_MARKS.success.fallback)}  ${text}`);
    },
    error(text: string) {
      write(`${mark("31", STATUS_MARKS.error.text, STATUS_MARKS.error.fallback)}  ${text}`);
    },
    card(title: string, rows: ReadonlyArray<readonly [string, string]>) {
      write(`${paint("90", "│")}`);
      write(`${paint("32", "◇")}  ${paint("1", title)}`);
      // 不依赖字符宽度补齐边框，窄终端和中文路径可以自然换行。
      for (const [label, value] of rows)
        write(`${paint("90", "│")}  ${paint("90", label)}  ${value}`);
    },
    async task<T>(label: string, action: () => T | Promise<T>): Promise<T> {
      if (!interactive) return action();
      if (!motion) {
        write(`${paint("90", "│")}  ${label}`);
        return action();
      }
      let frame = 0;
      const draw = () =>
        stream.write(
          `\r\x1b[2K${paint(Math.floor(frame / 6) % 2 ? "35" : "36", SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length] ?? "·")}  ${label} ${paint("90", "···")}`,
        );
      draw();
      const timer = setInterval(draw, 90);
      try {
        return await action();
      } finally {
        clearInterval(timer);
        stream.write("\r\x1b[2K");
      }
    },
  };
}

// 示例命令按当前平台的 shell 引用路径，避免空格、$ 等改变参数含义。
export function nextCommand(
  command: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
) {
  const safeHome = [...String(home)]
    .filter(
      (character) => (character.codePointAt(0) ?? 0) >= 32 && character.codePointAt(0) !== 127,
    )
    .join("");
  const path = safeHome.replaceAll("\\", "/");
  const quoted =
    platform === "win32" ? `'${path.replaceAll("'", "''")}'` : `'${path.replaceAll("'", "'\\''")}'`;
  return `agentdesk ${command} --data-dir ${quoted}`;
}
