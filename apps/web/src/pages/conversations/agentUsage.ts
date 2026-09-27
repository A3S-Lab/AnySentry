import type {
  AgentInstanceUsageSummary,
  AgentUsageSummary,
} from "@/lib/api/security-center";

export const EMPTY_AGENT_USAGE: AgentUsageSummary = {
  modelCallCount: 0,
  successfulModelCallCount: 0,
  failedModelCallCount: 0,
  tokenReportedModelCallCount: 0,
  tokenCoverage: "unavailable",
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  reasoningOutputTokens: 0,
  totalDurationMs: 0,
};

export function rollupUsage(summaries: readonly AgentUsageSummary[]): AgentUsageSummary {
  const nonEmpty = summaries.filter((summary) => summary.modelCallCount > 0);
  if (!nonEmpty.length) return EMPTY_AGENT_USAGE;
  const sum = (select: (summary: AgentUsageSummary) => number) =>
    nonEmpty.reduce((total, summary) => total + select(summary), 0);
  const modelCallCount = sum((summary) => summary.modelCallCount);
  const tokenReportedModelCallCount = sum((summary) => summary.tokenReportedModelCallCount);
  const totalDurationMs = sum((summary) => summary.totalDurationMs);
  return {
    modelCallCount,
    successfulModelCallCount: sum((summary) => summary.successfulModelCallCount),
    failedModelCallCount: sum((summary) => summary.failedModelCallCount),
    tokenReportedModelCallCount,
    tokenCoverage: tokenReportedModelCallCount === 0
      ? "unavailable"
      : tokenReportedModelCallCount === modelCallCount
        && nonEmpty.every((summary) => summary.tokenCoverage === "complete")
        ? "complete"
        : "partial",
    inputTokens: sum((summary) => summary.inputTokens),
    outputTokens: sum((summary) => summary.outputTokens),
    totalTokens: sum((summary) => summary.totalTokens),
    cachedInputTokens: sum((summary) => summary.cachedInputTokens),
    cacheCreationInputTokens: sum((summary) => summary.cacheCreationInputTokens),
    reasoningOutputTokens: sum((summary) => summary.reasoningOutputTokens),
    totalDurationMs,
    averageDurationMs: totalDurationMs / modelCallCount,
  };
}

export function usageForInstance(
  summaries: readonly AgentInstanceUsageSummary[],
  identities: ReadonlySet<string>,
) {
  return rollupUsage(summaries.filter((summary) => identities.has(summary.agentInstanceId)));
}

export function formatTokenCount(value: number, compact = true) {
  return new Intl.NumberFormat("zh-CN", compact
    ? { notation: "compact", maximumFractionDigits: 1 }
    : { maximumFractionDigits: 0 }).format(value);
}

export function formatTokenTotal(usage: AgentUsageSummary, compact = true) {
  if (usage.tokenCoverage === "unavailable") return "--";
  return formatTokenCount(usage.totalTokens, compact);
}

export function tokenCoverageText(usage: AgentUsageSummary) {
  if (usage.tokenCoverage === "complete") return "全部调用由模型返回";
  if (usage.tokenCoverage === "partial") {
    return `${usage.tokenReportedModelCallCount}/${usage.modelCallCount} 次调用返回用量`;
  }
  return usage.modelCallCount > 0 ? "模型未返回 Token 用量" : "当前没有模型调用";
}

export function formatDuration(milliseconds?: number) {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "--";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}
