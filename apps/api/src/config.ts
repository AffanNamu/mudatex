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
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.AUTH_DEV_SECRET) {
        ctx.addIssue({ code: 'custom', message: 'AUTH_DEV_SECRET must not be set in production' });
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
