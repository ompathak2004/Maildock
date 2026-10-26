export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function publicError(error: unknown): { code: string; error: string } {
  if (error instanceof AppError) return { code: error.code, error: error.message };
  return { code: 'unexpected', error: 'Something went wrong. Try again. No code was submitted.' };
}
