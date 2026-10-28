import { createHash } from "node:crypto";
import type { FileChange } from "@agentdesk/shared";

export const contentHash = (content: string) => createHash("sha256").update(content).digest("hex");

/** 有界的行级比较；大范围重写退化为整段替换，避免平方级内存增长。 */
export function fileChange(path: string, before: string | null, after: string): FileChange {
  const lines = (text: string) => text.replace(/\r\n/g, "\n").match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const oldLines = lines(before ?? "");
  const newLines = lines(after);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start])
    start++;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }
  const a = oldLines.slice(start, endOld);
  const b = newLines.slice(start, endNew);
  const changes: string[] = [];
  if ((a.length + 1) * (b.length + 1) <= 1_000_000) {
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * width + j] =
          a[i] === b[j]
            ? table[(i + 1) * width + j + 1]! + 1
            : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        changes.push(` ${a[i++]}`);
        j++;
      } else if (
        i < a.length &&
        (j === b.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)
      )
        changes.push(`-${a[i++]}`);
      else changes.push(`+${b[j++]}`);
    }
  } else {
    for (const line of a) changes.push(`-${line}`);
    for (const line of b) changes.push(`+${line}`);
  }
  const additions = changes.filter((line) => line.startsWith("+")).length;
  const deletions = changes.filter((line) => line.startsWith("-")).length;
  const contextStart = Math.max(0, start - 3);
  const tail = Math.min(3, oldLines.length - endOld);
  const body = [
    ...oldLines.slice(contextStart, start).map((line) => ` ${line}`),
    ...changes,
    ...oldLines.slice(endOld, endOld + tail).map((line) => ` ${line}`),
  ];
  const diff =
    additions || deletions
      ? [
          `--- ${before === null ? "/dev/null" : `a/${path}`}`,
          `+++ b/${path}`,
          `@@ -${oldLines.length ? contextStart + 1 : 0},${endOld + tail - contextStart} +${newLines.length ? contextStart + 1 : 0},${endNew + tail - contextStart} @@`,
          ...body.flatMap((line) =>
            line.endsWith("\n") ? [line.slice(0, -1)] : [line, "\\ No newline at end of file"],
          ),
        ].join("\n")
      : "";
  return {
    path,
    operation: before === null ? "create" : "edit",
    additions,
    deletions,
    diff: diff.slice(0, 80_000),
    truncated: diff.length > 80_000,
    beforeHash: before === null ? null : contentHash(before),
    afterHash: contentHash(after),
  };
}
