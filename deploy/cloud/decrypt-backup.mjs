import { createDecipheriv, privateDecrypt, createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  readFileSync,
  renameSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";

const [file, privateKeyFile, output] = process.argv.slice(2);
if (!file?.endsWith(".enc") || !privateKeyFile || !output || existsSync(output))
  throw new Error("Usage: decrypt-backup.mjs <file.enc> <RSA-private-key> <new-output-file>");
const metadata = JSON.parse(readFileSync(`${file.slice(0, -4)}.encryption.json`, "utf8"));
if (metadata.algorithm !== "AES-256-GCM" || metadata.keyWrapping !== "RSA-OAEP-SHA256")
  throw new Error("Unsupported backup format");
const key = privateDecrypt(
  { key: readFileSync(privateKeyFile), oaepHash: "sha256" },
  Buffer.from(metadata.encryptedKey, "base64"),
);
const temporary = `${output}.partial`;
try {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(metadata.iv, "base64"));
  decipher.setAuthTag(Buffer.from(metadata.tag, "base64"));
  await pipeline(
    createReadStream(file),
    decipher,
    createWriteStream(temporary, { mode: 0o600, flags: "wx" }),
  );
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(temporary)) hash.update(chunk);
  if (hash.digest("hex") !== metadata.plaintextSha256) throw new Error("Backup checksum mismatch");
  renameSync(temporary, output);
  console.info("Backup authenticated and decrypted");
} catch (error) {
  if (existsSync(temporary)) unlinkSync(temporary);
  throw error;
} finally {
  key.fill(0);
}
