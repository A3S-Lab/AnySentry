#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  InteractionForwarder,
  contentEvent,
  isAgentInteractionClassification,
  metadataEvent,
  observedAtMillis,
} = require('./observer-interaction-forwarder.js');

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'anysentry-interaction-forwarder-'),
);
let responseMode = 'unavailable';
const received = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(label, fn, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = fn();
    if (last) return last;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

function observerEvent(sequence) {
  return {
    schema_version: 1,
    provider: 'openai-compatible',
    process: {
      host_id: 'fixture-host',
      boot_id: 'fixture-boot',
      pid: 4242,
      pid_namespace: '4026535075',
      namespace_pid: 42,
      namespace_ppid: 1,
      start_time_ticks: '123456789',
      comm: 'node',
      exe: '/usr/bin/node',
      cgroup_id: '987654321',
    },
    observation: {
      observed_at_unix_nanos: String(BigInt(Date.now()) * 1_000_000n),
    },
    event: {
      LlmCall: {
        pid: 4242,
        sni: 'api.openai.com',
        peer: '203.0.113.10:443',
        req_bytes: 400 + sequence,
        resp_bytes: 800 + sequence,
        latency: { secs: 0, nanos: 25_000_000 },
        timing_scope: 'connection',
        capture_mode: 'metadata',
        capture_completeness: 'unavailable',
        parse_status: 'not_attempted',
        raw_retention_state: 'not_retained',
        presentation_state: 'metadata_only',
      },
    },
  };
}

function observerContentEvent(marker) {
  return {
    schema_version: 1,
    provider: 'openai-compatible',
    process: {
      host_id: 'fixture-host',
      boot_id: 'fixture-boot',
      pid: 5252,
      pid_namespace: '4026535076',
      namespace_pid: 52,
      namespace_ppid: 1,
      start_time_ticks: '22334455',
      comm: 'codex',
      exe: '/opt/codex',
      cgroup_id: '112233',
    },
    observation: {
      observed_at_unix_nanos: String(BigInt(Date.now()) * 1_000_000n),
    },
    event: {
      LlmRequestObserved: {
        pid: 5252,
        tid: 5253,
        protocol: 'websocket',
        host: 'chatgpt.com',
        path: '/backend-api/codex/responses',
        endpoint_attribution: 'configured_endpoint',
        provider: 'openai',
        model: 'gpt-fixture',
        session_id: 'session-ebpf-fixture',
        thread_id: 'thread-ebpf-fixture',
        turn_id: 'turn-ebpf-fixture',
        window_id: 'window-ebpf-fixture',
        request_kind: 'responses.create',
        user_instruction: marker,
        capture_profile: 'exact_binary_runtime',
        capture_completeness: 'complete',
      },
    },
  };
}

function hasForbiddenContentKey(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (
      /(?:content|prompt|message|messages|query|instruction|requestbody|responsebody|payload|hmac|contenthash)/iu
        .test(key)
    ) {
      return true;
    }
    if (hasForbiddenContentKey(child)) return true;
  }
  return false;
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push({
      body,
      path: request.url,
      sourceId: request.headers['x-anysentry-source-id'],
      tokenPresent: Boolean(request.headers['x-anysentry-ingest-token']),
    });
    response.setHeader('content-type', 'application/json');
    if (responseMode === 'unavailable') {
      response.statusCode = 503;
      response.end(JSON.stringify({ message: 'fixture unavailable' }));
      return;
    }
    if (responseMode === 'rejected') {
      response.statusCode = 400;
      response.end(JSON.stringify({ message: 'fixture permanent rejection' }));
      return;
    }
    response.statusCode = 202;
    response.end(JSON.stringify({
      data: {
        schemaVersion: 'anysentry.interaction-receipt.v1',
        accepted: true,
        sourceEventId: body.sourceEventId,
        interactionId: `int_${body.sourceEventId}`,
        conversationId: 'conv_fixture',
        contentDisposition:
          body.eventType === 'AgentInputObserved' ? 'encrypted' : 'metadata_only',
        contentStoreDurable: body.eventType === 'AgentInputObserved',
        kafkaDurable: true,
        projectionStatus: 'pending',
        acceptedAt: Date.now(),
      },
    }));
  });
});

async function listen() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function forwarder(spoolPath, writerId = 'fixture-writer') {
  return new InteractionForwarder({
    writerId,
    collectorId: 'fixture-collector',
    sourceId: 'fixture-source',
    sourceToken: 'fixture-source-token',
    ingestTarget: new URL(process.env.ANYSENTRY_INTERACTION_INGEST_URL),
    spoolPath,
  });
}

async function main() {
  const unsafeNumericNanos = 1_787_889_504_964_953_784;
  const unsafeTimestampEvent = {
    observation: { observed_at_unix_nanos: unsafeNumericNanos },
  };
  const expectedUnsafeMillis = Math.trunc(unsafeNumericNanos / 1_000_000);
  assert.equal(observedAtMillis(unsafeTimestampEvent), expectedUnsafeMillis);
  assert.equal(observedAtMillis(unsafeTimestampEvent), expectedUnsafeMillis);
  assert.equal(
    observedAtMillis({
      observation: { observed_at_unix_nanos: '1787889504964953784' },
    }),
    1_787_889_504_964,
  );
  const deterministicLine = JSON.stringify({
    ...observerEvent(0),
    observation: { observed_at_unix_nanos: unsafeNumericNanos },
  });
  const firstMapping = metadataEvent(JSON.parse(deterministicLine), {
    writerId: 'deterministic-writer',
    collectorId: 'fixture-collector',
    line: deterministicLine,
  });
  const replayMapping = metadataEvent(JSON.parse(deterministicLine), {
    writerId: 'deterministic-writer',
    collectorId: 'fixture-collector',
    line: deterministicLine,
  });
  assert.deepEqual(replayMapping, firstMapping);
  console.log('PASS unsafe numeric nanoseconds map to deterministic replay metadata');

  assert.equal(
    isAgentInteractionClassification({
      state: 'agent',
      attribution: { classification: 'confirmed_agent' },
    }),
    true,
  );
  for (const state of ['unknown', 'non_agent', 'infrastructure']) {
    assert.equal(isAgentInteractionClassification({ state }), false);
  }
  const forwarderSource = fs.readFileSync(
    new URL('./observer-forward.js', import.meta.url),
    'utf8',
  );
  assert.match(
    forwarderSource,
    /kind === 'LlmCall' && isAgentInteractionClassification\(classification\)/u,
  );
  console.log('PASS only Agent-attributed LLM calls enter the Interaction lane');

  const port = await listen();
  process.env.ANYSENTRY_INTERACTIONS = 'on';
  process.env.ANYSENTRY_INTERACTION_INGEST_URL =
    `http://127.0.0.1:${port}/security-center/interactions/ingest`;
  process.env.ANYSENTRY_INTERACTION_RETRY_BASE_MS = '50';
  process.env.ANYSENTRY_INTERACTION_RETRY_MAX_MS = '100';
  process.env.ANYSENTRY_INTERACTION_HTTP_TIMEOUT_MS = '500';
  process.env.ANYSENTRY_INTERACTION_SPOOL_FSYNC = 'always';

  const recoverySpool = path.join(temporaryDirectory, 'recovery.wal');
  const first = forwarder(recoverySpool);
  assert.equal(first.observe(observerEvent(1), {
    line: 'fixture-metadata-event-1',
    agentInstanceId: 'fixture-agent',
    workspacePath: '/fixture/workspace',
  }), true);
  await eventually('retry after HTTP 503', () => {
    const status = first.status();
    return status.retried >= 1 && status.records === 1 ? status : undefined;
  });
  first.close();
  assert.equal(hasForbiddenContentKey(received[0].body), false);
  assert.equal(received[0].sourceId, 'fixture-source');
  assert.equal(received[0].tokenPresent, true);
  console.log('PASS transient HTTP failure keeps metadata observation in durable WAL');

  responseMode = 'accepted';
  const recovered = forwarder(recoverySpool);
  await eventually('WAL replay acknowledgement', () => {
    const status = recovered.status();
    return status.acknowledged >= 1 && status.records === 0 ? status : undefined;
  });
  recovered.close();
  console.log('PASS process restart replays WAL and deletes it only after durable receipt');

  const marker = 'ANYSENTRY_OBSERVER_RUSTLS_CONTENT_MUST_NOT_ENTER_WAL_0901';
  const contentLine = JSON.stringify(observerContentEvent(marker));
  const mappedContent = contentEvent(JSON.parse(contentLine), {
    writerId: 'fixture-content-writer',
    collectorId: 'fixture-collector',
    line: contentLine,
  });
  assert.equal(mappedContent.userInstruction.content, marker);
  assert.equal(mappedContent.runtime.runtimeType, 'codex_ebpf_rustls');
  assert.equal(mappedContent.runtime.sessionId, 'session-ebpf-fixture');
  assert.equal(mappedContent.process.pid, 5252);
  assert.equal(mappedContent.process.tid, 5253);
  assert.equal(mappedContent.process.pidNamespace, '4026535076');
  assert.equal(mappedContent.process.namespacePid, 52);
  assert.equal(mappedContent.process.namespacePpid, 1);
  const { validateInteractionInstructionIngest, validateInteractionMetadataIngest } =
    await import('../apps/api/dist/security-monitoring/interaction.types.js');
  assert.equal(validateInteractionInstructionIngest(mappedContent).metadata.process.pidNamespace, '4026535076');
  assert.equal(validateInteractionInstructionIngest(mappedContent).metadata.process.namespacePid, 52);
  const nsMetadata = metadataEvent(observerEvent(1), {
    writerId: 'namespace-test', collectorId: 'fixture-collector', line: 'namespace-test',
  });
  assert.equal(nsMetadata.process.pidNamespace, '4026535075');
  assert.equal(validateInteractionMetadataIngest(nsMetadata).process.namespacePid, 42);
  const mismatchedPidEvent = observerContentEvent(marker);
  mismatchedPidEvent.process.pid = 9000;
  assert.equal(contentEvent(mismatchedPidEvent, {
    writerId: 'namespace-test', collectorId: 'fixture-collector', line: 'mismatched-pid',
  }).process.pidNamespace, undefined, 'a different PID must not donate namespace identity');
  assert.equal(mappedContent.input.transportProtocol, 'websocket');
  assert.equal(mappedContent.input.endpointAttribution, 'configured_endpoint');
  assert.equal(mappedContent.capture.captureMethod, 'ebpf_rustls');
  assert.equal(mappedContent.capture.captureProfile, 'exact_binary_runtime');

  const a3sContentLine = JSON.stringify({
    ...JSON.parse(contentLine),
    process: {
      ...(JSON.parse(contentLine).process || {}),
      comm: 'a3s',
      exe: '/home/zhongyule/.local/bin/a3s',
    },
    event: {
      ...JSON.parse(contentLine).event,
      LlmRequestObserved: {
        ...JSON.parse(contentLine).event.LlmRequestObserved,
        capture_method: 'ebpf_openssl',
      },
    },
  });
  const mappedA3s = contentEvent(JSON.parse(a3sContentLine), {
    writerId: 'fixture-content-writer',
    collectorId: 'fixture-collector',
    line: a3sContentLine,
  });
  assert.equal(mappedA3s.runtime.runtimeType, 'a3s_code_ebpf_tls');
  assert.equal(mappedA3s.runtime.source, 'anysentry_observer_ebpf_a3s_tls');
  assert.equal(mappedA3s.capture.captureMethod, 'ebpf_openssl');
  console.log('PASS A3S OpenSSL content maps to a3s_code_ebpf_tls');

  const claudeContentLine = JSON.stringify({
    ...JSON.parse(contentLine),
    process: {
      ...(JSON.parse(contentLine).process || {}),
      comm: 'HTTP Client',
      exe: '/home/user/.nvm/versions/node/v22/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
    },
    event: {
      ...JSON.parse(contentLine).event,
      LlmRequestObserved: {
        ...JSON.parse(contentLine).event.LlmRequestObserved,
        provider: 'anthropic',
        host: 'api.anthropic.com',
        path: '/v1/messages',
        capture_method: 'ebpf_boringssl',
      },
    },
  });
  const mappedClaude = contentEvent(JSON.parse(claudeContentLine), {
    writerId: 'fixture-content-writer',
    collectorId: 'fixture-collector',
    line: claudeContentLine,
  });
  assert.equal(mappedClaude.runtime.runtimeType, 'claude_code_ebpf_tls');
  assert.equal(mappedClaude.runtime.source, 'anysentry_observer_ebpf_claude_boringssl');
  assert.equal(mappedClaude.input.protocol, 'messages_api');
  assert.equal(mappedClaude.capture.captureMethod, 'ebpf_boringssl');
  console.log('PASS Claude BoringSSL content maps to claude_code_ebpf_tls');

  const geminiContentLine = JSON.stringify({
    ...JSON.parse(contentLine),
    process: {
      ...(JSON.parse(contentLine).process || {}),
      comm: 'node',
      exe: '/usr/bin/node',
    },
    event: {
      ...JSON.parse(contentLine).event,
      LlmRequestObserved: {
        ...JSON.parse(contentLine).event.LlmRequestObserved,
        provider: 'gemini',
        host: 'generativelanguage.googleapis.com',
        path: '/v1beta/models/gemini-2.5-pro:streamGenerateContent',
        capture_method: 'ebpf_openssl',
      },
    },
  });
  const mappedGemini = contentEvent(JSON.parse(geminiContentLine), {
    writerId: 'fixture-content-writer',
    collectorId: 'fixture-collector',
    line: geminiContentLine,
    agentDisplayName: 'Gemini CLI',
  });
  assert.equal(mappedGemini.runtime.runtimeType, 'gemini_cli_ebpf_openssl');
  assert.equal(mappedGemini.runtime.source, 'anysentry_observer_ebpf_gemini_openssl');
  assert.equal(mappedGemini.input.protocol, 'generate_content_api');
  assert.equal(mappedGemini.capture.captureMethod, 'ebpf_openssl');
  console.log('PASS exact Gemini CLI attribution maps OpenSSL content to Gemini runtime');

  responseMode = 'unavailable';
  const contentSpool = path.join(temporaryDirectory, 'content-recovery.wal');
  const contentFirst = forwarder(contentSpool, 'fixture-content-writer');
  assert.equal(contentFirst.observe(observerContentEvent(marker), {
    line: contentLine,
    agentInstanceId: 'fixture-codex-agent',
    workspacePath: '/fixture/workspace',
  }), true);
  await eventually('encrypted content retry after HTTP 503', () => {
    const status = contentFirst.status();
    return status.retried >= 1 && status.records === 1 ? status : undefined;
  });
  const contentFirstStatus = contentFirst.status();
  contentFirst.close();
  const sealedWal = fs.readFileSync(contentFirstStatus.filePath, 'utf8');
  assert.equal(sealedWal.includes(marker), false);
  assert.equal(sealedWal.includes('"userInstruction"'), false);
  assert.equal(sealedWal.includes('anysentry.interaction-spool-sealed.v1'), true);
  console.log('PASS Observer plaintext content is AES-GCM sealed before durable WAL storage');

  responseMode = 'accepted';
  const contentRecovered = forwarder(contentSpool, 'fixture-content-writer');
  await eventually('encrypted content WAL replay acknowledgement', () => {
    const status = contentRecovered.status();
    return status.acknowledged >= 1 && status.records === 0 ? status : undefined;
  });
  contentRecovered.close();
  const acceptedContent = received.find(
    ({ body, path: requestPath }) =>
      body.userInstruction?.content === marker
      && requestPath === '/security-center/interactions/ingest-content',
  );
  assert.ok(acceptedContent);
  assert.equal(acceptedContent.body.runtime.source, 'anysentry_observer_ebpf_rustls');
  assert.equal(acceptedContent.sourceId, 'fixture-source');
  assert.equal(acceptedContent.tokenPresent, true);
  console.log('PASS restart decrypts and posts content only to AnySentry encrypted Interaction ingress');

  responseMode = 'unavailable';
  const forcedCloseSpool = path.join(temporaryDirectory, 'forced-close.wal');
  const forcedClose = forwarder(forcedCloseSpool, 'fixture-forced-close-writer');
  assert.equal(forcedClose.observe(observerContentEvent(`${marker}_FORCED_CLOSE`), {
    line: `${contentLine}-forced-close`,
    agentInstanceId: 'fixture-codex-agent',
    workspacePath: '/fixture/workspace',
  }), true);
  assert.equal(forcedClose.beginDrain(), true);
  const forcedCloseWalPath = forcedClose.status().filePath;
  forcedClose.close();
  await sleep(50);
  const forcedCloseWal = fs.readFileSync(forcedCloseWalPath, 'utf8');
  assert.equal(forcedCloseWal.includes(`${marker}_FORCED_CLOSE`), false);
  assert.equal(forcedCloseWal.includes('anysentry.interaction-spool-sealed.v1'), true);
  responseMode = 'accepted';
  const forcedCloseRecovered =
    forwarder(forcedCloseSpool, 'fixture-forced-close-writer');
  await eventually('forced-close WAL replay acknowledgement', () => {
    const status = forcedCloseRecovered.status();
    return status.acknowledged >= 1 && status.records === 0 ? status : undefined;
  });
  assert.equal(forcedCloseRecovered.hasPendingWork(), false);
  forcedCloseRecovered.close();
  console.log('PASS forced close preserves unacknowledged encrypted content for replay');

  responseMode = 'rejected';
  const rejectionSpool = path.join(temporaryDirectory, 'rejection.wal');
  const rejected = forwarder(rejectionSpool, 'fixture-rejection-writer');
  assert.equal(rejected.observe(observerEvent(2), {
    line: 'fixture-metadata-event-2',
    agentInstanceId: 'fixture-agent',
    workspacePath: '/fixture/workspace',
  }), true);
  await eventually('permanent rejection DLQ', () => {
    const status = rejected.status();
    return status.rejected >= 1 && status.records === 0 ? status : undefined;
  });
  const rejectedStatus = rejected.status();
  rejected.close();
  assert.equal(rejectedStatus.deadLetterRecords, 1);
  assert.equal(fs.existsSync(`${rejectedStatus.filePath}.dlq`), true);
  console.log('PASS permanent 4xx moves the observation to a durable DLQ');

  responseMode = 'unavailable';
  process.env.ANYSENTRY_INTERACTION_SPOOL_FSYNC = 'periodic';
  process.env.ANYSENTRY_INTERACTION_SPOOL_MAX_RECORDS = '1000';
  const capacitySpool = path.join(temporaryDirectory, 'capacity.wal');
  const capacity = forwarder(capacitySpool, 'fixture-capacity-writer');
  for (let index = 0; index < 1001; index += 1) {
    capacity.observe(observerEvent(10 + index), {
      line: `fixture-capacity-event-${index}`,
      agentInstanceId: 'fixture-agent',
      workspacePath: '/fixture/workspace',
    });
  }
  await eventually('bounded spool capacity ledger', () => {
    const status = capacity.status();
    return status.records === 1000 && status.lostAtCapacity === 1 ? status : undefined;
  });
  const capacityStatus = capacity.status();
  capacity.close();
  assert.equal(capacityStatus.atCapacity, true);
  const lossLedger = fs.readFileSync(`${capacityStatus.filePath}.loss.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(lossLedger.length, 1);
  assert.equal(lossLedger[0].reason, 'interaction_spool_capacity');
  assert.equal(hasForbiddenContentKey(lossLedger[0]), false);
  console.log('PASS bounded capacity records an explicit metadata-only Loss Ledger entry');

  assert.equal(
    received
      .filter(({ body }) => body.eventType === 'LlmTransportObserved')
      .some(({ body }) => hasForbiddenContentKey(body)),
    false,
  );
  console.log('PASS metadata lane never emits content-bearing fields');
}

main()
  .finally(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
