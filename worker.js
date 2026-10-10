/* Sprout — Cloudflare Worker: serves the PWA's static assets and the sync API.
   GET  /api/sync/:key -> JSON snapshot or 404
   PUT  /api/sync/:key -> store JSON snapshot (validated, size-capped)
   Everything else falls through to the static assets.
   Requires a KV namespace bound as SPROUT_KV (dashboard: Settings → Bindings). */

const KEY_RE = /^[a-z0-9-]{8,64}$/;
const SYNC_RE = /^\/api\/sync\/([^/]+)$/;
const MAX_BYTES = 5000000; // 5 MB — far below KV's 25 MiB per-value limit

function kvName(key) {
  return 'sprout:sync:' + key;
}

async function handleSync(request, env, rawKey) {
  const key = String(rawKey).toLowerCase();
  if (!KEY_RE.test(key)) return new Response('bad key', { status: 400 });
  if (!env.SPROUT_KV) return new Response('KV namespace SPROUT_KV is not bound', { status: 500 });

  if (request.method === 'GET') {
    const val = await env.SPROUT_KV.get(kvName(key));
    if (val == null) return new Response('not found', { status: 404 });
    return new Response(val, {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  if (request.method === 'PUT') {
    let body;
    try {
      body = await request.text();
    } catch (e) {
      return new Response('bad body', { status: 400 });
    }
    if (!body || body.length > MAX_BYTES) return new Response('bad size', { status: 413 });

    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      return new Response('bad json', { status: 400 });
    }
    if (!data || !Array.isArray(data.kids) || !Array.isArray(data.measurements)) {
      return new Response('bad snapshot', { status: 400 });
    }

    await env.SPROUT_KV.put(kvName(key), body);
    return new Response('ok');
  }

  return new Response('method not allowed', { status: 405 });
}

export default {
  async fetch(request, env) {
    const m = SYNC_RE.exec(new URL(request.url).pathname);
    if (m) return handleSync(request, env, m[1]);
    return env.ASSETS.fetch(request);
  }
};
