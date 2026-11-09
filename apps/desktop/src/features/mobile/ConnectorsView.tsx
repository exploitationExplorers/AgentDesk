import { useEffect, useState } from "react";
import type { DeviceIdentity } from "@agentdesk/shared";
import { type CloudApi, cloudPath, errorMessage, type CloudHost } from "../../lib/cloud-api";
import { Back, Button, Empty, Notice, Status } from "./components";
import { displayTime, useCloudQuery, useOnline } from "./hooks";

interface Pairing {
  id: string;
  code?: string;
  expiresAt: string;
  device?: {
    id: string;
    identity: DeviceIdentity;
    fingerprint: string;
    state: string;
    projects: string[];
  } | null;
}

export function ConnectorsView({ api, onBack }: { api: CloudApi; onBack: () => void }) {
  const online = useOnline();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const hosts = useCloudQuery<{ hosts: CloudHost[] }>(api, cloudPath("hosts"));
  const refreshHosts = hosts.refresh;
  const pairingId = pairing?.id;
  const pairingState = pairing?.device?.state;
  useEffect(() => {
    if (!pairingId || pairingState === "active") return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await api.request<Pairing>(
          cloudPath("device-pairings", pairingId),
          undefined,
          "GET",
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setPairing((previous) =>
          previous?.id === pairingId ? { ...result, code: previous.code } : previous,
        );
        if (result.device?.state === "active") {
          refreshHosts();
          return;
        }
        timer = setTimeout(() => void poll(), 3000);
      } catch (err) {
        if (!abort.signal.aborted) setError(errorMessage(err));
      }
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, pairingId, pairingState, refreshHosts]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
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
        <span className="m-overline">DEVICE CONNECTOR</span>
        <h2>连接公司电脑</h2>
      </div>
      {(error || hosts.error) && <Notice>{error || hosts.error}</Notice>}
      <Notice>
        在电脑终端完成配对，选择允许手机操作的项目。电脑在线时可以查看任务和提交改动。
      </Notice>
      {hosts.data?.hosts
        .filter((h) => h.kind === "office")
        .map((host) => (
          <div className="m-device-card" key={host.id}>
            <div>
              <strong>{host.name}</strong>
              <small>
                {host.status === "online"
                  ? "电脑已连接"
                  : `离线 · 最近连接 ${displayTime(host.lastSeen)}`}
              </small>
            </div>
            <Button disabled={busy || !online} onClick={() => setRevokeId(host.id)}>
              撤销连接
            </Button>
            {revokeId === host.id && (
              <div>
                <Notice>撤销后需在电脑重新配对，才能再次接收手机操作。</Notice>
                <Button
                  disabled={busy || !online}
                  onClick={() =>
                    void action(async () => {
                      await api.request(cloudPath("hosts", host.id, "revoke"), {});
                      setRevokeId(null);
                      hosts.refresh();
                    })
                  }
                >
                  确认撤销 {host.name}
                </Button>
                <Button onClick={() => setRevokeId(null)}>取消</Button>
              </div>
            )}
          </div>
        ))}
      {!pairing && (
        <Empty title="配对一台电脑">一次性配对码 5 分钟内有效，手机与电脑均需确认。</Empty>
      )}
      <Button
        disabled={busy || !online}
        className="m-wide-action"
        onClick={() =>
          void action(async () => {
            setPairing(await api.request<Pairing>(cloudPath("device-pairings"), {}));
            setSelected([]);
          })
        }
      >
        {pairing ? "重新生成配对码" : "创建一次性配对码"}
      </Button>
      {pairing && (
        <section className="m-pairing-result">
          <span>在电脑运行</span>
          <code style={{ overflowWrap: "anywhere" }}>
            agentdesk connect pair --server {location.origin}
          </code>
          <span>在终端输入此配对码</span>
          <strong style={{ overflowWrap: "anywhere" }}>{pairing.code}</strong>
          <span>有效至 {displayTime(pairing.expiresAt)}</span>
          {pairing.device ? (
            <>
              <h3>{pairing.device.identity.name}</h3>
              <p>
                {pairing.device.identity.platform} · 实例 {pairing.device.identity.instanceId}
              </p>
              <p>与电脑核对指纹</p>
              <code style={{ overflowWrap: "anywhere" }}>{pairing.device.fingerprint}</code>
              {pairing.device.identity.projects.map((project) => (
                <label
                  key={project.id}
                  style={{ display: "block", padding: "12px 0", overflowWrap: "anywhere" }}
                >
                  <input
                    type="checkbox"
                    checked={
                      pairing.device!.state === "pending"
                        ? selected.includes(project.id)
                        : pairing.device!.projects.includes(project.id)
                    }
                    disabled={pairing.device!.state !== "pending" || busy}
                    onChange={(e) =>
                      setSelected((previous) =>
                        e.target.checked
                          ? [...previous, project.id]
                          : previous.filter((id) => id !== project.id),
                      )
                    }
                  />
                  {project.name}
                  <small style={{ display: "block" }}>{project.path}</small>
                </label>
              ))}
              {pairing.device.state === "pending" ? (
                <Button
                  disabled={busy || !online || !selected.length}
                  onClick={() =>
                    void action(async () => {
                      const result = await api.request<{ device: NonNullable<Pairing["device"]> }>(
                        cloudPath("device-pairings", pairing.id, "confirm"),
                        {
                          fingerprint: pairing.device!.fingerprint,
                          projects: selected,
                        },
                      );
                      setPairing({ ...pairing, device: result.device });
                    })
                  }
                >
                  指纹一致，授权所选项目
                </Button>
              ) : (
                <Status
                  value={pairing.device.state === "active" ? "配对完成" : "等待电脑最终确认"}
                />
              )}
            </>
          ) : (
            <p>等待电脑输入配对码…</p>
          )}
        </section>
      )}
    </>
  );
}
