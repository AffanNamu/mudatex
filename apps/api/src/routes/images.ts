import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hasPermissionAnywhere } from '../auth/authorize.js';
import type { Db } from '../db.js';
import { AppError, forbidden, invalid } from '../errors.js';

export const MAX_IMAGE_BYTES = 2_000_000;
export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

/** What the bytes really are, from their first few bytes. The declared type is never trusted. */
export function sniffImage(b: Buffer): ImageType | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** A photo's public address: the configured public API address, else the one this request came to. */
export const imageUrl = (req: Pick<FastifyRequest, 'protocol' | 'headers'>, publicBase: string | undefined, id: string) =>
  `${(publicBase ?? `${req.protocol}://${req.headers.host}`).replace(/\/$/, '')}/images/${id}`;

/** Staff upload a photo (the raw image as the request body). Returns its address, to be used as a picture link. */
export const imageUploadRoutes: FastifyPluginAsync<{ db: Db; publicBase?: string; quotaBytes: number }> = async (app, { db, publicBase, quotaBytes }) => {
  // Images arrive as raw bytes, not JSON.
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream']) {
    app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES + 1 }, (_req, body, done) => done(null, body));
  }

  app.post('/images', async (req, reply) => {
    const { actor } = req;
    if (!(await hasPermissionAnywhere(db, actor, 'storefront.manage'))) throw forbidden();
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw invalid('Send the picture as the body of the request');
    if (body.length > MAX_IMAGE_BYTES) throw new AppError(413, 'too_large', 'That picture is too large. Pictures are limited to 2 MB; the console shrinks them for you.');
    const type = sniffImage(body);
    if (!type) throw new AppError(415, 'unsupported_media_type', 'Only JPEG, PNG and WebP pictures are accepted');
    const sha = createHash('sha256').update(body).digest('hex');
    const used = await db.query<{ n: string }>('SELECT COALESCE(sum(size_bytes), 0) AS n FROM images WHERE organization_id = $1', [actor.organizationId]);
    const existing = await db.query<{ id: string }>('SELECT id FROM images WHERE organization_id = $1 AND sha256 = $2', [actor.organizationId, sha]);
    if (existing.rows[0]) return reply.status(200).send({ id: existing.rows[0].id, url: imageUrl(req, publicBase, existing.rows[0].id), sizeBytes: body.length });
    if (Number(used.rows[0]!.n) + body.length > quotaBytes) throw new AppError(413, 'quota', 'The picture store is full. Remove pictures that are not used, or ask for more space.');
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO images (organization_id, content_type, bytes, size_bytes, sha256, created_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, sha256) DO UPDATE SET sha256 = EXCLUDED.sha256 RETURNING id`,
      [actor.organizationId, type, body, body.length, sha, actor.userId]);
    return reply.status(201).send({ id: rows[0]!.id, url: imageUrl(req, publicBase, rows[0]!.id), sizeBytes: body.length });
  });

  app.get('/images/usage', async (req) => {
    if (!(await hasPermissionAnywhere(db, req.actor, 'storefront.manage'))) throw forbidden();
    const { rows } = await db.query<{ n: string; c: string }>('SELECT COALESCE(sum(size_bytes), 0) AS n, count(*) AS c FROM images WHERE organization_id = $1', [req.actor.organizationId]);
    return { count: Number(rows[0]!.c), bytes: Number(rows[0]!.n), quotaBytes };
  });
};

/** Anyone may view a photo (the shop shows them), by its unguessable id. Cached for a year: a photo never changes. */
export const imageServeRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/images/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).safeParse(req.params).data ?? {};
    if (!id) return reply.status(404).send({ error: 'not_found', message: 'Picture not found' });
    const { rows } = await db.query<{ content_type: string; sha256: string }>('SELECT content_type, sha256 FROM images WHERE id = $1', [id]);
    const row = rows[0];
    if (!row) return reply.status(404).send({ error: 'not_found', message: 'Picture not found' });
    const etag = `"${row.sha256}"`;
    reply.header('etag', etag).header('cache-control', 'public, max-age=31536000, immutable').header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox").header('cross-origin-resource-policy', 'cross-origin');
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    const data = await db.query<{ bytes: Buffer }>('SELECT bytes FROM images WHERE id = $1', [id]);
    return reply.type(row.content_type).send(data.rows[0]!.bytes);
  });
};

/** Pictures nobody uses any more (an upload that was never saved, a photo that was replaced). Kept two days first, in case a form is still open. */
export async function purgeOrphanImages(db: Db, olderThanDays = 2): Promise<number> {
  const r = await db.query(
    `DELETE FROM images i WHERE i.created_at < now() - make_interval(days => $1)
        AND NOT EXISTS (SELECT 1 FROM storefront_products sp WHERE sp.images::text LIKE '%/images/' || i.id::text || '%')
        AND NOT EXISTS (SELECT 1 FROM storefront_departments d WHERE d.image_url LIKE '%/images/' || i.id::text || '%')`, [olderThanDays]);
  return r.rowCount ?? 0;
}
