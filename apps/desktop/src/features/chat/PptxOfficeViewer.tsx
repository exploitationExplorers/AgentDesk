import { useEffect, useMemo, useState } from "react";
import { Spinner } from "@agentdesk/ui";

/**
 * 与 WorkBuddy 一致：右侧用 iframe 加载独立幻灯片页 `/slide/pc.html`
 *（对方是腾讯文档 sandbox；我们用 vue-office 同系 pptx-preview 预览）。
 */
export function PptxOfficeViewer({ url, fileName }: { url: string; fileName?: string }) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const title = fileName?.endsWith(".pptx") ? fileName : `${fileName ?? "演示文稿"}.pptx`;
  const src = useMemo(() => {
    const base = import.meta.env.BASE_URL.endsWith("/")
      ? import.meta.env.BASE_URL
      : `${import.meta.env.BASE_URL}/`;
    const params = new URLSearchParams({
      src: url,
      title,
      hideTitlebar: "1",
      client: "sdk_local_ad",
    });
    return `${base}slide/pc.html?${params.toString()}`;
  }, [url, title]);

  useEffect(() => {
    setLoading(true);
    setFailed(false);
  }, [src]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-[#f5f5f5]">
      {loading ? (
        <div
          role="status"
          className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-surface/90 text-sm text-muted"
        >
          <Spinner />
          正在打开演示文稿…
        </div>
      ) : null}
      {failed ? (
        <p role="alert" className="p-4 text-sm text-muted">
          暂时无法打开 PPT 预览，请稍后重试或下载文件查看。
        </p>
      ) : null}
      <iframe
        key={src}
        title={title}
        src={src}
        allow="clipboard-read; clipboard-write; fullscreen"
        tabIndex={-1}
        aria-label="PPTX 成果预览"
        onLoad={() => setLoading(false)}
        onError={() => {
          setLoading(false);
          setFailed(true);
        }}
        className="block h-full min-h-[320px] w-full flex-1 border-0 bg-[#f5f5f5]"
        style={{ display: failed ? "none" : "block" }}
      />
    </div>
  );
}
