import { createHmac, randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { getAdapter } from "better-auth/db/adapter";
import { getMigrations } from "better-auth/db/migration";
import { emailOTP } from "better-auth/plugins/email-otp";
import type Database from "better-sqlite3";
import type { GatewayConfig } from "../config";
import { hashedSessionAdapter } from "./hashed-session-adapter";

export type SendOtp = (email: string, otp: string) => Promise<void>;

export async function createGatewayAuth(
  config: GatewayConfig,
  db: Database.Database,
  sendOtp: SendOtp,
) {
  const options = {
    appName: "AgentDesk",
    baseURL: config.publicOrigin,
    basePath: "/internal-auth",
    secret: config.sessionSecret,
    database: db,
    trustedOrigins: [config.publicOrigin],
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    advanced: {
      // 名称自行使用 __Host-，避免库额外加 __Secure-；属性仍强制 Secure。
      useSecureCookies: false,
      cookies: {
        session_token: {
          name: "__Host-agentdesk_session",
          attributes: { secure: true, httpOnly: true, sameSite: "lax" as const, path: "/" },
        },
      },
      defaultCookieAttributes: {
        secure: true,
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
      },
      database: { generateId: () => randomUUID() },
    },
    logger: { disabled: true },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 5,
        disableSignUp: true,
        resendStrategy: "rotate",
        storeOTP: {
          hash: async (otp) => createHmac("sha256", config.otpPepper).update(otp).digest("hex"),
        },
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (email !== config.ownerEmail || type !== "sign-in")
            throw new Error("Unsupported OTP action");
          await sendOtp(email, otp);
        },
      }),
    ],
  } satisfies Parameters<typeof betterAuth>[0];
  const migration = await getMigrations(options);
  await migration.runMigrations();
  db.transaction(() => {
    const existing = db.prepare('SELECT id,email FROM "user"').all() as Array<{
      id: string;
      email: string;
    }>;
    if (existing.length > 1 || (existing[0] && existing[0].email !== config.ownerEmail))
      throw new Error("Owner configuration changed; use the server recovery command");
    if (existing[0] && config.ownerUserId && existing[0].id !== config.ownerUserId)
      throw new Error("Configured owner ID differs from the existing database");
    if (!existing.length) {
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)',
      ).run(config.ownerUserId ?? randomUUID(), "Owner", config.ownerEmail, 1, now, now);
    }
  }).immediate();
  const adapter = hashedSessionAdapter(await getAdapter(options));
  const auth = betterAuth({ ...options, database: () => adapter });
  await auth.$context;
  return Object.assign(auth, { deliverOtp: sendOtp });
}
export type GatewayAuth = Awaited<ReturnType<typeof createGatewayAuth>>;
