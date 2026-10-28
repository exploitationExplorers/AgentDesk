import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Project } from "@agentdesk/shared";
import { apiRequest, type ApiState } from "./client.js";

/** 将启动目录所属的 Git 项目登记为本轮工作目录；使用服务返回的规范路径。 */
export async function registerWorkspace(
  state: ApiState,
  cwd = process.cwd(),
): Promise<string | undefined> {
  let root = cwd;
  while (!existsSync(join(root, ".git")) && dirname(root) !== root) root = dirname(root);
  if (!existsSync(join(root, ".git"))) return undefined;
  const project = await (
    await apiRequest<Project>(state, "/projects", {
      method: "POST",
      body: JSON.stringify({ path: root }),
    })
  ).json();
  return project.path;
}
