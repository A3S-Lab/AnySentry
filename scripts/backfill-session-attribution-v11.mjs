#!/usr/bin/env node
/**
 * Historical Session attribution backfill for bindings whose older relations were invalidated
 * by the v11 upgrade and still lack any active relation.
 *
 * Defaults to dry-run. Pass --write to persist. Run in an isolated container so the worker does
 * not share the API 2 GiB memory cgroup (in-API `docker exec` has OOMed this host):
 *
 *   docker run --rm --network anysentry_default --memory 1g --env-file ... \
 *     -v "$PWD/scripts/backfill-session-attribution-v11.mjs:/tmp/backfill.mjs:ro" \
 *     -v "$PWD/apps/api/dist:/app/dist:ro" -w /app anysentry-api:evidence-20260908 \
 *     node /tmp/backfill.mjs --write --limit 5
 *
 * This is a bounded per-binding replay, not a claim that every historical event has been
 * re-attributed. Interactive System Evidence remains partial for older coverage.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const write = process.argv.includes('--write');
const argValue = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
};
const limit = Math.max(1, Math.min(200, Number(argValue('--limit', 5))));
const delayMs = Math.max(0, Math.min(60_000, Number(argValue('--delay-ms', 1_000))));
const eventLimit = Math.max(32, Math.min(1_000, Number(argValue('--event-limit', 250))));
const maxWindowMs = Math.max(
  5 * 60_000,
  Math.min(24 * 60 * 60_000, Number(argValue('--max-window-ms', 2 * 60 * 60_000))),
);
if (![limit, delayMs, eventLimit, maxWindowMs].every(Number.isFinite)) {
  console.error(JSON.stringify({ ok: false, error: 'invalid_numeric_args' }));
  process.exit(2);
}

const distRoot = process.env.ANYSENTRY_API_DIST
  ?? (existsSync('/app/dist/security-monitoring')
    ? '/app/dist'
    : new URL('../apps/api/dist', import.meta.url).pathname);
const moduleRequire = createRequire(
  existsSync('/app/node_modules/pg')
    ? '/app/node_modules/pg/package.json'
    : new URL('../apps/api/package.json', import.meta.url),
);
const pg = moduleRequire('pg');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function evidenceWindow(binding) {
  const until = Math.max(
    binding.validFrom,
    Number(binding.validTo ?? binding.observedAt ?? Date.now()) || Date.now(),
  );
  const since = Math.max(1, Math.max(binding.validFrom, until - maxWindowMs));
  return { since, until };
}

function parseRecord(record) {
  if (!record) return undefined;
  if (typeof record === 'string') {
    try {
      return JSON.parse(record);
    } catch {
      return undefined;
    }
  }
  return record;
}

const { ClickHouseStore } = await import(pathToFileURL(`${distRoot}/security-monitoring/clickhouse-store.js`).href);
const { RelationalBusinessStore } = await import(pathToFileURL(`${distRoot}/security-monitoring/relational-business-store.service.js`).href);
const { SessionEventAttributionService } = await import(pathToFileURL(`${distRoot}/security-monitoring/session-event-attribution.service.js`).href);
const { SESSION_EVENT_ATTRIBUTION_VERSION } = await import(pathToFileURL(`${distRoot}/security-monitoring/session-event-attribution.types.js`).href);

const databaseUrl = process.env.ANYSENTRY_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error(JSON.stringify({ ok: false, error: 'ANYSENTRY_DATABASE_URL required' }));
  process.exit(2);
}

const listPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pendingResult = await listPool.query(
  `WITH need AS (
     SELECT DISTINCT record->>'bindingId' AS binding_id
       FROM anysentry_event_session_relations
      WHERE COALESCE((record->>'requiresReattribution')::boolean, false)
   ),
   active AS (
     SELECT DISTINCT record->>'bindingId' AS binding_id
       FROM anysentry_event_session_relations
      WHERE COALESCE((record->>'active')::boolean, true)
   ),
   pending AS (
     SELECT need.binding_id
       FROM need
       LEFT JOIN active USING (binding_id)
      WHERE active.binding_id IS NULL
   ),
   ranked AS (
     SELECT b.record,
            row_number() OVER (
              PARTITION BY b.record->>'nativeSessionId'
              ORDER BY b.observed_at DESC NULLS LAST, b.binding_id
            ) AS session_rank
       FROM anysentry_session_process_bindings b
       JOIN pending ON pending.binding_id = b.binding_id
   )
   SELECT record
     FROM ranked
    WHERE session_rank = 1
    ORDER BY (record->>'observedAt')::bigint DESC NULLS LAST, record->>'bindingId'
    LIMIT $1`,
  [limit],
);
const pending = pendingResult.rows
  .map((row) => parseRecord(row.record))
  .filter((record) => Boolean(record?.bindingId));

const relational = new RelationalBusinessStore();
const clickhouse = new ClickHouseStore();
const ready = await Promise.all([relational.initialize(), clickhouse.init()]);
if (!ready[0] || !ready[1]) {
  console.error(JSON.stringify({
    ok: false,
    error: 'stores_unavailable',
    postgresql: ready[0],
    clickhouse: ready[1],
  }));
  await listPool.end().catch(() => undefined);
  process.exit(2);
}

const attribution = new SessionEventAttributionService(clickhouse, relational);
const report = [];
const skipBindingIds = new Set(
  String(process.env.ANYSENTRY_BACKFILL_SKIP_BINDING_IDS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);
for (const binding of pending) {
  if (skipBindingIds.has(binding.bindingId)) {
    report.push({
      bindingId: binding.bindingId,
      nativeSessionId: binding.nativeSessionId,
      matchedPid: binding.matchedPid,
      mode: write ? 'write' : 'dry-run',
      skipped: 'env_skip_list',
      elapsedMs: 0,
    });
    continue;
  }
  const window = evidenceWindow(binding);
  const started = Date.now();
  try {
    if (!write) {
      report.push({
        bindingId: binding.bindingId,
        nativeSessionId: binding.nativeSessionId,
        matchedPid: binding.matchedPid,
        window,
        mode: 'dry-run',
        elapsedMs: Date.now() - started,
      });
    } else {
      const evidence = await attribution.evidence(
        binding,
        window,
        undefined,
        eventLimit,
        { persist: true, coveragePartial: true },
      );
      const empty = evidence.events.length === 0
        && evidence.counts.direct === 0
        && evidence.counts.lineage === 0;
      if (empty) skipBindingIds.add(binding.bindingId);
      report.push({
        bindingId: binding.bindingId,
        nativeSessionId: binding.nativeSessionId,
        matchedPid: binding.matchedPid,
        window,
        mode: 'write',
        persistence: evidence.persistence,
        completeness: evidence.completeness,
        counts: evidence.counts,
        returnedEvents: evidence.events.length,
        ...(empty ? { skippedNext: 'empty_evidence' } : {}),
        elapsedMs: Date.now() - started,
      });
    }
  } catch (error) {
    report.push({
      bindingId: binding.bindingId,
      nativeSessionId: binding.nativeSessionId,
      matchedPid: binding.matchedPid,
      window,
      mode: write ? 'write' : 'dry-run',
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started,
    });
  }
  if (delayMs > 0) await sleep(delayMs);
}

console.log(JSON.stringify({
  ok: !report.some((item) => item.error),
  write,
  version: SESSION_EVENT_ATTRIBUTION_VERSION,
  distRoot,
  limit,
  eventLimit,
  maxWindowMs,
  delayMs,
  pending: pending.length,
  skipBindingIds: [...skipBindingIds],
  report,
}, null, 2));

await listPool.end().catch(() => undefined);
if (typeof clickhouse.close === 'function') await clickhouse.close().catch(() => undefined);
if (typeof relational.onApplicationShutdown === 'function') {
  await relational.onApplicationShutdown().catch(() => undefined);
}
process.exit(report.some((item) => item.error) ? 1 : 0);
