import { spawnSync } from 'node:child_process';

const database = process.env.CLICKHOUSE_DB || 'anysentry';
const username = process.env.CLICKHOUSE_USER || 'anysentry';
const password = process.env.CLICKHOUSE_PASSWORD || 'anysentry';
const schemaOnly = process.argv.includes('--schema-only');
const identifiers = /^[A-Za-z_][A-Za-z0-9_]*$/;

if (!identifiers.test(database)) {
  throw new Error('CLICKHOUSE_DB must be a plain identifier');
}

const statements = [
  `ALTER TABLE ${database}.events
    ADD COLUMN IF NOT EXISTS commitBatchId String DEFAULT ''`,
  `CREATE TABLE IF NOT EXISTS ${database}.event_commit_facts_v2 (
    eventId String,
    decisionRevision UInt32,
    eventAt UInt64,
    committedAt UInt64,
    commitBatchId String,
    sourceId String,
    collectorId String,
    ts DateTime MATERIALIZED toDateTime(intDiv(committedAt, 1000))
  ) ENGINE = MergeTree
  ORDER BY (committedAt, commitBatchId, eventId, decisionRevision)
  TTL ts + INTERVAL 7 DAY`,
  `CREATE TABLE IF NOT EXISTS ${database}.source_commit_progress (
    sourceId String,
    collectorId String,
    observedDurableThroughState AggregateFunction(max, UInt64),
    lastStoreCommittedAtState AggregateFunction(max, UInt64),
    commitGenerationState AggregateFunction(uniq, UInt64)
  ) ENGINE = AggregatingMergeTree
  ORDER BY (sourceId, collectorId)`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS ${database}.source_commit_progress_mv
  TO ${database}.source_commit_progress
  AS SELECT
    sourceId,
    collectorId,
    maxState(eventAt) AS observedDurableThroughState,
    maxState(committedAt) AS lastStoreCommittedAtState,
    uniqState(cityHash64(eventId, decisionRevision)) AS commitGenerationState
  FROM ${database}.event_commit_facts_v2
  GROUP BY sourceId, collectorId`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS ${database}.event_commit_facts_v2_mv
  TO ${database}.event_commit_facts_v2
  AS SELECT
    eventId,
    decisionRevision,
    at AS eventAt,
    toUInt64(toUnixTimestamp64Milli(now64(3))) AS committedAt,
    commitBatchId,
    sourceId,
    collectorId
  FROM ${database}.events`,
  `INSERT INTO ${database}.source_commit_progress
  SELECT
    sourceId,
    collectorId,
    maxState(at) AS observedDurableThroughState,
    maxState(ingestedAt) AS lastStoreCommittedAtState,
    uniqState(cityHash64(eventId, decisionRevision)) AS commitGenerationState
  FROM ${database}.events
  GROUP BY sourceId, collectorId`,
];

async function executeOverHttp(statement) {
  const endpoint = new URL(process.env.CLICKHOUSE_URL.trim());
  endpoint.pathname = '/';
  endpoint.search = '';
  endpoint.searchParams.set('database', database);
  endpoint.searchParams.set('query', statement);
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization },
  });
  if (!response.ok) {
    throw new Error(`ClickHouse ${response.status}: ${(await response.text()).trim()}`);
  }
}

function executeInCompose(statement) {
  const result = spawnSync('docker', [
    'compose',
    'exec',
    '-T',
    'clickhouse',
    'clickhouse-client',
    '--user',
    username,
    '--password',
    password,
    '--database',
    database,
    '--query',
    statement,
  ], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const selectedStatements = schemaOnly ? statements.slice(0, -1) : statements;
for (const [index, statement] of selectedStatements.entries()) {
  console.log(`[source-progress] step ${index + 1}/${selectedStatements.length}`);
  if (process.env.CLICKHOUSE_URL?.trim()) {
    await executeOverHttp(statement);
  } else {
    executeInCompose(statement);
  }
}

console.log(schemaOnly
  ? 'Source commit progress schema ready; historical events were not scanned.'
  : 'Source commit progress backfill complete. It is an observed durable high-water, not an arrival watermark.');
