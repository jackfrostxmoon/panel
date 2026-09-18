import { ErrorCodes, type ApiErrorCode } from '@panel/shared';

/**
 * Typed application errors.
 *
 * Routes/services throw these; the global error handler converts them into
 * the consistent `{ success: false, error }` envelope. Anything that is NOT
 * an AppError is treated as an unexpected internal error and logged.
 */

const HTTP_STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  [ErrorCodes.VALIDATION_ERROR]: 400,
  [ErrorCodes.PANEL_NOT_FOUND]: 404,
  [ErrorCodes.CHAPTER_NOT_FOUND]: 404,
  [ErrorCodes.BOOKMARK_NOT_FOUND]: 404,
  [ErrorCodes.READING_LIST_NOT_FOUND]: 404,
  [ErrorCodes.BOOKMARK_EXISTS]: 409,
  [ErrorCodes.SOURCE_UNAVAILABLE]: 502,
  [ErrorCodes.SOURCE_TIMEOUT]: 504,
  [ErrorCodes.SOURCE_PARSE_ERROR]: 502,
  [ErrorCodes.SOURCE_DISABLED]: 503,
  [ErrorCodes.UNKNOWN_SOURCE]: 400,
  [ErrorCodes.DATABASE_ERROR]: 500,
  [ErrorCodes.RATE_LIMITED]: 429,
  [ErrorCodes.NOT_FOUND]: 404,
  [ErrorCodes.INTERNAL_ERROR]: 500,
};

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown, status?: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    this.status = status ?? HTTP_STATUS_BY_CODE[code] ?? 500;
  }
}

/** Errors raised by panel source adapters (network, parsing, ...). */
export class SourceError extends AppError {
  readonly source: string;

  constructor(source: string, code: ApiErrorCode, message: string, details?: unknown) {
    super(code, message, details);
    this.name = 'SourceError';
    this.source = source;
  }

  static timeout(source: string, url: string): SourceError {
    return new SourceError(
      source,
      ErrorCodes.SOURCE_TIMEOUT,
      'The panel source took too long to respond. Please try again.',
      { url },
    );
  }

  static unavailable(source: string, url: string, status?: number): SourceError {
    return new SourceError(
      source,
      ErrorCodes.SOURCE_UNAVAILABLE,
      'The panel source is currently unavailable. Please try again later.',
      { url, upstreamStatus: status },
    );
  }

  static parse(source: string, what: string): SourceError {
    return new SourceError(
      source,
      ErrorCodes.SOURCE_PARSE_ERROR,
      'The panel source returned an unexpected response format.',
      { what },
    );
  }
}

export function httpStatusFor(code: ApiErrorCode): number {
  return HTTP_STATUS_BY_CODE[code] ?? 500;
}
