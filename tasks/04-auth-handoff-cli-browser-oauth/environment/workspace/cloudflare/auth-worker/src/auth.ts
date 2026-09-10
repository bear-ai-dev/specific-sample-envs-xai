import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";

export interface AuthEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  MIGRATION_SECRET?: string;
  BETTER_AUTH_URL: string;
  PUBLIC_GAME_URL: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
}

export function trustedOrigins(env: AuthEnv): string[] {
  const configured = (env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([...configured, "http://127.0.0.1:3210", env.BETTER_AUTH_URL])];
}

export function createAuth(env: AuthEnv) {
  return betterAuth({
    database: env.DB,
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: trustedOrigins(env),
    emailAndPassword: {
      enabled: true,
      // SMTP is optional; friend can turn verification on later.
      requireEmailVerification: false,
    },
    account: {
      storeStateStrategy: "cookie",
    },
    plugins: [bearer()],
  });
}

