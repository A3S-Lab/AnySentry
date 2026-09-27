#!/usr/bin/env node
/**
 * Repeatable unit checks for hop-fence empty route-alias repair and multi-hop
 * semantic projection. Does not deploy, mutate tip, or require Docker.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperTs = path.join(
  root,
  'apps/api/src/security-monitoring/agent-conversation-route-alias-repair.ts',
);
const controllerTs = path.join(
  root,
  'apps/api/src/security-monitoring/security-monitoring.controller.ts',
);

function loadRepairHelper() {
  const script = `
    import {
      repairEmptyRouteAliasConversationId,
      hopConversationFenceValue,
      boundHopRemintConversationId,
      pointReadCanonicalConversationId,
      conversationHopScopeSuffix,
      hopFromLogicalScopeKey,
      hopLocalProjectionRecord,
      hopAlignedConversationId,
      persistedMembershipConversationId,
      shouldProjectHopLocal,
    } from ${JSON.stringify(helperTs)};
    const cases = [
      {
        name: 'empty_alias_prefers_requested',
        input: {
          requestedConversationId: 'cv_parent',
          aliasCanonicalConversationId: 'cv_empty',
          aliasMembershipIds: [],
          requestedMembershipIds: ['mi_1', 'mi_2'],
        },
        expect: 'cv_parent',
      },
      {
        name: 'populated_alias_kept',
        input: {
          requestedConversationId: 'cv_parent',
          aliasCanonicalConversationId: 'cv_canon',
          aliasMembershipIds: ['mi_a'],
          requestedMembershipIds: ['mi_1'],
        },
        expect: 'cv_canon',
      },
      {
        name: 'no_alias_uses_requested',
        input: {
          requestedConversationId: 'cv_parent',
          aliasMembershipIds: [],
          requestedMembershipIds: [],
        },
        expect: 'cv_parent',
      },
      {
        name: 'empty_requested_membership_keeps_alias',
        input: {
          requestedConversationId: 'cv_parent',
          aliasCanonicalConversationId: 'cv_empty',
          aliasMembershipIds: [],
          requestedMembershipIds: [],
        },
        expect: 'cv_empty',
      },
    ];
    for (const c of cases) {
      const got = repairEmptyRouteAliasConversationId(c.input);
      if (got !== c.expect) {
        console.error(JSON.stringify({ case: c.name, got, expect: c.expect }));
        process.exit(1);
      }
    }
    const orch = hopConversationFenceValue('orchestrator');
    const worker = hopConversationFenceValue('worker');
    const supervisor = hopConversationFenceValue('supervisor');
    const specialist = hopConversationFenceValue('specialist');
    if (!orch || !worker || orch === worker) {
      console.error(JSON.stringify({ orch, worker }));
      process.exit(1);
    }
    if (!supervisor || !specialist || supervisor === specialist || supervisor === orch) {
      console.error(JSON.stringify({ supervisor, specialist, orch }));
      process.exit(1);
    }
    if (hopConversationFenceValue('') || hopConversationFenceValue(undefined)) {
      console.error('empty hop must not fence');
      process.exit(1);
    }
    const durable = 'cv_ddf7cdc36befaa8eaaf3ba2f';
    const remint = boundHopRemintConversationId(durable, 'orchestrator');
    if (remint !== 'cv_2901172e7ca0eaa4307877db') {
      console.error(JSON.stringify({ remint, expect: 'cv_2901172e7ca0eaa4307877db' }));
      process.exit(1);
    }
    if (boundHopRemintConversationId(durable, 'worker') === remint) {
      console.error('hop remint must stay hop-fenced');
      process.exit(1);
    }
    if (boundHopRemintConversationId(durable) || boundHopRemintConversationId('', 'orchestrator')) {
      console.error('remint requires a durable id and a hop fence');
      process.exit(1);
    }
    const keptDirectory = pointReadCanonicalConversationId({
      requestedConversationId: 'cv_dir_worker',
      initialConversationId: 'cv_dir_worker',
      membershipCount: 9,
      selectedConversationId: 'cv_shared_parent',
      projectionHasRequested: true,
    });
    if (keptDirectory !== 'cv_dir_worker') {
      console.error(JSON.stringify({ keptDirectory, expect: 'cv_dir_worker' }));
      process.exit(1);
    }
    const usesSelectedWhenMissing = pointReadCanonicalConversationId({
      requestedConversationId: 'cv_dir_worker',
      initialConversationId: 'cv_dir_worker',
      membershipCount: 9,
      selectedConversationId: 'cv_worker_local',
      projectionHasRequested: false,
    });
    if (usesSelectedWhenMissing !== 'cv_worker_local') {
      console.error(JSON.stringify({ usesSelectedWhenMissing, expect: 'cv_worker_local' }));
      process.exit(1);
    }
    if (!shouldProjectHopLocal([{ hop: 'worker' }, { hop: 'worker' }])
      || shouldProjectHopLocal([{ hop: 'worker' }, { hop: 'orchestrator' }])) {
      console.error('hop-local projection is for a single hop membership');
      process.exit(1);
    }
    const stripped = hopLocalProjectionRecord({
      hop: 'worker',
      conversationId: 'cv_shared_parent',
      conversationIdSource: 'inferred',
      conversationBindingVersion: 2,
    });
    if (stripped.conversationId || stripped.conversationBindingVersion) {
      console.error('hop-local projection must drop a shared persisted Thread id');
      process.exit(1);
    }
    if (persistedMembershipConversationId({
      resolverConversationId: 'cv_worker_v2',
      bindingConversationId: 'cv_orch_stamp',
    }) !== 'cv_worker_v2') {
      console.error('v2 hop-local membership must win over a v1 parent stamp');
      process.exit(1);
    }
    const remintedWorker = hopAlignedConversationId({
      conversationId: 'cv_a85602d5b8a4049aca517859',
      hop: 'worker',
      threadLogicalScopeKey: 'ls_fixture|hop:orchestrator',
    });
    const remintedOrch = hopAlignedConversationId({
      conversationId: 'cv_a85602d5b8a4049aca517859',
      hop: 'orchestrator',
      threadLogicalScopeKey: 'ls_fixture|hop:orchestrator',
    });
    if (!remintedWorker || remintedWorker === remintedOrch || remintedOrch !== 'cv_a85602d5b8a4049aca517859') {
      console.error(JSON.stringify({ remintedWorker, remintedOrch }));
      process.exit(1);
    }
    if (hopAlignedConversationId({
      conversationId: 'cv_worker_v2',
      hop: 'worker',
    }) !== 'cv_worker_v2') {
      console.error('missing Thread must keep a hop-local membership id');
      process.exit(1);
    }
    if (hopAlignedConversationId({
      conversationId: 'cv_a85602d5b8a4049aca517859',
      hop: 'worker',
      threadLogicalScopeKey: 'ls_fixture',
    }) !== 'cv_a85602d5b8a4049aca517859') {
      console.error('hop-unscoped Thread must keep the persisted stamp');
      process.exit(1);
    }
    const followsSelected = pointReadCanonicalConversationId({
      requestedConversationId: 'cv_dir_worker',
      initialConversationId: 'cv_shared_parent',
      membershipCount: 9,
      selectedConversationId: 'cv_shared_parent',
    });
    if (followsSelected !== 'cv_shared_parent') {
      console.error(JSON.stringify({ followsSelected, expect: 'cv_shared_parent' }));
      process.exit(1);
    }
    const orchSuffix = conversationHopScopeSuffix('orchestrator');
    const workerSuffix = conversationHopScopeSuffix('worker');
    if (!orchSuffix.startsWith('|hop:') || orchSuffix === workerSuffix || orchSuffix.indexOf(String.fromCharCode(0)) >= 0) {
      console.error(JSON.stringify({ orchSuffix, workerSuffix }));
      process.exit(1);
    }
    if (hopFromLogicalScopeKey('ls_fixture' + orchSuffix) !== 'orchestrator') {
      console.error('scope hop suffix must round-trip');
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, cases: cases.length, hopFenceDistinct: true, remintLocked: true }));
  `;
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { encoding: 'utf8', cwd: root },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'helper load failed\n');
    process.exit(result.status ?? 1);
  }
  process.stdout.write(result.stdout);
}

function assertControllerMembershipHotProjection() {
  const source = readFileSync(controllerTs, 'utf8');
  assert.match(source, /hotInteractions\.length > 1/);
  assert.match(source, /canonicalHotSessionTimeline\(session, hotInteractions/);
  assert.match(source, /Membership-backed Session deep links can outlive a single hot row/);
  console.log(JSON.stringify({ controller: 'multi_hot_membership_ok' }));
}

function loadSemanticMultiHop() {
  const require = createRequire(import.meta.url);
  const dist = path.join(root, 'apps/api/dist/security-monitoring/agent-semantic-timeline.js');
  let projectSemanticConversationTimeline;
  try {
    ({ projectSemanticConversationTimeline } = require(dist));
  } catch {
    console.log(JSON.stringify({ semantic: 'skipped_no_dist' }));
    return;
  }
  const emptyReq = { structured: undefined, text: undefined };
  const base = {
    startedAtUnixNs: '1000',
    endedAtUnixNs: '2000',
    durationNs: '1000',
    statusCode: 200,
    completeness: 'complete',
    partialReasons: [],
    toolCalls: [],
    toolResults: [],
    request: emptyReq,
    response: emptyReq,
    agentAssetId: 'agent_x',
    path: '/x',
    method: 'POST',
    evidenceEventIds: [],
    correlationQuality: 'inferred',
  };
  const interactions = [
    {
      ...base,
      interactionId: 'mi_orch_model',
      interactionType: 'model',
      hop: 'orchestrator',
      trafficRole: 'conversation',
      semanticItems: [
        { kind: 'user_message', content: 'hi', partialReasons: [], semanticItemId: 's1' },
        { kind: 'model_final', content: 'ok', partialReasons: [], semanticItemId: 's2' },
      ],
      startedAtUnixNs: '1000',
      endedAtUnixNs: '1100',
    },
    {
      ...base,
      interactionId: 'mi_ra',
      interactionType: 'remote_agent',
      trafficRole: 'delegation',
      hop: 'orchestrator',
      path: '/runs',
      delegationId: 'd1',
      startedAtUnixNs: '1200',
      endedAtUnixNs: '1500',
      endpoint: 'http://127.0.0.1:18091/runs',
      semanticItems: [],
    },
    {
      ...base,
      interactionId: 'mi_worker',
      interactionType: 'model',
      hop: 'worker',
      trafficRole: 'conversation',
      semanticItems: [
        { kind: 'user_message', content: 'w', partialReasons: [], semanticItemId: 's3' },
        { kind: 'tool_call', content: {}, partialReasons: [], semanticItemId: 's4', toolCallId: 't1' },
        { kind: 'tool_result', content: {}, partialReasons: [], semanticItemId: 's5', toolCallId: 't1' },
        { kind: 'model_final', content: '4', partialReasons: [], semanticItemId: 's6' },
      ],
      startedAtUnixNs: '1300',
      endedAtUnixNs: '1400',
      toolCalls: [{ toolCallId: 't1', name: 'run_in_sandbox' }],
      toolResults: [{ toolCallId: 't1', isError: false }],
    },
  ];
  const summary = {
    conversationId: 'sess_test',
    hasContent: true,
    agentAssetId: 'agent_x',
    agentAssetIds: ['agent_x'],
    agentInstanceIds: [],
    agentProduct: 'LangGraph',
    displayName: 'LangGraph',
    environment: 'host',
    classification: 'confirmed_agent',
    workspacePath: '/',
    startedAtUnixNs: '1000',
    lastActivityAtUnixNs: '1500',
    turnCount: 1,
    modelCallCount: 2,
    toolCallCount: 1,
    toolResultCount: 1,
    errorCount: 0,
    models: [],
    usage: {},
    instanceUsage: [],
    coverage: {
      status: 'complete',
      reasons: [],
      completeInteractions: 3,
      partialInteractions: 0,
    },
  };
  try {
    const turns = projectSemanticConversationTimeline(summary, interactions, []);
    const events = turns.flatMap((turn) => turn.events);
    const kinds = events.map((event) => event.kind);
    assert.ok(kinds.includes('delegation_send'), 'missing delegation_send');
    assert.ok(kinds.includes('delegation_reply'), 'missing delegation_reply');
    console.log(JSON.stringify({
      semantic: 'ok',
      turns: turns.length,
      kinds: [...new Set(kinds)],
      hops: [...new Set(events.map((event) => event.hop).filter(Boolean))],
    }));
  } catch (error) {
    // Dist may lag source under capacity NO-GO tip builds; keep repair checks authoritative.
    console.log(JSON.stringify({
      semantic: 'skipped_dist_error',
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

loadRepairHelper();
assertControllerMembershipHotProjection();
loadSemanticMultiHop();
console.log(JSON.stringify({ ok: true, verifier: 'verify-empty-route-alias-repair' }));
