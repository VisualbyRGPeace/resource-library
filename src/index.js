// Resource Library — Worker (API + phục vụ frontend tĩnh).
import { AwsClient } from 'aws4fetch';
import * as U from './util.js';
import * as A from './auth.js';

const { HttpError, json } = U;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, ctx, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Internal error' }, 500);
    }
  },
};

async function route(request, env, ctx, url) {
  const m = request.method;
  const p = url.pathname.replace(/\/+$/, '');

  // ---------- Auth ----------
  if (p === '/api/auth/login' && m === 'POST') return A.login(request, env);
  if (p === '/api/auth/logout' && m === 'POST') return A.logout(request);
  if (p === '/api/auth/me' && m === 'GET') return json({ authenticated: await A.isAdmin(request, env) });

  // ---------- Public ----------
  if (p === '/api/config' && m === 'GET') {
    return json({
      categories: U.CATEGORIES,
      partSize: U.PART_SIZE,
      maxFileSize: U.MAX_FILE_SIZE,
      blockedExt: [...U.BLOCKED_EXT],
    });
  }
  if (p === '/api/categories' && m === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT category, COUNT(*) AS count FROM resources GROUP BY category ORDER BY count DESC'
    ).all();
    return json(results, 200, { 'Cache-Control': 'no-cache' });
  }
  if (p === '/api/resources' && m === 'GET') return listResources(env, url);

  let r = p.match(new RegExp(`^/api/resources/(${U.ID_RE})(?:/(thumb|preview|file|download))?$`));
  if (r && (m === 'GET' || m === 'HEAD')) {
    const row = await getRow(env, r[1]);
    switch (r[2]) {
      case undefined: return json(toPublic(row), 200, { 'Cache-Control': 'no-cache' });
      case 'thumb': return serveThumb(request, env, ctx, row);
      case 'preview': return servePreview(env, row);
      case 'file': return serveFile(request, env, row);
      case 'download': return download(env, url, row);
    }
  }

  // ---------- Admin ----------
  if (p.startsWith('/api/admin/')) {
    await A.requireAdmin(request, env);

    if (p === '/api/admin/uploads/init' && m === 'POST') return initUpload(request, env);
    if (p === '/api/admin/uploads/part' && m === 'PUT') return uploadPart(request, env, url);
    if (p === '/api/admin/uploads/complete' && m === 'POST') return completeUpload(request, env);
    if (p === '/api/admin/uploads/abort' && m === 'POST') return abortUpload(request, env);
    if (p === '/api/admin/resources/bulk-delete' && m === 'POST') return bulkDelete(request, env);

    r = p.match(new RegExp(`^/api/admin/resources/(${U.ID_RE})(?:/(thumbnail))?$`));
    if (r) {
      if (!r[2] && m === 'PUT') return updateResource(request, env, r[1]);
      if (!r[2] && m === 'DELETE') return deleteResources(env, [r[1]]);
      if (r[2] && m === 'PUT') return putThumbnail(request, env, r[1]);
    }
  }

  throw new HttpError(404, 'Not found');
}

// =====================================================================
// Helpers
// =====================================================================

async function getRow(env, id) {
  const row = await env.DB.prepare('SELECT * FROM resources WHERE id = ?1').bind(id).first();
  if (!row) throw new HttpError(404, 'Resource not found');
  return row;
}

function parseTags(s) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Không bao giờ trả file_key / thumbnail_key ra ngoài.
function toPublic(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    fileName: row.file_name,
    type: row.file_type,
    mimeType: row.mime_type,
    size: row.file_size,
    width: row.width,
    height: row.height,
    category: row.category,
    tags: parseTags(row.tags),
    isImage: U.IMAGE_EXT.has(row.file_type),
    thumb: row.thumbnail_key ? `/api/resources/${row.id}/thumb?v=${encodeURIComponent(row.updated_at)}` : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ORDER = {
  newest: 'created_at DESC',
  oldest: 'created_at ASC',
  name_asc: 'name COLLATE NOCASE ASC',
  name_desc: 'name COLLATE NOCASE DESC',
  size_desc: 'file_size DESC',
  size_asc: 'file_size ASC',
};

async function listResources(env, url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const category = url.searchParams.get('category') || '';
  const sort = url.searchParams.get('sort') || 'newest';
  const limit = U.clamp(parseInt(url.searchParams.get('limit'), 10) || 48, 1, 100);
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);

  const where = [];
  const args = [];
  if (category && U.CATEGORIES.includes(category)) {
    where.push('category = ?');
    args.push(category);
  }
  for (const term of q.split(/\s+/).filter(Boolean).slice(0, 6)) {
    const like = '%' + term.replace(/[\\%_]/g, '\\$&') + '%';
    where.push("(name LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR file_name LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const order = (ORDER[sort] || ORDER.newest) + ', id ASC';

  const [list, count] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM resources ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...args, limit, (page - 1) * limit),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM resources ${w}`).bind(...args),
  ]);
  const total = count.results[0].n;
  return json(
    { items: list.results.map(toPublic), total, page, limit, hasMore: page * limit < total },
    200,
    { 'Cache-Control': 'no-cache' }
  );
}

// =====================================================================
// Phục vụ file
// =====================================================================

// Thumbnail nhỏ, bất biến (key đổi mỗi lần thay) -> cache mạnh ở edge + trình duyệt.
async function serveThumb(request, env, ctx, row) {
  if (!row.thumbnail_key) throw new HttpError(404, 'No thumbnail');
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const obj = await env.BUCKET.get(row.thumbnail_key);
  if (!obj) throw new HttpError(404, 'No thumbnail');
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('ETag', obj.httpEtag);
  h.set('Cache-Control', 'public, max-age=31536000, immutable');
  h.set('X-Content-Type-Options', 'nosniff');
  const res = new Response(obj.body, { headers: h });
  ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

// Xem ảnh gốc trong modal. Chỉ cho file ảnh; SVG bị sandbox bằng CSP.
async function servePreview(env, row) {
  if (!U.IMAGE_EXT.has(row.file_type)) throw new HttpError(400, 'Not an image');
  const obj = await env.BUCKET.get(row.file_key);
  if (!obj) throw new HttpError(404, 'File not found');
  const h = new Headers();
  h.set('Content-Type', U.imageMime(row.file_type));
  h.set('Content-Length', String(obj.size));
  h.set('ETag', obj.httpEtag);
  h.set('Cache-Control', 'public, max-age=3600');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  return new Response(obj.body, { headers: h });
}

// Stream file từ R2 (hỗ trợ Range để tải lại/tiếp tục). Dữ liệu không bị buffer trong Worker.
async function serveFile(request, env, row) {
  const range = request.headers.get('Range');
  const obj = await env.BUCKET.get(row.file_key, range ? { range: request.headers } : undefined);
  if (!obj) throw new HttpError(404, 'File not found');

  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('ETag', obj.httpEtag);
  h.set('Accept-Ranges', 'bytes');
  h.set('Content-Disposition', U.contentDisposition(row.file_name));
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Cache-Control', 'public, max-age=3600');

  let status = 200;
  if (range && obj.range) {
    const r = obj.range;
    const offset = r.offset ?? Math.max(0, obj.size - (r.suffix || 0));
    const length = r.length ?? obj.size - offset;
    h.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    h.set('Content-Length', String(length));
    status = 206;
  } else {
    h.set('Content-Length', String(obj.size));
  }
  return new Response(obj.body, { status, headers: h });
}

function presignEnabled(env) {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET_NAME);
}

async function presignedDownloadUrl(env, row) {
  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  const path = row.file_key.split('/').map(encodeURIComponent).join('/');
  const u = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${path}`);
  u.searchParams.set('X-Amz-Expires', '3600');
  u.searchParams.set('response-content-disposition', U.contentDisposition(row.file_name));
  const signed = await aws.sign(new Request(u, { method: 'GET' }), { aws: { signQuery: true } });
  return signed.url;
}

// Có presign -> trình duyệt tải thẳng từ R2. Không có -> dùng /file (stream qua Worker).
async function download(env, url, row) {
  const head = await env.BUCKET.head(row.file_key);
  if (!head) throw new HttpError(404, 'Download unavailable');
  const target = presignEnabled(env) ? await presignedDownloadUrl(env, row) : `/api/resources/${row.id}/file`;
  if (url.searchParams.get('json')) return json({ url: target });
  return new Response(null, {
    status: 302,
    headers: { Location: new URL(target, url).href, 'Cache-Control': 'no-store' },
  });
}

// =====================================================================
// Admin: upload (multipart qua R2 binding)
// =====================================================================

async function initUpload(request, env) {
  const b = await U.readJson(request);
  const fileName = U.safeFileName(b.fileName);
  const ext = U.extOf(fileName);
  const size = Number(b.size);
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, 'Empty file');
  if (size > U.MAX_FILE_SIZE) throw new HttpError(413, 'File is too large');
  if (U.BLOCKED_EXT.has(ext)) throw new HttpError(400, `.${ext} files are not allowed`);

  const id = U.uid();
  const key = `resources/${id}/${fileName.replace(/\s+/g, '-')}`;
  const mpu = await env.BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType: U.mimeFor(ext, b.mimeType) },
  });
  return json({ key, uploadId: mpu.uploadId, partSize: U.PART_SIZE });
}

async function uploadPart(request, env, url) {
  const key = U.assertKey(url.searchParams.get('key'));
  const uploadId = url.searchParams.get('uploadId') || '';
  const n = parseInt(url.searchParams.get('n'), 10);
  if (!uploadId || !(n >= 1 && n <= 10000)) throw new HttpError(400, 'Bad part');
  const buf = await request.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > U.PART_SIZE) throw new HttpError(400, 'Bad part size');
  const part = await env.BUCKET.resumeMultipartUpload(key, uploadId).uploadPart(n, buf);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

async function abortUpload(request, env) {
  const b = await U.readJson(request);
  const key = U.assertKey(b.key);
  try { await env.BUCKET.resumeMultipartUpload(key, String(b.uploadId || '')).abort(); } catch { /* đã huỷ/không tồn tại */ }
  return json({ ok: true });
}

async function completeUpload(request, env) {
  const b = await U.readJson(request, 512 * 1024);
  const key = U.assertKey(b.key);
  const uploadId = String(b.uploadId || '');
  if (!uploadId || !Array.isArray(b.parts) || !b.parts.length || b.parts.length > 10000) {
    throw new HttpError(400, 'Bad parts');
  }
  const parts = b.parts
    .map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }))
    .sort((a, c) => a.partNumber - c.partNumber);

  let obj;
  try {
    obj = await env.BUCKET.resumeMultipartUpload(key, uploadId).complete(parts);
  } catch (e) {
    throw new HttpError(400, 'Could not finish upload: ' + (e && e.message ? e.message : 'unknown error'));
  }

  const meta = b.meta || {};
  const id = key.split('/')[1];
  const fileName = U.safeFileName(meta.fileName || key.split('/').slice(2).join('/'));
  const ext = U.extOf(fileName);
  const isImage = U.IMAGE_EXT.has(ext);
  const name = (meta.name && String(meta.name).trim().slice(0, 200)) || U.prettyName(fileName);
  const category = U.CATEGORIES.includes(meta.category) ? meta.category : U.guessCategory(ext);
  const now = new Date().toISOString();
  const row = {
    id, name, description: '', file_key: key, file_name: fileName, file_type: ext || 'file',
    mime_type: U.mimeFor(ext, meta.mimeType), file_size: obj.size,
    width: isImage ? U.safeDim(meta.width) : null, height: isImage ? U.safeDim(meta.height) : null,
    category, tags: JSON.stringify(U.normalizeTags(meta.tags)), thumbnail_key: null,
    created_at: now, updated_at: now,
  };

  try {
    await env.DB.prepare(
      `INSERT INTO resources (id,name,description,file_key,file_name,file_type,mime_type,file_size,width,height,category,tags,thumbnail_key,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`
    ).bind(row.id, row.name, row.description, row.file_key, row.file_name, row.file_type, row.mime_type,
      row.file_size, row.width, row.height, row.category, row.tags, row.thumbnail_key, row.created_at, row.updated_at).run();
  } catch (e) {
    await env.BUCKET.delete(key); // không để file mồ côi
    throw e;
  }
  return json(toPublic(row), 201);
}

async function putThumbnail(request, env, id) {
  const row = await getRow(env, id);
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  const ext = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' }[type];
  if (!ext) throw new HttpError(415, 'Thumbnail must be WebP, JPEG or PNG');
  const buf = await request.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > U.MAX_THUMB_SIZE) throw new HttpError(400, 'Thumbnail must be under 2 MB');

  const key = `thumbnails/${id}/${U.uid().slice(0, 8)}.${ext}`;
  await env.BUCKET.put(key, buf, { httpMetadata: { contentType: type } });
  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE resources SET thumbnail_key = ?1, updated_at = ?2 WHERE id = ?3').bind(key, now, id).run();
  if (row.thumbnail_key) await env.BUCKET.delete(row.thumbnail_key);
  return json(toPublic({ ...row, thumbnail_key: key, updated_at: now }));
}

// =====================================================================
// Admin: sửa / xoá
// =====================================================================

async function updateResource(request, env, id) {
  const row = await getRow(env, id);
  const b = await U.readJson(request);

  const name = b.name !== undefined ? String(b.name).trim() : row.name;
  if (!name || name.length > 200) throw new HttpError(400, 'Name is required (max 200 characters)');
  const description = b.description !== undefined ? String(b.description).trim().slice(0, 2000) : row.description;
  const category = b.category !== undefined ? b.category : row.category;
  if (!U.CATEGORIES.includes(category)) throw new HttpError(400, 'Unknown category');
  const tags = b.tags !== undefined ? JSON.stringify(U.normalizeTags(b.tags)) : row.tags;
  const now = new Date().toISOString();

  await env.DB.prepare('UPDATE resources SET name=?1, description=?2, category=?3, tags=?4, updated_at=?5 WHERE id=?6')
    .bind(name, description, category, tags, now, id).run();
  return json(toPublic({ ...row, name, description, category, tags, updated_at: now }));
}

async function bulkDelete(request, env) {
  const b = await U.readJson(request);
  const ids = Array.isArray(b.ids) ? b.ids : [];
  const re = new RegExp(`^${U.ID_RE}$`);
  if (!ids.length || ids.length > 100 || !ids.every((i) => re.test(i))) throw new HttpError(400, 'Invalid ids');
  return deleteResources(env, ids);
}

// Xoá R2 trước, D1 sau: nếu D1 lỗi thì bấm xoá lại là xong (xoá R2 lặp lại vô hại), không để file mồ côi.
async function deleteResources(env, ids) {
  const ph = ids.map((_, i) => `?${i + 1}`).join(',');
  const { results } = await env.DB.prepare(`SELECT id, file_key, thumbnail_key FROM resources WHERE id IN (${ph})`).bind(...ids).all();
  const keys = results.flatMap((r) => [r.file_key, r.thumbnail_key]).filter(Boolean);
  if (keys.length) await env.BUCKET.delete(keys);
  if (results.length) {
    await env.DB.batch(results.map((r) => env.DB.prepare('DELETE FROM resources WHERE id = ?1').bind(r.id)));
  }
  return json({ deleted: results.length });
}
