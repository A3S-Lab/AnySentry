#!/usr/bin/env node

/**
 * Static High-level wiring/safety contract.
 *
 * This verifier proves that required source seams, ordering guards, deployment references, and
 * compatibility test entry points remain wired. It does NOT compile eBPF/Rust/TypeScript, start a
 * service, exercise a Ring Buffer, validate kernel verifier acceptance, or replace unit/load/E2E
 * tests. Those runtime gates remain separate package scripts and final-stage evidence.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const observerRoot = new URL('../Observer/', root);
const read = (relative, base = root) => readFile(new URL(relative, base), 'utf8');
const [
  packageText,
  handbook,
  controller,
  judge,
  correlation,
  toolEvidence,
  systemContext,
  securityAssistant,
  unknownLearning,
  unknownRuntime,
  infrastructureRules,
  captureControl,
  capturePublisher,
  forwarder,
  piLoop,
  piAdapter,
  s0Compatibility,
  traceCompatibility,
  s2Persistence,
  observerCommon,
  observerEbpf,
  observerMain,
  observerCaptureProfile,
  observerModel,
  observerPipeline,
  observerRingReader,
  deployment,
] = await Promise.all([
  read('package.json'),
  read('docs/anysentry-trusted-correlation-and-capture-roadmap.md'),
  read('apps/api/src/security-monitoring/security-monitoring.controller.ts'),
  read('apps/api/src/security-monitoring/sentry-judge.service.ts'),
  read('apps/api/src/security-monitoring/trusted-correlation.ts'),
  read('apps/api/src/security-monitoring/tool-evidence-linker.ts'),
  read('apps/api/src/security-monitoring/system-context-bundle.ts'),
  read('apps/api/src/security-monitoring/security-assistant.service.ts'),
  read('apps/api/src/security-monitoring/unknown-learning.ts'),
  read('apps/api/src/security-monitoring/unknown-learning-runtime.service.ts'),
  read('apps/api/src/security-monitoring/infrastructure-rule.service.ts'),
  read('scripts/observer-capture-profile-control.js'),
  read('scripts/observer-filter-rule-publisher.js'),
  read('scripts/observer-forward.js'),
  read('examples/agent-runtime-lab/app/pi-loop.mjs'),
  read('examples/agent-runtime-lab/app/anysentry-pi-adapter.mjs'),
  read('scripts/verify-s0-compatibility-fixtures.mjs'),
  read('scripts/verify-trusted-correlation-compatibility.mjs'),
  read('scripts/verify-s2-persistence-canonical.mjs'),
  read('a3s-observer-common/src/lib.rs', observerRoot),
  read('a3s-observer-ebpf/src/main.rs', observerRoot),
  read('a3s-observer-collector/src/main.rs', observerRoot),
  read('a3s-observer-collector/src/capture_profile.rs', observerRoot),
  read('src/model.rs', observerRoot),
  read('a3s-observer-collector/src/pipeline.rs', observerRoot),
  read('a3s-observer-collector/src/ring_reader.rs', observerRoot),
  read('deploy/observer.yaml'),
]);
const packageJson = JSON.parse(packageText);

function pass(label, condition) {
  assert.ok(condition, label);
  console.log(`PASS ${label}`);
}

function section(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `${label}: missing start marker ${startMarker}`);
  assert.ok(end > start, `${label}: missing end marker ${endMarker}`);
  return source.slice(start, end);
}

function ordered(source, ...markers) {
  let cursor = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker, cursor + 1);
    if (index < 0 || index <= cursor) return false;
    cursor = index;
  }
  return true;
}

function includesAll(source, markers) {
  return markers.every((marker) => source.includes(marker));
}

function assertPreRingDecision(label, source, probe, reserveMarker) {
  pass(`[DATA/RING-PRE/${label}] capture decision rejects before Ring reservation`,
    ordered(source, 'capture_raw_decision(', probe, 'capture_decision.selected()', reserveMarker) ||
    ordered(source, 'capture_raw_selected(', probe, reserveMarker));
}

function assertPayloadDiscard(label, source, probe) {
  const payloadError = `capture_payload_error(${probe})`;
  pass(`[DATA/PAYLOAD/${label}] selected payload failure is accounted and discarded before submit`,
    source.includes(payloadError) &&
    source.includes('entry.discard(0)') &&
    source.indexOf(payloadError) < source.indexOf('entry.discard(0)') &&
    (!source.includes('submit_accounted(') ||
      source.indexOf('entry.discard(0)') < source.lastIndexOf('submit_accounted(')));
}

console.log('CONTRACT static-wiring-and-safety (not runtime, load, kernel-verifier, or E2E evidence)');

pass('[SCOPE] package entry runs this static contract without an implicit build',
  packageJson.scripts?.['verify:roadmap-high-level'] ===
    'node scripts/verify-roadmap-high-level-contract.mjs');

pass('[ARCH] handbook retains the control/learning and fast-data loops',
  handbook.includes('控制与学习闭环') && handbook.includes('快速数据闭环'));

pass('[IDENTITY] trusted correlation stays additive and never aliases legacy Trace',
  correlation.includes('TRUSTED_CORRELATION_SCHEMA_VERSION') &&
  controller.includes("@Post('events/tool-evidence')") &&
  !toolEvidence.includes('traceId ='));

pass('[CONTROL/COMPILE] control plane emits closed probe actions and generation-bound grants',
  captureControl.includes('probeActions') &&
  capturePublisher.includes('activationGrant') &&
  capturePublisher.includes('collectorInstanceId') &&
  capturePublisher.includes('lastControlPlaneGoodAt'));

pass('[COLLECTOR/RING-DRAIN] event-driven reader uses the exact bounded drain budget',
  observerRingReader.includes('const RING_DRAIN_BUDGET: usize = 1_024;') &&
  observerRingReader.includes('for _ in 0..RING_DRAIN_BUDGET') &&
  observerRingReader.includes('AsyncFd'));

pass('[COLLECTOR/QUEUES] Collector retains bounded Critical/Semantic/Bulk service classes',
  observerPipeline.includes('Critical') &&
  observerPipeline.includes('Semantic') &&
  observerPipeline.includes('Bulk'));

const expectedProbeConstants = [
  'CAPTURE_PROBE_EXEC',
  'CAPTURE_PROBE_EXIT',
  'CAPTURE_PROBE_TLS',
  'CAPTURE_PROBE_CONNECT',
  'CAPTURE_PROBE_DNS',
  'CAPTURE_PROBE_FILE_ACCESS',
  'CAPTURE_PROBE_FILE_DELETE',
  'CAPTURE_PROBE_LLM',
  'CAPTURE_PROBE_SSL',
  'CAPTURE_PROBE_SECURITY',
  'CAPTURE_PROBE_FILE_READ',
];
pass('[DATA/PROBE-MATRIX] shared ABI retains exactly eleven closed Capture Probe slots',
  observerCommon.includes('pub const CAPTURE_PROBE_COUNT: usize = 11;') &&
  includesAll(observerCommon, expectedProbeConstants));

const tls = section(observerEbpf, 'fn try_tls(', '// ---- OPT-IN OpenSSL content', 'TLS probe');
assertPreRingDecision('TLS', tls, 'CAPTURE_PROBE_TLS', 'reserve_or_drop::<TlsEvent>');
assertPayloadDiscard('TLS', tls, 'CAPTURE_PROBE_TLS');

const ssl = section(observerEbpf, 'fn emit_ssl(', '// ---- outbound connection peer', 'SSL probe');
assertPreRingDecision('SSL', ssl, 'CAPTURE_PROBE_SSL', 'reserve_or_drop::<SslEvent>');
assertPayloadDiscard('SSL', ssl, 'CAPTURE_PROBE_SSL');

const connect = section(observerEbpf, 'fn try_connect(', '// ---- security-sensitive actions', 'Connect probe');
assertPreRingDecision('CONNECT', connect, 'CAPTURE_PROBE_CONNECT', 'reserve_or_drop::<ConnectEvent>');
assertPayloadDiscard('CONNECT', connect, 'CAPTURE_PROBE_CONNECT');

const dnsDatagram = section(observerEbpf, 'fn try_dns(', '// ---- DNS query via sendmsg', 'DNS datagram probe');
assertPreRingDecision('DNS/SENDTO', dnsDatagram, 'CAPTURE_PROBE_DNS', 'reserve_or_drop::<DnsEvent>');
assertPayloadDiscard('DNS/SENDTO', dnsDatagram, 'CAPTURE_PROBE_DNS');

const dnsMessage = section(observerEbpf, 'fn try_dns_msghdr(', '// ---- file opened', 'DNS msghdr probe');
assertPreRingDecision('DNS/SENDMSG', dnsMessage, 'CAPTURE_PROBE_DNS', 'reserve_or_drop::<DnsEvent>');
assertPayloadDiscard('DNS/SENDMSG', dnsMessage, 'CAPTURE_PROBE_DNS');

const fileAccess = section(observerEbpf, 'fn try_open_common(', '// ---- file deleted', 'FileAccess probe');
pass('[DATA/RING-PRE/FILE_ACCESS] write and selective-read decisions precede both Rings and path copy',
  includesAll(fileAccess, [
    'CAPTURE_PROBE_FILE_ACCESS',
    'CAPTURE_PROBE_FILE_READ',
    'FILE_READ_EVENTS',
    'PIPELINE_RING_FILE_READ',
    'reserve_file_or_drop',
  ]) &&
  ordered(fileAccess, 'capture_raw_decision(', 'capture_decision.selected()', 'bpf_probe_read_user_str_bytes') &&
  ordered(fileAccess, 'capture_decision.selected()', 'reserve_or_drop::<FileEvent>'));
pass('[DATA/SYSCALL-COVERAGE] open, openat and openat2 reuse one selective-read decision path',
  includesAll(observerEbpf, ['file_open_legacy', 'file_openat2', 'try_open_common']) &&
  includesAll(observerMain, ['sys_enter_open', 'sys_enter_openat', 'sys_enter_openat2']));

const fileDelete = section(observerEbpf, 'fn try_unlink(', '// ---- LLM-call metrics', 'FileDelete probes');
pass('[DATA/RING-PRE/FILE_DELETE] unlink and unlinkat both decide before the shared delete Ring',
  ((fileDelete.match(/capture_raw_decision\(CAPTURE_PROBE_FILE_DELETE/g) ?? []).length === 2 &&
    fileDelete.lastIndexOf('capture_raw_decision(CAPTURE_PROBE_FILE_DELETE') <
      fileDelete.indexOf('reserve_file_or_drop')) ||
  ((fileDelete.match(/capture_raw_selected\(CAPTURE_PROBE_FILE_DELETE/g) ?? []).length === 2 &&
    fileDelete.lastIndexOf('capture_raw_selected(CAPTURE_PROBE_FILE_DELETE') <
      fileDelete.indexOf('reserve_file_or_drop')));
const fileDeleteSubmit = section(observerEbpf, 'fn submit_file_delete(', '// ---- LLM-call metrics', 'FileDelete payload');
assertPayloadDiscard('FILE_DELETE', fileDeleteSubmit, 'CAPTURE_PROBE_FILE_DELETE');

const llm = section(observerEbpf, 'pub fn sock_close(', '// ---- egress enforcement', 'LLM probe');
assertPreRingDecision('LLM', llm, 'CAPTURE_PROBE_LLM', 'reserve_or_drop::<LlmEvent>');
pass('[DATA/PAYLOAD/LLM] no fallible userspace payload copy exists after LLM Ring reservation',
  !llm.includes('bpf_probe_read_user') &&
  ordered(llm, 'reserve_or_drop::<LlmEvent>', 'submit_accounted('));

const captureDecision = section(observerEbpf, 'fn capture_raw_decision(', 'const FILE_STAT_ACCESS_KEPT', 'capture decision');
pass('[DATA/DECISION-FAILURE] invalid action and aggregate/sample failures never fall back to unbounded FULL',
  includesAll(captureDecision, [
    'CAPTURE_STAT_AGGREGATE_ERROR',
    'capture_emergency_sample_allowed',
    'CAPTURE_STAT_SAMPLE_REJECTED',
    'CAPTURE_STAT_DECISION_ERROR',
  ]) &&
  !captureDecision.includes('return true; // fail'));

const reloadCapture = section(observerMain, 'fn reload_capture_profile(', 'fn aggregate_file_filter_stats(', 'Collector reload');
pass('[CONTROL/APPLY-SAFE] Collector installs a non-destructive generation before ACK handling',
  ordered(reloadCapture, 'parse_snapshot(', 'manager.apply_safe(&mut parsed)',
    'finish_capture_profile_ack('));

const finishAck = section(observerMain, 'fn finish_capture_profile_ack(', '#[allow(clippy::too_many_arguments)]', 'Collector ACK');
pass('[CONTROL/ACK-GATE] durable ACK precedes destructive map enable and ACK failure revokes DROP',
  ordered(finishAck, 'write_ack_atomic(ack_path, &applied)', 'manager.enable_destructive(snapshot)') &&
  finishAck.includes('manager.revoke_destructive'));

const applySafe = section(observerCaptureProfile, 'pub(crate) fn apply_safe(', 'pub(crate) fn enable_destructive(', 'apply_safe');
pass('[CONTROL/APPLY-SAFE] apply_safe explicitly writes config with destructive=false',
  applySafe.includes('self.write_config(self.active_epoch, 0, false)') &&
  applySafe.includes('self.write_config(snapshot.epoch, snapshot.expires_at_boot_ns, false)'));

const grant = section(observerCaptureProfile, 'fn grant_matches(', 'pub(crate) fn parse_snapshot(', 'activation grant');
pass('[CONTROL/GRANT-FENCE] activation grant binds collector, boot, publisher, preview, intent, report and expiry',
  includesAll(grant, [
    'collectorInstanceId',
    'hostBootId',
    'publisherInstanceId',
    'previewEpoch',
    'previewContentHash',
    'intentHash',
    'centralReportId',
    'expiresAt',
    'preview_generation_mismatch',
  ]));
pass('[CONTROL/ACK-SCHEMA] Collector publishes the versioned capture-profile ACK contract',
  observerCaptureProfile.includes(
    'pub(crate) const ACK_SCHEMA: &str = "anysentry.capture_profile_ack.v1";'));

pass('[COLLECTOR/AGGREGATE] Collector emits CaptureAggregate and exact generation/time identities',
  observerMain.includes('CaptureAggregate') &&
  observerMain.includes('exec_id_exact') &&
  observerModel.includes('window_start_unix_ns_exact') &&
  observerModel.includes('window_end_unix_ns_exact'));

pass('[FORWARDER/BULK] CaptureAggregate has a dedicated non-classifying path',
  forwarder.includes("if (kind === 'CaptureAggregate')") &&
  forwarder.includes("pipelineAccounting.record('classified', 'capture_aggregate')") &&
  forwarder.includes('return;'));

pass('[DEPLOY/SECRET-KEYREF] control-plane token comes from the exact Secret keyRef',
  deployment.includes(
    'valueFrom: { secretKeyRef: { name: anysentry-control-auth, key: management-token } }') &&
  !/name:\s*ANYSENTRY_INFRASTRUCTURE_POLICY_TOKEN[^\n]*value:/u.test(deployment));
pass('[DEPLOY/SOURCE-SECRET] per-node Source credentials use a read-only keyed Secret projection',
  deployment.includes('ANYSENTRY_SOURCE_CREDENTIALS_FILE') &&
  deployment.includes('secretName: anysentry-observer-auth') &&
  deployment.includes('{ key: observer-sources.json, path: observer-sources.json, mode: 0400 }') &&
  !deployment.includes('ansrc_'));
pass('[DEPLOY/CAPTURE] Collector and Forwarder share snapshot, ACK and rollout mode wiring',
  includesAll(deployment, [
    'ANYSENTRY_FILTER_RULES_FILE',
    'ANYSENTRY_FILTER_RULES_ACK_FILE',
    'ANYSENTRY_CAPTURE_PROFILE_MODE',
  ]));

pass('[S6/PI-LOAD] Pi explicitly loads the first-party adapter despite global extension discovery being off',
  ordered(piLoop, "'--no-extensions'", "'--extension'", 'anySentryAdapter'));
pass('[S6/PI-GENAI] Pi emits invocation/tool lifecycle with current GenAI identifiers',
  includesAll(piAdapter, [
    "pi.on('turn_start'",
    "pi.on('tool_execution_start'",
    "pi.on('tool_execution_end'",
    "eventKind: 'AgentInvocation'",
    "eventKind: 'AgentTool'",
    "operation: 'invoke_agent'",
    "operation: 'execute_tool'",
    "'gen_ai.tool.call.id'",
    "'gen_ai.conversation.id'",
  ]) &&
  !piAdapter.includes('gen_ai.tool.call.arguments') &&
  !piAdapter.includes('gen_ai.tool.call.result'));
pass('[S6/OTLP-MAP] native OTLP GenAI operations map to additive Agent semantic event kinds',
  controller.includes("genAiOperation === 'execute_tool' ? 'AgentTool'") &&
  controller.includes("genAiOperation === 'invoke_agent' ? 'AgentInvocation'"));
pass('[S6/OTLP-REDACTION] GenAI arguments/results/messages are sensitive by default',
  controller.includes(
    'GENAI_SENSITIVE_CONTENT_KEY = /^gen_ai_(?:tool_call_(?:arguments|result)|input_messages|output_messages)$/u') &&
  controller.includes("if (key && sensitiveAttributeKey(key)) return '[redacted]';"));
pass('[S6/TRUST] Tool evidence requires authenticated adapter semantics and attested kernel facts',
  toolEvidence.includes('authenticated_agent_adapter') &&
  toolEvidence.includes('attested_observer') &&
  toolEvidence.includes('same_process_resource') &&
  toolEvidence.includes('direct_child_command') &&
  toolEvidence.includes('overlapping_exact_claims'));

pass('[S7/CONTEXT] System Context is authenticated, workspace-isolated, two-hop and byte-bounded',
  controller.includes('isTrustedSystemContextProducer') &&
  controller.includes('Boolean(boundWorkspacePath)') &&
  controller.includes('boundWorkspacePath === eventWorkspacePath') &&
  controller.includes("@Post('context/system')") &&
  systemContext.includes('maxHops: [1, 2]') &&
  systemContext.includes("code: 'byte_budget'"));
pass('[S7/RISK-CONSUMER] bounded System Context reaches the read-only Assistant with explicit partial quality',
  securityAssistant.includes('this.systemContext.build') &&
  securityAssistant.includes('maxHops: 2') &&
  securityAssistant.includes('maxBytes: 64 * 1_024') &&
  securityAssistant.includes("status: 'partial'") &&
  securityAssistant.includes('systemContext: this.systemContextSummary(snapshot)'));
pass('[S7/ISOLATION] System Context bypasses Agent/Unknown/Streaming activity paths',
  controller.includes("if (kind !== 'SystemContext')") && judge.includes('recordSystemContext'));

pass('[S8/LEARNING] Unknown learning is stable, bounded and recommendation-only',
  unknownLearning.includes('familyId') &&
  unknownLearning.includes('countScope') &&
  unknownLearning.includes("authority: 'recommendation_only'") &&
  unknownLearning.includes('authoritativeDrop: false') &&
  !unknownLearning.includes("UnknownLearnedAction = 'drop'"));

const unknownBridgeEndpoint = section(
  controller,
  "@Post('unknown-learning/policies/:policyId/infrastructure-draft')",
  "@Put('unknown-learning/config')",
  'Unknown recommendation Infrastructure bridge',
);
pass('[S8/CONTROL-BRIDGE] only an explicit managed operation can create a non-destructive Infrastructure draft',
  unknownBridgeEndpoint.includes('@RequireManagementAuth()') &&
  unknownBridgeEndpoint.includes('authorizeInfrastructureDraft') &&
  unknownBridgeEndpoint.includes('createUnknownRecommendationDraft') &&
  unknownBridgeEndpoint.includes('operationDestructive: false'));
pass('[S8/CONTROL-BRIDGE] enforced recommendation, current review and exact physical workload/canary are mandatory',
  unknownRuntime.includes("policy.stage !== 'enforced'") &&
  unknownRuntime.includes("review.decision !== 'non_agent'") &&
  unknownRuntime.includes('review.revision !== policy.evidence.reviewRevision') &&
  unknownRuntime.includes('family.stableScope !== `workload:${physicalWorkloadIdHash}`') &&
  unknownRuntime.includes("policy.evidence.canaryScope?.kind !== 'physical_workload'") &&
  unknownRuntime.includes('policy.evidence.canaryScope.valueHash !== physicalWorkloadIdHash'));
pass('[S8/CONTROL-BRIDGE] bridge output is candidate/draft and remains behind the existing Infrastructure workflow',
  infrastructureRules.includes("authority: 'candidate'") &&
  infrastructureRules.includes("lifecycleStage: 'draft'") &&
  infrastructureRules.includes("effectiveInfrastructureAction(rule) !== 'sample'") &&
  infrastructureRules.includes('createUnknownRecommendationDraft') &&
  infrastructureRules.includes('already bridged with a different Infrastructure draft intent') &&
  includesAll(infrastructureRules, [
    'shadow(ruleId:',
    'validate(',
    'promote(ruleId:',
    "current.lifecycleStage !== 'shadow'",
    "target === 'enforced' ? 'authoritative'",
  ]));

pass('[COMPAT/ENTRY-S0] package exposes the S0 golden compatibility gate',
  packageJson.scripts?.['verify:s0-compatibility']?.includes(
    'scripts/verify-s0-compatibility-fixtures.mjs') &&
  s0Compatibility.includes('traceId changed'));
pass('[COMPAT/ENTRY-TRACE] package exposes legacy Trace/Incident/Alert/Flink compatibility checks',
  packageJson.scripts?.['verify:trusted-correlation-compatibility']?.includes(
    'scripts/verify-trusted-correlation-compatibility.mjs') &&
  traceCompatibility.includes('existing Incident identity must keep the legacy trace key') &&
  traceCompatibility.includes('existing Alert deduplication must keep the legacy trace key') &&
  traceCompatibility.includes('existing Flink episode state must keep the legacy session component'));
pass('[COMPAT/ENTRY-S2] package exposes S2 persistence plus off/shadow API gates independently',
  packageJson.scripts?.['verify:s2-trusted-correlation-unit']?.includes(
    'scripts/verify-s2-persistence-canonical.mjs') &&
  packageJson.scripts?.['verify:s2-trusted-correlation-api:local']?.includes(
    'ANYSENTRY_S2_EXPECT_MODE=off') &&
  packageJson.scripts?.['verify:s2-trusted-correlation-api:local']?.includes(
    'ANYSENTRY_S2_EXPECT_MODE=shadow') &&
  s2Persistence.includes("assert.equal(persisted.traceId, 'legacy-trace-1')") &&
  s2Persistence.includes('trusted correlation must be additive to every canonical v1 legacy identity field'));

console.log('AnySentry static High-level roadmap wiring/safety contract passed');
