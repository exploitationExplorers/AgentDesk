import type { SkillInfo } from "../../lib/api";

export interface MentionQuery {
  start: number;
  query: string;
  /** 光标前的文本用于匹配时，完整替换区间截止到光标。 */
  end: number;
}

/** 根据光标前文本判断是否正在输入 `@技能`。 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const match = /(^|[\s([{])@([a-zA-Z0-9_-]*)$/.exec(before);
  if (!match) return null;
  const start = match.index! + match[1]!.length;
  return { start, query: match[2] ?? "", end: caret };
}

export function filterMentionSkills(
  skills: SkillInfo[],
  query: string,
  agent?: string,
): SkillInfo[] {
  const needle = query.toLowerCase();
  return skills
    .filter((skill) => skill.userInvocable !== false)
    .filter((skill) => !agent || !skill.agents?.length || skill.agents.includes(agent))
    .filter((skill) => {
      if (!needle) return true;
      const haystack = `${skill.name} ${skill.description}`.toLowerCase();
      return skill.name.toLowerCase().startsWith(needle) || haystack.includes(needle);
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function applyMentionAt(
  text: string,
  start: number,
  end: number,
  name: string,
): { value: string; caret: number } {
  const inserted = `@${name} `;
  const value = `${text.slice(0, start)}${inserted}${text.slice(end)}`;
  return { value, caret: start + inserted.length };
}
