import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import type { AppEnv, RedisState } from "@ocgw/shared";

export type AdminPrincipal = {
  id: string;
  email: string;
  forcePasswordChange: boolean;
};

export type AppContext = {
  env: AppEnv;
  db: Pool;
  redis: RedisState;
  logger: FastifyBaseLogger;
};

declare module "fastify" {
  interface FastifyInstance {
    context: AppContext;
  }

  interface FastifyRequest {
    admin: AdminPrincipal | null;
    authType: "admin" | "internal" | null;
  }
}

export type ApiEnvelope<T> = { data: T; meta?: Record<string, unknown> };
