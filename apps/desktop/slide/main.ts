import JSZip from "jszip";
import { init } from "pptx-preview";

/** WorkBuddy 同款：/slide/pc.html 独立页；vue-office 同系 pptx-preview 渲染。 */

function params() {
  const query = new URLSearchParams(location.search);
  return {
    src: query.get("src") ?? "",
    title: query.get("title") ?? "演示文稿.pptx",
  };
}

function showStatus(message: string | null) {
  const el = document.getElementById("status");
  if (!el) return;
  if (!message) {
    el.dataset.show = "0";
    el.textContent = "";
    return;
  }
  el.dataset.show = "1";
  el.textContent = message;
}

/**
 * 部分生成器会在 [Content_Types].xml 里声明不存在的 slideMaster/layout。
 * pptx-preview 读到缺失 Part 会整段静默失败 → 黑屏 0 页。预览前剔掉幽灵 Override。
 */
function assertPptxZip(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error("文件还不是可预览的 PowerPoint，请等生成完成后再打开");
  }
}

async function sanitizePptxBuffer(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  assertPptxZip(buffer);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error("演示文稿文件不完整或已损坏，请重新生成后再预览");
  }
  const ctFile = zip.file("[Content_Types].xml");
  if (!ctFile) return buffer;

  const original = await ctFile.async("string");
  const cleaned = original.replace(/<Override\b[^>]*\/>/g, (tag) => {
    const match = /PartName="([^"]+)"/.exec(tag);
    const partName = match?.[1];
    if (!partName) return tag;
    const part = partName.replace(/^\//, "");
    return zip.file(part) ? tag : "";
  });
  if (cleaned === original) return buffer;

  zip.file("[Content_Types].xml", cleaned);
  return zip.generateAsync({ type: "arraybuffer" });
}

async function boot() {
  const { src, title } = params();
  const host = document.getElementById("pre-container");
  if (!host) return;
  document.title = title;
  if (!src) {
    showStatus("缺少演示文稿地址");
    return;
  }

  showStatus("正在打开演示文稿…");
  try {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`download ${response.status}`);
    const raw = await response.arrayBuffer();
    const buffer = await sanitizePptxBuffer(raw);
    showStatus(null);
    const width = Math.max(host.clientWidth || window.innerWidth, 320);
    const height = Math.max(host.clientHeight || window.innerHeight, 240);
    const viewer = init(host, { width, height });
    await viewer.preview(buffer);
    if (!viewer.slideCount) {
      showStatus("无法解析演示文稿内容");
      return;
    }
    window.addEventListener("pagehide", () => viewer.destroy(), { once: true });
  } catch (cause) {
    showStatus(cause instanceof Error ? cause.message : "无法打开演示文稿");
  }
}

void boot();
