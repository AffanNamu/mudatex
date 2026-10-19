export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Not permitted for this scope') => new AppError(403, 'forbidden', msg);
export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (msg: string) => new AppError(409, 'conflict', msg);
export const invalid = (msg: string) => new AppError(422, 'invalid', msg);
