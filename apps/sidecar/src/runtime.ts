import { serve } from "@hono/node-server";
import { createServer, type Server } from "node:http";
import type { Hono } from "hono";
import type { SidecarConfig } from "./config";
import { createContainer, type Container } from "./container";
import { createApp } from "./http/app";
import { applyProxy, resolveProxy } from "./proxy";

export interface SidecarRuntime {
  container: Container;
  port: number;
  close: () => Promise<void>;
}

/** 桌面端与 CLI 共用的生命周期，不在导入模块时启动服务或注册进程信号。 */
export async function startSidecar(
  config: SidecarConfig,
  options: {
    configureApp?: (app: Hono, container: Container) => void;
    schedule?: boolean;
    webRoot?: string;
  } = {},
): Promise<SidecarRuntime> {
  const container = await createContainer(config);
  let server: Server | undefined;
  try {
    applyProxy(resolveProxy(container.settings.get().proxy));
    const app = createApp(container, { webRoot: options.webRoot });
    options.configureApp?.(app, container);
    const port = await new Promise<number>((resolve, reject) => {
      server = serve(
        { createServer, fetch: app.fetch, hostname: config.host, port: config.port },
        (info) => resolve(info.port),
      ) as Server;
      server.once("error", reject);
    });
    if (options.schedule !== false) container.scheduler.start();
    let closing: Promise<void> | undefined;
    return {
      container,
      port,
      close: () =>
        (closing ??= (async () => {
          container.scheduler.stop();
          try {
            await new Promise<void>((resolve, reject) => {
              if (!server) return resolve();
              const timer = setTimeout(() => server?.closeAllConnections(), 3_000);
              timer.unref();
              server.close((error) => {
                clearTimeout(timer);
                if (error) reject(error);
                else resolve();
              });
              server.closeIdleConnections();
            });
          } finally {
            await container.dispose();
          }
        })()),
    };
  } catch (error) {
    server?.close();
    await container.dispose();
    throw error;
  }
}
