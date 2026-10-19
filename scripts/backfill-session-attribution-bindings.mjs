#!/usr/bin/env node
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire('/app/node_modules/pg/package.json');
const pg = require('pg');
const dist = '/app/dist';
const { ClickHouseStore } = await import(pathToFileURL(`${dist}/security-monitoring/clickhouse-store.js`).href);
const { RelationalBusinessStore } = await import(pathToFileURL(`${dist}/security-monitoring/relational-business-store.service.js`).href);
const { SessionEventAttributionService } = await import(pathToFileURL(`${dist}/security-monitoring/session-event-attribution.service.js`).href);

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error(JSON.stringify({ ok: false, error: 'binding_ids_required' }));
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.ANYSENTRY_DATABASE_URL, max: 2 });
const { rows } = await pool.query(
  `SELECT record FROM anysentry_session_process_bindings WHERE binding_id = ANY($1::text[])`,
  [ids],
);
const parse = (record) => (typeof record === 'string' ? JSON.parse(record) : record);
const bindings = rows.map((row) => parse(row.record)).filter((item) => item?.bindingId);
const relational = new RelationalBusinessStore();
const clickhouse = new ClickHouseStore();
const ready = await Promise.all([relational.initialize(), clickhouse.init()]);
if (!ready[0] || !ready[1]) {
  console.error(JSON.stringify({ ok: false, error: 'stores_unavailable', ready }));
  process.exit(2);
}
const service = new SessionEventAttributionService(clickhouse, relational);
const report = [];
for (const binding of bindings) {
  const until = Math.max(
    binding.validFrom,
    Number(binding.validTo ?? binding.observedAt ?? Date.now()) || Date.now(),
  );
  const since = Math.max(1, Math.max(binding.validFrom, until - 24 * 60 * 60 * 1000));
  const started = Date.now();
  try {
    const evidence = await service.evidence(
      binding,
      { since, until },
      undefined,
      128,
      { persist: true, coveragePartial: true },
    );
    report.push({
      bindingId: binding.bindingId,
      session: binding.nativeSessionId,
      persistence: evidence.persistence,
      counts: evidence.counts,
      events: evidence.events.length,
      ms: Date.now() - started,
    });
  } catch (error) {
    report.push({
      bindingId: binding.bindingId,
      session: binding.nativeSessionId,
      error: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    });
  }
}
console.log(JSON.stringify({ ok: !report.some((item) => item.error), report }, null, 2));
await pool.end().catch(() => undefined);
process.exit(report.some((item) => item.error) ? 1 : 0);
