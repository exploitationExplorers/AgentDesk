// 只读上线检查；验证码、真实任务和 Git 推送由部署者随后交互验收。
const origin = new URL(process.argv[2]);
if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash)
  throw new Error("Expected exact HTTPS origin");
for (const [path, allowed] of [
  ["/", [200]],
  ["/cloud-sw.js", [200]],
  ["/api/v1/session", [401]],
  ["/api/v1/hosts", [401]],
  ["/remote-api/v1/health", [404]],
  ["/api/cli/shutdown", [404, 401]],
  ["/.env", [404]],
]) {
  const response = await fetch(new URL(path, origin), {
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (!allowed.includes(response.status)) throw new Error(`${path}: unexpected ${response.status}`);
  if (path === "/" && !(response.headers.get("content-type") ?? "").includes("text/html"))
    throw new Error("Mobile entry is missing");
  await response.body?.cancel();
  console.info(`${path}: ${response.status}`);
}
