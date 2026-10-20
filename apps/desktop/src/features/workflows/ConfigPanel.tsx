import { Plus, Trash2, X } from "lucide-react";
import { NODE_SPECS, type Workflow } from "@agentdesk/workflow/dsl";
import { Button, Field, Input, Segmented, Select, Textarea } from "@agentdesk/ui";
import type { FlowNode } from "./FlowNode";

export type WorkflowMeta = Pick<Workflow, "name" | "description" | "trigger" | "inputs">;

export function NodeConfigPanel({
  node,
  onChange,
  onDelete,
  onClose,
}: {
  node: FlowNode;
  onChange: (patch: Partial<FlowNode["data"]>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const spec = NODE_SPECS[node.data.kind];
  const setConfig = (key: string, value: unknown) =>
    onChange({ config: { ...node.data.config, [key]: value } });

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <p className="text-[13.5px] font-semibold">{spec.title}</p>
        <span className="font-mono text-[11px] text-subtle">{node.id}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded p-1 text-subtle hover:text-fg"
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <Field label="名称">
        <Input value={node.data.label} onChange={(e) => onChange({ label: e.target.value })} />
      </Field>
      {spec.fields.map((f) => {
        const raw = node.data.config[f.key];
        const value = raw === undefined ? "" : typeof raw === "string" ? raw : JSON.stringify(raw);
        return (
          <Field key={f.key} label={f.label}>
            {f.kind === "select" ? (
              <Select value={value} onChange={(e) => setConfig(f.key, e.target.value)}>
                <option value="">请选择</option>
                {f.options?.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </Select>
            ) : f.kind === "textarea" ? (
              <Textarea
                value={value}
                placeholder={f.placeholder}
                onChange={(e) => setConfig(f.key, e.target.value)}
                className="min-h-28 font-mono text-[12px]"
              />
            ) : (
              <Input
                type={f.kind === "number" ? "number" : "text"}
                value={value}
                placeholder={f.placeholder}
                onChange={(e) =>
                  setConfig(f.key, f.kind === "number" ? Number(e.target.value) : e.target.value)
                }
              />
            )}
          </Field>
        );
      })}
      <p className="rounded-lg bg-surface-2 px-3 py-2 text-[11.5px] leading-5 text-muted">
        可用变量：<code>{"{{inputs.名称}}"}</code>、<code>{"{{nodes.节点ID.output}}"}</code>
        {node.data.kind === "loop" ? (
          <>
            、循环中 <code>{"{{loop.item}}"}</code> / <code>{"{{loop.index}}"}</code>
          </>
        ) : null}
      </p>
      {node.data.kind !== "start" ? (
        <Button variant="danger" size="sm" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
          删除节点
        </Button>
      ) : null}
    </div>
  );
}

export function WorkflowMetaPanel({
  meta,
  onChange,
}: {
  meta: WorkflowMeta;
  onChange: (meta: WorkflowMeta) => void;
}) {
  return (
    <div className="grid gap-4">
      <p className="text-[13.5px] font-semibold">工作流设置</p>
      <Field label="描述">
        <Textarea
          value={meta.description}
          onChange={(e) => onChange({ ...meta, description: e.target.value })}
        />
      </Field>
      <Field label="触发方式">
        <Segmented
          value={meta.trigger.type}
          onChange={(type) =>
            onChange({ ...meta, trigger: type === "manual" ? { type } : { type, time: "09:00" } })
          }
          options={[
            { value: "manual", label: "手动 / Bot 调用" },
            { value: "schedule", label: "每天定时" },
          ]}
        />
      </Field>
      {meta.trigger.type === "schedule" ? (
        <Field label="执行时间">
          <Input
            type="time"
            value={meta.trigger.time}
            onChange={(e) =>
              onChange({ ...meta, trigger: { type: "schedule", time: e.target.value } })
            }
          />
        </Field>
      ) : null}
      <div>
        <div className="mb-2 flex items-center">
          <span className="text-[12px] font-medium text-muted">输入参数</span>
          <Button
            className="ml-auto"
            size="sm"
            variant="ghost"
            onClick={() =>
              onChange({
                ...meta,
                inputs: [
                  ...meta.inputs,
                  { name: `input${meta.inputs.length + 1}`, label: "", default: "" },
                ],
              })
            }
          >
            <Plus className="h-3.5 w-3.5" />
            添加
          </Button>
        </div>
        <div className="grid gap-2">
          {meta.inputs.map((input, i) => {
            const update = (patch: Partial<typeof input>) =>
              onChange({
                ...meta,
                inputs: meta.inputs.map((x, j) => (j === i ? { ...x, ...patch } : x)),
              });
            return (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
                <Input
                  value={input.name}
                  onChange={(e) => update({ name: e.target.value })}
                  placeholder="变量名"
                  className="font-mono text-[12px]"
                />
                <Input
                  value={input.label}
                  onChange={(e) => update({ label: e.target.value })}
                  placeholder="显示名"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    onChange({ ...meta, inputs: meta.inputs.filter((_, j) => j !== i) })
                  }
                  aria-label="删除"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
                <Input
                  value={input.default}
                  onChange={(e) => update({ default: e.target.value })}
                  placeholder="默认值"
                  className="col-span-3"
                />
              </div>
            );
          })}
          {meta.inputs.length === 0 ? (
            <p className="text-[12px] text-subtle">没有输入参数</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
