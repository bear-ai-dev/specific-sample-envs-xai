import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";

export interface AuthEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  MIGRATION_SECRET?: string;
  BETTER_AUTH_URL: string;
  PUBLIC_GAME_URL: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

export function trustedOrigins(env: AuthEnv): string[] {
  const configured = (env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([...configured, "http://127.0.0.1:3210", env.BETTER_AUTH_URL])];
}

export function createAuth(env: AuthEnv) {
  const socialProviders: NonNullable<Parameters<typeof betterAuth>[0]["socialProviders"]> = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  }
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    socialProviders.github = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    };
  }

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
    socialProviders,
    plugins: [bearer()],
  });
}
