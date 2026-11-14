import { getSidecarInfo } from "../../lib/tauri";
import { TeamSession } from "@agentdesk/shared";

export const isTeamHost = () => import.meta.env.VITE_AGENTDESK_MODE === "team";
export async function teamRequest<T>(path: string, token?: string, body?: unknown): Promise<T> {
  const base = isTeamHost() ? window.location.origin : (await getSidecarInfo()).url;
  const response = await fetch(`${base}/team-api/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? "团队请求未完成");
  return value as T;
}
const storageKey = "agentdesk.team.sessions";
export function readTeamSessions(): TeamSession[] {
  try {
    return TeamSession.array().parse(JSON.parse(localStorage.getItem(storageKey) ?? "[]"));
  } catch {
    return [];
  }
}
export function storeTeamSessions(sessions: TeamSession[]) {
  localStorage.setItem(storageKey, JSON.stringify(sessions));
}
