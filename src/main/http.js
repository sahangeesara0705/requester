'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const inflight = new Map();

const MIME_BY_EXT = {
  '.json': 'application/json', '.txt': 'text/plain', '.html': 'text/html', '.xml': 'application/xml',
  '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
};

function guessMime(file) {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return headers.some(([k]) => k.toLowerCase() === lower);
}

function escapeQuoted(s) {
  return String(s).replace(/"/g, '%22').replace(/\r?\n/g, ' ');
}

/** Build the request body buffer. Returns { buffer, contentType|null }. */
async function buildBody(body) {
  if (!body || body.type === 'none') return { buffer: null, contentType: null };

  if (body.type === 'text') {
    return { buffer: Buffer.from(body.text || '', 'utf8'), contentType: body.contentType || null };
  }

  if (body.type === 'file') {
    if (!body.path) return { buffer: null, contentType: null };
    const buffer = await fs.promises.readFile(body.path);
    return { buffer, contentType: body.contentType || guessMime(body.path) };
  }

  if (body.type === 'multipart') {
    const boundary = '----RequesterBoundary' + crypto.randomBytes(12).toString('hex');
    const chunks = [];
    for (const part of body.parts || []) {
      const name = escapeQuoted(part.key);
      if (part.type === 'file') {
        if (!part.path) continue;
        const data = await fs.promises.readFile(part.path);
        const filename = escapeQuoted(path.basename(part.path));
        chunks.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
          `Content-Type: ${guessMime(part.path)}\r\n\r\n`, 'utf8'));
        chunks.push(data);
        chunks.push(Buffer.from('\r\n', 'utf8'));
      } else {
        chunks.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${part.value || ''}\r\n`, 'utf8'));
      }
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    return { buffer: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  return { buffer: null, contentType: null };
}

function decompress(buffer, encoding) {
  const enc = (encoding || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buffer);
    if (enc === 'deflate') {
      try { return zlib.inflateSync(buffer); } catch (_) { return zlib.inflateRawSync(buffer); }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buffer);
    if (enc === 'zstd' && typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(buffer);
  } catch (_) {
    // Fall through and return the raw bytes if decoding fails.
  }
  return buffer;
}

function isTextual(contentType) {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  return ct.startsWith('text/') || /json|xml|javascript|ecmascript|graphql|x-www-form-urlencoded|yaml|csv|html|svg/.test(ct);
}

function singleRequest({ id, method, url, headers, bodyBuffer, timeout, verifySSL }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`Unsupported protocol: ${parsed.protocol}`));
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;

    // Node wants headers as an object; combine duplicates into arrays.
    const headerObj = {};
    for (const [k, v] of headers) {
      if (headerObj[k] === undefined) headerObj[k] = v;
      else if (Array.isArray(headerObj[k])) headerObj[k].push(v);
      else headerObj[k] = [headerObj[k], v];
    }

    const req = lib.request(parsed, {
      method,
      headers: headerObj,
      rejectUnauthorized: verifySSL !== false,
      insecureHTTPParser: true,
    });

    let timer = null;
    if (timeout > 0) {
      timer = setTimeout(() => req.destroy(new Error(`Request timed out after ${timeout} ms`)), timeout);
    }
    inflight.set(id, req);

    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (timer) clearTimeout(timer);
        const raw = Buffer.concat(chunks);
        resolve({ res, raw });
      });
      res.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });
    req.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    if (bodyBuffer && bodyBuffer.length) req.write(bodyBuffer);
    req.end();
  });
}

/**
 * spec: { id, method, url, headers: [[k, v]], body, timeout, followRedirects, verifySSL }
 */
async function sendHttpRequest(spec) {
  const started = Date.now();
  try {
    let method = (spec.method || 'GET').toUpperCase();
    let url = spec.url;
    let headers = (spec.headers || []).filter(([k]) => k && k.trim()).map(([k, v]) => [k.trim(), String(v ?? '')]);

    const { buffer, contentType } = await buildBody(spec.body);
    let bodyBuffer = buffer;

    if (contentType && !hasHeader(headers, 'content-type')) headers.push(['Content-Type', contentType]);
    if (!hasHeader(headers, 'user-agent')) headers.push(['User-Agent', 'Requester/1.0']);
    if (!hasHeader(headers, 'accept')) headers.push(['Accept', '*/*']);
    if (!hasHeader(headers, 'accept-encoding')) headers.push(['Accept-Encoding', 'gzip, deflate, br']);
    if (bodyBuffer && !hasHeader(headers, 'content-length')) headers.push(['Content-Length', String(bodyBuffer.length)]);

    const redirects = [];
    const maxRedirects = spec.followRedirects === false ? 0 : 10;
    let result;

    for (;;) {
      result = await singleRequest({
        id: spec.id, method, url, headers, bodyBuffer,
        timeout: spec.timeout ?? 0, verifySSL: spec.verifySSL,
      });
      const { res } = result;
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && location && redirects.length < maxRedirects) {
        const next = new URL(location, url).toString();
        redirects.push({ status: res.statusCode, from: url, to: next });
        const prevHost = new URL(url).host;
        url = next;
        // 303 (and 301/302 for non-GET/HEAD, as browsers do) switch to GET without a body.
        if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET';
          bodyBuffer = null;
          headers = headers.filter(([k]) => !/^(content-type|content-length)$/i.test(k));
        }
        // Do not leak credentials to a different host.
        if (new URL(next).host !== prevHost) {
          headers = headers.filter(([k]) => !/^(authorization|cookie)$/i.test(k));
        }
        continue;
      }
      break;
    }

    const { res, raw } = result;
    const elapsed = Date.now() - started;
    const body = decompress(raw, res.headers['content-encoding']);
    const ct = res.headers['content-type'] || '';

    const rawHeaders = [];
    for (let i = 0; i < res.rawHeaders.length; i += 2) rawHeaders.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);

    return {
      ok: true,
      status: res.statusCode,
      statusText: res.statusMessage || http.STATUS_CODES[res.statusCode] || '',
      httpVersion: res.httpVersion,
      headers: rawHeaders,
      contentType: ct,
      isText: isTextual(ct),
      bodyText: isTextual(ct) ? body.toString('utf8') : null,
      bodyBase64: body.toString('base64'),
      size: raw.length,
      decodedSize: body.length,
      time: elapsed,
      url,
      redirects,
      sentHeaders: headers,
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      code: err && err.code,
      time: Date.now() - started,
    };
  } finally {
    inflight.delete(spec.id);
  }
}

function cancelHttpRequest(id) {
  const req = inflight.get(id);
  if (req) {
    req.destroy(new Error('Request cancelled'));
    inflight.delete(id);
    return true;
  }
  return false;
}

module.exports = { sendHttpRequest, cancelHttpRequest };
