import { spawnSync } from 'node:child_process';

const database = process.env.CLICKHOUSE_DB || 'anysentry';
const table = process.env.CLICKHOUSE_EVENTS_TABLE || 'events';
const username = process.env.CLICKHOUSE_USER || 'anysentry';
const password = process.env.CLICKHOUSE_PASSWORD || 'anysentry';
const wait = process.argv.includes('--wait');
const schemaOnly = process.argv.includes('--schema-only');
const identifiers = /^[A-Za-z_][A-Za-z0-9_]*$/;

if (!identifiers.test(database) || !identifiers.test(table)) {
  throw new Error('CLICKHOUSE_DB and CLICKHOUSE_EVENTS_TABLE must be plain identifiers');
}

const statements = [
  `ALTER TABLE ${database}.${table}
    ADD COLUMN IF NOT EXISTS agentSessionKey String DEFAULT if(
      JSONExtractString(attribution, 'agentSessionId') != '',
      JSONExtractString(attribution, 'agentSessionId'),
      if(
        JSONExtractString(attribution, 'agentDisplayName') != '',
        JSONExtractString(attribution, 'agentDisplayName'),
        if(JSONExtractString(attribution, 'agentScopeId') != '', JSONExtractString(attribution, 'agentScopeId'), agentId)
      )
    )`,
  `ALTER TABLE ${database}.${table}
    ADD COLUMN IF NOT EXISTS resolvedWorkspacePath String DEFAULT if(
      JSONExtractString(process, 'cwd') != '',
      JSONExtractString(process, 'cwd'),
      if(
        JSONExtractString(attribution, 'agentScopeId') != '',
        concat('agent://', JSONExtractString(attribution, 'agentScopeId')),
        workspacePath
      )
    )`,
  `ALTER TABLE ${database}.${table}
    MATERIALIZE COLUMN agentSessionKey,
    MATERIALIZE COLUMN resolvedWorkspacePath
  SETTINGS mutations_sync = ${wait ? 2 : 0}`,
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
  console.log(`[dashboard-columns] step ${index + 1}/${selectedStatements.length}`);
  if (process.env.CLICKHOUSE_URL?.trim()) {
    await executeOverHttp(statement);
  } else {
    executeInCompose(statement);
  }
}

console.log(schemaOnly
  ? 'Dashboard query column schema ready; historical parts were not changed.'
  : wait
    ? 'Dashboard query columns materialized'
    : 'Dashboard query column materialization scheduled; inspect system.mutations for progress');
