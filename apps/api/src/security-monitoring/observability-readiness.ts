import type { FilterRuleStageStatus, FilterRuleSystemStatus } from './filter-rule.types';

export const OBSERVABILITY_READINESS_SCHEMA = 'anysentry.observability_readiness.v1' as const;

export interface ObservabilityReadinessPersistence {
  asyncDerivedPersistenceDropped: number;
  asyncRawPersistenceDropped: number;
  asyncKernelPersistenceDropped: number;
}

export interface ObservabilityReadinessInfrastructureRule {
  ruleId: string;
  lifecycleStage: string;
}

export interface ObservabilityReadinessPhase {
  ready: boolean;
  reason: string;
}

export interface ObservabilityReadinessSnapshot {
  schemaVersion: typeof OBSERVABILITY_READINESS_SCHEMA;
  ready: boolean;
  generatedAt: string;
  collection: {
    globallyOpened: boolean;
    filterMode: string;
    captureProfile: string;
    candidateInfrastructureRules: number;
    enforcedInfrastructureRules: number;
  };
  persistence: ObservabilityReadinessPersistence & {
    unexpectedDerivedDrop: boolean;
  };
  phases: {
    c: ObservabilityReadinessPhase;
    d: ObservabilityReadinessPhase;
    e: ObservabilityReadinessPhase;
    f0f3: ObservabilityReadinessPhase & {
      degradedStages: number;
      stages: Array<{ stage: string; status: string }>;
    };
  };
}

export function buildObservabilityReadiness(input: {
  status: FilterRuleSystemStatus;
  infrastructureRules: ObservabilityReadinessInfrastructureRule[];
  persistence: ObservabilityReadinessPersistence;
  contractsReady?: boolean;
  generatedAt?: string;
}): ObservabilityReadinessSnapshot {
  const contractsReady = input.contractsReady !== false;
  const catalogLoaded = input.status.totalRules > 0;
  const stage = (id: string): FilterRuleStageStatus | undefined =>
    input.status.stages.find((item) => item.stage === id);
  const filterMode = stage('f2')?.mode ?? 'unknown';
  const captureProfile = stage('f1')?.mode ?? 'unknown';
  const globallyOpened = filterMode === 'shadow' || filterMode === 'off' || filterMode === 'disabled';
  const candidateInfrastructureRules = input.infrastructureRules.filter((rule) =>
    rule.ruleId.startsWith('ifr_') && rule.lifecycleStage !== 'enforced' && rule.lifecycleStage !== 'revoked').length;
  const enforcedInfrastructureRules = input.infrastructureRules.filter((rule) =>
    rule.ruleId.startsWith('ifr_') && rule.lifecycleStage === 'enforced').length;
  const unexpectedDerivedDrop = input.persistence.asyncDerivedPersistenceDropped > 0;
  const f0f3Ready = input.status.degradedStages === 0
    && input.status.stages.length > 0
    && input.status.stages.every((item) => item.status === 'ready');
  const f0f3Reason = f0f3Ready
    ? 'F0–F3 stages aligned; inventory candidates stay unenforced'
    : input.status.stages.some((item) => item.status === 'unknown')
      ? 'Observer unified projection has not reported'
      : `F0–F3 not ready (${input.status.degradedStages} degraded)`;
  const c: ObservabilityReadinessPhase = {
    ready: contractsReady && catalogLoaded,
    reason: contractsReady && catalogLoaded
      ? 'AgentInstance/RuntimeInstance/Session/Run contracts and catalog are loaded'
      : 'generic lifecycle contracts or catalog are not loaded',
  };
  const d: ObservabilityReadinessPhase = {
    ready: contractsReady && catalogLoaded,
    reason: contractsReady && catalogLoaded
      ? 'hop-fenced Session/EvidenceLink contracts are loaded'
      : 'parent/child contracts or catalog are not loaded',
  };
  const e: ObservabilityReadinessPhase = {
    ready: !unexpectedDerivedDrop && !globallyOpened && enforcedInfrastructureRules === 0,
    reason: unexpectedDerivedDrop
      ? 'unexpected derived-lane persistence drop'
      : globallyOpened
        ? 'collection bound is not enforce'
        : enforcedInfrastructureRules > 0
          ? 'candidate infrastructure rules were promoted to enforced'
          : 'no unexpected derived drop; collection remains bounded',
  };
  const f0f3 = {
    ready: f0f3Ready && enforcedInfrastructureRules === 0,
    reason: enforcedInfrastructureRules > 0
      ? 'inventory candidates must stay unenforced'
      : f0f3Reason,
    degradedStages: input.status.degradedStages,
    stages: input.status.stages.map((item) => ({ stage: item.stage, status: item.status })),
  };
  return {
    schemaVersion: OBSERVABILITY_READINESS_SCHEMA,
    ready: c.ready && d.ready && e.ready && f0f3.ready,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    collection: {
      globallyOpened,
      filterMode,
      captureProfile,
      candidateInfrastructureRules,
      enforcedInfrastructureRules,
    },
    persistence: {
      ...input.persistence,
      unexpectedDerivedDrop,
    },
    phases: { c, d, e, f0f3 },
  };
}
