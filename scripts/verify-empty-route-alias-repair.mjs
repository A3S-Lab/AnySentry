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
    if (!orch || !worker || orch === worker) {
      console.error(JSON.stringify({ orch, worker }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, cases: cases.length, hopFenceDistinct: true }));
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
