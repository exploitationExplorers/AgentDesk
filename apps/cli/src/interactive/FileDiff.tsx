import { Box, Text } from "ink";
import { stripVTControlCharacters } from "node:util";
import { FileChange } from "@agentdesk/shared";
import { pick } from "./colors.js";
import type { AccessibilityTheme } from "./theme.js";

export function resultFileChange(result: unknown): FileChange | undefined {
  if (typeof result !== "object" || result === null || !("change" in result)) return undefined;
  const parsed = FileChange.safeParse(result.change);
  return parsed.success ? parsed.data : undefined;
}

type DiffRow = { kind: "context" | "add" | "delete" | "note"; number?: number; text: string };

/** 行号来自真实 diff 的 hunk，删除行使用旧文件行号，新增与上下文使用新文件行号。 */
export function diffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of stripVTControlCharacters(diff).split(/\r?\n/)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      if (inHunk) rows.push({ kind: "note", text: "…" });
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
    } else if (inHunk && line.startsWith("+")) {
      rows.push({ kind: "add", number: newLine++, text: line.slice(1) });
    } else if (inHunk && line.startsWith("-")) {
      rows.push({ kind: "delete", number: oldLine++, text: line.slice(1) });
    } else if (inHunk && line.startsWith(" ")) {
      rows.push({ kind: "context", number: newLine++, text: line.slice(1) });
      oldLine++;
    } else if (inHunk && line.startsWith("\\")) {
      rows.push({ kind: "note", text: "文件末尾无换行" });
    }
  }
  return rows;
}

/** 单纯渲染已解析的 diff 行；FileDiff（执行后真实差异）和审批预览（执行前)共用。 */
export function DiffLines({ rows, theme }: { rows: DiffRow[]; theme: AccessibilityTheme }) {
  const digits = rows.reduce((width, row) => Math.max(width, String(row.number ?? "").length), 1);
  return (
    <>
      {rows.map((row, index) => {
        const added = row.kind === "add";
        const deleted = row.kind === "delete";
        return (
          <Box key={index} flexShrink={0}>
            <Text
              wrap="truncate-end"
              dimColor={row.kind === "note"}
              color={added ? pick("diffAdded", theme) : deleted ? pick("diffRemoved", theme) : undefined}
              backgroundColor={
                added ? pick("diffAddedBg", theme) : deleted ? pick("diffRemovedBg", theme) : undefined
              }
            >
              {`${String(row.number ?? "").padStart(digits)} ${added ? "+" : deleted ? "-" : " "} ${row.text.replace(/\t/g, "  ")}`}
            </Text>
          </Box>
        );
      })}
    </>
  );
}

export default function FileDiff({
  change,
  theme,
}: {
  change: FileChange;
  theme: AccessibilityTheme;
}) {
  const rows = diffRows(change.diff);
  return (
    <Box flexDirection="column" paddingLeft={3} flexShrink={0}>
      <Text>
        <Text color={pick("success", theme)}>+{change.additions}</Text>{" "}
        <Text color={pick("error", theme)}>−{change.deletions}</Text>
        <Text dimColor> 行{change.additions || change.deletions ? "" : " · 内容未变化"}</Text>
      </Text>
      <DiffLines rows={rows} theme={theme} />
      {change.truncated ? (
        <Text dimColor>差异较长，以上显示部分内容；增删统计包含全部改动。</Text>
      ) : null}
    </Box>
  );
}
