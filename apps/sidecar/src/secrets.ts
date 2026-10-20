import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { secrets } from "./db/schema";

export type SecretBackend = "keychain" | "dev-file";

/**
 * 信封加密：主密钥由 Tauri 存在系统钥匙串（Windows 凭据管理器）并在启动时注入，
 * 数据库只保存密文。脱离 Tauri 单独运行 sidecar 时，退化为数据目录下的开发密钥文件。
 */
export class SecretStore {
  readonly backend: SecretBackend;
  private readonly key: Buffer;
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly db: Db,
    masterKey: string | null,
    dataDir: string,
  ) {
    if (masterKey) {
      this.key = Buffer.from(masterKey, "base64");
      this.backend = "keychain";
    } else {
      const file = join(dataDir, "dev-master.key");
      if (!existsSync(file))
        writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
      this.key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
      this.backend = "dev-file";
    }
    if (this.key.length !== 32) throw new Error("主密钥长度必须是 32 字节");
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  private decrypt(payload: string): string {
    const buf = Buffer.from(payload, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
  }

  set(id: string, value: string): void {
    const now = new Date().toISOString();
    const ciphertext = this.encrypt(value);
    this.db
      .insert(secrets)
      .values({ id, ciphertext, updatedAt: now })
      .onConflictDoUpdate({ target: secrets.id, set: { ciphertext, updatedAt: now } })
      .run();
    this.cache.set(id, value);
  }

  get(id: string): string | null {
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const row = this.db.select().from(secrets).where(eq(secrets.id, id)).get();
    if (!row) return null;
    try {
      const value = this.decrypt(row.ciphertext);
      this.cache.set(id, value);
      return value;
    } catch {
      // 主密钥变化（例如钥匙串被清空）导致无法解密
      return null;
    }
  }

  has(id: string): boolean {
    return this.get(id) !== null;
  }

  delete(id: string): void {
    this.db.delete(secrets).where(eq(secrets.id, id)).run();
    this.cache.delete(id);
  }
}
