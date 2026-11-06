// A plugin in this install's folder wins over one that ships.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HOME } from "./home.ts";

export async function loadPlugin(name: string, kind: "agent" | "channel" | "source") {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`插件名字不正确：${name}`);
  const entry = join(name, `${kind}.ts`);
  const file = [join(HOME, "plugins", entry), join(import.meta.dirname, "..", "plugins", entry)].find(existsSync);
  if (!file) throw new Error(`没有 ${name} 的插件（plugins/${name}/${kind}.ts）`);
  return (await import(pathToFileURL(file).href)).default;
}
