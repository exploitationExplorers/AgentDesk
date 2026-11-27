/** 把本机路径显示成文件夹名和所在位置，主目录用 ~ 表示。 */
export function presentFolder(path: string): { name: string; location: string } {
  const trimmed = normalizeFolder(path);
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\")) {
    const parts = trimmed.split(/[\\/]/).filter(Boolean);
    const name = parts.at(-1) ?? trimmed;
    return { name, location: parts.slice(0, -1).join("\\") };
  }
  const shortened = trimmed
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~");
  const parts = shortened.split("/").filter(Boolean);
  if (parts.length === 0 || shortened === "~") return { name: "个人文件夹", location: "" };
  return {
    name: parts.at(-1) ?? shortened,
    location: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
  };
}

export function normalizeFolder(path: string): string {
  const trimmed = path.trim();
  if (/^[A-Za-z]:[\\/]?$/.test(trimmed) || trimmed === "/" || trimmed === "\\") return trimmed;
  return trimmed.replace(/[\\/]+$/, "");
}
