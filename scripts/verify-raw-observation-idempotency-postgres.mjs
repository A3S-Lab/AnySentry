#!/usr/bin/env node

// Runs the real writer against a transaction-local table cloned from the installed schema.
// The URL is read from the environment; no credentials or record bodies are printed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Client } = require('pg');
const { RelationalBusinessStore } = require('./dist/security-monitoring/relational-business-store.service.js');
const { rawObservationFromLine } = require('./dist/security-monitoring/canonical-observability.js');
const connectionString = process.env.ANYSENTRY_TEST_PG_URL;
assert(connectionString, 'ANYSENTRY_TEST_PG_URL is required');
const client = new Client({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(`CREATE TEMP TABLE anysentry_raw_observations_v1
    (LIKE public.anysentry_raw_observations_v1 INCLUDING ALL) ON COMMIT DROP`);
  await client.query('SET LOCAL search_path TO pg_temp');
  const store = Object.create(RelationalBusinessStore.prototype);
  const databaseFailures = [];
  store.initialize = async () => true;
  store.pool = client;
  store.markUnavailable = (_operation, error) => databaseFailures.push(error.code);
  const make = (id, key, revision = 1) => rawObservationFromLine('{"fixture":true}', {
    observationId: id, idempotencyKey: key, revision, sourceId: 'raw-idempotency-fixture',
    eventAtUnixNs: '1788000000000000000', receivedAtUnixNs: '1788000000000000000',
  });
  const original = make('ob_original', 'source-key');
  assert.equal(await store.saveRawObservations([original]), true);
  assert.equal(await store.saveRawObservations([original]), true, 'identical replay succeeds');
  // This used to reach PostgreSQL's second unique constraint, fail the whole INSERT, and mark
  // the store unavailable instead of rejecting a known identity conflict before writing.
  assert.equal(await store.saveRawObservations([make('ob_conflicting-alias', 'source-key')]), false);
  assert.deepEqual(databaseFailures, [], 'stored idempotency collision must be rejected before INSERT');
  assert.equal(await store.saveRawObservations([make('ob_original', 'different-key')]), false);
  assert.equal(await store.saveRawObservations([
    make('ob_batch-a', 'batch-key'), make('ob_batch-b', 'batch-key'),
  ]), false, 'same-batch idempotency collision rejects the batch');
  assert.deepEqual(databaseFailures, []);
  assert.equal(await store.saveRawObservations([make('ob_revision-two', 'source-key', 2)]), true,
    'revision is part of the idempotency identity');
  assert.equal(await store.saveRawObservations([make('ob_other-source', 'other-source-key')]), true);
  const rows = await client.query('SELECT count(*)::int AS count FROM anysentry_raw_observations_v1');
  assert.equal(rows.rows[0].count, 3, 'conflicts never insert a partial batch');
  console.log('PASS PostgreSQL raw observation replay, both identity keys, batch conflicts and revisions (3 temporary rows)');
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end();
}
