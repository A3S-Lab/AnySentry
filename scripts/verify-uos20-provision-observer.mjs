import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anysentry-provision-observer.'));
const envFile = path.join(directory, 'anysentry.env');
fs.writeFileSync(envFile, [
  'ANYSENTRY_ADMIN_TOKEN=fixture-admin-token',
  'ANYSENTRY_SOURCE_ID=',
  'ANYSENTRY_INGEST_TOKEN=',
  'A3S_OBSERVER_COLLECTOR_ID=',
  'ANYSENTRY_WORKSPACE_PATH=host://fixture',
  '',
].join('\n'), { mode: 0o600 });

let requests = 0;
const mock = http.createServer(async (req, res) => {
  requests += 1;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (req.url !== '/security-center/sources' || req.headers['x-anysentry-admin-token'] !== 'fixture-admin-token') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  if (body.type !== 'observer' || body.requireToken !== true || !body.collectorId) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  res.writeHead(201, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ source: { sourceId: 'src_fixture_observer' }, token: 'fixture-ingest-token' }));
});
await new Promise((resolve, reject) => {
  mock.once('error', reject);
  mock.listen(0, '127.0.0.1', resolve);
});
const address = mock.address();

async function runProvisioner() {
  const child = spawn(process.execPath, [
    'packaging/uos20-arm64/provision-observer.mjs',
    envFile,
    `http://127.0.0.1:${address.port}/security-center`,
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  if (code !== 0) throw new Error(`provisioner exited ${code}: ${output}`);
  if (output.includes('fixture-ingest-token')) throw new Error('provisioner printed the ingest token');
}

try {
  await runProvisioner();
  await runProvisioner();
  const configured = fs.readFileSync(envFile, 'utf8');
  if (!configured.includes('ANYSENTRY_SOURCE_ID=src_fixture_observer')) throw new Error('Source ID was not written');
  if (!configured.includes('ANYSENTRY_INGEST_TOKEN=fixture-ingest-token')) throw new Error('ingest token was not written');
  if (!configured.match(/^A3S_OBSERVER_COLLECTOR_ID=observer-/mu)) throw new Error('collector ID was not written');
  if ((fs.statSync(envFile).mode & 0o777) !== 0o600) throw new Error('environment file mode is not 0600');
  if (requests !== 1) throw new Error(`idempotent provisioning made ${requests} API requests`);
  console.log('UOS ARM64 Observer Source provisioning verification passed');
} finally {
  await new Promise((resolve) => mock.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
}
