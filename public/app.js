/* S3 Browser — vanilla JS, virtualized, paginated */

const ROW_H = 44;
const OVERSCAN = 8;
const FETCH_AHEAD_PX = 600;
const PAGE_HARD_CAP = 100_000;

const state = {
  config: null,
  buckets: [],
  bucket: null,
  prefix: '',
  items: [],
  nextToken: null,
  hasMore: false,
  loading: false,
  filter: '',
  sort: { key: 'name', dir: 'asc' },
  selection: new Set(),
  focusIndex: -1,
  visible: [],
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ------------------------------------------------------------ utilities */

function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

function fmtSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  const now = new Date();
  const diff = (now - dt) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  const opts = dt.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  return dt.toLocaleDateString(undefined, opts);
}

function iconRef(name, type) {
  if (type === 'folder') return '#i-folder';
  const ext = name.split('.').pop().toLowerCase();
  if (['png','jpg','jpeg','gif','webp','svg','bmp','ico','heic','avif'].includes(ext)) return '#i-image';
  if (['mp4','mov','webm','avi','mkv','m4v'].includes(ext)) return '#i-video';
  if (['mp3','wav','flac','ogg','m4a','aac'].includes(ext)) return '#i-music';
  if (['zip','tar','gz','rar','7z','bz2','xz'].includes(ext)) return '#i-archive';
  if (['js','ts','tsx','jsx','py','go','rs','c','cpp','h','java','rb','php','html','css','sh','sql','yaml','yml','toml','json','xml'].includes(ext)) return '#i-code';
  if (['md','txt','log','csv','tsv','rtf'].includes(ext)) return '#i-file-text';
  return '#i-file';
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ------------------------------------------------------------ data */

async function loadConnection() {
  const r = await fetch('/api/connection', { credentials: 'same-origin' });
  const data = await r.json();
  if (!data.connected) return null;
  state.config = data;
  $('#metaEndpoint').textContent = data.endpoint ? data.endpoint.replace(/^https?:\/\//, '') : 'aws (default)';
  $('#metaRegion').textContent = data.region;
  $('#metaAccess').textContent = data.accessKey || '—';
  $('#metaStyle').textContent = data.pathStyle ? 'path' : 'vhost';
  return data;
}

async function loadBuckets() {
  const { buckets } = await api('/api/buckets');
  state.buckets = buckets;
  if (!state.bucket || !buckets.find(b => b.name === state.bucket)) {
    const def = state.config?.defaultBucket || '';
    state.bucket = def && buckets.find(b => b.name === def) ? def : (buckets[0]?.name || null);
  }
  renderBucketPicker();
}

async function fetchPage(reset) {
  if (state.loading) return;
  state.loading = true;
  renderStatus();
  try {
    const params = new URLSearchParams({
      bucket: state.bucket,
      prefix: state.prefix,
    });
    if (!reset && state.nextToken) params.set('token', state.nextToken);
    const data = await api(`/api/list?${params}`);
    if (reset) {
      state.items = [];
      state.selection.clear();
      state.focusIndex = -1;
    }
    state.items.push(
      ...data.folders.map(f => ({ ...f })),
      ...data.files.map(f => ({ ...f })),
    );
    state.nextToken = data.nextToken;
    state.hasMore = !!data.nextToken && state.items.length < PAGE_HARD_CAP;
    sortItems();
    computeVisible();
    renderHeader();
    renderList();
    renderCrumbs();
    renderDetails();
    renderSelectionBar();
  } catch (e) {
    toast(e.message);
  } finally {
    state.loading = false;
    renderStatus();
  }
}

function sortItems() {
  const { key, dir } = state.sort;
  const mul = dir === 'asc' ? 1 : -1;
  state.items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    let va = a[key], vb = b[key];
    if (key === 'name') return a.name.localeCompare(b.name, undefined, { numeric: true }) * mul;
    if (key === 'size') return ((va ?? 0) - (vb ?? 0)) * mul;
    if (key === 'lastModified') return ((new Date(va || 0)) - (new Date(vb || 0))) * mul;
    return 0;
  });
}

function computeVisible() {
  const q = state.filter.trim().toLowerCase();
  state.visible = q
    ? state.items.filter(it => it.name.toLowerCase().includes(q))
    : state.items;
}

/* ------------------------------------------------------------ rendering: sidebar */

function renderBucketPicker() {
  $('#bucketLabel').textContent = state.bucket || '—';
  const menu = $('#bucketMenu');
  menu.innerHTML = '';
  for (const b of state.buckets) {
    const item = document.createElement('div');
    item.className = 'bucket-item' + (b.name === state.bucket ? ' active' : '');
    item.innerHTML = `<svg class="icon-sm"><use href="#i-database"/></svg><span>${escapeHtml(b.name)}</span><svg class="icon-sm check"><use href="#i-check"/></svg>`;
    item.onclick = () => {
      state.bucket = b.name;
      state.prefix = '';
      $('#bucketMenu').hidden = true;
      writeHash();
      renderBucketPicker();
      fetchPage(true);
    };
    menu.appendChild(item);
  }
  const sep = document.createElement('div'); sep.className = 'bucket-menu-sep'; menu.appendChild(sep);
  const add = document.createElement('div');
  add.className = 'bucket-menu-action';
  add.innerHTML = `<svg class="icon-sm"><use href="#i-plus"/></svg><span>New bucket…</span>`;
  add.onclick = () => { $('#bucketMenu').hidden = true; openNewBucket(); };
  menu.appendChild(add);
}

/* ------------------------------------------------------------ rendering: top */

function renderCrumbs() {
  const el = $('#crumbs');
  el.innerHTML = '';
  const root = document.createElement('button');
  root.className = 'crumb';
  root.innerHTML = `<svg class="icon-sm"><use href="#i-database"/></svg><span>${escapeHtml(state.bucket || '')}</span>`;
  root.onclick = () => navigate('');
  el.appendChild(root);
  const parts = state.prefix.split('/').filter(Boolean);
  let acc = '';
  parts.forEach((p, i) => {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.innerHTML = `<svg class="icon-xs"><use href="#i-chevron-right"/></svg>`;
    el.appendChild(sep);
    acc += p + '/';
    const c = document.createElement('button');
    c.className = 'crumb' + (i === parts.length - 1 ? ' current' : '');
    c.textContent = p;
    const target = acc;
    c.onclick = () => navigate(target);
    el.appendChild(c);
  });
}

function renderHeader() {
  $$('.lh-col').forEach(el => {
    const k = el.dataset.sort;
    el.classList.toggle('sort-active', k === state.sort.key);
    el.classList.toggle('sort-desc', k === state.sort.key && state.sort.dir === 'desc');
  });
}

/* ------------------------------------------------------------ rendering: list (virtualized) */

let scrollEl, spacerEl, viewportEl;
let renderScheduled = false;

function renderList() {
  const total = state.visible.length;
  spacerEl.style.height = `${total * ROW_H}px`;
  scheduleRender();
  $('#listEmpty').hidden = total > 0 || state.loading;
  renderStatus();
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderVisibleRows();
  });
}

function renderVisibleRows() {
  const scrollTop = scrollEl.scrollTop;
  const viewportH = scrollEl.clientHeight;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(state.visible.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);

  // Reuse existing children if possible
  const existing = new Map();
  for (const node of viewportEl.children) {
    existing.set(parseInt(node.dataset.index, 10), node);
  }

  const stillUsed = new Set();
  for (let i = first; i < last; i++) {
    const item = state.visible[i];
    if (!item) continue;
    let row = existing.get(i);
    if (!row) {
      row = buildRow(item, i);
      viewportEl.appendChild(row);
    } else {
      updateRow(row, item, i);
    }
    row.style.transform = `translateY(${i * ROW_H}px)`;
    stillUsed.add(i);
  }
  for (const [idx, node] of existing) {
    if (!stillUsed.has(idx)) node.remove();
  }
}

function buildRow(item, index) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.index = index;
  row.innerHTML = `
    <div class="row-check"><input type="checkbox"/></div>
    <div class="row-name">
      <span class="row-icon"><svg><use/></svg></span>
      <span class="row-name-text"></span>
    </div>
    <div class="row-size"></div>
    <div class="row-mod"></div>
    <div class="row-actions"></div>
  `;
  const cb = row.querySelector('input');
  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('change', () => {
    const it = state.visible[parseInt(row.dataset.index, 10)];
    if (cb.checked) state.selection.add(it.key);
    else state.selection.delete(it.key);
    row.classList.toggle('selected', cb.checked);
    renderSelectionBar();
    renderDetails();
  });
  row.addEventListener('click', (e) => {
    if (e.target.closest('.row-actions') || e.target.closest('.row-check')) return;
    const it = state.visible[parseInt(row.dataset.index, 10)];
    if (!it) return;
    if (e.metaKey || e.ctrlKey) {
      if (state.selection.has(it.key)) state.selection.delete(it.key);
      else state.selection.add(it.key);
      renderVisibleRows(); renderSelectionBar(); renderDetails();
    } else if (it.type === 'folder') {
      navigate(it.key);
    } else {
      openPreview(it);
    }
  });
  row.addEventListener('dblclick', (e) => {
    const it = state.visible[parseInt(row.dataset.index, 10)];
    if (it && it.type === 'folder') navigate(it.key);
  });
  updateRow(row, item, index);
  return row;
}

function updateRow(row, item, index) {
  row.dataset.index = index;
  const cb = row.querySelector('input');
  const selected = state.selection.has(item.key);
  cb.checked = selected;
  row.classList.toggle('selected', selected);
  row.classList.toggle('focused', state.focusIndex === index);

  const icon = row.querySelector('.row-icon');
  icon.classList.toggle('folder', item.type === 'folder');
  icon.querySelector('use').setAttribute('href', iconRef(item.name, item.type));

  row.querySelector('.row-name-text').textContent = item.name;
  row.querySelector('.row-size').textContent = item.type === 'folder' ? '—' : fmtSize(item.size);
  row.querySelector('.row-mod').textContent = item.type === 'folder' ? '' : fmtDate(item.lastModified);

  const acts = row.querySelector('.row-actions');
  if (acts.childElementCount === 0) {
    if (item.type === 'file') {
      acts.appendChild(rowAction('#i-share', 'Share', (e) => { e.stopPropagation(); openShare(item); }));
      acts.appendChild(rowAction('#i-download', 'Download', (e) => { e.stopPropagation(); downloadOne(item.key); }));
    }
    acts.appendChild(rowAction('#i-edit', 'Rename', (e) => { e.stopPropagation(); openRename(item); }));
    acts.appendChild(rowAction('#i-trash', 'Delete', (e) => { e.stopPropagation(); deleteOne(item); }));
  }
}

function rowAction(href, title, onclick) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.title = title;
  b.innerHTML = `<svg class="icon-sm"><use href="${href}"/></svg>`;
  b.onclick = onclick;
  return b;
}

function renderStatus() {
  const el = $('#listStatus');
  el.hidden = false;
  if (state.loading) {
    el.innerHTML = `<svg class="spin"><use href="#i-loader"/></svg><span>Loading…</span>`;
    return;
  }
  if (state.hasMore) {
    el.textContent = `Loaded ${state.items.length.toLocaleString()} items · scroll to load more`;
    return;
  }
  if (state.items.length === 0) {
    el.hidden = true;
    return;
  }
  el.textContent = `${state.items.length.toLocaleString()} item${state.items.length === 1 ? '' : 's'}`;
}

function maybeLoadMore() {
  if (state.loading || !state.hasMore) return;
  const remaining = scrollEl.scrollHeight - (scrollEl.scrollTop + scrollEl.clientHeight);
  if (remaining < FETCH_AHEAD_PX) fetchPage(false);
}

/* ------------------------------------------------------------ rendering: selection & details */

function renderSelectionBar() {
  const n = state.selection.size;
  $('#selectionBar').hidden = n === 0;
  $('#selCount').textContent = n;
  $('#checkAll').checked = n > 0 && state.visible.every(it => state.selection.has(it.key));
}

function selectedItems() {
  return state.items.filter(it => state.selection.has(it.key));
}

function renderDetails() {
  const sel = selectedItems();
  const el = $('#details');
  if (sel.length !== 1 || sel[0].type !== 'file') { el.hidden = true; return; }
  el.hidden = false;
  const it = sel[0];
  $('#detailsIcon').innerHTML = `<svg><use href="${iconRef(it.name, it.type)}"/></svg>`;
  $('#detailsName').textContent = it.name;
  const list = $('#detailsList');
  list.innerHTML = '';
  const entries = [
    ['Size', fmtSize(it.size)],
    ['Modified', new Date(it.lastModified).toLocaleString()],
    ['Path', '/' + it.key],
    ['ETag', (it.etag || '').replace(/"/g, '')],
  ];
  for (const [k, v] of entries) {
    const d = document.createElement('div');
    d.innerHTML = `<dt>${k}</dt><dd></dd>`;
    d.querySelector('dd').textContent = v;
    list.appendChild(d);
  }
  $('#detailsOpen').onclick = () => openPreview(it);
  $('#detailsDownload').onclick = () => downloadOne(it.key);
  $('#detailsShare').onclick = () => openShare(it);
  $('#detailsRename').onclick = () => openRename(it);
  $('#detailsDelete').onclick = () => deleteOne(it);
}

/* ------------------------------------------------------------ actions */

function navigate(prefix) {
  state.prefix = prefix;
  writeHash();
  fetchPage(true);
}

function writeHash() {
  const v = `${state.bucket || ''}:${state.prefix || ''}`;
  history.replaceState(null, '', '#' + encodeURIComponent(v));
}

function readHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  const [b, p] = h.split(':');
  if (b) state.bucket = b;
  if (p !== undefined) state.prefix = p;
}

async function deleteOne(item) {
  const label = item.type === 'folder' ? `folder “${item.name}” and everything in it` : `“${item.name}”`;
  if (!confirm(`Delete ${label}?`)) return;
  try {
    await fetch(`/api/object?bucket=${encodeURIComponent(state.bucket)}&key=${encodeURIComponent(item.key)}`, { method: 'DELETE' });
    state.items = state.items.filter(i => i.key !== item.key);
    state.selection.delete(item.key);
    computeVisible(); renderList(); renderSelectionBar(); renderDetails();
    toast('Deleted');
  } catch (e) { toast(e.message); }
}

async function bulkDelete() {
  const items = selectedItems();
  if (!items.length) return;
  if (!confirm(`Delete ${items.length} item(s)?`)) return;
  try {
    await api('/api/objects', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: state.bucket, keys: items.map(i => i.key) }),
    });
    const keys = new Set(items.map(i => i.key));
    state.items = state.items.filter(i => !keys.has(i.key));
    state.selection.clear();
    computeVisible(); renderList(); renderSelectionBar(); renderDetails();
    toast(`Deleted ${items.length}`);
  } catch (e) { toast(e.message); }
}

function downloadOne(key) {
  const a = document.createElement('a');
  a.href = `/api/download?bucket=${encodeURIComponent(state.bucket)}&key=${encodeURIComponent(key)}`;
  a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}

function bulkDownload() {
  for (const it of selectedItems()) if (it.type === 'file') downloadOne(it.key);
}

function openShare(item) {
  openModal({
    title: 'Share link',
    body: `
      <label>Link expires after
        <select id="expSel">
          <option value="3600">1 hour</option>
          <option value="86400" selected>1 day</option>
          <option value="604800">7 days</option>
        </select>
      </label>
      <div id="shareResult" class="share-result" hidden></div>
    `,
    actions: [
      { label: 'Cancel', cls: 'btn-ghost', onclick: closeModal },
      { label: 'Generate link', cls: 'btn-primary', onclick: async (btn) => {
        const expires = parseInt($('#expSel').value, 10);
        try {
          btn.disabled = true; btn.textContent = 'Generating…';
          const { url } = await api(`/api/presign?bucket=${encodeURIComponent(state.bucket)}&key=${encodeURIComponent(item.key)}&expires=${expires}`);
          const r = $('#shareResult');
          r.hidden = false;
          r.innerHTML = `<a href="${url}" target="_blank" rel="noopener"></a><button class="icon-btn" id="copyLink" title="Copy"><svg class="icon-sm"><use href="#i-link"/></svg></button>`;
          r.querySelector('a').textContent = url;
          $('#copyLink').onclick = async () => { await navigator.clipboard.writeText(url); toast('Link copied'); };
          await navigator.clipboard.writeText(url).catch(() => {});
          toast('Link copied');
          btn.disabled = false; btn.textContent = 'Generate link';
        } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Generate link'; }
      }},
    ],
  });
}

function openRename(item) {
  const isFolder = item.type === 'folder';
  openModal({
    title: `Rename ${isFolder ? 'folder' : 'file'}`,
    body: `<label>New name<input type="text" id="newName" value="${escapeAttr(item.name)}"/></label>`,
    actions: [
      { label: 'Cancel', cls: 'btn-ghost', onclick: closeModal },
      { label: 'Rename', cls: 'btn-primary', onclick: async () => {
        const newName = $('#newName').value.trim();
        if (!newName || newName === item.name) return closeModal();
        const newKey = state.prefix + newName + (isFolder ? '/' : '');
        try {
          await api('/api/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bucket: state.bucket, from: item.key, to: newKey }),
          });
          closeModal();
          toast('Renamed');
          fetchPage(true);
        } catch (e) { toast(e.message); }
      }},
    ],
  });
  setTimeout(() => {
    const inp = $('#newName');
    if (!inp) return;
    inp.focus();
    const dot = item.name.lastIndexOf('.');
    if (!isFolder && dot > 0) inp.setSelectionRange(0, dot); else inp.select();
  }, 20);
}

function openNewFolder() {
  openModal({
    title: 'New folder',
    body: `<label>Name<input type="text" id="folderName" placeholder="folder name"/></label>`,
    actions: [
      { label: 'Cancel', cls: 'btn-ghost', onclick: closeModal },
      { label: 'Create', cls: 'btn-primary', onclick: async () => {
        const name = $('#folderName').value.trim();
        if (!name) return;
        try {
          await api('/api/folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bucket: state.bucket, prefix: state.prefix, name }),
          });
          closeModal();
          toast('Folder created');
          fetchPage(true);
        } catch (e) { toast(e.message); }
      }},
    ],
  });
  setTimeout(() => $('#folderName')?.focus(), 20);
}

function openNewBucket() {
  openModal({
    title: 'New bucket',
    body: `<label>Bucket name<input type="text" id="bucketName" placeholder="my-bucket"/></label>`,
    actions: [
      { label: 'Cancel', cls: 'btn-ghost', onclick: closeModal },
      { label: 'Create', cls: 'btn-primary', onclick: async () => {
        const name = $('#bucketName').value.trim();
        if (!name) return;
        try {
          await api('/api/buckets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          closeModal();
          state.bucket = name; state.prefix = '';
          await loadBuckets();
          writeHash();
          fetchPage(true);
        } catch (e) { toast(e.message); }
      }},
    ],
  });
  setTimeout(() => $('#bucketName')?.focus(), 20);
}

/* ------------------------------------------------------------ modal */

function openModal({ title, body, actions = [] }) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  const foot = $('#modalFoot'); foot.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.cls || ''}`;
    b.textContent = a.label;
    b.onclick = () => a.onclick(b);
    foot.appendChild(b);
  }
  $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; }

/* ------------------------------------------------------------ preview */

async function openPreview(item) {
  $('#previewName').textContent = item.name;
  const body = $('#previewBody');
  body.innerHTML = `<div class="preview-fallback"><svg><use href="#i-loader"/></svg><div>Loading…</div></div>`;
  $('#preview').hidden = false;
  const url = `/api/download?bucket=${encodeURIComponent(state.bucket)}&key=${encodeURIComponent(item.key)}&inline=1`;
  const ext = item.name.split('.').pop().toLowerCase();
  $('#previewDl').onclick = () => downloadOne(item.key);
  $('#previewShare').onclick = () => openShare(item);
  if (['png','jpg','jpeg','gif','webp','svg','bmp','avif'].includes(ext)) {
    body.innerHTML = `<img alt="" src="${url}"/>`;
  } else if (['mp4','webm','mov','m4v'].includes(ext)) {
    body.innerHTML = `<video src="${url}" controls autoplay></video>`;
  } else if (['mp3','wav','ogg','flac','m4a'].includes(ext)) {
    body.innerHTML = `<audio src="${url}" controls autoplay></audio>`;
  } else if (ext === 'pdf') {
    body.innerHTML = `<iframe src="${url}"></iframe>`;
  } else if (item.size != null && item.size < 2 * 1024 * 1024) {
    try {
      const res = await fetch(url); const text = await res.text();
      const pre = document.createElement('pre'); pre.textContent = text;
      body.innerHTML = ''; body.appendChild(pre);
    } catch {
      body.innerHTML = `<div class="preview-fallback"><svg><use href="#i-file"/></svg><div>No preview available</div></div>`;
    }
  } else {
    body.innerHTML = `<div class="preview-fallback"><svg><use href="#i-file"/></svg><div>No preview for .${ext} files</div></div>`;
  }
}

function closePreview() { $('#preview').hidden = true; $('#previewBody').innerHTML = ''; }

/* ------------------------------------------------------------ upload */

const uploadQueue = { active: 0, max: 4, queued: [] };

function enqueueUpload(file, relPath) {
  return new Promise((resolve) => {
    uploadQueue.queued.push({ file, relPath, resolve });
    pumpUploads();
  });
}

function pumpUploads() {
  while (uploadQueue.active < uploadQueue.max && uploadQueue.queued.length) {
    const job = uploadQueue.queued.shift();
    uploadQueue.active++;
    runUpload(job).finally(() => { uploadQueue.active--; pumpUploads(); });
  }
  if (uploadQueue.active === 0 && uploadQueue.queued.length === 0) {
    fetchPage(true);
  }
}

function runUpload({ file, relPath, resolve }) {
  return new Promise((res) => {
    const card = addUploadCard(relPath);
    const fd = new FormData();
    fd.append('file', file, relPath);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?bucket=${encodeURIComponent(state.bucket)}&prefix=${encodeURIComponent(state.prefix)}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) card.update(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      const ok = xhr.status >= 200 && xhr.status < 300;
      card.done(ok);
      resolve?.(ok); res();
    };
    xhr.onerror = () => { card.done(false); resolve?.(false); res(); };
    xhr.send(fd);
  });
}

function addUploadCard(name) {
  const card = document.createElement('div');
  card.className = 'upload-item';
  card.innerHTML = `
    <div class="upload-row">
      <svg class="icon-sm" style="color: var(--muted)"><use href="#i-upload"/></svg>
      <span class="upload-name"></span>
      <span class="upload-pct">0%</span>
    </div>
    <div class="upload-bar"><div></div></div>
  `;
  card.querySelector('.upload-name').textContent = name;
  $('#uploads').appendChild(card);
  return {
    update(pct) {
      card.querySelector('.upload-pct').textContent = pct + '%';
      card.querySelector('.upload-bar > div').style.width = pct + '%';
    },
    done(ok) {
      card.classList.add(ok ? 'done' : 'fail');
      card.querySelector('.upload-pct').textContent = ok ? 'Done' : 'Failed';
      if (ok) card.querySelector('.upload-bar > div').style.width = '100%';
      setTimeout(() => card.remove(), ok ? 1400 : 4000);
    },
  };
}

function uploadFiles(fileList) {
  for (const f of fileList) {
    const rel = f.webkitRelativePath || f.name;
    enqueueUpload(f, rel);
  }
}

/* Drag-and-drop with folders via DataTransferItem entries */

async function walkEntry(entry, path = '') {
  if (entry.isFile) {
    const file = await new Promise((r) => entry.file(r));
    enqueueUpload(file, path + entry.name);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((r) => reader.readEntries(r));
      for (const e of batch) await walkEntry(e, path + entry.name + '/');
    } while (batch.length);
  }
}

async function handleDrop(e) {
  e.preventDefault();
  if (e.dataTransfer.items && e.dataTransfer.items[0]?.webkitGetAsEntry) {
    for (const item of e.dataTransfer.items) {
      const entry = item.webkitGetAsEntry();
      if (entry) await walkEntry(entry);
    }
  } else if (e.dataTransfer.files) {
    uploadFiles(e.dataTransfer.files);
  }
}

function setupDropzone() {
  const target = $('.files-pane');
  const overlay = $('#dragOverlay');
  let depth = 0;
  const show = () => { overlay.hidden = false; $('#dragPath').textContent = '/' + state.prefix; };
  target.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault(); depth++; show();
  });
  target.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  target.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (depth === 0) overlay.hidden = true; });
  target.addEventListener('drop', async (e) => { depth = 0; overlay.hidden = true; await handleDrop(e); });
}

/* ------------------------------------------------------------ keyboard */

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#preview').hidden) return closePreview();
      if (!$('#modal').hidden) return closeModal();
      if (state.selection.size) { state.selection.clear(); renderVisibleRows(); renderSelectionBar(); renderDetails(); return; }
    }
    if (e.target.matches('input, textarea, select')) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault();
      state.visible.forEach(it => state.selection.add(it.key));
      renderVisibleRows(); renderSelectionBar(); renderDetails();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      state.focusIndex = Math.max(0, Math.min(state.visible.length - 1, (state.focusIndex < 0 ? 0 : state.focusIndex + dir)));
      const item = state.visible[state.focusIndex];
      if (e.shiftKey && item) state.selection.add(item.key);
      ensureFocusedVisible();
      renderVisibleRows();
      renderSelectionBar();
      renderDetails();
    } else if (e.key === 'Enter' && state.focusIndex >= 0) {
      const it = state.visible[state.focusIndex];
      if (it?.type === 'folder') navigate(it.key);
      else if (it) openPreview(it);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selection.size) { e.preventDefault(); bulkDelete(); }
    } else if (e.key === ' ' && state.focusIndex >= 0) {
      e.preventDefault();
      const it = state.visible[state.focusIndex];
      if (!it) return;
      if (state.selection.has(it.key)) state.selection.delete(it.key); else state.selection.add(it.key);
      renderVisibleRows(); renderSelectionBar(); renderDetails();
    }
  });
}

function ensureFocusedVisible() {
  const top = state.focusIndex * ROW_H;
  const bot = top + ROW_H;
  if (top < scrollEl.scrollTop) scrollEl.scrollTop = top;
  else if (bot > scrollEl.scrollTop + scrollEl.clientHeight) scrollEl.scrollTop = bot - scrollEl.clientHeight;
}

/* ------------------------------------------------------------ helpers */

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s) { return escapeHtml(s); }

/* ------------------------------------------------------------ wiring */

function wire() {
  scrollEl = $('#listScroll');
  spacerEl = $('#listSpacer');
  viewportEl = $('#listViewport');

  scrollEl.addEventListener('scroll', () => { scheduleRender(); maybeLoadMore(); }, { passive: true });
  new ResizeObserver(scheduleRender).observe(scrollEl);

  $('#bucketPickerBtn').onclick = (e) => { e.stopPropagation(); const m = $('#bucketMenu'); m.hidden = !m.hidden; };
  document.addEventListener('click', (e) => {
    if (!$('#bucketPicker').contains(e.target)) $('#bucketMenu').hidden = true;
  });

  $('#newFolderBtn').onclick = openNewFolder;
  $('#uploadBtn').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => { uploadFiles(e.target.files); e.target.value = ''; };

  const searchInput = $('#search');
  const onSearch = debounce(() => {
    state.filter = searchInput.value;
    $('#searchClear').hidden = !state.filter;
    computeVisible(); renderList();
  }, 80);
  searchInput.addEventListener('input', onSearch);
  $('#searchClear').onclick = () => { searchInput.value = ''; state.filter = ''; $('#searchClear').hidden = true; computeVisible(); renderList(); };

  $('#checkAll').onchange = (e) => {
    if (e.target.checked) state.visible.forEach(it => state.selection.add(it.key));
    else state.selection.clear();
    renderVisibleRows(); renderSelectionBar(); renderDetails();
  };
  $('#selClear').onclick = () => { state.selection.clear(); renderVisibleRows(); renderSelectionBar(); renderDetails(); };
  $('#selDelete').onclick = bulkDelete;
  $('#selDownload').onclick = bulkDownload;
  $('#selShare').onclick = () => {
    const f = selectedItems().filter(i => i.type === 'file');
    if (f.length === 1) openShare(f[0]);
    else toast('Select a single file to share');
  };

  $$('.lh-col').forEach(el => {
    el.onclick = () => {
      const k = el.dataset.sort;
      if (state.sort.key === k) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      else { state.sort.key = k; state.sort.dir = 'asc'; }
      sortItems(); computeVisible(); renderHeader(); renderList();
    };
  });

  $('#modalClose').onclick = closeModal;
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  $('#previewClose').onclick = closePreview;
  $('#preview').addEventListener('click', (e) => { if (e.target.id === 'preview') closePreview(); });

  $('#detailsClose').onclick = () => { state.selection.clear(); renderVisibleRows(); renderSelectionBar(); renderDetails(); };

  setupDropzone();
  setupKeyboard();
}

/* ------------------------------------------------------------ connect screen */

const REMEMBER_KEY = 's3browser.remembered';

function setupConnectScreen() {
  const sel = $('#cfRegion');
  const custom = $('#cfRegionCustom');
  sel.addEventListener('change', () => {
    custom.hidden = sel.value !== '__custom__';
    if (sel.value === '__custom__') custom.focus();
  });

  $('#pwToggle').onclick = () => {
    const i = $('#cfSecretKey');
    i.type = i.type === 'password' ? 'text' : 'password';
  };

  // prefill from localStorage if present
  try {
    const r = JSON.parse(localStorage.getItem(REMEMBER_KEY) || 'null');
    if (r) {
      $('#cfEndpoint').value = r.endpoint || '';
      $('#cfAccessKey').value = r.accessKey || '';
      $('#cfBucket').value = r.defaultBucket || '';
      $('#cfPathStyle').checked = r.pathStyle !== false;
      if (r.region) {
        const known = Array.from(sel.options).some(o => o.value === r.region);
        if (known) sel.value = r.region;
        else { sel.value = '__custom__'; custom.hidden = false; custom.value = r.region; }
      }
    }
  } catch {}

  $('#connectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#connectError'); err.hidden = true;
    const region = sel.value === '__custom__' ? custom.value.trim() : sel.value;
    const body = {
      endpoint: $('#cfEndpoint').value.trim(),
      region,
      accessKey: $('#cfAccessKey').value.trim(),
      secretKey: $('#cfSecretKey').value,
      pathStyle: $('#cfPathStyle').checked,
      defaultBucket: $('#cfBucket').value.trim(),
    };
    const btn = $('#connectBtn');
    btn.disabled = true; btn.querySelector('span').textContent = 'Connecting…';
    try {
      const r = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `${r.status} ${r.statusText}`);
      }
      if ($('#cfRemember').checked) {
        localStorage.setItem(REMEMBER_KEY, JSON.stringify({
          endpoint: body.endpoint, region: body.region,
          accessKey: body.accessKey, defaultBucket: body.defaultBucket,
          pathStyle: body.pathStyle,
        }));
      } else {
        localStorage.removeItem(REMEMBER_KEY);
      }
      $('#connect').hidden = true;
      await loadConnection();
      await startApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false; btn.querySelector('span').textContent = 'Test & connect';
    }
  });
}

function showConnectScreen() {
  $('#connect').hidden = false;
  setTimeout(() => $('#cfAccessKey').focus(), 30);
}

async function disconnect() {
  await fetch('/api/disconnect', { method: 'POST', credentials: 'same-origin' });
  state.bucket = null; state.prefix = ''; state.items = []; state.selection.clear();
  if (scrollEl) viewportEl.innerHTML = '';
  showConnectScreen();
}

/* ------------------------------------------------------------ init */

let wired = false;

async function startApp() {
  await loadBuckets();
  if (!wired) { wire(); wired = true; }
  renderHeader();
  if (state.bucket) await fetchPage(true);
  else { renderCrumbs(); renderList(); }
}

async function init() {
  setupConnectScreen();
  $('#disconnectBtn')?.addEventListener('click', disconnect);
  readHash();
  try {
    const conn = await loadConnection();
    if (!conn) { showConnectScreen(); return; }
    await startApp();
  } catch (e) {
    console.error(e);
    showConnectScreen();
  }
}

init();
