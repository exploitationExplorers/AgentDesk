import type { MarkedExtension } from "marked";

// marked-terminal 7 的工厂返回 { renderer }，上游声明仍误写为 Renderer 实例。
declare module "marked-terminal" {
  export function markedTerminal(): MarkedExtension;
}
