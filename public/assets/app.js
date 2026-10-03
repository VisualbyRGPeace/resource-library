import { api, h, fmtSize, debounce, initTheme, thumbNode, placeholder, meta, downloadButton, toast } from './common.js';

initTheme(document.getElementById('theme-toggle'));

const $ = (id) => document.getElementById(id);
const grid = $('grid'), statusEl = $('status'), moreEl = $('more'), modal = $('modal');
const PAGE_SIZE = 48;

const params = new URLSearchParams(location.search);
const state = {
  q: params.get('q') || '',
  category: params.get('category') || '',
  sort: params.get('sort') || 'newest',
  page: 1,
  loading: false,
  token: 0,
};
$('search').value = state.q;
$('sort').value = [...$('sort').options].some((o) => o.value === state.sort) ? state.sort : 'newest';

function syncUrl() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.category) p.set('category', state.category);
  if (state.sort !== 'newest') p.set('sort', state.sort);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function card(r) {
  return h('article', { class: 'card' },
    h('button', { class: 'thumb', type: 'button', 'aria-label': `Preview ${r.name}`, onclick: () => openModal(r) }, thumbNode(r)),
    h('div', { class: 'card-body' },
      h('h3', { class: 'card-title', title: r.name }, r.name),
      h('p', { class: 'card-meta' }, meta(r)),
      r.width && r.height ? h('p', { class: 'card-meta' }, `${r.width} × ${r.height}`) : null,
      downloadButton(r)));
}

async function load(reset) {
  if (reset) { state.page = 1; grid.replaceChildren(); }
  const token = ++state.token;
  state.loading = true;
  statusEl.hidden = true;
  moreEl.hidden = true;
  syncUrl();
  try {
    const qs = new URLSearchParams({ q: state.q, category: state.category, sort: state.sort, page: state.page, limit: PAGE_SIZE });
    const data = await api(`/api/resources?${qs}`);
    if (token !== state.token) return; // đã có truy vấn mới hơn
    grid.append(...data.items.map(card));
    if (!data.total) {
      statusEl.textContent = state.q || state.category ? 'No resources match your search.' : 'No resources yet.';
      statusEl.hidden = false;
    }
    moreEl.hidden = !data.hasMore;
  } catch {
    if (token !== state.token) return;
    statusEl.textContent = 'Could not load resources. Check your connection and try again.';
    statusEl.hidden = false;
  } finally {
    if (token === state.token) state.loading = false;
  }
}

async function loadChips() {
  const chips = $('chips');
  try {
    const rows = await api('/api/categories');
    if (rows.length < 2) { chips.hidden = true; return; }
    const make = (label, value) => {
      const b = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(state.category === value) }, label);
      b.addEventListener('click', () => {
        state.category = value;
        chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
        load(true);
      });
      return b;
    };
    chips.replaceChildren(make('All', ''), ...rows.map((r) => make(r.category, r.category)));
  } catch { chips.hidden = true; }
}

function openModal(r) {
  const box = h('div', { class: 'preview-box' });
  if (r.isImage) {
    const img = h('img', { src: `/api/resources/${r.id}/preview`, alt: r.name });
    img.addEventListener('error', () => box.replaceChildren(r.thumb ? thumbNode(r) : placeholder(r.type)), { once: true });
    box.append(img);
  } else {
    box.append(r.thumb ? thumbNode(r) : placeholder(r.type));
  }
  modal.replaceChildren(
    h('button', { class: 'btn secondary icon dlg-close', type: 'button', 'aria-label': 'Close', onclick: () => modal.close() }, '✕'),
    h('div', { class: 'dlg-body' },
      box,
      h('div', { class: 'preview-info' },
        h('h2', {}, r.name),
        h('p', {}, meta(r) + (r.width && r.height ? ` · ${r.width} × ${r.height}` : '')),
        r.description ? h('p', {}, r.description) : null,
        r.tags.length ? h('div', { class: 'tags' }, r.tags.map((t) => h('span', { class: 'tag' }, t))) : null,
        downloadButton(r))));
  modal.showModal();
}
modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });

$('search').addEventListener('input', debounce((e) => { state.q = e.target.value.trim(); load(true); }, 250));
$('sort').addEventListener('change', (e) => { state.sort = e.target.value; load(true); });
$('more-btn').addEventListener('click', () => { if (!state.loading) { state.page++; load(false); } });

loadChips();
load(true);
