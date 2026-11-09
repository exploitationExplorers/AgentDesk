import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
const ca = readFileSync("/fixture/cert.pem"),
  mode = process.argv[2] ?? "login";
let cookie = "";
function call(path, body, csrf) {
  return new Promise((resolve, reject) => {
    const req = request(
      "https://fixture:8443" + path,
      {
        ca,
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: "https://fixture:8443",
          cookie,
          "content-type": "application/json",
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            /* HTML 页面无需 JSON 解析。 */
          }
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("HTTPS fixture request timed out")));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
if (mode === "login") {
  assert.equal((await call("/api/v1/hosts")).status, 401);
  assert.equal((await call("/")).status, 200);
  const csrf = await call("/api/v1/auth/csrf");
  assert.equal(csrf.status, 200);
  cookie = csrf.headers["set-cookie"].map((v) => v.split(";")[0]).join("; ");
  const send = await call(
    "/api/v1/auth/otp/request",
    { email: "owner@example.test" },
    csrf.json.csrfToken,
  );
  assert.equal(send.status, 202, send.text);
  const otp = (await call("/__fixture/otp")).json.otp;
  assert.match(otp, /^\d{6}$/);
  const login = await call(
    "/api/v1/auth/otp/verify",
    { email: "owner@example.test", otp },
    csrf.json.csrfToken,
  );
  assert.equal(login.status, 200, login.text);
  const sessionCookie = login.headers["set-cookie"].find((v) =>
    v.startsWith("__Host-agentdesk_session="),
  );
  assert(sessionCookie.includes("Secure"));
  assert(sessionCookie.includes("HttpOnly"));
  cookie = sessionCookie.split(";")[0];
  writeFileSync("/data/test-session", cookie, { mode: 0o600 });
} else cookie = readFileSync("/data/test-session", "utf8");
const session = await call("/api/v1/session");
assert.equal(session.status, 200, session.text);
const hosts = await call("/api/v1/hosts");
assert.equal(hosts.status, 200, hosts.text);
assert(JSON.stringify(hosts.json).includes("cloud"), "Missing real cloud host");
const projects = await call("/api/v1/hosts/cloud/projects");
assert.equal(projects.status, 200, projects.text);
assert(projects.json.projects.length >= 1, "Configured workspace was not registered");
assert.equal((await call("/remote-api/v1/health")).status, 404);
if (mode === "login") {
  const credentials = await call(
    "/api/v1/hosts/cloud/git-credentials",
    { url: "https://github.com/owner/fixture", username: "fixture", token: "fixture-git-token" },
    session.json.csrfToken,
  );
  assert.equal(credentials.status, 200, credentials.text);
  assert(!credentials.text.includes("fixture-git-token"));
}
console.info(
  "Compose " + mode + ": HTTPS, TLS SMTP login, secure session and host/project routing passed",
);
