import { Prisma } from "@prisma/client";
import { ZodError } from "zod";

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function statusToCode(status: number) {
  if (status === 400) return "BAD_REQUEST";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 413) return "PAYLOAD_TOO_LARGE";
  if (status === 429) return "TOO_MANY_REQUESTS";
  return "INTERNAL_SERVER_ERROR";
}

export function normalizeError(err: unknown): { status: number; body: ApiErrorBody } {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } },
    };
  }

  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request payload",
          details: err.flatten(),
        },
      },
    };
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return {
        status: 409,
        body: {
          error: {
            code: "UNIQUE_CONSTRAINT",
            message: "Resource already exists",
            details: err.meta,
          },
        },
      };
    }
    if (err.code === "P2025") {
      return {
        status: 404,
        body: {
          error: {
            code: "NOT_FOUND",
            message: "Resource not found",
          },
        },
      };
    }
  }

  if (typeof err === "object" && err !== null) {
    const e = err as { status?: number; statusCode?: number; code?: string; message?: string; details?: unknown };
    const status = e.status ?? e.statusCode ?? 500;
    const code = e.code ?? statusToCode(status);
    return {
      status,
      body: {
        error: {
          code,
          message: e.message ?? "Internal Server Error",
          ...(e.details !== undefined ? { details: e.details } : {}),
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal Server Error",
      },
    },
  };
}
