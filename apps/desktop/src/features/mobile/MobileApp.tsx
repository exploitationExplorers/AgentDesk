import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Cloud,
  Code2,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  Laptop,
  LogOut,
  Plus,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { OtpVerification } from "./leibox/otp-verification/OtpVerification";
import { BootScreen } from "./BootScreen";
import { CollabScene } from "./CollabScene";
import { LoginAtmosphere } from "./LoginAtmosphere";
import { ProjectCards } from "./ProjectCards";
import { TaskRows } from "./TaskRows";
import type {
  AgentModelBinding,
  RemoteApprovalDecision,
  RemoteTaskInput,
  RunEventRecord,
  Task,
} from "@agentdesk/shared";
import {
  CloudApi,
  CloudApiError,
  cloudPath,
  errorMessage,
  requestId,
  type CloudApproval,
  type CloudHost,
  type CloudProject,
  type CloudProvider,
  type CloudSession,
  type CloudTaskSnapshot,
  type CloudExecutor,
} from "../../lib/cloud-api";
import { Back, Button, Empty, Notice, Refresh, Status } from "./components";
import { TransfersView } from "./TransfersView";
import { ConnectorsView } from "./ConnectorsView";
import { ExecutorsView } from "./ExecutorsView";
import { RepositorySetupView } from "./RepositorySetupView";
import { GlassNavigation } from "./GlassNavigation";
import { displayTime, useCloudQuery, useOnline } from "./hooks";

type Page =
  | "workspace"
  | "tasks"
  | "approvals"
  | "settings"
  | "project"
  | "task"
  | "new-task"
  | "git"
  | "providers"
  | "connectors"
  | "executors"
  | "repository-setup"
  | "transfers";
type Collection<T> = { [key: string]: unknown } & {
  items?: T[];
  hosts?: T[];
  projects?: T[];
  tasks?: T[];
  approvals?: T[];
  providers?: T[];
  executors?: T[];
};
type JsonRecord = Record<string, unknown>;
const arr = <T,>(value: Collection<T> | undefined, key: keyof Collection<T>): T[] =>
  Array.isArray(value?.[key]) ? (value[key] as T[]) : [];
const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const api = new CloudApi();
const EMAIL_STORAGE_KEY = "agentdesk.cloud.email";
const readStoredEmail = () => {
  try {
    return localStorage.getItem(EMAIL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
};
const rememberEmail = (value: string) => {
  const normalized = value.trim().toLowerCase();
  try {
    if (normalized) localStorage.setItem(EMAIL_STORAGE_KEY, normalized);
    else localStorage.removeItem(EMAIL_STORAGE_KEY);
  } catch {
    /* private mode / quota */
  }
};

export function MobileApp() {
  const online = useOnline();
  const [session, setSession] = useState<CloudSession | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [hostId, setHostId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [page, setPage] = useState<Page>("workspace");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState(false);
  const eventAbort = useRef<AbortController | null>(null);
  const dataGeneration = useRef(0);
  const [taskEvents, setTaskEvents] = useState<RunEventRecord[]>([]);
  const [streamState, setStreamState] = useState<"connected" | "reconnecting" | null>(null);

  const clearIdentity = () => {
    dataGeneration.current++;
    api.clear();
    setSession(null);
    setHostId(null);
    setProjectId(null);
    setTaskId(null);
    setTaskEvents([]);
    setStreamState(null);
    eventAbort.current?.abort();
    setNotice("");
    setBusy(false);
    setPage("workspace");
  };
  api.onUnauthorized = clearIdentity;

  useEffect(() => {
    const abort = new AbortController();
    void api
      .session(abort.signal)
      .then((current) => {
        if (abort.signal.aborted) return;
        setSession(current);
        setSessionReady(true);
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        if (!(error instanceof CloudApiError && error.status === 401))
          setNotice(errorMessage(error));
        setSessionReady(true);
      });
    return () => abort.abort();
  }, []);

  useEffect(() => {
    const showUpdate = () => setUpdated(true);
    const showError = (event: Event) => setNotice(str((event as CustomEvent<unknown>).detail));
    window.addEventListener("cloud-update", showUpdate);
    window.addEventListener("cloud-error", showError);
    return () => {
      window.removeEventListener("cloud-update", showUpdate);
      window.removeEventListener("cloud-error", showError);
    };
  }, []);

  const hostsQuery = useCloudQuery<Collection<CloudHost>>(api, session ? cloudPath("hosts") : null);
  const hosts = arr(hostsQuery.data, "hosts");
  const selectedHost =
    hosts.find((host) => host.id === hostId) ??
    hosts.find((host) => host.kind === "cloud") ??
    hosts[0] ??
    null;
  const actualHostId = selectedHost?.id ?? null;
  const projectsQuery = useCloudQuery<Collection<CloudProject>>(
    api,
    session && actualHostId ? cloudPath("hosts", actualHostId, "projects") : null,
  );
  const projects = arr(projectsQuery.data, "projects");
  const selectedProject =
    projects.find((project) => project.id === projectId) ?? projects[0] ?? null;
  const actualProjectId = selectedProject?.id ?? null;
  const tasksPath =
    session && actualHostId
      ? `${cloudPath("hosts", actualHostId, "tasks")}${actualProjectId ? `?projectId=${encodeURIComponent(actualProjectId)}` : ""}`
      : null;
  const tasksQuery = useCloudQuery<Collection<Task>>(api, tasksPath);
  const tasks = arr(tasksQuery.data, "tasks");
  const approvalsQuery = useCloudQuery<Collection<CloudApproval>>(
    api,
    session ? cloudPath("approvals") : null,
  );
  const approvals = arr(approvalsQuery.data, "approvals").filter(
    (item) => item.context.hostId === actualHostId,
  );
  const providersQuery = useCloudQuery<Collection<CloudProvider>>(
    api,
    session && actualHostId ? cloudPath("hosts", actualHostId, "providers") : null,
  );
  const providers = arr(providersQuery.data, "providers");
  const bindings = Array.isArray(providersQuery.data?.bindings)
    ? (providersQuery.data.bindings as AgentModelBinding[])
    : [];
  const executorsQuery = useCloudQuery<Collection<CloudExecutor>>(
    api,
    session && actualHostId ? cloudPath("hosts", actualHostId, "executors") : null,
  );
  const executors = arr(executorsQuery.data, "executors");
  const projectTasks = useCloudQuery<Collection<Task>>(
    api,
    session && actualHostId && actualProjectId
      ? `${cloudPath("hosts", actualHostId, "tasks")}?projectId=${encodeURIComponent(actualProjectId)}`
      : null,
  );
  const detailQuery = useCloudQuery<CloudTaskSnapshot>(
    api,
    session && actualHostId && taskId ? cloudPath("hosts", actualHostId, "tasks", taskId) : null,
  );
  const taskSnapshot = detailQuery.data;
  const observedTaskId = taskSnapshot?.task?.id;
  const refreshTaskDetail = detailQuery.refresh;
  const refreshApprovals = approvalsQuery.refresh;
  const refreshTasks = tasksQuery.refresh;

  useEffect(() => {
    if (actualHostId && actualHostId !== hostId) setHostId(actualHostId);
    if (actualProjectId && actualProjectId !== projectId) setProjectId(actualProjectId);
  }, [actualHostId, actualProjectId, hostId, projectId]);

  useEffect(() => {
    if (!session || !actualHostId || !taskId || !observedTaskId) return;
    const controller = new AbortController();
    eventAbort.current = controller;
    const stop = api.watchTask(
      actualHostId,
      taskId,
      (event) => {
        if (!controller.signal.aborted) {
          setTaskEvents((events) =>
            events.some((item) => item.seq === event.seq) ? events : [...events, event].slice(-120),
          );
          if (
            [
              "task_status",
              "run_status",
              "run_started",
              "run_ended",
              "approval_required",
              "approval_resolved",
              "done",
              "error",
            ].includes(event.event.type)
          ) {
            refreshTaskDetail();
            refreshApprovals();
            refreshTasks();
          }
        }
      },
      (state) => {
        if (!controller.signal.aborted) {
          if (state === "history_expired") {
            setTaskEvents([]);
            setNotice("部分运行记录已按留存策略回收，请查看任务结果与产物。");
            refreshTaskDetail();
            setStreamState("connected");
          } else setStreamState(state);
        }
      },
    );
    return () => {
      stop();
      controller.abort();
      if (eventAbort.current === controller) eventAbort.current = null;
    };
  }, [
    session,
    actualHostId,
    taskId,
    observedTaskId,
    refreshTaskDetail,
    refreshApprovals,
    refreshTasks,
  ]);

  const navigate = (next: Page) => {
    setNotice("");
    setPage(next);
  };
  const selectHost = (value: string) => {
    if (value === hostId) return;
    dataGeneration.current++;
    setBusy(false);
    api.cancelPending();
    eventAbort.current?.abort();
    setHostId(value);
    setProjectId(null);
    setTaskId(null);
    setTaskEvents([]);
    setStreamState(null);
    approvalsQuery.refresh();
    navigate("workspace");
  };
  const selectProject = (project: CloudProject) => {
    setProjectId(project.id);
    setTaskId(null);
    setTaskEvents([]);
    navigate("project");
  };
  const selectTask = (id: string) => {
    setTaskId(id);
    setTaskEvents([]);
    navigate("task");
  };
  const refresh = () => {
    hostsQuery.refresh();
    projectsQuery.refresh();
    tasksQuery.refresh();
    approvalsQuery.refresh();
    providersQuery.refresh();
    executorsQuery.refresh();
    projectTasks.refresh();
    detailQuery.refresh();
  };
  const perform = async (
    action: () => Promise<unknown>,
    success: string,
    refreshAfter = true,
  ): Promise<boolean> => {
    if (!online) {
      setNotice("当前离线，已禁用写操作。网络恢复后请刷新状态。");
      return false;
    }
    const generation = dataGeneration.current;
    setBusy(true);
    setNotice("");
    try {
      await action();
      if (generation !== dataGeneration.current) return false;
      setNotice(success);
      if (refreshAfter) refresh();
      return true;
    } catch (error) {
      if (generation === dataGeneration.current) setNotice(errorMessage(error));
      return false;
    } finally {
      if (generation === dataGeneration.current) setBusy(false);
    }
  };
  const logout = () =>
    void perform(
      async () => {
        await api.request("/api/v1/logout", {}, "POST");
        clearIdentity();
        setSessionReady(true);
      },
      "已退出登录",
      false,
    );
  const activeTab =
    page === "tasks" || page === "task"
      ? 1
      : page === "approvals"
        ? 2
        : page === "settings" ||
            page === "providers" ||
            page === "connectors" ||
            page === "transfers"
          ? 3
          : 0;
  const title = (
    {
      workspace: "工作区",
      tasks: "任务",
      approvals: "审批",
      settings: "设置",
      project: "项目",
      task: "任务详情",
      "new-task": "新建任务",
      git: "Git 操作",
      providers: "模型配置",
      connectors: "电脑连接",
      executors: "Codex 授权",
      "repository-setup": "添加仓库",
      transfers: "取回改动",
    } satisfies Record<Page, string>
  )[page];

  if (!sessionReady) return <BootScreen />;
  if (!session)
    return (
      <Login
        api={api}
        notice={notice}
        clearNotice={() => setNotice("")}
        onSession={(value) => {
          setSession(value);
          setNotice("");
        }}
      />
    );

  const body = (() => {
    if (page === "workspace")
      return (
        <WorkspaceView
          selectedHost={selectedHost}
          hosts={hosts}
          hostId={actualHostId}
          hostLoading={hostsQuery.loading}
          projects={projects}
          projectsLoading={projectsQuery.loading}
          tasks={tasks}
          onSelectHost={selectHost}
          onProject={selectProject}
          onTask={selectTask}
          onApprovals={() => navigate("approvals")}
          onCreate={() => navigate("new-task")}
          onAddRepo={() =>
            navigate(selectedHost?.kind === "cloud" ? "repository-setup" : "connectors")
          }
        />
      );
    if (page === "project" && selectedProject)
      return (
        <ProjectView
          project={selectedProject}
          host={selectedHost}
          tasks={arr(projectTasks.data, "tasks")}
          loading={projectTasks.loading}
          onBack={() => navigate("workspace")}
          onTask={selectTask}
          onCreate={() => navigate("new-task")}
          onGit={() => navigate("git")}
        />
      );
    if (page === "tasks")
      return <TasksView tasks={tasks} loading={tasksQuery.loading} onTask={selectTask} />;
    if (page === "task" && taskId)
      return (
        <TaskView
          key={`${actualHostId}:${taskId}`}
          snapshot={taskSnapshot}
          events={taskEvents}
          streamState={streamState}
          loading={detailQuery.loading}
          onBack={() => navigate("tasks")}
          onRefresh={detailQuery.refresh}
          onFollowup={(message, clientRequestId) =>
            perform(
              () =>
                api.request(cloudPath("hosts", actualHostId ?? "", "tasks", taskId, "followup"), {
                  message,
                  clientRequestId,
                }),
              "已提交后续任务",
            )
          }
          onCancel={() =>
            perform(
              () =>
                api.request(cloudPath("hosts", actualHostId ?? "", "tasks", taskId, "cancel"), {
                  clientRequestId: requestId(),
                }),
              "已发送停止请求",
            )
          }
        />
      );
    if (page === "new-task")
      return (
        <NewTaskView
          key={`${actualHostId}:${actualProjectId}`}
          host={selectedHost}
          project={selectedProject}
          executors={executors}
          onBack={() => navigate(selectedProject ? "project" : "workspace")}
          onSubmit={(payload) =>
            perform(
              async () => {
                const response = await api.request<unknown>(
                  cloudPath(
                    "hosts",
                    actualHostId ?? "",
                    "projects",
                    actualProjectId ?? "",
                    "tasks",
                  ),
                  payload,
                );
                const task = record(response).task;
                const id = str(record(task).id, str(record(response).taskId));
                if (!id)
                  throw new Error(
                    "服务没有返回任务 ID。请先刷新任务列表确认是否已受理，再决定是否重试。",
                  );
                setTaskId(id);
                setTaskEvents([]);
                navigate("task");
              },
              "任务已受理",
              false,
            )
          }
        />
      );
    if (page === "approvals")
      return (
        <ApprovalsView
          api={api}
          host={selectedHost}
          approvals={approvals}
          loading={approvalsQuery.loading}
          busy={busy}
          onResolved={() => {
            setNotice("审批决定已提交");
            approvalsQuery.refresh();
            detailQuery.refresh();
          }}
        />
      );
    if (page === "git" && selectedProject)
      return (
        <GitView
          key={`${actualHostId}:${actualProjectId}`}
          api={api}
          hostId={actualHostId ?? ""}
          project={selectedProject}
          busy={busy}
          onAction={perform}
          onBack={() => navigate("project")}
        />
      );
    if (page === "providers")
      return (
        <ProviderView
          key={actualHostId}
          host={selectedHost}
          providers={providers}
          bindings={bindings}
          allowServerCredentials={
            providersQuery.data?.credentialPolicy != null &&
            typeof providersQuery.data.credentialPolicy === "object" &&
            "allowServerCredentials" in providersQuery.data.credentialPolicy &&
            providersQuery.data.credentialPolicy.allowServerCredentials === true
          }
          loading={providersQuery.loading}
          busy={busy}
          onSave={(id, body) =>
            perform(
              () =>
                api.request(cloudPath("hosts", actualHostId ?? "", "providers", id), body, "PUT"),
              "模型配置已保存",
            )
          }
          onTest={(id) =>
            perform(
              () =>
                api.request(cloudPath("hosts", actualHostId ?? "", "providers", id, "test"), {}),
              "模型连通性检查完成",
            )
          }
          onUseForBot={(provider) =>
            perform(
              () =>
                api.request(
                  cloudPath("hosts", actualHostId ?? "", "provider-bindings"),
                  {
                    bindings: ["orchestrator", "code", "reviewer"].map((agent) => ({
                      agent,
                      providerId: provider.id,
                      model: provider.defaultModel,
                      fallbackProviderIds: [],
                    })),
                  },
                  "PUT",
                ),
              "Bot 任务的规划、编码和审阅模型已更新",
            )
          }
          onBack={() => navigate("settings")}
        />
      );
    if (page === "connectors")
      return (
        <ConnectorsView
          api={api}
          onBack={() => {
            hostsQuery.refresh();
            navigate("settings");
          }}
        />
      );
    if (page === "executors")
      return (
        <ExecutorsView
          key={actualHostId}
          api={api}
          host={selectedHost}
          onBack={() => {
            executorsQuery.refresh();
            navigate("settings");
          }}
        />
      );
    if (page === "repository-setup")
      return (
        <RepositorySetupView
          key={actualHostId}
          api={api}
          host={selectedHost}
          onBack={() => {
            projectsQuery.refresh();
            navigate("workspace");
          }}
        />
      );
    if (page === "transfers")
      return (
        <TransfersView
          api={api}
          hosts={hosts}
          onBack={() => {
            projectsQuery.refresh();
            navigate("settings");
          }}
        />
      );
    return (
      <SettingsView
        session={session}
        host={selectedHost}
        providers={providers}
        executors={executors}
        onProviders={() => navigate("providers")}
        onConnectors={() => navigate("connectors")}
        onExecutors={() => navigate("executors")}
        onTransfers={() => navigate("transfers")}
        onLogout={logout}
      />
    );
  })();

  return (
    <div className="m-app">
      <header className="m-app-header">
        <div>
          <p className="m-app-eyebrow">AGENTDESK / CONTROL ROOM</p>
          <h1>{title}</h1>
        </div>
        <div className="m-header-actions">
          <span
            className={`m-net${online ? " is-online" : " is-offline"}`}
            aria-label={online ? "在线" : "离线"}
          >
            <span />
          </span>
          <Refresh onClick={refresh} busy={hostsQuery.loading || tasksQuery.loading} />
          <button
            type="button"
            className="m-create-avatar"
            aria-label="新建任务"
            onClick={() => navigate("new-task")}
          >
            <Plus size={18} aria-hidden="true" />
          </button>
        </div>
      </header>
      <main className="m-main">
        {!online && <Notice error>离线模式：显示的数据可能已过期，所有写操作已暂停。</Notice>}
        {(hostsQuery.error ||
          projectsQuery.error ||
          tasksQuery.error ||
          detailQuery.error ||
          providersQuery.error ||
          executorsQuery.error ||
          approvalsQuery.error) && (
          <Notice error>
            {hostsQuery.error ||
              projectsQuery.error ||
              tasksQuery.error ||
              detailQuery.error ||
              providersQuery.error ||
              executorsQuery.error ||
              approvalsQuery.error}
          </Notice>
        )}
        {notice && (
          <Notice
            error={notice.includes("失败") || notice.includes("无法") || notice.includes("过期")}
          >
            {notice}
          </Notice>
        )}
        {body}
      </main>
      <GlassNavigation
        active={activeTab}
        onChange={(index) =>
          navigate(
            (["workspace", "tasks", "approvals", "settings"] as Page[])[index] ?? "workspace",
          )
        }
        onCreate={() => navigate("new-task")}
      />
      {updated && (
        <div className="m-update">
          <span>有新版界面可用。</span>
          <Button
            variant="secondary"
            onClick={() => {
              navigator.serviceWorker?.addEventListener(
                "controllerchange",
                () => window.location.reload(),
                { once: true },
              );
              void navigator.serviceWorker
                ?.getRegistration()
                .then((registration) => registration?.waiting?.postMessage("activate-update"));
            }}
          >
            更新
          </Button>
          <button aria-label="关闭" onClick={() => setUpdated(false)}>
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

function Login({
  api,
  notice,
  clearNotice,
  onSession,
}: {
  api: CloudApi;
  notice: string;
  clearNotice: () => void;
  onSession: (value: CloudSession) => void;
}) {
  const [email, setEmail] = useState(readStoredEmail);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const emailRef = useRef(email);
  emailRef.current = email;
  const clearNoticeRef = useRef(clearNotice);
  clearNoticeRef.current = clearNotice;
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;

  useEffect(() => {
    void api.loginCsrf().catch((error: unknown) => setMessage(errorMessage(error)));
  }, [api]);

  const otpOptions = useMemo(
    () => ({
      autoPlay: false as const,
      onVerify: async (code: string) => {
        clearNoticeRef.current();
        setMessage("");
        try {
          await api.request("/api/v1/auth/otp/verify", {
            email: emailRef.current.trim().toLowerCase(),
            otp: code,
          });
          return true;
        } catch (error) {
          setMessage(errorMessage(error));
          return false;
        }
      },
      onSuccess: async () => {
        try {
          rememberEmail(emailRef.current);
          const current = await api.session();
          onSessionRef.current(current);
        } catch (error) {
          setMessage(errorMessage(error));
        }
      },
    }),
    [api],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sent) return;
    clearNotice();
    setMessage("");
    setBusy(true);
    try {
      const normalized = email.trim().toLowerCase();
      await api.request("/api/v1/auth/otp/request", { email: normalized });
      rememberEmail(normalized);
      setSent(true);
      setMessage("如果邮箱有效，验证码将发送至收件箱。请在 5 分钟内完成验证。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="m-login">
      <div className="m-login-panel">
        <div className="m-login-brand">
          <span className="m-brand-mark">
            <Code2 size={24} />
          </span>
          <span>AgentDesk</span>
          <span className="m-login-cloud">
            <Cloud size={16} /> CLOUD
          </span>
        </div>
        <p className="m-overline">YOUR PERSONAL BUILD DESK</p>
        <h1>
          从手机接上
          <br />
          你的工作现场。
        </h1>
        <p className="m-login-copy">安全查看项目进度、审批操作并继续开发任务。</p>
        {!sent ? (
          <form onSubmit={(event) => void submit(event)} className="m-login-form">
            <label className="m-field">
              <span>邮箱地址</span>
              <input
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
              />
            </label>
            {message && <Notice error={!message.startsWith("如果")}>{message}</Notice>}
            {notice && <Notice error>{notice}</Notice>}
            <Button type="submit" busy={busy} className="m-login-submit">
              发送登录验证码
              <ArrowRight size={17} />
            </Button>
          </form>
        ) : (
          <div className="m-login-otp">
            <div className="m-login-otp-meta">
              <span className="m-overline">VERIFY</span>
              <strong>{email.trim().toLowerCase()}</strong>
              <button
                className="m-inline-action"
                type="button"
                onClick={() => {
                  setSent(false);
                  setMessage("");
                }}
              >
                更换邮箱
              </button>
            </div>
            <OtpVerification className="m-otp-host" options={otpOptions} />
            {message && <Notice error={!message.startsWith("如果")}>{message}</Notice>}
            {notice && <Notice error>{notice}</Notice>}
          </div>
        )}
        <div className="m-login-foot">
          <ShieldCheck size={16} />
          <span>支持邮箱验证码登录</span>
          <span className="m-foot-dot" />
          <span>验证码 5 分钟有效</span>
        </div>
      </div>
      <div className="m-login-side">
        <LoginAtmosphere />
        <div className="m-login-side-copy">
          <div className="m-side-index">01 / PRIVATE WORKSPACE</div>
          <strong>Work moves with you.</strong>
          <span>REMOTE · REVIEW · RESUME</span>
        </div>
      </div>
    </div>
  );
}

function WorkspaceView({
  selectedHost,
  hosts,
  hostId,
  hostLoading,
  projects,
  projectsLoading,
  tasks,
  onSelectHost,
  onProject,
  onTask,
  onApprovals,
  onCreate,
  onAddRepo,
}: {
  selectedHost: CloudHost | null;
  hosts: CloudHost[];
  hostId: string | null;
  hostLoading: boolean;
  projects: CloudProject[];
  projectsLoading: boolean;
  tasks: Task[];
  onSelectHost: (id: string) => void;
  onProject: (project: CloudProject) => void;
  onTask: (id: string) => void;
  onApprovals: () => void;
  onCreate: () => void;
  onAddRepo: () => void;
}) {
  const pending = tasks.filter((task) => task.status.startsWith("awaiting_")).length;
  const active = tasks.filter((task) =>
    ["queued", "planning", "running"].includes(task.status),
  ).length;
  const completed = tasks.filter((task) =>
    ["completed", "succeeded", "closed"].includes(task.status),
  ).length;
  const fallbackBranch = selectedHost?.kind === "cloud" ? "云端工作区" : "已授权目录";
  const online = selectedHost?.status === "online";
  return (
    <>
      <section className="m-runner" aria-label="执行端与任务概览">
        <div className="m-runner-line">
          <span className="m-runner-icon">
            {selectedHost?.kind === "cloud" ? (
              <Cloud size={18} aria-hidden="true" />
            ) : (
              <Laptop size={18} aria-hidden="true" />
            )}
          </span>
          <div className="m-runner-info">
            <strong>{selectedHost?.name ?? "尚未连接执行宿主"}</strong>
            <p>
              <span className={`m-online${online ? "" : " is-offline"}`}>
                <i className="m-dot" />
                {online ? "在线" : "离线"}
              </span>
              <span> · 最近活动 {displayTime(selectedHost?.lastSeen)}</span>
            </p>
          </div>
          <label className="m-runner-switch" aria-label="切换执行端">
            <select
              aria-label="当前执行宿主"
              value={hostId ?? ""}
              onChange={(event) => onSelectHost(event.target.value)}
              disabled={!hosts.length}
            >
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name}
                </option>
              ))}
            </select>
            <ChevronDown size={17} aria-hidden="true" />
          </label>
        </div>
        <div className="m-metrics">
          <div className="m-metric">
            <strong>{active}</strong>
            <span>执行中</span>
          </div>
          <div className={`m-metric${pending ? " is-attention" : ""}`}>
            <button
              type="button"
              className="m-metric-btn"
              onClick={onApprovals}
              aria-label="查看待审批"
            >
              <strong>{pending}</strong>
              <span>待审批</span>
            </button>
          </div>
          <div className="m-metric">
            <strong>{completed}</strong>
            <span>已完成</span>
          </div>
        </div>
      </section>

      <section className="m-section">
        <div className="m-section-head">
          <h2>
            你的项目
            <small>{projects.length || 0}</small>
          </h2>
          <button type="button" className="m-text-button" onClick={onAddRepo}>
            <Plus size={14} aria-hidden="true" />
            添加项目
          </button>
        </div>
        {projectsLoading || hostLoading ? (
          <LoadingRows count={2} />
        ) : projects.length ? (
          <ProjectCards
            projects={projects}
            host={selectedHost}
            fallbackBranch={fallbackBranch}
            onSelect={onProject}
          />
        ) : (
          <Empty title={selectedHost ? "这个宿主还没有可用项目" : "添加执行宿主以开始"}>
            已连接的仓库和办公室项目会显示在这里。
          </Empty>
        )}
      </section>

      <CollabScene tasks={tasks} onOpenTask={onTask} />

      <section className="m-section m-recent">
        <div className="m-section-head">
          <h2>最近任务</h2>
          <Button className="m-small-primary" onClick={onCreate}>
            <Plus size={15} aria-hidden="true" />
            新建任务
          </Button>
        </div>
        {tasks.length ? (
          <TaskRows tasks={tasks.slice(0, 3)} onSelect={onTask} />
        ) : (
          <Empty title="从一个小目标开始">
            检查代码、整理方案，或完成一次部署。
            <br />
            点击「新建任务」，让 Agent 帮你推进。
          </Empty>
        )}
      </section>

      <div className="m-helper">
        <ShieldCheck size={16} aria-hidden="true" />
        <p>
          <strong>放心交给 Agent，关键操作由你决定。</strong>
          <br />
          需要确认的操作会出现在「审批」中。
        </p>
      </div>
    </>
  );
}

function ProjectView({
  project,
  host,
  tasks,
  loading,
  onBack,
  onTask,
  onCreate,
  onGit,
}: {
  project: CloudProject;
  host: CloudHost | null;
  tasks: Task[];
  loading: boolean;
  onBack: () => void;
  onTask: (id: string) => void;
  onCreate: () => void;
  onGit: () => void;
}) {
  return (
    <>
      <Back onClick={onBack} />
      <section className="m-project-hero">
        <span className="m-project-mark mark-1">
          <Code2 size={21} />
        </span>
        <div>
          <span className="m-overline">{host?.name ?? "HOST"}</span>
          <h2>{project.name}</h2>
          <span className="m-branch">
            <GitBranch size={14} />
            {project.branch || "当前工作区"}
          </span>
        </div>
      </section>
      <div className="m-action-grid">
        <button onClick={onCreate}>
          <span className="action-icon action-green">
            <Sparkles size={18} />
          </span>
          <strong>AI 任务</strong>
          <small>描述目标并开始</small>
        </button>
        <button onClick={onGit}>
          <span className="action-icon action-violet">
            <GitCompareArrows size={18} />
          </span>
          <strong>Git 操作</strong>
          <small>预览、提交与推送</small>
        </button>
      </div>
      <div className="m-section-head">
        <div>
          <span className="m-overline">ACTIVITY</span>
          <h2>项目任务</h2>
        </div>
        <span className="m-count">{tasks.length}</span>
      </div>
      {loading ? (
        <LoadingRows />
      ) : tasks.length ? (
        <TaskRows tasks={tasks} projectName={project.name} onSelect={onTask} />
      ) : (
        <Empty title="还没有任务" />
      )}
    </>
  );
}

function TasksView({
  tasks,
  loading,
  onTask,
}: {
  tasks: Task[];
  loading: boolean;
  onTask: (id: string) => void;
}) {
  const [filter, setFilter] = useState("all");
  const filtered =
    filter === "running"
      ? tasks.filter(
          (task) =>
            ["queued", "planning", "running"].includes(task.status) ||
            task.status.startsWith("awaiting_"),
        )
      : filter === "completed"
        ? tasks.filter((task) =>
            ["completed", "succeeded", "failed", "cancelled", "closed"].includes(task.status),
          )
        : tasks;
  const filters: [string, string][] = [
    ["all", "全部"],
    ["running", "执行中"],
    ["completed", "已完成"],
  ];
  return (
    <>
      <p className="m-view-desc">跟踪 Agent 的执行过程与任务结果。</p>
      <div className="m-filters" role="tablist" aria-label="任务筛选">
        {filters.map(([value, label]) => (
          <button
            type="button"
            role="tab"
            className="m-filter"
            aria-selected={filter === value}
            aria-pressed={filter === value}
            key={value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {loading ? (
        <LoadingRows count={4} />
      ) : filtered.length ? (
        <TaskRows tasks={filtered} onSelect={onTask} />
      ) : (
        <Empty title="这里还没有任务">
          {filter === "all" ? "创建任务后，进度与结果会显示在这里。" : "当前筛选下暂无任务。"}
        </Empty>
      )}
    </>
  );
}

function TaskView({
  snapshot,
  events,
  streamState,
  loading,
  onBack,
  onRefresh,
  onFollowup,
  onCancel,
}: {
  snapshot?: CloudTaskSnapshot;
  events: RunEventRecord[];
  streamState: "connected" | "reconnecting" | null;
  loading: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onFollowup: (message: string, clientRequestId: string) => Promise<boolean>;
  onCancel: () => Promise<unknown>;
}) {
  const online = useOnline();
  const [followup, setFollowup] = useState("");
  const [busy, setBusy] = useState(false);
  const task = snapshot?.task;
  const followupRequest = useRef({ message: "", id: "" });
  const run = snapshot?.run ?? snapshot?.runs?.at(-1);
  const resolved = events;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!followup.trim() || busy) return;
    setBusy(true);
    const message = followup.trim();
    if (followupRequest.current.message !== message)
      followupRequest.current = { message, id: requestId() };
    try {
      if (await onFollowup(message, followupRequest.current.id)) {
        setFollowup("");
        followupRequest.current = { message: "", id: "" };
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Back onClick={onBack}>全部任务</Back>
      {loading && !task ? (
        <LoadingRows count={2} />
      ) : task ? (
        <>
          <div className="m-detail-title">
            <div>
              <span className="m-overline">TASK · {task.id.slice(0, 8)}</span>
              <h2>{task.title}</h2>
            </div>
            <button className="m-icon-button" aria-label="刷新任务" onClick={onRefresh}>
              <Activity size={18} />
            </button>
          </div>
          <div className="m-detail-meta">
            <Status value={run?.status ?? task.status} />
            <span>创建于 {displayTime(task.createdAt)}</span>
            {streamState && (
              <span className={`m-stream-state ${streamState}`}>
                {streamState === "connected" ? "实时同步" : "正在重连"}
              </span>
            )}
          </div>
          <section className="m-detail-section">
            <h3>任务目标</h3>
            <p className="m-goal">{task.goal}</p>
          </section>
          {run?.resultError && <Notice error>{run.resultError}</Notice>}
          {run?.resultText && (
            <section className="m-detail-section">
              <h3>执行结果</h3>
              <pre className="m-output">{run.resultText}</pre>
            </section>
          )}
          <section className="m-detail-section">
            <h3>
              执行时间线 <span>{resolved.length}</span>
            </h3>
            {resolved.length ? (
              <div className="m-timeline">
                {resolved
                  .slice(-30)
                  .reverse()
                  .map((event) => (
                    <div className="m-timeline-event" key={event.seq}>
                      <span className="m-timeline-dot" />
                      <div>
                        <strong>{event.event.type.replaceAll("_", " ")}</strong>
                        <small>
                          #{event.seq} · {displayTime(event.createdAt)}
                        </small>
                        {"status" in event.event && <small>{String(event.event.status)}</small>}
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="m-subtle-empty">执行中的新进度会实时出现在这里。</div>
            )}
          </section>
          {snapshot.approvals?.some((item) => item.approval.status === "pending") && (
            <Notice>此任务有待处理审批，请切换到“审批”完成审核。</Notice>
          )}
          <form className="m-followup" onSubmit={(event) => void submit(event)}>
            <label className="m-field">
              <span>继续指示</span>
              <textarea
                rows={3}
                value={followup}
                onChange={(event) => setFollowup(event.target.value)}
                placeholder="补充说明或继续修复方向"
              />
            </label>
            <div className="m-follow-actions">
              <Button type="submit" busy={busy} disabled={!online || !followup.trim()}>
                继续任务 <ArrowRight size={16} />
              </Button>
              {run && ["queued", "running"].includes(run.status) && (
                <Button variant="danger" disabled={!online} onClick={() => void onCancel()}>
                  停止执行
                </Button>
              )}
            </div>
          </form>
        </>
      ) : (
        <Notice error>暂时无法加载任务详情。</Notice>
      )}
    </>
  );
}

function NewTaskView({
  host,
  project,
  executors,
  onBack,
  onSubmit,
}: {
  host: CloudHost | null;
  project: CloudProject | null;
  executors: CloudExecutor[];
  onBack: () => void;
  onSubmit: (input: RemoteTaskInput) => Promise<boolean>;
}) {
  const online = useOnline();
  const available = executors.filter((item) => item.available);
  const [goal, setGoal] = useState("");
  const [executor, setExecutor] = useState<"native-bot" | "codex">("native-bot");
  const [busy, setBusy] = useState(false);
  const submission = useRef({ fingerprint: "", id: "" });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!project || busy) return;
    setBusy(true);
    const fingerprint = JSON.stringify({
      goal: goal.trim(),
      executor,
      workspaceId: project.workspaceId,
    });
    if (submission.current.fingerprint !== fingerprint)
      submission.current = { fingerprint, id: requestId() };
    try {
      await onSubmit({
        clientRequestId: submission.current.id,
        goal: goal.trim(),
        executor,
        workspaceMode: "existing",
        workspaceId: project.workspaceId,
        requiresPlanApproval: true,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Back onClick={onBack} />
      <div className="m-form-title">
        <span className="m-overline">NEW TASK</span>
        <h2>给项目一个目标。</h2>
        <p>任务会在选定的宿主上持久执行，即使手机断开也不会停止。</p>
      </div>
      {!project && <Notice error>请先选择项目，再创建任务。</Notice>}
      <form className="m-form" onSubmit={(event) => void submit(event)}>
        <div className="m-context-line">
          <span>{host?.name ?? "未选择宿主"}</span>
          <ArrowRight size={14} />
          <span>{project?.name ?? "未选择项目"}</span>
        </div>
        <label className="m-field">
          <span>你想完成什么？</span>
          <textarea
            required
            minLength={1}
            maxLength={32000}
            rows={7}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="例如：检查登录流程，修复失败的单元测试，并说明改动内容。"
          />
          <small>{goal.length} / 32,000</small>
        </label>
        <fieldset className="m-fieldset">
          <legend>执行器</legend>
          {available.length ? (
            <div className="m-choice-grid">
              {available.map((item) => (
                <label
                  key={item.id}
                  className={`m-choice${executor === item.id ? " is-selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="executor"
                    value={item.id}
                    checked={executor === item.id}
                    onChange={() => setExecutor(item.id)}
                  />
                  <span className="m-choice-icon">
                    {item.id === "codex" ? <Code2 size={19} /> : <Sparkles size={19} />}
                  </span>
                  <span>
                    <strong>{item.id === "codex" ? "Codex" : "Bot"}</strong>
                    <small>{item.id === "codex" ? "独立编码会话" : "AgentDesk 助手"}</small>
                  </span>
                  <span className="m-choice-check">
                    <Check size={14} />
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <div className="m-subtle-empty">当前宿主没有已配置的执行器，请先在设置中完成配置。</div>
          )}
        </fieldset>
        {executors
          .filter((item) => !item.available)
          .map((item) => (
            <Notice key={item.id}>
              {item.id === "codex" ? "Codex" : "Bot"} 暂不可用：{item.reason || "此宿主尚未启用"}
            </Notice>
          ))}
        <div className="m-form-callout">
          <ShieldCheck size={16} />
          <span>开始执行前会要求确认计划。危险操作仍须单独审批。</span>
        </div>
        <Button
          className="m-wide-action"
          type="submit"
          busy={busy}
          disabled={
            !online || !project || !available.some((item) => item.id === executor) || !goal.trim()
          }
        >
          <Sparkles size={17} />
          提交任务
        </Button>
      </form>
    </>
  );
}

function ApprovalsView({
  api,
  host,
  approvals,
  loading,
  busy,
  onResolved,
}: {
  api: CloudApi;
  host: CloudHost | null;
  approvals: CloudApproval[];
  loading: boolean;
  busy: boolean;
  onResolved: () => void;
}) {
  const [resolving, setResolving] = useState(false);
  const decisions = useRef(new Map<string, RemoteApprovalDecision>());
  const pending = approvals.filter(({ approval }) => approval.status === "pending");
  const resolve = async (item: CloudApproval, approved: boolean) => {
    if (resolving) return;
    const key = `${item.approval.id}:${item.context.version}:${approved}`;
    const decision = decisions.current.get(key) ?? {
      clientRequestId: requestId(),
      version: item.context.version,
      actionDigest: item.context.actionDigest,
      approved,
    };
    decisions.current.set(key, decision);
    setResolving(true);
    try {
      await api.request(
        cloudPath("hosts", item.context.hostId, "approvals", item.approval.id, "resolve"),
        decision,
      );
      onResolved();
    } catch (error) {
      window.dispatchEvent(new CustomEvent("cloud-error", { detail: errorMessage(error) }));
    } finally {
      setResolving(false);
    }
  };
  return (
    <>
      <p className="m-view-desc">先了解操作内容，再决定是否继续。</p>
      {host && (
        <div className="m-approval-context">
          <ShieldCheck size={17} />
          <span>审批操作将绑定到 {host.name}</span>
        </div>
      )}
      {loading ? (
        <LoadingRows count={2} />
      ) : pending.length ? (
        <div className="m-approval-list">
          {pending.map((item) => (
            <ApprovalCard
              key={item.approval.id}
              item={item}
              busy={busy || resolving}
              onDecision={resolve}
            />
          ))}
        </div>
      ) : (
        <Empty title="当前没有待审批操作">有风险的文件、Git 和计划操作会先在此等待你的决定。</Empty>
      )}
      <details className="m-past-approvals">
        <summary>
          已处理的审批 <span>{approvals.length - pending.length}</span>
        </summary>
        {approvals
          .filter(({ approval }) => approval.status !== "pending")
          .slice(0, 8)
          .map((item) => (
            <div key={item.approval.id} className="m-past-row">
              <span>{item.approval.title}</span>
              <Status value={item.approval.status} />
            </div>
          ))}
      </details>
    </>
  );
}

function ApprovalCard({
  item,
  busy,
  onDecision,
}: {
  item: CloudApproval;
  busy: boolean;
  onDecision: (item: CloudApproval, approved: boolean) => void;
}) {
  const approval = item.approval;
  const context = item.context;
  const payload = record(approval.payload);
  const online = useOnline();
  const expired = Date.parse(context.expiresAt) <= Date.now();
  const paths = [
    payload.path,
    payload.targetPath,
    ...(Array.isArray(payload.paths) ? payload.paths : []),
    ...(Array.isArray(payload.files) ? payload.files : []),
  ].filter((value): value is string => typeof value === "string");
  return (
    <article className="m-approval-card">
      <div className="m-approval-top">
        <span className="m-risk">
          <CircleAlert size={14} />
          {approval.risk === "dangerous"
            ? "高风险操作"
            : approval.risk === "confirm"
              ? "需要确认"
              : "安全操作"}
        </span>
        <span className="m-expiry">有效至 {displayTime(context.expiresAt)}</span>
      </div>
      <h3>{approval.title}</h3>
      <p className="m-approval-description">{approval.detail}</p>
      {paths.length > 0 && (
        <div className="m-approval-paths">
          <span>受影响路径</span>
          {paths.slice(0, 8).map((path) => (
            <code key={path}>{path}</code>
          ))}
        </div>
      )}
      <div className="m-approval-paths">
        <span>宿主 / 项目 / 工作区</span>
        <code>
          {context.hostId} / {context.projectId} / {context.workspaceId}
        </code>
        <span>动作：{context.action}</span>
      </div>
      {typeof payload.diff === "string" && <pre className="m-diff">{payload.diff}</pre>}
      <details>
        <summary className="m-inline-action">查看完整动作参数</summary>
        <pre className="m-output">{JSON.stringify(approval.payload, null, 2)}</pre>
      </details>
      <div className="m-approval-binding">
        <span>版本 {context.version}</span>
        <code>{context.actionDigest.slice(0, 18)}…</code>
      </div>
      {expired && <Notice error>此审批已过期，请刷新任务并重新发起。</Notice>}
      <div className="m-approval-buttons">
        <Button
          variant="secondary"
          busy={busy}
          disabled={!online || expired}
          onClick={() => onDecision(item, false)}
        >
          拒绝
        </Button>
        <Button busy={busy} disabled={!online || expired} onClick={() => onDecision(item, true)}>
          批准并继续 <ArrowRight size={15} />
        </Button>
      </div>
    </article>
  );
}

function GitView({
  api,
  hostId,
  project,
  busy,
  onAction,
  onBack,
}: {
  api: CloudApi;
  hostId: string;
  project: CloudProject;
  busy: boolean;
  onAction: (action: () => Promise<unknown>, success: string) => Promise<boolean>;
  onBack: () => void;
}) {
  const statusQuery = useCloudQuery<{
    head: string;
    branch: string;
    files: Array<{
      path: string;
      previousPath: string | null;
      indexStatus: string;
      worktreeStatus: string;
      kind: string;
    }>;
  }>(api, cloudPath("hosts", hostId, "projects", project.id, "git", "status"));
  const [files, setFiles] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<JsonRecord | null>(null);
  const [previewKind, setPreviewKind] = useState<"commit" | "push">("commit");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [remote, setRemote] = useState("origin");
  const [targetRef, setTargetRef] = useState("");
  const [outcome, setOutcome] = useState<JsonRecord | null>(null);
  const attempts = useRef(new Map<string, { approval: string; execute: string }>());
  const online = useOnline();
  const base = cloudPath("hosts", hostId, "projects", project.id, "git");
  const previewGit = async () => {
    if (!files.length || !message.trim()) {
      setError("请选择文件并填写提交说明。");
      return;
    }
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const response = await api.request<unknown>(
        `${base}/preview`,
        { clientRequestId: requestId(), kind: "commit", files, message },
        "POST",
      );
      const operation = record(response).operation;
      const result = operation ? record(operation).result : record(response).result;
      setPreview(result ? record(result) : record(response));
      setPreviewKind("commit");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  const previewPush = async () => {
    const ref =
      targetRef ||
      (statusQuery.data?.branch.startsWith("refs/heads/")
        ? statusQuery.data.branch
        : `refs/heads/${statusQuery.data?.branch ?? ""}`);
    if (!remote.trim() || !ref.startsWith("refs/heads/") || ref === "refs/heads/") {
      setError("请填写明确的远端名称和目标分支 ref。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await api.request<unknown>(
        `${base}/preview`,
        { clientRequestId: requestId(), kind: "push", remote: remote.trim(), ref },
        "POST",
      );
      const operation = record(response).operation;
      const result = operation ? record(operation).result : record(response).result;
      setPreview(result ? record(result) : record(response));
      setPreviewKind("push");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  const approveAndExecute = async () => {
    const result = record(preview);
    if (
      typeof result.previewId !== "string" ||
      typeof result.approvalId !== "string" ||
      typeof result.version !== "number" ||
      typeof result.actionDigest !== "string"
    ) {
      setError("预览缺少绑定审批所需的字段，请重新生成预览。");
      return;
    }
    const attempt = attempts.current.get(result.previewId) ?? {
      approval: requestId(),
      execute: requestId(),
    };
    attempts.current.set(result.previewId, attempt);
    const approval: RemoteApprovalDecision = {
      clientRequestId: attempt.approval,
      version: result.version,
      actionDigest: result.actionDigest,
      approved: true,
    };
    const action = previewKind;
    const endpoint = `${base}/${action}`;
    const body = {
      clientRequestId: attempt.execute,
      previewId: result.previewId,
      approvalId: result.approvalId,
      version: result.version,
      actionDigest: result.actionDigest,
    };
    const approvalPath = cloudPath("hosts", hostId, "approvals", result.approvalId, "resolve");
    await onAction(async () => {
      await api.request(approvalPath, approval);
      const response = await api.request<unknown>(endpoint, body);
      const operation = record(record(response).operation);
      setOutcome(operation);
      if (operation.status === "succeeded") {
        setPreview(null);
        setFiles([]);
        statusQuery.refresh();
      }
    }, "Git 操作已返回，请查看执行结果。");
  };
  const previewRecord = record(preview);
  const changedFiles = Array.isArray(previewRecord.files) ? previewRecord.files : [];
  const diff = str(previewRecord.diff);
  return (
    <>
      <Back onClick={onBack} />
      <div className="m-form-title">
        <span className="m-overline">GIT · {project.name}</span>
        <h2>审阅变更，再决定是否提交。</h2>
        <p>先选出文件，再检查完整 diff。预览绑定当前分支、内容和远端。</p>
      </div>
      <form
        className="m-form"
        onSubmit={(event) => {
          event.preventDefault();
          void previewGit();
        }}
      >
        <label className="m-field">
          <span>提交说明</span>
          <input
            value={message}
            maxLength={500}
            onChange={(event) => {
              setMessage(event.target.value);
              setPreview(null);
            }}
            placeholder="简述这次改动"
          />
        </label>
        <div className="m-changes-title">
          <span>
            工作区改动 <small>{statusQuery.data?.files.length ?? 0}</small>
          </span>
          <span>HEAD {statusQuery.data?.head.slice(0, 10) ?? "--"}</span>
        </div>
        {statusQuery.loading ? (
          <LoadingRows count={2} />
        ) : statusQuery.error ? (
          <Notice error>{statusQuery.error}</Notice>
        ) : statusQuery.data?.files.length ? (
          <div className="m-change-list">
            {statusQuery.data.files.map((file) => (
              <label key={file.path} className="m-change-row">
                <input
                  type="checkbox"
                  checked={files.includes(file.path)}
                  onChange={(event) => {
                    setFiles((previous) =>
                      event.target.checked
                        ? [...previous, file.path]
                        : previous.filter((path) => path !== file.path),
                    );
                    setPreview(null);
                  }}
                />
                <span>
                  <strong>{file.path}</strong>
                  {file.previousPath && <small>来自 {file.previousPath}</small>}
                  <small>
                    {file.kind} · index {file.indexStatus} · worktree {file.worktreeStatus}
                  </small>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <div className="m-subtle-empty">
            状态服务未提供改动文件，或工作区当前没有变更。请刷新状态后再选择提交范围。
          </div>
        )}
        {statusQuery.data?.files.length ? (
          <button
            className="m-text-button m-select-all"
            type="button"
            onClick={() => {
              setFiles((previous) =>
                previous.length === statusQuery.data?.files.length
                  ? []
                  : (statusQuery.data?.files.map((file) => file.path) ?? []),
              );
              setPreview(null);
            }}
          >
            {files.length === statusQuery.data.files.length ? "取消全选" : "选择所有改动"}
          </button>
        ) : null}
        <Button
          variant="secondary"
          type="submit"
          busy={loading}
          disabled={!online || !files.length || !message.trim()}
        >
          <GitCompareArrows size={17} />
          生成 Git 预览 · {files.length}
        </Button>
      </form>
      <section className="m-detail-section">
        <h3>单独推送已提交内容</h3>
        <form
          className="m-form"
          onSubmit={(event) => {
            event.preventDefault();
            void previewPush();
          }}
        >
          <label className="m-field">
            <span>远端名称</span>
            <input
              required
              value={remote}
              onChange={(event) => {
                setRemote(event.target.value);
                setPreview(null);
              }}
            />
          </label>
          <label className="m-field">
            <span>目标分支 ref</span>
            <input
              required
              value={
                targetRef ||
                (statusQuery.data?.branch.startsWith("refs/heads/")
                  ? statusQuery.data.branch
                  : `refs/heads/${statusQuery.data?.branch ?? ""}`)
              }
              onChange={(event) => {
                setTargetRef(event.target.value);
                setPreview(null);
              }}
            />
          </label>
          <Button
            variant="secondary"
            type="submit"
            busy={loading}
            disabled={!online || !statusQuery.data}
          >
            <ArrowDownToLine size={16} />
            预览推送
          </Button>
        </form>
      </section>
      {outcome && (
        <section className="m-git-preview">
          <div className="m-preview-head">
            <strong>Git 执行结果</strong>
            <Status value={str(outcome.status, "needs_reconciliation")} />
          </div>
          <pre className="m-output">{JSON.stringify(outcome.result, null, 2)}</pre>
          {outcome.status !== "succeeded" && (
            <Notice>结果尚未确认。请查询此操作，避免重复创建新的提交请求。</Notice>
          )}
        </section>
      )}
      {error && <Notice error>{error}</Notice>}
      {preview && (
        <section className="m-git-preview">
          <div className="m-preview-head">
            <span>
              <GitBranch size={16} />
              {str(previewRecord.branch, previewKind === "push" ? "推送预览" : "当前分支")}
            </span>
            {typeof previewRecord.remote === "string" && (
              <span>
                {previewRecord.remote}/{str(previewRecord.ref)}
              </span>
            )}
          </div>
          <div className="m-preview-state">
            <span>
              HEAD{" "}
              <code>
                {str(previewRecord.state && record(previewRecord.state).head).slice(0, 10)}
              </code>
            </span>
            <span>预览有效至 {displayTime(str(previewRecord.expiresAt))}</span>
          </div>
          {previewKind === "commit" ? (
            changedFiles.length ? (
              <div className="m-diff-files">
                {changedFiles.map((value, index) => {
                  const file =
                    typeof value === "string"
                      ? value
                      : str(record(value).path, `文件 ${index + 1}`);
                  return (
                    <div key={`${file}-${index}`}>
                      <span>
                        <Code2 size={14} />
                        {file}
                      </span>
                      <Check size={15} className="m-included-file" aria-label="已包含在预览" />
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty title="没有可提交的变更" />
            )
          ) : (
            <div className="m-diff-files">
              {(Array.isArray(previewRecord.commits) ? previewRecord.commits : []).map(
                (value, index) => (
                  <div key={index}>
                    <span>
                      <GitCommitHorizontal size={14} />
                      {str(record(value).subject, "待推送提交")}
                    </span>
                    <code>{str(record(value).sha).slice(0, 9)}</code>
                  </div>
                ),
              )}
            </div>
          )}
          {diff && (
            <pre className="m-diff">
              <code>{diff}</code>
            </pre>
          )}
          {typeof previewRecord.previewId === "string" && (
            <div className="m-approval-buttons">
              {previewKind === "commit" ? (
                <Button
                  variant="secondary"
                  busy={busy}
                  disabled={!online || Date.parse(str(previewRecord.expiresAt)) <= Date.now()}
                  onClick={() => void approveAndExecute()}
                >
                  <GitCommitHorizontal size={16} />
                  批准并提交
                </Button>
              ) : (
                <Button
                  variant="danger"
                  busy={busy}
                  disabled={!online || Date.parse(str(previewRecord.expiresAt)) <= Date.now()}
                  onClick={() => void approveAndExecute()}
                >
                  <ArrowDownToLine size={16} />
                  批准并推送
                </Button>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}

function SettingsView({
  session,
  host,
  providers,
  executors,
  onProviders,
  onConnectors,
  onExecutors,
  onTransfers,
  onLogout,
}: {
  session: CloudSession;
  host: CloudHost | null;
  providers: CloudProvider[];
  executors: CloudExecutor[];
  onProviders: () => void;
  onConnectors: () => void;
  onExecutors: () => void;
  onTransfers: () => void;
  onLogout: () => void;
}) {
  const enabled = executors.filter((executor) => executor.available);
  return (
    <>
      <section className="m-account">
        <span className="m-account-avatar">{session.user.email[0]?.toUpperCase() ?? "A"}</span>
        <div>
          <strong>{session.user.email}</strong>
          <small>Owner 账户 · 会话到期 {displayTime(session.session.expiresAt)}</small>
        </div>
      </section>
      <section className="m-settings-group">
        <span className="m-overline">EXECUTION HOST</span>
        <button className="m-settings-row">
          <span className="settings-icon settings-green">
            {host?.kind === "cloud" ? <Cloud size={18} /> : <Laptop size={18} />}
          </span>
          <span>
            <strong>{host?.name ?? "尚未配置宿主"}</strong>
            <small>{enabled.length} 个可用执行器</small>
          </span>
          <Status value={host?.status ?? "offline"} />
        </button>
      </section>
      <section className="m-settings-group">
        <span className="m-overline">AI & DEVELOPMENT</span>
        <button className="m-settings-row" onClick={onProviders}>
          <span className="settings-icon settings-purple">
            <Sparkles size={18} />
          </span>
          <span>
            <strong>模型 Provider</strong>
            <small>
              {providers.filter((provider) => provider.enabled).length} 个已启用 · 密钥不可回读
            </small>
          </span>
          <ArrowRight size={17} />
        </button>
        <button className="m-settings-row" onClick={onConnectors}>
          <span className="settings-icon settings-blue">
            <Laptop size={18} />
          </span>
          <span>
            <strong>公司电脑连接</strong>
            <small>配对、撤销与连接状态</small>
          </span>
          <ArrowRight size={17} />
        </button>
        <button className="m-settings-row" onClick={onExecutors}>
          <span className="settings-icon settings-purple">
            <Code2 size={18} />
          </span>
          <span>
            <strong>Codex 授权</strong>
            <small>登录当前宿主并检查执行器状态</small>
          </span>
          <ArrowRight size={17} />
        </button>
        <button className="m-settings-row" onClick={onTransfers}>
          <span className="settings-icon settings-amber">
            <ArrowDownToLine size={18} />
          </span>
          <span>
            <strong>取回遗留改动</strong>
            <small>快照采集与隔离导入</small>
          </span>
          <ArrowRight size={17} />
        </button>
      </section>
      <section className="m-settings-group">
        <span className="m-overline">SECURITY</span>
        <button className="m-settings-row" onClick={onLogout}>
          <span className="settings-icon settings-red">
            <LogOut size={18} />
          </span>
          <span>
            <strong>退出登录</strong>
            <small>撤销此浏览器的会话</small>
          </span>
          <ArrowRight size={17} />
        </button>
      </section>
      <Notice>云端和办公室分别配置模型与 Git 凭据。手机页面不会保存模型密钥。</Notice>
    </>
  );
}

function ProviderView({
  host,
  providers,
  bindings,
  allowServerCredentials,
  loading,
  busy,
  onSave,
  onTest,
  onUseForBot,
  onBack,
}: {
  host: CloudHost | null;
  providers: CloudProvider[];
  bindings: AgentModelBinding[];
  allowServerCredentials: boolean;
  loading: boolean;
  busy: boolean;
  onSave: (id: string, body: unknown) => Promise<boolean>;
  onTest: (id: string) => Promise<unknown>;
  onUseForBot: (provider: CloudProvider) => Promise<unknown>;
  onBack: () => void;
}) {
  const online = useOnline();
  const [selected, setSelected] = useState<CloudProvider | null>(null);
  const [name, setName] = useState("");
  const [apiType, setApiType] = useState<"openai-completions" | "anthropic-messages">(
    "openai-completions",
  );
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [serverCredential, setServerCredential] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const open = (provider?: CloudProvider) => {
    setSelected(provider ?? null);
    setName(provider?.name ?? "");
    setApiType(provider?.api ?? "openai-completions");
    setBaseUrl(provider?.baseUrl ?? "");
    setModels(provider?.models.join("\n") ?? "");
    setApiKey("");
    setServerCredential(false);
    setEnabled(provider?.enabled ?? true);
    setShowForm(true);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const list = models
      .split(/[,\n]/)
      .map((model) => model.trim())
      .filter(Boolean);
    if (!list.length || !name.trim()) return;
    const saved = await onSave(selected?.id ?? "new", {
      name: name.trim(),
      api: apiType,
      baseUrl: baseUrl.trim(),
      models: list,
      defaultModel: list[0],
      source: "manual",
      ...(apiKey && allowServerCredentials && serverCredential
        ? { apiKey, credentialPurpose: "server-service" }
        : {}),
      enabled,
    });
    setApiKey("");
    if (saved) setShowForm(false);
  };
  return (
    <>
      <Back onClick={onBack} />
      <div className="m-form-title">
        <span className="m-overline">PROVIDERS · {host?.name}</span>
        <h2>模型配置</h2>
        <p>
          个人 API Key 请在桌面本地配置。此处展示云宿主的独立模型配置；已有云密钥仍保存在服务器。
        </p>
      </div>
      {showForm ? (
        <form className="m-form" onSubmit={(event) => void save(event)}>
          <label className="m-field">
            <span>名称</span>
            <input
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="m-field">
            <span>兼容协议</span>
            <select
              value={apiType}
              onChange={(event) => setApiType(event.target.value as typeof apiType)}
            >
              <option value="openai-completions">OpenAI Completions</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select>
          </label>
          <label className="m-field">
            <span>API 地址</span>
            <input
              type="url"
              required
              maxLength={2048}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <label className="m-field">
            <span>
              模型 ID <small>每行一个</small>
            </span>
            <textarea
              rows={3}
              required
              value={models}
              onChange={(event) => setModels(event.target.value)}
              placeholder="model-name"
            />
          </label>
          {allowServerCredentials ? (
            <label className="m-toggle">
              <input
                type="checkbox"
                checked={serverCredential}
                onChange={(event) => {
                  setServerCredential(event.target.checked);
                  setApiKey("");
                }}
              />
              <span>配置独立服务器服务凭证，允许加密保存在云宿主</span>
            </label>
          ) : (
            <p className="m-hint">
              服务器凭证写入已关闭。电脑离线的云任务需要部署者另外配置云端凭证。
            </p>
          )}
          {allowServerCredentials && serverCredential ? (
            <label className="m-field">
              <span>服务器服务密钥 {selected?.hasKey && <small>留空保留现有云密钥</small>}</span>
              <input
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={selected?.hasKey ? "已加密存储" : "输入 API 密钥"}
              />
            </label>
          ) : null}
          <label className="m-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>启用此 Provider</span>
          </label>
          <div className="m-follow-actions">
            <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
              取消
            </Button>
            <Button type="submit" busy={busy} disabled={!online}>
              保存配置
            </Button>
          </div>
        </form>
      ) : (
        <>
          {loading ? (
            <LoadingRows />
          ) : (
            providers.map((provider) => (
              <div className="m-provider-row" key={provider.id}>
                <span className="settings-icon settings-purple">
                  <Sparkles size={18} />
                </span>
                <span>
                  <strong>{provider.name}</strong>
                  <small>
                    {provider.defaultModel} · {provider.hasKey ? "密钥已配置" : "缺少密钥"}
                  </small>
                </span>
                <Status value={provider.enabled ? "online" : "offline"} />
                <div className="m-provider-actions">
                  <button
                    className="m-icon-button"
                    aria-label={`编辑 ${provider.name}`}
                    onClick={() => open(provider)}
                  >
                    <ChevronDown size={17} />
                  </button>
                  <Button
                    variant="secondary"
                    busy={busy}
                    disabled={!online}
                    onClick={() => void onTest(provider.id)}
                  >
                    测试
                  </Button>
                  <Button
                    variant="secondary"
                    busy={busy}
                    disabled={!online || !provider.enabled || !provider.hasKey}
                    onClick={() => void onUseForBot(provider)}
                  >
                    {["orchestrator", "code", "reviewer"].every((agent) =>
                      bindings.some(
                        (binding) =>
                          binding.agent === agent &&
                          binding.providerId === provider.id &&
                          binding.model === provider.defaultModel,
                      ),
                    )
                      ? "Bot 当前模型"
                      : "用于 Bot 任务"}
                  </Button>
                </div>
              </div>
            ))
          )}
          <Button variant="secondary" className="m-add-provider" onClick={() => open()}>
            <Plus size={16} />
            添加 Provider
          </Button>
        </>
      )}
      <Notice>Codex 登录态是独立执行器能力，不会从这份 Provider 配置导入。</Notice>
      <Notice>
        “用于 Bot 任务”会将该 Provider 的默认模型用于规划、编码与审阅；保存配置不会发起模型请求。
      </Notice>
    </>
  );
}

function LoadingRows({ count = 3 }: { count?: number }) {
  return (
    <div className="m-skeletons" aria-label="加载中">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}
