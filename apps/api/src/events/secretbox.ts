import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM with a random nonce per value. Output is `v1.<nonce>.<tag>.<ciphertext>` in base64url. */
export function createSecretBox(keyBase64: string | undefined) {
  if (!keyBase64) return null;
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('SECRETS_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  return {
    encrypt(plain: string): string {
      const nonce = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, nonce);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return ['v1', nonce.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
    },
    decrypt(boxed: string): string {
      const [v, nonce, tag, ct] = boxed.split('.');
      if (v !== 'v1' || !nonce || !tag || !ct) throw new Error('Unrecognised encrypted value');
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    },
  };
}
export type SecretBox = NonNullable<ReturnType<typeof createSecretBox>>;
