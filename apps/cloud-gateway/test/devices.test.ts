import { generateKeyPairSync, sign } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { devicePairProof, deviceProof, type DeviceIdentity } from "@agentdesk/shared";
import { DeviceStore } from "../src/devices/store";
async function fixture() {
  let now = Date.now();
  const db = new Database(":memory:");
  const store = new DeviceStore(db, "p".repeat(32), "https://agent.example.com", () => now);
  const actor = {
    userId: "owner",
    sessionId: "session",
    recentAuthAt: new Date(now).toISOString(),
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const identity: DeviceIdentity = {
    name: "Work PC",
    platform: "win32",
    instanceId: crypto.randomUUID(),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    projects: [{ id: "im", name: "IM", path: "D:/work/im" }],
  };
  const pair = await store.createPairing(actor);
  const signature = sign(
    null,
    Buffer.from(devicePairProof(store.origin, pair.code, identity)),
    privateKey,
  ).toString("base64");
  const claim = async () => await store.claim(pair.code, identity, signature);
  const prove = async (hostId: string, purpose: "status" | "confirm" | "connect" | "revoke") => {
    const challenge = await store.challenge(hostId, purpose);
    const signature = sign(
      null,
      Buffer.from(deviceProof(store.origin, hostId, purpose, challenge.nonce)),
      privateKey,
    ).toString("base64");
    return {
      challenge,
      signature,
      auth: async () => await store.authenticate(challenge.id, signature),
    };
  };
  return {
    db,
    store,
    actor,
    pair,
    claim,
    prove,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe("device pairing and reconnect authorization", () => {
  it("requires both confirmations, consumes codes/nonces/tokens once, fences epochs and revocation", async () => {
    const f = await fixture();
    try {
      const claim = await f.claim();
      await expect(f.claim()).rejects.toThrow();
      await expect(f.store.token(claim.hostId)).rejects.toThrow();
      await expect(f.store.localConfirm(claim.hostId)).rejects.toThrow();
      await expect(
        f.store.confirmPairing(f.actor, f.pair.id, claim.fingerprint, ["other"]),
      ).rejects.toThrow();
      await f.store.confirmPairing(f.actor, f.pair.id, claim.fingerprint, ["im"]);
      const local = await f.prove(claim.hostId, "confirm");
      expect((await local.auth()).purpose).toBe("confirm");
      await expect(local.auth()).rejects.toThrow();
      await f.store.localConfirm(claim.hostId);
      const token = await f.store.token(claim.hostId);
      const first = await f.store.consumeToken(token.token);
      expect(first.epoch).toBe(1);
      await expect(f.store.consumeToken(token.token)).rejects.toThrow();
      const second = await f.store.consumeToken((await f.store.token(claim.hostId)).token);
      expect(second.epoch).toBe(2);
      expect(await f.store.heartbeat(first.id, 1)).toBe(false);
      expect(await f.store.heartbeat(first.id, 2)).toBe(true);
      await f.store.revoke(first.id, f.actor);
      await expect(f.store.token(first.id)).rejects.toThrow();
      await expect(f.store.challenge(first.id, "connect")).rejects.toThrow();
    } finally {
      f.db.close();
    }
  });
  it("rejects expired pairings, expired challenges, mismatched signatures and foreign owners", async () => {
    const f = await fixture();
    try {
      const claim = await f.claim();
      await expect(f.store.get(claim.hostId, "stranger")).rejects.toThrow();
      await expect(
        f.store.confirmPairing({ ...f.actor, userId: "stranger" }, f.pair.id, claim.fingerprint, [
          "im",
        ]),
      ).rejects.toThrow();
      const proof = await f.prove(claim.hostId, "status");
      await expect(f.store.authenticate(proof.challenge.id, "bad")).rejects.toThrow();
      f.advance(30001);
      await expect(proof.auth()).rejects.toThrow();
      f.advance(300000);
      await expect(
        f.store.confirmPairing(f.actor, f.pair.id, claim.fingerprint, ["im"]),
      ).rejects.toThrow();
    } finally {
      f.db.close();
    }
  });
});
