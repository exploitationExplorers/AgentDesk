import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2, Wand2 } from "lucide-react";
import { useState } from "react";
import { describeStep, type DeployRecipe, type RecipeStep } from "@agentdesk/shared";
import { Button, Card, Dialog, Field, Input, Select, Textarea } from "@agentdesk/ui";
import { api, type RecipePreset } from "../../lib/api";
import { STEP_FIELDS, STEP_TYPES, defaultStep } from "./steps";

function StepEditor({
  step,
  onChange,
}: {
  step: RecipeStep;
  onChange: (step: RecipeStep) => void;
}) {
  const values = step as unknown as Record<string, unknown>;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {STEP_FIELDS[step.type].map((f) => {
        const value = values[f.key] === undefined ? "" : String(values[f.key]);
        const update = (raw: string) => {
          const next = {
            ...values,
            [f.key]:
              f.kind === "number" ? (raw === "" ? undefined : Number(raw)) : raw || undefined,
          };
          onChange(next as unknown as RecipeStep);
        };
        return (
          <Field
            key={f.key}
            label={f.label}
            className={f.kind === "textarea" ? "sm:col-span-2" : undefined}
          >
            {f.kind === "select" ? (
              <Select value={value} onChange={(e) => update(e.target.value)}>
                {f.options?.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </Select>
            ) : f.kind === "textarea" ? (
              <Textarea
                value={value}
                onChange={(e) => update(e.target.value)}
                className="font-mono text-[12px]"
              />
            ) : (
              <Input
                type={f.kind === "number" ? "number" : "text"}
                value={value}
                onChange={(e) => update(e.target.value)}
              />
            )}
          </Field>
        );
      })}
      <Field label="步骤名称（可选）" className="sm:col-span-2">
        <Input
          value={"label" in step && step.label ? step.label : ""}
          onChange={(e) => onChange({ ...step, label: e.target.value || undefined } as RecipeStep)}
        />
      </Field>
    </div>
  );
}

function PresetBuilder({ onSteps }: { onSteps: (steps: RecipeStep[]) => void }) {
  const presets = useQuery({ queryKey: ["recipe-presets"], queryFn: api.recipePresets });
  const [key, setKey] = useState<string>("");
  const [options, setOptions] = useState<RecipePreset["options"] | null>(null);
  const build = useMutation({ mutationFn: api.presetSteps, onSuccess: onSteps });

  const pick = (k: string) => {
    setKey(k);
    const preset = presets.data?.find((p) => p.key === k);
    setOptions(preset ? { ...preset.options } : null);
  };
  const set = (k: keyof RecipePreset["options"]) => (e: { target: { value: string } }) =>
    setOptions((o) => (o ? { ...o, [k]: e.target.value || undefined } : o));

  return (
    <Card className="bg-surface-2/50 p-4">
      <div className="mb-3 flex items-center gap-2 text-[13px] font-medium">
        <Wand2 className="h-4 w-4 text-brand" />
        从模板生成
        <Select value={key} onChange={(e) => pick(e.target.value)} className="ml-auto w-56">
          <option value="">选择模板…</option>
          {presets.data?.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </Select>
      </div>
      {options ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="服务器项目目录">
            <Input
              value={options.remoteDir}
              onChange={set("remoteDir")}
              placeholder="/www/wwwroot/im-server"
            />
          </Field>
          <Field label="分支">
            <Input value={options.branch ?? ""} onChange={set("branch")} placeholder="main" />
          </Field>
          <Field label="构建命令" className="sm:col-span-2">
            <Input
              value={options.buildCommand ?? ""}
              onChange={set("buildCommand")}
              className="font-mono text-[12px]"
            />
          </Field>
          <Field label="宝塔项目类型">
            <Select value={options.projectType} onChange={set("projectType")}>
              {["node", "java", "go", "python", "php"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
          <Field label="宝塔中的项目名">
            <Input value={options.projectName} onChange={set("projectName")} />
          </Field>
          <Field label="健康检查 URL（可选）" className="sm:col-span-2">
            <Input
              value={options.healthUrl ?? ""}
              onChange={set("healthUrl")}
              placeholder="http://1.2.3.4:8080/health"
            />
          </Field>
          <div className="sm:col-span-2">
            <Button
              size="sm"
              variant="brand"
              loading={build.isPending}
              onClick={() => build.mutate(options)}
            >
              生成步骤（覆盖当前）
            </Button>
            {build.error ? (
              <span className="ml-2 text-[12px] text-danger">{build.error.message}</span>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-[12px] text-muted">
          内置 IM（Java/Node）、Go 服务等后端部署模板：拉代码 → 构建 → 重启 → 健康检查。
        </p>
      )}
    </Card>
  );
}

export function RecipeDialog({
  recipe,
  onClose,
}: {
  recipe: DeployRecipe | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const servers = useQuery({ queryKey: ["servers"], queryFn: api.servers });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const [name, setName] = useState(recipe?.name ?? "");
  const [serverId, setServerId] = useState(recipe?.serverId ?? "");
  const [projectId, setProjectId] = useState(recipe?.projectId ?? "");
  const [description, setDescription] = useState(recipe?.description ?? "");
  const [steps, setSteps] = useState<RecipeStep[]>(recipe?.steps ?? [{ type: "login" }]);
  const [expanded, setExpanded] = useState<number | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.saveRecipe(
        { name, serverId, projectId: projectId || null, description, steps },
        recipe?.id,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["recipes"] });
      onClose();
    },
  });

  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    setSteps(next);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={recipe ? "编辑部署配方" : "新建部署配方"}
      className="w-[min(760px,94vw)]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!name || !serverId || steps.length === 0}
            onClick={() => save.mutate()}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="名称">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="IM 后端发布"
              autoFocus
            />
          </Field>
          <Field label="服务器">
            <Select value={serverId} onChange={(e) => setServerId(e.target.value)}>
              <option value="">选择服务器…</option>
              {servers.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="关联项目（可选）">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">无</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="说明">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        <PresetBuilder onSteps={setSteps} />

        <div>
          <div className="mb-2 flex items-center">
            <span className="text-[13px] font-medium">步骤（{steps.length}）</span>
            <Select
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                setSteps([...steps, defaultStep(e.target.value as RecipeStep["type"])]);
                setExpanded(steps.length);
              }}
              className="ml-auto w-40"
            >
              <option value="">+ 添加步骤</option>
              {STEP_TYPES.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            {steps.map((step, i) => (
              <div key={i} className="rounded-xl border bg-surface-2/40">
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-surface-2 text-[10.5px] text-muted">
                    {i + 1}
                  </span>
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-[12.5px]"
                    onClick={() => setExpanded(expanded === i ? null : i)}
                  >
                    <span className="mr-2 text-subtle">
                      {STEP_TYPES.find((t) => t.type === step.type)?.label}
                    </span>
                    {describeStep(step)}
                  </button>
                  <button
                    type="button"
                    aria-label="上移"
                    className="p-1 text-subtle hover:text-fg"
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="下移"
                    className="p-1 text-subtle hover:text-fg"
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="删除"
                    className="p-1 text-subtle hover:text-danger"
                    onClick={() => setSteps(steps.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {expanded === i ? (
                  <div className="border-t px-3 py-3">
                    <StepEditor
                      step={step}
                      onChange={(s) => setSteps(steps.map((x, j) => (j === i ? s : x)))}
                    />
                  </div>
                ) : null}
              </div>
            ))}
            {steps.length === 0 ? (
              <button
                type="button"
                className="flex items-center justify-center gap-1 rounded-xl border border-dashed py-4 text-[12.5px] text-muted"
                onClick={() => setSteps([{ type: "login" }])}
              >
                <Plus className="h-3.5 w-3.5" />
                添加第一步
              </button>
            ) : null}
          </div>
        </div>
        {save.error ? <p className="text-[12.5px] text-danger">{save.error.message}</p> : null}
      </div>
    </Dialog>
  );
}
