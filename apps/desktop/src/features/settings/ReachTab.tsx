import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Badge, Button, Card } from "@agentdesk/ui";
import type { ReachRequestInput } from "@agentdesk/shared";
import { api } from "../../lib/api";
import { toast } from "../../lib/toast";

const checks: Record<string, ReachRequestInput> = {
  web: { channel: "web", action: "search", query: "AgentDesk", limit: 1 },
  github: { channel: "github", action: "search", query: "agentdesk", limit: 1 },
  v2ex: { channel: "v2ex", action: "hot", limit: 1 },
};
const actionLabels: Record<string, string> = {
  search: "搜索",
  read: "阅读",
  hot: "热门",
  node: "节点",
  user: "用户",
};

export function ReachTab() {
  const client = useQueryClient();
  const capabilities = useQuery({
    queryKey: ["reach", "capabilities"],
    queryFn: api.reachCapabilities,
  });
  const status = useQuery({
    queryKey: ["reach", "status"],
    queryFn: api.reachStatus,
    refetchInterval: 15_000,
  });
  const save = useMutation({
    mutationFn: api.updateReachSettings,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["reach"] });
    },
    onError: (error: Error) => toast(error.message, { tone: "danger" }),
  });
  const check = useMutation({
    mutationFn: api.runReach,
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ["reach", "status"] });
      toast(result.ok ? "连接检查成功" : (result.error?.message ?? "检查失败"), {
        tone: result.ok ? "success" : "danger",
      });
    },
    onError: (error: Error) => toast(error.message, { tone: "danger" }),
  });

  if (capabilities.isPending)
    return (
      <p className="text-sm text-muted" role="status">
        正在加载检索渠道…
      </p>
    );
  if (capabilities.isError)
    return (
      <div role="alert" className="grid gap-3">
        <p>加载失败：{capabilities.error.message}</p>
        <Button onClick={() => void capabilities.refetch()}>重试</Button>
      </div>
    );

  return (
    <div className="grid max-w-3xl gap-4">
      <Card className="p-5">
        <h3 className="text-[14px] font-semibold">让研究助手检索公开内容</h3>
        <p className="mt-2 text-[13px] leading-6 text-muted">
          在对话中让助手“搜索一个开源项目”或“看看 V2EX 热门”，即可使用已启用的渠道。
        </p>
        <p className="mt-2 text-[13px] leading-6 text-muted">
          Web 搜索会把查询词发送给 Exa。网页先在本地提取，失败时会把目标网址交给 Jina
          Reader。两者使用免费端点，可能受到额度和频率限制。请勿在查询词或网址中包含密钥、私密资料。
        </p>
      </Card>
      {status.isError && (
        <p role="alert" className="text-sm text-muted">
          最近调用状态暂时无法加载：{status.error.message}
        </p>
      )}
      {capabilities.data.channels.map((channel) => {
        const recent = status.data?.channels.find((entry) => entry.id === channel.id);
        return (
          <Card key={channel.id} className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h3 className="text-[14px] font-semibold">{channel.title}</h3>
                <Badge tone={channel.enabled ? "brand" : undefined}>
                  {channel.enabled ? "已启用" : "已关闭"}
                </Badge>
              </div>
              <Button
                variant="secondary"
                disabled={save.isPending}
                aria-label={`${channel.enabled ? "关闭" : "启用"}${channel.title}渠道`}
                onClick={() => {
                  const disabled = capabilities.data.channels
                    .filter((entry) => !entry.enabled)
                    .map((entry) => entry.id);
                  save.mutate({
                    disabledChannels: channel.enabled
                      ? [...disabled, channel.id]
                      : disabled.filter((id) => id !== channel.id),
                  });
                }}
              >
                {channel.enabled ? "关闭" : "启用"}
              </Button>
            </div>
            <p className="mt-2 text-[13px] text-muted">{channel.description}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {channel.actions.map((action) => (
                <Badge key={action}>{actionLabels[action] ?? action}</Badge>
              ))}
            </div>
            <p className="mt-3 text-[12px] text-muted">
              数据发送至：{channel.sendsDataTo.join("、") || "无外部服务"}
            </p>
            {channel.id === "github" && (
              <p className="mt-2 text-[12px] text-muted">
                复用{" "}
                <Link to="/settings" search={{ tab: "git" }} className="text-brand underline">
                  Git 平台设置
                </Link>{" "}
                中的 github.com 凭据；未配置时匿名访问，速率上限较低。仓库搜索不包含代码搜索，PR
                阅读不含 diff。
              </p>
            )}
            {channel.id === "v2ex" && (
              <p className="mt-2 text-[12px] text-muted">
                读取公开主题与回复，不支持全站关键词搜索。
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="text-[12px] text-muted" aria-live="polite">
                <p>{recent?.detail ?? "尚未检查，不代表已经验证可用"}</p>
                {recent?.lastCheckedAt && (
                  <p className="mt-1">
                    最近调用：{new Date(recent.lastCheckedAt).toLocaleString()}
                  </p>
                )}
              </div>
              {checks[channel.id] && (
                <Button
                  variant="secondary"
                  disabled={!channel.enabled || check.isPending}
                  loading={check.isPending && check.variables?.channel === channel.id}
                  onClick={() => check.mutate(checks[channel.id]!)}
                >
                  检查连接
                </Button>
              )}
            </div>
            {channel.id === "web" && (
              <p className="mt-2 text-[12px] text-subtle">
                检查连接会向 Exa 搜索“AgentDesk”；Jina 将在实际需要提取网页时使用。
              </p>
            )}
          </Card>
        );
      })}
    </div>
  );
}
