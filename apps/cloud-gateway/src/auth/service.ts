import { createHmac, randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { getAdapter } from "better-auth/db/adapter";
import { getMigrations } from "better-auth/db/migration";
import { emailOTP } from "better-auth/plugins/email-otp";
import type Database from "better-sqlite3";
import { gatewayDatabase, type GatewayDatabase } from "../db/database";
import type { GatewayConfig } from "../config";
import { hashedSessionAdapter } from "./hashed-session-adapter";
import { SESSION_ABSOLUTE_SECONDS } from "./session-policy";

export type SendOtp = (email: string, otp: string) => Promise<void>;

export async function createGatewayAuth(
  config: GatewayConfig,
  database: Database.Database | GatewayDatabase,
  sendOtp: SendOtp,
  initialization: { initializeOwner?: boolean } = {},
) {
  const db = gatewayDatabase(database);
  const options = {
    appName: "AgentDesk",
    baseURL: config.publicOrigin,
    basePath: "/internal-auth",
    secret: config.sessionSecret,
    database: db.authDatabase,
    trustedOrigins: [config.publicOrigin],
    session: {
      expiresIn: SESSION_ABSOLUTE_SECONDS,
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
        disableSignUp: !config.authMultiUser,
        resendStrategy: "rotate",
        storeOTP: {
          hash: async (otp) => createHmac("sha256", config.otpPepper).update(otp).digest("hex"),
        },
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== "sign-in") throw new Error("Unsupported OTP action");
          if (!config.authMultiUser && email !== config.ownerEmail)
            throw new Error("Unsupported OTP action");
          await sendOtp(email, otp);
        },
      }),
    ],
  } satisfies Parameters<typeof betterAuth>[0];
  await db.exclusive(async () => {
    const migration = await getMigrations(options);
    await migration.runMigrations();
  });
  if (initialization.initializeOwner !== false)
    await db
      .transaction(async () => {
        const existing = (await db.prepare('SELECT id,email FROM "user"').all()) as Array<{
          id: string;
          email: string;
        }>;
        const byEmail = existing.find((user) => user.email === config.ownerEmail);
        const byId = config.ownerUserId
          ? existing.find((user) => user.id === config.ownerUserId)
          : undefined;
        if (byEmail && byId && byEmail.id !== byId.id)
          throw new Error("Owner email and configured owner ID point to different users");
        if (byId && byId.email !== config.ownerEmail)
          throw new Error("Configured owner ID differs from the existing database");
        if (!config.authMultiUser) {
          if (existing.length > 1 || (existing[0] && existing[0].email !== config.ownerEmail))
            throw new Error("Owner configuration changed; use the server recovery command");
          if (existing[0] && config.ownerUserId && existing[0].id !== config.ownerUserId)
            throw new Error("Configured owner ID differs from the existing database");
        }
        if (!byEmail) {
          if (config.ownerUserId && existing.some((user) => user.id === config.ownerUserId))
            throw new Error("Configured owner ID exists with a different email; use recovery");
          const now = new Date().toISOString();
          await db
            .prepare(
              'INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)',
            )
            .run(
              config.ownerUserId ?? randomUUID(),
              "Owner",
              config.ownerEmail,
              db.dialect === "postgres" ? true : 1,
              now,
              now,
            );
        }
      })
      .immediate();
  // SQLite 的认证适配器与业务仓储共用串行队列，避免 await 期间穿插到另一请求的事务中。
  const rawAdapter = await getAdapter(options);
  const serializedAdapter = new Proxy(rawAdapter, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== "function") return method;
      return (...args: unknown[]) => db.exclusive(() => Reflect.apply(method, target, args));
    },
  });
  const adapter = hashedSessionAdapter(serializedAdapter);
  const auth = betterAuth({ ...options, database: () => adapter });
  await auth.$context;
  return Object.assign(auth, { deliverOtp: sendOtp });
}
export type GatewayAuth = Awaited<ReturnType<typeof createGatewayAuth>>;
