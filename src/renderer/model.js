// Data model, tree operations, request resolution, and import/export.
import { uid, clone } from './util.js';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export const BODY_MODES = [
  { id: 'none', label: 'None' },
  { id: 'json', label: 'JSON' },
  { id: 'graphql', label: 'GraphQL' },
  { id: 'form-urlencoded', label: 'Form URL Encoded' },
  { id: 'multipart', label: 'Multipart Form' },
  { id: 'text', label: 'Text' },
  { id: 'xml', label: 'XML' },
  { id: 'binary', label: 'Binary File' },
];

export const AUTH_TYPES = [
  { id: 'inherit', label: 'Inherit from parent' },
  { id: 'none', label: 'No Auth' },
  { id: 'bearer', label: 'Bearer Token' },
  { id: 'basic', label: 'Basic Auth' },
  { id: 'apikey', label: 'API Key' },
];

export const COMMON_HEADERS = [
  'Accept', 'Accept-Encoding', 'Accept-Language', 'Authorization', 'Cache-Control', 'Connection',
  'Content-Type', 'Cookie', 'If-Match', 'If-None-Match', 'If-Modified-Since', 'Origin', 'Pragma',
  'Referer', 'User-Agent', 'X-API-Key', 'X-Requested-With', 'X-Request-ID', 'X-Correlation-ID',
];

export function kv(key = '', value = '', enabled = true) {
  return { id: uid(), key, value, enabled };
}

export function defaultAuth(type = 'inherit') {
  return {
    type,
    bearer: { token: '', prefix: 'Bearer' },
    basic: { username: '', password: '' },
    apikey: { key: 'X-API-Key', value: '', in: 'header' },
  };
}

export function newRequest(name = 'New Request', overrides = {}) {
  return {
    type: 'request',
    id: uid(),
    name,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    body: {
      mode: 'none',
      raw: '',
      form: [],
      multipart: [],
      graphql: { query: '', variables: '', operationName: '' },
      file: '',
    },
    auth: defaultAuth('inherit'),
    ...overrides,
  };
}

export function newFolder(name = 'New Folder') {
  return { type: 'folder', id: uid(), name, expanded: true, items: [], auth: defaultAuth('inherit'), headers: [] };
}

export function newCollection(name = 'New Collection') {
  return {
    type: 'collection', id: uid(), name, expanded: true, items: [],
    auth: defaultAuth('none'), headers: [], variables: [],
  };
}

export function defaultData() {
  const examples = newCollection('Examples');
  examples.variables = [kv('baseUrl', 'https://jsonplaceholder.typicode.com')];

  const rest = newFolder('REST');
  rest.items.push(
    newRequest('List posts', { url: '{{baseUrl}}/posts?_limit=5', params: [kv('_limit', '5')] }),
    newRequest('Get post', { url: '{{baseUrl}}/posts/1' }),
  );
  const create = newRequest('Create post', { method: 'POST', url: '{{baseUrl}}/posts' });
  create.body.mode = 'json';
  create.body.raw = JSON.stringify({ title: 'Hello', body: 'Sent from Requester', userId: 1 }, null, 2);
  rest.items.push(create);
  const del = newRequest('Delete post', { method: 'DELETE', url: '{{baseUrl}}/posts/1' });
  rest.items.push(del);

  const gql = newFolder('GraphQL');
  const countries = newRequest('Countries (GraphQL)', { method: 'POST', url: 'https://countries.trevorblades.com/graphql' });
  countries.body.mode = 'graphql';
  countries.body.graphql.query = 'query Country($code: ID!) {\n  country(code: $code) {\n    name\n    capital\n    currency\n    emoji\n    languages {\n      name\n    }\n  }\n}';
  countries.body.graphql.variables = '{\n  "code": "LK"\n}';
  gql.items.push(countries);

  examples.items.push(rest, gql);

  return {
    version: 1,
    collections: [examples],
    environments: [
      { id: uid(), name: 'Development', variables: [kv('token', 'dev-token-123')] },
      { id: uid(), name: 'Production', variables: [kv('token', '')] },
    ],
    activeEnvironmentId: null,
    openTabs: [],
    activeTabId: null,
    settings: {
      timeout: 30000,
      followRedirects: true,
      verifySSL: true,
      theme: 'dark',
      layout: 'horizontal',
      wrapResponse: false,
    },
    ui: { sidebarWidth: 280, splitRatio: 0.5 },
  };
}

/** Fill in fields missing from older/partial saved data. */
export function normalizeData(data) {
  const d = defaultData();
  if (!data || typeof data !== 'object') return d;
  const out = {
    ...d,
    ...data,
    settings: { ...d.settings, ...(data.settings || {}) },
    ui: { ...d.ui, ...(data.ui || {}) },
  };
  out.collections = Array.isArray(data.collections) ? data.collections : [];
  out.environments = Array.isArray(data.environments) ? data.environments : [];
  out.openTabs = Array.isArray(data.openTabs) ? data.openTabs : [];
  for (const c of out.collections) normalizeContainer(c, 'collection');
  for (const e of out.environments) {
    e.id = e.id || uid();
    e.variables = normalizeKv(e.variables);
  }
  return out;
}

function normalizeKv(list) {
  return (Array.isArray(list) ? list : []).map((r) => ({
    id: r.id || uid(), key: r.key ?? '', value: r.value ?? '', enabled: r.enabled !== false,
    ...(r.type ? { type: r.type } : {}), ...(r.path ? { path: r.path } : {}),
  }));
}

function normalizeAuth(auth, fallback) {
  const base = defaultAuth(fallback);
  if (!auth) return base;
  return {
    type: auth.type || fallback,
    bearer: { ...base.bearer, ...(auth.bearer || {}) },
    basic: { ...base.basic, ...(auth.basic || {}) },
    apikey: { ...base.apikey, ...(auth.apikey || {}) },
  };
}

function normalizeContainer(node, type) {
  node.type = type;
  node.id = node.id || uid();
  node.name = node.name || (type === 'collection' ? 'Collection' : 'Folder');
  node.items = Array.isArray(node.items) ? node.items : [];
  node.expanded = node.expanded !== false;
  node.auth = normalizeAuth(node.auth, type === 'collection' ? 'none' : 'inherit');
  node.headers = normalizeKv(node.headers);
  if (type === 'collection') node.variables = normalizeKv(node.variables);
  for (const item of node.items) {
    if (item.type === 'folder') normalizeContainer(item, 'folder');
    else normalizeRequest(item);
  }
}

function normalizeRequest(r) {
  const base = newRequest(r.name || 'Request');
  r.type = 'request';
  r.id = r.id || uid();
  r.name = r.name || 'Request';
  r.method = (r.method || 'GET').toUpperCase();
  r.url = r.url || '';
  r.params = normalizeKv(r.params);
  r.headers = normalizeKv(r.headers);
  r.body = { ...base.body, ...(r.body || {}) };
  r.body.form = normalizeKv(r.body.form);
  r.body.multipart = normalizeKv(r.body.multipart);
  r.body.graphql = { ...base.body.graphql, ...(r.body.graphql || {}) };
  r.auth = normalizeAuth(r.auth, 'inherit');
}

// ---------- tree ----------

/** Walks the tree. Returns {node, parent, collection, ancestors[]} or null. */
export function findNode(data, id) {
  for (const col of data.collections) {
    if (col.id === id) return { node: col, parent: null, collection: col, ancestors: [] };
    const r = findIn(col, id, [col]);
    if (r) return { ...r, collection: col };
  }
  return null;
}

function findIn(container, id, ancestors) {
  for (const item of container.items) {
    if (item.id === id) return { node: item, parent: container, ancestors };
    if (item.items) {
      const r = findIn(item, id, [...ancestors, item]);
      if (r) return r;
    }
  }
  return null;
}

export function walkRequests(node, fn) {
  if (node.type === 'request') fn(node);
  else for (const item of node.items || []) walkRequests(item, fn);
}

export function removeNode(data, id) {
  const found = findNode(data, id);
  if (!found) return null;
  if (!found.parent) data.collections = data.collections.filter((c) => c.id !== id);
  else found.parent.items = found.parent.items.filter((i) => i.id !== id);
  return found.node;
}

/** Deep copy a node assigning fresh ids. */
export function cloneWithNewIds(node) {
  const copy = clone(node);
  const reid = (n) => {
    n.id = uid();
    for (const key of ['params', 'headers', 'variables']) if (Array.isArray(n[key])) n[key].forEach((r) => { r.id = uid(); });
    if (n.body) {
      (n.body.form || []).forEach((r) => { r.id = uid(); });
      (n.body.multipart || []).forEach((r) => { r.id = uid(); });
    }
    (n.items || []).forEach(reid);
  };
  reid(copy);
  return copy;
}

export function isDescendant(node, maybeChildId) {
  if (!node.items) return false;
  return node.items.some((i) => i.id === maybeChildId || isDescendant(i, maybeChildId));
}

/** Move node `dragId` relative to `targetId`. position: 'before' | 'after' | 'inside'. */
export function moveNode(data, dragId, targetId, position) {
  if (dragId === targetId) return false;
  const drag = findNode(data, dragId);
  const target = findNode(data, targetId);
  if (!drag || !target) return false;

  if (drag.node.type === 'collection') {
    if (target.node.type !== 'collection' || position === 'inside') return false;
    data.collections = data.collections.filter((c) => c.id !== dragId);
    const idx = data.collections.findIndex((c) => c.id === targetId);
    data.collections.splice(position === 'after' ? idx + 1 : idx, 0, drag.node);
    return true;
  }

  if (isDescendant(drag.node, targetId)) return false;
  if (position !== 'inside' && target.node.type === 'collection') position = 'inside';

  drag.parent.items = drag.parent.items.filter((i) => i.id !== dragId);
  if (position === 'inside') {
    target.node.items.push(drag.node);
    target.node.expanded = true;
  } else {
    const parent = findNode(data, targetId).parent;
    const idx = parent.items.findIndex((i) => i.id === targetId);
    parent.items.splice(position === 'after' ? idx + 1 : idx, 0, drag.node);
  }
  return true;
}

// ---------- URL <-> params ----------

export function splitUrl(url) {
  const hashIdx = url.indexOf('#');
  const noHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const q = noHash.indexOf('?');
  if (q < 0) return { base: noHash, query: null, hash: hashIdx >= 0 ? url.slice(hashIdx) : '' };
  return { base: noHash.slice(0, q), query: noHash.slice(q + 1), hash: hashIdx >= 0 ? url.slice(hashIdx) : '' };
}

export function parseQuery(query) {
  if (!query) return [];
  return query.split('&').filter((p) => p !== '').map((pair) => {
    const eq = pair.indexOf('=');
    return eq < 0 ? [pair, ''] : [pair.slice(0, eq), pair.slice(eq + 1)];
  });
}

/** Called when URL text changes: re-derive enabled params, keep disabled ones. */
export function syncParamsFromUrl(req) {
  const { query } = splitUrl(req.url);
  const pairs = parseQuery(query);
  const disabled = req.params.filter((p) => !p.enabled);
  const enabledOld = req.params.filter((p) => p.enabled);
  const next = pairs.map(([k, v], i) => {
    const old = enabledOld[i];
    return old ? { ...old, key: k, value: v } : kv(k, v);
  });
  req.params = [...next, ...disabled];
}

/** Called when params table changes: rebuild the URL query string. */
export function syncUrlFromParams(req) {
  const { base, hash } = splitUrl(req.url);
  const enabled = req.params.filter((p) => p.enabled && (p.key || p.value));
  const qs = enabled.map((p) => (p.value === '' ? p.key : `${p.key}=${p.value}`)).join('&');
  req.url = base + (qs ? `?${qs}` : '') + hash;
}

// ---------- variables ----------

function guid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const DYNAMIC = {
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $guid: guid,
  $uuid: guid,
  $randomInt: () => String(Math.floor(Math.random() * 1001)),
};

export function buildVariables(data, collection) {
  const vars = {};
  if (collection) for (const v of collection.variables || []) if (v.enabled && v.key) vars[v.key] = v.value;
  const env = data.environments.find((e) => e.id === data.activeEnvironmentId);
  if (env) for (const v of env.variables) if (v.enabled && v.key) vars[v.key] = v.value;
  return vars;
}

export function substitute(str, vars, missing) {
  if (str == null) return '';
  // Resolve up to 5 levels deep so variables can reference other variables.
  let out = String(str);
  for (let i = 0; i < 5 && out.includes('{{'); i++) {
    const before = out;
    out = out.replace(/\{\{\s*([\w$.-]+)\s*\}\}/g, (m, name) => {
      if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
      if (DYNAMIC[name]) return DYNAMIC[name]();
      if (missing) missing.add(name);
      return m;
    });
    if (out === before) break;
  }
  return out;
}

function utf8Base64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Returns the effective auth for a request after following 'inherit' up the tree. */
export function effectiveAuth(req, ancestors) {
  if (req.auth.type !== 'inherit') return { auth: req.auth, from: null };
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i].auth;
    if (a && a.type !== 'inherit') return { auth: a, from: ancestors[i] };
  }
  return { auth: defaultAuth('none'), from: null };
}

/**
 * Turn a stored request into a concrete spec for the main process.
 * Returns { spec, missing: [varNames] }.
 */
export function resolveRequest(data, reqId, settings) {
  const found = findNode(data, reqId);
  const req = found.node;
  const ancestors = found.ancestors;
  const vars = buildVariables(data, found.collection);
  const missing = new Set();
  const sub = (s) => substitute(s, vars, missing);

  // Headers: collection -> folders -> request; later definitions override earlier ones by name.
  const headerMap = new Map();
  const addHeaders = (list) => {
    for (const hdr of list || []) {
      if (!hdr.enabled || !hdr.key.trim()) continue;
      const k = sub(hdr.key).trim();
      headerMap.set(k.toLowerCase(), [k, sub(hdr.value)]);
    }
  };
  for (const a of ancestors) addHeaders(a.headers);
  addHeaders(req.headers);
  const setHeaderIfMissing = (k, v) => {
    if (!headerMap.has(k.toLowerCase())) headerMap.set(k.toLowerCase(), [k, v]);
  };

  // URL
  let url = sub(req.url).trim();
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;

  // Auth
  const { auth } = effectiveAuth(req, ancestors);
  const extraQuery = [];
  if (auth.type === 'bearer' && auth.bearer.token) {
    const prefix = sub(auth.bearer.prefix ?? 'Bearer').trim();
    setHeaderIfMissing('Authorization', prefix ? `${prefix} ${sub(auth.bearer.token)}` : sub(auth.bearer.token));
  } else if (auth.type === 'basic' && (auth.basic.username || auth.basic.password)) {
    setHeaderIfMissing('Authorization', `Basic ${utf8Base64(`${sub(auth.basic.username)}:${sub(auth.basic.password)}`)}`);
  } else if (auth.type === 'apikey' && auth.apikey.key) {
    if (auth.apikey.in === 'query') extraQuery.push([sub(auth.apikey.key), sub(auth.apikey.value)]);
    else setHeaderIfMissing(sub(auth.apikey.key), sub(auth.apikey.value));
  }

  if (extraQuery.length) {
    const qs = extraQuery.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const { base, query, hash } = splitUrl(url);
    url = `${base}?${query ? `${query}&` : ''}${qs}${hash}`;
  }

  try {
    url = new URL(url).toString();
  } catch (_) { /* let the main process report the invalid URL */ }

  // Body
  let body = { type: 'none' };
  const b = req.body;
  const method = req.method.toUpperCase();
  switch (b.mode) {
    case 'json':
      body = { type: 'text', text: sub(b.raw), contentType: 'application/json' };
      break;
    case 'text':
      body = { type: 'text', text: sub(b.raw), contentType: 'text/plain' };
      break;
    case 'xml':
      body = { type: 'text', text: sub(b.raw), contentType: 'application/xml' };
      break;
    case 'form-urlencoded': {
      const sp = new URLSearchParams();
      for (const f of b.form) if (f.enabled && f.key) sp.append(sub(f.key), sub(f.value));
      body = { type: 'text', text: sp.toString(), contentType: 'application/x-www-form-urlencoded' };
      break;
    }
    case 'multipart':
      body = {
        type: 'multipart',
        parts: b.multipart.filter((p) => p.enabled && p.key).map((p) => (p.type === 'file'
          ? { key: sub(p.key), type: 'file', path: p.path || '' }
          : { key: sub(p.key), type: 'text', value: sub(p.value) })),
      };
      break;
    case 'graphql': {
      const payload = { query: sub(b.graphql.query) };
      const varsText = sub(b.graphql.variables).trim();
      if (varsText) {
        try {
          payload.variables = JSON.parse(varsText);
        } catch (e) {
          throw new Error(`GraphQL variables are not valid JSON: ${e.message}`);
        }
      }
      if (b.graphql.operationName) payload.operationName = sub(b.graphql.operationName);
      if (method === 'GET') {
        const sep = url.includes('?') ? '&' : '?';
        url += `${sep}query=${encodeURIComponent(payload.query)}`;
        if (payload.variables) url += `&variables=${encodeURIComponent(JSON.stringify(payload.variables))}`;
        if (payload.operationName) url += `&operationName=${encodeURIComponent(payload.operationName)}`;
      } else {
        body = { type: 'text', text: JSON.stringify(payload), contentType: 'application/json' };
      }
      break;
    }
    case 'binary':
      body = { type: 'file', path: b.file || '' };
      break;
    default:
      body = { type: 'none' };
  }

  return {
    spec: {
      id: uid(),
      method,
      url,
      headers: [...headerMap.values()],
      body,
      timeout: Number(settings.timeout) || 0,
      followRedirects: settings.followRedirects !== false,
      verifySSL: settings.verifySSL !== false,
    },
    missing: [...missing],
  };
}

// ---------- cURL ----------

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function toCurl(spec) {
  let first = 'curl';
  if (spec.method !== 'GET') first += ` -X ${spec.method}`;
  if (spec.followRedirects) first += ' -L';
  if (!spec.verifySSL) first += ' -k';
  first += ` ${shq(spec.url)}`;
  const lines = [first];
  let headers = spec.headers;
  if (spec.body.type === 'multipart') headers = headers.filter(([k]) => k.toLowerCase() !== 'content-type');
  for (const [k, v] of headers) lines.push(`-H ${shq(`${k}: ${v}`)}`);
  const b = spec.body;
  if (b.type === 'text') {
    if (b.contentType && !headers.some(([k]) => k.toLowerCase() === 'content-type')) lines.push(`-H ${shq(`Content-Type: ${b.contentType}`)}`);
    lines.push(`--data-raw ${shq(b.text)}`);
  } else if (b.type === 'multipart') {
    for (const p of b.parts) lines.push(`-F ${shq(p.type === 'file' ? `${p.key}=@${p.path}` : `${p.key}=${p.value}`)}`);
  } else if (b.type === 'file' && b.path) {
    lines.push(`--data-binary ${shq(`@${b.path}`)}`);
  }
  return lines.join(' \\\n  ');
}

function tokenizeShell(input) {
  const tokens = [];
  let cur = '';
  let inToken = false;
  let i = 0;
  const s = input.replace(/\\\r?\n/g, ' ');
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      cur += s.slice(i + 1, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end + 1;
      inToken = true;
    } else if (c === '$' && s[i + 1] === "'") {
      // ANSI-C quoting: $'...'
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[i + 1];
          cur += ({ n: '\n', t: '\t', r: '\r', "'": "'", '\\': '\\', '"': '"' })[n] ?? n;
          i += 2;
        } else cur += s[i++];
      }
      i++;
      inToken = true;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
          cur += s[i + 1];
          i += 2;
        } else cur += s[i++];
      }
      i++;
      inToken = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[i + 1];
      i += 2;
      inToken = true;
    } else if (/\s/.test(c)) {
      if (inToken) tokens.push(cur);
      cur = '';
      inToken = false;
      i++;
    } else {
      cur += c;
      inToken = true;
      i++;
    }
  }
  if (inToken) tokens.push(cur);
  return tokens;
}

/** Parse a cURL command into a new request object, or return null. */
export function parseCurl(text) {
  const tokens = tokenizeShell(text.trim());
  if (!tokens.length || tokens[0] !== 'curl') return null;
  const req = newRequest('Imported cURL');
  let method = null;
  let url = '';
  const data = [];
  const form = [];
  let getMode = false;

  const takesValue = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary',
    '--data-ascii', '--data-urlencode', '-F', '--form', '--form-string', '-u', '--user', '--url', '-A', '--user-agent',
    '-b', '--cookie', '-e', '--referer', '-o', '--output', '-m', '--max-time', '--connect-timeout', '-x', '--proxy',
    '-w', '--write-out', '--cacert', '--cert', '--key', '-T', '--upload-file', '--retry']);

  for (let i = 1; i < tokens.length; i++) {
    let t = tokens[i];
    let val;
    // Support --opt=value
    const eq = t.startsWith('--') ? t.indexOf('=') : -1;
    if (eq > 0 && takesValue.has(t.slice(0, eq))) {
      val = t.slice(eq + 1);
      t = t.slice(0, eq);
    } else if (/^-[XHdFuAbe]./.test(t) && !t.startsWith('--')) {
      // Short flag with attached value, e.g. -XPOST
      val = t.slice(2);
      t = t.slice(0, 2);
    } else if (takesValue.has(t)) {
      val = tokens[++i] ?? '';
    }

    switch (t) {
      case '-X': case '--request': method = val.toUpperCase(); break;
      case '-H': case '--header': {
        const c = val.indexOf(':');
        if (c > 0) req.headers.push(kv(val.slice(0, c).trim(), val.slice(c + 1).trim()));
        break;
      }
      case '-d': case '--data': case '--data-raw': case '--data-binary': case '--data-ascii':
        data.push(val);
        break;
      case '--data-urlencode': {
        const e2 = val.indexOf('=');
        data.push(e2 >= 0 ? `${val.slice(0, e2)}=${encodeURIComponent(val.slice(e2 + 1))}` : encodeURIComponent(val));
        break;
      }
      case '-F': case '--form': case '--form-string': {
        const e2 = val.indexOf('=');
        if (e2 > 0) {
          const k = val.slice(0, e2);
          const v = val.slice(e2 + 1);
          if (v.startsWith('@') && t !== '--form-string') form.push({ ...kv(k, ''), type: 'file', path: v.slice(1).split(';')[0] });
          else form.push({ ...kv(k, v), type: 'text' });
        }
        break;
      }
      case '-u': case '--user': {
        const c = val.indexOf(':');
        req.auth.type = 'basic';
        req.auth.basic = { username: c >= 0 ? val.slice(0, c) : val, password: c >= 0 ? val.slice(c + 1) : '' };
        break;
      }
      case '-A': case '--user-agent': req.headers.push(kv('User-Agent', val)); break;
      case '-b': case '--cookie': req.headers.push(kv('Cookie', val)); break;
      case '-e': case '--referer': req.headers.push(kv('Referer', val)); break;
      case '--url': url = val; break;
      case '-G': case '--get': getMode = true; break;
      default:
        if (val === undefined && !t.startsWith('-') && !url) url = t;
    }
  }

  const ctHeader = req.headers.find((x) => x.key.toLowerCase() === 'content-type');
  const ct = ctHeader ? ctHeader.value.toLowerCase() : '';

  if (getMode && data.length) {
    url += (url.includes('?') ? '&' : '?') + data.join('&');
  } else if (form.length) {
    req.body.mode = 'multipart';
    req.body.multipart = form;
  } else if (data.length) {
    const joined = data.join('&');
    const trimmed = joined.trim();
    if (ct.includes('json') || (!ct && /^[[{]/.test(trimmed))) {
      req.body.mode = 'json';
      try { req.body.raw = JSON.stringify(JSON.parse(trimmed), null, 2); } catch (_) { req.body.raw = joined; }
      // GraphQL payloads become GraphQL bodies.
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj.query === 'string' && Object.keys(obj).every((k) => ['query', 'variables', 'operationName'].includes(k))) {
          req.body.mode = 'graphql';
          req.body.graphql = {
            query: obj.query,
            variables: obj.variables ? JSON.stringify(obj.variables, null, 2) : '',
            operationName: obj.operationName || '',
          };
        }
      } catch (_) { /* not JSON */ }
    } else if (ct.includes('x-www-form-urlencoded') || (!ct && /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(trimmed))) {
      req.body.mode = 'form-urlencoded';
      req.body.form = parseQuery(joined).map(([k, v]) => {
        const dec = (x) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch (_) { return x; } };
        return kv(dec(k), dec(v));
      });
    } else if (ct.includes('xml')) {
      req.body.mode = 'xml';
      req.body.raw = joined;
    } else {
      req.body.mode = 'text';
      req.body.raw = joined;
    }
    // Content-Type is set automatically for these modes.
    if (ctHeader && ['json', 'graphql', 'form-urlencoded', 'xml'].includes(req.body.mode)) {
      req.headers = req.headers.filter((x) => x !== ctHeader);
    }
  }

  req.method = method || (req.body.mode !== 'none' ? 'POST' : 'GET');
  req.url = url;
  syncParamsFromUrl(req);
  try {
    const u = new URL(url);
    req.name = `${req.method} ${u.pathname === '/' ? u.host : u.pathname}`;
  } catch (_) { /* keep default name */ }
  return req;
}

// ---------- import / export ----------

export function exportPayload(collections, environments) {
  return {
    format: 'requester',
    version: 1,
    exportedAt: new Date().toISOString(),
    collections: clone(collections),
    environments: clone(environments || []),
  };
}

/** Detects format and returns {collections, environments}. Throws on unknown format. */
export function importAny(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (_) {
    throw new Error('File is not valid JSON.');
  }
  if (obj && obj.format === 'requester') {
    const collections = (obj.collections || []).map((c) => {
      const n = cloneWithNewIds(c);
      normalizeContainer(n, 'collection');
      return n;
    });
    const environments = (obj.environments || []).map((e) => ({
      id: uid(), name: e.name || 'Environment', variables: normalizeKv(e.variables),
    }));
    return { collections, environments };
  }
  if (obj && obj.info && Array.isArray(obj.item)) {
    return { collections: [fromPostman(obj)], environments: [] };
  }
  if (obj && Array.isArray(obj.values) && obj.name && (obj._postman_variable_scope || obj.values.every((v) => 'key' in v))) {
    return {
      collections: [],
      environments: [{ id: uid(), name: obj.name, variables: obj.values.map((v) => kv(v.key, v.value ?? '', v.enabled !== false)) }],
    };
  }
  throw new Error('Unrecognized format. Supported: Requester export, Postman Collection v2/v2.1, Postman environment.');
}

function pmList(list) {
  return (list || []).map((x) => kv(x.key ?? '', x.value ?? '', !x.disabled));
}

function pmAuth(a, fallback) {
  const auth = defaultAuth(fallback);
  if (!a || !a.type) return auth;
  const get = (arr, key) => {
    if (!arr) return '';
    if (!Array.isArray(arr)) return arr[key] ?? '';
    const f = arr.find((x) => x.key === key);
    return f ? String(f.value ?? '') : '';
  };
  if (a.type === 'noauth') auth.type = 'none';
  else if (a.type === 'bearer') {
    auth.type = 'bearer';
    auth.bearer.token = get(a.bearer, 'token');
  } else if (a.type === 'basic') {
    auth.type = 'basic';
    auth.basic = { username: get(a.basic, 'username'), password: get(a.basic, 'password') };
  } else if (a.type === 'apikey') {
    auth.type = 'apikey';
    auth.apikey = { key: get(a.apikey, 'key') || 'X-API-Key', value: get(a.apikey, 'value'), in: get(a.apikey, 'in') === 'query' ? 'query' : 'header' };
  }
  return auth;
}

function fromPostman(pm) {
  const col = newCollection(pm.info.name || 'Imported Collection');
  col.variables = pmList(pm.variable);
  col.auth = pmAuth(pm.auth, 'none');
  const convertItems = (items) => items.map((it) => {
    if (Array.isArray(it.item)) {
      const f = newFolder(it.name || 'Folder');
      f.auth = pmAuth(it.auth, 'inherit');
      f.items = convertItems(it.item);
      f.expanded = false;
      return f;
    }
    const r = it.request || {};
    const req = newRequest(it.name || 'Request');
    req.method = (r.method || 'GET').toUpperCase();
    req.url = typeof r.url === 'string' ? r.url : (r.url && r.url.raw) || '';
    syncParamsFromUrl(req);
    if (r.url && Array.isArray(r.url.query)) {
      for (const q of r.url.query) if (q.disabled) req.params.push(kv(q.key ?? '', q.value ?? '', false));
    }
    req.headers = pmList(r.header);
    req.auth = pmAuth(r.auth, 'inherit');
    const body = r.body;
    if (body && body.mode === 'raw') {
      const lang = body.options && body.options.raw && body.options.raw.language;
      req.body.mode = lang === 'json' ? 'json' : lang === 'xml' ? 'xml' : (/^\s*[[{]/.test(body.raw || '') ? 'json' : 'text');
      req.body.raw = body.raw || '';
    } else if (body && body.mode === 'urlencoded') {
      req.body.mode = 'form-urlencoded';
      req.body.form = pmList(body.urlencoded);
    } else if (body && body.mode === 'formdata') {
      req.body.mode = 'multipart';
      req.body.multipart = (body.formdata || []).map((x) => ({
        ...kv(x.key ?? '', x.type === 'file' ? '' : (x.value ?? ''), !x.disabled),
        type: x.type === 'file' ? 'file' : 'text',
        path: x.type === 'file' ? (Array.isArray(x.src) ? x.src[0] : x.src) || '' : '',
      }));
    } else if (body && body.mode === 'graphql') {
      req.body.mode = 'graphql';
      req.body.graphql = { query: body.graphql.query || '', variables: body.graphql.variables || '', operationName: '' };
    } else if (body && body.mode === 'file') {
      req.body.mode = 'binary';
      req.body.file = (body.file && body.file.src) || '';
    }
    // Drop explicit Content-Type headers the body mode will set anyway.
    if (['json', 'graphql', 'form-urlencoded'].includes(req.body.mode)) {
      req.headers = req.headers.filter((x) => x.key.toLowerCase() !== 'content-type' || !x.enabled);
    }
    return req;
  });
  col.items = convertItems(pm.item);
  return col;
}
