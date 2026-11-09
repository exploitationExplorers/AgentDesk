import { readFileSync } from "node:fs";
import { createServer as tlsServer } from "node:tls";
import { createServer as httpsServer } from "node:https";
import { request } from "node:http";
const tls = { key: readFileSync("/fixture/key.pem"), cert: readFileSync("/fixture/cert.pem") };
let lastCode;
const smtp = tlsServer(tls, (socket) => {
  socket.setEncoding("utf8");
  socket.write("220 fixture ESMTP\r\n");
  let buffer = "",
    message = "",
    collecting = false,
    authStep = 0;
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\r\n")) {
      const index = buffer.indexOf("\r\n"),
        line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (collecting) {
        if (line === ".") {
          const body = message.slice(message.indexOf("\n\n") + 2);
          const decoded = /Content-Transfer-Encoding: base64/i.test(message)
            ? Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8")
            : body.replace(/=\n/g, "");
          lastCode = decoded.match(/\b\d{6}\b/)?.[0];
          message = "";
          collecting = false;
          socket.write("250 accepted\r\n");
        } else message += line + "\n";
      } else if (authStep) {
        authStep--;
        socket.write(authStep ? "334 UGFzc3dvcmQ6\r\n" : "235 authenticated\r\n");
      } else if (/^EHLO|^HELO/.test(line)) socket.write("250-fixture\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (/^AUTH LOGIN/.test(line)) {
        authStep = 2;
        socket.write("334 VXNlcm5hbWU6\r\n");
      } else if (/^AUTH PLAIN/.test(line)) socket.write("235 authenticated\r\n");
      else if (line === "DATA") {
        collecting = true;
        socket.write("354 send data\r\n");
      } else if (line === "QUIT") socket.end("221 goodbye\r\n");
      else socket.write("250 ok\r\n");
    }
  });
});
smtp.listen(2465, "0.0.0.0");
const proxy = httpsServer(tls, (req, res) => {
  if (req.url === "/__fixture/otp") {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ otp: lastCode }));
    return;
  }
  const upstream = request(
    {
      hostname: "gateway",
      port: 3000,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: "fixture:8443",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "192.0.2.10",
      },
    },
    (incoming) => {
      res.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(res);
    },
  );
  upstream.on("error", () => res.writeHead(502).end());
  req.pipe(upstream);
});
proxy.listen(8443, "0.0.0.0");
process.on("SIGTERM", () => {
  smtp.close();
  proxy.closeAllConnections();
  proxy.close(() => process.exit(0));
});
console.info("Local HTTPS and SMTP fixture ready");
