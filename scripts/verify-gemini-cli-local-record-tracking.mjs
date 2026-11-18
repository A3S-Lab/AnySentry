import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LocalRecordTrackingService } = require(
  '../apps/api/dist/security-monitoring/local-record-tracking.service.js',
);
const { parseGeminiCliRecord } = require(
  '../apps/api/dist/security-monitoring/local-record-gemini-cli.adapter.js',
);

const keys = [
  'ANYSENTRY_LOCAL_RECORD_TRACKING',
  'ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR',
  'ANYSENTRY_LOCAL_A3S_SESSIONS_DIRS',
  'ANYSENTRY_LOCAL_CLAUDE_SESSIONS_DIR',
  'ANYSENTRY_LOCAL_GEMINI_SESSIONS_DIR',
  'ANYSENTRY_LOCAL_GEMINI_SESSIONS_DIRS',
  'ANYSENTRY_LOCAL_PROCESS_TRACKING',
  'ANYSENTRY_LOCAL_PROCESS_ROOT',
];
const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const fixture = await mkdtemp(join(tmpdir(), 'anysentry-gemini-records-'));
const geminiRoot = join(fixture, 'gemini-tmp');
const chats = join(geminiRoot, '0123456789abcdef', 'chats');
const proc = join(fixture, 'proc');
const sessionId = 'gemini-session-one';
const sessionPath = join(chats, `session-2026-09-09T01-00-${sessionId}.json`);

function procStat(pid, ppid, start) {
  return `${pid} (node) ${['S', String(ppid), ...Array(17).fill('0'), String(start)].join(' ')}\n`;
}

async function writeProcess(pid, path, start) {
  const root = join(proc, String(pid));
  await mkdir(join(root, 'fd'), { recursive: true });
  await mkdir(join(root, 'fdinfo'), { recursive: true });
  await writeFile(join(root, 'comm'), 'node\n');
  await writeFile(
    join(root, 'cmdline'),
    `/usr/bin/node\0/home/test/lib/node_modules/@google/gemini-cli/dist/index.js\0`,
  );
  await writeFile(join(root, 'stat'), procStat(pid, 1, start));
  await symlink(path, join(root, 'fd', '23'));
  await writeFile(join(root, 'fdinfo', '23'), 'flags:\t0102001\n');
}

try {
  await mkdir(chats, { recursive: true });
  await writeFile(join(fixture, 'projects.json'), JSON.stringify({
    projects: { '/workspace/demo': '0123456789abcdef' },
  }));
  await writeFile(sessionPath, JSON.stringify({
    sessionId,
    projectHash: '0123456789abcdef',
    startTime: '2026-09-09T01:00:00.000Z',
    lastUpdated: '2026-09-09T01:00:06.000Z',
    messages: [
      {
        id: 'meta-1', type: 'user', timestamp: '2026-09-09T01:00:00.100Z',
        content: '<session_context>internal bootstrap</session_context>',
      },
      {
        id: 'user-1', type: 'user', timestamp: '2026-09-09T01:00:01.000Z',
        content: '读取项目并运行 Gemini 测试',
      },
      {
        id: 'gemini-1', type: 'gemini', timestamp: '2026-09-09T01:00:04.000Z',
        model: 'gemini-2.5-pro', content: [{ text: '我先执行测试。' }],
        tokens: { input: 20, output: 4, cached: 5, thoughts: 2, total: 26 },
        toolCalls: [{
          id: 'tool-1', name: 'run_shell_command',
          args: { command: 'pnpm test', cwd: '/workspace/demo' },
          result: [{ text: 'tests passed' }], status: 'success',
          timestamp: '2026-09-09T01:00:03.000Z',
        }],
      },
      {
        id: 'user-2', type: 'user', timestamp: '2026-09-09T01:00:05.000Z',
        content: '再检查状态',
      },
      {
        id: 'gemini-2', type: 'gemini', timestamp: '2026-09-09T01:00:06.000Z',
        model: 'gemini-2.5-pro', content: '状态正常。',
        tokens: { input: 6, output: 2, cached: 0, thoughts: 0, total: 8 },
      },
    ],
  }));

  const jsonlSessionId = 'gemini-jsonl-session';
  const jsonlPath = join(chats, `session-2026-09-09T02-00-${jsonlSessionId}.jsonl`);
  const jsonl = [
    { sessionId: jsonlSessionId, projectHash: '0123456789abcdef', startTime: '2026-09-09T02:00:00.000Z' },
    { id: 'jsonl-user', type: 'user', timestamp: '2026-09-09T02:00:01.000Z', content: 'JSONL 第一条指令' },
    { id: 'jsonl-answer', type: 'gemini', timestamp: '2026-09-09T02:00:02.000Z', content: 'JSONL 回复', model: 'gemini-3-flash', tokens: { input: 3, output: 1, total: 4 } },
    { $set: { lastUpdated: '2026-09-09T02:00:02.000Z' } },
  ];
  await writeFile(jsonlPath, `${jsonl.map((line) => JSON.stringify(line)).join('\n')}\n{"id":`);
  const subagentDirectory = join(chats, sessionId);
  await mkdir(subagentDirectory, { recursive: true });
  await writeFile(join(subagentDirectory, 'gemini-subagent-one.jsonl'), [
    { sessionId: 'gemini-subagent-one', projectHash: '0123456789abcdef', startTime: '2026-09-09T03:00:00.000Z', kind: 'subagent' },
    { id: 'sub-user', type: 'user', timestamp: '2026-09-09T03:00:01.000Z', content: '子 Agent 第一条指令' },
    { id: 'sub-answer', type: 'gemini', timestamp: '2026-09-09T03:00:02.000Z', content: '子 Agent 回复' },
  ].map((line) => JSON.stringify(line)).join('\n'));
  await writeProcess(43001, sessionPath, 3001);

  process.env.ANYSENTRY_LOCAL_RECORD_TRACKING = 'on';
  process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR = join(fixture, 'missing-codex');
  process.env.ANYSENTRY_LOCAL_A3S_SESSIONS_DIRS = join(fixture, 'missing-a3s');
  process.env.ANYSENTRY_LOCAL_CLAUDE_SESSIONS_DIR = join(fixture, 'missing-claude');
  process.env.ANYSENTRY_LOCAL_GEMINI_SESSIONS_DIR = geminiRoot;
  delete process.env.ANYSENTRY_LOCAL_GEMINI_SESSIONS_DIRS;
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
  assert.equal(list.status.adapter, 'gemini_cli');
  assert.deepEqual(list.status.adapters, ['gemini_cli']);
  assert.equal(list.total, 3);
  assert.ok(list.items.some((item) =>
    item.sessionId === 'gemini-subagent-one'
    && item.title === '子 Agent 第一条指令'));
  const summary = list.items.find((item) => item.sessionId === sessionId);
  assert.ok(summary);
  assert.equal(summary.adapter, 'gemini_cli');
  assert.equal(summary.title, '读取项目并运行 Gemini 测试');
  assert.equal(summary.model, 'gemini-2.5-pro');
  assert.equal(summary.cwd, '/workspace/demo');
  assert.equal(summary.processPid, 43001);
  assert.equal(summary.processEvidence, 'proc_fd');
  assert.equal(summary.userMessageCount, 2);
  assert.equal(summary.assistantMessageCount, 2);
  assert.equal(summary.toolCallCount, 1);
  assert.deepEqual(summary.tokenUsage, {
    inputTokens: 26,
    cachedInputTokens: 5,
    outputTokens: 6,
    reasoningOutputTokens: 2,
    totalTokens: 34,
  });

  const detail = await service.recordDetail(summary.recordId, {
    limit: 100,
    includeSystemEvidence: true,
  });
  assert.equal(detail.provenance.source, 'gemini_cli_local_session');
  assert.equal(detail.record.originator, 'gemini-cli');
  assert.ok(!detail.events.some((event) => event.content?.includes('session_context')));
  assert.ok(detail.events.some((event) =>
    event.kind === 'tool_call'
    && event.toolName === 'run_shell_command'
    && event.command === 'pnpm test'
    && event.workdir === '/workspace/demo'));
  assert.ok(detail.events.some((event) =>
    event.kind === 'tool_result'
    && event.callId === 'tool-1'
    && event.status === 'success'
    && event.content === 'tests passed'));
  assert.ok(candidates.some((candidate) =>
    candidate.runtimeType === 'gemini_cli'
    && candidate.nativeSessionId === sessionId
    && candidate.matchedPid === 43001
    && candidate.method === 'proc_fd'));

  const parsedJsonl = await parseGeminiCliRecord(jsonlPath, '0123456789abcdef01234567');
  assert.equal(parsedJsonl?.sessionId, jsonlSessionId);
  assert.equal(parsedJsonl?.title, 'JSONL 第一条指令');
  assert.equal(parsedJsonl?.model, 'gemini-3-flash');
  assert.equal(parsedJsonl?.metrics.completeTurnCount, 1);

  process.env.ANYSENTRY_LOCAL_PROCESS_TRACKING = 'off';
  let fileBindingInput;
  const fallbackService = new LocalRecordTrackingService(interactions, {
    resolveBindingFromSessionFile: async (input) => {
      if (input.nativeSessionId === sessionId) fileBindingInput = input;
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
  assert.equal(fileBindingInput?.runtimeType, 'gemini_cli');
  assert.equal(fileBindingInput?.nativeSessionId, sessionId);
  assert.ok(fileBindingInput?.sessionPaths.includes(sessionPath));

  console.log(JSON.stringify({
    ok: true,
    adapter: summary.adapter,
    jsonAndJsonl: true,
    nestedSubagentJsonl: true,
    firstHumanPromptTitle: summary.title,
    internalMessagesExcluded: true,
    toolResultPaired: true,
    processBinding: `${summary.processEvidence}:${summary.processPid}`,
    nodePackageIdentity: true,
    sessionFileEbpfFallback: true,
  }, null, 2));
} finally {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(fixture, { recursive: true, force: true });
}
