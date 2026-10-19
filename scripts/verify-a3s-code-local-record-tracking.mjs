import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LocalRecordTrackingService } = require(
  '../apps/api/dist/security-monitoring/local-record-tracking.service.js',
);

const prior = Object.fromEntries([
  'ANYSENTRY_LOCAL_RECORD_TRACKING',
  'ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR',
  'ANYSENTRY_LOCAL_A3S_SESSIONS_DIR',
  'ANYSENTRY_LOCAL_A3S_SESSIONS_DIRS',
  'ANYSENTRY_LOCAL_CLAUDE_SESSIONS_DIR',
  'ANYSENTRY_LOCAL_GEMINI_SESSIONS_DIR',
  'ANYSENTRY_LOCAL_PROCESS_TRACKING',
  'ANYSENTRY_LOCAL_PROCESS_ROOT',
].map((key) => [key, process.env[key]]));
const fixture = await mkdtemp(join(tmpdir(), 'anysentry-a3s-records-'));
const sessions = join(fixture, 'sessions');
const proc = join(fixture, 'proc');

function procStat(pid, ppid, start) {
  return `${pid} (a3s) ${['S', String(ppid), ...Array(17).fill('0'), String(start)].join(' ')}\n`;
}

async function writeSession(id, prompt, pidSuffix) {
  const file = `${id}.json`;
  const start = 1788429600000 + pidSuffix * 10_000;
  await writeFile(join(sessions, file), JSON.stringify({
    id,
    created_at: new Date(start).toISOString(),
    updated_at: new Date(start + 4_000).toISOString(),
    model_name: 'a3s-test-model',
    config: { workspace: `/workspace/${id}` },
    messages: [],
    total_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }));
  await writeFile(join(sessions, 'runs', file), JSON.stringify([{
    snapshot: {
      id: `run-${id}`,
      session_id: id,
      prompt,
      result_text: `完成 ${id}`,
      status: 'completed',
      created_at_ms: start,
      updated_at_ms: start + 4_000,
    },
    events: [
      { sequence: 1, timestamp_ms: start, event: { type: 'turn_start' } },
      { sequence: 2, timestamp_ms: start + 1_000, event: { type: 'tool_start', id: `call-${id}`, name: 'bash' } },
      { sequence: 3, timestamp_ms: start + 1_100, event: { type: 'tool_input_delta', delta: JSON.stringify({ command: `/usr/bin/printf ${id}`, workdir: `/workspace/${id}` }) } },
      { sequence: 4, timestamp_ms: start + 2_000, event: { type: 'tool_output_delta', delta: id } },
      { sequence: 5, timestamp_ms: start + 2_100, event: { type: 'tool_end', id: `call-${id}`, name: 'bash', exit_code: 0 } },
      { sequence: 6, timestamp_ms: start + 4_000, event: { type: 'turn_end', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ],
  }]));
  return join(sessions, file);
}

async function writeProcess(pid, argv, sessionPath, start) {
  const root = join(proc, String(pid));
  await mkdir(join(root, 'fd'), { recursive: true });
  await writeFile(join(root, 'comm'), 'a3s\n');
  await writeFile(join(root, 'cmdline'), `${argv.join('\0')}\0`);
  await writeFile(join(root, 'stat'), procStat(pid, 1, start));
  await symlink(sessionPath, join(root, 'fd', '17'));
  await mkdir(join(root, 'fdinfo'), { recursive: true });
  await writeFile(join(root, 'fdinfo', '17'), 'flags:\t0102001\n');
}

try {
  await Promise.all([
    mkdir(join(sessions, 'runs'), { recursive: true }),
    mkdir(join(sessions, 'traces'), { recursive: true }),
    mkdir(join(sessions, 'subagent_tasks'), { recursive: true }),
    mkdir(join(sessions, 'verification'), { recursive: true }),
  ]);
  const firstPath = await writeSession('a3s-session-one', '读取项目并运行测试', 1);
  const secondPath = await writeSession('a3s-session-two', '检查依赖但不要修改文件', 2);
  await writeProcess(41001, ['/usr/local/bin/a3s', 'code'], firstPath, 1001);
  await writeProcess(41002, ['/usr/local/bin/a3s', 'code'], secondPath, 1002);
  // This administrative command deliberately holds a Session FD; strict recognition must reject it.
  await writeProcess(41003, ['/usr/local/bin/a3s', 'info'], firstPath, 1003);
  // Tokio renames `comm` while keeping the `a3s` executable; still a coding runtime.
  await writeProcess(41004, ['/usr/local/bin/a3s', 'code', 'exec'], firstPath, 1004);
  // Patch the Tokio worker's comm after writeProcess defaults to "a3s".
  await writeFile(join(proc, '41004', 'comm'), 'tokio-rt-worker\n');

  // v1 nested layout: discovery stores relativePath `v1/sessions/<file>` while the
  // process FD points at the host absolute path. Relative matching must preserve `v1/`.
  const nestedRoot = join(fixture, 'nested-sessions');
  await mkdir(join(nestedRoot, 'v1', 'sessions'), { recursive: true });
  await mkdir(join(nestedRoot, 'runs'), { recursive: true });
  const nestedSessionPath = join(nestedRoot, 'v1', 'sessions', 'id_nested.json');
  await writeFile(nestedSessionPath, JSON.stringify({
    schema_version: 1,
    session: {
      id: 'nested-session-one',
      created_at: new Date(1788429700000).toISOString(),
      updated_at: new Date(1788429704000).toISOString(),
      model_name: 'a3s-nested-model',
      config: { workspace: '/workspace/nested' },
      messages: [{
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: 'nested v1 path binding' }],
        created_at: new Date(1788429700000).toISOString(),
      }],
      total_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  }));
  await writeProcess(41005, ['/usr/local/bin/a3s', 'code'], nestedSessionPath, 1005);

  process.env.ANYSENTRY_LOCAL_RECORD_TRACKING = 'on';
  process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR = join(fixture, 'missing-codex');
  process.env.ANYSENTRY_LOCAL_A3S_SESSIONS_DIRS = `${sessions}${delimiter}${nestedRoot}`;
  delete process.env.ANYSENTRY_LOCAL_A3S_SESSIONS_DIR;
  process.env.ANYSENTRY_LOCAL_CLAUDE_SESSIONS_DIR = join(fixture, 'missing-claude');
  process.env.ANYSENTRY_LOCAL_GEMINI_SESSIONS_DIR = join(fixture, 'missing-gemini');
  process.env.ANYSENTRY_LOCAL_PROCESS_TRACKING = 'on';
  process.env.ANYSENTRY_LOCAL_PROCESS_ROOT = proc;

  const interactions = {
    status: () => ({ enabled: false, projection: { postgresql: false, clickhouse: false } }),
  };
  const bindingCandidates = [];
  const sessionAttribution = {
    resolveBinding: async (candidate) => {
      bindingCandidates.push(candidate);
      return undefined;
    },
    evidence: async () => {
      throw new Error('evidence must not run without a resolved binding');
    },
  };
  const service = new LocalRecordTrackingService(interactions, sessionAttribution);
  const list = await service.listRecords({ limit: 20 });
  assert.equal(list.status.adapter, 'a3s_code');
  assert.deepEqual(list.status.adapters, ['a3s_code']);
  assert.equal(list.total, 3);
  assert.equal(list.aggregates.runningProcesses, 3);

  const first = list.items.find((item) => item.sessionId === 'a3s-session-one');
  const second = list.items.find((item) => item.sessionId === 'a3s-session-two');
  const nested = list.items.find((item) => item.sessionId === 'nested-session-one');
  assert.ok(first && second && nested);
  assert.equal(first.adapter, 'a3s_code');
  assert.equal(first.title, '读取项目并运行测试');
  assert.equal(first.model, 'a3s-test-model');
  assert.ok([41001, 41004].includes(first.processPid));
  assert.equal(second.processPid, 41002);
  assert.equal(nested.processPid, 41005);
  assert.equal(nested.processEvidence, 'proc_fd');
  assert.equal(nested.title, 'nested v1 path binding');
  assert.equal(first.toolCallCount, 1);
  assert.equal(first.tokenUsage.totalTokens, 15);

  const detail = await service.recordDetail(first.recordId, {
    limit: 100,
    includeSystemEvidence: true,
  });
  assert.equal(detail.provenance.source, 'a3s_code_local_session');
  assert.equal(detail.metrics.scope, 'full_record');
  assert.ok(detail.events.some((event) =>
    event.kind === 'user_message'
    && event.phase === 'human_instruction'
    && event.content === '读取项目并运行测试'));
  assert.ok(detail.events.some((event) =>
    event.kind === 'tool_call'
    && event.command === '/usr/bin/printf a3s-session-one'));
  assert.ok(detail.events.some((event) =>
    event.kind === 'assistant_message'
    && event.content === '完成 a3s-session-one'));
  assert.ok(bindingCandidates.some((candidate) =>
    candidate.runtimeType === 'a3s_code'
    && candidate.nativeSessionId === 'a3s-session-one'
    && [41001, 41004].includes(candidate.matchedPid)
    && candidate.method === 'proc_fd'));

  const paged = await service.recordDetail(first.recordId, {
    limit: 2,
    includeSystemEvidence: false,
  });
  assert.equal(paged.events.length, 2);
  assert.equal(paged.page.hasMore, true);
  const older = await service.recordDetail(first.recordId, {
    limit: 100,
    beforeOffset: paged.page.nextBeforeOffset,
    includeSystemEvidence: false,
  });
  assert.ok(older.events.length > 0);
  assert.ok(older.events.every((event) =>
    event.sourceOffset < paged.page.nextBeforeOffset));

  console.log(JSON.stringify({
    ok: true,
    records: list.total,
    runningProcesses: list.aggregates.runningProcesses,
    strictA3sCodeRecognition: true,
    tokioWorkerRecognized: true,
    nestedV1PathBound: nested.processPid === 41005,
    concurrentSessionsIsolated: true,
    attributionCandidateRuntime: 'a3s_code',
    humanPromptSource: 'runs.snapshot.prompt',
    semanticEvents: detail.events.length,
    pagination: true,
  }, null, 2));
} finally {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(fixture, { recursive: true, force: true });
}
