import { generateKeyPairSync, sign } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { devicePairProof, deviceProof, type DeviceIdentity } from "@agentdesk/shared";
import { DeviceStore } from "../src/devices/store";

function fixture() {
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
  const pair = store.createPairing(actor);
  const signature = sign(
    null,
    Buffer.from(devicePairProof(store.origin, pair.code, identity)),
    privateKey,
  ).toString("base64");
  const claim = () => store.claim(pair.code, identity, signature);
  const prove = (hostId: string, purpose: "status" | "confirm" | "connect" | "revoke") => {
    const challenge = store.challenge(hostId, purpose);
    const signature = sign(
      null,
      Buffer.from(deviceProof(store.origin, hostId, purpose, challenge.nonce)),
      privateKey,
    ).toString("base64");
    return { challenge, signature, auth: () => store.authenticate(challenge.id, signature) };
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
  it("requires both confirmations, consumes codes/nonces/tokens once, fences epochs and revocation", () => {
    const f = fixture();
    try {
      const claim = f.claim();
      expect(() => f.claim()).toThrow();
      expect(() => f.store.token(claim.hostId)).toThrow();
      expect(() => f.store.localConfirm(claim.hostId)).toThrow();
      expect(() =>
        f.store.confirmPairing(f.actor, f.pair.id, claim.fingerprint, ["other"]),
      ).toThrow();
      f.store.confirmPairing(f.actor, f.pair.id, claim.fingerprint, ["im"]);
      const local = f.prove(claim.hostId, "confirm");
      expect(local.auth().purpose).toBe("confirm");
      expect(() => local.auth()).toThrow();
      f.store.localConfirm(claim.hostId);
      const token = f.store.token(claim.hostId);
      const first = f.store.consumeToken(token.token);
      expect(first.epoch).toBe(1);
      expect(() => f.store.consumeToken(token.token)).toThrow();
      const second = f.store.consumeToken(f.store.token(claim.hostId).token);
      expect(second.epoch).toBe(2);
      expect(f.store.heartbeat(first.id, 1)).toBe(false);
      expect(f.store.heartbeat(first.id, 2)).toBe(true);
      f.store.revoke(first.id, f.actor);
      expect(() => f.store.token(first.id)).toThrow();
      expect(() => f.store.challenge(first.id, "connect")).toThrow();
    } finally {
      f.db.close();
    }
  });
  it("rejects expired pairings, expired challenges, mismatched signatures and foreign owners", () => {
    const f = fixture();
    try {
      const claim = f.claim();
      expect(() => f.store.get(claim.hostId, "stranger")).toThrow();
      expect(() =>
        f.store.confirmPairing({ ...f.actor, userId: "stranger" }, f.pair.id, claim.fingerprint, [
          "im",
        ]),
      ).toThrow();
      const proof = f.prove(claim.hostId, "status");
      expect(() => f.store.authenticate(proof.challenge.id, "bad")).toThrow();
      f.advance(30_001);
      expect(() => proof.auth()).toThrow();
      f.advance(300_000);
      expect(() => f.store.confirmPairing(f.actor, f.pair.id, claim.fingerprint, ["im"])).toThrow();
    } finally {
      f.db.close();
    }
  });
});
