import { spawnSync } from 'node:child_process';

const database = process.env.CLICKHOUSE_DB || 'anysentry';
const table = process.env.CLICKHOUSE_EVENTS_TABLE || 'events';
const username = process.env.CLICKHOUSE_USER || 'anysentry';
const password = process.env.CLICKHOUSE_PASSWORD || 'anysentry';
const wait = process.argv.includes('--wait');
const identifiers = /^[A-Za-z_][A-Za-z0-9_]*$/;

if (!identifiers.test(database) || !identifiers.test(table)) {
  throw new Error('CLICKHOUSE_DB and CLICKHOUSE_EVENTS_TABLE must be plain identifiers');
}

const columns = [
  'agentIdentityKey',
  'agentInstanceKey',
  'agentMonitored',
  'agentHasPhysicalIdentity',
  'agentHasRootIdentity',
];

const query = `
ALTER TABLE ${database}.${table}
  ${columns.map((column) => `MATERIALIZE COLUMN ${column}`).join(',\n  ')}
SETTINGS mutations_sync = ${wait ? 2 : 0}
`.trim();

const url = process.env.CLICKHOUSE_URL?.trim();
if (url) {
  const endpoint = new URL(url);
  endpoint.pathname = '/';
  endpoint.searchParams.set('database', database);
  endpoint.searchParams.set('query', query);
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization },
  });
  if (!response.ok) {
    throw new Error(`ClickHouse ${response.status}: ${(await response.text()).trim()}`);
  }
} else {
  const args = [
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
    query,
  ];
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(
  wait
    ? 'Event query columns materialized'
    : 'Event query column materialization scheduled; inspect system.mutations for progress',
);
