/** ESM 加载器钩子：测试直接 `node --test` 运行时，把 .jsx 源码用 esbuild 转成普通 ESM。 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".jsx")) return nextLoad(url, context);
  const source = await readFile(fileURLToPath(url), "utf8");
  const { code } = await transform(source, {
    loader: "jsx",
    jsx: "automatic",
    format: "esm",
    sourcefile: fileURLToPath(url),
  });
  return { format: "module", source: code, shortCircuit: true };
}
