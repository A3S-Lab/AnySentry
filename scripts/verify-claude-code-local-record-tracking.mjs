import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LocalRecordTrackingService } = require(
  '../apps/api/dist/security-monitoring/local-record-tracking.service.js',
);

const keys = [
  'ANYSENTRY_LOCAL_RECORD_TRACKING',
  'ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR',
  'ANYSENTRY_LOCAL_A3S_SESSIONS_DIRS',
  'ANYSENTRY_LOCAL_CLAUDE_SESSIONS_DIR',
  'ANYSENTRY_LOCAL_CLAUDE_SESSIONS_DIRS',
  'ANYSENTRY_LOCAL_GEMINI_SESSIONS_DIR',
  'ANYSENTRY_LOCAL_PROCESS_TRACKING',
  'ANYSENTRY_LOCAL_PROCESS_ROOT',
];
const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const fixture = await mkdtemp(join(tmpdir(), 'anysentry-claude-records-'));
const projects = join(fixture, 'projects');
const project = join(projects, '-workspace-demo');
const proc = join(fixture, 'proc');
const sessionId = 'claude-session-one';
const sessionPath = join(project, `${sessionId}.jsonl`);

function procStat(pid, ppid, start) {
  return `${pid} (claude) ${['S', String(ppid), ...Array(17).fill('0'), String(start)].join(' ')}\n`;
}

async function writeProcess(pid, argv, path, start) {
  const root = join(proc, String(pid));
  await mkdir(join(root, 'fd'), { recursive: true });
  await mkdir(join(root, 'fdinfo'), { recursive: true });
  await writeFile(join(root, 'comm'), 'claude\n');
  await writeFile(join(root, 'cmdline'), `${argv.join('\0')}\0`);
  await writeFile(join(root, 'stat'), procStat(pid, 1, start));
  await symlink(path, join(root, 'fd', '19'));
  await writeFile(join(root, 'fdinfo', '19'), 'flags:\t0102001\n');
}

try {
  await mkdir(project, { recursive: true });
  const lines = [
    { type: 'system', sessionId, cwd: '/workspace/demo', version: '2.1.0', timestamp: '2026-09-09T01:00:00.000Z' },
    { type: 'user', sessionId, promptId: 'p1', isMeta: true, message: { content: '<system-reminder>internal</system-reminder>' }, timestamp: '2026-09-09T01:00:00.100Z' },
    { type: 'user', sessionId, promptId: 'p1', message: { content: '读取项目并运行测试' }, timestamp: '2026-09-09T01:00:01.000Z' },
    { type: 'assistant', sessionId, requestId: 'req-1', message: { id: 'msg-1', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: '我先执行测试。' }], usage: { input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 4 } }, timestamp: '2026-09-09T01:00:02.000Z' },
    { type: 'assistant', sessionId, requestId: 'req-1', message: { id: 'msg-1', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pnpm test', workdir: '/workspace/demo' } }], usage: { input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 4 } }, timestamp: '2026-09-09T01:00:02.100Z' },
    { type: 'user', sessionId, promptId: 'p1', sourceToolAssistantUUID: 'assistant-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: false, content: 'tests passed' }] }, timestamp: '2026-09-09T01:00:03.000Z' },
    { type: 'assistant', sessionId, requestId: 'req-2', message: { id: 'msg-2', model: 'claude-sonnet-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '测试已通过。' }], usage: { input_tokens: 20, cache_creation_input_tokens: 2, output_tokens: 5 } }, timestamp: '2026-09-09T01:00:04.000Z' },
    { type: 'user', sessionId, promptId: 'p2', message: { content: '再检查状态' }, timestamp: '2026-09-09T01:00:05.000Z' },
    { type: 'assistant', sessionId, requestId: 'req-3', message: { id: 'msg-3', model: 'claude-sonnet-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '状态正常。' }], usage: { input_tokens: 6, output_tokens: 2 } }, timestamp: '2026-09-09T01:00:06.000Z' },
  ];
  await writeFile(sessionPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n{\"type\":`);
  await writeProcess(42001, ['/home/test/.local/bin/claude'], sessionPath, 2001);

  process.env.ANYSENTRY_LOCAL_RECORD_TRACKING = 'on';
  process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR = join(fixture, 'missing-codex');
  process.env.ANYSENTRY_LOCAL_A3S_SESSIONS_DIRS = join(fixture, 'missing-a3s');
  process.env.ANYSENTRY_LOCAL_CLAUDE_SESSIONS_DIR = projects;
  delete process.env.ANYSENTRY_LOCAL_CLAUDE_SESSIONS_DIRS;
  process.env.ANYSENTRY_LOCAL_GEMINI_SESSIONS_DIR = join(fixture, 'missing-gemini');
  process.env.ANYSENTRY_LOCAL_PROCESS_TRACKING = 'on';
  process.env.ANYSENTRY_LOCAL_PROCESS_ROOT = proc;

  const interactions = {
    status: () => ({ enabled: false, projection: { postgresql: false, clickhouse: false } }),
  };
  const candidates = [];
  const attribution = {
    resolveBinding: async (candidate) => {
      candidates.push(candidate);
      return undefined;
    },
    evidence: async () => {
      throw new Error('evidence must not run without a binding');
    },
  };
  const service = new LocalRecordTrackingService(interactions, attribution);
  const list = await service.listRecords({ limit: 10 });
  assert.equal(list.status.adapter, 'claude_code');
  assert.deepEqual(list.status.adapters, ['claude_code']);
  assert.equal(list.total, 1);
  const summary = list.items[0];
  assert.equal(summary.adapter, 'claude_code');
  assert.equal(summary.sessionId, sessionId);
  assert.equal(summary.title, '读取项目并运行测试');
  assert.equal(summary.model, 'claude-sonnet-4-5');
  assert.equal(summary.processPid, 42001);
  assert.equal(summary.processEvidence, 'proc_fd');
  assert.equal(summary.userMessageCount, 2);
  assert.equal(summary.assistantMessageCount, 3);
  assert.equal(summary.toolCallCount, 1);
  // req-1 is split across two JSONL records but its usage must be counted once.
  assert.deepEqual(summary.tokenUsage, {
    inputTokens: 36,
    cachedInputTokens: 5,
    outputTokens: 11,
    reasoningOutputTokens: 0,
    totalTokens: 52,
  });

  const detail = await service.recordDetail(summary.recordId, {
    limit: 100,
    includeSystemEvidence: true,
  });
  assert.equal(detail.provenance.source, 'claude_code_local_session');
  assert.equal(detail.record.originator, 'claude-code');
  assert.equal(detail.record.cliVersion, '2.1.0');
  assert.equal(detail.events.filter((event) => event.kind === 'user_message').length, 2);
  assert.ok(!detail.events.some((event) => event.content?.includes('system-reminder')));
  assert.equal(detail.events.filter((event) => event.kind === 'assistant_message').length, 3);
  assert.ok(detail.events.some((event) =>
    event.kind === 'tool_call'
    && event.toolName === 'Bash'
    && event.command === 'pnpm test'
    && event.workdir === '/workspace/demo'));
  assert.ok(detail.events.some((event) =>
    event.kind === 'tool_result'
    && event.callId === 'tool-1'
    && event.status === 'success'
    && event.content === 'tests passed'));
  assert.ok(candidates.some((candidate) =>
    candidate.runtimeType === 'claude_code'
    && candidate.nativeSessionId === sessionId
    && candidate.matchedPid === 42001
    && candidate.method === 'proc_fd'));

  const idleSessionId = 'claude-session-idle';
  const idlePath = join(project, `${idleSessionId}.jsonl`);
  const otherPath = join(project, 'claude-session-other.jsonl');
  await writeFile(idlePath, `${JSON.stringify({
    type: 'user', sessionId: idleSessionId, cwd: '/workspace/demo',
    message: { content: '先打开着' }, timestamp: '2026-09-01T01:00:00.000Z',
  })}\n`);
  await writeFile(otherPath, `${JSON.stringify({
    type: 'user', sessionId: 'claude-session-other', cwd: '/workspace/demo',
    message: { content: '另一条历史会话' }, timestamp: '2026-08-01T01:00:00.000Z',
  })}\n`);
  const idleRoot = join(proc, '42002');
  await mkdir(join(idleRoot, 'fd'), { recursive: true });
  await writeFile(join(idleRoot, 'comm'), 'claude\n');
  await writeFile(join(idleRoot, 'cmdline'), '/usr/bin/claude\0');
  await writeFile(join(idleRoot, 'stat'), procStat(42002, 1, 3002));
  await symlink(`/tmp/claude-test/${idleSessionId}/tasks`, join(idleRoot, 'fd', '7'));
  const liveService = new LocalRecordTrackingService(interactions, attribution);
  const liveList = await liveService.listRecords({ limit: 10 });
  const idle = liveList.items.find((item) => item.sessionId === idleSessionId);
  const other = liveList.items.find((item) => item.sessionId === 'claude-session-other');
  assert.equal(idle?.processStatus, 'running');
  assert.equal(idle?.processEvidence, 'live_agent');
  assert.equal(idle?.processPid, 42002);
  assert.equal(other?.processStatus, 'unknown');

  // If Claude closes the JSONL FD between refreshes, scoped FileAccess evidence is the
  // deterministic fallback. Verify that the exact discovered file paths and runtime family
  // reach the attribution service rather than falling back to cwd/time heuristics.
  process.env.ANYSENTRY_LOCAL_PROCESS_TRACKING = 'off';
  let fileBindingInput;
  const fallbackService = new LocalRecordTrackingService(interactions, {
    resolveBindingFromSessionFile: async (input) => {
      fileBindingInput = input;
      return undefined;
    },
    evidence: async () => {
      throw new Error('evidence must not run without a binding');
    },
  });
  await fallbackService.recordDetail(summary.recordId, {
    limit: 20,
    includeSystemEvidence: true,
  });
  assert.equal(fileBindingInput?.runtimeType, 'claude_code');
  assert.equal(fileBindingInput?.nativeSessionId, sessionId);
  assert.ok(fileBindingInput?.sessionPaths.includes(sessionPath));

  console.log(JSON.stringify({
    ok: true,
    adapter: summary.adapter,
    firstHumanPromptTitle: summary.title,
    splitResponseDeduplicated: true,
    internalMessagesExcluded: true,
    toolResultPaired: true,
    processBinding: `${summary.processEvidence}:${summary.processPid}`,
    sessionFileEbpfFallback: true,
    attributionRuntime: candidates[0]?.runtimeType,
  }, null, 2));
} finally {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(fixture, { recursive: true, force: true });
}
