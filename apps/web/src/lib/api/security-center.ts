import { apiClient, apiRawFetch } from "@/lib/api/client";

export type SecurityTimeType = "last_3h" | "last_1d" | "last_7d" | "last_30d" | "custom";
export type SecurityRiskLevel = "safe" | "low" | "medium" | "high" | "critical" | "unknown" | string;
export type SecurityPolicyAction = "allow" | "review" | "block" | string;

export interface SecurityTimeFilter {
  timeType?: SecurityTimeType;
  startTime?: string;
  endTime?: string;
}

export interface SecurityHealthCard {
  healthScore: number;
  healthStatusText: string;
  tokenConsumptionTotal: number;
  tokenConsumptionUnit: string;
}

export interface SecurityWaveSeriesPoint {
  statTime: string;
  value: number;
  activationCount: number;
}

export interface SecurityWaveSeries {
  safeSeries: SecurityWaveSeriesPoint[];
  riskSeries: SecurityWaveSeriesPoint[];
}

export interface SecurityExplainabilityScan {
  waveSeries: SecurityWaveSeries[];
  threatInterception: string;
  sessionActiveCount: string;
  updateTime: string;
}

export interface SecurityPerformanceMetric {
  current: number;
  peak: number;
  avg: number;
}

export interface SecurityLatencyMetric {
  value: number;
  unit: string;
}

export interface SecurityPerformanceCard {
  componentRequestCount: SecurityPerformanceMetric;
  tps: SecurityPerformanceMetric;
  avgLatency: SecurityLatencyMetric;
  updateTime: string;
}

export interface SecurityRiskSummaryCard {
  riskTypeCode: string;
  riskTypeName: string;
  eventCount: number;
}

export interface SecurityRiskSummary {
  summaryCards: SecurityRiskSummaryCard[];
  updateTime: string;
}

export interface SecurityRiskBreakdownItem {
  riskCode: string;
  riskName: string;
  eventCount: number;
  changeRate: number;
}

export interface SecurityRiskCategory {
  totalCount: number;
  displayColor?: string;
  items: SecurityRiskBreakdownItem[];
}

export interface SecurityRiskBreakdown {
  systemRisks: SecurityRiskCategory;
  communicationRisks: SecurityRiskCategory;
  singleAgentRisks: SecurityRiskCategory;
  updateTime: string;
}

export interface SecurityRiskDimension {
  dimensionCode: string;
  dimensionName: string;
  score: number;
}

export interface SecurityHighestRiskSession {
  sessionId: string;
  userId: string;
  workspacePath: string;
  riskLevel: SecurityRiskLevel;
  riskLevelText: string;
  compositeScore: number;
  lastEventTime: string;
  riskDimensions: SecurityRiskDimension[];
  updateTime: string;
}

export interface SecurityDecisionTier {
  tierCode: string;
  tierName: string;
  count: number;
  percentage: number;
  slaDesc: string;
}

export interface SecurityDecisionFunnel {
  tiers: SecurityDecisionTier[];
  finalBlock: {
    count: number;
    percentage: number;
  };
  updateTime: string;
}

// 智能体可观测性:Agent Observability = Infra Metrics + Behavior Analytics。
export interface AgentObservability {
  health: { heartbeatOk: boolean; resourceUtil: number; errorRate: number; decisionLatencyMs: number };
  behavioral: { actionRate: number; decisionPattern: "baseline" | "drift"; stateTransitions: number; goalProgress: number };
  system: { agentCount: number; commThroughput: number; infraHealthy: boolean };
  updateTime: string;
}

export interface SecurityWorkspaceRiskItem {
  workspacePath: string;
  sessionCount: number;
  totalRiskScore: number;
  riskLevel: SecurityRiskLevel;
  riskLevelText: string;
}

export interface SecurityWorkspaceRiskDistribution {
  list: SecurityWorkspaceRiskItem[];
  updateTime: string;
}

export interface SecurityExplainabilityHealth {
  configured: boolean;
  ok: boolean;
  model: string;
  baseUrl?: string;
  status?: number;
  latencyMs?: number;
  checkedAt: string;
  message?: string;
}

export interface SecurityAuditMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SecurityExplainabilityAuditRequest {
  model?: string;
  messages: SecurityAuditMessage[];
  sessionId?: string;
  traceId?: string;
  persist?: boolean;
}

export interface SecurityExplainabilityAuditResult {
  sampleId?: string;
  model: string;
  harmful: number;
  safety: number;
  riskScore: number;
  safetyScore: number;
  riskLevel: SecurityRiskLevel;
  policyAction: SecurityPolicyAction;
  detectedAt: string;
}

export interface SecurityExplainabilityScanRequest extends SecurityTimeFilter {
  seriesPoints?: number;
}

export type SecurityVerdict = "allow" | "block" | "escalate";
export type SecuritySeverity = "info" | "low" | "medium" | "high" | "critical";

export interface SaeDriver {
  concept: string;
  category: string;
  source: string;
  activation: number;
  contribution: number;
}

export interface SecurityExplainabilityDrivers {
  scored: number;
  flaggedCount: number;
  avgHarmful: number;
  perCategory: Array<{ category: string; total: number; count: number }>;
  topDrivers: Array<{ concept: string; category: string; source: string; count: number; avgContribution: number }>;
  flaggedOutputs: Array<{
    agentId: string;
    sessionId: string;
    harmful: number;
    verdict: SecurityVerdict;
    severity: SecuritySeverity;
    at: string;
    drivers: SaeDriver[];
  }>;
  updateTime: string;
}

export const securityCenterApi = {
  healthCard: (filter: SecurityTimeFilter) =>
    apiClient.post<SecurityHealthCard>("/security-center/top/healthCard", filter),
  explainabilityScan: (filter: SecurityExplainabilityScanRequest) =>
    apiClient.post<SecurityExplainabilityScan>("/security-center/top/explainabilityScan", filter),
  explainabilityDrivers: (filter: SecurityTimeFilter) =>
    apiClient.post<SecurityExplainabilityDrivers>("/security-center/top/explainabilityDrivers", filter),
  performanceCard: (filter: SecurityTimeFilter) =>
    apiClient.post<SecurityPerformanceCard>("/security-center/top/performanceCard", filter),
  riskSummary: (filter: SecurityTimeFilter) =>
    apiClient.post<SecurityRiskSummary>("/security-center/risks/summary", filter),
  riskBreakdown: (filter: SecurityTimeFilter) =>
    apiClient.post<SecurityRiskBreakdown>("/security-center/risks/breakdown", filter),
  highestRiskSession: (filter: SecurityTimeFilter) =>
    apiClient.post<SecurityHighestRiskSession>("/security-center/sessions/highestRisk", filter),
  decisionFunnel: (filter: SecurityTimeFilter) =>
    apiClient.post<SecurityDecisionFunnel>("/security-center/sessions/decisionFunnel", filter),
  agentObservability: (filter: SecurityTimeFilter) =>
    apiClient.post<AgentObservability>("/security-center/sessions/agentObservability", filter),
  workspaceRiskDistribution: (filter: SecurityTimeFilter) =>
    apiClient.post<SecurityWorkspaceRiskDistribution>("/security-center/sessions/workspaceRiskDistribution", filter),
  explainabilityHealth: () => apiClient.get<SecurityExplainabilityHealth>("/open/security/explainability/health"),
  explainabilityAudit: (body: SecurityExplainabilityAuditRequest) =>
    apiClient.post<SecurityExplainabilityAuditResult>("/open/security/explainability/audit", body),
  openExplainabilityScan: (filter: SecurityExplainabilityScanRequest) =>
    apiClient.post<SecurityExplainabilityScan>("/open/security/explainability/scan", filter),
};

/**
 * 订阅智能体可观测性指标的 SSE 实时推送(服务端每 3s 推一帧,前端不轮询)。
 * 走 fetch + ReadableStream(apiRawFetch)。断线自动重连(退避≤5s);abort signal 关闭即停。
 * 每帧 `data:` JSON → onData。
 */
export function streamAgentObservability(
  filter: SecurityTimeFilter,
  onData: (data: AgentObservability) => void,
  signal: AbortSignal,
): void {
  const qs = new URLSearchParams();
  if (filter.timeType) qs.set("timeType", filter.timeType);
  if (filter.startTime) qs.set("startTime", filter.startTime);
  if (filter.endTime) qs.set("endTime", filter.endTime);
  const url = `/security-center/sessions/agentObservability/stream${qs.toString() ? `?${qs.toString()}` : ""}`;

  const consumeBlock = (block: string) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data) return;
    try {
      const parsed = JSON.parse(data);
      // 服务端某一拍取数失败会推 { error: true };忽略,保留上一帧。
      if (parsed && typeof parsed === "object" && !("error" in parsed)) onData(parsed as AgentObservability);
    } catch {
      // 半帧 / 心跳行,忽略。
    }
  };

  const run = async () => {
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) return;
      try {
        const res = await apiRawFetch(url, { method: "GET", headers: { Accept: "text/event-stream" }, signal });
        if (res.ok && res.body) {
          attempt = 0; // 连上即重置退避
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const blocks = buffer.split("\n\n");
            buffer = blocks.pop() ?? "";
            blocks.forEach(consumeBlock);
            if (done) break;
          }
        } else if (res.status >= 400 && res.status < 500) {
          return; // 4xx(鉴权/不存在)不会因重试恢复
        }
      } catch (error) {
        if ((error as Error)?.name === "AbortError") return;
      }
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * (attempt + 1), 5000)));
    }
  };
  void run();
}
