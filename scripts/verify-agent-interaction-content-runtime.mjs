#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const configuredBase = (
  process.env.ANYSENTRY_API_BASE
  ?? process.env.API_BASE
)?.trim();
if (!configuredBase) {
  throw new Error('ANYSENTRY_API_BASE is required');
}
const baseUrl = configuredBase.replace(/\/$/u, '');
if (
  new URL(baseUrl).port === '29653'
  && process.env.ANYSENTRY_ALLOW_PRODUCTION_INTERACTION_CONTENT_VERIFY
    !== 'I_UNDERSTAND_THIS_WRITES_ENCRYPTED_TEST_CONTENT'
) {
  throw new Error('refusing to write encrypted fixture content to port 29653 without confirmation');
}
const rawViewToken = (process.env.ANYSENTRY_INTERACTION_RAW_VIEW_TOKEN ?? '').trim();
if (!rawViewToken) throw new Error('ANYSENTRY_INTERACTION_RAW_VIEW_TOKEN is required');
if (Object.keys(managementAuthHeaders()).length === 0) {
  throw new Error('ANYSENTRY_ADMIN_TOKEN or ANYSENTRY_MANAGEMENT_TOKEN is required');
}

const runId = safeProbeId('interaction-content');
const collectorId = `${runId}-collector`;
const workspacePath = `/tmp/${runId}`;
const keptContent = `AnySentry 受控正文验证 ${runId}：只返回 OK。`;
const deletedContent = `AnySentry 删除验证 ${runId}：此正文必须被清除。`;

function pass(message) {
  console.log(`PASS ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestRaw(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = raw;
  }
  return {
    status: response.status,
    data: parsed?.data ?? parsed,
    raw,
  };
}

async function request(path, method = 'GET', body, headers = {}) {
  const result = await requestRaw(path, method, body, headers);
  assert.ok(
    result.status >= 200 && result.status < 300,
    `${method} ${path} -> ${result.status}: ${result.raw}`,
  );
  return result.data;
}

async function eventually(label, fn, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

function contentEnvelope(sourceEventId, content, observedAt) {
  const encoded = Buffer.from(content);
  return {
    schemaVersion: 'anysentry.interaction-instruction.v1',
    eventType: 'AgentInputObserved',
    sourceEventId,
    collectorId,
    observedAt,
    agentInstanceId: `${runId}-codex`,
    workspacePath,
    process: {
      hostId: `${runId}-host`,
      bootId: `${runId}-boot`,
      pid: 4242,
      startTimeTicks: '1000',
      comm: 'codex',
      exe: '/fixture/codex',
    },
    input: {
      protocol: 'native_stdio',
      inputScope: 'agent_process_stdin',
      fd: 0,
    },
    capture: {
      captureMethod: 'ebpf_stdin',
      captureProfile: 'isolated_fixture',
      captureMode: 'encrypted_full',
      captureCompleteness: 'complete',
      parseStatus: 'boundary_observed',
      rawRetentionState: 'encrypted',
      presentationState: 'redacted',
    },
    userInstruction: {
      eventType: 'UserInstructionObserved',
      messageRole: 'user',
      content,
      contentBytes: encoded.byteLength,
      contentSha256: createHash('sha256').update(encoded).digest('hex'),
    },
  };
}

function rawHeaders(reason = `验证 ${runId} 的受控正文访问审计`) {
  return {
    ...managementAuthHeaders(),
    'x-anysentry-raw-view-token': rawViewToken,
    'x-anysentry-raw-view-reason': encodeURIComponent(reason),
    'x-anysentry-actor-id': 'interaction-content-runtime-verifier',
  };
}

async function main() {
  const status = await request(
    '/interactions/status',
    'GET',
    undefined,
    managementAuthHeaders(),
  );
  assert.equal(status.enabled, true);
  assert.equal(status.ready, true);
  assert.equal(status.contentCaptureAllowed, true);
  assert.equal(status.contentCaptureMode, 'isolated_fixture_encrypted');
  assert.equal(status.contentStore.encryptionReady, true);
  assert.equal(status.rawViewEnabled, true);
  assert.equal(status.contentDurableBoundary, 'content_store_finalize+kafka_ack');
  if (status.directViewEnabled) {
    assert.equal(status.rawViewAuthentication, 'unsafe_local_direct_view');
    pass('isolated encrypted content lane and explicit local direct-view mode are ready');
  } else {
    assert.equal(status.rawViewAuthentication, 'management_plus_raw_capability');
    pass('isolated encrypted content lane and two-token Raw View Gate are ready');
  }

  const created = await request('/sources', 'POST', {
    name: `${runId} source`,
    type: 'forwarder',
    enabled: true,
    requireToken: true,
    collectorId,
    workspacePath,
    owner: 'interaction-content-runtime-verifier',
    tags: [runId, 'encrypted-content-fixture'],
    correlationClaims: {
      enabled: true,
      authority: 'observer_runtime',
      bindings: {
        collectorIds: [collectorId],
        workspacePaths: [workspacePath],
      },
    },
  }, managementAuthHeaders());
  const sourceId = created.source?.sourceId;
  const sourceToken = created.token;
  assert.ok(sourceId && sourceToken);
  const sourceHeaders = {
    'x-anysentry-source-id': sourceId,
    'x-anysentry-ingest-token': sourceToken,
  };
  pass('protected scoped Source created');

  const firstEnvelope = contentEnvelope(`${runId}-keep`, keptContent, Date.now());
  const first = await request(
    '/interactions/ingest-content',
    'POST',
    firstEnvelope,
    sourceHeaders,
  );
  assert.equal(first.accepted, true);
  assert.equal(first.contentDisposition, 'encrypted');
  assert.equal(first.contentStoreDurable, true);
  assert.equal(first.kafkaDurable, true);
  assert.ok(first.contentRef);
  const replay = await request(
    '/interactions/ingest-content',
    'POST',
    firstEnvelope,
    sourceHeaders,
  );
  assert.deepEqual(replay, first);
  pass('ContentStore finalize + Kafka ack receipt is stable across replay');

  const projected = await eventually('encrypted instruction projection', async () => {
    const detail = await request(
      `/conversations/${encodeURIComponent(first.conversationId)}`,
      'GET',
      undefined,
      managementAuthHeaders(),
    );
    return detail.observations?.find(
      (item) => item.interactionId === first.interactionId,
    )
      ? detail
      : undefined;
  });
  assert.equal(projected.conversation.contentAvailable, true);
  assert.equal(projected.contentCapture, 'encrypted_available');
  assert.equal(projected.observations.length, 1);
  assert.equal(projected.observations[0].eventType, 'AgentInputObserved');
  assert.equal(projected.observations[0].contentAvailability, 'available');
  assert.equal(JSON.stringify(projected).includes(keptContent), false);
  pass('ordinary list/detail projections expose contentRef and hash but never plaintext');

  if (status.directViewEnabled) {
    const anonymousStatus = await request('/interactions/status');
    assert.equal(anonymousStatus.directViewEnabled, true);
    const anonymousDetail = await request(
      `/conversations/${encodeURIComponent(first.conversationId)}`,
    );
    assert.equal(
      JSON.stringify(anonymousDetail).includes(keptContent),
      false,
    );
    pass('local direct-view list and detail need no credential but still exclude plaintext');
  } else {
    const noManagement = await requestRaw(
      `/interactions/${encodeURIComponent(first.interactionId)}/content`,
      'GET',
      undefined,
      {
        'x-anysentry-raw-view-token': rawViewToken,
        'x-anysentry-raw-view-reason': encodeURIComponent(
          `验证 ${runId} 缺少管理凭据`,
        ),
      },
    );
    assert.equal(noManagement.status, 401);
    const noRawCapability = await requestRaw(
      `/interactions/${encodeURIComponent(first.interactionId)}/content`,
      'GET',
      undefined,
      {
        ...managementAuthHeaders(),
        'x-anysentry-raw-view-reason': encodeURIComponent(
          `验证 ${runId} 缺少独立正文凭据`,
        ),
      },
    );
    assert.equal(noRawCapability.status, 403);
    const noReason = await requestRaw(
      `/interactions/${encodeURIComponent(first.interactionId)}/content`,
      'GET',
      undefined,
      {
        ...managementAuthHeaders(),
        'x-anysentry-raw-view-token': rawViewToken,
      },
    );
    assert.equal(noReason.status, 400);
    pass('management token, independent Raw View token, and reason are all mandatory');
  }

  const raw = await request(
    `/interactions/${encodeURIComponent(first.interactionId)}/content`,
    'GET',
    undefined,
    status.directViewEnabled ? {} : rawHeaders(),
  );
  assert.equal(raw.content, keptContent);
  assert.equal(raw.contentSha256, firstEnvelope.userInstruction.contentSha256);
  assert.equal(raw.presentationState, 'raw_authorized');
  pass(
    status.directViewEnabled
      ? 'credential-free local read returns exact plaintext with integrity metadata'
      : 'authorized on-demand read returns exact plaintext with integrity metadata',
  );

  const viewAudit = await eventually('raw-view audit', async () => {
    const list = await request('/audit/list', 'POST', {
      timeType: 'last_3h',
      resourceType: 'interaction',
      resourceId: first.interactionId,
      limit: 20,
    }, managementAuthHeaders());
    return list.items?.find((item) => item.action === 'interaction.content.viewed');
  });
  assert.equal(JSON.stringify(viewAudit).includes(keptContent), false);
  pass('Raw View is audited without recording plaintext');

  const deletedEnvelope = contentEnvelope(
    `${runId}-delete`,
    deletedContent,
    Date.now() + 1,
  );
  const deletable = await request(
    '/interactions/ingest-content',
    'POST',
    deletedEnvelope,
    sourceHeaders,
  );
  await eventually('deletable instruction projection', async () => {
    const detail = await request(
      `/conversations/${encodeURIComponent(deletable.conversationId)}`,
      'GET',
      undefined,
      managementAuthHeaders(),
    );
    return detail.observations?.some(
      (item) => item.interactionId === deletable.interactionId,
    );
  });
  const deletion = await request(
    `/interactions/${encodeURIComponent(deletable.interactionId)}/content`,
    'DELETE',
    undefined,
    rawHeaders(`删除 ${runId} 的受控测试正文并验证密文清除`),
  );
  assert.equal(deletion.deleted, true);
  const afterDelete = await requestRaw(
    `/interactions/${encodeURIComponent(deletable.interactionId)}/content`,
    'GET',
    undefined,
    rawHeaders(`确认 ${runId} 的受控测试正文已删除`),
  );
  assert.equal(afterDelete.status, 404);
  const deletedDetail = await request(
    `/conversations/${encodeURIComponent(deletable.conversationId)}`,
    'GET',
    undefined,
    managementAuthHeaders(),
  );
  const deletedObservation = deletedDetail.observations.find(
    (item) => item.interactionId === deletable.interactionId,
  );
  assert.equal(deletedObservation.contentAvailability, 'deleted');
  assert.equal(JSON.stringify(deletedDetail).includes(deletedContent), false);
  pass('deletion erases ciphertext while retaining a deleted metadata/audit tombstone');

  console.log(JSON.stringify({
    ok: true,
    runId,
    sourceId,
    interactionId: first.interactionId,
    conversationId: first.conversationId,
    contentRef: first.contentRef,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
