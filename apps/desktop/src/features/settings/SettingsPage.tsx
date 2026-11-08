import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Brain,
  Bot,
  GitBranch,
  KeyRound,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  Badge,
  Card,
  PageHeader,
  PageSurface,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  motion,
  softSpring,
  useReducedMotion,
} from "@agentdesk/ui";
import { api } from "../../lib/api";
import { settingsRoute } from "../../router";
import { BindingsTab } from "./BindingsTab";
import { GeneralTab } from "./GeneralTab";
import { GitAccountsTab } from "./GitAccountsTab";
import { MemoryTab } from "./MemoryTab";
import { ProvidersTab } from "./ProvidersTab";
import { ReachTab } from "./ReachTab";
import "./settings.css";

const SECTIONS = [
  {
    value: "providers",
    label: "模型 Provider",
    icon: KeyRound,
    description: "管理可用的模型服务和连接方式。",
    component: ProvidersTab,
  },
  {
    value: "bindings",
    label: "Agent 模型",
    icon: Bot,
    description: "为不同 Agent 选择模型与备用服务。",
    component: BindingsTab,
  },
  {
    value: "git",
    label: "Git 平台",
    icon: GitBranch,
    description: "连接代码托管平台，统一管理项目访问。",
    component: GitAccountsTab,
  },
  {
    value: "reach",
    label: "跨平台检索",
    icon: Search,
    description: "配置搜索来源与平台连接。",
    component: ReachTab,
  },
  {
    value: "general",
    label: "通用",
    icon: SlidersHorizontal,
    description: "调整外观、工作目录和应用偏好。",
    component: GeneralTab,
  },
  {
    value: "skills",
    label: "技能",
    icon: Sparkles,
    description: "查看 Agent 可按需使用的专业技能。",
    component: SkillsTab,
  },
  {
    value: "memory",
    label: "记忆",
    icon: Brain,
    description: "管理 Agent 保留的信息与长期偏好。",
    component: MemoryTab,
  },
] as const;

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
  const selected = SECTIONS.find((section) => section.value === tab) ?? SECTIONS[0];
  const id = useId();
  const reduced = useReducedMotion();
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return (
    <PageSurface>
      <PageHeader
        icon={<Settings className="h-5 w-5" />}
        title="设置"
        description="配置你的 Agent 工作环境。"
      />
      <Tabs
        value={selected.value}
        onValueChange={(v) => void navigate({ to: "/settings", search: { tab: v } })}
        className="settings-layout"
        orientation={narrow ? "horizontal" : "vertical"}
        activationMode="manual"
      >
        <TabsList className="settings-nav" aria-label="设置分类">
          {SECTIONS.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} className="settings-nav-item">
              {selected.value === value ? (
                <motion.span
                  layoutId={reduced ? undefined : `settings-selection-${id}`}
                  transition={reduced ? { duration: 0 } : softSpring}
                  className="settings-nav-selection"
                />
              ) : null}
              <Icon className="h-4 w-4 shrink-0" />
              <span>{label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="min-w-0">
          {SECTIONS.map(({ value, label, description, component: Content }) => (
            <TabsContent key={value} value={value} className="ad-tab-content pt-0">
              <div className="mb-6 border-b border-border/60 pb-5">
                <h2 className="text-lg font-semibold tracking-tight">{label}</h2>
                <p className="mt-1.5 text-xs leading-6 text-muted">{description}</p>
              </div>
              <Content />
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </PageSurface>
  );
}
