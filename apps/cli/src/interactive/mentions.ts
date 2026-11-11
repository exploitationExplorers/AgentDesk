export interface MentionableSkill {
  name: string;
  description: string;
  userInvocable?: boolean;
  agents?: string[];
}

export interface MentionQuery {
  /** `@` 在输入中的起始下标。 */
  start: number;
  /** `@` 之后已输入的筛选词。 */
  query: string;
}

/** 仅在输入末尾正在写 `@技能` 时返回查询；中间的历史 mention 不打开菜单。 */
export function mentionQuery(input: string): MentionQuery | null {
  const match = /(^|[\s([{])@([a-zA-Z0-9_-]*)$/.exec(input);
  if (!match) return null;
  return { start: match.index! + match[1]!.length, query: match[2] ?? "" };
}

export function mentionSuggestions(
  input: string,
  skills: MentionableSkill[],
  agent?: string,
): MentionableSkill[] {
  const active = mentionQuery(input);
  if (!active) return [];
  const query = active.query.toLowerCase();
  return skills
    .filter((skill) => skill.userInvocable !== false)
    .filter((skill) => !agent || !skill.agents?.length || skill.agents.includes(agent))
    .filter((skill) => {
      if (!query) return true;
      const haystack = `${skill.name} ${skill.description}`.toLowerCase();
      return skill.name.toLowerCase().startsWith(query) || haystack.includes(query);
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** 把当前半截 `@query` 替换成完整 `@name `。 */
export function applyMention(input: string, start: number, name: string): string {
  const prefix = input.slice(0, start);
  const rest = input.slice(start).replace(/^@[a-zA-Z0-9_-]*/, "");
  return `${prefix}@${name}${rest.startsWith(" ") ? rest : ` ${rest}`}`;
}
