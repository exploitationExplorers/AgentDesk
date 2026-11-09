import { useEffect, useState } from "react";
import {
  type CloudApi,
  type CloudHost,
  cloudPath,
  errorMessage,
  requestId,
} from "../../lib/cloud-api";
import { Back, Button, Notice } from "./components";
import { useCloudQuery, useOnline } from "./hooks";

interface Import {
  id: string;
  repository: string;
  status: string;
  projectId: string | null;
}
export function RepositorySetupView({
  api,
  host,
  onBack,
}: {
  api: CloudApi;
  host: CloudHost | null;
  onBack: () => void;
}) {
  const online = useOnline(),
    [url, setUrl] = useState(""),
    [username, setUsername] = useState("x-access-token"),
    [token, setToken] = useState("");
  const [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<{ id: string; key: string } | null>(null);
  const path = host?.kind === "cloud" ? cloudPath("hosts", host.id) : null;
  const imports = useCloudQuery<{ imports: Import[] }>(
    api,
    path ? `${path}/repository-imports` : null,
  );
  const pending = imports.data?.imports.some((item) => item.status === "running");
  const refresh = imports.refresh;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [pending, refresh]);
  const act = async (action: "save" | "test" | "import") => {
    if (!path) return;
    setBusy(true);
    setMessage("");
    try {
      if (action === "save") {
        await api.request(`${path}/git-credentials`, { url, username, token });
        setToken("");
        setMessage("访问凭据已加密保存。");
      }
      if (action === "test") {
        await api.request(`${path}/git-credentials/test`, { url });
        setMessage("仓库可读取。推送权限会在单独审阅并批准 push 时验证。");
      }
      if (action === "import") {
        const key = JSON.stringify({ url, name, email }),
          id = attempt?.key === key ? attempt.id : requestId();
        setAttempt({ id, key });
        await api.request(`${path}/repository-imports`, { url, name, email, clientRequestId: id });
        imports.refresh();
        setMessage("仓库导入已提交，可以离开页面，稍后查看结果。");
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  if (!path)
    return (
      <>
        <Back onClick={onBack} />
        <Notice>请切换到云端添加仓库。公司电脑项目在配对时选择。</Notice>
      </>
    );
  return (
    <>
      <Back onClick={onBack} />
      <div className="m-form-title">
        <span className="m-overline">CLOUD REPOSITORY</span>
        <h2>添加云端仓库</h2>
      </div>
      <Notice>当前宿主：{host?.name}。支持 GitHub、Gitee 的 HTTPS 仓库地址。</Notice>
      {(message || imports.error) && <Notice>{message || imports.error}</Notice>}
      <div className="m-form">
        <label className="m-field">
          <span>仓库地址</span>
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://github.com/owner/repository.git"
            autoComplete="off"
          />
        </label>
        <details>
          <summary>私有仓库访问凭据</summary>
          <p>填写仅授权此仓库的 HTTPS token。公开仓库可跳过。</p>
          <label className="m-field">
            <span>Git 用户名</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="m-field">
            <span>仓库 token</span>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="new-password"
            />
          </label>
          <Button disabled={busy || !online || !url || !token} onClick={() => void act("save")}>
            保存访问凭据
          </Button>
        </details>
        <Button disabled={busy || !online || !url} onClick={() => void act("test")}>
          检查仓库访问
        </Button>
        <label className="m-field">
          <span>Git 提交姓名</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
          />
        </label>
        <label className="m-field">
          <span>Git 提交邮箱</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
          />
        </label>
        <Button
          disabled={busy || pending || !online || !url || !name || !email}
          onClick={() => void act("import")}
        >
          导入为云端项目
        </Button>
      </div>
      <section className="m-settings-group">
        <h3>导入记录</h3>
        {imports.data?.imports.map((item) => (
          <div className="m-device-card" key={item.id}>
            <div>
              <strong>{item.repository}</strong>
              <p>
                {(
                  {
                    running: "正在导入",
                    succeeded: "导入完成",
                    failed: "导入失败，请检查仓库地址与凭据",
                    interrupted: "上次导入被中断，现场已保留",
                  } as Record<string, string>
                )[item.status] ?? item.status}
              </p>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
