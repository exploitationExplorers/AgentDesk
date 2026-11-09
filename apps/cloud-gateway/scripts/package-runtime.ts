import { cp, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";

// 从已按锁文件安装的包复制依赖图，打包阶段不重新解析版本或访问 registry。
const destination = resolve(process.argv[2] ?? "dist-runtime");
const store = join(destination, "node_modules/.store");
await mkdir(store, { recursive: true });
const copied = new Map<string, string>();
async function locate(name: string, parent: string) {
  const require = createRequire(join(parent, "package.json"));
  try {
    return dirname(await realpath(require.resolve(`${name}/package.json`)));
  } catch {
    let path = dirname(await realpath(require.resolve(name)));
    for (;;) {
      try {
        if (JSON.parse(await readFile(join(path, "package.json"), "utf8")).name === name)
          return path;
      } catch {
        /* 包入口可能位于 dist 子目录。 */
      }
      const next = dirname(path);
      if (next === path) throw new Error(`Cannot locate ${name}`);
      path = next;
    }
  }
}
async function copy(name: string, parent: string, linkRoot: string) {
  const source = await locate(name, parent);
  let target = copied.get(source);
  if (!target) {
    target = join(
      store,
      createHash("sha256").update(relative(process.cwd(), source)).digest("hex").slice(0, 20),
      name,
    );
    copied.set(source, target);
    await cp(source, target, {
      recursive: true,
      filter: (path) => path === source || basename(path) !== "node_modules",
    });
    const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    for (const dependency of Object.keys({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    })) {
      try {
        await locate(dependency, source);
      } catch (error) {
        if (
          pkg.optionalDependencies?.[dependency] ||
          pkg.peerDependenciesMeta?.[dependency]?.optional
        )
          continue;
        throw error;
      }
      await copy(dependency, source, join(target, "node_modules"));
    }
  }
  const link = join(linkRoot, name);
  await mkdir(dirname(link), { recursive: true });
  await symlink(relative(dirname(link), target), link, "dir");
}
for (const dependency of ["better-auth", "better-sqlite3", "nodemailer"])
  await copy(dependency, process.cwd(), join(destination, "node_modules"));
console.info(`Packaged ${copied.size} runtime dependencies from the installed lockfile`);
