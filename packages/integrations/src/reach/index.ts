import { ReachRegistry } from "./registry";
import { githubChannel } from "./channels/github";
import { v2exChannel } from "./channels/v2ex";
import { webChannel } from "./channels/web";

export * from "./types";
export * from "./registry";

/**
 * 内置渠道。以后接外部 CLI 或别的运行时，只要再 register 一个
 * ReachChannelDef 即可，上层工具和结果协议都不用改。
 */
export function createDefaultReachRegistry(): ReachRegistry {
  return new ReachRegistry().register(webChannel).register(githubChannel).register(v2exChannel);
}
