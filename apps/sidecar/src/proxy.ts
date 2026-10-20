import { execFileSync } from "node:child_process";
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/** 读取 Windows「设置 > 代理」中的手动代理（Clash 等工具通常写在这里） */
function windowsSystemProxy(): string | null {
  if (process.platform !== "win32") return null;
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  try {
    const enabled = execFileSync("reg", ["query", key, "/v", "ProxyEnable"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (!/0x1\b/.test(enabled)) return null;
    const server = execFileSync("reg", ["query", key, "/v", "ProxyServer"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const value = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(server)?.[1];
    if (!value) return null;
    // 形如 "http=127.0.0.1:7890;https=127.0.0.1:7890" 或 "127.0.0.1:7890"
    const https = /https=([^;]+)/.exec(value)?.[1] ?? value.split(";")[0]!.replace(/^\w+=/, "");
    return https.includes("://") ? https : `http://${https}`;
  } catch {
    return null;
  }
}

export function resolveProxy(configured: string | undefined): string | null {
  return (
    configured?.trim() || process.env.HTTPS_PROXY || process.env.https_proxy || windowsSystemProxy()
  );
}

/** 让全局 fetch（热榜、Git 平台 API、LLM）走代理，本机地址始终直连。 */
export function applyProxy(proxy: string | null): void {
  if (!proxy) {
    setGlobalDispatcher(new Agent());
    return;
  }
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      httpProxy: proxy,
      httpsProxy: proxy,
      noProxy: "localhost,127.0.0.1,::1",
    }),
  );
}
