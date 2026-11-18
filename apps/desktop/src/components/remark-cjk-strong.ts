interface Node {
  type: string;
  value?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
/** 容忍模型把中文加粗末尾的空格写在 ** 内；不触碰代码节点或原始 HTML。 */
export function remarkCjkStrong() {
  return (root: unknown, file?: unknown) => {
    const source = String(file ?? "");
    const walk = (node: Node) => {
      if (!node.children || ["code", "inlineCode", "html"].includes(node.type)) return;
      const next: Node[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value) {
          walk(child);
          next.push(child);
          continue;
        }
        // 已转义的星号属于用户字面量，不能被兼容规则变成格式。
        if (
          child.position &&
          source.slice(child.position.start.offset, child.position.end.offset).includes("\\*")
        ) {
          next.push(child);
          continue;
        }
        const value = child.value;
        const matches = [...value.matchAll(/\*\*([^*\n]*[\u3400-\u9fff][^*\n]*\s)\*\*/g)];
        let at = 0;
        for (const match of matches) {
          if (match.index > at) next.push({ type: "text", value: value.slice(at, match.index) });
          next.push({ type: "strong", children: [{ type: "text", value: match[1]!.trim() }] });
          next.push({ type: "text", value: " " });
          at = match.index + match[0].length;
        }
        if (!matches.length) next.push(child);
        else if (at < value.length) next.push({ type: "text", value: value.slice(at) });
      }
      node.children = next;
    };
    walk(root as Node);
  };
}
