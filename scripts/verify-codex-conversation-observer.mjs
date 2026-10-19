#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractCodexConversationMessages,
} from './codex-conversation-observer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const types = require(path.join(
  root,
  'apps/api/dist/security-monitoring/interaction.types.js',
));
const { parseInteractionKafkaRecord } = require(path.join(
  root,
  'apps/api/dist/security-monitoring/interaction.service.js',
));

const thread = {
  id: '01a00000-0000-7000-8000-000000000001',
  sessionId: '01a00000-0000-7000-8000-000000000001',
  source: 'cli',
  cwd: '/workspace/real-agent',
  cliVersion: '0.147.0',
  modelProvider: 'openai',
  createdAt: 1_787_900_000,
  turns: [
    {
      id: '01a00000-0000-7000-8000-000000000011',
      status: 'completed',
      startedAt: 1_787_900_010,
      itemsView: 'full',
      items: [
        {
          id: 'item-user-1',
          type: 'userMessage',
          content: [
            { type: 'text', text: '检查当前仓库，并告诉我风险。' },
            { type: 'localImage', path: '/sensitive/path/screenshot.png' },
          ],
        },
        {
          id: 'item-commentary-1',
          type: 'agentMessage',
          phase: 'commentary',
          text: '我先读取仓库约束和当前状态。',
        },
        {
          id: 'item-command-1',
          type: 'commandExecution',
          command: 'git status --short',
          aggregatedOutput: 'secret tool output must not become dialogue body',
        },
        {
          id: 'item-final-1',
          type: 'agentMessage',
          phase: 'final_answer',
          text: '检查完成：当前有两项需要处理。',
        },
      ],
    },
    {
      id: '01a00000-0000-7000-8000-000000000012',
      status: 'inProgress',
      startedAt: 1_787_900_020,
      itemsView: 'full',
      items: [
        {
          id: 'item-user-mutable',
          type: 'userMessage',
          content: [{ type: 'text', text: '这轮还没有完成。' }],
        },
        {
          id: 'item-agent-mutable',
          type: 'agentMessage',
          phase: 'commentary',
          text: 'mutable prefix',
        },
      ],
    },
  ],
};

const extracted = extractCodexConversationMessages(thread);
assert.equal(extracted.totalTurns, 2);
assert.equal(extracted.skippedInProgress, 1);
assert.equal(extracted.messages.length, 3);
assert.deepEqual(
  extracted.messages.map((item) => [item.role, item.phase]),
  [
    ['user', undefined],
    ['assistant', 'commentary'],
    ['assistant', 'final_answer'],
  ],
);
assert.equal(
  extracted.messages[0].envelope.userInstruction.content,
  '检查当前仓库，并告诉我风险。\n[图片附件]',
);
assert.equal(
  JSON.stringify(extracted.messages).includes('secret tool output'),
  false,
  'command output must not enter the conversation content lane',
);

const repeated = extractCodexConversationMessages(thread);
assert.deepEqual(
  repeated.messages.map((item) => item.fingerprint),
  extracted.messages.map((item) => item.fingerprint),
  'native ids and content must produce stable retry fingerprints',
);

const user = types.validateInteractionInstructionIngest(
  extracted.messages[0].envelope,
);
const commentary = types.validateInteractionResponseIngest(
  extracted.messages[1].envelope,
);
const userRecord = types.interactionInstructionRecord(
  user.metadata,
  { sourceId: 'source-codex-runtime', tenantId: 'tenant_default' },
  'blob-user',
  1_787_900_100_000,
);
const responseRecord = types.interactionResponseRecord(
  commentary.metadata,
  { sourceId: 'source-codex-runtime', tenantId: 'tenant_default' },
  'blob-assistant',
  1_787_900_100_001,
);
assert.equal(userRecord.process, undefined);
assert.equal(userRecord.runtime.threadId, thread.id);
assert.match(userRecord.processInstanceId, /^runtime_[a-f0-9]{32}$/u);
assert.equal(userRecord.conversationId, responseRecord.conversationId);
assert.equal(userRecord.turnId, responseRecord.turnId);
assert.equal(responseRecord.assistantResponse.phase, 'commentary');

const reconstructed = parseInteractionKafkaRecord(
  Buffer.from(JSON.stringify(userRecord), 'utf8'),
);
assert.deepEqual(reconstructed, userRecord);

assert.throws(
  () =>
    types.validateInteractionInstructionIngest({
      ...extracted.messages[0].envelope,
      process: {
        hostId: 'host',
        bootId: 'boot',
        pid: 42,
        startTimeTicks: '1',
      },
    }),
  /exactly one of body\.process or body\.runtime/u,
);

const oversized = `${'🙂'.repeat(70_000)}-tail-must-be-truncated`;
const truncatedThread = {
  ...thread,
  turns: [
    {
      id: '01a00000-0000-7000-8000-000000000099',
      status: 'completed',
      startedAt: 1_787_900_030,
      items: [
        {
          id: 'item-user-large',
          type: 'userMessage',
          content: [{ type: 'text', text: oversized }],
        },
      ],
    },
  ],
};
const truncated = extractCodexConversationMessages(truncatedThread).messages[0].envelope;
assert.equal(truncated.capture.captureCompleteness, 'truncated');
assert.ok(Buffer.byteLength(truncated.userInstruction.content, 'utf8') <= 256 * 1024);
assert.equal(truncated.userInstruction.content.includes('\ufffd'), false);
types.validateInteractionInstructionIngest(truncated);

const checkpointShape = extracted.messages.map(({ sourceEventId, fingerprint }) => ({
  sourceEventId,
  fingerprint,
}));
assert.equal(
  JSON.stringify(checkpointShape).includes('检查当前仓库'),
  false,
  'cursor material must contain ids and hashes, never plaintext',
);

console.log(
  JSON.stringify({
    ok: true,
    terminalMessages: extracted.messages.length,
    skippedInProgress: extracted.skippedInProgress,
    stableConversationId: userRecord.conversationId,
    runtimeProcessKey: userRecord.processInstanceId,
    truncationBytes: Buffer.byteLength(truncated.userInstruction.content, 'utf8'),
  }),
);

