export const ErrorCode = {
  BadRequest: "BAD_REQUEST",
  Unauthorized: "UNAUTHORIZED",
  NotFound: "NOT_FOUND",
  Conflict: "CONFLICT",
  ProviderUnavailable: "PROVIDER_UNAVAILABLE",
  IntegrationFailed: "INTEGRATION_FAILED",
  ApprovalRequired: "APPROVAL_REQUIRED",
  Internal: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export function httpStatusOf(code: ErrorCode): number {
  switch (code) {
    case ErrorCode.BadRequest:
      return 400;
    case ErrorCode.Unauthorized:
      return 401;
    case ErrorCode.NotFound:
      return 404;
    case ErrorCode.Conflict:
    case ErrorCode.ApprovalRequired:
      return 409;
    case ErrorCode.ProviderUnavailable:
    case ErrorCode.IntegrationFailed:
      return 502;
    default:
      return 500;
  }
}
