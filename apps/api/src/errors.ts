import type { Localized } from './shop/messages.js';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** For errors a shopper reads: the same message as a catalogue key, so the shop can answer in their language. */
    readonly say?: Localized,
  ) {
    super(message);
  }
}

export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'unauthorized', msg, undefined, msg === 'Authentication required' ? { key: 'err.unauthorized' } : undefined);
export const forbidden = (msg = 'Not permitted for this scope', say?: Localized) => new AppError(403, 'forbidden', msg, undefined, say);
export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`, undefined, { key: `err.notFound.${what}` as Localized['key'] });
export const conflict = (msg: string, say?: Localized) => new AppError(409, 'conflict', msg, undefined, say);
export const invalid = (msg: string, say?: Localized) => new AppError(422, 'invalid', msg, undefined, say);

export const shortage = (msg: string, details: unknown) => new AppError(409, 'shortage', msg, details);
