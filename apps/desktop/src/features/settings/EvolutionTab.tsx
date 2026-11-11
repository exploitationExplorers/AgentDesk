import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FlaskConical, History, Plus, RotateCcw, Sparkles } from "lucide-react";
import { useState } from "react";
import type {
  BehaviorVersion,
  EvaluationRun,
  EvolutionEvidence,
  EvolutionProposal,
} from "@agentdesk/shared";
import { Badge, Button, Card, EmptyState, Field, Input, Spinner, Textarea } from "@agentdesk/ui";
import { api } from "../../lib/api";

const STATUS_LABEL = {
  draft: "待评测",
  evaluated: "已评测",
  published: "已发布",
  rejected: "已拒绝",
} as const;
const ACTION_KEY = ["evolution-action"];

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function VersionInstructions({
  text,
  empty = "使用内置指导，没有附加规则。",
}: {
  text: string;
  empty?: string;
}) {
  return (
    <p className="whitespace-pre-wrap break-words text-xs leading-7 text-muted">{text || empty}</p>
  );
}

export function EvolutionTab() {
  const client = useQueryClient();
  const overview = useQuery({ queryKey: ["evolution"], queryFn: api.evolution });
  const [section, setSection] = useState<"proposals" | "evaluations" | "versions">("proposals");
  const [creating, setCreating] = useState(false);
  const data = overview.data;
  const refresh = () => client.invalidateQueries({ queryKey: ["evolution"] });

  return (
    <div className="grid min-w-0 max-w-5xl gap-5">
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
          <div>
            <h3 className="text-sm font-semibold">用评测决定改进是否生效</h3>
            <p className="mt-2 text-xs leading-7 text-muted">
              从真实失败中整理候选指导，在隔离环境与当前版本比较，再审核发布。候选不会自动改变运行中的任务，也不能修改工具权限和评分规则。
            </p>
          </div>
        </div>
        <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-xs leading-6 text-subtle">
          记忆回归只检查本地记忆行为，不证明提示词更好。Agent
          沙箱评测会调用配置的模型并产生费用，工具只操作合成测试环境。
        </p>
      </Card>
      {overview.isPending ? (
        <div className="flex items-center gap-2 py-8 text-xs text-muted">
          <Spinner />
          正在加载实验与版本…
        </div>
      ) : null}
      {overview.isError ? (
        <Card className="p-4">
          <p role="alert" className="text-xs text-danger">
            加载失败：{overview.error.message}
          </p>
          <Button className="mt-3" size="sm" onClick={() => void overview.refetch()}>
            重试
          </Button>
        </Card>
      ) : null}
      {data ? (
        <>
          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[11px] text-subtle">当前生效版本</p>
                <h3 className="mt-1 text-sm font-semibold">{data.activeVersion.title}</h3>
              </div>
              <Badge tone="success">
                <CheckCircle2 className="h-3 w-3" />
                已生效
              </Badge>
            </div>
            <p className="mt-2 break-all font-mono text-[10px] text-subtle">
              {data.activeVersion.id} · {formatTime(data.activeVersion.createdAt)}
            </p>
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-brand">查看当前指导</summary>
              <div className="mt-2 rounded-xl border border-border bg-surface-2 p-3">
                <VersionInstructions text={data.activeVersion.instructions} />
              </div>
            </details>
          </Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2" role="group" aria-label="进化记录分类">
              {(
                [
                  ["proposals", `改进候选 ${data.proposals.length}`],
                  ["evaluations", `评测记录 ${data.evaluations.length}`],
                  ["versions", `版本历史 ${data.versions.length}`],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  size="sm"
                  variant={section === value ? "primary" : "ghost"}
                  aria-pressed={section === value}
                  onClick={() => setSection(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCreating(!creating);
                setSection("proposals");
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              提出改进
            </Button>
          </div>
          {section === "proposals" ? (
            <>
              {creating ? (
                <ProposalComposer
                  evidence={data.evidence}
                  onSaved={() => {
                    setCreating(false);
                    void refresh();
                  }}
                  onCancel={() => setCreating(false)}
                />
              ) : null}
              <EvidenceCandidates evidence={data.evidence} onSaved={() => void refresh()} />
              {data.proposals.length === 0 ? (
                <EmptyState
                  icon={<Sparkles className="h-6 w-6" />}
                  title="还没有改进候选"
                  description="先根据真实失败提出一个可比较的改动，评测通过后再决定是否发布。"
                />
              ) : (
                data.proposals.map((proposal) => (
                  <ProposalCard
                    key={proposal.id}
                    proposal={proposal}
                    activeVersion={data.activeVersion}
                    evaluations={data.evaluations.filter((run) => run.candidate.id === proposal.id)}
                    onChanged={() => void refresh()}
                  />
                ))
              )}
            </>
          ) : null}
          {section === "evaluations" ? (
            data.evaluations.length === 0 ? (
              <EmptyState
                icon={<FlaskConical className="h-6 w-6" />}
                title="还没有评测记录"
                description="在候选卡片中运行本地记忆回归，或确认后启动 Agent 沙箱评测。"
              />
            ) : (
              data.evaluations.map((run) => <EvaluationCard key={run.id} run={run} />)
            )
          ) : null}
          {section === "versions" ? (
            <VersionHistory
              versions={data.versions}
              active={data.activeVersion}
              onChanged={() => void refresh()}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ProposalComposer({
  evidence,
  onSaved,
  onCancel,
}: {
  evidence: EvolutionEvidence[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const busy = useIsMutating({ mutationKey: ACTION_KEY }) > 0;
  const create = useMutation({
    mutationKey: ACTION_KEY,
    mutationFn: () =>
      api.createEvolutionProposal({
        title: title.trim(),
        instructions: instructions.trim(),
        evidenceRunIds: evidenceIds,
      }),
    onSuccess: onSaved,
  });
  return (
    <Card className="grid gap-4 p-5">
      <h3 className="text-sm font-semibold">提出一项具体改进</h3>
      <Field label="标题">
        <Input
          aria-label="候选标题"
          value={title}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="例如：修复后先验证工具返回结果"
        />
      </Field>
      <Field
        label="候选指导"
        hint="这是对当前附加指导的完整替换。描述可验证的行为，不要粘贴凭据或试图扩大工具权限。"
      >
        <Textarea
          aria-label="候选指导"
          value={instructions}
          maxLength={4000}
          onChange={(event) => setInstructions(event.target.value)}
          rows={5}
          placeholder="说明何时采取什么行动，以及用什么结果验证完成。"
        />
      </Field>
      {evidence.length > 0 ? (
        <EvidencePicker evidence={evidence} selected={evidenceIds} onChange={setEvidenceIds} />
      ) : null}
      <div className="flex gap-2">
        <Button
          variant="primary"
          loading={create.isPending}
          disabled={busy || !title.trim() || instructions.trim().length < 4}
          onClick={() => create.mutate()}
        >
          保存候选
        </Button>
        <Button variant="ghost" disabled={create.isPending} onClick={onCancel}>
          取消
        </Button>
      </div>
      {create.isError ? (
        <p role="alert" className="text-xs text-danger">
          {create.error.message}
        </p>
      ) : null}
    </Card>
  );
}

function EvidencePicker({
  evidence,
  selected,
  onChange,
}: {
  evidence: EvolutionEvidence[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="min-w-0 rounded-xl border border-border p-3">
      <legend className="px-1 text-xs font-medium text-muted">关联失败证据（最多 5 条）</legend>
      <div className="grid max-h-60 gap-2 overflow-y-auto">
        {evidence.map((item) => (
          <label
            key={item.runId}
            className="flex items-start gap-2 rounded-lg p-2 hover:bg-surface-2"
          >
            <input
              type="checkbox"
              className="mt-1 accent-brand"
              checked={selected.includes(item.runId)}
              disabled={!selected.includes(item.runId) && selected.length >= 5}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, item.runId]
                    : selected.filter((id) => id !== item.runId),
                )
              }
            />
            <span className="min-w-0">
              <span className="block break-words text-xs leading-6">
                {item.summary || "运行失败"}
              </span>
              <span className="block break-all font-mono text-[10px] text-subtle">
                {item.runId} · {item.status}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function EvidenceCandidates({
  evidence,
  onSaved,
}: {
  evidence: EvolutionEvidence[];
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [runId, setRunId] = useState("");
  const [note, setNote] = useState("");
  const busy = useIsMutating({ mutationKey: ACTION_KEY }) > 0;
  const generate = useMutation({
    mutationKey: ACTION_KEY,
    mutationFn: () => api.generateEvolutionProposal(selected),
    onSuccess: () => {
      setSelected([]);
      setConsent(false);
      onSaved();
    },
  });
  const feedback = useMutation({
    mutationKey: ACTION_KEY,
    mutationFn: () => api.evolutionFeedback(runId.trim(), "unhelpful", note.trim()),
    onSuccess: () => {
      setFeedbackOpen(false);
      setRunId("");
      setNote("");
      onSaved();
    },
  });
  return (
    <Card className="p-5">
      <details>
        <summary className="cursor-pointer text-[13px] font-medium">
          从真实失败生成候选{" "}
          <span className="ml-2 text-xs font-normal text-subtle">{evidence.length} 条可用证据</span>
        </summary>
        <div className="mt-4 grid gap-4">
          <p className="text-xs leading-6 text-muted">
            只使用已记录失败或被标为无帮助的运行。选择证据后，模型将根据脱敏摘要提出附加指导；它不会直接发布改动。
          </p>
          {evidence.length > 0 ? (
            <EvidencePicker evidence={evidence} selected={selected} onChange={setSelected} />
          ) : (
            <p className="text-xs text-subtle">
              暂无失败证据。可以为一条已完成运行记录反馈，再生成候选。
            </p>
          )}
          <label className="flex items-start gap-2 text-xs leading-6 text-muted">
            <input
              type="checkbox"
              className="mt-1 accent-brand"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            允许将所选运行的脱敏摘要发送给当前模型生成候选，并承担模型调用费用。
          </label>
          <div>
            <Button
              variant="primary"
              loading={generate.isPending}
              disabled={busy || !consent || selected.length === 0}
              onClick={() => generate.mutate()}
            >
              <Sparkles className="h-3.5 w-3.5" />
              生成候选
            </Button>
          </div>
          {generate.isError ? (
            <p role="alert" className="text-xs text-danger">
              {generate.error.message}
            </p>
          ) : null}
        </div>
      </details>
      <div className="mt-4 border-t border-border/60 pt-3">
        <Button size="sm" variant="ghost" onClick={() => setFeedbackOpen(!feedbackOpen)}>
          记录运行反馈
        </Button>
        {feedbackOpen ? (
          <div className="mt-3 grid gap-3">
            <Field label="运行 ID">
              <Input
                aria-label="反馈运行 ID"
                value={runId}
                maxLength={128}
                onChange={(event) => setRunId(event.target.value)}
                placeholder="从任务运行记录复制 ID"
              />
            </Field>
            <Field label="哪里没有帮助" hint="只描述问题，不包含密钥、密码或其他敏感正文。">
              <Textarea
                aria-label="运行反馈说明"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={1000}
                rows={2}
              />
            </Field>
            <div>
              <Button
                size="sm"
                disabled={busy || !runId.trim()}
                loading={feedback.isPending}
                onClick={() => feedback.mutate()}
              >
                记录为无帮助
              </Button>
            </div>
            {feedback.isError ? (
              <p role="alert" className="text-xs text-danger">
                {feedback.error.message}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function ProposalCard({
  proposal,
  activeVersion,
  evaluations,
  onChanged,
}: {
  proposal: EvolutionProposal;
  activeVersion: BehaviorVersion;
  evaluations: EvaluationRun[];
  onChanged: () => void;
}) {
  const [review, setReview] = useState<"agent" | "publish" | null>(null);
  const [allowModel, setAllowModel] = useState(false);
  const busy = useIsMutating({ mutationKey: ACTION_KEY }) > 0;
  const evaluation = evaluations.find((run) => run.id === proposal.evaluationId) ?? evaluations[0];
  const currentBase = proposal.baseVersionId === activeVersion.id;
  const releaseReady =
    currentBase && evaluation?.eligibleForRelease && evaluation.baseline.id === activeVersion.id;
  const editable = proposal.status === "draft" || proposal.status === "evaluated";
  const action = useMutation({
    mutationKey: ACTION_KEY,
    mutationFn: async (kind: "memory" | "agent" | "publish" | "reject") => {
      if (kind === "publish") {
        if (!evaluation) throw new Error("请先完成评测");
        await api.publishEvolutionProposal(proposal.id, evaluation.id);
      } else if (kind === "reject") await api.rejectEvolutionProposal(proposal.id);
      else await api.evaluateEvolutionProposal(proposal.id, kind);
    },
    onSuccess: () => {
      setReview(null);
      setAllowModel(false);
      onChanged();
    },
  });
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold">{proposal.title}</h3>
          <p className="mt-1 text-[11px] text-subtle">
            {formatTime(proposal.createdAt)} · {proposal.evidenceRunIds.length} 条来源证据
          </p>
        </div>
        <Badge
          tone={
            proposal.status === "published"
              ? "success"
              : proposal.status === "rejected"
                ? "neutral"
                : "brand"
          }
        >
          {STATUS_LABEL[proposal.status]}
        </Badge>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-border bg-surface-2 p-3">
          <p className="mb-2 text-[11px] font-medium text-subtle">当前生效指导</p>
          <VersionInstructions text={activeVersion.instructions} />
        </div>
        <div className="rounded-xl border border-brand/30 bg-brand/5 p-3">
          <p className="mb-2 text-[11px] font-medium text-brand">候选完整指导</p>
          <VersionInstructions text={proposal.instructions} />
        </div>
      </div>
      {!currentBase && editable ? (
        <p className="mt-3 text-xs leading-6 text-warning">
          当前版本已改变，此候选基于旧版本，不能直接发布。请基于最新版本重新提出候选。
        </p>
      ) : null}
      {editable ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !currentBase}
            loading={action.isPending && action.variables === "memory"}
            onClick={() => action.mutate("memory")}
          >
            本地记忆回归
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !currentBase}
            loading={action.isPending && action.variables === "agent"}
            onClick={() => {
              action.reset();
              setReview("agent");
              setAllowModel(false);
            }}
          >
            Agent 沙箱评测…
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !releaseReady}
            onClick={() => {
              action.reset();
              setReview("publish");
            }}
          >
            审核发布…
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => action.mutate("reject")}>
            拒绝候选
          </Button>
        </div>
      ) : null}
      {action.isPending ? (
        <p role="status" className="mt-3 text-xs leading-6 text-muted">
          {action.variables === "agent"
            ? "正在逐案例比较当前版本与候选，可能需要几分钟。不会操作真实项目。"
            : "正在处理…"}
        </p>
      ) : null}
      {review === "agent" ? (
        <div className="mt-4 rounded-xl border border-border bg-surface-2 p-4">
          <h4 className="text-xs font-semibold">启动 Agent 沙箱评测</h4>
          <p className="mt-2 text-xs leading-6 text-muted">
            基线和候选使用独立测试状态。合成任务会发送给当前配置模型，产生 token
            费用；工具返回只来自测试 fixtures，不执行真实命令或部署。
          </p>
          <label className="mt-3 flex items-start gap-2 text-xs leading-6">
            <input
              type="checkbox"
              className="mt-1 accent-brand"
              checked={allowModel}
              disabled={action.isPending}
              onChange={(event) => setAllowModel(event.target.checked)}
            />
            允许本次评测调用模型并产生费用。
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={action.isPending}
              disabled={busy || !allowModel}
              onClick={() => action.mutate("agent")}
            >
              确认开始评测
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={action.isPending}
              onClick={() => setReview(null)}
            >
              取消
            </Button>
          </div>
        </div>
      ) : null}
      {review === "publish" ? (
        <div className="mt-4 rounded-xl border border-brand/30 bg-brand/5 p-4">
          <h4 className="text-xs font-semibold">将候选发布为新的附加指导</h4>
          <p className="mt-2 text-xs leading-6 text-muted">
            请核对上方差异和下方评测结果。发布会影响后续本地聊天与任务，正在执行的运行保持原版本。工具权限不会随指导扩大；版本历史中可以回退。
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !releaseReady}
              loading={action.isPending}
              onClick={() => action.mutate("publish")}
            >
              确认发布新版本
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={action.isPending}
              onClick={() => setReview(null)}
            >
              取消
            </Button>
          </div>
        </div>
      ) : null}
      {action.isError ? (
        <p role="alert" className="mt-3 text-xs text-danger">
          {action.error.message}
        </p>
      ) : null}
      {evaluation ? (
        <div className="mt-4">
          <EvaluationCard run={evaluation} nested />
        </div>
      ) : (
        <p className="mt-3 text-xs text-subtle">
          尚未评测。发布需要完整 Agent 评测通过，并且相对基线有改善、无退化。
        </p>
      )}
    </Card>
  );
}

function EvaluationCard({ run, nested = false }: { run: EvaluationRun; nested?: boolean }) {
  const tokens = run.cases.reduce(
    (total, item) =>
      total +
      item.baseline.inputTokens +
      item.baseline.outputTokens +
      item.candidate.inputTokens +
      item.candidate.outputTokens,
    0,
  );
  const knownCost =
    run.cases.length > 0 &&
    run.cases.every((item) => item.baseline.costUsd !== null && item.candidate.costUsd !== null);
  const cost = knownCost
    ? run.cases.reduce(
        (total, item) => total + (item.baseline.costUsd ?? 0) + (item.candidate.costUsd ?? 0),
        0,
      )
    : null;
  const content = (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-[13px] font-semibold">
            {run.mode === "memory" ? "本地记忆回归" : "Agent 沙箱评测"}
          </h4>
          <p className="mt-1 text-[11px] text-subtle">
            {formatTime(run.createdAt)} · {run.cases.length}/{run.expectedCaseCount} 个案例 ·{" "}
            {run.fullSuite ? "完整集" : "部分集"}
          </p>
        </div>
        <Badge
          tone={
            run.eligibleForRelease ? "success" : run.status === "completed" ? "warning" : "danger"
          }
        >
          {run.eligibleForRelease
            ? "满足发布门槛"
            : run.status === "completed"
              ? "未满足发布门槛"
              : run.status === "cancelled"
                ? "已取消"
                : "评测失败"}
        </Badge>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["基线通过", `${run.baselinePassed}/${run.expectedCaseCount}`],
          ["候选通过", `${run.candidatePassed}/${run.expectedCaseCount}`],
          ["改善 / 退化", `${run.wins} / ${run.regressions}`],
          ["关键失败", String(run.criticalFailures)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl bg-surface-2 px-3 py-2">
            <p className="text-[10px] text-subtle">{label}</p>
            <p className="mt-1 font-mono text-sm">{value}</p>
          </div>
        ))}
      </div>
      {run.gateReasons.length > 0 ? (
        <ul className="mt-3 list-disc space-y-1 pl-4 text-xs leading-6 text-muted">
          {run.gateReasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 break-words text-[11px] leading-6 text-subtle">
        {run.model ?? "不调用模型"} · 调用 {run.modelCalls}/{run.maxModelCalls} 次 ·{" "}
        {tokens.toLocaleString()} tokens · {cost === null ? "费用未知" : `$${cost.toFixed(4)}`}
      </p>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-brand">查看逐案例结果与验证依据</summary>
        <div className="mt-3 grid gap-2">
          {run.cases.map((item) => (
            <details key={item.id} className="rounded-xl border border-border p-3">
              <summary className="cursor-pointer break-words text-xs leading-6">
                <span className={item.candidate.passed ? "text-success" : "text-danger"}>
                  {item.candidate.passed ? "通过" : "未通过"}
                </span>{" "}
                · {item.title}
                {item.critical ? " · 关键案例" : ""}
                <span className="ml-2 text-subtle">
                  基线{item.baseline.passed ? "通过" : "未通过"}
                </span>
              </summary>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {(
                  [
                    ["基线", item.baseline],
                    ["候选", item.candidate],
                  ] as const
                ).map(([name, attempt]) => (
                  <div key={name} className="min-w-0 rounded-lg bg-surface-2 p-3">
                    <h5 className="text-xs font-medium">{name}</h5>
                    <ul className="mt-2 grid gap-1 text-[11px] leading-6">
                      {attempt.checks.map((check, index) => (
                        <li key={index} className="break-words">
                          <span className={check.passed ? "text-success" : "text-danger"}>
                            {check.passed ? "✓" : "✕"}
                          </span>{" "}
                          {check.name}：{check.detail}
                        </li>
                      ))}
                    </ul>
                    {attempt.error ? (
                      <p className="mt-2 break-words text-xs text-danger">{attempt.error}</p>
                    ) : null}
                    {attempt.tools.length > 0 ? (
                      <p className="mt-2 break-words text-[11px] text-subtle">
                        工具：{attempt.tools.join(" → ")}
                      </p>
                    ) : null}
                    {attempt.output ? (
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-6 text-muted">
                        {attempt.output}
                      </pre>
                    ) : null}
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
        <p className="mt-3 break-all font-mono text-[10px] leading-6 text-subtle">
          dataset {run.datasetId}@{run.datasetVersion}
          <br />
          grader {run.graderVersion}
          <br />
          baseline {run.baselineHash}
          <br />
          candidate {run.candidateHash}
          <br />
          {run.environment}
        </p>
      </details>
    </>
  );
  return nested ? (
    <div className="rounded-xl border border-border p-4">{content}</div>
  ) : (
    <Card className="p-5">{content}</Card>
  );
}

function VersionHistory({
  versions,
  active,
  onChanged,
}: {
  versions: BehaviorVersion[];
  active: BehaviorVersion;
  onChanged: () => void;
}) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const busy = useIsMutating({ mutationKey: ACTION_KEY }) > 0;
  const rollback = useMutation({
    mutationKey: ACTION_KEY,
    mutationFn: api.rollbackEvolution,
    onSuccess: () => {
      setTargetId(null);
      onChanged();
    },
  });
  return (
    <div className="grid gap-3">
      {versions.map((version) => (
        <Card key={version.id} className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-muted" />
              <h3 className="text-[13px] font-semibold">{version.title}</h3>
              {version.id === active.id ? <Badge tone="success">当前生效</Badge> : null}
            </div>
            {version.id !== active.id ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  rollback.reset();
                  setTargetId(version.id);
                }}
              >
                <RotateCcw className="h-3 w-3" />
                回退到此版本…
              </Button>
            ) : null}
          </div>
          <p className="mt-2 break-all font-mono text-[10px] text-subtle">
            {version.id} · {formatTime(version.createdAt)}
          </p>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-brand">查看指导内容</summary>
            <div className="mt-2 rounded-xl bg-surface-2 p-3">
              <VersionInstructions text={version.instructions} />
            </div>
          </details>
          {targetId === version.id ? (
            <div className="mt-4 rounded-xl border border-border bg-surface-2 p-4">
              <p className="text-xs leading-6">
                确认恢复“{version.title}
                ”？后续本地运行将使用此版本，正在运行的任务和业务数据保持当前状态。
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  loading={rollback.isPending}
                  onClick={() => rollback.mutate(version.id)}
                >
                  确认回退
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={rollback.isPending}
                  onClick={() => setTargetId(null)}
                >
                  取消
                </Button>
              </div>
              {rollback.isError ? (
                <p role="alert" className="mt-2 text-xs text-danger">
                  {rollback.error.message}
                </p>
              ) : null}
            </div>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
