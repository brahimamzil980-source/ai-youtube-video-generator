// Local stand-ins for the Cloudflare D1 (SQLite) and R2 bindings, for tests and the
// UI harness only. D1 runs on node:sqlite, so the real SQL is exercised.
import { DatabaseSync } from 'node:sqlite';

export function mockD1() {
  const db = new DatabaseSync(':memory:');
  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
      };
      return stmt;
    },
  };
}

export function mockR2() {
  const store = new Map();
  const toBytes = async (v) => (typeof v === 'string' ? new TextEncoder().encode(v) : v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(await new Response(v).arrayBuffer()));
  return {
    store,
    async put(key, value) { store.set(key, await toBytes(value)); return {}; },
    async get(key, options = {}) {
      const all = store.get(key);
      if (!all) return null;
      const bytes = options.range ? all.slice(options.range.offset, options.range.offset + options.range.length) : all;
      return { size: all.length, body: new Blob([bytes]).stream(), async text() { return new TextDecoder().decode(bytes); } };
    },
    async delete(key) { store.delete(key); },
  };
}
