import type { FileChange } from "@agentdesk/shared";

export function DiffView({ change }: { change: FileChange }) {
  let oldLine = 0;
  let newLine = 0;
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="code-diff">
      <table
        className="w-full border-collapse font-mono text-[12px] leading-6"
        aria-label={`文件差异 ${change.path}`}
      >
        <tbody>
          {change.diff.split("\n").map((line, index) => {
            const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
            if (hunk) {
              oldLine = Number(hunk[1]);
              newLine = Number(hunk[2]);
            }
            const meta =
              !!hunk ||
              (index < 2 && (line.startsWith("---") || line.startsWith("+++"))) ||
              line.startsWith("\\ No newline");
            const added = !meta && line.startsWith("+");
            const removed = !meta && line.startsWith("-");
            const oldNumber = meta || added ? "" : oldLine++;
            const newNumber = meta || removed ? "" : newLine++;
            return (
              <tr
                key={index}
                className={
                  meta
                    ? "bg-info/5 text-info"
                    : added
                      ? "bg-success/10 text-success"
                      : removed
                        ? "bg-danger/10 text-danger"
                        : "text-muted"
                }
              >
                <td className="w-10 select-none border-r px-2 text-right text-subtle">
                  {oldNumber}
                </td>
                <td className="w-10 select-none border-r px-2 text-right text-subtle">
                  {newNumber}
                </td>
                <td className="whitespace-pre px-3">{line || " "}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!change.diff && <p className="p-6 text-sm text-muted">文件内容没有变化。</p>}
      {change.truncated && (
        <p className="p-4 text-xs text-warning">
          差异超过展示上限，已截断。请在本地编辑器查看完整文件。
        </p>
      )}
    </div>
  );
}
