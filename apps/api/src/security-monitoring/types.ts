// Shapes shared by the judge, the aggregator, and the controller.
// Response shapes match the dashboard's API contract; every value is computed from live
// @a3s-lab/sentry judgments.

export interface SecurityTimeFilter {
  timeType?: 'last_3h' | 'last_1d' | 'last_7d' | 'last_30d' | 'custom';
  startTime?: string;
  endTime?: string;
}
export interface ExplainabilityScanRequest extends SecurityTimeFilter {
  seriesPoints?: number;
}

export type Verdict = 'allow' | 'block' | 'escalate';
export type Tier = 'Rules' | 'Llm' | 'Agent' | 'Sae';
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type RiskType = 'system' | 'communication' | 'atomic';

/** One named contributor to an SAE explainability score — the WHY-panel's spine. */
export interface SaeDriver {
  concept: string;
  category: string;
  source: string; // sae_feature:#8801
  activation: number;
  contribution: number;
}
/** Explainable safety score for one model output (white-box, from a3s-power's in-enclave SAE tap). */
export interface SaeExplain {
  harmful: number; // 0..1, worst category
  safety: number;
  perCategory: Record<string, number>;
  drivers: SaeDriver[];
  channel: string; // "activation"
}

/** One judged event: a sentry Decision joined with the event's source metadata. */
export interface JudgedEvent {
  at: number; // epoch ms
  eventKind: string; // ToolExec | Egress | FileAccess | Dns | SslContent | SecurityAction
  subject: string; // human summary of the event
  workspacePath: string;
  agentId: string;
  sessionId: string;
  userId: string;
  verdict: Verdict;
  tier: Tier;
  severity: Severity;
  reason: string;
  actionKind?: string; // DenyEgress | DenyFile | DenyExec
  actionTarget?: string;
  riskCategory: string; // command_danger | data_leak | prompt_injection | ...
  riskName: string; // human label for the category
  riskType: RiskType;
  riskScore: number; // 0-100
  tokenCount: number;
  latencyMs: number;
  explain?: SaeExplain; // present for SAE-scored model outputs (LlmActivations)
}

export interface EventMeta {
  workspacePath: string;
  agentId: string;
  sessionId: string;
  userId: string;
  tokenCount?: number;
  latencyMs?: number;
  subject?: string;
  eventKind?: string;
}

// ---- Response DTOs (identical field names to the frontend) ----

export interface SecurityHealthCard {
  healthScore: number;
  healthStatusText: string;
  tokenConsumptionTotal: number;
  tokenConsumptionUnit: string;
}
export interface WaveSeriesPoint {
  statTime: string;
  value: number;
  activationCount: number;
}
export interface SecurityExplainabilityScan {
  waveSeries: Array<{ safeSeries: WaveSeriesPoint[]; riskSeries: WaveSeriesPoint[] }>;
  threatInterception: string;
  sessionActiveCount: string;
  updateTime: string;
}
/** The WHY view — mechanistic interpretability of LLM outputs (SAE drivers). */
export interface SecurityExplainabilityDrivers {
  scored: number; // model outputs scored in the window
  flaggedCount: number; // verdict != allow
  avgHarmful: number; // 0-100
  perCategory: Array<{ category: string; total: number; count: number }>;
  topDrivers: Array<{ concept: string; category: string; source: string; count: number; avgContribution: number }>;
  flaggedOutputs: Array<{
    agentId: string;
    sessionId: string;
    harmful: number;
    verdict: Verdict;
    severity: Severity;
    at: string;
    drivers: SaeDriver[];
  }>;
  updateTime: string;
}
export interface SecurityPerformanceCard {
  componentRequestCount: { current: number; peak: number; avg: number };
  tps: { current: number; peak: number; avg: number };
  avgLatency: { value: number; unit: string };
  updateTime: string;
}
export interface SecurityRiskSummary {
  summaryCards: Array<{ riskTypeCode: string; riskTypeName: string; eventCount: number }>;
  updateTime: string;
}
export interface RiskCategory {
  totalCount: number;
  displayColor?: string;
  items: Array<{ riskCode: string; riskName: string; eventCount: number; changeRate: number }>;
}
export interface SecurityRiskBreakdown {
  systemRisks: RiskCategory;
  communicationRisks: RiskCategory;
  singleAgentRisks: RiskCategory;
  updateTime: string;
}
export interface SecurityHighestRiskSession {
  sessionId: string;
  userId: string;
  workspacePath: string;
  riskLevel: string;
  riskLevelText: string;
  compositeScore: number;
  lastEventTime: string;
  riskDimensions: Array<{ dimensionCode: string; dimensionName: string; score: number }>;
  updateTime: string;
}
export interface SecurityDecisionFunnel {
  tiers: Array<{ tierCode: string; tierName: string; count: number; percentage: number; slaDesc: string }>;
  finalBlock: { count: number; percentage: number };
  updateTime: string;
}
export interface AgentObservability {
  health: { heartbeatOk: boolean; resourceUtil: number; errorRate: number; decisionLatencyMs: number };
  behavioral: { actionRate: number; decisionPattern: 'baseline' | 'drift'; stateTransitions: number; goalProgress: number };
  system: { agentCount: number; commThroughput: number; infraHealthy: boolean };
  updateTime: string;
}
export interface SecurityWorkspaceRiskDistribution {
  list: Array<{ workspacePath: string; sessionCount: number; totalRiskScore: number; riskLevel: string; riskLevelText: string }>;
  updateTime: string;
}
