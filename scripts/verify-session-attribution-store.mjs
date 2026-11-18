import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  RelationalBusinessStore, INVALIDATE_OLD_SESSION_RELATIONS_SQL,
} from '../apps/api/dist/security-monitoring/relational-business-store.service.js';
import { SESSION_EVENT_ATTRIBUTION_VERSION as version } from '../apps/api/dist/security-monitoring/session-event-attribution.types.js';

const store = new RelationalBusinessStore();
store.initialize = async () => true;
const query = { hostId: 'host-test', bootId: 'boot-test', since: 1, until: 2 };
for (const size of [0, 1, 5000, 5001]) {
  store.pool = { query: async sql => {
    assert.match(sql, /LIMIT 5001/);
    return { rows: Array.from({ length: size }, (_, i) => ({ record: { bindingId: `b-${i}` } })) };
  } };
  const result = await store.loadSessionProcessBindings(query);
  if (size > 5000) assert.equal(result, null);
  else assert.equal(result.length, size);
}

store.pool = { query: async (sql, values) => {
  assert.match(sql, /native_session_id = \$1/);
  assert.match(sql, /record->>'runtimeType' = \$2/);
  assert.deepEqual(values, ['native-session-history', 'codex', 64]);
  return { rows: [{ record: {
    bindingId: 'binding-history', nativeSessionId: 'native-session-history', runtimeType: 'codex',
  } }] };
} };
const historicalBindings = await store.loadSessionProcessBindingsForNativeSession({
  nativeSessionId: 'native-session-history', runtimeType: 'codex',
});
assert.equal(historicalBindings?.[0]?.bindingId, 'binding-history');

store.pool = { query: async (sql, values) => {
  assert.match(sql, /DISTINCT ON \(record->>'eventId'\)/);
  assert.match(sql, /COALESCE\(\(record->>'active'\)::boolean, true\)/);
  assert.match(sql, /attributionVersion/);
  assert.deepEqual(values, ['binding-history', 'conversation-history', 25, version, 100, 200]);
  return { rows: [{ record: {
    relationId: 'relation-history', eventId: 'event-history', eventAt: 150,
    bindingId: 'binding-history', conversationId: 'conversation-history',
    bindingRevision: 2, processInstanceKey: 'process-history', relation: 'DIRECT',
  } }] };
} };
const historicalRelations = await store.loadHistoricalEventSessionRelations({
  bindingId: 'binding-history', conversationId: 'conversation-history',
  limit: 25, since: 100, until: 200,
});
assert.equal(historicalRelations?.[0]?.eventId, 'event-history');

// Opt-in PostgreSQL integration: a transaction-local table shadows the real one.
// No production relation is read or updated; every fixture change is rolled back.
if (process.env.ANYSENTRY_TEST_POSTGRES_CONTAINER) {
  const migration = INVALIDATE_OLD_SESSION_RELATIONS_SQL
    .replaceAll('$1', String(version)).replaceAll('$2', '1800000000000');
  const result = spawnSync('docker', ['exec', '-i', process.env.ANYSENTRY_TEST_POSTGRES_CONTAINER,
    'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'anysentry', '-d', 'anysentry'], {
    encoding: 'utf8', timeout: 15000,
    input: `BEGIN;
      SET LOCAL statement_timeout='8s';
      CREATE TEMP TABLE anysentry_event_session_relations (relation_id text, record jsonb, updated_at bigint);
      INSERT INTO anysentry_event_session_relations VALUES
        ('old','{"active":true,"attributionVersion":${version - 1}}',1),
        ('current','{"active":true,"attributionVersion":${version}}',1),
        ('future','{"active":true,"attributionVersion":${version + 1}}',1),
        ('inactive','{"active":false,"attributionVersion":1}',1),
        ('legacy','{}',1);
      ${migration};
      ${migration};
      DO $$ BEGIN
        IF (SELECT count(*) FROM anysentry_event_session_relations WHERE record->>'requiresReattribution'='true') <> 2
          THEN RAISE EXCEPTION 'old or legacy relations not invalidated'; END IF;
        IF (SELECT count(*) FROM anysentry_event_session_relations WHERE record->>'active'='true') <> 2
          THEN RAISE EXCEPTION 'current or future relations changed'; END IF;
        IF (SELECT updated_at FROM anysentry_event_session_relations WHERE relation_id='inactive') <> 1
          THEN RAISE EXCEPTION 'inactive audit record changed'; END IF;
      END $$;
      ROLLBACK;`,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}
console.log(JSON.stringify({ ok: true, overflowFailsClosed: true,
  historicalBindingRead: true, historicalRelationRead: true,
  migrationPostgresTest: Boolean(process.env.ANYSENTRY_TEST_POSTGRES_CONTAINER), version }));
