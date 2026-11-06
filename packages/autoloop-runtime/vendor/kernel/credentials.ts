// Run tokens and card links derive from the master key, so they're never stored. Access keys are kept only as hashes.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { rows, type View } from "./evolve.ts";

export type Environment = { secret: string; publicUrl: string };

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export const credential = (env: Environment, purpose: string, ...parts: unknown[]) =>
  createHmac("sha256", env.secret)
    .update(JSON.stringify([purpose, ...parts]))
    .digest("base64url");

/** What a card is found by from its link, which isn't stored. */
export const cardHash = (env: Environment, id: unknown, at: unknown) => digest(credential(env, "card", id, at));

export function whose(view: View, kind: string, key: string): string | null {
  if (!key) return null;
  const given = Buffer.from(digest(key), "hex");
  const found = rows(view, "keys").find(
    (row) => row.kind === kind && timingSafeEqual(Buffer.from(row.hash, "hex"), given),
  );
  return found?.name ?? null;
}
