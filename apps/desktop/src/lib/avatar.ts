import type { AppSettings } from "@agentdesk/shared";
import { api } from "./api";

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/** 把用户选的图片裁成正方形头像，避免把原图塞进设置。 */
export async function fileToAvatar(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  if (file.size > MAX_SOURCE_BYTES) throw new Error("图片不能超过 8 MB");
  const bitmap = await createImageBitmap(file);
  try {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法处理这张图片");
    const scale = Math.max(size / bitmap.width, size / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    ctx.drawImage(bitmap, (size - width) / 2, (size - height) / 2, width, height);
    return canvas.toDataURL("image/jpeg", 0.86);
  } finally {
    bitmap.close();
  }
}

export async function saveAvatar(file: File | null): Promise<AppSettings> {
  const avatar = file ? await fileToAvatar(file) : "";
  return api.updateSettings({ avatar });
}
