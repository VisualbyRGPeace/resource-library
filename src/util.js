// Hằng số + hàm tiện ích dùng chung cho Worker.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const CATEGORIES = [
  'Mockup', 'Poster', 'Texture', 'Background', 'Typography', 'Branding',
  'Packaging', '3D', 'Photo', 'Video', 'Audio', 'Other',
];

// Mỗi part 10 MiB: nằm dưới giới hạn body của Worker (100 MB) và trên mức tối thiểu 5 MiB của R2.
export const PART_SIZE = 10 * 1024 * 1024;
export const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GiB (R2 hỗ trợ nhiều hơn, chỉnh nếu cần)
export const MAX_THUMB_SIZE = 2 * 1024 * 1024;

export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg']);

// File thực thi bị chặn để thư viện không bị dùng phát tán mã độc.
export const BLOCKED_EXT = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'vbs', 'jar', 'apk', 'lnk',
]);

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', svg: 'image/svg+xml', pdf: 'application/pdf', zip: 'application/zip',
  rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', mp4: 'video/mp4',
  mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', psd: 'image/vnd.adobe.photoshop',
  ai: 'application/illustrator', eps: 'application/postscript',
};

export const ID_RE = '[a-f0-9]{16}';

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

export async function readJson(request, max = 64 * 1024) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > max) throw new HttpError(413, 'Request too large');
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function mimeFor(ext, provided) {
  if (provided && /^[\w.+-]+\/[\w.+-]+$/.test(provided) && provided.length < 100) return provided;
  return MIME[ext] || 'application/octet-stream';
}

export function imageMime(ext) {
  return MIME[ext] || 'application/octet-stream';
}

export function safeFileName(name) {
  let n = String(name || 'file')
    .split(/[\\/]/).pop()
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!n) n = 'file';
  if (n.length > 150) {
    const e = extOf(n);
    n = n.slice(0, 150 - (e ? e.length + 1 : 0)) + (e ? '.' + e : '');
  }
  return n;
}

export function uid() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function assertKey(key) {
  if (typeof key !== 'string' || !new RegExp(`^resources/${ID_RE}/[^/]{1,200}$`).test(key)) {
    throw new HttpError(400, 'Invalid key');
  }
  return key;
}

// "summer-poster_final.png" -> "Summer Poster Final"
export function prettyName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '');
  const spaced = base.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!spaced) return fileName;
  return spaced.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

export function guessCategory(ext) {
  if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) return 'Video';
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(ext)) return 'Audio';
  return 'Other';
}

export function normalizeTags(v) {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out = [];
  for (const t of arr) {
    const s = String(t).trim().toLowerCase().slice(0, 40);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 20) break;
  }
  return out;
}

export function contentDisposition(filename, type = 'attachment') {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function safeDim(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 && n <= 200000 ? n : null;
}
