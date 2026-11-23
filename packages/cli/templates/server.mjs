
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createPublicationTracing } from './publication-tracing.mjs';
const fail = (message) => {
  console.error('server.mjs: ' + message);
  process.exit(1);
};
const flag = (name) => {
  const value = process.env[name] ?? 'false';
  if (value !== 'true' && value !== 'false') fail('Invalid ' + name);
  return value === 'true';
};
const tracingEnabled = flag('WORKSPACE_TRACING_ENABLED'),
  capabilityPropagation = flag('WORKSPACE_TRACING_PROPAGATE_CAPABILITIES'),
  agentPropagation = flag('WORKSPACE_TRACING_PROPAGATE_AGENT');
if ((capabilityPropagation || agentPropagation) && !tracingEnabled) fail('Invalid workspace tracing configuration');
const tracing = await createPublicationTracing({
  enabled: tracingEnabled,
  trustIncoming: flag('WORKSPACE_TRACING_TRUST_INCOMING'),
  propagate: flag('WORKSPACE_TRACING_PROPAGATE'),
});
const portText = process.env.PORT || '3000';
if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65535) fail('PORT must be an integer from 0 to 65535');
const port = Number(portText);
const publicationSchemaVersion = /^[12]$/.test(process.env.PUBLICATION_SCHEMA_VERSION || '1') ? Number(process.env.PUBLICATION_SCHEMA_VERSION || '1') : null;
const bind = process.env.APP_MIXER_BIND || '127.0.0.1';
if (!['127.0.0.1', '0.0.0.0'].includes(bind)) fail('Invalid bind address');
const endpoint = (urlName, path, tokenName) => {
  const text = process.env[urlName];
  if (!text) return undefined;
  const expected = urlName + ' must be an http URL on 127.0.0.1 or localhost with the path ' + path;
  let candidate;
  try {
    candidate = new URL(text);
  } catch {
    fail(expected);
  }
  if (!(
    candidate.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(candidate.hostname) &&
    candidate.pathname === path &&
    !candidate.search &&
    !candidate.hash &&
    !candidate.username &&
    !candidate.password
  ))
    fail(expected);
  if (tokenName && (process.env[tokenName] || '').length < 32) fail(tokenName + ' must contain at least 32 characters when ' + urlName + ' is set');
  return candidate;
};
const dataURL = endpoint('DATA_PLANE_URL', '/application');
const capabilityTimeoutText = process.env.CAPABILITY_TIMEOUT_MS ?? '5000';
if (!/^[1-9]\d{0,4}$/.test(capabilityTimeoutText) || Number(capabilityTimeoutText) < 100 || Number(capabilityTimeoutText) > 30000) fail('Invalid CAPABILITY_TIMEOUT_MS');
const capabilityTimeoutMs = Number(capabilityTimeoutText);
const capabilityResponseLimitText = process.env.CAPABILITY_RESPONSE_MAX_BYTES ?? '1048576';
if (!/^[1-9]\d{0,7}$/.test(capabilityResponseLimitText) || Number(capabilityResponseLimitText) < 1048576 || Number(capabilityResponseLimitText) > 8388608)
  fail('Invalid CAPABILITY_RESPONSE_MAX_BYTES');
const capabilityResponseLimit = Number(capabilityResponseLimitText);
const capabilityRequestLimitText = process.env.CAPABILITY_REQUEST_MAX_BYTES ?? '1048576';
if (!/^[1-9]\d{0,7}$/.test(capabilityRequestLimitText) || Number(capabilityRequestLimitText) < 1048576 || Number(capabilityRequestLimitText) > 8388608)
  fail('Invalid CAPABILITY_REQUEST_MAX_BYTES');
const capabilityRequestLimit = Number(capabilityRequestLimitText);
const capabilityConcurrencyText = process.env.CAPABILITY_MAX_IN_FLIGHT;
if (capabilityConcurrencyText !== undefined && (!/^[1-9]\d{0,2}$/.test(capabilityConcurrencyText) || Number(capabilityConcurrencyText) > 100))
  fail('Invalid CAPABILITY_MAX_IN_FLIGHT');
const capabilityConcurrency = capabilityConcurrencyText === undefined ? undefined : Number(capabilityConcurrencyText);
let capabilityInFlight = 0;
const capabilityUploadTimeoutText = process.env.CAPABILITY_UPLOAD_TIMEOUT_MS;
if (
  capabilityUploadTimeoutText !== undefined &&
  (!/^[1-9]\d{0,4}$/.test(capabilityUploadTimeoutText) || Number(capabilityUploadTimeoutText) < 100 || Number(capabilityUploadTimeoutText) > 30000)
)
  fail('Invalid CAPABILITY_UPLOAD_TIMEOUT_MS');
const capabilityUploadTimeout = capabilityUploadTimeoutText === undefined ? undefined : Number(capabilityUploadTimeoutText);
const capabilityURL = endpoint('CAPABILITY_URL', '/capabilities/', 'CAPABILITY_TOKEN');
const agentURL = endpoint('AGENT_URL', '/agent', 'AGENT_TOKEN');
// Origins the page may call besides itself, for an operator whose extensions use another service; only bare http(s) origins are accepted.
const connectOrigins = (process.env.CONNECT_ORIGINS ?? '').split(/[ ,]+/).filter(Boolean);
for (const origin of connectOrigins) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {}
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin)
    fail(
      'CONNECT_ORIGINS must list origins such as https://api.example.com,' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        ' separated by spaces or commas',
    );
}
// The page's inline script and style are allowed by hash, so the policy needs no 'unsafe-inline'; only index.html is HTML. The policy is derived from the bytes being served.
const inlineHashes = (html, tag) =>
  [...html.matchAll(new RegExp('<' + tag + '( [^>]*)?>([^]*?)</' + tag + '>', 'g'))]
    .filter((match) => !/\ssrc=/.test(match[1] || ''))
    .map((match) => "'sha256-" + createHash('sha256').update(match[2]).digest('base64') + "'");
const indexPolicy = (html) =>
  [
    "default-src 'none'",
    "script-src 'self' " + inlineHashes(html, 'script').join(' '),
    'style-src ' + (inlineHashes(html, 'style').join(' ') || "'none'"),
    "connect-src 'self'" + connectOrigins.map((origin) => ' ' + origin).join(''),
    "img-src 'self' data:",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
};
const readCapabilityBody = (req, maxBytes, timeoutMs) =>
  new Promise((resolve, reject) => {
    const parts = [];
    let size = 0,
      finished = false;
    const timer = setTimeout(() => finish(Error('UPLOAD_TIMEOUT')), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAbort);
      req.off('error', onError);
    };
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) {
        req.on('error', () => {});
        req.resume();
        reject(error);
      } else resolve(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish(Error('TOO_LARGE'));
        return;
      }
      parts.push(chunk);
    };
    const onEnd = () => {
      try {
        finish(undefined, JSON.parse(Buffer.concat(parts).toString('utf8')));
      } catch {
        finish(Error('INVALID_JSON'));
      }
    };
    const onAbort = () => finish(Error('DISCONNECTED')),
      onError = () => finish(Error('DISCONNECTED'));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAbort);
    req.once('error', onError);
  });
const server = createServer(async (req, res) => {
  const host = req.headers.host;
  if (host !== '127.0.0.1:' + req.socket.localPort && host !== 'localhost:' + req.socket.localPort) {
    json(res, 400, { error: 'Invalid host' });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/publication/status') {
    json(res, 200, { configured: !!process.env.DATA_PLANE_URL, schemaVersion: publicationSchemaVersion });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/publication') {
    return tracing.handle(req, res, 'GET', '/api/publication', async () => {
      if (!dataURL) {
        json(res, 503, { error: 'Data plane is not configured' });
        return;
      }
      try {
        await tracing.upstream('GET', '/application', async (traceHeaders, report) => {
          const upstream = await fetch(dataURL, {
            headers: { ...traceHeaders, ...(req.headers['if-none-match'] ? { 'If-None-Match': req.headers['if-none-match'] } : {}) },
            redirect: 'error',
            signal: AbortSignal.timeout(5000),
          });
          report(upstream.status);
          const etag = upstream.headers.get('etag');
          if (upstream.status === 304 && etag) {
            res.writeHead(304, { etag: etag, 'cache-control': 'no-store' });
            res.end();
            return;
          }
          if (upstream.status !== 200 || !etag || !upstream.body) throw Error('Invalid publication response');
          const chunks = [];
          let size = 0;
          for await (const chunk of upstream.body) {
            size += chunk.length;
            if (size > 1024 * 1024) throw Error('Publication too large');
            chunks.push(chunk);
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', etag: etag });
          res.end(Buffer.concat(chunks));
        });
      } catch {
        if (!res.destroyed) json(res, 502, { error: 'Publication unavailable' });
      }
    });
  }
  const capabilityMatch = req.method === 'POST' && /^\/api\/capabilities\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,255})$/.exec(req.url || '');
  if (capabilityMatch) {
    return tracing.handle(req, res, 'POST', '/api/capabilities/{operationId}', async () => {
      if (req.headers.origin !== 'http://' + host) {
        json(res, 403, { error: 'Invalid origin' });
        return;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
        json(res, 415, { error: 'Expected JSON' });
        return;
      }
      if (!capabilityURL) {
        json(res, 503, { error: 'Capabilities are not configured' });
        return;
      }
      if (capabilityConcurrency !== undefined && capabilityInFlight >= capabilityConcurrency) {
        json(res, 503, { error: 'Capability proxy busy' });
        return;
      }
      capabilityInFlight++;
      try {
        const parts = [];
        let size = 0,
          input;
        try {
          if (capabilityUploadTimeout !== undefined) input = await readCapabilityBody(req, capabilityRequestLimit, capabilityUploadTimeout);
          else {
            for await (const chunk of req) {
              size += chunk.length;
              if (size > capabilityRequestLimit) {
                json(res, 413, { error: 'Request too large' });
                return;
              }
              parts.push(chunk);
            }
            input = JSON.parse(Buffer.concat(parts).toString('utf8'));
          }
        } catch (error) {
          if (!res.destroyed) {
            if (error?.message === 'UPLOAD_TIMEOUT' || error?.message === 'TOO_LARGE') res.setHeader('Connection', 'close');
            json(res, error?.message === 'UPLOAD_TIMEOUT' ? 408 : error?.message === 'TOO_LARGE' ? 413 : 400, {
              error: error?.message === 'UPLOAD_TIMEOUT' ? 'Request timed out' : error?.message === 'TOO_LARGE' ? 'Request too large' : 'Invalid request',
            });
          }
          return;
        }
        try {
          await tracing.upstream(
            'POST',
            '/capabilities/{operationId}/invoke',
            async (traceHeaders, report) => {
              const upstream = await fetch(new URL(capabilityMatch[1] + '/invoke', capabilityURL), {
                method: 'POST',
                headers: { ...traceHeaders, 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CAPABILITY_TOKEN },
                body: JSON.stringify({ origin: 'ui', input }),
                redirect: 'error',
                signal: AbortSignal.timeout(capabilityTimeoutMs),
              });
              report(upstream.status);
              if (
                ![200, 400, 401, 403, 404, 409, 413, 415, 429, 500, 503].includes(upstream.status) ||
                !/^application\/json(?:\s*;|$)/i.test(upstream.headers.get('content-type') || '') ||
                !upstream.body
              )
                throw Error('Invalid capability response');
              const chunks = [];
              let length = 0;
              for await (const chunk of upstream.body) {
                length += chunk.length;
                if (length > capabilityResponseLimit) throw Error('Capability response too large');
                chunks.push(chunk);
              }
              const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              json(res, upstream.status, result);
            },
            capabilityPropagation,
          );
        } catch {
          if (!res.destroyed) json(res, 502, { error: 'Capability service unavailable' });
        }
      } finally {
        capabilityInFlight--;
      }
    });
  }
  if (req.method === 'GET' && req.url === '/api/chat/status') {
    json(res, 200, { enabled: !!agentURL });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    return tracing.handle(req, res, 'POST', '/api/chat', async () => {
      if (req.headers.origin !== 'http://' + host) {
        json(res, 403, { error: 'Invalid origin' });
        return;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
        json(res, 415, { error: 'Expected JSON' });
        return;
      }
      if (!agentURL) {
        json(res, 503, { error: 'Agent is not configured' });
        return;
      }
      let body = '',
        size = 0;
      const parts = [];
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) {
            json(res, 413, { error: 'Request too large' });
            return;
          }
          parts.push(chunk);
        }
        body = Buffer.concat(parts).toString('utf8');
        JSON.parse(body);
      } catch {
        if (!res.destroyed) json(res, 400, { error: 'Invalid request' });
        return;
      }
      const controller = new AbortController();
      res.once('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        await tracing.upstream(
          'POST',
          '/agent',
          async (traceHeaders, report) => {
            const upstream = await fetch(agentURL, {
              method: 'POST',
              headers: { ...traceHeaders, 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.AGENT_TOKEN },
              body,
              signal: controller.signal,
            });
            report(upstream.status);
            if (!upstream.ok || !upstream.body || !/^text\/event-stream/i.test(upstream.headers.get('content-type') || '')) throw Error('Invalid agent response');
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            for await (const chunk of upstream.body) {
              if (res.destroyed) break;
              if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
            }
            if (controller.signal.aborted) throw Error('Client disconnected');
            if (!res.destroyed) res.end();
          },
          agentPropagation,
        );
      } catch {
        if (!res.destroyed) {
          if (!res.headersSent) json(res, 502, { error: 'Agent unavailable' });
          else res.destroy();
        }
      }
    });
  }
  const shellWorkerRequest = req.method === 'GET' && /^\/offline-shell-sw\.js\?revision=[a-zA-Z0-9._-]{1,64}$/.test(req.url || '');
  const path = shellWorkerRequest
    ? 'offline-shell-sw.js'
    : req.method === 'GET' && req.url === '/api/application'
      ? 'application.json'
      : req.method === 'GET' && req.url === '/'
        ? 'index.html'
        : req.method === 'GET' && req.url === '/renderer.mjs'
          ? 'renderer.mjs'
          : req.method === 'GET' && req.url === '/workspace.mjs'
            ? 'workspace.mjs'
            : req.method === 'GET' && req.url === '/extensions.mjs'
              ? 'extensions.mjs'
              : req.method === 'GET' && req.url === '/chat.mjs'
                ? 'chat.mjs'
                : req.method === 'GET' && req.url === '/capabilities.mjs'
                  ? 'capabilities.mjs'
                  : req.method === 'GET' && req.url === '/data-editor.mjs'
                    ? 'data-editor.mjs'
                    : req.method === 'GET' && req.url === '/staged-editor.mjs'
                      ? 'staged-editor.mjs'
                      : req.method === 'GET' &&
                          [
                            '/offline.js',
                            '/offline-worker.js',
                            '/offline-ui.js',
                            '/offline-runtime.mjs',
                            '/offline-shell.mjs',
                            '/offline-shell-sw.js',
                            '/offline-publications.js',
                            '/offline-publication-runtime.mjs',
                            '/offline-publication-host.mjs',
                          ].includes(req.url)
                        ? req.url.slice(1)
                        : null;
  if (!path) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const data = await readFile(new URL(path, import.meta.url));
    res.writeHead(200, {
      'Content-Type': path.endsWith('.json')
        ? 'application/json; charset=utf-8'
        : path.endsWith('.mjs') || path.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(path === 'index.html' ? { 'Content-Security-Policy': indexPolicy(data.toString('utf8')), 'Referrer-Policy': 'no-referrer' } : {}),
    });
    res.end(data);
  } catch {
    res.writeHead(500);
    res.end();
  }
});
// Bound slow or stalled clients; Node's defaults wait 60 s for headers and 300 s for a request.
server.headersTimeout = 10000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 5000;
server.setTimeout(30000);
server.once('error', (error) =>
  fail(error.code === 'EADDRINUSE' ? 'PORT ' + port + ' is already in use on ' + bind : 'Cannot listen on ' + bind + ':' + port + ': ' + error.message),
);
server.listen(port, bind, function () {
  console.log('http://127.0.0.1:' + this.address().port);
});
