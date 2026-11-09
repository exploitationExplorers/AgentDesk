import { useEffect, useRef, useState } from "react";
import type { SnapshotManifest } from "@agentdesk/shared";
import {
  cloudPath,
  errorMessage,
  requestId,
  type CloudApi,
  type CloudHost,
  type CloudProject,
} from "../../lib/cloud-api";
import { Back, Button, Notice, Status } from "./components";
import { useCloudQuery, useOnline } from "./hooks";

interface Transfer {
  id: string;
  state: string;
  bytes: number;
  error?: string;
  manifest: SnapshotManifest;
  manifestDigest: string;
  result?: { projectId: string; branch: string };
}
const stateLabels: Record<string, string> = {
  transferring: "正在传输",
  ready: "等待恢复确认",
  importing: "正在恢复并校验",
  verified: "恢复已验证",
  paused: "传输已暂停",
  failed: "恢复失败，现场已保留",
};

export function TransfersView({
  api,
  hosts,
  onBack,
}: {
  api: CloudApi;
  hosts: CloudHost[];
  onBack: () => void;
}) {
  const online = useOnline();
  const [sourceHost, setSourceHost] = useState("");
  const [sourceProject, setSourceProject] = useState("");
  const [targetProject, setTargetProject] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [fetchRef, setFetchRef] = useState("");
  const attempts = useRef<{
    key: string;
    snapshot: string;
    transfer: string;
    snapshotId?: string;
  } | null>(null);
  const source = useCloudQuery<{ projects: CloudProject[] }>(
    api,
    sourceHost ? cloudPath("hosts", sourceHost, "projects") : null,
  );
  const targets = useCloudQuery<{ projects: CloudProject[] }>(
    api,
    cloudPath("hosts", "cloud", "projects"),
  );
  const changes = useCloudQuery<{
    files: { path: string; previousPath: string | null; kind: string }[];
  }>(
    api,
    sourceProject
      ? cloudPath("hosts", sourceHost, "projects", sourceProject, "git", "status")
      : null,
  );
  const history = useCloudQuery<{ transfers: Transfer[] }>(api, cloudPath("transfers"));
  const refreshHistory = history.refresh;
  const transferId = transfer?.id,
    transferState = transfer?.state;
  useEffect(() => {
    if (!transferId || !["transferring", "importing"].includes(transferState ?? "")) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.request<Transfer>(
          cloudPath("transfers", transferId),
          undefined,
          "GET",
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setTransfer(next);
        if (["transferring", "importing"].includes(next.state))
          timer = setTimeout(() => void poll(), 2000);
        else refreshHistory();
      } catch (err) {
        if (!abort.signal.aborted) setError(errorMessage(err));
      }
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, transferId, transferState, refreshHistory]);
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
  const start = () =>
    action(async () => {
      const key = JSON.stringify([sourceHost, sourceProject, targetProject, files]);
      if (attempts.current?.key !== key)
        attempts.current = { key, snapshot: requestId(), transfer: requestId() };
      const attempt = attempts.current;
      if (!attempt.snapshotId) {
        const captured = await api.request<{ snapshotId: string }>(
          cloudPath("hosts", sourceHost, "projects", sourceProject, "snapshots"),
          {
            clientRequestId: attempt.snapshot,
            files,
          },
        );
        attempt.snapshotId = captured.snapshotId;
      }
      setTransfer(
        await api.request<Transfer>(cloudPath("transfers"), {
          clientRequestId: attempt.transfer,
          sourceHostId: sourceHost,
          sourceProjectId: sourceProject,
          snapshotId: attempt.snapshotId,
          targetProjectId: targetProject,
        }),
      );
      refreshHistory();
    });
  return (
    <>
      <Back onClick={onBack} />
      <div className="m-form-title">
        <span className="m-overline">WORKSPACE TRANSFER</span>
        <h2>取回遗留改动</h2>
      </div>
      <Notice>
        选择电脑上未提交的文件，恢复到云端的新工作区。源目录保持原样。请先停止其他程序对所选文件的写入。
      </Notice>
      {(error || source.error || targets.error || changes.error) && (
        <Notice>{error || source.error || targets.error || changes.error}</Notice>
      )}
      <label className="m-field">
        来源电脑
        <select
          value={sourceHost}
          onChange={(e) => {
            setSourceHost(e.target.value);
            setSourceProject("");
            setFiles([]);
          }}
        >
          <option value="">选择在线电脑</option>
          {hosts
            .filter((h) => h.kind === "office")
            .map((host) => (
              <option key={host.id} value={host.id} disabled={host.status !== "online"}>
                {host.name} · {host.status === "online" ? "在线" : "离线"}
              </option>
            ))}
        </select>
      </label>
      <label className="m-field">
        来源项目
        <select
          value={sourceProject}
          onChange={(e) => {
            setSourceProject(e.target.value);
            setFiles([]);
          }}
        >
          <option value="">选择项目</option>
          {source.data?.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="m-field">
        云端对应仓库
        <select value={targetProject} onChange={(e) => setTargetProject(e.target.value)}>
          <option value="">选择具有相同 Git 基线的仓库</option>
          {targets.data?.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <details>
        <summary>云端缺少电脑上的 Git 提交</summary>
        <p>
          先切换到公司电脑项目，在 Git
          操作中检查待推送提交，指定临时分支并单独批准推送。然后在这里填写该分支，将已公开到远端的提交取到云端。
        </p>
        <label className="m-field">
          远端临时分支
          <input
            placeholder="refs/heads/recovery/office"
            value={fetchRef}
            onChange={(event) => setFetchRef(event.target.value)}
          />
        </label>
        <Button
          disabled={!online || busy || !targetProject || !fetchRef.startsWith("refs/heads/")}
          onClick={() =>
            void action(async () => {
              await api.request(cloudPath("hosts", "cloud", "repository-fetch"), {
                projectId: targetProject,
                ref: fetchRef,
              });
              setError("基线提交已获取，请重新点击采集与传输。");
            })
          }
        >
          获取已批准推送的基线
        </Button>
      </details>
      <div className="m-file-list">
        {changes.data?.files.map((file) => (
          <label
            key={file.path}
            style={{ display: "block", padding: "12px 0", overflowWrap: "anywhere" }}
          >
            <input
              type="checkbox"
              checked={files.includes(file.path)}
              disabled={busy}
              onChange={(e) =>
                setFiles((previous) => {
                  const selected = [file.path, ...(file.previousPath ? [file.previousPath] : [])];
                  return e.target.checked
                    ? [...new Set([...previous, ...selected])]
                    : previous.filter((p) => !selected.includes(p));
                })
              }
            />
            {file.path} <small>{file.kind}</small>
          </label>
        ))}
      </div>
      <Button
        className="m-wide-action"
        disabled={busy || !online || !files.length || !sourceProject || !targetProject}
        onClick={() => void start()}
      >
        采集所选文件并传到云端
      </Button>
      {transfer && (
        <section className="m-pairing-result">
          <Status value={stateLabels[transfer.state] ?? transfer.state} />
          <p>已传输 {(transfer.bytes / 1024).toFixed(1)} KB</p>
          <p>
            基线 <code>{transfer.manifest.sourceHead.slice(0, 12)}</code> ·{" "}
            {transfer.manifest.entries.length} 个文件
          </p>
          {transfer.error && <Notice>{transfer.error}</Notice>}
          <details>
            <summary>查看恢复清单与排除项</summary>
            {transfer.manifest.entries.map((entry) => (
              <p key={entry.path} style={{ overflowWrap: "anywhere" }}>
                {entry.kind === "deleted" ? "删除" : "恢复"}：{entry.path}
                {entry.kind === "file" ? `（${entry.size} 字节）` : ""}
              </p>
            ))}
            {transfer.manifest.exclusions.map((entry) => (
              <p key={entry.path}>排除：{entry.path}</p>
            ))}
          </details>
          {transfer.state === "ready" && (
            <Button
              disabled={busy || !online}
              onClick={() =>
                void action(async () =>
                  setTransfer(
                    await api.request<Transfer>(cloudPath("transfers", transfer.id, "import"), {
                      manifestDigest: transfer.manifestDigest,
                    }),
                  ),
                )
              }
            >
              按此清单恢复到新工作区
            </Button>
          )}
          {transfer.state === "paused" && (
            <Button
              disabled={busy || !online}
              onClick={() =>
                void action(async () =>
                  setTransfer(
                    await api.request<Transfer>(cloudPath("transfers", transfer.id, "resume"), {}),
                  ),
                )
              }
            >
              继续传输
            </Button>
          )}
          {transfer.state === "verified" && (
            <Notice>
              恢复完成，分支 {transfer.result?.branch}。可返回工作区列表，在云端新项目中继续开发。
            </Notice>
          )}
        </section>
      )}
      {!!history.data?.transfers.length && (
        <section>
          <h3>最近传输</h3>
          {history.data.transfers.map((item) => (
            <Button
              key={item.id}
              onClick={() =>
                void action(async () =>
                  setTransfer(await api.request<Transfer>(cloudPath("transfers", item.id))),
                )
              }
            >
              {stateLabels[item.state] ?? item.state} · {item.manifest.entries.length} 个文件
            </Button>
          ))}
        </section>
      )}
    </>
  );
}
