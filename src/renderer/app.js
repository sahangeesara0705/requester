import {
  h, svg, ICONS, debounce, formatBytes, formatTime, highlightJson, codeTextarea, toast,
  openMenu, openModal, promptModal, confirmModal, makeResizer, uid,
} from './util.js';
import {
  METHODS, BODY_MODES, AUTH_TYPES, COMMON_HEADERS, kv, newRequest, newFolder, newCollection, normalizeData,
  findNode, walkRequests, removeNode, cloneWithNewIds, isDescendant, moveNode, syncParamsFromUrl,
  syncUrlFromParams, effectiveAuth, resolveRequest, toCurl, parseCurl, exportPayload, importAny,
} from './model.js';

const api = window.api;
const $ = (sel) => document.querySelector(sel);

const S = {
  data: null,
  responses: new Map(), // requestId -> response | {pending:true}
  inflight: new Map(), // requestId -> spec id
  reqTab: new Map(), // requestId -> sub tab
  resTab: 'body',
  resView: 'pretty',
  filter: '',
  renamingId: null,
  dragId: null,
};

const persist = debounce(() => api.saveData(S.data), 350);
function commit() { persist(); }

// =====================================================================
// Boot
// =====================================================================
async function init() {
  let raw = null;
  try { raw = await api.loadData(); } catch (_) { /* first run */ }
  S.data = normalizeData(raw);
  if (!raw) commit();

  applyTheme();
  applySidebarWidth();
  wireChrome();
  renderAll();

  window.addEventListener('beforeunload', () => {
    persist.cancel();
    api.saveDataSync(S.data);
  });
  api.onMenu((cmd) => {
    if (cmd === 'new-request') createRequestQuick();
    else if (cmd === 'new-collection') createCollection();
    else if (cmd === 'import') openImportModal();
    else if (cmd === 'export-all') exportAll();
  });
}

function applyTheme() {
  const t = S.data.settings.theme;
  const resolved = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
  document.documentElement.dataset.theme = resolved;
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => S.data && applyTheme());

function applySidebarWidth() {
  $('#sidebar').style.width = `${S.data.ui.sidebarWidth}px`;
}

function wireChrome() {
  $('#btn-new-collection').addEventListener('click', createCollection);
  $('#btn-envs').addEventListener('click', () => openEnvironmentsModal());
  $('#btn-import').addEventListener('click', openImportModal);
  $('#btn-export').addEventListener('click', exportAll);
  $('#btn-settings').addEventListener('click', openSettingsModal);
  $('#env-select').addEventListener('change', (e) => {
    S.data.activeEnvironmentId = e.target.value || null;
    commit();
    renderEnvSelect();
  });
  $('#tree-filter').addEventListener('input', (e) => {
    S.filter = e.target.value.trim().toLowerCase();
    renderTree();
  });

  makeResizer($('#sidebar-resizer'), {
    onStart: () => S.data.ui.sidebarWidth,
    onMove: (dx, _dy, start) => {
      S.data.ui.sidebarWidth = Math.max(180, Math.min(560, start + dx));
      applySidebarWidth();
    },
    onEnd: commit,
  });

  // Tree background context menu
  $('#tree').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.node')) return;
    e.preventDefault();
    openMenu([{ label: 'New Collection', action: createCollection }, { label: 'Import…', action: openImportModal }], e.clientX, e.clientY);
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (document.querySelector('.modal-backdrop')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (S.data.activeTabId) toggleSend(S.data.activeTabId);
    } else if (e.key.toLowerCase() === 'w') {
      e.preventDefault();
      if (S.data.activeTabId) closeTab(S.data.activeTabId);
    } else if (e.key.toLowerCase() === 's') {
      e.preventDefault();
      persist.flush();
      toast('All changes are saved automatically');
    } else if (e.key.toLowerCase() === 'l') {
      const u = $('.url-input');
      if (u) { e.preventDefault(); u.focus(); u.select(); }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const tabs = S.data.openTabs;
      if (tabs.length < 2) return;
      const i = tabs.indexOf(S.data.activeTabId);
      openTab(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]);
    }
  });
}

function renderAll() {
  renderEnvSelect();
  renderTree();
  renderTabs();
  renderEditor();
}

// =====================================================================
// Environments select
// =====================================================================
function renderEnvSelect() {
  const sel = $('#env-select');
  sel.innerHTML = '';
  sel.appendChild(h('option', { value: '' }, 'No environment'));
  for (const env of S.data.environments) sel.appendChild(h('option', { value: env.id }, env.name));
  if (!S.data.environments.some((e) => e.id === S.data.activeEnvironmentId)) S.data.activeEnvironmentId = null;
  sel.value = S.data.activeEnvironmentId || '';
  sel.parentElement.classList.toggle('active', !!S.data.activeEnvironmentId);
}

// =====================================================================
// Sidebar tree
// =====================================================================
const SHORT_METHOD = { DELETE: 'DEL', OPTIONS: 'OPT' };

function methodBadge(req, cls = 'span.method') {
  if (req.body && req.body.mode === 'graphql') return h(cls, { class: 'm-GQL' }, 'GQL');
  const m = req.method;
  return h(cls, { class: METHODS.includes(m) ? `m-${m}` : 'm-other' }, SHORT_METHOD[m] || m);
}

function nodeMatches(node) {
  if (!S.filter) return true;
  if (node.name.toLowerCase().includes(S.filter)) return true;
  if (node.type === 'request') return node.url.toLowerCase().includes(S.filter);
  return node.items.some(nodeMatches);
}

function renderTree() {
  const tree = $('#tree');
  const scroll = tree.scrollTop;
  tree.innerHTML = '';
  if (!S.data.collections.length) {
    tree.appendChild(h('div.tree-empty',
      h('div', 'No collections yet.'),
      h('div', 'Create one to group and save your requests.'),
      h('button.btn.primary', { on: { click: createCollection } }, 'New Collection')));
    return;
  }
  for (const col of S.data.collections) renderNode(tree, col, 0);
  tree.scrollTop = scroll;
  const input = tree.querySelector('.rename-input');
  if (input) { input.focus(); input.select(); }
}

function renderNode(parentEl, node, depth) {
  if (!nodeMatches(node)) return;
  const isContainer = node.type !== 'request';
  const open = isContainer && (node.expanded || !!S.filter);
  const selected = node.id === S.data.activeTabId;

  const row = h('div.node', {
    class: `${node.type}${selected ? ' selected' : ''}${S.inflight.has(node.id) ? ' spinning' : ''}`,
    style: { paddingLeft: `${8 + depth * 14}px` },
    draggable: !S.filter && S.renamingId !== node.id ? 'true' : 'false',
    'data-id': node.id,
  });

  if (isContainer) {
    const chev = svg(ICONS.chevron, 14);
    chev.classList.add('chev');
    if (open) chev.classList.add('open');
    row.appendChild(chev);
    const ico = svg(node.type === 'collection' ? ICONS.box : (open ? ICONS.folderOpen : ICONS.folder), 15);
    ico.classList.add('ico');
    row.appendChild(ico);
  } else {
    row.appendChild(methodBadge(node));
  }

  if (S.renamingId === node.id) {
    const input = h('input.input.rename-input', { value: node.name, spellcheck: 'false' });
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v) { node.name = v; commit(); }
      S.renamingId = null;
      renderTree();
      renderTabs();
      if (node.id === S.data.activeTabId) renderBreadcrumb();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    row.appendChild(input);
  } else {
    row.appendChild(h('span.label', { title: node.type === 'request' ? `${node.name}\n${node.url}` : node.name }, node.name));
  }

  const more = h('span.more', { title: 'More actions' }, svg(ICONS.more, 14));
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = more.getBoundingClientRect();
    more.classList.add('open');
    showNodeMenu(node, r.left, r.bottom + 2, () => more.classList.remove('open'));
  });
  row.appendChild(more);

  row.addEventListener('click', () => {
    if (S.renamingId) return;
    if (isContainer) {
      node.expanded = !node.expanded;
      commit();
      renderTree();
    } else {
      openTab(node.id);
    }
  });
  row.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(node.id);
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showNodeMenu(node, e.clientX, e.clientY);
  });
  row.addEventListener('mousedown', (e) => {
    if (e.button === 1 && !isContainer) { e.preventDefault(); openTab(node.id); }
  });
  wireDrag(row, node);

  parentEl.appendChild(row);
  if (open) for (const child of node.items) renderNode(parentEl, child, depth + 1);
}

function startRename(id) {
  S.renamingId = id;
  renderTree();
}

function clearDropClasses() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-inside'));
}

function dropPosition(row, node, e) {
  const drag = S.dragId && findNode(S.data, S.dragId);
  if (!drag || drag.node.id === node.id) return null;
  const rect = row.getBoundingClientRect();
  const ratio = (e.clientY - rect.top) / rect.height;
  if (drag.node.type === 'collection') {
    if (node.type !== 'collection') return null;
    return ratio < 0.5 ? 'before' : 'after';
  }
  if (isDescendant(drag.node, node.id)) return null;
  if (node.type === 'collection') return 'inside';
  if (node.type === 'folder') return ratio < 0.25 ? 'before' : ratio > 0.75 && !node.expanded ? 'after' : 'inside';
  return ratio < 0.5 ? 'before' : 'after';
}

function wireDrag(row, node) {
  row.addEventListener('dragstart', (e) => {
    S.dragId = node.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', node.id);
  });
  row.addEventListener('dragover', (e) => {
    const pos = dropPosition(row, node, e);
    clearDropClasses();
    if (!pos) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add(`drop-${pos}`);
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-inside'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    const pos = dropPosition(row, node, e);
    clearDropClasses();
    if (pos && moveNode(S.data, S.dragId, node.id, pos)) {
      commit();
      renderTree();
      if (S.data.activeTabId) renderBreadcrumb();
    }
    S.dragId = null;
  });
  row.addEventListener('dragend', () => {
    S.dragId = null;
    clearDropClasses();
  });
}

function showNodeMenu(node, x, y, onClose) {
  const items = [];
  if (node.type !== 'request') {
    items.push(
      { label: 'New Request', action: () => createRequestIn(node) },
      { label: 'New Folder', action: () => createFolderIn(node) },
      '-',
      { label: node.type === 'collection' ? 'Collection Settings…' : 'Folder Settings…', action: () => openContainerSettings(node) },
      { label: 'Rename', action: () => startRename(node.id) },
      { label: 'Duplicate', action: () => duplicateNode(node) },
    );
    if (node.type === 'collection') items.push({ label: 'Export…', action: () => exportCollection(node) });
    items.push('-', { label: 'Delete', danger: true, action: () => deleteNode(node) });
  } else {
    items.push(
      { label: 'Open', action: () => openTab(node.id) },
      { label: 'Rename', action: () => startRename(node.id) },
      { label: 'Duplicate', action: () => duplicateNode(node) },
      { label: 'Copy as cURL', action: () => copyAsCurl(node.id) },
      '-',
      { label: 'Delete', danger: true, action: () => deleteNode(node) },
    );
  }
  openMenu(items, x, y, onClose);
}

// ---------- tree actions ----------
async function createCollection() {
  const name = await promptModal('New Collection', { value: 'New Collection', okLabel: 'Create' });
  if (!name) return;
  const col = newCollection(name);
  S.data.collections.push(col);
  commit();
  renderTree();
}

function createRequestIn(container, req = newRequest()) {
  container.items.push(req);
  container.expanded = true;
  commit();
  openTab(req.id);
  setTimeout(() => { const u = $('.url-input'); if (u) u.focus(); });
  return req;
}

/** Ctrl+N: create next to the active request, or in the first collection. */
function createRequestQuick(req) {
  let container = null;
  if (S.data.activeTabId) {
    const f = findNode(S.data, S.data.activeTabId);
    if (f) container = f.parent;
  }
  if (!container) container = S.data.collections[0];
  if (!container) {
    container = newCollection('My Collection');
    S.data.collections.push(container);
  }
  return createRequestIn(container, req);
}

async function createFolderIn(container) {
  const name = await promptModal('New Folder', { value: 'New Folder', okLabel: 'Create' });
  if (!name) return;
  container.items.push(newFolder(name));
  container.expanded = true;
  commit();
  renderTree();
}

function duplicateNode(node) {
  const copy = cloneWithNewIds(node);
  copy.name = `${node.name} Copy`;
  const f = findNode(S.data, node.id);
  const list = f.parent ? f.parent.items : S.data.collections;
  list.splice(list.indexOf(node) + 1, 0, copy);
  commit();
  if (copy.type === 'request') openTab(copy.id);
  else renderTree();
}

async function deleteNode(node) {
  let count = 0;
  walkRequests(node, () => count++);
  const what = node.type === 'request' ? 'request' : node.type;
  const msg = node.type === 'request'
    ? `Delete request "${node.name}"?`
    : `Delete ${what} "${node.name}" and the ${count} request${count === 1 ? '' : 's'} inside it?`;
  if (!(await confirmModal(`Delete ${what}`, msg))) return;
  const removed = removeNode(S.data, node.id);
  if (removed) {
    walkRequests(removed, (r) => {
      S.responses.delete(r.id);
      S.data.openTabs = S.data.openTabs.filter((id) => id !== r.id);
      if (S.data.activeTabId === r.id) S.data.activeTabId = S.data.openTabs[S.data.openTabs.length - 1] || null;
    });
  }
  commit();
  renderAll();
}

// =====================================================================
// Tabs
// =====================================================================
function openTab(id) {
  if (!S.data.openTabs.includes(id)) {
    const i = S.data.openTabs.indexOf(S.data.activeTabId);
    S.data.openTabs.splice(i >= 0 ? i + 1 : S.data.openTabs.length, 0, id);
  }
  S.data.activeTabId = id;
  // Make sure the request is visible in the tree.
  const f = findNode(S.data, id);
  if (f) for (const a of f.ancestors) a.expanded = true;
  commit();
  renderTree();
  renderTabs();
  renderEditor();
  const sel = document.querySelector(`.node[data-id="${id}"]`);
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function closeTab(id) {
  const tabs = S.data.openTabs;
  const i = tabs.indexOf(id);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (S.data.activeTabId === id) S.data.activeTabId = tabs[Math.min(i, tabs.length - 1)] || null;
  commit();
  renderTree();
  renderTabs();
  renderEditor();
}

function renderTabs() {
  const bar = $('#tabs');
  bar.innerHTML = '';
  S.data.openTabs = S.data.openTabs.filter((id) => {
    const f = findNode(S.data, id);
    return f && f.node.type === 'request';
  });
  if (S.data.activeTabId && !S.data.openTabs.includes(S.data.activeTabId)) S.data.activeTabId = S.data.openTabs[0] || null;

  for (const id of S.data.openTabs) {
    const req = findNode(S.data, id).node;
    const close = h('span.close', { title: 'Close (Ctrl+W)' }, svg(ICONS.close, 11));
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
    const tab = h('div.tab', { class: id === S.data.activeTabId ? 'active' : '', title: req.url || req.name },
      methodBadge(req), h('span.label', req.name), close);
    tab.addEventListener('click', () => openTab(id));
    tab.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(id); } });
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu([
        { label: 'Close', kbd: 'Ctrl+W', action: () => closeTab(id) },
        { label: 'Close Others', action: () => { S.data.openTabs = [id]; S.data.activeTabId = id; commit(); renderTabs(); renderEditor(); renderTree(); } },
        { label: 'Close All', action: () => { S.data.openTabs = []; S.data.activeTabId = null; commit(); renderTabs(); renderEditor(); renderTree(); } },
      ], e.clientX, e.clientY);
    });
    bar.appendChild(tab);
  }
  const active = bar.querySelector('.tab.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function refreshTabAndTreeLabels() {
  renderTabs();
  renderTree();
}
const refreshLabelsSoon = debounce(refreshTabAndTreeLabels, 250);

// =====================================================================
// Editor
// =====================================================================
function activeRequest() {
  if (!S.data.activeTabId) return null;
  const f = findNode(S.data, S.data.activeTabId);
  return f && f.node.type === 'request' ? f : null;
}

function renderEditor() {
  const ed = $('#editor');
  ed.innerHTML = '';
  const f = activeRequest();
  if (!f) {
    ed.appendChild(h('div.empty-state',
      h('img', { src: '../assets/icon.png', alt: '' }),
      h('h2', 'Requester'),
      h('div', 'Select a request from the sidebar, or create a new one.'),
      h('div.row', { style: { marginTop: '8px' } },
        h('button.btn.primary', { on: { click: () => createRequestQuick() } }, 'New Request'),
        h('button.btn', { on: { click: openImportModal } }, 'Import')),
      h('div.shortcuts',
        h('kbd', 'Ctrl+N'), h('span', 'New request'),
        h('kbd', 'Ctrl+Enter'), h('span', 'Send request'),
        h('kbd', 'Ctrl+L'), h('span', 'Focus URL'),
        h('kbd', 'Ctrl+W'), h('span', 'Close tab'),
        h('kbd', 'Ctrl+Tab'), h('span', 'Next tab'),
        h('span', 'Paste cURL'), h('span', 'into the URL bar to import'))));
    return;
  }
  const req = f.node;

  // ---- head: breadcrumb + url bar ----
  const methodSel = h('select.method-select', { class: `m-${req.method}`, title: 'HTTP method' },
    METHODS.map((m) => h('option', { value: m, class: `m-${m}` }, m)));
  methodSel.value = req.method;
  methodSel.addEventListener('change', () => {
    req.method = methodSel.value;
    methodSel.className = `method-select m-${req.method}`;
    commit();
    refreshTabAndTreeLabels();
  });

  const urlInput = h('input.url-input', {
    value: req.url, placeholder: 'Enter URL or paste cURL — e.g. https://api.example.com/users or {{baseUrl}}/users',
    spellcheck: 'false',
  });
  urlInput.addEventListener('input', () => {
    req.url = urlInput.value;
    syncParamsFromUrl(req);
    commit();
    if (currentReqTab(req) === 'params') renderReqPaneBody(req, f);
    updateReqTabCounts(req);
    refreshLabelsSoon();
  });
  urlInput.addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text');
    if (/^\s*curl\s/.test(text)) {
      e.preventDefault();
      const parsed = parseCurl(text);
      if (!parsed) { toast('Could not parse cURL command', 'err'); return; }
      Object.assign(req, { method: parsed.method, url: parsed.url, params: parsed.params, headers: parsed.headers, body: parsed.body, auth: parsed.auth.type === 'inherit' ? req.auth : parsed.auth });
      commit();
      toast('Imported cURL command');
      refreshTabAndTreeLabels();
      renderEditor();
    }
  });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.ctrlKey) { e.preventDefault(); toggleSend(req.id); }
  });

  const sendBtn = h('button.btn.primary.send', { id: 'send-btn', on: { click: () => toggleSend(req.id) } });
  updateSendButton(sendBtn, req.id);

  const moreBtn = h('button.btn.icon', { title: 'More' }, svg(ICONS.more, 16));
  moreBtn.addEventListener('click', () => {
    const r = moreBtn.getBoundingClientRect();
    openMenu([
      { label: 'Copy as cURL', action: () => copyAsCurl(req.id) },
      { label: 'Duplicate', action: () => duplicateNode(req) },
      { label: 'Rename', action: () => startRename(req.id) },
      '-',
      { label: 'Delete', danger: true, action: () => deleteNode(req) },
    ], r.left - 120, r.bottom + 4);
  });

  const head = h('div.request-head',
    h('div.breadcrumb', { id: 'breadcrumb' }),
    h('div.url-bar', h('div.url-group', methodSel, urlInput), sendBtn, moreBtn));

  // ---- panes ----
  const layout = S.data.settings.layout;
  const reqPane = h('div.pane.req', { id: 'req-pane' });
  const resPane = h('div.pane.res', { id: 'res-pane' });
  const resizer = h('div.resizer', { class: layout === 'vertical' ? 'row' : 'col' });
  const panes = h('div.panes', { class: layout === 'vertical' ? 'vertical' : '' }, reqPane, resizer, resPane);
  reqPane.style.flexBasis = `${S.data.ui.splitRatio * 100}%`;
  makeResizer(resizer, {
    axis: layout === 'vertical' ? 'y' : 'x',
    onStart: () => ({ ratio: S.data.ui.splitRatio, size: layout === 'vertical' ? panes.clientHeight : panes.clientWidth }),
    onMove: (dx, dy, ctx) => {
      const delta = (layout === 'vertical' ? dy : dx) / ctx.size;
      S.data.ui.splitRatio = Math.max(0.2, Math.min(0.8, ctx.ratio + delta));
      reqPane.style.flexBasis = `${S.data.ui.splitRatio * 100}%`;
    },
    onEnd: commit,
  });

  ed.append(head, panes);
  renderBreadcrumb();
  renderReqPane(req, f);
  renderResponse(req.id);
}

function renderBreadcrumb() {
  const el = $('#breadcrumb');
  const f = activeRequest();
  if (!el || !f) return;
  el.innerHTML = '';
  for (const a of f.ancestors) {
    const link = h('span', { style: { cursor: 'pointer' }, title: `${a.type === 'collection' ? 'Collection' : 'Folder'} settings` }, a.name);
    link.addEventListener('click', () => openContainerSettings(a));
    el.append(link, h('span', '/'));
  }
  const name = h('span.name', { title: 'Click to rename' }, f.node.name);
  name.addEventListener('click', () => {
    const input = h('input.input', { value: f.node.name, spellcheck: 'false' });
    const done = (save) => {
      if (save && input.value.trim()) { f.node.name = input.value.trim(); commit(); refreshTabAndTreeLabels(); }
      renderBreadcrumb();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = ''; input.blur(); }
    });
    input.addEventListener('blur', () => done(true));
    name.replaceWith(input);
    input.focus();
    input.select();
  });
  el.appendChild(name);
}

function updateSendButton(btn, reqId) {
  btn = btn || $('#send-btn');
  if (!btn) return;
  const busy = S.inflight.has(reqId);
  btn.textContent = busy ? 'Cancel' : 'Send';
  btn.classList.toggle('primary', !busy);
  btn.title = busy ? 'Cancel request' : 'Send (Ctrl+Enter)';
}

// ---------- request pane ----------
function currentReqTab(req) {
  if (S.reqTab.has(req.id)) return S.reqTab.get(req.id);
  return req.body.mode !== 'none' ? 'body' : 'params';
}

function countEnabled(list) {
  return list.filter((x) => x.enabled && x.key).length;
}

function reqTabCounts(req) {
  const f = findNode(S.data, req.id);
  const { auth } = effectiveAuth(req, f.ancestors);
  return {
    params: countEnabled(req.params),
    headers: countEnabled(req.headers),
    body: req.body.mode === 'none' ? '' : (BODY_MODES.find((m) => m.id === req.body.mode) || {}).label,
    auth: auth.type === 'none' ? '' : (AUTH_TYPES.find((a) => a.id === auth.type) || {}).label,
  };
}

function updateReqTabCounts(req) {
  const counts = reqTabCounts(req);
  for (const [k, v] of Object.entries(counts)) {
    const el = document.querySelector(`.subtab[data-tab="${k}"] .count`);
    if (el) { el.textContent = v || ''; el.style.display = v ? '' : 'none'; }
  }
}

function renderReqPane(req, f) {
  const pane = $('#req-pane');
  pane.innerHTML = '';
  const tabs = [['params', 'Params'], ['headers', 'Headers'], ['body', 'Body'], ['auth', 'Auth']];
  const counts = reqTabCounts(req);
  const bar = h('div.subtabs', tabs.map(([id, label]) => {
    const t = h('div.subtab', { class: currentReqTab(req) === id ? 'active' : '', 'data-tab': id },
      label, h('span.count', { style: { display: counts[id] ? '' : 'none' } }, counts[id] || ''));
    t.addEventListener('click', () => {
      S.reqTab.set(req.id, id);
      renderReqPane(req, f);
    });
    return t;
  }));
  pane.append(bar, h('div.pane-body', { id: 'req-body' }));
  renderReqPaneBody(req, f);
}

function renderReqPaneBody(req, f) {
  const body = $('#req-body');
  if (!body) return;
  body.innerHTML = '';
  const tab = currentReqTab(req);
  if (tab === 'params') body.appendChild(renderParams(req));
  else if (tab === 'headers') body.appendChild(renderHeaders(req, f));
  else if (tab === 'body') body.appendChild(renderBody(req));
  else if (tab === 'auth') body.appendChild(renderAuthTab(req, f));
}

function renderParams(req) {
  return h('div',
    h('div.kv-toolbar', h('span', 'Query parameters'), h('span.spacer'),
      h('span', 'Synced with the URL. Use ', h('code', '{{variable}}'), ' for environment values.')),
    kvEditor(req.params, {
      keyPh: 'parameter', valPh: 'value',
      onChange: () => {
        syncUrlFromParams(req);
        const u = $('.url-input');
        if (u) u.value = req.url;
        commit();
        updateReqTabCounts(req);
      },
    }));
}

function renderHeaders(req, f) {
  const wrap = h('div',
    h('div.kv-toolbar', h('span', 'Request headers')),
    kvEditor(req.headers, {
      keyPh: 'Header', valPh: 'value', datalist: 'common-headers',
      onChange: () => { commit(); updateReqTabCounts(req); },
    }));
  const inherited = [];
  for (const a of f.ancestors) for (const hd of a.headers || []) if (hd.enabled && hd.key) inherited.push([hd.key, hd.value, a.name]);
  if (inherited.length) {
    wrap.appendChild(h('div.info-section', { style: { marginTop: '18px' } },
      h('h4', 'Inherited from parent'),
      h('table.htable', inherited.map(([k, v, from]) => h('tr', h('td', k), h('td', v, h('span.muted', `  · ${from}`)))))));
  }
  wrap.appendChild(h('div.hint', { style: { marginTop: '14px' } },
    'Content-Type is set automatically from the body type unless you add it here. Auth headers come from the Auth tab.'));
  return wrap;
}

function renderBody(req) {
  const b = req.body;
  const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } });
  const content = h('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } });
  const modes = h('div.body-modes', BODY_MODES.map((m) => {
    const chip = h('button.chip', { class: b.mode === m.id ? 'active' : '' }, m.label);
    chip.addEventListener('click', () => {
      b.mode = m.id;
      if (m.id === 'graphql' && req.method === 'GET') {
        req.method = 'POST';
        const sel = $('.method-select');
        if (sel) { sel.value = 'POST'; sel.className = 'method-select m-POST'; }
      }
      commit();
      updateReqTabCounts(req);
      refreshTabAndTreeLabels();
      const fresh = renderBody(req);
      wrap.replaceWith(fresh);
    });
    return chip;
  }));
  wrap.append(modes, content);

  if (b.mode === 'none') {
    content.appendChild(h('div.res-empty', h('div', 'This request has no body.'), h('div.hint', 'Pick a body type above to add one.')));
  } else if (b.mode === 'json' || b.mode === 'text' || b.mode === 'xml') {
    const ta = codeTextarea(h('textarea.code', { value: b.raw, placeholder: b.mode === 'json' ? '{\n  "key": "value"\n}' : '' }));
    const status = h('div.code-status');
    const validate = () => {
      if (b.mode !== 'json') return;
      const text = b.raw.trim();
      if (!text) { status.textContent = ''; status.className = 'code-status'; ta.classList.remove('invalid'); return; }
      try {
        // Variables like {{id}} are not JSON; replace them with a placeholder for validation.
        JSON.parse(text.replace(/"?\{\{[^}]+\}\}"?/g, '0'));
        status.textContent = 'Valid JSON';
        status.className = 'code-status';
        ta.classList.remove('invalid');
      } catch (e) {
        status.textContent = e.message;
        status.className = 'code-status err';
        ta.classList.add('invalid');
      }
    };
    ta.addEventListener('input', () => { b.raw = ta.value; commit(); validate(); });
    if (b.mode === 'json') {
      const beautify = h('button.btn.small', 'Beautify');
      beautify.addEventListener('click', () => {
        try {
          b.raw = JSON.stringify(JSON.parse(b.raw), null, 2);
          ta.value = b.raw;
          commit();
          validate();
        } catch (e) {
          toast(`Cannot beautify: ${e.message}`, 'err');
        }
      });
      modes.append(h('span.spacer'), beautify);
    }
    content.append(ta, status);
    validate();
  } else if (b.mode === 'form-urlencoded') {
    content.appendChild(kvEditor(b.form, { keyPh: 'field', valPh: 'value', onChange: commit }));
  } else if (b.mode === 'multipart') {
    content.appendChild(kvEditor(b.multipart, { keyPh: 'field', valPh: 'value', multipart: true, onChange: commit }));
  } else if (b.mode === 'graphql') {
    content.appendChild(renderGraphql(req));
  } else if (b.mode === 'binary') {
    const pathEl = h('span.path', b.file || 'No file selected');
    const pick = h('button.btn', 'Choose File…');
    pick.addEventListener('click', async () => {
      const p = await api.pickFile();
      if (p) { b.file = p; pathEl.textContent = p; commit(); }
    });
    content.appendChild(h('div.file-pick', svg(ICONS.file, 18), pathEl, pick));
    content.appendChild(h('div.hint', { style: { marginTop: '10px' } }, 'The file is sent as the raw request body. Content-Type is guessed from the file extension unless set in Headers.'));
  }
  return wrap;
}

function renderGraphql(req) {
  const g = req.body.graphql;
  const q = codeTextarea(h('textarea.code', { value: g.query, placeholder: 'query {\n  viewer {\n    id\n  }\n}' }));
  q.addEventListener('input', () => { g.query = q.value; commit(); });
  const v = codeTextarea(h('textarea.code', { value: g.variables, placeholder: '{\n  "id": 1\n}' }));
  const status = h('span');
  const validate = () => {
    const t = g.variables.trim();
    if (!t) { status.textContent = ''; v.classList.remove('invalid'); return; }
    try {
      JSON.parse(t.replace(/"?\{\{[^}]+\}\}"?/g, '0'));
      status.textContent = '';
      v.classList.remove('invalid');
    } catch (e) {
      status.textContent = e.message;
      status.style.color = 'var(--danger)';
      v.classList.add('invalid');
    }
  };
  v.addEventListener('input', () => { g.variables = v.value; commit(); validate(); });
  validate();

  const opName = h('input.input', { value: g.operationName || '', placeholder: 'Operation name (optional)', style: { height: '24px', width: '200px', fontSize: '12px' }, spellcheck: 'false' });
  opName.addEventListener('input', () => { g.operationName = opName.value; commit(); });

  const beautifyVars = h('button.btn.small', 'Beautify');
  beautifyVars.addEventListener('click', () => {
    try {
      g.variables = JSON.stringify(JSON.parse(g.variables || '{}'), null, 2);
      v.value = g.variables;
      commit();
      validate();
    } catch (e) { toast(`Cannot beautify: ${e.message}`, 'err'); }
  });

  return h('div.gql',
    h('div.section.query', h('div.section-head', h('span', 'Query'), h('span.spacer'), opName), q),
    h('div.section.vars', h('div.section-head', h('span', 'Variables (JSON)'), status, h('span.spacer'), beautifyVars), v));
}

function renderAuthTab(req, f) {
  const wrap = h('div');
  const rerender = () => { wrap.replaceWith(renderAuthTab(req, f)); updateReqTabCounts(req); };
  wrap.appendChild(authForm(req.auth, { allowInherit: true, ancestors: f.ancestors, onChange: commit, onTypeChange: rerender }));
  return wrap;
}

/** Shared auth editor for requests, folders, and collections. */
function authForm(auth, { allowInherit, ancestors = [], onChange, onTypeChange }) {
  const typeSel = h('select.input', AUTH_TYPES.filter((t) => allowInherit || t.id !== 'inherit').map((t) => h('option', { value: t.id }, t.label)));
  typeSel.value = auth.type;
  typeSel.addEventListener('change', () => { auth.type = typeSel.value; onChange(); onTypeChange(); });

  const input = (obj, key, ph, type = 'text') => {
    const el = h('input.input.mono', { value: obj[key] ?? '', placeholder: ph, type, spellcheck: 'false' });
    el.addEventListener('input', () => { obj[key] = el.value; onChange(); });
    return el;
  };

  const grid = h('div.form-grid', h('label', 'Type'), typeSel);
  const wrap = h('div', grid);

  if (auth.type === 'bearer') {
    grid.append(h('label', 'Token'), input(auth.bearer, 'token', '{{token}} or paste a token'),
      h('label', 'Prefix'), input(auth.bearer, 'prefix', 'Bearer'));
    wrap.appendChild(h('div.hint', 'Sends ', h('code', 'Authorization: <prefix> <token>'), '.'));
  } else if (auth.type === 'basic') {
    grid.append(h('label', 'Username'), input(auth.basic, 'username', 'username'),
      h('label', 'Password'), passwordInput(auth.basic, 'password', onChange));
    wrap.appendChild(h('div.hint', 'Sends ', h('code', 'Authorization: Basic base64(username:password)'), '.'));
  } else if (auth.type === 'apikey') {
    const inSel = h('select.input', h('option', { value: 'header' }, 'Header'), h('option', { value: 'query' }, 'Query Params'));
    inSel.value = auth.apikey.in;
    inSel.addEventListener('change', () => { auth.apikey.in = inSel.value; onChange(); });
    grid.append(h('label', 'Key'), input(auth.apikey, 'key', 'X-API-Key'),
      h('label', 'Value'), input(auth.apikey, 'value', '{{apiKey}}'),
      h('label', 'Add to'), inSel);
  } else if (auth.type === 'inherit') {
    let from = null;
    let eff = null;
    for (let i = ancestors.length - 1; i >= 0; i--) {
      if (ancestors[i].auth && ancestors[i].auth.type !== 'inherit') { from = ancestors[i]; eff = ancestors[i].auth; break; }
    }
    const label = eff ? (AUTH_TYPES.find((a) => a.id === eff.type) || {}).label : 'No Auth';
    const note = h('div.auth-note', 'Using ', h('b', label), from ? [' from ', h('b', from.name), '. '] : '. ');
    if (from) {
      const link = h('a', { href: '#' }, 'Edit');
      link.addEventListener('click', (e) => { e.preventDefault(); openContainerSettings(from); });
      note.appendChild(link);
    }
    wrap.appendChild(h('div', { style: { marginTop: '14px' } }, note));
  } else if (auth.type === 'none') {
    wrap.appendChild(h('div.hint', { style: { marginTop: '14px' } }, 'No authorization will be sent.'));
  }
  if (auth.type === 'bearer' || auth.type === 'basic' || auth.type === 'apikey') {
    wrap.appendChild(h('div.hint', 'Tip: store secrets in an environment and reference them with ', h('code', '{{name}}'), '.'));
  }
  return wrap;
}

function passwordInput(obj, key, onChange) {
  const el = h('input.input.mono.grow', { value: obj[key] ?? '', type: 'password', spellcheck: 'false' });
  el.addEventListener('input', () => { obj[key] = el.value; onChange(); });
  const toggle = h('button.btn.small', 'Show');
  toggle.addEventListener('click', () => {
    el.type = el.type === 'password' ? 'text' : 'password';
    toggle.textContent = el.type === 'password' ? 'Show' : 'Hide';
  });
  return h('div.row', el, toggle);
}

// ---------- key/value editor ----------
function ensureHeaderDatalist() {
  if (document.getElementById('common-headers')) return;
  document.body.appendChild(h('datalist#common-headers', COMMON_HEADERS.map((x) => h('option', { value: x }))));
}

/** Editable table bound to `list` (mutated in place). Trailing empty row adds new entries. */
function kvEditor(list, { onChange, multipart = false, datalist, keyPh = 'Key', valPh = 'Value' }) {
  if (datalist) ensureHeaderDatalist();
  const wrap = h('div.kv');
  wrap.appendChild(h('div.kv-row.head',
    h('div.kv-check'), h('div.kv-cell', keyPh), multipart ? h('div.kv-cell.type', 'Type') : null,
    h('div.kv-cell', valPh), h('div.kv-del')));

  const makeRow = (item, isPlaceholder) => {
    const row = h('div.kv-row', { class: `${isPlaceholder ? 'placeholder' : ''}${item.enabled ? '' : ' disabled'}` });
    let placeholder = isPlaceholder;
    const materialize = () => {
      if (!placeholder) return;
      placeholder = false;
      list.push(item);
      row.classList.remove('placeholder');
      wrap.appendChild(makeRow(blank(), true));
    };

    const cb = h('input', { type: 'checkbox', checked: item.enabled, title: 'Enable / disable' });
    cb.addEventListener('change', () => {
      materialize();
      item.enabled = cb.checked;
      row.classList.toggle('disabled', !item.enabled);
      onChange();
    });

    const keyIn = h('input.kv-input', { value: item.key, placeholder: keyPh, spellcheck: 'false', list: datalist || null });
    keyIn.addEventListener('input', () => { materialize(); item.key = keyIn.value; onChange(); });

    const valueCell = h('div.kv-cell');
    const renderValue = () => {
      valueCell.innerHTML = '';
      if (multipart && item.type === 'file') {
        const name = h('span', { title: item.path || '' }, item.path || 'No file chosen');
        const btn = h('button.btn.small', 'Choose…');
        btn.addEventListener('click', async () => {
          const p = await api.pickFile();
          if (!p) return;
          materialize();
          item.path = p;
          name.textContent = p;
          name.title = p;
          onChange();
        });
        valueCell.appendChild(h('div.kv-file', name, btn));
      } else {
        const valIn = h('input.kv-input', { value: item.value, placeholder: valPh, spellcheck: 'false' });
        valIn.addEventListener('input', () => { materialize(); item.value = valIn.value; onChange(); });
        valueCell.appendChild(valIn);
      }
    };
    renderValue();

    let typeCell = null;
    if (multipart) {
      const sel = h('select', h('option', { value: 'text' }, 'Text'), h('option', { value: 'file' }, 'File'));
      sel.value = item.type || 'text';
      sel.addEventListener('change', () => { materialize(); item.type = sel.value; renderValue(); onChange(); });
      typeCell = h('div.kv-cell.type', sel);
    }

    const del = h('div.kv-del', { title: 'Remove' }, svg(ICONS.trash, 14));
    del.addEventListener('click', () => {
      const i = list.indexOf(item);
      if (i >= 0) list.splice(i, 1);
      row.remove();
      onChange();
    });

    row.append(...[h('div.kv-check', cb), h('div.kv-cell', keyIn), typeCell, valueCell, del].filter(Boolean));
    return row;
  };
  const blank = () => ({ id: uid(), key: '', value: '', enabled: true, ...(multipart ? { type: 'text', path: '' } : {}) });

  for (const item of list) wrap.appendChild(makeRow(item, false));
  wrap.appendChild(makeRow(blank(), true));
  return wrap;
}

// =====================================================================
// Sending
// =====================================================================
async function toggleSend(reqId) {
  if (S.inflight.has(reqId)) {
    await api.cancel(S.inflight.get(reqId));
    return;
  }
  persist.flush();
  let resolved;
  try {
    resolved = resolveRequest(S.data, reqId, S.data.settings);
  } catch (e) {
    S.responses.set(reqId, { ok: false, error: e.message, time: 0 });
    renderResponse(reqId);
    return;
  }
  const { spec, missing } = resolved;
  if (!spec.url) {
    toast('Enter a URL first', 'err');
    const u = $('.url-input');
    if (u) u.focus();
    return;
  }
  if (missing.length) toast(`Undefined variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`, 'err');

  S.inflight.set(reqId, spec.id);
  S.responses.set(reqId, { pending: true, startedAt: Date.now() });
  afterSendStateChange(reqId);

  const res = await api.send(spec);
  res.spec = spec;
  S.inflight.delete(reqId);
  if (findNode(S.data, reqId)) S.responses.set(reqId, res);
  afterSendStateChange(reqId);
}

function afterSendStateChange(reqId) {
  if (S.data.activeTabId === reqId) {
    updateSendButton(null, reqId);
    renderResponse(reqId);
  }
  const row = document.querySelector(`.node[data-id="${reqId}"]`);
  if (row) row.classList.toggle('spinning', S.inflight.has(reqId));
}

async function copyAsCurl(reqId) {
  try {
    const { spec } = resolveRequest(S.data, reqId, S.data.settings);
    await navigator.clipboard.writeText(toCurl(spec));
    toast('cURL command copied to clipboard');
  } catch (e) {
    toast(e.message, 'err');
  }
}

// =====================================================================
// Response
// =====================================================================
function statusClass(status) {
  return `s-${String(status)[0]}`;
}

function renderResponse(reqId) {
  const pane = $('#res-pane');
  if (!pane) return;
  pane.innerHTML = '';
  const res = S.responses.get(reqId);

  const tabs = [['body', 'Body'], ['headers', 'Headers'], ['info', 'Info']];
  const bar = h('div.subtabs');
  for (const [id, label] of tabs) {
    const count = id === 'headers' && res && res.ok ? res.headers.length : 0;
    const t = h('div.subtab', { class: S.resTab === id ? 'active' : '' }, label, count ? h('span.count', count) : null);
    t.addEventListener('click', () => { S.resTab = id; renderResponse(reqId); });
    bar.appendChild(t);
  }
  bar.appendChild(h('span.spacer'));
  if (res && res.ok) {
    bar.appendChild(h('div.res-status',
      h('span.status-pill', { class: statusClass(res.status) }, `${res.status} ${res.statusText}`),
      h('span.stat', h('span.muted', 'Time '), h('b', formatTime(res.time))),
      h('span.stat', h('span.muted', 'Size '), h('b', formatBytes(res.size)))));
  } else if (res && res.ok === false) {
    bar.appendChild(h('div.res-status', h('span.status-pill.s-err', 'Error'), h('span.stat', h('span.muted', 'Time '), h('b', formatTime(res.time)))));
  }

  const body = h('div.pane-body');
  pane.append(bar, body);

  if (!res) {
    body.appendChild(h('div.res-empty', svg(ICONS.send, 42), h('div', 'Send a request to see the response here.'),
      h('div.hint', h('kbd', 'Ctrl'), ' + ', h('kbd', 'Enter'))));
    return;
  }
  if (res.pending) {
    const cancel = h('button.btn', 'Cancel');
    cancel.addEventListener('click', () => toggleSend(reqId));
    body.appendChild(h('div.res-empty', h('div.spinner'), h('div', 'Sending request…'), cancel));
    return;
  }
  if (!res.ok) {
    body.appendChild(h('div.res-error', h('h3', 'Could not get a response'), h('pre.mono', res.error + (res.code ? `\n\nCode: ${res.code}` : ''))));
    body.appendChild(h('div.hint', { style: { marginTop: '12px' } },
      'Check the URL, your network connection, and whether the server is running. For self-signed certificates, turn off SSL verification in Settings.'));
    return;
  }

  if (S.resTab === 'body') renderResponseBody(body, res, reqId);
  else if (S.resTab === 'headers') {
    body.appendChild(h('table.htable', res.headers.map(([k, v]) => h('tr', h('td', k), h('td', v)))));
  } else {
    renderResponseInfo(body, res);
  }
}

function prettyText(res) {
  const ct = (res.contentType || '').toLowerCase();
  const text = res.bodyText ?? '';
  const looksJson = ct.includes('json') || /^\s*[[{]/.test(text);
  if (looksJson) {
    try {
      return { text: JSON.stringify(JSON.parse(text), null, 2), json: true };
    } catch (_) { /* not JSON */ }
  }
  return { text, json: false };
}

function renderResponseBody(body, res, reqId) {
  const ct = (res.contentType || '').toLowerCase();
  const isImage = ct.startsWith('image/');
  const isHtml = ct.includes('text/html');
  const canPreview = isImage || isHtml;
  const views = res.isText ? ['pretty', 'raw', ...(canPreview ? ['preview'] : [])] : (isImage ? ['preview'] : []);
  let view = views.includes(S.resView) ? S.resView : views[0];

  const toggle = h('div.view-toggle', views.map((v) => {
    const b = h('button', { class: v === view ? 'active' : '' }, v[0].toUpperCase() + v.slice(1));
    b.addEventListener('click', () => { S.resView = v; renderResponse(reqId); });
    return b;
  }));

  const copyBtn = h('button.btn.small', 'Copy');
  copyBtn.addEventListener('click', async () => {
    const text = view === 'pretty' ? prettyText(res).text : (res.bodyText ?? '');
    await navigator.clipboard.writeText(text);
    toast('Response copied');
  });
  const saveBtn = h('button.btn.small', 'Save…');
  saveBtn.addEventListener('click', async () => {
    let name = 'response';
    try { name = decodeURIComponent(new URL(res.url).pathname.split('/').filter(Boolean).pop() || 'response'); } catch (_) { /* default */ }
    if (!/\.\w+$/.test(name)) {
      const ext = ct.includes('json') ? '.json' : ct.includes('html') ? '.html' : ct.includes('xml') ? '.xml' : ct.startsWith('text/') ? '.txt' : '';
      name += ext;
    }
    const r = await api.saveResponse(name, res.bodyBase64);
    if (!r.canceled) toast(`Saved to ${r.filePath}`);
  });
  const wrapBtn = h('button.btn.small', { title: 'Toggle line wrapping' }, S.data.settings.wrapResponse ? 'No wrap' : 'Wrap');
  wrapBtn.addEventListener('click', () => {
    S.data.settings.wrapResponse = !S.data.settings.wrapResponse;
    commit();
    renderResponse(reqId);
  });

  body.appendChild(h('div.res-toolbar', views.length > 1 ? toggle : null,
    h('span.muted', { style: { fontSize: '12px' } }, res.contentType || 'no content-type'),
    h('span.spacer'), res.isText && view !== 'preview' ? wrapBtn : null, res.isText ? copyBtn : null, saveBtn));

  if (!res.isText && !isImage) {
    body.appendChild(h('div.res-empty', svg(ICONS.file, 36),
      h('div', `Binary response (${formatBytes(res.decodedSize)})`),
      h('div.hint', 'Use Save… to write it to a file.')));
    return;
  }

  if (view === 'preview') {
    if (isImage) {
      body.appendChild(h('div.img-preview', h('img', { src: `data:${ct.split(';')[0]};base64,${res.bodyBase64}`, alt: 'response image' })));
    } else {
      // Fully sandboxed: no scripts, no same-origin access.
      body.appendChild(h('iframe.preview-frame', { sandbox: '', srcdoc: res.bodyText || '' }));
    }
    return;
  }

  const pre = h('pre.code-view', { class: S.data.settings.wrapResponse ? 'wrap' : '' });
  if (view === 'raw') {
    pre.textContent = res.bodyText || '';
  } else {
    const p = prettyText(res);
    if (p.json && p.text.length < 3_000_000) pre.innerHTML = highlightJson(p.text);
    else pre.textContent = p.text;
  }
  if (!res.bodyText) pre.appendChild(h('span.muted', '(empty response body)'));
  body.appendChild(pre);
}

function renderResponseInfo(body, res) {
  const spec = res.spec || {};
  body.appendChild(h('div.info-section', h('h4', 'General'), h('table.htable',
    h('tr', h('td', 'Request URL'), h('td', spec.url || '')),
    res.url !== spec.url ? h('tr', h('td', 'Final URL'), h('td', res.url)) : null,
    h('tr', h('td', 'Method'), h('td', spec.method || '')),
    h('tr', h('td', 'Status'), h('td', `${res.status} ${res.statusText}`)),
    h('tr', h('td', 'HTTP version'), h('td', res.httpVersion || '')),
    h('tr', h('td', 'Time'), h('td', formatTime(res.time))),
    h('tr', h('td', 'Size (transferred)'), h('td', formatBytes(res.size))),
    h('tr', h('td', 'Size (decoded)'), h('td', formatBytes(res.decodedSize))))));
  if (res.redirects && res.redirects.length) {
    body.appendChild(h('div.info-section', h('h4', 'Redirects'), h('table.htable',
      res.redirects.map((r) => h('tr', h('td', String(r.status)), h('td', `${r.from} → ${r.to}`))))));
  }
  body.appendChild(h('div.info-section', h('h4', 'Request headers sent'), h('table.htable',
    (res.sentHeaders || []).map(([k, v]) => h('tr', h('td', k), h('td', v))))));
}

// =====================================================================
// Modals: collection/folder settings
// =====================================================================
function openContainerSettings(node) {
  const isCol = node.type === 'collection';
  const tabs = isCol ? [['auth', 'Auth'], ['headers', 'Headers'], ['variables', 'Variables']] : [['auth', 'Auth'], ['headers', 'Headers']];
  let tab = 'auth';
  const content = h('div');
  const tabBar = h('div.settings-tabs');
  const ancestors = isCol ? [] : findNode(S.data, node.id).ancestors;

  const renderContent = () => {
    tabBar.innerHTML = '';
    for (const [id, label] of tabs) {
      const t = h('div.subtab', { class: tab === id ? 'active' : '' }, label);
      t.addEventListener('click', () => { tab = id; renderContent(); });
      tabBar.appendChild(t);
    }
    content.innerHTML = '';
    if (tab === 'auth') {
      content.appendChild(h('div.hint', `Requests inside this ${node.type} that use "Inherit from parent" will use this auth.`));
      content.appendChild(authForm(node.auth, { allowInherit: !isCol, ancestors, onChange: commit, onTypeChange: renderContent }));
    } else if (tab === 'headers') {
      content.appendChild(h('div.hint', `Sent with every request inside this ${node.type}. Request headers with the same name override these.`));
      content.appendChild(kvEditor(node.headers, { keyPh: 'Header', valPh: 'value', datalist: 'common-headers', onChange: commit }));
    } else {
      content.appendChild(h('div.hint', 'Collection variables are available as ', h('code', '{{name}}'), ' in this collection. The active environment overrides variables with the same name.'));
      content.appendChild(kvEditor(node.variables, { keyPh: 'Variable', valPh: 'value', onChange: commit }));
    }
  };
  renderContent();

  const nameIn = h('input.input', { value: node.name, spellcheck: 'false', style: { width: '100%' } });
  nameIn.addEventListener('input', () => { if (nameIn.value.trim()) { node.name = nameIn.value.trim(); commit(); } });

  openModal({
    title: `${isCol ? 'Collection' : 'Folder'} Settings`,
    wide: true,
    body: h('div', tabBar, h('div.field', h('label', 'Name'), nameIn), content),
    buttons: [{ label: 'Done', primary: true }],
    onClose: () => {
      renderTree();
      renderTabs();
      renderEditor();
    },
  });
}

// =====================================================================
// Modals: environments
// =====================================================================
function openEnvironmentsModal(selectId) {
  let selected = selectId || S.data.activeEnvironmentId || (S.data.environments[0] && S.data.environments[0].id);
  const listEl = h('div.env-list');
  const detail = h('div.env-detail');

  const render = () => {
    listEl.innerHTML = '';
    for (const env of S.data.environments) {
      const item = h('div.env-item', { class: env.id === selected ? 'active' : '' },
        h('span.label', env.name), env.id === S.data.activeEnvironmentId ? h('span.badge', 'ACTIVE') : null);
      item.addEventListener('click', () => { selected = env.id; render(); });
      listEl.appendChild(item);
    }
    const add = h('button.btn.small', { style: { marginTop: '8px' } }, '+ Add Environment');
    add.addEventListener('click', () => {
      const env = { id: uid(), name: `Environment ${S.data.environments.length + 1}`, variables: [] };
      S.data.environments.push(env);
      selected = env.id;
      commit();
      render();
      const n = detail.querySelector('input');
      if (n) { n.focus(); n.select(); }
    });
    listEl.appendChild(add);

    detail.innerHTML = '';
    const env = S.data.environments.find((e) => e.id === selected);
    if (!env) {
      detail.appendChild(h('div.res-empty', h('div', 'No environments yet.'), h('div.hint', 'Environments hold variables like base URLs and tokens.')));
      return;
    }
    const nameIn = h('input.input', { value: env.name, spellcheck: 'false', style: { width: '100%' } });
    nameIn.addEventListener('input', () => {
      if (!nameIn.value.trim()) return;
      env.name = nameIn.value.trim();
      commit();
      const active = listEl.querySelector('.env-item.active .label');
      if (active) active.textContent = env.name;
    });
    const isActive = env.id === S.data.activeEnvironmentId;
    const activate = h('button.btn.small', isActive ? 'Deactivate' : 'Set Active');
    activate.addEventListener('click', () => {
      S.data.activeEnvironmentId = isActive ? null : env.id;
      commit();
      renderEnvSelect();
      render();
    });
    const del = h('button.btn.small.danger', 'Delete');
    del.addEventListener('click', async () => {
      if (!(await confirmModal('Delete environment', `Delete environment "${env.name}"?`))) return;
      S.data.environments = S.data.environments.filter((e) => e.id !== env.id);
      if (S.data.activeEnvironmentId === env.id) S.data.activeEnvironmentId = null;
      selected = S.data.environments[0] && S.data.environments[0].id;
      commit();
      renderEnvSelect();
      render();
    });
    detail.append(
      h('div.field', h('label', 'Name'), h('div.row', nameIn, activate, del)),
      h('div.hint', 'Use variables anywhere as ', h('code', '{{name}}'), '. Built-ins: ', h('code', '{{$timestamp}}'), ' ', h('code', '{{$isoTimestamp}}'), ' ', h('code', '{{$uuid}}'), ' ', h('code', '{{$randomInt}}')),
      kvEditor(env.variables, { keyPh: 'Variable', valPh: 'value', onChange: commit }));
  };
  render();

  openModal({
    title: 'Environments',
    wide: true,
    body: h('div.env-layout', listEl, detail),
    buttons: [{ label: 'Done', primary: true }],
    onClose: () => { renderEnvSelect(); },
  });
}

// =====================================================================
// Modals: settings
// =====================================================================
async function openSettingsModal() {
  const st = S.data.settings;
  const sel = (key, options, onChange) => {
    const el = h('select.input', options.map(([v, l]) => h('option', { value: v }, l)));
    el.value = st[key];
    el.addEventListener('change', () => { st[key] = el.value; commit(); if (onChange) onChange(); });
    return el;
  };
  const check = (key, label) => {
    const cb = h('input', { type: 'checkbox', checked: !!st[key] });
    cb.addEventListener('change', () => { st[key] = cb.checked; commit(); });
    return h('label.check-row', cb, h('span', label));
  };
  const timeout = h('input.input', { type: 'number', min: '0', step: '1000', value: String(st.timeout) });
  timeout.addEventListener('input', () => { st.timeout = Math.max(0, parseInt(timeout.value, 10) || 0); commit(); });

  const dataPath = await api.dataPath();

  openModal({
    title: 'Settings',
    body: h('div',
      h('div.form-grid', { style: { marginBottom: '18px' } },
        h('label', 'Theme'), sel('theme', [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']], applyTheme),
        h('label', 'Layout'), sel('layout', [['horizontal', 'Side by side'], ['vertical', 'Stacked']], renderEditor),
        h('label', 'Timeout (ms)'), timeout),
      check('followRedirects', 'Follow redirects automatically'),
      check('verifySSL', 'Verify SSL certificates (turn off for self-signed certs)'),
      h('div.hint', { style: { marginTop: '18px' } }, 'Timeout 0 means no timeout. All data is stored locally in:'),
      h('div.mono', { style: { userSelect: 'text', fontSize: '12px', wordBreak: 'break-all' } }, dataPath),
      h('div.hint', { style: { marginTop: '14px' } }, 'Requester 1.0.0 · No account or login needed.')),
    buttons: [{ label: 'Done', primary: true }],
  });
}

// =====================================================================
// Import / export
// =====================================================================
function openImportModal() {
  let modalRef = null;
  const card = (title, desc, action) => {
    const el = h('div.import-card', svg(ICONS.file, 22), h('div', h('div.t', title), h('div.d', desc)));
    el.addEventListener('click', () => { modalRef.close(); action(); });
    return el;
  };
  modalRef = openModal({
    title: 'Import',
    body: h('div.import-options',
      card('From file', 'Requester export, Postman Collection (v2 / v2.1), or Postman environment JSON.', importFromFile),
      card('From cURL', 'Paste a cURL command to create a new request.', openCurlImport)),
  });
}

async function importFromFile() {
  const r = await api.importJson();
  if (r.canceled) return;
  try {
    const { collections, environments } = importAny(r.text);
    S.data.collections.push(...collections);
    S.data.environments.push(...environments);
    commit();
    renderAll();
    const parts = [];
    if (collections.length) parts.push(`${collections.length} collection${collections.length > 1 ? 's' : ''}`);
    if (environments.length) parts.push(`${environments.length} environment${environments.length > 1 ? 's' : ''}`);
    toast(`Imported ${parts.join(' and ') || 'nothing'}`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

function openCurlImport() {
  const ta = h('textarea.input.mono', { rows: 9, placeholder: "curl -X POST 'https://api.example.com/items' -H 'Content-Type: application/json' -d '{\"name\":\"x\"}'", style: { width: '100%' }, spellcheck: 'false' });
  openModal({
    title: 'Import cURL',
    wide: true,
    body: h('div', ta),
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Import',
        primary: true,
        action: () => {
          const req = parseCurl(ta.value);
          if (!req) { toast('That does not look like a cURL command', 'err'); return false; }
          createRequestQuick(req);
          toast('Request created from cURL');
          return true;
        },
      },
    ],
  });
}

async function exportAll() {
  const r = await api.exportJson('requester-export.json', exportPayload(S.data.collections, S.data.environments));
  if (!r.canceled) toast(`Exported to ${r.filePath}`);
}

async function exportCollection(col) {
  const safe = col.name.replace(/[^\w.-]+/g, '_');
  const r = await api.exportJson(`${safe}.requester.json`, exportPayload([col], []));
  if (!r.canceled) toast(`Exported to ${r.filePath}`);
}

init();
