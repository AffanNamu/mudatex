import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    DATABASE_URL: z.string().min(1),
    // Production: verify tokens against the identity provider's JWKS.
    AUTH_JWKS_URL: z.string().url().optional(),
    AUTH_ISSUER: z.string().optional(),
    AUTH_AUDIENCE: z.string().optional(),
    // Development and tests only: shared HS256 secret.
    AUTH_DEV_SECRET: z.string().min(32).optional(),
    // Local development and automated browser tests only: lets anyone who can reach the server sign in as any existing user.
    // Off unless explicitly enabled, and refused outright in production.
    DEV_TOKEN_ENDPOINT: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    // required: staff (the console and its API) must have signed in with a second factor. Customers of the shop are not affected.
    // Turn it on once every staff member has enrolled an authenticator app, or they are locked out of the console.
    STAFF_MFA: z.enum(['off', 'required']).default('off'),
    // Comma-separated browser origins allowed to call the API. Empty means no cross-origin access.
    CORS_ORIGINS: z.string().default('').transform((v) => v.split(',').map((o) => o.trim()).filter(Boolean)),
    // Requests per minute per client address. Unset: 600 outside tests, off in tests.
    RATE_LIMIT_MAX: z.coerce.number().int().positive().optional(),
    // Set true only behind a trusted reverse proxy, so client addresses come from X-Forwarded-For.
    TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
    // 32 random bytes, base64. Encrypts webhook signing secrets at rest. Webhooks cannot be created without it.
    SECRETS_ENCRYPTION_KEY: z.string().optional(),
    // Webhooks to http:// and to private addresses are for development and tests only.
    WEBHOOK_ALLOW_HTTP: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    WEBHOOK_ALLOW_PRIVATE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    // Run the delivery worker inside the API process. Prefer a separate `node dist/worker.js` in production.
    RUN_WORKER_IN_API: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
    // Paystack secret key (sk_test_… or sk_live_…). Without it, card payments are switched off.
    PAYSTACK_SECRET_KEY: z.string().regex(/^sk_(test|live)_[A-Za-z0-9]+$/).optional(),
    // Only for tests: where the payment provider's API lives. Never changed in production.
    PAYSTACK_BASE_URL: z.string().url().optional(),
    // Order emails to customers, through Resend. Without both, no email is sent.
    RESEND_API_KEY: z.string().min(10).optional(),
    MAIL_FROM: z.string().min(5).max(200).optional(),
    // Browser push notifications (generate once with `npx web-push generate-vapid-keys`). Without all three, push is off.
    // Text messages (Termii). Off unless both the key and a registered sender ID are set.
    TERMII_API_KEY: z.string().min(10).optional(),
    TERMII_SENDER_ID: z.string().min(3).max(11).optional(),
    TERMII_BASE_URL: z.string().url().optional(),
    TERMII_CHANNEL: z.enum(['generic', 'dnd', 'whatsapp']).optional(),
    VAPID_PUBLIC_KEY: z.string().min(40).optional(),
    VAPID_PRIVATE_KEY: z.string().min(20).optional(),
    VAPID_SUBJECT: z.string().regex(/^(mailto:|https:\/\/)/).optional(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    // A statement running longer than this is cancelled, so one bad query cannot hold locks for long.
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
    DB_IDLE_IN_TX_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.AUTH_DEV_SECRET) {
        ctx.addIssue({ code: 'custom', message: 'AUTH_DEV_SECRET must not be set in production' });
      }
      if (env.DEV_TOKEN_ENDPOINT) {
        ctx.addIssue({ code: 'custom', message: 'DEV_TOKEN_ENDPOINT must not be set in production' });
      }
      if (env.WEBHOOK_ALLOW_HTTP || env.WEBHOOK_ALLOW_PRIVATE) {
        ctx.addIssue({ code: 'custom', message: 'WEBHOOK_ALLOW_HTTP and WEBHOOK_ALLOW_PRIVATE must not be set in production' });
      }
      if (env.PAYSTACK_BASE_URL) {
        ctx.addIssue({ code: 'custom', message: 'PAYSTACK_BASE_URL must not be set in production' });
      }
      if (env.PAYSTACK_SECRET_KEY?.startsWith('sk_test_')) {
        ctx.addIssue({ code: 'custom', message: 'PAYSTACK_SECRET_KEY must be a live key in production' });
      }
      if (!env.AUTH_JWKS_URL || !env.AUTH_ISSUER || !env.AUTH_AUDIENCE) {
        ctx.addIssue({
          code: 'custom',
          message: 'AUTH_JWKS_URL, AUTH_ISSUER and AUTH_AUDIENCE are required in production',
        });
      }
    } else if (!env.AUTH_DEV_SECRET && !env.AUTH_JWKS_URL) {
      ctx.addIssue({ code: 'custom', message: 'Set AUTH_DEV_SECRET or AUTH_JWKS_URL' });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
