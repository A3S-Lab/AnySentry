import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as wait } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const {
  LocalRecordTrackingService,
} = require('../apps/api/dist/security-monitoring/local-record-tracking.service.js');

const previous = {
  enabled: process.env.ANYSENTRY_LOCAL_RECORD_TRACKING,
  root: process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR,
  maxFiles: process.env.ANYSENTRY_LOCAL_RECORD_MAX_FILES,
  processTracking: process.env.ANYSENTRY_LOCAL_PROCESS_TRACKING,
  processRoot: process.env.ANYSENTRY_LOCAL_PROCESS_ROOT,
  hostSessionsRoot: process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_HOST_DIR,
  a3sRoot: process.env.ANYSENTRY_LOCAL_A3S_SESSIONS_DIR,
  claudeRoot: process.env.ANYSENTRY_LOCAL_CLAUDE_SESSIONS_DIR,
  geminiRoot: process.env.ANYSENTRY_LOCAL_GEMINI_SESSIONS_DIR,
  processCacheMs: process.env.ANYSENTRY_LOCAL_PROCESS_CACHE_MS,
  backgroundAttribution: process.env.ANYSENTRY_SESSION_ATTRIBUTION_BACKGROUND,
};

const fixtureRoot = await mkdtemp(join(tmpdir(), 'anysentry-local-records-'));

function linuxProcStat(pid, comm, ppid, startTimeTicks) {
  return `${pid} (${comm}) ${[
    'S',
    String(ppid),
    ...Array.from({ length: 17 }, () => '0'),
    String(startTimeTicks),
  ].join(' ')}\n`;
}

try {
  process.env.ANYSENTRY_LOCAL_RECORD_TRACKING = 'off';
  delete process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR;
  const disabled = await new LocalRecordTrackingService().status();
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.rootAccessible, false);

  const datedDirectory = join(fixtureRoot, '2026', '08', '31');
  await mkdir(datedDirectory, { recursive: true });
  const sessionPath = join(
    datedDirectory,
    'rollout-2026-08-31T10-00-00-fixture.jsonl',
  );
  const records = [
    {
      timestamp: '2026-08-31T02:00:00.000Z',
      type: 'session_meta',
      payload: {
        session_id: 'session-local-fixture',
        id: 'session-local-fixture',
        cwd: '/workspace/demo',
        originator: 'codex-tui',
        cli_version: 'fixture-1.0',
        model_provider: 'openai',
        base_instructions: 'MUST_NOT_APPEAR_IN_API',
      },
    },
    {
      timestamp: '2026-08-31T02:00:01.000Z',
      type: 'turn_context',
      payload: {
        turn_id: 'turn-local-fixture',
        cwd: '/workspace/demo',
        model: 'gpt-fixture',
      },
    },
    {
      timestamp: '2026-08-31T02:00:01.100Z',
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: 'turn-local-fixture',
        started_at: 1788141601,
      },
    },
    {
      timestamp: '2026-08-31T02:00:01.200Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '创建 demo.txt，写入 hello，再读取文件。',
      },
    },
    {
      timestamp: '2026-08-31T02:00:01.300Z',
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: '我会创建并检查这个本地文件。',
        phase: 'commentary',
      },
    },
    {
      timestamp: '2026-08-31T02:00:01.400Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-local-fixture',
        arguments: JSON.stringify({
          cmd: 'printf "hello\\n" > demo.txt && cat demo.txt',
          workdir: '/workspace/demo',
        }),
        internal_chat_message_metadata_passthrough: {
          turn_id: 'turn-local-fixture',
        },
      },
    },
    {
      timestamp: '2026-08-31T02:00:01.500Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-local-fixture',
        output: 'Script completed\nProcess exited with code 0\nOutput:\nhello\n',
        internal_chat_message_metadata_passthrough: {
          turn_id: 'turn-local-fixture',
        },
      },
    },
    {
      timestamp: '2026-08-31T02:00:01.520Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'call-local-fixture-failure',
        input: 'const r = await tools.exec_command({cmd:"/usr/bin/false"}); text(r)',
        internal_chat_message_metadata_passthrough: {
          turn_id: 'turn-local-fixture',
        },
      },
    },
    {
      timestamp: '2026-08-31T02:00:01.540Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call-local-fixture-failure',
        output: [
          {
            type: 'input_text',
            text: 'Script completed\nWall time 0.1 seconds\nOutput:\n',
          },
          {
            type: 'input_text',
            text: '{"exit_code":1,"output":""}',
          },
        ],
        internal_chat_message_metadata_passthrough: {
          turn_id: 'turn-local-fixture',
        },
      },
    },
    {
      timestamp: '2026-08-31T02:00:01.600Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 120,
            cached_input_tokens: 40,
            output_tokens: 25,
            reasoning_output_tokens: 5,
            total_tokens: 145,
          },
          model_context_window: 258400,
        },
      },
    },
    {
      timestamp: '2026-08-31T02:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-local-fixture',
        completed_at: 1788141602,
        duration_ms: 900,
        time_to_first_token_ms: 180,
        last_agent_message: '完成。',
      },
    },
    {
      timestamp: '2026-08-31T02:01:00.000Z',
      type: 'turn_context',
      payload: {
        turn_id: 'turn-local-fixture-2',
        cwd: '/workspace/demo',
        model: 'gpt-fixture',
      },
    },
    {
      timestamp: '2026-08-31T02:01:00.100Z',
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: 'turn-local-fixture-2',
        started_at: 1788141660,
      },
    },
    {
      timestamp: '2026-08-31T02:01:00.200Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '这是后续指令，不能覆盖列表中的会话标题。',
      },
    },
    {
      timestamp: '2026-08-31T02:01:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-local-fixture-2',
        completed_at: 1788141661,
        duration_ms: 800,
        last_agent_message: '已确认。',
      },
    },
  ];
  await writeFile(
    sessionPath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );

  // A single oversized, invalid line verifies that bounded pagination advances instead of
  // repeatedly returning the same offset or loading an arbitrary-size record into memory.
  const giantPath = join(
    datedDirectory,
    'rollout-2026-08-31T11-00-00-giant.jsonl',
  );
  await writeFile(giantPath, Buffer.alloc(25 * 1024 * 1024, 0x78));

  const fakeProcRoot = join(fixtureRoot, 'proc');
  const launcherPid = 4242;
  const runtimePid = 4243;
  const launcherDirectory = join(fakeProcRoot, String(launcherPid));
  const runtimeDirectory = join(fakeProcRoot, String(runtimePid));
  await mkdir(join(runtimeDirectory, 'fd'), { recursive: true });
  await mkdir(launcherDirectory, { recursive: true });
  await writeFile(join(launcherDirectory, 'comm'), 'node\n', 'utf8');
  await writeFile(
    join(launcherDirectory, 'cmdline'),
    `node\u0000/usr/local/bin/codex\u0000resume\u0000`,
    'utf8',
  );
  await writeFile(
    join(launcherDirectory, 'stat'),
    linuxProcStat(launcherPid, 'node', 1, 1000),
    'utf8',
  );
  await writeFile(join(runtimeDirectory, 'comm'), 'codex\n', 'utf8');
  await writeFile(
    join(runtimeDirectory, 'cmdline'),
    `/usr/local/bin/codex\u0000resume\u0000`,
    'utf8',
  );
  await writeFile(
    join(runtimeDirectory, 'stat'),
    linuxProcStat(runtimePid, 'codex', launcherPid, 1001),
    'utf8',
  );
  await symlink(sessionPath, join(runtimeDirectory, 'fd', '7'));
  await mkdir(join(runtimeDirectory, 'fdinfo'), { recursive: true });
  await writeFile(join(runtimeDirectory, 'fdinfo', '7'), 'flags:\t0102001\n');

  process.env.ANYSENTRY_LOCAL_RECORD_TRACKING = 'on';
  process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR = fixtureRoot;
  process.env.ANYSENTRY_LOCAL_A3S_SESSIONS_DIR = join(fixtureRoot, 'missing-a3s');
  process.env.ANYSENTRY_LOCAL_CLAUDE_SESSIONS_DIR = join(fixtureRoot, 'missing-claude');
  process.env.ANYSENTRY_LOCAL_GEMINI_SESSIONS_DIR = join(fixtureRoot, 'missing-gemini');
  process.env.ANYSENTRY_LOCAL_RECORD_MAX_FILES = '20';
  process.env.ANYSENTRY_LOCAL_PROCESS_TRACKING = 'on';
  process.env.ANYSENTRY_LOCAL_PROCESS_ROOT = fakeProcRoot;
  process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_HOST_DIR = fixtureRoot;
  process.env.ANYSENTRY_LOCAL_PROCESS_CACHE_MS = '1';
  const interactionService = {
    status() {
      return {
        enabled: true,
        projection: {
          postgresql: true,
          clickhouse: false,
        },
      };
    },
    async instructionsForRuntimeSession(sessionId) {
      assert.equal(sessionId, 'session-local-fixture');
      return [{
        record: {
          schemaVersion: 'anysentry.interaction-instruction.v1',
          eventType: 'AgentInputObserved',
          interactionId: 'int-observer-ebpf-fixture',
          conversationId: 'conv-observer-ebpf-fixture',
          sourceId: 'fixture-source',
          tenantId: 'fixture-tenant',
          sourceEventId: 'source-observer-ebpf-fixture',
          collectorId: 'fixture-observer',
          observedAt: Date.parse('2026-08-31T02:00:01.250Z'),
          acceptedAt: Date.parse('2026-08-31T02:00:01.260Z'),
          processInstanceId: 'proc-observer-ebpf-fixture',
          turnCorrelation: 'explicit_source_turn',
          process: {
            hostId: 'host-fixture',
            bootId: 'boot-fixture',
            pid: runtimePid,
            tid: runtimePid + 1,
            startTimeTicks: '1001',
            comm: 'codex',
          },
          runtime: {
            runtimeType: 'codex_ebpf_rustls',
            threadId: 'session-local-fixture',
            sessionId: 'session-local-fixture',
            source: 'anysentry_observer_ebpf_rustls',
            modelProvider: 'openai',
          },
          turn: {
            sourceTurnId: 'turn-local-fixture',
          },
          input: {
            protocol: 'responses_api',
            inputScope: 'llm_request_user_message',
            requestPath: '/backend-api/codex/responses',
            transportProtocol: 'websocket',
            providerHost: 'chatgpt.com',
            requestKind: 'responses.create',
            windowId: 'window-local-fixture',
            model: 'gpt-fixture',
          },
          capture: {
            captureMethod: 'ebpf_rustls',
            captureProfile: 'exact_pid_runtime',
            captureMode: 'encrypted_full',
            captureCompleteness: 'complete',
            parseStatus: 'parsed',
            rawRetentionState: 'encrypted',
            presentationState: 'redacted',
          },
          userInstruction: {
            eventType: 'UserInstructionObserved',
            messageRole: 'user',
            contentBytes: 39,
            contentSha256: 'a'.repeat(64),
            contentRef: 'blob-observer-ebpf-fixture',
          },
        },
        contentAvailability: 'available',
        content: '创建 demo.txt，写入 hello，再读取文件。',
      }];
    },
  };
  const service = new LocalRecordTrackingService(interactionService);
  const startedAt = Date.now();
  const list = await service.listRecords({ limit: 20 });
  assert.equal(list.status.rootAccessible, true);
  assert.equal(list.total, 2);
  assert.ok(Date.now() - startedAt < 3_000, 'bounded list read exceeded 3 seconds');

  const fixture = list.items.find(
    (item) => item.sessionId === 'session-local-fixture',
  );
  assert.ok(fixture);
  assert.equal(fixture.title, '创建 demo.txt，写入 hello，再读取文件。');
  assert.equal(fixture.model, 'gpt-fixture');
  assert.equal(fixture.tokenUsage.totalTokens, 145);
  assert.equal(fixture.toolCallCount, 2);
  assert.equal(fixture.processStatus, 'running');
  assert.equal(fixture.processPid, launcherPid);
  assert.equal(fixture.processEvidence, 'proc_fd');
  assert.equal(Number.isInteger(fixture.startedAt), true);
  assert.equal(Number.isInteger(fixture.updatedAt), true);
  assert.equal(
    list.items[0]?.recordId,
    fixture.recordId,
    'running records must be ordered before non-running records',
  );
  assert.equal(list.aggregates.runningProcesses, 1);
  assert.equal(list.aggregates.unknownProcessRecords, 1);

  const exactMatch = {
    pid: launcherPid,
    startTimeTicks: '1000',
    matchedPid: runtimePid,
    matchedStartTimeTicks: '1001',
    recordId: fixture.recordId,
  };
  const identityRecord = {
    processInstanceId: 'runtime-process-fixture',
    agentInstanceId: 'agent-process-fixture',
    process: {
      hostId: 'host-fixture',
      bootId: 'boot-fixture',
      pid: runtimePid,
      startTimeTicks: '1001',
    },
    runtime: { runtimeType: 'codex_ebpf_rustls' },
  };
  const matchingIdentityCandidate = service.sessionProcessBindingCandidate(
    fixture,
    exactMatch,
    identityRecord,
  );
  assert.equal(matchingIdentityCandidate.agentInstanceId, 'agent-process-fixture');
  assert.equal(matchingIdentityCandidate.runtimeProcessInstanceId, 'runtime-process-fixture');
  assert.equal(
    matchingIdentityCandidate.validFrom,
    fixture.startedAt - 5_000,
    'a Session binding must retain a bounded process-startup head for pre-JSONL setup events',
  );
  const exitedIdentityCandidate = service.sessionProcessBindingCandidate(
    { ...fixture, processStatus: 'exited' },
    exactMatch,
    identityRecord,
  );
  assert.equal(
    exitedIdentityCandidate.validTo,
    fixture.updatedAt + 5_000,
    'an exited Session binding must retain a bounded process-drain tail for final kernel events',
  );
  const mismatchedIdentityCandidate = service.sessionProcessBindingCandidate(
    fixture,
    exactMatch,
    {
      ...identityRecord,
      process: { ...identityRecord.process, pid: runtimePid + 100 },
    },
  );
  assert.equal(
    mismatchedIdentityCandidate.agentInstanceId,
    undefined,
    'a different Interaction process must not donate agentInstanceId to an FD binding',
  );
  assert.equal(
    mismatchedIdentityCandidate.runtimeProcessInstanceId,
    undefined,
    'a different Interaction process must not donate runtimeProcessInstanceId to an FD binding',
  );

  const backgroundCalls = { resolve: 0, evidence: 0 };
  const backgroundAttribution = {
    async resolveBinding(candidate) {
      backgroundCalls.resolve += 1;
      assert.equal(candidate.nativeSessionId, 'session-local-fixture');
      return { bindingId: 'binding-fixture' };
    },
    async evidence(binding) {
      backgroundCalls.evidence += 1;
      assert.equal(binding.bindingId, 'binding-fixture');
      await wait(20);
    },
  };
  const backgroundService = new LocalRecordTrackingService(
    interactionService,
    backgroundAttribution,
  );
  const backgroundStartedAt = Date.now();
  await backgroundService.listRecords({ limit: 20 });
  assert.ok(
    Date.now() - backgroundStartedAt < 3_000,
    'active Session attribution must not block the list response',
  );
  await wait(50);
  assert.equal(backgroundCalls.resolve, 1);
  assert.equal(backgroundCalls.evidence, 1);
  await backgroundService.listRecords({ limit: 20 });
  await wait(30);
  assert.equal(backgroundCalls.evidence, 1, 'background attribution must be throttled');

  const secondLauncherPid = 5242;
  const secondRuntimePid = 5243;
  const secondLauncherDirectory = join(fakeProcRoot, String(secondLauncherPid));
  const secondRuntimeDirectory = join(fakeProcRoot, String(secondRuntimePid));
  await mkdir(join(secondRuntimeDirectory, 'fd'), { recursive: true });
  await mkdir(secondLauncherDirectory, { recursive: true });
  await writeFile(join(secondLauncherDirectory, 'comm'), 'node\n', 'utf8');
  await writeFile(
    join(secondLauncherDirectory, 'cmdline'),
    `node\u0000/usr/local/bin/codex\u0000resume\u0000`,
    'utf8',
  );
  await writeFile(
    join(secondLauncherDirectory, 'stat'),
    linuxProcStat(secondLauncherPid, 'node', 1, 2000),
    'utf8',
  );
  await writeFile(join(secondRuntimeDirectory, 'comm'), 'codex\n', 'utf8');
  await writeFile(
    join(secondRuntimeDirectory, 'cmdline'),
    `/usr/local/bin/codex\u0000resume\u0000`,
    'utf8',
  );
  await writeFile(
    join(secondRuntimeDirectory, 'stat'),
    linuxProcStat(secondRuntimePid, 'codex', secondLauncherPid, 2001),
    'utf8',
  );
  await symlink(sessionPath, join(secondRuntimeDirectory, 'fd', '8'));
  await mkdir(join(secondRuntimeDirectory, 'fdinfo'), { recursive: true });
  await writeFile(join(secondRuntimeDirectory, 'fdinfo', '8'), 'flags:\t0102001\n');
  const multiProcessCalls = { resolve: [], evidence: [] };
  const multiProcessService = new LocalRecordTrackingService(
    interactionService,
    {
      async resolveBinding(candidate) {
        multiProcessCalls.resolve.push(candidate.matchedPid);
        return { bindingId: `binding-${candidate.matchedPid}` };
      },
      async evidence(binding) {
        multiProcessCalls.evidence.push(binding.bindingId);
        if (binding.bindingId === `binding-${runtimePid}`) {
          throw new Error('fixture process-family timeout');
        }
      },
    },
  );
  await multiProcessService.listRecords({ limit: 20 });
  await wait(80);
  assert.deepEqual(
    [...multiProcessCalls.resolve].sort((left, right) => left - right),
    [runtimePid, secondRuntimePid],
    'every live process holding one native Session FD must receive its own binding',
  );
  assert.deepEqual(
    [...multiProcessCalls.evidence].sort(),
    [`binding-${runtimePid}`, `binding-${secondRuntimePid}`].sort(),
    'one failed active Session must not prevent later process generations from materializing',
  );
  assert.equal(
    multiProcessService.activeAttributionCheckpoint,
    0,
    'a partial background pass must retain its checkpoint for a safe overlap retry',
  );
  await rm(secondLauncherDirectory, { recursive: true, force: true });
  await rm(secondRuntimeDirectory, { recursive: true, force: true });

  const deferredEvidenceCalls = { resolve: 0, evidence: 0 };
  const deferredEvidenceService = new LocalRecordTrackingService(
    interactionService,
    {
      async resolveBinding() {
        deferredEvidenceCalls.resolve += 1;
        throw new Error('system evidence must not run on the fast detail path');
      },
      async evidence() {
        deferredEvidenceCalls.evidence += 1;
        throw new Error('system evidence must not run on the fast detail path');
      },
    },
  );
  const fastDetail = await deferredEvidenceService.recordDetail(
    fixture.recordId,
    { limit: 100, includeSystemEvidence: false },
  );
  assert.equal(fastDetail.events.length > 0, true);
  assert.deepEqual(
    deferredEvidenceCalls,
    { resolve: 0, evidence: 0 },
    'conversation detail must defer the expensive system-evidence projection',
  );

  const detail = await service.recordDetail(fixture.recordId, { limit: 100 });
  assert.deepEqual(
    detail.events.map((event) => event.kind),
    [
      'turn_start',
      'user_message',
      'assistant_message',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'turn_complete',
      'turn_start',
      'user_message',
      'turn_complete',
    ],
  );
  assert.equal(
    detail.events.find((event) => event.kind === 'tool_call')?.command,
    'printf "hello\\n" > demo.txt && cat demo.txt',
  );
  assert.equal(detail.metrics.toolFailureCount, 1);
  assert.equal(
    detail.events.find((event) => event.callId === 'call-local-fixture-failure')
      ?.status,
    'observed',
  );
  assert.equal(
    detail.events.find(
      (event) =>
        event.kind === 'tool_result'
        && event.callId === 'call-local-fixture-failure',
    )?.status,
    'failure',
  );
  assert.equal(detail.metrics.averageTimeToFirstTokenMs, 180);
  assert.equal(detail.metrics.scope, 'full_record');
  assert.equal(detail.provenance.ebpfIncluded, true);
  assert.equal(detail.provenance.observerRequestEvidence, 'observed');
  assert.equal(detail.provenance.observerSource, 'anysentry_observer');
  assert.equal(detail.provenance.captureMethod, 'local_file_read');
  assert.equal(detail.observedLlmRequests.length, 1);
  assert.equal(
    detail.observedLlmRequests[0]?.content,
    '创建 demo.txt，写入 hello，再读取文件。',
  );
  assert.equal(detail.observedLlmRequests[0]?.capture.method, 'ebpf_rustls');
  assert.equal(detail.observedLlmRequests[0]?.pid, runtimePid);
  const turnWindowBase = 1_800_000_000_000;
  const evidenceTimeWindows = service.systemEvidenceTimeWindows(
    [
      {
        eventId: 'turn-a-start',
        kind: 'turn_start',
        timestamp: turnWindowBase,
        turnId: 'turn-a',
        title: 'Turn start',
        sourceOffset: 1,
      },
      {
        eventId: 'turn-a-complete',
        kind: 'turn_complete',
        timestamp: turnWindowBase + 10_000,
        turnId: 'turn-a',
        title: 'Turn complete',
        sourceOffset: 2,
      },
      {
        eventId: 'turn-b-start',
        kind: 'turn_start',
        timestamp: turnWindowBase + 24 * 60 * 60 * 1_000,
        turnId: 'turn-b',
        title: 'Turn start',
        sourceOffset: 3,
      },
    ],
    [],
    {
      since: turnWindowBase - 10 * 60 * 1_000,
      until: turnWindowBase + 25 * 60 * 60 * 1_000,
    },
  );
  assert.deepEqual(evidenceTimeWindows, [
    {
      sinceMs: turnWindowBase - 5 * 60 * 1_000,
      untilMs: turnWindowBase + 10_000 + 5 * 60 * 1_000,
    },
    {
      sinceMs: turnWindowBase + 24 * 60 * 60 * 1_000 - 5 * 60 * 1_000,
      untilMs: turnWindowBase + 24 * 60 * 60 * 1_000 + 5 * 60 * 1_000,
    },
  ], 'resumed Turns must not make the system-evidence query scan the idle day between them');
  assert.equal(
    JSON.stringify({ list, detail }).includes('MUST_NOT_APPEAR_IN_API'),
    false,
  );

  const giant = list.items.find((item) => item.fileBytes > 24 * 1024 * 1024);
  assert.ok(giant);
  const giantDetail = await service.recordDetail(giant.recordId, { limit: 20 });
  assert.equal(giantDetail.events.length, 0);
  assert.equal(giantDetail.page.hasMore, true);
  assert.ok(
    (giantDetail.page.nextBeforeOffset ?? giantDetail.page.beforeOffset)
      < giantDetail.page.beforeOffset,
    'oversized-line pagination did not make progress',
  );

  await rm(launcherDirectory, { recursive: true, force: true });
  await rm(runtimeDirectory, { recursive: true, force: true });
  await wait(5);
  // Discovery serves stale-while-revalidate: wait for the bounded background scan,
  // rather than assuming its first stale response already reflects process exit.
  let afterExit;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    afterExit = await service.listRecords({ limit: 20 });
    if (afterExit.items.find(item => item.sessionId === 'session-local-fixture')?.processStatus === 'exited') break;
    await wait(10);
  }
  const exitedFixture = afterExit.items.find(
    (item) => item.sessionId === 'session-local-fixture',
  );
  assert.equal(exitedFixture?.processStatus, 'exited');
  assert.equal(exitedFixture?.processPid, launcherPid);
  assert.equal(exitedFixture?.processEvidence, 'observed_exit');

  // A current/resumed generation can be visible through /proc after Observer capture stopped.
  // Failure to resolve that newest generation must not hide relations already materialized for
  // older generations of the same Native Session.
  const historicalFallbackCalls = [];
  const historicalFallbackService = new LocalRecordTrackingService(
    interactionService,
    {
      async resolveBinding() {
        return undefined;
      },
      async historicalEvidenceForNativeSession(input) {
        historicalFallbackCalls.push(input);
        return [{
          schemaVersion: 'anysentry.local-session-system-evidence.v1',
          conversationId: 'conv-historical-fixture',
          evidenceScope: 'historical_persisted',
          binding: {
            bindingId: 'binding-historical-fixture',
            bindingRevision: 3,
            nativeSessionId: 'session-local-fixture',
            matchedOsProcessInstanceKey: 'pri-historical-fixture',
            matchedPid: runtimePid,
            method: 'proc_fd',
            confidence: 1,
          },
          persistence: 'degraded',
          completeness: 'partial',
          counts: { direct: 1, lineage: 0, ambiguous: 0, conflict: 0, unattributed: 0 },
          page: {
            requestedLimit: input.eventLimit,
            totalRelations: 1,
            loadedRelations: 1,
            returnedEvents: 1,
            unavailableEvents: 0,
            totalLineageEdges: 0,
            returnedLineageEdges: 0,
            hasMore: false,
          },
          lineage: [],
          events: [{
            relationId: 'relation-historical-fixture',
            relation: 'DIRECT',
            confidence: 1,
            eventId: 'event-historical-fixture',
            at: Date.parse('2026-08-31T02:00:01.000Z'),
            eventKind: 'ToolExec',
            eventCategory: 'process',
            subject: 'historical command',
            processInstanceKey: 'pri-historical-fixture',
            pid: runtimePid,
            verdict: 'allow',
            tier: 'Rules',
            severity: 'info',
            riskScore: 0,
          }],
          exceptions: [],
          calculatedAt: Date.now(),
        }];
      },
    },
  );
  const historicalFallbackDetail = await historicalFallbackService.recordDetail(
    fixture.recordId,
    { limit: 100, includeSystemEvidence: true },
  );
  assert.equal(historicalFallbackCalls.length, 1);
  assert.equal(historicalFallbackCalls[0]?.nativeSessionId, 'session-local-fixture');
  assert.equal(historicalFallbackDetail.systemEvidence?.evidenceScope, 'historical_persisted');
  assert.equal(historicalFallbackDetail.systemEvidence?.events[0]?.eventId, 'event-historical-fixture');
  assert.equal(historicalFallbackDetail.toolEvidence?.schemaVersion, 'anysentry.local-tool-evidence.v1');
  assert.equal(historicalFallbackDetail.toolEvidence?.nativeSessionId, historicalFallbackDetail.record.sessionId);
  assert.equal(historicalFallbackDetail.toolEvidence?.scope, 'loaded_window');

  // A short-lived Codex process can be gone before the detail endpoint is called, and the API
  // itself may have restarted after capture. The persisted Observer request still carries the
  // native Session id plus an exact process generation, so system-evidence replay must not depend
  // on a live /proc FD or an in-memory sticky binding.
  const restoredCandidates = [];
  const restoredService = new LocalRecordTrackingService(
    interactionService,
    {
      async resolveBinding(candidate) {
        restoredCandidates.push(candidate);
        return {
          bindingId: 'binding-restored-observer-generation',
          conversationId: 'conv-observer-ebpf-fixture',
        };
      },
      async evidence(binding) {
        return {
          schemaVersion: 'anysentry.local-session-system-evidence.v1',
          conversationId: binding.conversationId,
          binding: {
            bindingId: binding.bindingId,
            bindingRevision: 1,
            nativeSessionId: 'session-local-fixture',
            matchedOsProcessInstanceKey: 'pri-restored-fixture',
            matchedPid: runtimePid,
            method: 'proc_fd',
            confidence: 1,
          },
          persistence: 'persisted',
          completeness: 'complete_as_observed',
          counts: {
            direct: 1,
            lineage: 2,
            ambiguous: 0,
            conflict: 0,
            unattributed: 0,
          },
          lineage: [],
          events: [{
            relationId: 'relation-restored-root-exit',
            relation: 'DIRECT',
            confidence: 1,
            eventId: 'event-restored-root-exit',
            at: Date.parse('2026-08-31T02:00:02.500Z'),
            eventKind: 'ProcessExit',
            eventCategory: 'process',
            subject: 'ProcessExit',
            processInstanceKey: 'pri-restored-fixture',
            pid: runtimePid,
            verdict: 'allow',
            tier: 'Rules',
            severity: 'info',
            riskScore: 0,
          }],
          exceptions: [],
          calculatedAt: Date.now(),
        };
      },
    },
  );
  const restoredDetail = await restoredService.recordDetail(
    fixture.recordId,
    { limit: 100 },
  );
  assert.equal(restoredCandidates.length, 1);
  assert.equal(restoredCandidates[0]?.matchedPid, runtimePid);
  assert.equal(restoredCandidates[0]?.matchedStartTime, 'ticks:1001');
  assert.equal(restoredCandidates[0]?.nativeSessionId, 'session-local-fixture');
  assert.equal(restoredCandidates[0]?.method, 'observer_request');
  assert.equal(restoredDetail.systemEvidence?.counts.direct, 1);
  assert.equal(restoredDetail.systemEvidence?.counts.lineage, 2);
  assert.equal(restoredDetail.record.processStatus, 'exited');
  assert.equal(restoredDetail.record.processEvidence, 'observed_exit');
  assert.equal(restoredDetail.record.processPid, runtimePid);

  console.log(JSON.stringify({
    ok: true,
    records: list.total,
    semanticEvents: detail.events.length,
    toolCalls: detail.metrics.toolCallCount,
    tokens: detail.metrics.tokenUsage.totalTokens,
    runningProcessMapped: true,
    observedExitMapped: true,
    giantLinePaginationAdvanced: true,
    backgroundAttributionNonBlocking: true,
    backgroundAttributionThrottled: true,
    processScopedIdentityInheritance: true,
    concurrentSessionProcessesBound: true,
    systemEvidenceDeferredFromFastDetail: true,
    historicalEvidenceSurvivesUnobservedCurrentGeneration: true,
    exitedObserverGenerationRestoredAfterApiRestart: true,
    elapsedMs: Date.now() - startedAt,
  }, null, 2));
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
  if (previous.enabled === undefined) delete process.env.ANYSENTRY_LOCAL_RECORD_TRACKING;
  else process.env.ANYSENTRY_LOCAL_RECORD_TRACKING = previous.enabled;
  if (previous.root === undefined) delete process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR;
  else process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR = previous.root;
  if (previous.maxFiles === undefined) delete process.env.ANYSENTRY_LOCAL_RECORD_MAX_FILES;
  else process.env.ANYSENTRY_LOCAL_RECORD_MAX_FILES = previous.maxFiles;
  if (previous.processTracking === undefined) delete process.env.ANYSENTRY_LOCAL_PROCESS_TRACKING;
  else process.env.ANYSENTRY_LOCAL_PROCESS_TRACKING = previous.processTracking;
  if (previous.processRoot === undefined) delete process.env.ANYSENTRY_LOCAL_PROCESS_ROOT;
  else process.env.ANYSENTRY_LOCAL_PROCESS_ROOT = previous.processRoot;
  if (previous.hostSessionsRoot === undefined) delete process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_HOST_DIR;
  else process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_HOST_DIR = previous.hostSessionsRoot;
  if (previous.a3sRoot === undefined) delete process.env.ANYSENTRY_LOCAL_A3S_SESSIONS_DIR;
  else process.env.ANYSENTRY_LOCAL_A3S_SESSIONS_DIR = previous.a3sRoot;
  if (previous.claudeRoot === undefined) delete process.env.ANYSENTRY_LOCAL_CLAUDE_SESSIONS_DIR;
  else process.env.ANYSENTRY_LOCAL_CLAUDE_SESSIONS_DIR = previous.claudeRoot;
  if (previous.geminiRoot === undefined) delete process.env.ANYSENTRY_LOCAL_GEMINI_SESSIONS_DIR;
  else process.env.ANYSENTRY_LOCAL_GEMINI_SESSIONS_DIR = previous.geminiRoot;
  if (previous.processCacheMs === undefined) delete process.env.ANYSENTRY_LOCAL_PROCESS_CACHE_MS;
  else process.env.ANYSENTRY_LOCAL_PROCESS_CACHE_MS = previous.processCacheMs;
  if (previous.backgroundAttribution === undefined) {
    delete process.env.ANYSENTRY_SESSION_ATTRIBUTION_BACKGROUND;
  } else {
    process.env.ANYSENTRY_SESSION_ATTRIBUTION_BACKGROUND = previous.backgroundAttribution;
  }
}
