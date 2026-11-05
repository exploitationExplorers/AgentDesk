/** 普通对话只展示可采取行动的提示，原始错误保留在运行记录中。 */
export function runFailureMessage(error: string, cancelled = false): string {
  if (cancelled || /\babort(?:ed)?\b|已取消|已中止/i.test(error))
    return "任务已停止。已生成的成果会保留，你可以告诉我继续完成。";
  if (/timeout|timed out|超时/i.test(error))
    return "这次处理超时了。已生成的成果会保留，可以稍后继续。";
  if (/429|quota|rate.?limit|额度/i.test(error))
    return "当前模型服务额度不足或请求过于频繁，请稍后重试，或在设置中更换模型。";
  if (/没有可用的模型|未配置.*模型/i.test(error))
    return "还没有可用的模型，请先在设置中添加并启用模型。";
  if (/401|403|api.?key|unauthorized/i.test(error))
    return "暂时无法连接当前模型，请在设置中检查模型配置后重试。";
  if (/network|fetch failed|failed to fetch|连接|ECONN/i.test(error))
    return "连接暂时中断，请检查网络后重试。已生成的成果会保留。";
  return "这次任务未能完成。已生成的成果会保留，你可以重试或调整要求后继续。";
}

/** 兼容旧版本已经存入历史消息的内部执行清单，不修改原始记录。 */
export function chatMessageContent(content: string): string {
  return content.startsWith("出错了：") ? runFailureMessage(content.split("\n")[0]!) : content;
}
