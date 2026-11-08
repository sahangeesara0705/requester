// Small DOM + UI helpers shared by the renderer.

/** h('div.cls#id', {attrs, on:{click}}, ...children) */
export function h(tag, props, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
      else if (k === 'value' || k === 'checked' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function svg(pathD, size = 16, viewBox = '0 0 24 24') {
  const wrap = document.createElement('span');
  wrap.style.display = 'inline-flex';
  wrap.innerHTML = `<svg viewBox="${viewBox}" width="${size}" height="${size}"><path fill="currentColor" d="${pathD}"/></svg>`;
  return wrap.firstChild;
}

export const ICONS = {
  chevron: 'M9 6l6 6-6 6-1.4-1.4L12.2 12 7.6 7.4z',
  folder: 'M10 4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6z',
  folderOpen: 'M20 18H4V8h16v10zm0-12h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2z',
  box: 'M12 2 3 6.5v11L12 22l9-4.5v-11L12 2zm0 2.2 6.6 3.3L12 10.8 5.4 7.5 12 4.2zM5 9.2l6 3v7.4l-6-3V9.2zm8 10.4v-7.4l6-3v7.4l-6 3z',
  more: 'M6 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
  close: 'M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z',
  trash: 'M9 3h6l1 1h4v2H4V4h4l1-1zm-3 5h12l-1 13H7L6 8z',
  send: 'M3 20.5v-7l9-1.5-9-1.5v-7L22 12 3 20.5z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm0 2.5L17.5 8H14V4.5z',
  plug: 'M16 7V3h-2v4h-4V3H8v4H6v6l4 4v4h4v-4l4-4V7h-2z',
};

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return wrapped;
}

export function clone(v) {
  return structuredClone(v);
}

export function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 2 : 1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatTime(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Syntax-highlights an already pretty-printed JSON string. Returns HTML. */
export function highlightJson(text) {
  const re = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],]/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    out += escapeHtml(text.slice(last, m.index));
    const tok = m[0];
    let cls;
    if (m[1]) cls = m[2] ? 't-key' : 't-str';
    else if (m[3]) cls = 't-bool';
    else if (tok === 'null') cls = 't-null';
    else if (/^[{}[\],]$/.test(tok)) cls = 't-punc';
    else cls = 't-num';
    if (m[1] && m[2]) out += `<span class="t-key">${escapeHtml(m[1])}</span><span class="t-punc">${escapeHtml(m[2])}</span>`;
    else out += `<span class="${cls}">${escapeHtml(tok)}</span>`;
    last = re.lastIndex;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

/** Make a <textarea> friendlier for code: Tab indents, auto-closing brackets kept simple. */
export function codeTextarea(textarea) {
  textarea.spellcheck = false;
  textarea.setAttribute('autocomplete', 'off');
  textarea.setAttribute('autocorrect', 'off');
  textarea.setAttribute('autocapitalize', 'off');
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = textarea;
      if (e.shiftKey) {
        const lineStart = value.lastIndexOf('\n', s - 1) + 1;
        if (value.slice(lineStart, lineStart + 2) === '  ') {
          textarea.setRangeText('', lineStart, lineStart + 2, 'preserve');
          textarea.selectionStart = textarea.selectionEnd = Math.max(lineStart, s - 2);
        }
      } else {
        textarea.setRangeText('  ', s, en, 'end');
      }
      textarea.dispatchEvent(new Event('input'));
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      // Keep indentation of the current line.
      const { selectionStart: s, selectionEnd: en, value } = textarea;
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      const indent = /^[ \t]*/.exec(value.slice(lineStart, s))[0];
      const prev = value[s - 1];
      const next = value[s];
      e.preventDefault();
      if ((prev === '{' && next === '}') || (prev === '[' && next === ']')) {
        textarea.setRangeText(`\n${indent}  \n${indent}`, s, en, 'start');
        textarea.selectionStart = textarea.selectionEnd = s + indent.length + 3;
      } else {
        const extra = prev === '{' || prev === '[' || prev === '(' ? '  ' : '';
        textarea.setRangeText(`\n${indent}${extra}`, s, en, 'end');
      }
      textarea.dispatchEvent(new Event('input'));
    }
  });
  return textarea;
}

// ---------- toast ----------
export function toast(message, kind = '') {
  const el = h('div.toast', { class: kind }, message);
  document.getElementById('toast-root').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 4500 : 2200);
}

// ---------- context menu ----------
let menuCleanup = null;

export function closeMenu() {
  if (menuCleanup) menuCleanup();
}

/** items: [{label, action, danger, kbd} | '-'] */
export function openMenu(items, x, y, onClose) {
  closeMenu();
  const root = document.getElementById('menu-root');
  const menu = h('div.ctx-menu');
  for (const it of items) {
    if (it === '-') {
      menu.appendChild(h('div.ctx-sep'));
      continue;
    }
    menu.appendChild(h('div.ctx-item', {
      class: it.danger ? 'danger' : '',
      on: {
        click: (e) => {
          e.stopPropagation();
          closeMenu();
          it.action();
        },
      },
    }, it.label, it.kbd ? h('span.kbd', it.kbd) : null));
  }
  root.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 6)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 6)}px`;

  const onDown = (e) => {
    if (!menu.contains(e.target)) closeMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') closeMenu();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', closeMenu);
  });
  menuCleanup = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', closeMenu);
    menuCleanup = null;
    if (onClose) onClose();
  };
}

// ---------- modal ----------
/**
 * openModal({title, body, buttons:[{label, primary, danger, action(close) -> false to keep open}], wide, onClose})
 */
export function openModal({ title, body, buttons = [], wide = false, onClose, footLeft, enterSubmits = false }) {
  const root = document.getElementById('modal-root');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose();
  };
  const runButton = async (b) => {
    if (b.action) {
      const r = await b.action(close);
      if (r === false) return;
    }
    close();
  };
  const onKey = (e) => {
    if (root.lastElementChild !== backdrop) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (enterSubmits && e.key === 'Enter' && e.target.tagName === 'INPUT') {
      const primary = buttons.find((b) => b.primary);
      if (primary) {
        e.preventDefault();
        e.stopPropagation();
        runButton(primary);
      }
    }
  };
  const modal = h('div.modal', { class: wide ? 'wide' : '' },
    h('div.modal-head', h('h3', title),
      h('button.btn.ghost.icon', { title: 'Close', on: { click: close } }, svg(ICONS.close, 14))),
    h('div.modal-body', body),
    buttons.length || footLeft
      ? h('div.modal-foot',
        footLeft ? h('div.left', footLeft) : null,
        buttons.map((b) => h('button.btn', {
          class: [b.primary ? 'primary' : '', b.danger ? 'danger solid' : ''].join(' '),
          on: { click: () => runButton(b) },
        }, b.label)))
      : null);
  const backdrop = h('div.modal-backdrop', {
    on: { mousedown: (e) => { if (e.target === backdrop) close(); } },
  }, modal);
  root.appendChild(backdrop);
  document.addEventListener('keydown', onKey, true);
  const firstInput = modal.querySelector('input:not([type=checkbox]), textarea');
  if (firstInput) setTimeout(() => { firstInput.focus(); if (firstInput.select) firstInput.select(); });
  return { close, modal };
}

export function promptModal(title, { label = 'Name', value = '', okLabel = 'Save' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input.input', { value, spellcheck: 'false', style: { width: '100%' } });
    openModal({
      title,
      body: h('div.field', h('label', label), input),
      buttons: [
        { label: 'Cancel' },
        {
          label: okLabel,
          primary: true,
          action: () => {
            const v = input.value.trim();
            if (!v) {
              input.focus();
              return false;
            }
            result = v;
            return true;
          },
        },
      ],
      onClose: () => resolve(result),
      enterSubmits: true,
    });
  });
}

export function confirmModal(title, message, { okLabel = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    openModal({
      title,
      body: h('div', message),
      buttons: [
        { label: 'Cancel' },
        { label: okLabel, danger, primary: !danger, action: () => { ok = true; } },
      ],
      onClose: () => resolve(ok),
    });
  });
}

/** Simple drag-to-resize helper. onMove gets (dx, dy) relative to drag start. */
export function makeResizer(handle, { axis = 'x', onStart, onMove, onEnd }) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const ctx = onStart ? onStart() : null;
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    if (axis === 'y') document.body.classList.add('rows');
    const move = (ev) => onMove(ev.clientX - sx, ev.clientY - sy, ctx);
    const up = () => {
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing', 'rows');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      if (onEnd) onEnd();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}
