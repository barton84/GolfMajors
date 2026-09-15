// Storage wrapper. Netlify Blobs in production, in-memory (or a JSON file) for local dev.
import { createHash } from 'node:crypto';

let memory = null;

function memoryStore() {
  if (!memory) memory = new Map();
  const persistFile = process.env.LOCAL_STORE_FILE;
  let loaded = false;
  const load = async () => {
    if (loaded || !persistFile) return;
    loaded = true;
    try {
      const fs = await import('node:fs/promises');
      const obj = JSON.parse(await fs.readFile(persistFile, 'utf8'));
      for (const [k, v] of Object.entries(obj)) memory.set(k, v);
    } catch {}
  };
  const save = async () => {
    if (!persistFile) return;
    const fs = await import('node:fs/promises');
    await fs.writeFile(persistFile, JSON.stringify(Object.fromEntries(memory)));
  };
  const etagOf = (v) => createHash('md5').update(JSON.stringify(v)).digest('hex');
  return {
    async get(key) {
      await load();
      if (!memory.has(key)) return { data: null, etag: null };
      const data = structuredClone(memory.get(key));
      return { data, etag: etagOf(data) };
    },
    async set(key, data, { onlyIfMatch, onlyIfNew } = {}) {
      await load();
      if (onlyIfNew && memory.has(key)) return { modified: false };
      if (onlyIfMatch && (!memory.has(key) || etagOf(memory.get(key)) !== onlyIfMatch)) return { modified: false };
      memory.set(key, structuredClone(data));
      await save();
      return { modified: true, etag: etagOf(data) };
    },
    async del(key) {
      await load();
      memory.delete(key);
      await save();
    },
  };
}

async function blobsStore() {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore({ name: 'golf-draft', consistency: 'strong' });
  return {
    async get(key) {
      const r = await store.getWithMetadata(key, { type: 'json' });
      return r ? { data: r.data, etag: r.etag } : { data: null, etag: null };
    },
    async set(key, data, opts = {}) {
      const r = await store.setJSON(key, data, opts);
      return { modified: r?.modified !== false, etag: r?.etag };
    },
    async del(key) {
      await store.delete(key);
    },
  };
}

// Netlify issues a short-lived access token for each request, so the Blobs client must be
// created fresh every time. Reusing one across requests fails with "Token expired".
export async function getStore() {
  return process.env.LOCAL_DEV ? memoryStore() : await blobsStore();
}

// Read-modify-write with optimistic concurrency so two picks at once can't clobber each other.
export async function update(key, fn, { retries = 6 } = {}) {
  const store = await getStore();
  for (let i = 0; i < retries; i++) {
    const { data, etag } = await store.get(key);
    const next = await fn(data);
    if (next === undefined) return data;
    const res = await store.set(key, next, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (res.modified) return next;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
  }
  throw Object.assign(new Error('Someone else just saved. Please try again.'), { status: 409 });
}
