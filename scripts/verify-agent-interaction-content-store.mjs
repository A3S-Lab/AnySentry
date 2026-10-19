#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ANYSENTRY_ADMIN_TOKEN = 'verify-content-admin-token';
process.env.ANYSENTRY_INTERACTION_CONTENTS = 'on';
process.env.ANYSENTRY_INTERACTION_CONTENT_CAPTURE_MODE = 'isolated_fixture';
process.env.ANYSENTRY_INTERACTION_CONTENT_KEY_TENANT = 'tenant_default';
process.env.ANYSENTRY_INTERACTION_CONTENT_KEY_VERSION = 'verify-v1';
process.env.ANYSENTRY_INTERACTION_CONTENT_KEY = Buffer.alloc(32, 0x5a).toString('base64');
process.env.ANYSENTRY_INTERACTION_RAW_VIEW = 'on';
process.env.ANYSENTRY_INTERACTION_RAW_VIEW_TOKEN = 'verify-content-raw-token';
process.env.ANYSENTRY_INTERACTION_CONTENT_ORPHAN_TTL_MS = '60000';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { InteractionContentStore } = require(path.join(
  root,
  'apps/api/dist/security-monitoring/interaction-content.store.js',
));
const {
  interactionContentRef,
  interactionInstructionRecord,
  validateInteractionInstructionIngest,
} = require(path.join(
  root,
  'apps/api/dist/security-monitoring/interaction.types.js',
));

const sentinel =
  '检查 <script>alert("never render as HTML")</script>\\n并列出当前仓库的风险。';
const encoded = Buffer.from(sentinel);
const source = { sourceId: 'verify-content-source', tenantId: 'tenant_default' };
const envelope = {
  schemaVersion: 'anysentry.interaction-instruction.v1',
  eventType: 'AgentInputObserved',
  sourceEventId: 'verify-content-event-1',
  collectorId: 'verify-content-collector',
  observedAt: 1787900000000,
  agentInstanceId: 'verify-content-agent',
  workspacePath: '/tmp/verify-content-workspace',
  process: {
    hostId: 'verify-content-host',
    bootId: 'verify-content-boot',
    pid: 4242,
    startTimeTicks: '998877',
    comm: 'codex',
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
    content: sentinel,
    contentBytes: encoded.byteLength,
    contentSha256: createHash('sha256').update(encoded).digest('hex'),
  },
};
const rustlsSentinel =
  '先运行 /usr/bin/uname -a，然后只回复 ANYSENTRY_RUSTLS_VALIDATION_0901。';
const rustlsEncoded = Buffer.from(rustlsSentinel);
const rustlsEnvelope = {
  schemaVersion: 'anysentry.interaction-instruction.v1',
  eventType: 'AgentInputObserved',
  sourceEventId: 'verify-rustls-event-1',
  collectorId: 'verify-content-collector',
  observedAt: 1787900000200,
  agentInstanceId: 'verify-content-agent',
  workspacePath: '/tmp/verify-content-workspace',
  turn: { sourceTurnId: 'verify-rustls-turn-1' },
  process: {
    hostId: 'verify-content-host',
    bootId: 'verify-content-boot',
    pid: 5252,
    tid: 5253,
    startTimeTicks: '998878',
    comm: 'codex',
    exe: '/opt/codex',
  },
  runtime: {
    runtimeType: 'codex_ebpf_rustls',
    threadId: 'verify-rustls-thread-1',
    sessionId: 'verify-rustls-session-1',
    source: 'anysentry_observer_ebpf_rustls',
    modelProvider: 'openai',
  },
  input: {
    protocol: 'responses_api',
    inputScope: 'llm_request_user_message',
    requestPath: '/backend-api/codex/responses',
    transportProtocol: 'websocket',
    providerHost: 'chatgpt.com',
    endpointAttribution: 'configured_endpoint',
    requestKind: 'responses.create',
    windowId: 'verify-rustls-window-1',
    model: 'gpt-fixture',
  },
  capture: {
    captureMethod: 'ebpf_rustls',
    captureProfile: 'exact_binary_runtime',
    captureMode: 'encrypted_full',
    captureCompleteness: 'complete',
    parseStatus: 'parsed',
    rawRetentionState: 'encrypted',
    presentationState: 'redacted',
  },
  userInstruction: {
    eventType: 'UserInstructionObserved',
    messageRole: 'user',
    content: rustlsSentinel,
    contentBytes: rustlsEncoded.byteLength,
    contentSha256: createHash('sha256').update(rustlsEncoded).digest('hex'),
  },
};
const claudeSentinel =
  '只回复 ANYSENTRY_CLAUDE_BORINGSSL_VALIDATION_0909。';
const claudeEncoded = Buffer.from(claudeSentinel);
const claudeEnvelope = {
  ...rustlsEnvelope,
  sourceEventId: 'verify-claude-boringssl-event-1',
  observedAt: 1787900000300,
  turn: { sourceTurnId: 'verify-claude-turn-1' },
  process: {
    ...rustlsEnvelope.process,
    pid: 6262,
    tid: 6263,
    startTimeTicks: '998879',
    comm: 'HTTP Client',
    exe: '/opt/claude-code/claude.exe',
  },
  runtime: {
    runtimeType: 'claude_code_ebpf_tls',
    threadId: 'verify-claude-thread-1',
    sessionId: 'verify-claude-session-1',
    source: 'anysentry_observer_ebpf_claude_boringssl',
    modelProvider: 'anthropic',
  },
  input: {
    ...rustlsEnvelope.input,
    protocol: 'messages_api',
    requestPath: '/v1/messages',
    transportProtocol: 'http1',
    providerHost: 'api.anthropic.com',
    requestKind: 'messages.create',
    windowId: 'verify-claude-window-1',
    model: 'claude-fixture',
  },
  capture: {
    ...rustlsEnvelope.capture,
    captureMethod: 'ebpf_boringssl',
  },
  userInstruction: {
    ...rustlsEnvelope.userInstruction,
    content: claudeSentinel,
    contentBytes: claudeEncoded.byteLength,
    contentSha256: createHash('sha256').update(claudeEncoded).digest('hex'),
  },
};

function cloneStored(value) {
  return {
    ...value,
    nonce: Buffer.from(value.nonce),
    authTag: Buffer.from(value.authTag),
    ciphertext: Buffer.from(value.ciphertext),
  };
}

async function main() {
  let stored;
  const relational = {
    configured: () => true,
    purgeOrphanInteractionContents: async () => 0,
    finalizeInteractionContent: async (incoming) => {
      if (!stored) {
        stored = { ...cloneStored(incoming), state: 'pending' };
        return { state: 'stored', record: cloneStored(stored) };
      }
      const identical =
        stored.contentRef === incoming.contentRef
        && stored.interactionId === incoming.interactionId
        && stored.contentSha256 === incoming.contentSha256
        && stored.contentBytes === incoming.contentBytes;
      return identical
        ? { state: 'duplicate', record: cloneStored(stored) }
        : { state: 'conflict' };
    },
    markInteractionContentAccepted: async (_contentRef, acceptedAt) => {
      stored = { ...stored, state: 'accepted', acceptedAt };
      return true;
    },
    loadInteractionContent: async (interactionId) =>
      stored?.interactionId === interactionId ? cloneStored(stored) : null,
    loadAvailableInteractionContentIds: async (ids) =>
      new Set(
        stored && stored.state !== 'deleted' && ids.includes(stored.interactionId)
          ? [stored.interactionId]
          : [],
      ),
    deleteInteractionContent: async (interactionId, deletedAt = Date.now()) => {
      if (!stored || stored.interactionId !== interactionId) return 'not_found';
      stored = {
        ...stored,
        state: 'deleted',
        nonce: Buffer.alloc(0),
        authTag: Buffer.alloc(0),
        ciphertext: Buffer.alloc(0),
        deletedAt,
      };
      return 'deleted';
    },
  };
  const store = new InteractionContentStore(relational);
  await store.onModuleInit();
  assert.equal(store.status().contentCaptureAllowed, true);
  assert.equal(store.status().rawViewEnabled, true);
  assert.equal(store.status().directViewEnabled, false);
  assert.equal(
    store.status().rawViewAuthentication,
    'management_plus_raw_capability',
  );
  assert.equal(store.rawViewAuthorized('verify-content-raw-token'), true);
  assert.equal(store.rawViewAuthorized('wrong-token'), false);
  console.log('PASS encrypted content and independent Raw View Gates are explicit');

  process.env.ANYSENTRY_INTERACTION_UNSAFE_LOCAL_DIRECT_VIEW = 'on';
  const directStore = new InteractionContentStore(relational);
  assert.equal(directStore.status().directViewEnabled, true);
  assert.equal(
    directStore.status().rawViewAuthentication,
    'unsafe_local_direct_view',
  );
  assert.equal(directStore.rawViewAuthorized(undefined), false);
  assert.equal(
    directStore.rawViewAuthorized('verify-content-raw-token'),
    true,
  );
  directStore.onModuleDestroy();
  delete process.env.ANYSENTRY_INTERACTION_UNSAFE_LOCAL_DIRECT_VIEW;
  console.log('PASS keyless direct view requires the explicit isolated-fixture unsafe flag');

  const validatedRustls =
    validateInteractionInstructionIngest(rustlsEnvelope);
  assert.equal(validatedRustls.content, rustlsSentinel);
  assert.equal(
    validatedRustls.metadata.runtime?.runtimeType,
    'codex_ebpf_rustls',
  );
  assert.equal(validatedRustls.metadata.process?.tid, 5253);
  assert.equal(validatedRustls.metadata.input.protocol, 'responses_api');
  assert.equal(
    validatedRustls.metadata.capture.captureMethod,
    'ebpf_rustls',
  );
  console.log('PASS exact-binary Rustls Observer instruction satisfies the AnySentry content schema');

  const validatedClaude =
    validateInteractionInstructionIngest(claudeEnvelope);
  assert.equal(validatedClaude.content, claudeSentinel);
  assert.equal(
    validatedClaude.metadata.runtime?.runtimeType,
    'claude_code_ebpf_tls',
  );
  assert.equal(validatedClaude.metadata.process?.tid, 6263);
  assert.equal(validatedClaude.metadata.input.protocol, 'messages_api');
  assert.equal(
    validatedClaude.metadata.capture.captureMethod,
    'ebpf_boringssl',
  );
  console.log('PASS exact-binary Claude BoringSSL instruction satisfies the AnySentry content schema');

  const validated = validateInteractionInstructionIngest(envelope);
  assert.equal(validated.content, sentinel);
  const record = interactionInstructionRecord(
    validated.metadata,
    source,
    interactionContentRef(source.sourceId, envelope.sourceEventId),
    1787900000100,
  );
  const finalized = await store.finalize(record, validated.content);
  assert.equal(finalized.state, 'stored');
  assert.ok(stored.ciphertext.byteLength > 0);
  assert.equal(stored.ciphertext.includes(encoded), false);
  assert.equal(JSON.stringify(record).includes(sentinel), false);
  console.log('PASS plaintext is excluded from Kafka metadata and encrypted at rest');

  await store.markAccepted(record.userInstruction.contentRef, record.acceptedAt);
  const viewed = await store.read(record.interactionId);
  assert.equal(viewed?.content, sentinel);
  assert.equal(viewed?.contentSha256, envelope.userInstruction.contentSha256);
  assert.deepEqual(
    await store.availableInteractionIds([record.interactionId]),
    new Set([record.interactionId]),
  );
  console.log('PASS authenticated decryption preserves exact UTF-8 content and integrity');

  const replay = await store.finalize(record, validated.content);
  assert.equal(replay.state, 'duplicate');
  console.log('PASS stable contentRef retry is idempotent after a lost HTTP response');

  const untampered = Buffer.from(stored.ciphertext);
  stored.ciphertext[0] ^= 0xff;
  await assert.rejects(
    store.read(record.interactionId),
    (error) => typeof error?.getStatus === 'function' && error.getStatus() === 503,
  );
  stored.ciphertext = untampered;
  console.log('PASS AES-GCM rejects ciphertext tampering before returning plaintext');

  assert.equal(await store.delete(record.interactionId), 'deleted');
  assert.equal(await store.read(record.interactionId), null);
  assert.deepEqual(
    await store.availableInteractionIds([record.interactionId]),
    new Set(),
  );
  console.log('PASS deletion cryptographically erases ciphertext while metadata can remain');
  store.onModuleDestroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
