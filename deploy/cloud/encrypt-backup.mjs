import { createCipheriv, randomBytes, publicEncrypt, createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";

const [file, publicKeyFile] = process.argv.slice(2);
if (!file || !publicKeyFile) throw new Error("Usage: encrypt-backup.mjs <file> <RSA-public-key>");
const key = randomBytes(32),
  iv = randomBytes(12),
  hash = createHash("sha256");
for await (const chunk of createReadStream(file)) hash.update(chunk);
const cipher = createCipheriv("aes-256-gcm", key, iv);
await pipeline(
  createReadStream(file),
  cipher,
  createWriteStream(`${file}.enc`, { mode: 0o600, flags: "wx" }),
);
writeFileSync(
  `${file}.encryption.json`,
  JSON.stringify(
    {
      algorithm: "AES-256-GCM",
      keyWrapping: "RSA-OAEP-SHA256",
      encryptedKey: publicEncrypt(
        { key: readFileSync(publicKeyFile), oaepHash: "sha256" },
        key,
      ).toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      plaintextSha256: hash.digest("hex"),
    },
    null,
    2,
  ),
  { mode: 0o600, flag: "wx" },
);
key.fill(0);
unlinkSync(file);
