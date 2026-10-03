// Xác thực một tài khoản admin: PBKDF2 + cookie phiên ký HMAC.
import { HttpError, json, readJson } from './util.js';

const enc = new TextEncoder();
const COOKIE = 'rl_session';
const SESSION_SECONDS = 7 * 24 * 3600;
const MAX_FAILS = 5;
const WINDOW_SECONDS = 15 * 60;

const b64u = {
  enc(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(s) {
    return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  },
};

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Định dạng: pbkdf2:<iterations>:<salt base64url>:<hash base64url>
export async function verifyPassword(stored, password) {
  try {
    const [scheme, iterStr, saltB64, hashB64] = String(stored || '').split(':');
    const iterations = Number(iterStr);
    if (scheme !== 'pbkdf2' || !iterations || iterations > 100000) return false;
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: b64u.dec(saltB64), iterations }, key, 256);
    return timingSafeEqual(new Uint8Array(bits), b64u.dec(hashB64));
  } catch {
    return false;
  }
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function createToken(secret, seconds = SESSION_SECONDS) {
  const payload = b64u.enc(enc.encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })));
  return `${payload}.${b64u.enc(await hmac(secret, payload))}`;
}

export async function verifyToken(secret, token) {
  try {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return false;
    if (!timingSafeEqual(await hmac(secret, payload), b64u.dec(sig))) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(b64u.dec(payload)));
    return typeof exp === 'number' && exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function cookieString(request, value, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function assertConfigured(env) {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD_HASH || !env.SESSION_SECRET) {
    throw new HttpError(500, 'Server is not configured: set ADMIN_EMAIL, ADMIN_PASSWORD_HASH and SESSION_SECRET.');
  }
}

// Chống CSRF: ngoài SameSite=Strict, request ghi dữ liệu phải có header tuỳ chỉnh và Origin trùng host.
function assertSameSiteRequest(request) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'Cross-origin request blocked');
  if (request.headers.get('X-Requested-With') !== 'resource-library') throw new HttpError(403, 'Missing header');
}

export async function isAdmin(request, env) {
  if (!env.SESSION_SECRET) return false;
  return verifyToken(env.SESSION_SECRET, getCookie(request, COOKIE));
}

export async function requireAdmin(request, env) {
  assertConfigured(env);
  if (request.method !== 'GET' && request.method !== 'HEAD') assertSameSiteRequest(request);
  if (!(await isAdmin(request, env))) throw new HttpError(401, 'Not authenticated');
}

export async function login(request, env) {
  assertConfigured(env);
  assertSameSiteRequest(request);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const now = Math.floor(Date.now() / 1000);

  const row = await env.DB.prepare('SELECT count, window_start FROM login_attempts WHERE ip = ?1').bind(ip).first();
  if (row && now - row.window_start < WINDOW_SECONDS && row.count >= MAX_FAILS) {
    throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  }

  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  // Luôn chạy cả hai phép kiểm tra để thời gian phản hồi không lộ email đúng/sai.
  const emailOk = timingSafeEqual(enc.encode(email), enc.encode(String(env.ADMIN_EMAIL).trim().toLowerCase()));
  const passOk = await verifyPassword(env.ADMIN_PASSWORD_HASH, password);

  if (!emailOk || !passOk) {
    await env.DB.prepare(
      `INSERT INTO login_attempts (ip, count, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(ip) DO UPDATE SET
         count = CASE WHEN ?2 - window_start >= ${WINDOW_SECONDS} THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN ?2 - window_start >= ${WINDOW_SECONDS} THEN ?2 ELSE window_start END`
    ).bind(ip, now).run();
    throw new HttpError(401, 'Invalid email or password');
  }

  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?1').bind(ip).run();
  const token = await createToken(env.SESSION_SECRET);
  return json({ ok: true }, 200, { 'Set-Cookie': cookieString(request, token, SESSION_SECONDS) });
}

export function logout(request) {
  assertSameSiteRequest(request);
  return json({ ok: true }, 200, { 'Set-Cookie': cookieString(request, '', 0) });
}
