/* Sprout sync API — Cloudflare Pages Function.
   GET  /api/sync/:key -> JSON snapshot or 404
   PUT  /api/sync/:key -> store JSON snapshot (validated, size-capped)
   Requires a KV namespace bound as SPROUT_KV (see README). */

const KEY_RE = /^[a-z0-9-]{8,64}$/;
const MAX_BYTES = 5000000; // 5 MB — far below KV's 25 MiB per-value limit

function kvName(key) {
  return 'sprout:sync:' + key;
}

function badKey(params) {
  const key = String((params && params.key) || '').toLowerCase();
  return KEY_RE.test(key) ? key : null;
}

export async function onRequestGet(context) {
  const { params, env } = context;
  const key = badKey(params);
  if (!key) return new Response('bad key', { status: 400 });
  if (!env.SPROUT_KV) return new Response('KV namespace SPROUT_KV is not bound', { status: 500 });
  const val = await env.SPROUT_KV.get(kvName(key));
  if (val == null) return new Response('not found', { status: 404 });
  return new Response(val, {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

export async function onRequestPut(context) {
  const { request, params, env } = context;
  const key = badKey(params);
  if (!key) return new Response('bad key', { status: 400 });
  if (!env.SPROUT_KV) return new Response('KV namespace SPROUT_KV is not bound', { status: 500 });

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
