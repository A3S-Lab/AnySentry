#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';

const lifecycle = fs.readFileSync(
  new URL('../apps/api/src/security-monitoring/observed-asset-lifecycle.read.service.ts', import.meta.url),
  'utf8',
);
const controller = fs.readFileSync(
  new URL('../apps/api/src/security-monitoring/security-monitoring.controller.ts', import.meta.url),
  'utf8',
);

const bindStart = lifecycle.indexOf('  bindIngestMeta(');
const materializeStart = lifecycle.indexOf('  materializeCommittedIngest(', bindStart);
assert(bindStart >= 0 && materializeStart > bindStart, 'ingest binding and materialization seams must exist');
const bindBody = lifecycle.slice(bindStart, materializeStart);
assert.doesNotMatch(bindBody, /this\.core\./u,
  'pre-commit subject binding must not publish Asset/Runtime/Binding state');
assert.doesNotMatch(bindBody, /persistStateSoon/u,
  'pre-commit subject binding must not schedule PostgreSQL state persistence');

const materializeBody = lifecycle.slice(materializeStart, lifecycle.indexOf('  private reviewSafety(', materializeStart));
assert.match(materializeBody, /subjectAssetType !== 'ephemeral_process'/u);
assert.match(materializeBody, /this\.core\.upsertAsset/u);
assert.match(materializeBody, /this\.core\.upsertBinding/u);
assert.match(materializeBody, /this\.core\.upsertRuntime/u);
assert.doesNotMatch(materializeBody, /persistStateSoon/u,
  'high-cardinality Process materialization must use ClickHouse as durable truth');

const batchStart = controller.indexOf("  @Post('ingest/batch')");
const singleStart = controller.indexOf("  @Post('ingest')", batchStart + 1);
assert(batchStart >= 0 && singleStart > batchStart, 'Observer batch/single ingest seams must exist');
const batchBody = controller.slice(batchStart, singleStart);
const lifecyclePersist = batchBody.indexOf('persistPreparedProcessLifecycleFacts');
const eventPersist = batchBody.indexOf('persistPreparedBatch');
const publish = batchBody.indexOf('materializeCommittedObservedAsset');
assert(lifecyclePersist >= 0 && eventPersist >= 0 && publish > lifecyclePersist && publish > eventPersist,
  'batch asset publication must follow both durable ClickHouse writes');
assert.match(batchBody.slice(0, publish), /if \(!persisted\)[\s\S]*?return \{/u,
  'structural persistence failure must return before asset publication');
assert.match(batchBody.slice(0, publish), /isClickHouseEventBufferFull[\s\S]*?return \{/u,
  'retained persistence failure must return before asset publication');
assert.match(batchBody.slice(publish), /retainedDurability === 'durable'/u,
  'memory-only retained batches must not publish Asset/Runtime state');

const singleBody = controller.slice(singleStart);
assert(singleBody.indexOf('materializeCommittedObservedAsset') > singleBody.indexOf('acceptWithDisposition'),
  'single-event asset publication must follow accepted persistence');

console.log('Observed Asset post-commit publication contract passed');
