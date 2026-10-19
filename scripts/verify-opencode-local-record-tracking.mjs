import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverOpenCodeSessions, parseOpenCodeRecord } from '../apps/api/dist/security-monitoring/local-record-opencode.adapter.js';
import { LocalRecordTrackingService } from '../apps/api/dist/security-monitoring/local-record-tracking.service.js';
import { staticToolCommands } from '../apps/api/dist/security-monitoring/local-tool-evidence.js';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const sqlite = require('sqlite3');
const { AgentAttributor } = createRequire(import.meta.url)('./observer-agent-attribution.js');
const dir = await mkdtemp(join(tmpdir(), 'anysentry-opencode-test-'));
const prior = { ...process.env };
let db;
try {
  const path = join(dir, 'opencode.db');
  db = await new Promise((resolve, reject) => { const value = new sqlite.Database(path, error => error ? reject(error) : resolve(value)); });
  const sql = (query, values = []) => new Promise((resolve, reject) => db.run(query, values, error => error ? reject(error) : resolve()));
  await sql('PRAGMA journal_mode = WAL'); await sql('PRAGMA wal_autocheckpoint = 0');
  await sql('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, version TEXT, time_created INTEGER, time_updated INTEGER)');
  await sql('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  await sql('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  await sql('CREATE INDEX message_session ON message(session_id, time_created, id)');
  await sql('CREATE INDEX part_session ON part(session_id, time_created, id)');
  const at = Date.now() - 10000;
  const message = (id, session, time, data) => sql('INSERT INTO message VALUES (?,?,?,?,?)', [id, session, at + time, at + time, JSON.stringify(data)]);
  const part = (id, msg, session, time, data) => sql('INSERT INTO part VALUES (?,?,?,?,?,?)', [id, msg, session, at + time, at + time, JSON.stringify(data)]);
  for (const session of ['ses_a', 'ses_b']) {
    await sql('INSERT INTO session VALUES (?,?,?,?,?,?)', [session, session, '/workspace/same', '1.18.31', at, at + 900]);
    await message(`${session}_u`, session, 0, { role: 'user', time: { created: at } });
    await part(`${session}_text`, `${session}_u`, session, 0, { type: 'text', text: session });
    await message(`${session}_a`, session, 100, { role: 'assistant', parentID: `${session}_u`, modelID: 'fixture', providerID: 'local',
      time: { created: at + 100, completed: at + 900 }, finish: 'stop', tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } } });
    await part(`${session}_reply`, `${session}_a`, session, 800, { type: 'text', text: `reply ${session}` });
    await part(`${session}_tool`, `${session}_a`, session, 200, { type: 'tool', tool: 'bash', callID: 'same-call-id', state: {
      status: 'completed', input: { command: `printf '  ${session}  '` }, output: `output ${session}`, metadata: { exit: session === 'ses_b' ? 1 : 0 },
      time: { start: at + 200, end: at + 700 } } });
  }
  const before = await readFile(path);
  assert.equal((await discoverOpenCodeSessions(path)).length, 2, 'reads live WAL while writer stays open');
  const a = await parseOpenCodeRecord(path, 'ses_a', 'record-a');
  const b = await parseOpenCodeRecord(path, 'ses_b', 'record-b');
  assert.equal(a.metrics.toolCallCount, 1); assert.equal(a.metrics.completeTurnCount, 1);
  assert.equal(a.metrics.tokenUsage.totalTokens, 20, 'count message usage once, not step-finish parts');
  assert.equal(b.metrics.toolFailureCount, 1, 'completed bash with nonzero exit is a failure');
  const call = a.events.find(e => e.kind === 'tool_call');
  assert.equal(call.command, "printf '  ses_a  '"); assert.equal(call.callId, 'same-call-id');
  assert.equal(call.turnId, 'ses_a_u');
  assert.ok(a.events.every(e => !e.content?.includes('ses_b')), 'shared database Sessions stay isolated');
  assert.notEqual(call.eventId, b.events.find(e => e.kind === 'tool_call').eventId);
  assert.deepEqual(await readFile(path), before, 'read-only adapter does not checkpoint or migrate source');
  await message('resume_u', 'ses_a', 1000, { role: 'user', time: { created: at + 1000 } });
  await part('resume_text', 'resume_u', 'ses_a', 1000, { type: 'text', text: 'resume' });
  await message('resume_a', 'ses_a', 1100, { role: 'assistant', parentID: 'resume_u' });
  await part('pending', 'resume_a', 'ses_a', 1200, { type: 'tool', tool: 'bash', callID: 'pending', state: { status: 'pending', input: { command: 'never executed' } } });
  const resumed = await parseOpenCodeRecord(path, 'ses_a', 'record-a');
  assert.equal(resumed.events.find(e => e.callId === call.callId).eventId, call.eventId, 'stable native event IDs after resume');
  assert.equal(resumed.metrics.turnCount, 2); assert.equal(resumed.metrics.completeTurnCount, 1);
  assert.equal(resumed.events.find(e => e.callId === 'pending').command, undefined, 'pending input is no exec anchor');
  assert.deepEqual(staticToolCommands(resumed.events.find(e => e.callId === 'pending')), [], 'candidate extraction cannot reinterpret pending JSON as execution');
  assert.equal(resumed.events.filter(e => e.kind === 'tool_result').length, 1);
  await sql('UPDATE part SET data=? WHERE id=?', [JSON.stringify({ type: 'tool', tool: 'bash', callID: 'pending', state: {
    status: 'error', input: { command: 'false' }, error: 'rejected', time: { start: at + 1200, end: at + 1300 } } }), 'pending']);
  const changed = await parseOpenCodeRecord(path, 'ses_a', 'record-a');
  assert.equal(changed.metrics.toolFailureCount, 1);
  assert.equal(changed.events.find(e => e.callId === 'pending').eventId, resumed.events.find(e => e.callId === 'pending').eventId);
  await sql('INSERT INTO part VALUES (?,?,?,?,?,?)', ['corrupt', 'resume_a', 'ses_a', at + 1500, at + 1500, '{bad']);
  await part('huge', 'resume_a', 'ses_a', 1600, { type: 'text', text: 'x'.repeat(70000) });
  assert.equal((await parseOpenCodeRecord(path, 'ses_a', 'record-a')).partial, true);
  assert.equal(await parseOpenCodeRecord(path, "ses_a' OR 1=1--", 'record'), undefined, 'parameterized Session selection');
  assert.equal(await parseOpenCodeRecord(join(dir, 'missing.db'), 'ses_a', 'record'), undefined);
  await writeFile(join(dir, 'broken.db'), 'not a sqlite database');
  assert.deepEqual(await discoverOpenCodeSessions(join(dir, 'broken.db')), []);
  const proc = join(dir, 'proc'), pid = 43112;
  await mkdir(join(proc, String(pid), 'fd'), { recursive: true });
  await mkdir(join(proc, String(pid), 'fdinfo'), { recursive: true });
  await writeFile(join(proc, String(pid), 'comm'), 'opencode\n');
  await writeFile(join(proc, String(pid), 'cmdline'), '/opt/opencode\0run\0');
  const fields = Array(50).fill('0'); fields[0] = 'S'; fields[1] = '1'; fields[19] = '987654';
  await writeFile(join(proc, String(pid), 'stat'), `${pid} (opencode) ${fields.join(' ')}\n`);
  await symlink(path, join(proc, String(pid), 'fd', '5')); await writeFile(join(proc, String(pid), 'fdinfo', '5'), 'flags:\t0100002\n');
  Object.assign(process.env, { ANYSENTRY_LOCAL_RECORD_TRACKING: 'on', ANYSENTRY_LOCAL_OPENCODE_DATA_DIR: dir,
    ANYSENTRY_LOCAL_PROCESS_TRACKING: 'on', ANYSENTRY_LOCAL_PROCESS_ROOT: proc });
  delete process.env.ANYSENTRY_LOCAL_OPENCODE_DATA_DIRS;
  for (const agent of ['CODEX', 'A3S', 'CLAUDE', 'GEMINI', 'KIMI']) {
    process.env[`ANYSENTRY_LOCAL_${agent}_SESSIONS_DIR`] = join(dir, 'none'); delete process.env[`ANYSENTRY_LOCAL_${agent}_SESSIONS_DIRS`];
  }
  delete process.env.ANYSENTRY_LOCAL_HARBOR_JOBS_DIR;
  const anchors = [];
  const service = new LocalRecordTrackingService({ status: () => ({ enabled: false, projection: { postgresql: false, clickhouse: false } }) }, {
    resolveBinding: async () => { throw new Error('shared SQLite FD must never bind a Session'); },
    resolveBindingFromSessionFile: async () => { throw new Error('shared SQLite path must never bind a Session'); },
    resolveBindingsFromExactToolExec: async value => { anchors.push(value); return []; },
  });
  const list = await service.listRecords({ limit: 10, adapter: 'opencode' });
  assert.equal(list.total, 2);
  assert.ok(list.items.every(item => item.adapter === 'opencode' && !item.processPid));
  const detail = await service.recordDetail(list.items.find(item => item.sessionId === 'ses_a').recordId, { limit: 3, includeObservedLlmRequests: false });
  assert.equal(detail.provenance.source, 'opencode_local_session'); assert.equal(detail.page.hasMore, true);
  assert.equal(detail.metrics.toolCallCount, 2);
  assert.ok(anchors.some(value => value.runtimeType === 'opencode' && value.nativeSessionId === 'ses_a'));
  const older = await service.recordDetail(detail.record.recordId, { limit: 500, beforeOffset: detail.page.nextBeforeOffset, includeSystemEvidence: false });
  assert.ok(older.events.every(event => !detail.events.some(item => item.eventId === event.eventId)));
  const attributor = new AgentAttributor({ hostId: 'test', bootId: 'test' });
  for (const input of [{ comm: 'opencode' }, { comm: 'worker', exe: '/opt/opencode' }, { comm: 'node', argv: ['node', '/tmp/node_modules/opencode-ai/bin/opencode'] }]) {
    assert.equal(attributor.matchAgentExecutable(input)?.agentId, 'opencode');
  }
  for (const input of [{ comm: 'bun', exe: '/usr/bin/bun', argv: ['bun', 'server.ts', 'opencode'] }, { comm: 'node', argv: ['node', 'app.js', '/tmp/opencode-ai/bin/opencode'] }]) {
    assert.equal(attributor.matchAgentExecutable(input), undefined);
  }
  await new Promise(resolve => db.close(resolve)); db = undefined;
  await chmod(path, 0o444); await chmod(dir, 0o555);
  try {
    assert.equal((await discoverOpenCodeSessions(path)).length, 2, 'closed WAL database works from a read-only directory');
    assert.equal((await parseOpenCodeRecord(path, 'ses_b', 'closed-db')).metrics.toolCallCount, 1);
  } finally { await chmod(dir, 0o755); await chmod(path, 0o644); }
  console.log(JSON.stringify({ pass: true, sqliteWal: true, readOnly: true, concurrentSessions: true, nativeCallId: true, resume: true,
    pendingAndFailure: true, malformedAndLargeRows: true, sharedFdIsolation: true, pagination: true, runtimeSignature: true }));
} finally {
  if (db) await new Promise(resolve => db.close(resolve));
  for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key]; Object.assign(process.env, prior);
  await rm(dir, { recursive: true, force: true });
}
