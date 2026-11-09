export const ErrorCode = {
  BadRequest: "BAD_REQUEST",
  Unauthorized: "UNAUTHORIZED",
  Forbidden: "FORBIDDEN",
  HostOffline: "HOST_OFFLINE",
  ServiceUnavailable: "SERVICE_UNAVAILABLE",
  ProtocolMismatch: "PROTOCOL_MISMATCH",
  RepoBusy: "REPO_BUSY",
  StalePreview: "STALE_PREVIEW",
  ApprovalExpired: "APPROVAL_EXPIRED",
  IdempotencyConflict: "IDEMPOTENCY_CONFLICT",
  SnapshotBaseMissing: "SNAPSHOT_BASE_MISSING",
  TransferQuotaExceeded: "TRANSFER_QUOTA_EXCEEDED",
  RateLimited: "RATE_LIMITED",
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
    case ErrorCode.Forbidden:
      return 403;
    case ErrorCode.HostOffline:
    case ErrorCode.ServiceUnavailable:
      return 503;
    case ErrorCode.RateLimited:
      return 429;
    case ErrorCode.TransferQuotaExceeded:
      return 413;
    case ErrorCode.NotFound:
      return 404;
    case ErrorCode.Conflict:
    case ErrorCode.ProtocolMismatch:
    case ErrorCode.RepoBusy:
    case ErrorCode.StalePreview:
    case ErrorCode.ApprovalExpired:
    case ErrorCode.IdempotencyConflict:
    case ErrorCode.SnapshotBaseMissing:
    case ErrorCode.ApprovalRequired:
      return 409;
    case ErrorCode.ProviderUnavailable:
    case ErrorCode.IntegrationFailed:
      return 502;
    default:
      return 500;
  }
}
