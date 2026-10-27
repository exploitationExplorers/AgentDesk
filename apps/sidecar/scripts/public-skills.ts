import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import PUBLIC_SKILLS from "./public-skills.json";

// 发布包仅包含明确允许公开的技能，避免复制本机私有 skill 或微信数据。
export function copyPublicSkills(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const name of PUBLIC_SKILLS) {
    cpSync(join(source, name), join(destination, name), { recursive: true });
  }
}
