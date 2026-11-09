import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Context } from "hono";
import { AppError, ErrorCode } from "@agentdesk/shared";
import type { GatewayConfig } from "../config";
import type { GatewayAuth } from "./service";
import type { GatewayStore } from "../db/store";

export function clientAddress(c: Context, config: GatewayConfig, peer: string): string {
  const address = peer.startsWith("::ffff:") ? peer.slice(7) : peer;
  const family = isIP(address) === 6 ? "ipv6" : "ipv4";
  const trusted = isIP(address) && config.trustedProxies.check(address, family);
  const forwarded = c.req.header("x-forwarded-for");
  const protocol = c.req.header("x-forwarded-proto");
  if (
    (forwarded || protocol || c.req.header("forwarded") || c.req.header("x-forwarded-host")) &&
    !trusted
  )
    throw new AppError(ErrorCode.Forbidden, "不可信的代理来源");
  // 首版 Nginx 覆写单一来源地址；不猜测任意代理链的最后一跳。
  if (forwarded && !isIP(forwarded)) throw new AppError(ErrorCode.BadRequest, "无效的代理地址");
  if (c.req.header("host") !== new URL(config.publicOrigin).host)
    throw new AppError(ErrorCode.Forbidden, "无效的访问域名");
  if (new URL(c.req.url).protocol !== "https:" && !(trusted && protocol === "https"))
    throw new AppError(ErrorCode.Forbidden, "需要 HTTPS");
  return forwarded ?? address;
}

export function authHeaders(c: Context, config: GatewayConfig): Headers {
  // Better Auth 只接收已核实的 Origin 和 Cookie，不再次解释浏览器提供的代理头。
  const headers = new Headers({ origin: config.publicOrigin });
  const cookie = c.req.header("cookie");
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

export const csrfToken = (sessionId: string, secret: string) =>
  createHmac("sha256", secret).update(`csrf:${sessionId}`).digest("base64url");

export function verifyCsrf(value: string | undefined, sessionId: string, secret: string): void {
  const expected = Buffer.from(csrfToken(sessionId, secret));
  const actual = Buffer.from(value ?? "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new AppError(ErrorCode.Forbidden, "请求验证已失效，请刷新页面");
}

export async function requireSession(
  auth: GatewayAuth,
  store: GatewayStore,
  headers: Headers,
  config: GatewayConfig,
) {
  const result = await auth.api.getSession({
    headers,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!result || result.user.email !== config.ownerEmail || !result.user.emailVerified)
    throw new AppError(ErrorCode.Unauthorized, "请登录");
  const { session } = result;
  if (
    !Number.isFinite(session.updatedAt.getTime()) ||
    !Number.isFinite(session.createdAt.getTime()) ||
    Date.now() - session.updatedAt.getTime() >= 12 * 60 * 60_000 ||
    Date.now() - session.createdAt.getTime() >= 7 * 24 * 60 * 60_000
  ) {
    store.db.prepare('DELETE FROM "session" WHERE id=?').run(session.id);
    throw new AppError(ErrorCode.Unauthorized, "登录已过期");
  }
  store.db
    .prepare('UPDATE "session" SET "updatedAt"=? WHERE id=?')
    .run(new Date().toISOString(), session.id);
  return result;
}
