import { AppError, ErrorCode } from "@agentdesk/shared";
import type { GatewayConfig } from "../config";
import { RunnerClient } from "../remote/client";
import type { DeviceRelay } from "./relay";

class OfficeClient extends RunnerClient {
  constructor(
    private readonly hostId: string,
    private readonly relay: DeviceRelay,
    config: GatewayConfig,
  ) {
    super(config);
  }
  override forHost(hostId: string) {
    if (hostId !== this.hostId) throw new AppError(ErrorCode.NotFound, "设备身份不匹配");
    return this;
  }
  protected override epoch() {
    return this.relay.epoch(this.hostId);
  }
  override async request(
    path: string,
    body?: unknown,
    options: { method?: string; signal?: AbortSignal; stream?: boolean } = {},
  ) {
    const response = await this.relay.request(this.hostId, path, body, options);
    if (!response.ok) {
      let code: (typeof ErrorCode)[keyof typeof ErrorCode] = ErrorCode.ServiceUnavailable;
      try {
        const value = (await response.json()) as { error?: { code?: string } };
        if (Object.values(ErrorCode).includes(value.error?.code as typeof code))
          code = value.error!.code as typeof code;
      } catch {
        /* 不转发设备内部路径和错误详情。 */
      }
      throw new AppError(code, "电脑暂时无法完成此操作，请刷新核对状态");
    }
    return response;
  }
}

export class HostRunnerClient extends RunnerClient {
  private readonly offices = new Map<string, OfficeClient>();
  constructor(
    private readonly hostConfig: GatewayConfig,
    private readonly relay: DeviceRelay,
  ) {
    super(hostConfig);
  }
  override forHost(hostId: string): RunnerClient {
    if (hostId === "cloud") return this;
    // 数据库授权在 relay.request 中异步核验；此处只选择传输客户端。
    if (!/^office-[a-zA-Z0-9-]+$/.test(hostId))
      throw new AppError(ErrorCode.NotFound, "设备未配对或已撤销");
    let client = this.offices.get(hostId);
    if (!client) {
      client = new OfficeClient(hostId, this.relay, this.hostConfig);
      this.offices.set(hostId, client);
    }
    return client;
  }
  override request(
    path: string,
    body?: unknown,
    options: { method?: string; signal?: AbortSignal; stream?: boolean } = {},
  ) {
    const envelope = body as { hostId?: string; command?: { hostId?: string } } | undefined;
    const hostId = envelope?.command?.hostId ?? envelope?.hostId ?? "cloud";
    return hostId === "cloud"
      ? super.request(path, body, options)
      : this.forHost(hostId).request(path, body, options);
  }
}
