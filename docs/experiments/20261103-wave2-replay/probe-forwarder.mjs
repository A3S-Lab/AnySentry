// Minimal probe: feed a few archived raw lines to the Forwarder with WAVE-2 replay env and
// print exactly what the mock API receives plus the pipeline diagnostics. Debug aid only.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const lines = fs.readFileSync('/tmp/replay-probe.ndjson', 'utf8').trim().split('\n');
const received = [];
const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', (c) => { body += c; });
  request.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    received.push({ url: request.url, parsed });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (request.url?.endsWith('/batch')) {
      const events = Array.isArray(parsed?.events) ? parsed.events : [];
      response.end(JSON.stringify({ data: { accepted: true, acceptedEvents: events.length, rejectedEvents: 0, retryableEvents: 0, items: events.map((_, i) => ({ index: i, accepted: true, disposition: 'retained' })) } }));
      return;
    }
    if (request.url?.endsWith('/runtime/lease')) { response.end('{"accepted":true,"leaseEpoch":1}'); return; }
    response.end('{"accepted":true}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave2-probe-'));
const diagnosticsPath = path.join(spoolDir, 'pipeline.json');
const env = {
  ...process.env,
  FORWARD_FILTER_MODE: 'enforce',
  FORWARD_RETAIN_UNKNOWN: 'false',
  FORWARD_RETAIN_NON_AGENT: 'false',
  FORWARD_NOISE_POLICY: 'balanced',
  FORWARD_AGENT_ALLOWLIST: 'kimi-cli',
  FORWARD_BATCH_SIZE: '64',
  FORWARD_BATCH_FLUSH_MS: '50',
  ANYSENTRY_UNRESOLVED_EXIT_LIMIT: '1000000',
  ANYSENTRY_PIPELINE_DIAGNOSTICS_PATH: diagnosticsPath,
  ANYSENTRY_INGEST_URL: `http://127.0.0.1:${port}/security-center/ingest`,
  ANYSENTRY_BATCH_INGEST_URL: `http://127.0.0.1:${port}/security-center/ingest/batch`,
  ANYSENTRY_HEARTBEAT_URL: `http://127.0.0.1:${port}/security-center/collectors/heartbeat`,
  ANYSENTRY_IDENTITY_SNAPSHOT_URL: `http://127.0.0.1:${port}/security-center/identity/snapshot`,
  ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_URL: `http://127.0.0.1:${port}/security-center/runtime/snapshot`,
  ANYSENTRY_AGENT_RUNTIME_LEASE_URL: `http://127.0.0.1:${port}/security-center/runtime/lease`,
  ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0.05',
  ANYSENTRY_HEARTBEAT_SECS: '60',
  ANYSENTRY_DOCKER_DISCOVERY: 'off',
  ANYSENTRY_BEHAVIOR_DISCOVERY: 'off',
  ANYSENTRY_AGENT_TEMPLATES_JSON: '[]',
  FORWARD_SPOOL_PATH: path.join(spoolDir, 'spool.wal'),
  FORWARD_SHUTDOWN_TIMEOUT_MS: '20000',
  A3S_OBSERVER_COLLECTOR_ID: 'wave2-probe',
};
delete env.ANYSENTRY_E2E_INGEST_MARKER_PREFIX;
const child = spawn(process.execPath, [path.join(repoRoot, 'scripts/observer-forward.js')], {
  env, stdio: ['pipe', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (c) => { stderr += c; });
child.stdin.write(lines.join('\n') + '\n');
child.stdin.end();
const code = await new Promise((r) => child.on('exit', r));
await new Promise((r) => server.close(r));
console.log('exit', code);
console.log('--- stderr tail ---');
console.log(stderr.split('\n').slice(-15).join('\n'));
const batchEvents = received.filter((r) => r.url.endsWith('/batch')).flatMap((r) => r.parsed.events ?? []);
console.log('--- batch events received:', batchEvents.length);
for (const e of batchEvents.slice(0, 10)) {
  const o = typeof e === 'string' ? JSON.parse(e) : e;
  console.log(JSON.stringify(o).slice(0, 400));
}
console.log('--- diagnostics ---');
if (fs.existsSync(diagnosticsPath)) {
  const d = JSON.parse(fs.readFileSync(diagnosticsPath, 'utf8'));
  const recs = Array.isArray(d.records) ? d.records : [];
  console.log('records', recs.length);
  const byReason = {};
  for (const r of recs) {
    const k = `${r.stage ?? r.decision ?? '?'}:${r.reasonCode ?? r.reason ?? '?'}`;
    byReason[k] = (byReason[k] ?? 0) + 1;
  }
  console.log(byReason);
  for (const r of recs.slice(0, 12)) console.log(JSON.stringify(r).slice(0, 300));
} else {
  console.log('no diagnostics file');
}
