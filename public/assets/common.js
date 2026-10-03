// Helper dùng chung cho trang public và admin.

// Tạo phần tử DOM an toàn (không dùng innerHTML với dữ liệu người dùng).
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export async function api(path, { method = 'GET', json, body, headers = {} } = {}) {
  const hdr = { 'X-Requested-With': 'resource-library', ...headers };
  let payload = body;
  if (json !== undefined) {
    hdr['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  const res = await fetch(path, { method, headers: hdr, body: payload, credentials: 'same-origin' });
  let data = null;
  if ((res.headers.get('content-type') || '').includes('json')) data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function toast(message, kind = '') {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = h('div', { id: 'toast-host', class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const el = h('div', { class: 'toast ' + kind }, message);
  host.append(el);
  setTimeout(() => el.remove(), 3800);
}

export function initTheme(button) {
  const sync = () => { button.textContent = document.documentElement.dataset.theme === 'dark' ? '☀' : '☾'; };
  sync();
  button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('rl-theme', next); } catch { /* bỏ qua */ }
    sync();
  });
}

export function placeholder(type) {
  return h('div', { class: 'placeholder' }, (type || 'FILE').toUpperCase());
}

// Thumbnail nếu có, nếu lỗi/không có thì hiện placeholder theo loại file.
export function thumbNode(r) {
  if (!r.thumb) return placeholder(r.type);
  const img = h('img', { src: r.thumb, alt: '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => img.replaceWith(placeholder(r.type)), { once: true });
  return img;
}

export function meta(r) {
  return `${r.type.toUpperCase()} · ${fmtSize(r.size)}`;
}

// Nút tải: hỏi API lấy URL trước để báo lỗi gọn ("Download unavailable.") thay vì hiện JSON thô.
export function downloadButton(r, cls = 'btn') {
  const a = h('a', { class: cls, href: `/api/resources/${r.id}/download`, rel: 'noopener' }, 'Download');
  a.addEventListener('click', async (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    a.setAttribute('aria-busy', 'true');
    try {
      const { url } = await api(`/api/resources/${r.id}/download?json=1`);
      const t = document.createElement('a');
      t.href = url;
      t.download = r.fileName;
      document.body.append(t);
      t.click();
      t.remove();
    } catch {
      toast('Download unavailable.', 'error');
    } finally {
      a.removeAttribute('aria-busy');
    }
  });
  return a;
}
