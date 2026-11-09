import { useState } from "react";
import {
  type CloudApi,
  type CloudExecutor,
  type CloudHost,
  cloudPath,
  errorMessage,
} from "../../lib/cloud-api";
import { Back, Button, Notice } from "./components";
import { useCloudQuery, useOnline } from "./hooks";

interface DeviceLogin {
  verificationUrl: string;
  userCode: string;
}

export function ExecutorsView({
  api,
  host,
  onBack,
}: {
  api: CloudApi;
  host: CloudHost | null;
  onBack: () => void;
}) {
  const online = useOnline();
  const [login, setLogin] = useState<DeviceLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const query = useCloudQuery<{ executors: CloudExecutor[] }>(
    api,
    host ? cloudPath("hosts", host.id, "executors") : null,
  );
  const codex = query.data?.executors.find((item) => item.id === "codex");
  const action = async (start: boolean) => {
    if (!host) return;
    setBusy(true);
    setError("");
    try {
      if (start) {
        const result = await api.request<DeviceLogin>(
          cloudPath("hosts", host.id, "executors", "codex", "login"),
          {},
        );
        const url = new URL(result.verificationUrl);
        if (
          url.protocol !== "https:" ||
          !["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(url.hostname) ||
          url.username ||
          url.password
        )
          throw new Error("授权链接无法验证，请重新发起登录。");
        setLogin(result);
      } else {
        const result = await api.request<CloudExecutor>(
          cloudPath("hosts", host.id, "executors", "codex", "login-status"),
          {},
        );
        if (result.available) setLogin(null);
        else setError(result.reason ?? "授权尚未完成，请在授权页面操作后重试。");
      }
      query.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Back onClick={onBack} />
      <div className="m-form-title">
        <span className="m-overline">CODEX</span>
        <h2>Codex 授权</h2>
      </div>
      <Notice>当前宿主：{host?.name ?? "未选择宿主"}。授权仅用于这台宿主的远程任务。</Notice>
      {(error || query.error) && <Notice>{error || query.error}</Notice>}
      <section className="m-settings-group">
        <p>{codex?.available ? "Codex 已就绪" : (codex?.reason ?? "正在检查 Codex 状态")}</p>
        <p>在 OpenAI 授权页面输入下方设备码，完成后返回检查状态。设备码仅在当前页面显示。</p>
        {login && (
          <div className="m-device-card">
            <div>
              <strong>设备码</strong>
              <p>
                <code>{login.userCode}</code>
              </p>
            </div>
            <a href={login.verificationUrl} target="_blank" rel="noopener noreferrer">
              打开 OpenAI 授权页面
            </a>
          </div>
        )}
        <Button
          disabled={busy || !online || !host || host.status !== "online"}
          onClick={() => void action(true)}
        >
          {login ? "重新获取设备码" : "在此宿主登录 Codex"}
        </Button>
        <Button
          disabled={busy || !online || !host || host.status !== "online"}
          onClick={() => void action(false)}
        >
          检查授权状态
        </Button>
      </section>
    </>
  );
}
