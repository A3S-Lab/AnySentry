import { DecisionResultJob, DecisionStage } from './async-judgment.types';
import { JudgedEvent, type ClassificationSemanticsV1, type TrustedCorrelationV1 } from './types';

export const STREAM_PUBLISH_QUEUE = 'anysentry-stream-publish';
export const COMPOSITE_JUDGE_QUEUE = 'anysentry-composite-judge';
export const DEFAULT_CANONICAL_TOPIC = 'anysentry.events.canonical.v1';
export const DEFAULT_JUDGMENTS_TOPIC = 'anysentry.judgments.v1';
export const DEFAULT_EPISODES_TOPIC = 'anysentry.risk-analysis-batches.v1';
export const DEFAULT_FINDINGS_TOPIC = 'anysentry.stream.findings.v1';
export const DEFAULT_DLQ_TOPIC = 'anysentry.stream.dlq.v1';

export type CanonicalOperation =
  | 'file_read'
  | 'file_write'
  | 'download'
  | 'chmod'
  | 'encode'
  | 'compress'
  | 'copy'
  | 'execute'
  | 'egress'
  | 'persistence_activate'
  | 'sandbox_probe'
  | 'privilege_change'
  | 'target_discovery'
  | 'destroy'
  | 'remote_connect'
  | 'remote_execute'
  | 'remote_copy'
  | 'observe';

export type CanonicalResourceType = 'file' | 'process' | 'network' | 'unknown';

export type CanonicalBehaviorStage =
  | 'download'
  | 'file_written'
  | 'permission_change'
  | 'file_execution'
  | 'credential_access'
  | 'staging'
  | 'transform'
  | 'external_egress'
  | 'dangerous_exec'
  | 'destructive_action'
  | 'shell_execution'
  | 'vulnerable_component_execution'
  | 'persistence_write'
  | 'persistence_activation'
  | 'sandbox_probe'
  | 'privilege_change'
  | 'target_discovery'
  | 'lateral_connect'
  | 'lateral_action'
  | 'none';

export interface RuntimeVulnerabilityMatch {
  findingId: string;
  dependencySnapshotId: string;
  vulnerabilityAssessmentId: string;
  ecosystem: string;
  packageName: string;
  version: string;
  vulnerabilityId: string;
  aliases: string[];
  confidence: 'medium' | 'high';
  matchBasis: string;
}

export interface CanonicalProcessIdentity {
  hostId?: string;
  bootId?: string;
  containerId?: string;
  cgroupId?: string;
  pid?: number;
  ppid?: number;
  rootPid?: number;
  rootStartTime?: string;
  startTimeTicks?: string;
  startTimeNs?: string;
  mountNamespace?: number;
  processInstanceId: string;
  identityConfidence: 'strong' | 'medium' | 'weak';
}

export interface CanonicalFileIdentity {
  fileInstanceId: string;
  path: string;
  device?: string;
  inode?: string;
  mountNamespace?: number;
  identityBasis: 'device_inode' | 'scoped_path';
  identityConfidence: 'strong' | 'medium' | 'weak';
}

export interface CanonicalSecurityEvent {
  schemaVersion: 'anysentry.canonical_event.v1';
  eventId: string;
  sourceEventId: string;
  sourceRecordId: string;
  eventTime: number;
  receivedAt: number;
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  workspacePath: string;
  workspacePathFingerprint: string;
  trustedSourceId: string;
  claimedAgentId: string;
  agentType: string;
  agentInstanceId: string;
  agentCorrelationId: string;
  sessionId: string;
  traceId: string;
  /** Additive trusted identity; never aliases or replaces the legacy traceId. */
  invocationId?: string;
  toolCallId?: string;
  correlation?: TrustedCorrelationV1;
  classificationSemantics?: ClassificationSemanticsV1;
  spanId: string;
  eventKind: string;
  operation: CanonicalOperation;
  resourceType: CanonicalResourceType;
  resource?: string;
  destination?: string;
  sensitiveResource: boolean;
  externalDestination: boolean;
  dangerous: boolean;
  failed: boolean;
  subject: string;
  command?: string;
  executable?: string;
  argvTruncated: boolean;
  argvSource?: string;
  behaviorStage: CanonicalBehaviorStage;
  repeatCount: number;
  firstEventAt: number;
  lastEventAt: number;
  aggregationWindowMs: number;
  platformRuntime: boolean;
  synthetic: boolean;
  processIdentity: CanonicalProcessIdentity;
  fileIdentity?: CanonicalFileIdentity;
  supplyChainWorkspaceId?: string;
  dependencySnapshotId?: string;
  vulnerabilityAssessmentId?: string;
  runtimeVulnerabilities: RuntimeVulnerabilityMatch[];
}

export interface JudgmentStreamEvent {
  schemaVersion: 'anysentry.judgment_update.v1';
  judgmentId: string;
  evaluationId: string;
  eventId: string;
  eventTime: number;
  publishedAt: number;
  revision: number;
  policyVersion: string;
  stage: DecisionStage;
  status: DecisionResultJob['status'];
  verdict?: string;
  severity?: string;
  reason?: string;
  riskCategory?: string;
  riskName?: string;
  latencyMs: number;
  attempt: number;
  awaitingL3: boolean;
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  workspacePath: string;
  agentCorrelationId: string;
  agentType: string;
  sessionId: string;
  traceId: string;
  spanId: string;
  eventKind: string;
  subject: string;
}

export interface EpisodeJudgmentEvidence {
  stage: DecisionStage;
  status: DecisionResultJob['status'];
  verdict?: string;
  severity?: string;
  reason?: string;
  latencyMs: number;
  revision: number;
}

export interface RiskAnalysisEvidence extends CompositeEvidence {
  traceId?: string;
  sessionId?: string;
  resource?: string;
  destination?: string;
  dangerous: boolean;
  sensitiveResource: boolean;
  externalDestination: boolean;
  failed: boolean;
  command?: string;
  executable?: string;
  argvTruncated: boolean;
  argvSource?: string;
  behaviorStage: CanonicalBehaviorStage;
  platformRuntime: boolean;
  synthetic: boolean;
  processIdentity?: CanonicalProcessIdentity;
  fileIdentity?: CanonicalFileIdentity;
  supplyChainWorkspaceId?: string;
  dependencySnapshotId?: string;
  vulnerabilityAssessmentId?: string;
  runtimeVulnerabilities: RuntimeVulnerabilityMatch[];
  judgment?: EpisodeJudgmentEvidence;
}

export interface RiskAnalysisBatch {
  schemaVersion: 'anysentry.risk_analysis_batch.v1';
  episodeId: string;
  revision: number;
  supersedesRevision?: number;
  evidenceFingerprint: string;
  triggerReason: 'idle' | 'max_duration' | 'event_limit' | 'critical_evidence' | 'judgment_update' | 'pattern_match';
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  workspacePath: string;
  agentCorrelationId: string;
  agentType: string;
  sessionId: string;
  traceIds: string[];
  windowStart: number;
  windowEnd: number;
  generatedAt: number;
  evidence: RiskAnalysisEvidence[];
  candidateType: string;
  decisionPath: 'deterministic_rule' | 'composite_judge';
  ruleVersion:
    | 'composite-risk-v2'
    | 'supply-chain-exploit-v1'
    | 'supply-chain-temporal-v2'
    | 'temporal-episode-v1'
    | 'temporal-episode-v2';
  evidenceConfidence?: 'strong' | 'medium' | 'weak';
  synthetic: boolean;
  shadow: true;
}

export interface RiskProfileFinding {
  schemaVersion: 'anysentry.stream_finding.v1';
  findingType: 'risk_profile';
  findingId: string;
  profileId: string;
  version: number;
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  workspacePath: string;
  agentCorrelationId: string;
  agentInstanceId: string;
  agentType: string;
  windowStart: number;
  windowEnd: number;
  calculatedAt: number;
  riskScore: number;
  riskLevel: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  features: Record<string, number>;
  hitRules: string[];
  ruleVersion: string;
  shadow: true;
}

export interface CompositeEvidence {
  eventId: string;
  sourceRecordId?: string;
  eventTime: number;
  eventKind: string;
  operation: CanonicalOperation;
  subject: string;
}

export interface CompositeRiskFinding {
  schemaVersion: 'anysentry.stream_finding.v1';
  findingType: 'composite_risk';
  findingId: string;
  correlationId: string;
  version: number;
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  workspacePath: string;
  agentCorrelationId: string;
  agentInstanceId?: string;
  agentType: string;
  sessionId?: string;
  traceId?: string;
  ruleId: 'sensitive-data-exfiltration';
  ruleVersion: '1';
  windowStart: number;
  windowEnd: number;
  calculatedAt: number;
  evidenceScore: number;
  severity: 'high' | 'critical';
  evidenceEventIds: string[];
  evidence: CompositeEvidence[];
  reason: string;
  shadow: true;
}

export type StreamFinding = RiskProfileFinding | CompositeRiskFinding;

export type CompositeJudgmentStatus = 'pending' | 'succeeded' | 'failed' | 'timeout' | 'suppressed';
export type CompositeClassification =
  | 'benign'
  | 'simulation'
  | 'authorized_admin'
  | 'suspicious'
  | 'confirmed_attack';

export interface CompositeJudgmentFinding {
  schemaVersion: 'anysentry.stream_finding.v1';
  findingType: 'composite_judgment';
  findingId: string;
  episodeId: string;
  revision: number;
  evidenceFingerprint: string;
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  workspacePath: string;
  agentCorrelationId: string;
  agentType: string;
  sessionId: string;
  traceIds: string[];
  windowStart: number;
  windowEnd: number;
  judgedAt: number;
  status: CompositeJudgmentStatus;
  verdict?: 'allow' | 'block';
  severity?: 'low' | 'medium' | 'high' | 'critical';
  confidence?: number;
  classification?: CompositeClassification;
  attackType?: string;
  reason?: string;
  evidenceEventIds: string[];
  evidence: RiskAnalysisEvidence[];
  model: string;
  latencyMs: number;
  error?: string;
  updateRevision?: number;
  updateStatus?: Exclude<CompositeJudgmentStatus, 'succeeded' | 'suppressed'>;
  updateError?: string;
  updateJudgedAt?: number;
  ruleVersion: string;
  decisionSource: 'deterministic_rule' | 'composite_judge';
  synthetic: boolean;
  shadow: true;
}

export type PersistedStreamFinding = StreamFinding | CompositeJudgmentFinding;

export interface CompositeJudgeJob {
  schemaVersion: 'anysentry.composite_judge_job.v1';
  batch: RiskAnalysisBatch;
  queuedAt: number;
}

export interface StreamPublishJob {
  schemaVersion: 'anysentry.stream_publish_job.v1';
  topic: string;
  key: string;
  messageId: string;
  payload: CanonicalSecurityEvent | JudgmentStreamEvent;
  queuedAt: number;
}

export interface StreamFindingList {
  enabled: boolean;
  riskProfiles: RiskProfileFinding[];
  compositeRisks: CompositeRiskFinding[];
  compositeJudgments: CompositeJudgmentFinding[];
  updateTime: string;
}

export interface StreamingStatus {
  enabled: boolean;
  agentOnly: boolean;
  brokerConfigured: boolean;
  canonicalTopic: string;
  judgmentsTopic: string;
  episodesTopic: string;
  findingsTopic: string;
  dlqTopic: string;
}

export interface CanonicalSource {
  event: JudgedEvent;
  observerLine: string;
}
