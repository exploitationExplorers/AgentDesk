import { readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { Env, Hono } from "hono";

const publicFiles = new Map([
  ["/", "cloud.html"],
  ["/cloud.html", "cloud.html"],
  ["/cloud-sw.js", "cloud-sw.js"],
  ["/manifest.webmanifest", "manifest.webmanifest"],
  ["/cloud-icon.svg", "cloud-icon.svg"],
]);
const contentTypes: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  png: "image/png",
  woff: "font/woff",
  woff2: "font/woff2",
};

/** 仅公开构建产物；未知路径和 API 不回退到 HTML。 */
export function registerCloudAssets<E extends Env>(app: Hono<E>, directory: string): void {
  app.on(["GET", "HEAD"], "*", async (c, next) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;
    const asset = /^\/assets\/[a-zA-Z0-9_-]+\.(?:js|css|woff2?|svg|png)$/.test(pathname);
    const name = publicFiles.get(pathname) ?? (asset ? pathname.slice(1) : undefined);
    if (!name || url.search) return next();
    let file: string;
    try {
      const root = await realpath(directory);
      file = await realpath(resolve(root, name));
      const path = relative(root, file);
      if (path === ".." || path.startsWith(`..${sep}`) || resolve(root, path) !== file)
        return next();
      if (!(await stat(file)).isFile()) return next();
    } catch {
      return next();
    }
    c.header("Content-Type", contentTypes[name.split(".").at(-1)!]!);
    c.header("Cache-Control", asset ? "public, max-age=31536000, immutable" : "no-cache");
    // 手机导航使用 Shadow DOM 动态样式和内嵌字体，脚本仍只允许本站构建文件。
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (pathname === "/cloud-sw.js") c.header("Service-Worker-Allowed", "/");
    if (c.req.method === "HEAD") return c.body(null);
    return c.body(new Uint8Array(await readFile(file)));
  });
}
