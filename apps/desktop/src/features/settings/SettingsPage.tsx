import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Settings, Sparkles } from "lucide-react";
import { Badge, Card, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@agentdesk/ui";
import { api } from "../../lib/api";
import { settingsRoute } from "../../router";
import { BindingsTab } from "./BindingsTab";
import { GeneralTab } from "./GeneralTab";
import { GitAccountsTab } from "./GitAccountsTab";
import { MemoryTab } from "./MemoryTab";
import { ProvidersTab } from "./ProvidersTab";

function SkillsTab() {
  const { data = [] } = useQuery({ queryKey: ["skills"], queryFn: api.skills });
  return (
    <div className="grid gap-3">
      <p className="text-[13px] text-muted">
        技能采用 SKILL.md 格式，按需加载：系统提示只放目录，命中触发词或模型调用 skills.load
        时才注入完整指令。把自定义技能放到数据目录的 skills 文件夹即可。
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {data.map((s) => (
          <Card key={s.name} className="p-4">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-brand" />
              <span className="text-[13.5px] font-semibold">{s.name}</span>
              <Badge>v{s.version}</Badge>
            </div>
            <p className="mt-2 text-[12.5px] text-muted">{s.description}</p>
            <div className="mt-3 flex flex-wrap gap-1">
              {s.agents.map((a) => (
                <Badge key={a} tone="brand">
                  {a}
                </Badge>
              ))}
              {s.triggers.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { tab = "providers" } = settingsRoute.useSearch();
  const navigate = useNavigate();
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-8">
        <PageHeader
          icon={<Settings className="h-5 w-5" />}
          title="设置"
          description="模型、Git 平台、项目扫描、记忆与外观"
        />
        <Tabs
          value={tab}
          onValueChange={(v) => void navigate({ to: "/settings", search: { tab: v } })}
        >
          <TabsList>
            <TabsTrigger value="providers">模型 Provider</TabsTrigger>
            <TabsTrigger value="bindings">Agent 模型</TabsTrigger>
            <TabsTrigger value="git">Git 平台</TabsTrigger>
            <TabsTrigger value="general">通用</TabsTrigger>
            <TabsTrigger value="skills">技能</TabsTrigger>
            <TabsTrigger value="memory">记忆</TabsTrigger>
          </TabsList>
          <TabsContent value="providers">
            <ProvidersTab />
          </TabsContent>
          <TabsContent value="bindings">
            <BindingsTab />
          </TabsContent>
          <TabsContent value="git">
            <GitAccountsTab />
          </TabsContent>
          <TabsContent value="general">
            <GeneralTab />
          </TabsContent>
          <TabsContent value="skills">
            <SkillsTab />
          </TabsContent>
          <TabsContent value="memory">
            <MemoryTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
