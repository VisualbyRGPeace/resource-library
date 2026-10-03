import { api, h, fmtSize, debounce, initTheme, thumbNode, toast, meta } from './common.js';

const $ = (id) => document.getElementById(id);
initTheme($('theme-toggle'));

let config = { categories: [], partSize: 10 * 1024 * 1024, maxFileSize: 5 * 1024 ** 3, blockedExt: [] };

// ======================================================================
// Đăng nhập / phiên
// ======================================================================
function showLogin() {
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  $('email').focus();
}

async function showApp() {
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  if (!config.loaded) {
    try {
      config = { ...(await api('/api/config')), loaded: true };
      for (const c of config.categories) {
        $('batch-category').append(h('option', { value: c }, c));
        $('e-cat').append(h('option', { value: c }, c));
      }
    } catch { /* dùng mặc định */ }
  }
  loadList(true);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  $('login-btn').disabled = true;
  try {
    await api('/api/auth/login', { method: 'POST', json: { email: $('email').value, password: $('password').value } });
    $('password').value = '';
    await showApp();
  } catch (err) {
    $('login-error').textContent = err.message;
  } finally {
    $('login-btn').disabled = false;
  }
});

$('logout-btn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* bỏ qua */ }
  showLogin();
});

// Khi phiên hết hạn giữa chừng: quay lại màn đăng nhập (hàng đợi upload vẫn được giữ trong trang).
function handleAuth(err) {
  if (err && err.status === 401) { showLogin(); return true; }
  return false;
}

// ======================================================================
// Upload
// ======================================================================
const IMG_DECODE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif', 'bmp']);
const extOf = (n) => (/\.([A-Za-z0-9]{1,10})$/.exec(n) || [])[1]?.toLowerCase() || '';
const queue = []; // { id, file, status, loaded, error, fatal, key, uploadId, parts, partLoaded, ... }
let nextId = 1;
let running = false;

function addFiles(files) {
  for (const file of files) {
    const ext = extOf(file.name);
    const item = { id: nextId++, file, status: 'queued', loaded: 0, error: '', fatal: false, parts: [], partLoaded: {} };
    if (!file.size) { item.status = 'failed'; item.fatal = true; item.error = 'File is empty'; }
    else if (file.size > config.maxFileSize) { item.status = 'failed'; item.fatal = true; item.error = `Larger than ${fmtSize(config.maxFileSize)}`; }
    else if (config.blockedExt.includes(ext)) { item.status = 'failed'; item.fatal = true; item.error = `.${ext} files are not allowed`; }
    queue.push(item);
  }
  renderQueue();
}

function pct(item) {
  if (item.status === 'done') return 100;
  return item.file.size ? Math.min(99, Math.round((item.loaded / item.file.size) * 100)) : 0;
}

const STATE_LABEL = { queued: 'Waiting…', uploading: 'Uploading', done: 'Done', failed: 'Failed' };

function renderQueue() {
  $('queue-wrap').hidden = queue.length === 0;
  const q = $('queue');
  q.replaceChildren(...queue.map((it) => {
    const label = it.status === 'uploading' || it.status === 'done' ? `${pct(it)}%` : STATE_LABEL[it.status];
    const bar = h('i'); bar.style.width = `${it.status === 'queued' ? 0 : pct(it)}%`;
    return h('div', { class: 'q-item', 'data-id': it.id },
      h('div', { class: 'q-top' },
        h('div', { class: 'q-name', title: it.file.name }, it.file.name, ' ', h('span', { class: 'q-state' }, fmtSize(it.file.size))),
        h('div', { class: 'q-actions' },
          h('span', { class: `q-state ${it.status}` }, label),
          it.status === 'failed' && !it.fatal ? h('button', { class: 'btn secondary small', type: 'button', onclick: () => { it.status = 'queued'; startUpload(); } }, 'Retry') : null,
          it.status !== 'uploading' ? h('button', { class: 'btn secondary small', type: 'button', 'aria-label': 'Remove', onclick: () => removeItem(it) }, '✕') : null)),
      it.status !== 'queued' ? h('div', { class: 'bar' }, bar) : null,
      it.error ? h('div', { class: 'q-err' }, it.error) : null,
      it.warn ? h('div', { class: 'q-err' }, it.warn) : null);
  }));
  renderSummary();
}

// Cập nhật thanh tiến trình mà không dựng lại cả danh sách (mượt khi upload nhiều file).
function updateProgress(item) {
  item.loaded = Object.values(item.partLoaded).reduce((a, b) => a + b, 0);
  const el = document.querySelector(`.q-item[data-id="${item.id}"]`);
  if (!el) return;
  const bar = el.querySelector('.bar > i');
  const state = el.querySelector('.q-actions .q-state');
  if (bar) bar.style.width = `${pct(item)}%`;
  if (state) state.textContent = `${pct(item)}%`;
}

function renderSummary() {
  const queued = queue.filter((i) => i.status === 'queued').length;
  const done = queue.filter((i) => i.status === 'done').length;
  const failed = queue.filter((i) => i.status === 'failed').length;
  const retryable = queue.filter((i) => i.status === 'failed' && !i.fatal).length;
  const uploading = queue.some((i) => i.status === 'uploading');
  const parts = [];
  if (done) parts.push(`${done} file${done > 1 ? 's' : ''} uploaded successfully`);
  if (failed) parts.push(`${failed} file${failed > 1 ? 's' : ''} failed`);
  $('summary-text').textContent = parts.join(' · ');
  $('upload-btn').hidden = queued === 0 && !uploading;
  $('upload-btn').disabled = uploading || running;
  $('upload-btn').textContent = uploading || running ? 'Uploading…' : `Upload ${queued} file${queued > 1 ? 's' : ''}`;
  $('retry-btn').hidden = retryable === 0 || uploading;
  $('clear-btn').hidden = done === 0;
}

function removeItem(item) {
  const i = queue.indexOf(item);
  if (i < 0) return;
  queue.splice(i, 1);
  // Upload dở dang: dọn multipart trên R2 (không chờ kết quả).
  if (item.key && item.uploadId && item.status !== 'done') {
    api('/api/admin/uploads/abort', { method: 'POST', json: { key: item.key, uploadId: item.uploadId } }).catch(() => {});
  }
  renderQueue();
}

async function pool(limit, items, worker) {
  const list = [...items];
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (list.length) await worker(list.shift());
  });
  await Promise.all(runners);
}

async function retry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (e.status && e.status < 500 && e.status !== 408 && e.status !== 429) throw e; // lỗi do request, không thử lại
      await new Promise((r) => setTimeout(r, 600 * 2 ** i));
    }
  }
  throw last;
}

function sendPart(item, n, blob) {
  return retry(() => new Promise((resolve, reject) => {
    item.partLoaded[n] = 0;
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/admin/uploads/part?${new URLSearchParams({ key: item.key, uploadId: item.uploadId, n })}`);
    xhr.setRequestHeader('X-Requested-With', 'resource-library');
    xhr.upload.onprogress = (e) => { item.partLoaded[n] = e.loaded; updateProgress(item); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('Bad response from server')); }
      } else {
        let msg = `Upload failed (${xhr.status})`;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* giữ msg */ }
        const err = new Error(msg); err.status = xhr.status; reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(blob);
  }));
}

// ---- Tạo thumbnail + đọc kích thước ảnh ngay trên trình duyệt ----
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const t = setTimeout(() => reject(new Error('timeout')), 20000);
    img.onload = () => { clearTimeout(t); resolve(img); };
    img.onerror = () => { clearTimeout(t); reject(new Error('decode')); };
    img.decoding = 'async';
    img.src = url;
  });
}

async function prepareImage(file) {
  if (!IMG_DECODE.has(extOf(file.name)) || file.size > 150 * 1024 * 1024) return {};
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const sw = img.naturalWidth, sh = img.naturalHeight;
    const baseW = sw || 800, baseH = sh || 800;
    const scale = Math.min(1, 640 / Math.max(baseW, baseH));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(baseW * scale));
    canvas.height = Math.max(1, Math.round(baseH * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const thumb = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.82));
    return { width: sw || null, height: sh || null, thumb };
  } catch {
    return {};
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadItem(item) {
  item.status = 'uploading';
  item.error = '';
  item.warn = '';
  renderQueue();
  try {
    if (!item.prepared) {
      Object.assign(item, await prepareImage(item.file));
      item.prepared = true;
    }
    if (!item.key) {
      const init = await api('/api/admin/uploads/init', {
        method: 'POST', json: { fileName: item.file.name, size: item.file.size, mimeType: item.file.type },
      });
      Object.assign(item, { key: init.key, uploadId: init.uploadId, partSize: init.partSize, parts: [], partLoaded: {} });
    }

    const total = Math.ceil(item.file.size / item.partSize);
    const pending = [];
    for (let n = 1; n <= total; n++) if (!item.parts.some((p) => p.partNumber === n)) pending.push(n);

    // Nhiều part chạy song song cho file lớn; retry riêng từng part, part đã xong được giữ lại khi bấm Retry.
    await pool(3, pending, async (n) => {
      const blob = item.file.slice((n - 1) * item.partSize, n * item.partSize);
      const part = await sendPart(item, n, blob);
      item.parts.push(part);
      item.partLoaded[n] = blob.size;
      updateProgress(item);
    });

    const category = $('batch-category').value || undefined;
    const res = await api('/api/admin/uploads/complete', {
      method: 'POST',
      json: {
        key: item.key, uploadId: item.uploadId, parts: item.parts,
        meta: { fileName: item.file.name, mimeType: item.file.type, width: item.width, height: item.height, category },
      },
    });

    if (item.thumb) {
      try {
        await retry(() => api(`/api/admin/resources/${res.id}/thumbnail`, {
          method: 'PUT', body: item.thumb, headers: { 'Content-Type': item.thumb.type || 'image/webp' },
        }));
      } catch {
        item.warn = 'Uploaded, but the thumbnail could not be saved. Add one with Edit.';
      }
    }
    item.status = 'done';
    item.loaded = item.file.size;
  } catch (err) {
    item.status = 'failed';
    item.error = err.message;
    if (err.status === 401) { item.error = 'Session expired. Log in again, then press Retry.'; showLogin(); }
  }
  renderQueue();
}

async function startUpload() {
  if (running) return;
  running = true;
  renderQueue();
  try {
    // 2 file cùng lúc để không nghẽn mạng, mỗi file lại có 3 part song song.
    while (queue.some((i) => i.status === 'queued')) {
      await pool(2, queue.filter((i) => i.status === 'queued'), uploadItem);
    }
  } finally {
    running = false;
    renderQueue();
    loadList(true);
  }
}

$('choose-btn').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('upload-btn').addEventListener('click', startUpload);
$('retry-btn').addEventListener('click', () => {
  queue.filter((i) => i.status === 'failed' && !i.fatal).forEach((i) => { i.status = 'queued'; });
  startUpload();
});
$('clear-btn').addEventListener('click', () => {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].status === 'done') queue.splice(i, 1);
  renderQueue();
});

const dz = $('dropzone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });
// Thả nhầm ngoài vùng drop sẽ không làm trình duyệt mở file thay vì upload.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

window.addEventListener('beforeunload', (e) => {
  if (running) { e.preventDefault(); e.returnValue = ''; }
});

// ======================================================================
// Danh sách resource
// ======================================================================
const list = { q: '', sort: 'newest', page: 1, items: [], total: 0, selected: new Set(), loading: false, token: 0 };

async function loadList(reset) {
  if (reset) { list.page = 1; list.items = []; }
  const token = ++list.token;
  list.loading = true;
  $('list-status').hidden = true;
  try {
    const qs = new URLSearchParams({ q: list.q, sort: list.sort, page: list.page, limit: 30 });
    const data = await api(`/api/resources?${qs}`);
    if (token !== list.token) return;
    list.items = reset ? data.items : list.items.concat(data.items);
    list.total = data.total;
    $('more').hidden = !data.hasMore;
    list.selected = new Set([...list.selected].filter((id) => list.items.some((r) => r.id === id) || !reset));
    renderList();
  } catch (err) {
    if (handleAuth(err)) return;
    $('list-status').textContent = 'Could not load resources.';
    $('list-status').hidden = false;
  } finally {
    if (token === list.token) list.loading = false;
  }
}

function renderList() {
  $('total').textContent = list.total ? `(${list.total})` : '';
  $('list').replaceChildren(...list.items.map(row));
  $('list').hidden = list.items.length === 0;
  $('list-status').hidden = list.items.length !== 0;
  if (!list.items.length) $('list-status').textContent = list.q ? 'No resources match your search.' : 'No resources yet. Drop files above to add some.';
  syncBulk();
}

function row(r) {
  const cb = h('input', { type: 'checkbox', 'aria-label': `Select ${r.name}` });
  cb.checked = list.selected.has(r.id);
  cb.addEventListener('change', () => { cb.checked ? list.selected.add(r.id) : list.selected.delete(r.id); syncBulk(); });
  const sub = [meta(r), r.category, r.width && r.height ? `${r.width} × ${r.height}` : null].filter(Boolean).join(' · ');
  return h('div', { class: 'row', 'data-id': r.id },
    cb,
    h('div', { class: 'mini' }, thumbNode(r)),
    h('div', {},
      h('div', { class: 'r-name', title: r.name }, r.name),
      h('div', { class: 'r-meta' }, sub)),
    h('div', { class: 'r-actions' },
      h('button', { class: 'btn secondary small', type: 'button', onclick: () => openEdit(r) }, 'Edit'),
      h('button', { class: 'btn secondary small', type: 'button', onclick: () => confirmDelete([r]) }, 'Delete')));
}

function syncBulk() {
  const n = list.selected.size;
  $('bulk-delete').disabled = n === 0;
  $('bulk-delete').textContent = n ? `Delete selected (${n})` : 'Delete selected';
  $('select-all').checked = list.items.length > 0 && list.items.every((r) => list.selected.has(r.id));
  $('select-all').indeterminate = n > 0 && !$('select-all').checked;
}

$('select-all').addEventListener('change', (e) => {
  if (e.target.checked) list.items.forEach((r) => list.selected.add(r.id)); else list.selected.clear();
  renderList();
});
$('bulk-delete').addEventListener('click', () => confirmDelete(list.items.filter((r) => list.selected.has(r.id))));
$('search').addEventListener('input', debounce((e) => { list.q = e.target.value.trim(); loadList(true); }, 250));
$('sort').addEventListener('change', (e) => { list.sort = e.target.value; loadList(true); });
$('more-btn').addEventListener('click', () => { if (!list.loading) { list.page++; loadList(false); } });

// ======================================================================
// Xoá (có xác nhận)
// ======================================================================
const cDlg = $('confirm-dialog');
let pendingDelete = [];

function confirmDelete(items) {
  if (!items.length) return;
  pendingDelete = items;
  const one = items.length === 1;
  $('c-title').textContent = one ? 'Delete this resource?' : `Delete ${items.length} resources?`;
  const names = items.slice(0, 5).map((r) => h('li', {}, r.fileName));
  if (items.length > 5) names.push(h('li', {}, `and ${items.length - 5} more`));
  $('c-body').replaceChildren(one ? h('p', { class: 'dlg-text' }, items[0].fileName) : h('ul', { class: 'dlg-list' }, names));
  $('c-ok').disabled = false;
  cDlg.showModal();
}

$('c-cancel').addEventListener('click', () => cDlg.close());
$('c-ok').addEventListener('click', async () => {
  $('c-ok').disabled = true;
  try {
    const ids = pendingDelete.map((r) => r.id);
    if (ids.length === 1) await api(`/api/admin/resources/${ids[0]}`, { method: 'DELETE' });
    else await api('/api/admin/resources/bulk-delete', { method: 'POST', json: { ids } });
    ids.forEach((id) => list.selected.delete(id));
    cDlg.close();
    toast(ids.length === 1 ? 'Deleted.' : `Deleted ${ids.length} resources.`);
    loadList(true);
  } catch (err) {
    if (handleAuth(err)) { cDlg.close(); return; }
    toast(err.message || 'Delete failed.', 'error');
    $('c-ok').disabled = false;
  }
});

// ======================================================================
// Sửa
// ======================================================================
const eDlg = $('edit-dialog');
let editing = null;
let newThumb = null;

function renderEditThumb(src) {
  $('e-thumb').replaceChildren(src ? h('img', { src, alt: '' }) : (editing ? thumbNode({ ...editing, thumb: null }) : ''));
}

function openEdit(r) {
  editing = r;
  newThumb = null;
  $('e-name').value = r.name;
  $('e-desc').value = r.description || '';
  $('e-cat').value = r.category;
  $('e-tags').value = r.tags.join(', ');
  $('e-error').textContent = '';
  $('e-save').disabled = false;
  renderEditThumb(r.thumb);
  eDlg.showModal();
}

$('e-thumb-btn').addEventListener('click', () => $('e-thumb-input').click());
$('e-thumb-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const prepared = await prepareImage(file);
  if (!prepared.thumb) { $('e-error').textContent = 'That image could not be read. Try a JPG, PNG or WebP.'; return; }
  $('e-error').textContent = '';
  newThumb = prepared.thumb;
  renderEditThumb(URL.createObjectURL(newThumb));
});

$('e-cancel').addEventListener('click', () => eDlg.close());
$('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editing) return;
  $('e-save').disabled = true;
  $('e-error').textContent = '';
  try {
    await api(`/api/admin/resources/${editing.id}`, {
      method: 'PUT',
      json: { name: $('e-name').value, description: $('e-desc').value, category: $('e-cat').value, tags: $('e-tags').value },
    });
    if (newThumb) {
      await api(`/api/admin/resources/${editing.id}/thumbnail`, {
        method: 'PUT', body: newThumb, headers: { 'Content-Type': newThumb.type || 'image/webp' },
      });
    }
    eDlg.close();
    toast('Saved.');
    loadList(true);
  } catch (err) {
    if (handleAuth(err)) { eDlg.close(); return; }
    $('e-error').textContent = err.message;
    $('e-save').disabled = false;
  }
});

// ======================================================================
// Khởi động
// ======================================================================
(async function boot() {
  try {
    const { authenticated } = await api('/api/auth/me');
    if (authenticated) await showApp(); else showLogin();
  } catch {
    showLogin();
  }
})();
