import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MessageCircle, RefreshCw, Sparkles, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  cn,
} from "@agentdesk/ui";
import { useApiUrl } from "../../hooks/useApiUrl";
import { api, type SkillInfo, type WechatReportJob } from "../../lib/api";
import { todayLocal } from "../../lib/format";
import { toast } from "../../lib/toast";

const RUNNABLE: Record<string, { title: string; blurb: string; icon: typeof MessageCircle }> = {
  "wechat-daily-report": {
    title: "微信群聊日报",
    blurb: "解密本机微信库 → 选群 → AI 摘要 → 生成手机长图报告",
    icon: MessageCircle,
  },
};

function statusTone(status: WechatReportJob["status"]) {
  if (status === "succeeded") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "queued") return "neutral" as const;
  return "info" as const;
}

function statusLabel(status: WechatReportJob["status"]) {
  const map: Record<WechatReportJob["status"], string> = {
    queued: "排队中",
    analyzing: "分析聊天",
    writing: "AI 写文案",
    rendering: "渲染长图",
    succeeded: "已完成",
    failed: "失败",
  };
  return map[status];
}

function WechatRunner({ onBack }: { onBack: () => void }) {
  const queryClient = useQueryClient();
  const [date, setDate] = useState(todayLocal());
  const [chatroom, setChatroom] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["wechat-status"],
    queryFn: api.wechatStatus,
    refetchInterval: 15_000,
  });
  const groups = useQuery({
    queryKey: ["wechat-groups"],
    queryFn: api.wechatGroups,
    enabled: !!status.data?.decryptedReady,
    retry: false,
  });
  const job = useQuery({
    queryKey: ["wechat-report", activeId],
    queryFn: () => api.wechatReport(activeId!),
    enabled: !!activeId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s && s !== "succeeded" && s !== "failed" ? 1200 : false;
    },
  });

  const imagePath =
    job.data?.status === "succeeded" && activeId
      ? `/skills/wechat/reports/${activeId}/image`
      : null;
  const imageUrl = useApiUrl(imagePath);

  const decrypt = useMutation({
    mutationFn: api.wechatDecrypt,
    onSuccess: () => {
      toast("解密完成", { tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["wechat-status"] });
      void queryClient.invalidateQueries({ queryKey: ["wechat-groups"] });
    },
    onError: (e: Error) => toast(e.message, { tone: "danger" }),
  });
  const generate = useMutation({
    mutationFn: () => api.startWechatReport({ chatroom, date }),
    onSuccess: (created) => {
      setActiveId(created.id);
      toast("已开始生成日报", { tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["wechat-report", created.id] });
    },
    onError: (e: Error) => toast(e.message, { tone: "danger" }),
  });

  const ready = status.data?.decryptedReady && status.data.pythonOk;
  const groupOptions = useMemo(
    () =>
      (groups.data ?? []).map((g) => ({
        value: g.displayName || g.username,
        label: `${g.displayName || g.username}（${g.messageCount} 条）`,
      })),
    [groups.data],
  );

  useEffect(() => {
    if (!chatroom && groupOptions[0]) setChatroom(groupOptions[0].value);
  }, [chatroom, groupOptions]);

  return (
    <div className="grid gap-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1.5 text-[13px] text-muted hover:text-fg"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        返回技能列表
      </button>

      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[15px] font-semibold">微信群聊日报</p>
            <p className="mt-1 text-[12.5px] text-muted">{status.data?.message ?? "检查环境中…"}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                void status.refetch();
                void groups.refetch();
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </Button>
            <Button
              variant="secondary"
              loading={decrypt.isPending}
              onClick={() => decrypt.mutate()}
              disabled={!status.data?.pythonOk}
            >
              解密微信数据库
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Badge tone={status.data?.pythonOk ? "success" : "danger"}>
            Python {status.data?.pythonOk ? "就绪" : "未就绪"}
          </Badge>
          <Badge tone={status.data?.decryptedReady ? "success" : "warning"}>
            解密库 {status.data?.decryptedReady ? "就绪" : "未解密"}
          </Badge>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-[1fr_180px_auto]">
          <Field label="群聊">
            {groups.isLoading ? (
              <Spinner />
            ) : groupOptions.length ? (
              <Select
                value={chatroom}
                onChange={(e) => setChatroom(e.target.value)}
                disabled={!ready}
              >
                {groupOptions.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="text-[12.5px] text-muted">
                {ready ? "没有找到群聊" : "解密后再选择群聊"}
              </p>
            )}
          </Field>
          <Field label="日期">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button
              variant="primary"
              className="w-full"
              loading={generate.isPending}
              disabled={!ready || !chatroom}
              onClick={() => generate.mutate()}
            >
              <Wand2 className="h-3.5 w-3.5" />
              生成日报长图
            </Button>
          </div>
        </div>
      </Card>

      {job.data ? (
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[14px] font-semibold">生成进度</p>
            <Badge tone={statusTone(job.data.status)}>{statusLabel(job.data.status)}</Badge>
            <span className="text-[12px] text-subtle">
              {job.data.chatroom} · {job.data.date}
            </span>
          </div>
          {job.data.status !== "succeeded" && job.data.status !== "failed" ? (
            <p className="mt-2 text-[12.5px] text-muted">
              还没完成：状态变成「已完成」后，日报长图会出现在下方。AI 写文案一般 1–2
              分钟；超时会显示失败原因。
            </p>
          ) : null}
          {job.data.error ? (
            <p className="mt-3 text-[12.5px] text-danger">{job.data.error}</p>
          ) : null}
          <ol className="mt-3 max-h-40 space-y-1 overflow-y-auto text-[12px] text-muted">
            {job.data.logs.map((line, i) => (
              <li key={`${i}-${line}`} className="truncate">
                {line}
              </li>
            ))}
          </ol>
          {imageUrl ? (
            <div className="mt-4 overflow-hidden rounded-xl border bg-surface-2/40">
              <img
                src={imageUrl}
                alt="微信群聊日报"
                className="mx-auto block max-h-[70vh] w-auto max-w-full"
              />
              <div className="border-t px-3 py-2 text-right">
                <a
                  href={imageUrl}
                  download={`wechat-report-${job.data.date}.png`}
                  className="text-[12.5px] text-brand hover:underline"
                >
                  下载 PNG
                </a>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

function SkillCard({ skill, onOpen }: { skill: SkillInfo; onOpen: () => void }) {
  const meta = RUNNABLE[skill.name];
  const Icon = meta?.icon ?? Sparkles;
  const runnable = !!meta;
  return (
    <Card
      className={cn(
        "flex flex-col p-4 transition-colors",
        runnable ? "hover:border-border-strong" : "opacity-80",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand/10 text-brand">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold">{meta?.title ?? skill.name}</p>
          <p className="mt-1 line-clamp-2 text-[12.5px] text-muted">
            {meta?.blurb ?? skill.description}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        <Badge>v{skill.version}</Badge>
        {skill.triggers.slice(0, 3).map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
      </div>
      <div className="mt-4">
        {runnable ? (
          <Button variant="primary" className="w-full" onClick={onOpen}>
            打开技能
          </Button>
        ) : (
          <p className="text-[12px] text-subtle">Bot 对话中可按触发词自动加载，暂无独立运行界面</p>
        )}
      </div>
    </Card>
  );
}

export function SkillsPage() {
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills });
  const [active, setActive] = useState<string | null>(null);

  if (active === "wechat-daily-report") {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-8">
          <WechatRunner onBack={() => setActive(null)} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <PageHeader
          icon={<Sparkles className="h-5 w-5" />}
          title="技能"
          description="可运行的技能包：选一个技能，按步骤生成结果。也支持在 Bot 里用自然语言触发。"
        />
        {skills.isLoading ? <Spinner /> : null}
        {skills.data?.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {skills.data.map((s) => (
              <SkillCard key={s.name} skill={s} onOpen={() => setActive(s.name)} />
            ))}
          </div>
        ) : skills.isFetched ? (
          <EmptyState
            icon={<Sparkles className="h-5 w-5" />}
            title="还没有技能"
            description="把 SKILL.md 放到数据目录的 skills 文件夹，或使用内置技能。"
          />
        ) : null}
      </div>
    </div>
  );
}
