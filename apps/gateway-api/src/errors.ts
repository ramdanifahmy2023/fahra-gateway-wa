import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function errorPayload(error: unknown): {
  statusCode: number;
  payload: Record<string, unknown>;
} {
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      payload: {
        error: {
          code: error.code,
          message: error.message,
          details: error.details ?? null,
        },
      },
    };
  }
  if (error instanceof ZodError) {
    return {
      statusCode: 422,
      payload: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Input tidak valid",
          details: error.flatten(),
        },
      },
    };
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "23505")
      return {
        statusCode: 409,
        payload: {
          error: {
            code: "RESOURCE_CONFLICT",
            message: "Data dengan identitas yang sama sudah tersedia",
          },
        },
      };
    if (code === "23503")
      return {
        statusCode: 409,
        payload: {
          error: {
            code: "RESOURCE_REFERENCED",
            message: "Data masih dipakai oleh resource lain",
          },
        },
      };
    if (["23502", "23514", "22P02"].includes(code))
      return {
        statusCode: 422,
        payload: {
          error: {
            code: "DATABASE_VALIDATION_ERROR",
            message: "Data tidak memenuhi aturan penyimpanan",
          },
        },
      };
  }
  return {
    statusCode: 500,
    payload: {
      error: { code: "INTERNAL_ERROR", message: "Terjadi kesalahan internal" },
    },
  };
}

export function sendError(reply: FastifyReply, error: unknown): void {
  const { statusCode, payload } = errorPayload(error);
  void reply.code(statusCode).send(payload);
}
