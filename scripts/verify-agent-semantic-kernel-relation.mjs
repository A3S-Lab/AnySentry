#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
  buildSemanticKernelRelationBatch,
  buildSemanticKernelRelations,
  canonicalEvidenceLinksForRelations,
  semanticKernelRelationBatchWindow,
  toolInvocationId,
} = require('../apps/api/dist/security-monitoring/agent-semantic-kernel-relation.js');
const {
  RelationalBusinessStore,
} = require('../apps/api/dist/security-monitoring/relational-business-store.service.js');
const {
  AggregationService,
  toolEvidenceHotPathTesting,
} = require('../apps/api/dist/security-monitoring/aggregation.service.js');
const {
  projectAgentConversations,
} = require('../apps/api/dist/security-monitoring/agent-conversation.js');
const {
  projectSemanticConversationTimeline,
} = require('../apps/api/dist/security-monitoring/agent-semantic-timeline.js');

const instanceId = 'host-root:semantic:100:200';
const interaction = {
  interactionId: 'mi_semantic_kernel_relation',
  agentAssetId: 'agent-semantic',
  agentInstanceId: instanceId,
};
const callAt = 1_788_500_000_000;
const toolCall = {
  semanticEventId: 'se_semantic_kernel_call',
  conversationId: 'cv_semantic',
  segmentId: 'seg_semantic',
  turnId: 'turn_semantic',
  actor: 'tool',
  kind: 'tool_call',
  atUnixNs: String(BigInt(callAt) * 1_000_000n),
  content: { cmd: 'rg -n resolver-v2 /tmp/canary.txt' },
  toolCallId: 'call-semantic',
  toolName: 'exec_command',
  toolKind: 'bash',
  sourceInteractionIds: [interaction.interactionId],
  evidenceEventIds: ['evt_llm_interaction'],
};
const toolResult = {
  ...toolCall,
  semanticEventId: 'se_semantic_kernel_result',
  kind: 'tool_result',
  atUnixNs: String(BigInt(callAt + 500) * 1_000_000n),
};
const kernelEvent = {
  eventId: 'evt_kernel_exec',
  at: new Date(callAt + 100).toISOString(),
  eventKind: 'ToolExec',
  decisionRevision: 3,
  subject: '/bin/bash -lc "rg -n resolver-v2 /tmp/canary.txt"',
  agentRuntimeInstanceId: instanceId,
  agentRuntimeInstanceAliases: [],
  attributes: {},
  verdict: 'block',
  tier: 'L1',
  severity: 'high',
  riskScore: 86,
  riskName: '危险命令',
  riskCategory: 'command_danger',
  reason: 'fixture risk judgment',
};
const unrelated = {
  ...kernelEvent,
  eventId: 'evt_unrelated',
  subject: '/bin/bash -lc "printf unrelated"',
};
const wrongInstance = {
  ...kernelEvent,
  eventId: 'evt_wrong_instance',
  agentRuntimeInstanceId: 'host-root:other:101:201',
};

const relations = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [kernelEvent, unrelated, wrongInstance],
  12,
  false,
);
assert.equal(relations.length, 1);
assert.equal(relations[0].status, 'linked_exact');
assert.equal(relations[0].linkMethod, 'command');
assert.equal(relations[0].kernelEventId, kernelEvent.eventId);
assert.equal(relations[0].kernelEventAt, kernelEvent.at);
assert.equal(relations[0].kernelEventKind, 'ToolExec');
assert.equal(relations[0].kernelEventDecisionRevision, 3);
assert.equal(relations[0].timeQuality, 'exact');
assert.equal(relations[0].risk.riskScore, 86);
assert.equal(relations[0].risk.verdict, 'block');
assert.equal(relations[0].authority, 'attested_tls_plaintext');
assert.equal(relations[0].toolInvocationId, toolInvocationId(toolCall, interaction));

const nestedSubcommandEvent = {
  ...kernelEvent,
  eventId: 'evt_nested_subcommand',
  subject: 'rg -n resolver-v2',
  process: { pid: 102, ppid: 101, comm: 'rg' },
};
const primaryCommandRelations = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [kernelEvent, nestedSubcommandEvent],
  12,
  false,
);
assert.equal(primaryCommandRelations.length, 1);
assert.equal(primaryCommandRelations[0].kernelEventId, kernelEvent.eventId,
  'the complete Tool command must uniquely outrank one nested subcommand process');
assert.equal(primaryCommandRelations[0].confidence, 1);

const equalCommandCandidates = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [kernelEvent, { ...kernelEvent, eventId: 'evt_equal_command_generation' }],
  12,
  false,
);
assert.equal(equalCommandCandidates.length, 2,
  'equal-strength competing Kernel generations must remain as explicit candidate relations');
assert(equalCommandCandidates.every((relation) => relation.status === 'ambiguous'));
assert.deepEqual(
  equalCommandCandidates.map((relation) => relation.kernelEventId).sort(),
  ['evt_equal_command_generation', 'evt_kernel_exec'].sort(),
);
assert(equalCommandCandidates.every((relation) => relation.competingKernelEventIds?.length === 2));
assert.match(equalCommandCandidates[0].evidenceLinkId ?? '', /^el_[a-f0-9]{24}$/u);
assert.equal(equalCommandCandidates[0].confidence, 0,
  'an unresolved competing candidate must not retain a positive EvidenceLink confidence');

const codexCustomToolCall = {
  ...toolCall,
  semanticEventId: 'se_codex_custom_tool',
  toolCallId: 'call-codex-custom',
  content: 'const r = await tools.exec_command({cmd:"rg -n resolver-v2 /tmp/canary.txt",workdir:"/tmp"}); text(r.output);',
};
const codexRelations = buildSemanticKernelRelations(
  codexCustomToolCall,
  toolResult,
  interaction,
  [kernelEvent],
  12,
  false,
);
assert.equal(codexRelations[0].status, 'linked_exact',
  'Codex custom-tool JavaScript wrappers must expose their bounded cmd field generically');
assert.equal(codexRelations[0].kernelEventId, kernelEvent.eventId);

const completeArgvEvent = {
  ...kernelEvent,
  eventId: 'evt_complete_argv_after_short_subject',
  subject: '/bin/bash -c source /tmp/agent-shell-snapshot',
  attributes: {
    argv: "/bin/bash -c source /tmp/agent-shell-snapshot && eval 'rg -n resolver-v2 /tmp/canary.txt'",
    argv_truncated: false,
    argv_incomplete: false,
  },
};
const completeArgvRelations = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [completeArgvEvent],
  12,
  false,
);
assert.equal(completeArgvRelations[0].status, 'linked_strong');
assert.equal(completeArgvRelations[0].linkMethod, 'command');
assert.equal(completeArgvRelations[0].kernelEventId, completeArgvEvent.eventId,
  'a complete eBPF argv must recover a command that the bounded Event subject omits');

const truncatedArgvRelations = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [{
    ...completeArgvEvent,
    eventId: 'evt_truncated_argv_after_short_subject',
    attributes: { ...completeArgvEvent.attributes, argv_truncated: true },
  }],
  12,
  false,
);
assert.equal(truncatedArgvRelations[0].status, 'semantic_only');
assert.equal(truncatedArgvRelations[0].kernelEventId, undefined,
  'an explicitly truncated argv must never be promoted into exact command evidence');

const preciseKernelTimeRelations = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [{
    ...kernelEvent,
    eventId: 'evt_precise_kernel_time',
    at: '1970-01-01 00:00:00',
    eventAtUnixNs: String(BigInt(callAt + 100) * 1_000_000n),
  }],
  12,
  false,
);
assert.equal(preciseKernelTimeRelations[0].status, 'linked_exact');
assert.equal(preciseKernelTimeRelations[0].kernelEventId, 'evt_precise_kernel_time',
  'the attested nanosecond event time must take precedence over a coarse or zone-less display time');

const resourceCall = {
  ...toolCall,
  semanticEventId: 'se_semantic_resource',
  toolCallId: 'call-resource',
  toolName: 'apply_patch',
  toolKind: 'write',
  content: { path: '/tmp/canary.txt', content: 'fixture' },
};
const fileEvent = {
  ...kernelEvent,
  eventId: 'evt_file_write',
  eventKind: 'FileAccess',
  subject: 'write /tmp/canary.txt',
  attributes: { path: '/tmp/canary.txt', accessMode: 'write_only' },
  verdict: 'allow',
  tier: 'Rules',
  severity: 'info',
  riskScore: 0,
  riskName: '正常',
  riskCategory: 'other',
};
const resourceRelations = buildSemanticKernelRelations(
  resourceCall,
  undefined,
  interaction,
  [fileEvent],
  13,
  false,
);
assert.equal(resourceRelations[0].status, 'linked_exact');
assert.equal(resourceRelations[0].linkMethod, 'resource');
assert.equal(resourceRelations[0].kernelEventId, fileEvent.eventId);
assert.equal(resourceRelations[0].timeQuality, 'bounded');
assert.equal(toolEvidenceHotPathTesting.semanticKernelEventCategory(resourceCall), 'file');

const relativeResourceCall = {
  ...resourceCall,
  semanticEventId: 'se_semantic_relative_resource',
  toolCallId: 'call-relative-resource',
  toolName: 'read',
  toolKind: 'read',
  content: { path: 'canary.txt' },
};
const absoluteFileEvent = {
  ...fileEvent,
  eventId: 'evt_file_relative_abs',
  subject: 'file /workspace/canary.txt',
  attributes: { path: '/workspace/canary.txt', accessMode: 'read_only' },
};
const relativeResourceRelations = buildSemanticKernelRelations(
  relativeResourceCall,
  undefined,
  interaction,
  [absoluteFileEvent],
  13,
  false,
);
assert.equal(relativeResourceRelations[0].status, 'linked_strong');
assert.equal(relativeResourceRelations[0].linkMethod, 'resource');
assert.equal(relativeResourceRelations[0].kernelEventId, absoluteFileEvent.eventId);
assert.equal(relativeResourceRelations[0].confidence, 0.98);

const dockerInteraction = {
  ...interaction,
  agentInstanceId: 'docker:pjnl261070032:f62f42c3a830aa82edd9a1684922d941b616cec97cca4260c08d0c31f9567559',
};
const dockerBashCall = {
  ...toolCall,
  semanticEventId: 'se_docker_bash_call',
  toolCallId: 'call_bash_fixture',
  toolName: 'bash',
  toolKind: 'bash',
  content: {
    command: "printf '%s\\n' 'PI_BASH_RESULT_SENTINEL_20260827' | tee -a tool-events.log",
  },
};
const dockerBashResult = {
  ...dockerBashCall,
  semanticEventId: 'se_docker_bash_result',
  kind: 'tool_result',
  atUnixNs: String(BigInt(callAt + 500) * 1_000_000n),
  content: 'PI_BASH_RESULT_SENTINEL_20260827\n',
};
const dockerBareChildExec = {
  ...kernelEvent,
  eventId: 'evt_docker_bare_bash',
  subject: "/bin/bash -lc printf '%s\\n' 'PI_BASH_RESULT_SENTINEL_20260827' | tee -a tool-events.log",
  // Child ToolExec sometimes loses the docker:host: qualifier while keeping the container id.
  agentRuntimeInstanceId: 'f62f42c3a830aa82edd9a1684922d941b616cec97cca4260c08d0c31f9567559',
  agentRuntimeInstanceAliases: [],
  attributes: {
    argv: "/bin/bash -lc printf '%s\\n' 'PI_BASH_RESULT_SENTINEL_20260827' | tee -a tool-events.log",
  },
};
const dockerBashRelations = buildSemanticKernelRelations(
  dockerBashCall,
  dockerBashResult,
  dockerInteraction,
  [dockerBareChildExec],
  13,
  false,
);
assert.equal(dockerBashRelations[0].status, 'linked_exact');
assert.equal(dockerBashRelations[0].linkMethod, 'command');
assert.equal(dockerBashRelations[0].kernelEventId, dockerBareChildExec.eventId);
assert.equal(dockerBashRelations[0].lineageMethod, 'direct_runtime');
assert.equal(dockerBashRelations[0].confidence, 1);

const httpToolInteraction = {
  ...interaction,
  interactionType: 'tool',
  endpoint: 'python-sandbox:8080',
};
const httpToolCall = {
  ...toolCall,
  semanticEventId: 'se_http_tool_call',
  toolCallId: 'sandbox-execution-1',
  toolName: 'http.code.execute',
  toolKind: 'other',
  content: { code: 'print(42)', timeout_ms: 4_000 },
};
const sandboxEgress = {
  ...kernelEvent,
  eventId: 'evt_sandbox_egress',
  eventKind: 'Egress',
  subject: 'python-sandbox:8080',
  attributes: { host: 'python-sandbox' },
};
const httpToolRelations = buildSemanticKernelRelations(
  httpToolCall,
  toolResult,
  httpToolInteraction,
  [sandboxEgress],
  13,
  false,
);
assert.equal(httpToolRelations[0].status, 'linked_strong');
assert.equal(toolEvidenceHotPathTesting.semanticKernelEventCategory(httpToolCall), 'network');
assert.ok(['network', 'network_endpoint'].includes(httpToolRelations[0].linkMethod),
  'HTTP code tools without a matching ToolExec still keep the transport kernel witness');
assert.equal(httpToolRelations[0].kernelEventId, sandboxEgress.eventId);
const httpCodeExec = {
  ...kernelEvent,
  eventId: 'evt_http_code_exec',
  eventKind: 'ToolExec',
  subject: 'python -c print(42)',
  agentRuntimeInstanceId: 'docker:python-sandbox:exec',
  agentRuntimeInstanceAliases: [],
  attributes: { argv: 'python -c print(42)' },
  at: new Date(callAt + 40).toISOString(),
  attribution: {
    processGenerationKey: 'pgk_http_code_child',
    parentProcessGenerationKey: 'pgk_http_code_parent',
    parentLinkAuthority: 'forwarder_process_graph',
  },
};
const httpCodeDelegated = buildSemanticKernelRelations(
  httpToolCall,
  toolResult,
  httpToolInteraction,
  [sandboxEgress, httpCodeExec],
  13,
  false,
);
assert.equal(httpCodeDelegated[0].kernelEventKind, 'ToolExec',
  'HTTP tools that carry a code/command argument must prefer delegated ToolExec over transport Egress');
assert.equal(httpCodeDelegated[0].linkMethod, 'command');
assert.equal(httpCodeDelegated[0].lineageMethod, 'delegated_runtime');
assert.equal(httpCodeDelegated[0].kernelEventId, httpCodeExec.eventId);
const dnsCandidate = {
  ...sandboxEgress,
  eventId: 'evt_sandbox_dns',
  eventKind: 'Dns',
  subject: 'DNS python-sandbox',
  attributes: { query: 'python-sandbox.' },
};
const dnsRelations = buildSemanticKernelRelations(
  httpToolCall,
  toolResult,
  httpToolInteraction,
  [dnsCandidate],
  13,
  false,
);
assert.equal(dnsRelations[0].status, 'linked_strong',
  'a DNS query name is a valid normalized network candidate for an endpoint ToolCall');
assert.equal(dnsRelations[0].kernelEventId, dnsCandidate.eventId);

const sandboxCodeInteraction = {
  ...interaction,
  agentInstanceId: '3ad2de90-274a-4065-8219-675fbd3d81d9/3e6d88bdfd7e0e36f73bea1b4a1f11adf4dfbbc0e8af25598fa739cc9bf5e013',
  interactionType: 'tool',
  endpoint: 'http://python-sandbox:8080/execute',
};
const sandboxCodeCall = {
  ...toolCall,
  semanticEventId: 'se_sandbox_code_call',
  toolCallId: 'sandbox-langgraph-1',
  toolName: 'python_code_block_sandbox',
  toolKind: 'code',
  content: { code: 'print(42)', endpoint: 'http://python-sandbox:8080/execute' },
};
const sandboxCodeResult = {
  ...sandboxCodeCall,
  semanticEventId: 'se_sandbox_code_result',
  kind: 'tool_result',
  atUnixNs: String(BigInt(callAt + 400) * 1_000_000n),
  content: { exit_code: 0, stdout: '42\n' },
};
const sandboxCodeEgress = {
  ...kernelEvent,
  eventId: 'evt_sandbox_code_egress',
  eventKind: 'Egress',
  subject: 'egress → 10.43.62.211:8080',
  agentRuntimeInstanceId: sandboxCodeInteraction.agentInstanceId,
  agentRuntimeInstanceAliases: [sandboxCodeInteraction.agentInstanceId],
  attributes: { peer: '10.43.62.211', port: 8080 },
  at: new Date(callAt + 50).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
};
const sandboxRunnerExecEvent = {
  ...kernelEvent,
  eventId: 'evt_sandbox_runner_exec',
  eventKind: 'ToolExec',
  subject: '/usr/local/bin/python -I -S /app/sandbox/runner.py',
  agentRuntimeInstanceId: 'c3f4c93e-7991-4bc7-93e5-216d7fe0b396/4a60aad1e2f7dd87c8b74f87162b7b233ad93ba1a4fad563acf5c4272155b6ef',
  agentRuntimeInstanceAliases: [],
  attributes: { argv: '/usr/local/bin/python -I -S /app/sandbox/runner.py' },
  at: new Date(callAt + 80).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
  attribution: {
    ...(kernelEvent.attribution || {}),
    processGenerationKey: 'pgk_sandbox_runner_child',
    parentProcessGenerationKey: 'pgk_sandbox_runner_parent',
    parentLinkAuthority: 'forwarder_process_graph',
    agentScopeId: 'langgraph-python-sandbox',
  },
};
const sandboxDelegatedRelations = buildSemanticKernelRelations(
  sandboxCodeCall,
  sandboxCodeResult,
  sandboxCodeInteraction,
  [sandboxCodeEgress, sandboxRunnerExecEvent],
  17,
  false,
);
assert.equal(sandboxDelegatedRelations[0].status, 'linked_strong',
  'sandbox ToolExec ownership should win via delegated runtime when a network witness exists');
assert.equal(sandboxDelegatedRelations[0].linkMethod, 'command');
assert.equal(sandboxDelegatedRelations[0].lineageMethod, 'delegated_runtime');
assert.equal(sandboxDelegatedRelations[0].kernelEventId, sandboxRunnerExecEvent.eventId);
assert.equal(sandboxDelegatedRelations[0].kernelEventKind, 'ToolExec');

// LangGraph Design B: run_bash HTTP → remote echo ToolExec must outrank transport Egress.
const bashHttpInteraction = {
  ...interaction,
  interactionId: 'mi_bash_http_tool',
  interactionType: 'tool',
  endpoint: 'tool-mocks:18092/bash/execute',
  startedAtUnixNs: String(BigInt(callAt) * 1_000_000n),
};
const bashHttpCall = {
  ...toolCall,
  semanticEventId: 'se_bash_http_call',
  toolCallId: 'call_bash_echo',
  toolName: 'run_bash',
  toolKind: 'bash',
  content: { command: 'echo "Hello from worker"' },
  sourceInteractionIds: [bashHttpInteraction.interactionId],
};
const bashHttpResult = {
  ...bashHttpCall,
  semanticEventId: 'se_bash_http_result',
  kind: 'tool_result',
  atUnixNs: String(BigInt(callAt + 80) * 1_000_000n),
};
const bashHttpEgress = {
  ...kernelEvent,
  eventId: 'evt_bash_http_egress',
  eventKind: 'Egress',
  subject: 'egress → 172.29.0.2:18092',
  attributes: { peer: '172.29.0.2', port: 18092 },
  at: new Date(callAt + 10).toISOString(),
};
const bashHttpExec = {
  ...kernelEvent,
  eventId: 'evt_bash_http_echo_exec',
  eventKind: 'ToolExec',
  subject: 'echo Hello from worker',
  agentRuntimeInstanceId: 'docker:tool-mocks:echo',
  agentRuntimeInstanceAliases: [],
  attributes: { argv: 'echo "Hello from worker"' },
  at: new Date(callAt + 25).toISOString(),
  attribution: {
    processGenerationKey: 'pgk_echo_child',
    parentProcessGenerationKey: 'pgk_tool_mocks_parent',
    parentLinkAuthority: 'forwarder_process_graph',
  },
};
const bashHttpRelations = buildSemanticKernelRelations(
  bashHttpCall,
  bashHttpResult,
  bashHttpInteraction,
  [bashHttpEgress, bashHttpExec],
  21,
  false,
);
assert.equal(bashHttpRelations[0].kernelEventKind, 'ToolExec',
  'shell HTTP tools must prefer delegated command ToolExec over transport Egress');
assert.equal(bashHttpRelations[0].linkMethod, 'command');
assert.equal(bashHttpRelations[0].lineageMethod, 'delegated_runtime');
assert.equal(bashHttpRelations[0].kernelEventId, bashHttpExec.eventId);

const mcpHttpCall = {
  ...bashHttpCall,
  semanticEventId: 'se_mcp_http_call',
  toolCallId: 'call_mcp_weather',
  toolName: 'call_mcp_tool',
  toolKind: 'mcp',
  content: { name: 'get_weather', arguments: { city: 'Beijing' } },
};
const mcpHttpResult = {
  ...mcpHttpCall,
  semanticEventId: 'se_mcp_http_result',
  kind: 'tool_result',
  atUnixNs: String(BigInt(callAt + 90) * 1_000_000n),
};
const mcpHttpRelations = buildSemanticKernelRelations(
  mcpHttpCall,
  mcpHttpResult,
  bashHttpInteraction,
  [bashHttpEgress],
  22,
  false,
);
assert.equal(mcpHttpRelations[0].kernelEventKind, 'Egress',
  'MCP HTTP tools correctly use network_effect when no local exec exists');
assert.equal(mcpHttpRelations[0].linkMethod, 'network_endpoint');

const resolvedServiceEgress = {
  ...sandboxEgress,
  eventId: 'evt_sandbox_cluster_ip_egress',
  subject: 'egress → 10.43.62.211:8080',
  attributes: { peer: '10.43.62.211', port: 8080 },
};
const resolvedServiceRelations = buildSemanticKernelRelations(
  httpToolCall,
  toolResult,
  httpToolInteraction,
  [resolvedServiceEgress],
  13,
  false,
);
assert.equal(resolvedServiceRelations[0].status, 'linked_strong');
assert.equal(resolvedServiceRelations[0].linkMethod, 'network_endpoint');
assert.equal(resolvedServiceRelations[0].kernelEventId, resolvedServiceEgress.eventId);

// Dify-style Host-only TLS tool endpoints omit :443. A sibling LLM Egress on the same port must
// not steal the Tool→Kernel edge when the Tool call is uniquely nearer the tool mock peer.
const hostOnlyTlsToolInteraction = {
  ...interaction,
  interactionType: 'tool',
  endpoint: 'tool-mock/',
  captureSource: 'tls_uprobe',
  transport: 'tls',
};
const hostOnlyTlsToolCall = {
  ...toolCall,
  semanticEventId: 'se_dify_http_tool_call',
  toolCallId: 'tool_dify_http_1',
  toolName: 'http.request',
  toolKind: 'other',
  content: { instruction: 'ping', requested_by: 'dify-observation-lab' },
  atUnixNs: String(BigInt(callAt + 1_000) * 1_000_000n),
};
const hostOnlyTlsToolResult = {
  ...hostOnlyTlsToolCall,
  semanticEventId: 'se_dify_http_tool_result',
  kind: 'tool_result',
  atUnixNs: String(BigInt(callAt + 1_200) * 1_000_000n),
};
const llmMockEgress = {
  ...kernelEvent,
  eventId: 'evt_llm_mock_egress',
  eventKind: 'Egress',
  at: new Date(callAt + 100).toISOString(),
  subject: 'egress → 172.27.0.12:443',
  attributes: { peer: '172.27.0.12', port: 443, sni: 'llm-mock' },
  kernelFactId: 'kf_llm_mock',
};
const toolMockEgress = {
  ...kernelEvent,
  eventId: 'evt_tool_mock_egress',
  eventKind: 'Egress',
  at: new Date(callAt + 1_050).toISOString(),
  subject: 'egress → 172.27.0.13:443',
  attributes: { peer: '172.27.0.13', port: 443 },
  kernelFactId: 'kf_tool_mock',
};
const hostOnlyTlsRelations = buildSemanticKernelRelations(
  hostOnlyTlsToolCall,
  hostOnlyTlsToolResult,
  hostOnlyTlsToolInteraction,
  [llmMockEgress, toolMockEgress],
  13,
  false,
);
assert.equal(hostOnlyTlsRelations[0].status, 'linked_strong',
  'Host-only TLS tool endpoints must still link to the nearest same-port Egress');
assert.equal(hostOnlyTlsRelations[0].linkMethod, 'network_endpoint');
assert.equal(hostOnlyTlsRelations[0].kernelEventId, toolMockEgress.eventId);
assert.equal(hostOnlyTlsRelations[0].kernelFactId, toolMockEgress.kernelFactId);

// Authenticated OTLP semantic Tool spans stay in the legacy model interaction lane for timeline
// compatibility, but their explicit semanticOnly ToolCall must still provide a network endpoint
// hint to the shared correlation algorithm.
const semanticOnlyHttpInteraction = {
  ...httpToolInteraction,
  interactionType: 'model',
  semanticOnly: true,
  toolCalls: [httpToolCall],
};
const semanticOnlyHttpRelations = buildSemanticKernelRelations(
  httpToolCall,
  toolResult,
  semanticOnlyHttpInteraction,
  [resolvedServiceEgress],
  13,
  false,
);
assert.equal(semanticOnlyHttpRelations[0].status, 'linked_strong');
assert.equal(semanticOnlyHttpRelations[0].linkMethod, 'network_endpoint');
assert.equal(semanticOnlyHttpRelations[0].kernelEventId, resolvedServiceEgress.eventId);
assert.equal(semanticOnlyHttpRelations[0].authority, 'authenticated_adapter',
  'OTLP/application semantic evidence must not be mislabeled as TLS plaintext');
const placeholderEndpointInteraction = {
  ...semanticOnlyHttpInteraction,
  endpoint: 'application://semantic-event',
};
const placeholderEndpointCandidate = {
  ...resolvedServiceEgress,
  eventId: 'evt_semantic_event_placeholder_host',
  subject: 'egress → semantic-event:8080',
  attributes: { host: 'semantic-event', port: 8080 },
};
const placeholderEndpointRelations = buildSemanticKernelRelations(
  httpToolCall,
  toolResult,
  placeholderEndpointInteraction,
  [placeholderEndpointCandidate],
  13,
  false,
);
assert.equal(placeholderEndpointRelations[0].status, 'semantic_only',
  'the application:// placeholder must not be treated as a network endpoint');
assert.equal(placeholderEndpointRelations[0].kernelEventId, undefined,
  'a same-named Egress cannot satisfy a missing semantic endpoint');
const placeholderContentCall = {
  ...httpToolCall,
  semanticEventId: 'se_semantic_placeholder_content',
  content: { url: 'application://semantic-event' },
};
const placeholderContentRelations = buildSemanticKernelRelations(
  placeholderContentCall,
  toolResult,
  { ...semanticOnlyHttpInteraction, endpoint: 'unknown' },
  [placeholderEndpointCandidate],
  13,
  false,
);
assert.equal(placeholderContentRelations[0].status, 'semantic_only',
  'non-network tool URL schemes must not become endpoint correlation hints');
assert.equal(placeholderContentRelations[0].kernelEventId, undefined);
const singleSlashPlaceholderRelations = buildSemanticKernelRelations(
  { ...placeholderContentCall, semanticEventId: 'se_semantic_single_slash', content: { url: 'application:/semantic-event' } },
  toolResult,
  { ...semanticOnlyHttpInteraction, endpoint: 'unknown' },
  [{ ...placeholderEndpointCandidate, eventId: 'evt_application_host', attributes: { host: 'application', port: 80 } }],
  13,
  false,
);
assert.equal(singleSlashPlaceholderRelations[0].status, 'semantic_only',
  'single-slash non-network URI schemes must not become endpoint correlation hints');
assert.equal(singleSlashPlaceholderRelations[0].kernelEventId, undefined);
const sameHostWrongPort = {
  ...resolvedServiceEgress,
  eventId: 'evt_same_host_wrong_port',
  subject: 'egress → python-sandbox:9090',
  attributes: { host: 'python-sandbox', port: 9090 },
};
const sameHostWrongPortRelations = buildSemanticKernelRelations(
  httpToolCall,
  toolResult,
  httpToolInteraction,
  [sameHostWrongPort],
  13,
  false,
);
assert.equal(sameHostWrongPortRelations[0].status, 'semantic_only',
  'an explicit endpoint port must reject a same-host Egress on a different port');
const ambiguousServiceEndpoint = buildSemanticKernelRelations(
  httpToolCall,
  toolResult,
  httpToolInteraction,
  [
    resolvedServiceEgress,
    { ...resolvedServiceEgress, eventId: 'evt_second_cluster_ip_egress' },
  ],
  13,
  false,
);
assert.equal(ambiguousServiceEndpoint.length, 2);
assert(ambiguousServiceEndpoint.every((relation) => relation.status === 'ambiguous'));
assert(ambiguousServiceEndpoint.every((relation) => relation.competingKernelEventIds?.length === 2));

const shellBootstrapEvent = {
  ...kernelEvent,
  eventId: 'evt_shell_bootstrap',
  at: new Date(callAt + 200).toISOString(),
  subject: '/bin/bash -c source /tmp/agent-shell-snapshot',
  process: {
    pid: 101,
    ppid: 100,
    comm: 'bash',
    hostId: 'host-semantic',
    bootId: 'boot-semantic',
  },
  attribution: { rootPid: 100 },
};
const shellBootstrapRelations = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [shellBootstrapEvent],
  13,
  false,
);
assert.equal(shellBootstrapRelations[0].status, 'linked_strong');
assert.equal(toolEvidenceHotPathTesting.semanticKernelEventCategory(toolCall), 'tool');
assert.equal(shellBootstrapRelations[0].linkMethod, 'shell_bootstrap');
assert.equal(shellBootstrapRelations[0].lineageMethod, 'direct_runtime');
assert.equal(shellBootstrapRelations[0].confidence, 0.95);
assert.equal(shellBootstrapRelations[0].kernelEventId, shellBootstrapEvent.eventId);

const customLocalToolCall = {
  ...toolCall,
  semanticEventId: 'se_custom_local_probe',
  toolCallId: 'call-inventory-fingerprint',
  toolName: 'inventory_fingerprint',
  toolKind: 'custom',
  // Intentionally no cmd/command/path/url/marker — pure undeclared custom tool shape.
  content: { task: 'undeclared-custom-fingerprint' },
};
const customLocalToolResult = {
  ...customLocalToolCall,
  semanticEventId: 'se_custom_local_probe_result',
  kind: 'tool_result',
  atUnixNs: String(BigInt(callAt + 500) * 1_000_000n),
  content: { ok: true, task: 'undeclared-custom-fingerprint', stdout: 'lab-local-probe-v1\n' },
};
const customLocalExec = {
  ...kernelEvent,
  eventId: 'evt_custom_local_echo',
  at: new Date(callAt + 120).toISOString(),
  subject: '/bin/echo lab-local-probe-v1',
  process: {
    pid: 220,
    ppid: 100,
    comm: 'echo',
    hostId: 'host-semantic',
    bootId: 'boot-semantic',
  },
  attribution: { rootPid: 100 },
  attributes: {
    argv: '/bin/echo lab-local-probe-v1',
    argv_truncated: false,
    argv_incomplete: false,
  },
};
const processLineageRelations = buildSemanticKernelRelations(
  customLocalToolCall,
  customLocalToolResult,
  interaction,
  [customLocalExec],
  14,
  false,
);
assert.equal(processLineageRelations[0].status, 'linked_strong',
  'undeclared custom tools must link the unique Agent-root child ToolExec by process lineage');
assert.equal(processLineageRelations[0].linkMethod, 'process_lineage');
assert.equal(processLineageRelations[0].lineageMethod, 'direct_runtime');
assert.equal(processLineageRelations[0].kernelEventId, customLocalExec.eventId);
assert.equal(
  canonicalEvidenceLinksForRelations(processLineageRelations)[0].method,
  'process_generation',
);

const markerToolCall = {
  ...customLocalToolCall,
  semanticEventId: 'se_custom_local_marker',
  toolCallId: 'call-inventory-fingerprint-marker',
  content: { marker: 'lab-local-probe-v1' },
};
const markerToolResult = {
  ...markerToolCall,
  semanticEventId: 'se_custom_local_marker_result',
  kind: 'tool_result',
  atUnixNs: String(BigInt(callAt + 500) * 1_000_000n),
  content: { ok: true, marker: 'lab-local-probe-v1', stdout: 'lab-local-probe-v1\n' },
};
const markerBoosted = buildSemanticKernelRelations(
  markerToolCall,
  markerToolResult,
  interaction,
  [
    {
      ...customLocalExec,
      eventId: 'evt_healthcheck_noise',
      subject: "python -c import urllib.request; urllib.request.urlopen('http://127.0.0.1:18091/healthz')",
      attributes: {
        argv: "python -c import urllib.request; urllib.request.urlopen('http://127.0.0.1:18091/healthz')",
        argv_truncated: false,
        argv_incomplete: false,
      },
    },
    customLocalExec,
  ],
  14,
  false,
);
assert.equal(markerBoosted.length, 1);
assert.equal(markerBoosted[0].linkMethod, 'command',
  'opaque marker containment must outrank unrelated same-runtime helper execs');
assert.equal(markerBoosted[0].kernelEventId, customLocalExec.eventId);

const ambiguousProcessLineage = buildSemanticKernelRelations(
  customLocalToolCall,
  customLocalToolResult,
  interaction,
  [
    customLocalExec,
    { ...customLocalExec, eventId: 'evt_second_custom_local_echo', process: { ...customLocalExec.process, pid: 221 } },
  ],
  14,
  false,
);
assert.equal(ambiguousProcessLineage.length, 2);
assert(ambiguousProcessLineage.every((relation) => relation.status === 'ambiguous'));

const wrongRuntimeProcessLineage = buildSemanticKernelRelations(
  customLocalToolCall,
  customLocalToolResult,
  interaction,
  [{ ...customLocalExec, eventId: 'evt_wrong_runtime_echo', agentRuntimeInstanceId: 'host-root:other:9:9' }],
  14,
  false,
);
assert.equal(wrongRuntimeProcessLineage[0].status, 'semantic_only',
  'process_lineage must still require same Agent runtime');

const ambiguousShellBootstrap = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [
    shellBootstrapEvent,
    { ...shellBootstrapEvent, eventId: 'evt_second_shell_bootstrap' },
  ],
  13,
  false,
);
assert.equal(ambiguousShellBootstrap.length, 2);
assert(ambiguousShellBootstrap.every((relation) => relation.status === 'ambiguous'));
assert(ambiguousShellBootstrap.every((relation) => relation.competingKernelEventIds?.length === 2),
  'multiple direct-child shells must retain all candidates without choosing one');

const timeOnly = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [{ ...unrelated, eventId: 'evt_time_only' }],
  14,
  false,
);
assert.equal(timeOnly.length, 1);
assert.equal(timeOnly[0].status, 'semantic_only',
  'time and Runtime identity alone must never invent a Kernel relation');
assert.equal(timeOnly[0].kernelEventId, undefined);

const coverageGap = buildSemanticKernelRelations(
  toolCall,
  toolResult,
  interaction,
  [],
  15,
  true,
);
assert.equal(coverageGap[0].status, 'coverage_gap');
assert.equal(
  canonicalEvidenceLinksForRelations(coverageGap)[0].linkId,
  coverageGap[0].evidenceLinkId,
  'unmatched/coverage-gap relation and canonical EvidenceLink must share one stable edge identity',
);

const earlierCompetingCall = {
  ...toolCall,
  semanticEventId: 'se_earlier_competing_call',
  toolCallId: 'call-earlier-competing',
  atUnixNs: String(BigInt(callAt - 10_000) * 1_000_000n),
};
const earlierCompetingResult = {
  ...toolResult,
  semanticEventId: 'se_earlier_competing_result',
  toolCallId: earlierCompetingCall.toolCallId,
  atUnixNs: String(BigInt(callAt + 100) * 1_000_000n),
};
const batchWindow = semanticKernelRelationBatchWindow([
  { event: earlierCompetingCall, result: earlierCompetingResult, interaction },
  { event: toolCall, result: toolResult, interaction },
], { event: toolCall, result: toolResult, interaction });
assert.equal(batchWindow.startMs, callAt - 12_000);
assert.equal(batchWindow.endMs, callAt + 2_500,
  'a replacement batch must query the full union of every competing Tool interval');

const shellParent = {
  ...kernelEvent,
  eventId: 'evt_shell_parent',
  subject: '/bin/bash -c source shell-snapshot',
  correlation: { authority: 'server_process_graph', inferred: false },
  attribution: { processGenerationKey: `pgk_${'a'.repeat(24)}` },
  process: {
    pid: 220, ppid: 100, hostId: 'host-semantic', bootId: 'boot-semantic',
    startTimeTicks: '2200',
  },
};
const externalChild = {
  ...kernelEvent,
  eventId: 'evt_external_child',
  subject: '/usr/bin/printf ancestry-marker',
  agentRuntimeInstanceId: 'docker:physical-workload',
  correlation: { authority: 'server_process_graph', inferred: false },
  attribution: {
    processGenerationKey: `pgk_${'b'.repeat(24)}`,
    parentProcessGenerationKey: shellParent.attribution.processGenerationKey,
    parentLinkAuthority: 'forwarder_process_graph',
  },
  process: {
    pid: 221, ppid: 220, hostId: 'host-semantic', bootId: 'boot-semantic',
    startTimeTicks: '2210',
  },
};
const ancestryCall = {
  ...toolCall,
  semanticEventId: 'se_ancestry_tool',
  toolCallId: 'call-ancestry',
  content: { command: '/usr/bin/printf ancestry-marker' },
};
const ancestryRelations = buildSemanticKernelRelations(
  ancestryCall,
  toolResult,
  interaction,
  [externalChild, shellParent],
  16,
  false,
);
assert.equal(ancestryRelations[0].status, 'linked_strong');
assert.equal(ancestryRelations[0].confidence, 0.99);
assert.equal(ancestryRelations[0].kernelEventId, externalChild.eventId);
assert.equal(ancestryRelations[0].linkMethod, 'command');
assert.equal(ancestryRelations[0].lineageMethod, 'generation_parent');

const reusedOldParent = {
  ...shellParent,
  eventId: 'evt_reused_old_parent',
  attribution: { processGenerationKey: `pgk_${'c'.repeat(24)}` },
  process: { ...shellParent.process, startTimeTicks: '1000' },
};
const reusedNewParent = {
  ...shellParent,
  eventId: 'evt_reused_new_parent',
  agentRuntimeInstanceId: 'runtime-unrelated',
  attribution: { processGenerationKey: `pgk_${'d'.repeat(24)}` },
  process: { ...shellParent.process, startTimeTicks: '2000' },
};
const reusedPidChild = {
  ...externalChild,
  eventId: 'evt_child_of_reused_parent',
  agentRuntimeInstanceId: 'runtime-unrelated',
  attribution: {
    processGenerationKey: `pgk_${'e'.repeat(24)}`,
    parentProcessGenerationKey: reusedNewParent.attribution.processGenerationKey,
    parentLinkAuthority: 'forwarder_process_graph',
  },
  process: { ...externalChild.process, startTimeTicks: '2001' },
};
const reusedPidRelations = buildSemanticKernelRelations(
  ancestryCall,
  toolResult,
  interaction,
  [reusedPidChild, reusedOldParent, reusedNewParent],
  17,
  false,
);
assert.equal(reusedPidRelations[0].status, 'semantic_only');
assert.equal(reusedPidRelations[0].kernelEventId, undefined,
  'an old same-PID Agent parent must not own a child of the reused parent generation');

const unauthoritativeParentRelations = buildSemanticKernelRelations(
  ancestryCall,
  toolResult,
  interaction,
  [{
    ...externalChild,
    eventId: 'evt_external_child_without_parent_authority',
    attribution: {
      processGenerationKey: externalChild.attribution.processGenerationKey,
      parentProcessGenerationKey: externalChild.attribution.parentProcessGenerationKey,
    },
  }, shellParent],
  18,
  false,
);
assert.equal(unauthoritativeParentRelations[0].status, 'semantic_only');
assert.equal(unauthoritativeParentRelations[0].kernelEventId, undefined,
  'a parent generation key without its graph authority must not become ancestry evidence');

const duplicateCallA = {
  ...ancestryCall,
  semanticEventId: 'se_duplicate_call_a',
  toolCallId: 'call-duplicate-a',
};
const duplicateCallB = {
  ...ancestryCall,
  semanticEventId: 'se_duplicate_call_b',
  toolCallId: 'call-duplicate-b',
};
const duplicateKernelEvent = {
  ...kernelEvent,
  eventId: 'evt_one_exec_two_tools',
  subject: '/usr/bin/printf ancestry-marker',
};
const duplicateBatch = buildSemanticKernelRelationBatch([
  { event: duplicateCallA, result: toolResult, interaction },
  { event: duplicateCallB, result: toolResult, interaction },
], [duplicateKernelEvent], 19, false);
const duplicateRelationsA = duplicateBatch.relationsBySemanticEventId.get(duplicateCallA.semanticEventId);
const duplicateRelationsB = duplicateBatch.relationsBySemanticEventId.get(duplicateCallB.semanticEventId);
assert.equal(duplicateRelationsA?.[0].status, 'ambiguous');
assert.equal(duplicateRelationsB?.[0].status, 'ambiguous');
assert.equal(duplicateRelationsA?.[0].kernelEventId, duplicateKernelEvent.eventId);
assert.equal(duplicateRelationsA?.[0].risk, undefined);
assert.deepEqual(
  duplicateRelationsA?.[0].competingToolInvocationIds,
  duplicateRelationsB?.[0].competingToolInvocationIds,
);
assert.equal(duplicateRelationsA?.[0].competingToolInvocationIds?.length, 2);

const replacementQueries = [];
let replacementParameters;
const relationStore = Object.create(RelationalBusinessStore.prototype);
relationStore.initialize = async () => true;
const replacementClient = {
  query: async (sql, parameters) => {
    replacementQueries.push(String(sql));
    if (parameters) replacementParameters = parameters;
    return { rows: [] };
  },
  release: () => undefined,
};
relationStore.pool = {
  connect: async () => replacementClient,
};
relationStore.markUnavailable = () => undefined;
assert.equal(await relationStore.saveAgentSemanticKernelRelations(duplicateBatch.allRelations), true);
assert(replacementQueries.some((query) => /relation_history_v1/u.test(query)),
  'relation revisions must be appended to the immutable history table');
assert(replacementQueries.some((query) => /ON CONFLICT \(relation_id, resolution_revision\) DO NOTHING/u.test(query)));
assert(replacementQueries.some((query) => /ON CONFLICT \(relation_id\) DO UPDATE/u.test(query)),
  'the legacy relation table is only a latest-row compatibility projection');
assert(!replacementQueries.some((query) => /DELETE FROM anysentry_agent_semantic_kernel_relations_v1/u.test(query)),
  'relation history must never be pruned in place');
assert.equal(JSON.parse(replacementParameters[0]).length, 2,
  'one transaction must atomically append both competing semantic relation sets');

const captured = (structured, messages = [], text) => {
  const body = JSON.stringify(structured);
  return {
    body,
    encoding: 'utf8',
    contentType: 'application/json',
    capturedBytes: Buffer.byteLength(body),
    decodedBytes: Buffer.byteLength(body),
    sha256: 'a'.repeat(64),
    completeness: 'complete',
    messages,
    structured,
    ...(text === undefined ? {} : { text }),
  };
};
const projectedInteraction = {
  schemaVersion: 'anysentry.agent_interaction.v1',
  interactionId: 'mi_incremental_relation_projection',
  interactionType: 'model',
  at: callAt,
  workspacePath: '/workspace',
  agentAssetId: 'agent-semantic',
  agentInstanceId: instanceId,
  agentProduct: 'Codex',
  detectedClassification: 'confirmed_agent',
  currentEffectiveClassification: 'confirmed_agent',
  process: {
    hostId: 'host-semantic', bootId: 'boot-semantic', pid: 100, ppid: 1,
    startTimeTicks: '200', comm: 'codex', exe: '/usr/bin/codex', cwd: '/workspace',
  },
  connectionId: 'tls:incremental',
  transport: 'tls',
  protocol: 'websocket-json',
  wireTemplateId: 'openai-responses',
  parseState: 'parsed',
  llmLikelihood: 'confirmed',
  endpoint: 'gateway.invalid',
  method: 'POST',
  path: '/responses',
  statusCode: 200,
  model: 'fixture-model',
  startedAtUnixNs: String(BigInt(callAt) * 1_000_000n),
  requestCompleteAtUnixNs: String(BigInt(callAt + 1) * 1_000_000n),
  firstResponseAtUnixNs: String(BigInt(callAt + 2) * 1_000_000n),
  endedAtUnixNs: String(BigInt(callAt + 3) * 1_000_000n),
  durationNs: '3000000',
  timeQuality: 'collector_calibrated',
  request: captured(
    { model: 'fixture-model', input: [{ role: 'user', content: 'run the command' }] },
    [{ role: 'user', content: 'run the command', messageOrigin: 'human_input' }],
  ),
  response: captured({
    id: 'resp-incremental', object: 'response', status: 'completed', output: [],
  }),
  toolCalls: [{
    toolCallId: toolCall.toolCallId,
    name: 'exec_command',
    arguments: toolCall.content,
    issuedAtUnixNs: toolCall.atUnixNs,
  }],
  toolResults: [],
  semanticParserId: 'observer.agent-interaction',
  semanticParserVersion: 2,
  completeness: 'partial',
  conversationCompleteness: 'tool_pending',
  partialReasons: ['tool_result_pending'],
  captureSource: 'tls_uprobe_rustls',
  receivedAt: callAt + 4,
};

const fastConversationId = 'cv_persisted_evidence_fast_path';
const fastInteraction = {
  ...projectedInteraction,
  conversationId: fastConversationId,
  conversationIdSource: 'provider',
  conversationBindingVersion: 2,
  trafficRole: 'conversation',
};
const fastQuery = {
  timeType: 'last_30d',
  scope: 'agent',
  classificationView: 'current_effective',
  conversationId: fastConversationId,
  limit: 200,
};
const fastProjection = projectAgentConversations([fastInteraction], [], fastQuery);
const fastThread = fastProjection.summaries.find((item) =>
  item.conversationId === fastConversationId);
const fastRecords = fastProjection.interactionsByConversation.get(fastConversationId) ?? [];
assert.ok(fastThread?.hasContent);
const fastToolCall = projectSemanticConversationTimeline(fastThread, fastRecords, [])
  .flatMap((turn) => turn.events)
  .find((event) => event.kind === 'tool_call');
assert.ok(fastToolCall);
const persistedFastRelation = {
  ...relations[0],
  relationId: 'skr_persisted_fast_path',
  stableSemanticEventId: fastToolCall.semanticEventId,
  conversationId: fastConversationId,
  turnId: fastToolCall.turnId,
  toolInvocationId: 'ti_persisted_fast_path',
  resolutionRevision: 99,
};
let fastKernelQueries = 0;
const fastEvidenceAggregate = new AggregationService(
  {},
  {
    identitySnapshotVersion: () => 0,
    canonicalAgentAssetId: (value) => value,
  },
  {},
  {},
  {},
  undefined,
  {
    segmentsForConversation: () => [],
    currentResolutionRevision: () => 99,
  },
  {
    configured: () => true,
    loadAgentSemanticKernelRelations: async () => [persistedFastRelation],
  },
);
fastEvidenceAggregate.agentConversationProjection = async () => ({
  projection: fastProjection,
  interactions: {
    items: [fastInteraction],
    coverage: {
      partial: false,
      completeness: 'exact_current_effective',
      source: 'clickhouse+hot_delta',
      totalMode: 'exact',
    },
  },
  inventory: { items: [], coverage: { partial: true, partialReason: 'hot_ring_only' } },
  canonicalConversationId: fastConversationId,
});
fastEvidenceAggregate.storedAgentEvents = async () => {
  fastKernelQueries += 1;
  throw new Error('persisted evidence fast path must not query the Event table');
};
const fastEvidence = await fastEvidenceAggregate.agentSemanticEvidence({
  ...fastQuery,
  semanticEventId: fastToolCall.semanticEventId,
});
assert.equal(fastKernelQueries, 0);
assert.equal(fastEvidence.relationStatus, 'linked_exact');
assert.equal(fastEvidence.relations[0].kernelEventId, kernelEvent.eventId);
assert.deepEqual(fastEvidence.kernelEvents, []);
assert.deepEqual(fastEvidence.evidenceBundleEventIds, [kernelEvent.eventId]);
assert.equal(fastEvidence.coverage.partial, false);

let projectionPersisted = 0;
let incrementallySavedRelations = [];
const incrementalKernelQueries = [];
const bindingStub = {
  applyPersistedBindings: async (items) => items,
  persistProjection: async () => { projectionPersisted += 1; },
  segmentsForConversation: () => [],
  currentResolutionRevision: () => 22,
};
const incrementalStore = {
  configured: () => true,
  saveAgentSemanticKernelRelations: async (items) => {
    incrementallySavedRelations = items;
    return true;
  },
};
const aggregate = new AggregationService(
  {},
  { canonicalAgentAssetId: (value) => value },
  {},
  {},
  {},
  undefined,
  bindingStub,
  incrementalStore,
);
const staleProjectedInteraction = {
  ...projectedInteraction,
  interactionId: 'mi_stale_incremental_relation_projection',
  at: callAt - 20 * 60_000,
  startedAtUnixNs: String(BigInt(callAt - 20 * 60_000) * 1_000_000n),
  requestCompleteAtUnixNs: String(BigInt(callAt - 20 * 60_000 + 1) * 1_000_000n),
  firstResponseAtUnixNs: String(BigInt(callAt - 20 * 60_000 + 2) * 1_000_000n),
  endedAtUnixNs: String(BigInt(callAt - 20 * 60_000 + 3) * 1_000_000n),
  receivedAt: callAt - 20 * 60_000 + 4,
  toolCalls: [{
    toolCallId: 'call-stale-incremental',
    name: 'exec_command',
    arguments: { cmd: 'printf stale-incremental-command' },
    issuedAtUnixNs: String(BigInt(callAt - 20 * 60_000 + 2) * 1_000_000n),
  }],
};
aggregate.readAgentInteractions = async () => ({
  items: [staleProjectedInteraction, projectedInteraction],
  total: 1,
  totalMode: 'exact',
  coverage: { partial: false },
  dataSource: 'clickhouse',
  updateTime: new Date(callAt).toISOString(),
});
aggregate.storedAgentEvents = async (query) => {
  incrementalKernelQueries.push(query);
  return {
    items: [kernelEvent],
    total: 1,
    totalMode: 'exact',
    coverage: { partial: false },
    dataSource: 'clickhouse',
    updateTime: new Date(callAt).toISOString(),
  };
};
await aggregate.projectSemanticKernelRelationsFor(projectedInteraction);
assert.equal(projectionPersisted, 1,
  'incremental relation work must persist the Conversation projection outside the read path');
assert.equal(incrementallySavedRelations.length, 1);
assert.equal(incrementallySavedRelations[0].kernelEventId, kernelEvent.eventId);
assert.equal(incrementallySavedRelations[0].kernelEventAt, kernelEvent.at);
assert.equal(incrementalKernelQueries.length, 1,
  'a trigger-local exact match must not require the unscoped ancestry fallback');
assert.equal(incrementalKernelQueries[0].eventCategory, 'tool');
assert.ok(Date.parse(incrementalKernelQueries[0].startTime) >= callAt - 5_000,
  'a stale Tool call in the hydration window must not widen incremental Kernel evidence work');

// Read/query paths must remain pure. Relation materialization is ingest-owned; a selected Tool
// evidence read may not write a compatibility relation as a hidden side effect.
const controllerSource = readFileSync(
  new URL('../apps/api/src/security-monitoring/security-monitoring.controller.ts', import.meta.url),
  'utf8',
);
const toolEvidenceStart = controllerSource.indexOf("@Post('events/tool-evidence')");
const toolEvidenceEnd = controllerSource.indexOf("@Post('context/system')", toolEvidenceStart);
assert(toolEvidenceStart >= 0 && toolEvidenceEnd > toolEvidenceStart,
  'tool evidence controller region is present');
assert.doesNotMatch(
  controllerSource.slice(toolEvidenceStart, toolEvidenceEnd),
  /writeStoredToolEvidenceRelations/iu,
  'tool evidence reads must not materialize relations',
);

const relationalSource = readFileSync(
  new URL('../apps/api/src/security-monitoring/relational-business-store.service.ts', import.meta.url),
  'utf8',
);
const relationWriterStart = relationalSource.indexOf('async saveAgentSemanticKernelRelations(');
const relationWriterEnd = relationalSource.indexOf('async loadIncidents(', relationWriterStart);
assert(relationWriterStart >= 0 && relationWriterEnd > relationWriterStart,
  'semantic-kernel relation writer source region is present');
const relationWriter = relationalSource.slice(relationWriterStart, relationWriterEnd);
assert.match(relationWriter, /SEMANTIC_KERNEL_RELATION_MAX_ROWS/iu,
  'relation persistence has an explicit row bound');
assert.match(relationWriter, /SEMANTIC_KERNEL_RELATION_MAX_BYTES/iu,
  'relation persistence has an explicit byte bound');
assert.match(relationWriter, /batchHasConflictingRecords/iu,
  'one incoming batch cannot contain two payloads for the same relation revision');

const todoCall = {
  ...toolCall,
  semanticEventId: 'se_write_todos_call',
  toolCallId: 'call-write-todos',
  toolName: 'write_todos',
  toolKind: 'write',
  content: { todos: [{ content: 'plan work', status: 'pending' }] },
};
const strayTodoFile = {
  ...kernelEvent,
  eventId: 'evt_todo_file_noise',
  eventKind: 'FileAccess',
  subject: 'file /tmp/unrelated.txt',
};
const todoUnlinked = buildSemanticKernelRelations(
  todoCall,
  undefined,
  interaction,
  [strayTodoFile],
  40,
  true,
);
assert.equal(todoUnlinked[0].status, 'semantic_only',
  'in-memory plan tools stay semantic_only even when the kernel page is partial');
assert.equal(todoUnlinked[0].kernelEventId, undefined,
  'write_todos must not invent a FileAccess link');

const lookupCall = {
  ...toolCall,
  semanticEventId: 'se_lookup_fixture_call',
  toolCallId: 'call-lookup-fixture',
  toolName: 'lookup_fixture',
  toolKind: 'lookup',
  content: { key: 'canary' },
};
const lookupUnlinked = buildSemanticKernelRelations(
  lookupCall,
  undefined,
  interaction,
  [strayTodoFile],
  41,
  true,
);
assert.equal(lookupUnlinked[0].status, 'semantic_only',
  'in-process lookup tools stay semantic_only when no kernel-shaped payload is observed');
assert.equal(lookupUnlinked[0].kernelEventId, undefined,
  'lookup_fixture must not invent a FileAccess link');

const codeAt = callAt + 80_000;
const executeInteraction = {
  ...interaction,
  interactionId: 'mi_http_execute',
  interactionType: 'tool',
  agentInstanceId: instanceId,
  runtimeInstanceId: instanceId,
  endpoint: 'python-sandbox:8080',
  startedAtUnixNs: String(BigInt(codeAt) * 1_000_000n),
};
const modelAliasInteraction = {
  ...interaction,
  interactionId: 'mi_llm_run_python',
  interactionType: 'model',
  agentInstanceId: instanceId,
  runtimeInstanceId: instanceId,
  endpoint: 'llm.example:443',
  startedAtUnixNs: String(BigInt(codeAt - 40) * 1_000_000n),
};
const executeCall = {
  ...toolCall,
  semanticEventId: 'se_http_execute',
  conversationId: 'cv_alias_fold',
  turnId: 'turn_alias',
  toolCallId: 'sandbox-run-1',
  toolName: 'http.code.execute',
  toolKind: 'code',
  content: { code: 'print(8 + 9)', timeout_ms: 4000 },
  atUnixNs: String(BigInt(codeAt) * 1_000_000n),
  sourceInteractionIds: [executeInteraction.interactionId],
};
const runPythonCall = {
  ...executeCall,
  semanticEventId: 'se_run_python_alias',
  toolCallId: 'call-run-python',
  toolName: 'run_python',
  toolKind: 'code',
  content: { code: 'print(8 + 9)' },
  atUnixNs: String(BigInt(codeAt - 40) * 1_000_000n),
  sourceInteractionIds: [modelAliasInteraction.interactionId],
};
const aliasSandboxEgress = {
  ...kernelEvent,
  eventId: 'evt_alias_sandbox_egress',
  eventKind: 'Egress',
  at: new Date(codeAt + 8).toISOString(),
  subject: 'egress → python-sandbox:8080',
  agentRuntimeInstanceId: instanceId,
  agentRuntimeInstanceAliases: [instanceId],
  attributes: { host: 'python-sandbox', port: 8080 },
  verdict: 'allow',
  riskScore: 0,
};
const aliasBatch = buildSemanticKernelRelationBatch([
  { event: runPythonCall, result: undefined, interaction: modelAliasInteraction },
  { event: executeCall, result: undefined, interaction: executeInteraction },
], [aliasSandboxEgress], 41, false);
const executeLinked = aliasBatch.relationsBySemanticEventId.get(executeCall.semanticEventId);
const aliasLinked = aliasBatch.relationsBySemanticEventId.get(runPythonCall.semanticEventId);
assert.equal(executeLinked?.[0].status, 'linked_strong');
assert.equal(executeLinked?.[0].kernelEventId, aliasSandboxEgress.eventId);
assert.equal(aliasLinked?.[0].status, 'linked_strong',
  'LLM tool names must fold onto the wire/kernel owner by code fingerprint');
assert.equal(aliasLinked?.[0].kernelEventId, aliasSandboxEgress.eventId);
assert.notEqual(aliasLinked?.[0].toolInvocationId, executeLinked?.[0].toolInvocationId);

console.log('Agent Semantic Tool to Kernel relation verification passed');
