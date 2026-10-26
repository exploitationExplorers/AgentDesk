import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Type } from "@mariozechner/pi-ai";
import type { AgentName } from "@agentdesk/shared";
import { defineTool, type AnyAgentTool } from "./tools";

export interface Skill {
  name: string;
  description: string;
  version: string;
  agents: AgentName[];
  triggers: string[];
  allowedTools: string[];
  instructions: string;
  dir: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkill(source: string, dir: string): Skill {
  // PowerShell Set-Content -Encoding utf8 会写入 BOM，需剥离后再匹配 frontmatter
  const text = source.replace(/^\uFEFF/, "");
  const match = FRONTMATTER.exec(text);
  if (!match) throw new Error(`SKILL.md 缺少 frontmatter：${dir}`);
  const meta = (parseYaml(match[1] ?? "") ?? {}) as Record<string, unknown>;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  if (typeof meta.name !== "string" || typeof meta.description !== "string") {
    throw new Error(`SKILL.md 需要 name 和 description：${dir}`);
  }
  return {
    name: meta.name,
    description: meta.description,
    version: String(meta.version ?? "1.0.0"),
    agents: list(meta.agents) as AgentName[],
    triggers: list(meta.triggers),
    allowedTools: list(meta.allowed_tools),
    instructions: (match[2] ?? "").trim(),
    dir,
  };
}

/**
 * 渐进式加载：系统提示里只放技能目录（名称 + 描述），
 * 模型需要时调用 skills.load 拿到完整指令，避免把所有技能塞进上下文。
 */
export class SkillRegistry {
  private skills = new Map<string, Skill>();

  async loadFrom(roots: string[], options: { exclude?: string[] } = {}): Promise<void> {
    const excluded = new Set(options.exclude);
    for (const root of roots) {
      let entries: string[] = [];
      try {
        entries = await readdir(root);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (excluded.has(entry)) continue;
        const dir = join(root, entry);
        try {
          const source = await readFile(join(dir, "SKILL.md"), "utf8");
          const skill = parseSkill(source, dir);
          if (!excluded.has(skill.name)) this.skills.set(skill.name, skill);
        } catch {
          // 非技能目录或格式错误，跳过
        }
      }
    }
  }

  add(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  forAgent(agent: AgentName): Skill[] {
    return this.list().filter((s) => s.agents.length === 0 || s.agents.includes(agent));
  }

  /** 用户消息命中 trigger 的技能，会在本轮直接注入完整指令。 */
  matchTriggers(agent: AgentName, text: string): Skill[] {
    const lower = text.toLowerCase();
    return this.forAgent(agent).filter((s) =>
      s.triggers.some((t) => lower.includes(t.toLowerCase())),
    );
  }

  promptFor(agent: AgentName, userText: string): string {
    const available = this.forAgent(agent);
    if (available.length === 0) return "";
    const catalog = available.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    const activated = this.matchTriggers(agent, userText)
      .map((s) => `<skill name="${s.name}" version="${s.version}">\n${s.instructions}\n</skill>`)
      .join("\n\n");
    return [
      `可用技能（需要时调用 skills.load 获取完整指令）：\n${catalog}`,
      activated ? `本轮已激活的技能：\n${activated}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  createLoadTool(): AnyAgentTool {
    return defineTool({
      name: "skills.load",
      description: "加载指定技能的完整操作指令（SKILL.md）",
      parameters: Type.Object({ name: Type.String({ description: "技能名称" }) }),
      risk: "safe",
      execute: async ({ name }) => {
        const skill = this.get(name);
        if (!skill) throw new Error(`技能不存在：${name}`);
        return {
          name: skill.name,
          version: skill.version,
          dir: skill.dir,
          allowedTools: skill.allowedTools,
          instructions: skill.instructions,
        };
      },
    });
  }
}
