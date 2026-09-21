/**
 * One error type for everything the API deliberately rejects. Anything that is
 * NOT an AppError is treated as a bug and scrubbed before it reaches a client.
 */
export class AppError extends Error {
  constructor(message, { status = 400, code = 'BAD_REQUEST', details = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = true;
  }
}

export const badRequest = (msg, details) => new AppError(msg, { status: 400, code: 'BAD_REQUEST', details });
export const unauthorized = (msg = 'Authentication required') => new AppError(msg, { status: 401, code: 'UNAUTHORIZED' });
export const forbidden = (msg = 'Not allowed') => new AppError(msg, { status: 403, code: 'FORBIDDEN' });
export const notFound = (msg = 'Resource not found') => new AppError(msg, { status: 404, code: 'NOT_FOUND' });
export const conflict = (msg, details) => new AppError(msg, { status: 409, code: 'CONFLICT', details });
export const tooMany = (msg = 'Too many requests') => new AppError(msg, { status: 429, code: 'RATE_LIMITED' });
export const unprocessable = (msg, details) => new AppError(msg, { status: 422, code: 'VALIDATION_FAILED', details });
