// Exercises the actual generated SQL in connection-local TEMP tables, never business tables.
// Run after build:api. Requires the local PostgreSQL container; override its name if needed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Module } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// Optional deployment artifact: resolve dependencies against the built API, while testing
// the exact extracted/patched module that will be copied into the existing runtime image.
const modulePath = fileURLToPath(new URL('../apps/api/dist/security-monitoring/relational-business-store.service.js', import.meta.url));
const loaded = new Module(modulePath);
loaded.filename = modulePath;
loaded.paths = Module._nodeModulePaths(dirname(modulePath));
loaded._compile(readFileSync(process.env.ANYSENTRY_TEST_STORE_FILE || modulePath, 'utf8'), modulePath);
const { RelationalBusinessStore } = loaded.exports;

const store = new RelationalBusinessStore();
const captured = [];
const client = { query: async (sql, values) => { if (values) captured.push(sql); } };
store.saveBusinessRecords = async (records, _operation, _identity, upsert) => {
  await upsert(client, records);
  return true;
};
const cases = [
  { table: 'anysentry_alerts', key: 'alertId', method: () => store.upsertAlertRecords(client, [{}]),
    columns: 'alert_id text PRIMARY KEY, dedupe_key text, status text, severity text, kind text, record jsonb, first_seen_at bigint, last_seen_at bigint, updated_at bigint',
    extra: { dedupeKey: 'test', kind: 'risk', firstSeenAt: 100, lastSeenAt: 200 } },
  { table: 'anysentry_incidents', key: 'incidentId', method: () => store.upsertIncidentRecords(client, [{}]),
    columns: 'incident_id text PRIMARY KEY, status text, severity text, agent_id text, workspace_path text, record jsonb, opened_at bigint, updated_at bigint',
    extra: { openedAt: 100, agentId: 'test', workspacePath: '/fixture' } },
  { table: 'anysentry_remediations', key: 'taskId', method: () => store.saveRemediations([{}]),
    columns: 'task_id text PRIMARY KEY, source_type text, source_id text, status text, severity text, record jsonb, created_at_ms bigint, updated_at bigint',
    extra: { createdAt: 100, sourceType: 'alert', sourceId: 'test' } },
];
let script = '\\set ON_ERROR_STOP on\nBEGIN;\nSET LOCAL statement_timeout = \'30s\';\n';
for (const c of cases) {
  await c.method();
  const sql = captured.pop();
  assert.match(sql, /IS DISTINCT FROM EXCLUDED.record/);
  // Same previous SQL, with only the new no-op predicate removed, for controlled comparison.
  const baseline = sql.slice(0, sql.indexOf('\n', sql.indexOf('WHERE EXCLUDED.updated_at')));
  const record = { [c.key]: 'fixture', status: 'open', severity: 'high', updatedAt: 200, ...c.extra };
  const bind = (query, value) => query.replace('$1', "'" + JSON.stringify([value]).replaceAll("'", "''") + "'");
  script += `CREATE TEMP TABLE ${c.table} (${c.columns}) ON COMMIT DROP;\n`;
  for (const [label, query, expected] of [['before', baseline, 100], ['after', sql, 0]]) {
    script += `TRUNCATE pg_temp.${c.table};\n${bind(query, record)};\n`;
    script += `DO $test$ DECLARE changed integer; total integer := 0; started timestamptz := clock_timestamp(); BEGIN
      FOR i IN 1..100 LOOP
        ${bind(query, record)};
        GET DIAGNOSTICS changed = ROW_COUNT; total := total + changed;
      END LOOP;
      IF total <> ${expected} THEN RAISE EXCEPTION 'unexpected duplicate updates: %', total; END IF;
      RAISE NOTICE '${c.table} ${label}: repeated updates=%, elapsed_ms=%', total, extract(epoch FROM clock_timestamp()-started)*1000;
    END $test$;\n`;
  }
  // Equal timestamp corrections must still work; stale writes must not overwrite them.
  for (const [value, expected] of [
    [{ ...record, note: 'same timestamp correction' }, 1],
    [{ ...record, updatedAt: 199, note: 'stale' }, 0],
    [{ ...record, updatedAt: 201, note: 'new revision' }, 1],
    [{ ...record, updatedAt: 201, note: 'new revision' }, 0],
  ]) {
    script += `DO $test$ DECLARE changed integer; BEGIN
      ${bind(sql, value)}; GET DIAGNOSTICS changed = ROW_COUNT;
      IF changed <> ${expected} THEN RAISE EXCEPTION 'revision contract failed'; END IF;
    END $test$;\n`;
  }
  script += `DO $test$ BEGIN IF (SELECT record->>'note' FROM pg_temp.${c.table}) <> 'new revision'
    THEN RAISE EXCEPTION 'final record mismatch'; END IF; END $test$;\n`;
}
script += 'ROLLBACK;\n';
const result = spawnSync('docker', ['exec', '-i', process.env.ANYSENTRY_TEST_POSTGRES_CONTAINER || 'anysentry-postgres-1',
  'psql', '-X', '-q', '-U', 'anysentry', '-d', 'anysentry'], { input: script, encoding: 'utf8', timeout: 60000 });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) throw result.error;
assert.equal(result.status, 0, 'isolated PostgreSQL contract test failed');
console.log('PASS: unchanged writes suppressed; corrections, newer revisions and stale-write guards preserved.');
