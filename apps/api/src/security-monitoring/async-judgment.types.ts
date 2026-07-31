import { PolicyConfig } from './policy-config';
import { JudgedEvent, JudgmentRoutingSnapshot } from './types';

export const FAST_JUDGE_QUEUE = 'anysentry-fast-judge';
export const L3_JOBS_QUEUE = 'anysentry-l3-jobs';
export const DECISION_RESULTS_QUEUE = 'anysentry-decision-results';

export type DecisionStage = 'L1' | 'L2' | 'L3';
export type DecisionStatus = 'accepted' | 'pending' | 'running' | 'succeeded' | 'failed' | 'timeout';

export interface AsyncDecision {
  verdict: string;
  tier: string;
  severity: string;
  reason: string;
  action?: { kind?: string; target?: string };
  risk?: { category?: string; name?: string; riskType?: string; risk_type?: string };
}

export interface FastJudgeJob {
  schemaVersion: 'anysentry.fast_judge_job.v2';
  evaluationId: string;
  policyVersion: string;
  event: JudgedEvent;
  observerLine: string;
  policy: PolicyConfig;
  routing: JudgmentRoutingSnapshot;
  queuedAt: number;
}

export interface L3JudgeJob {
  schemaVersion: 'anysentry.l3_judge_job.v1';
  evaluationId: string;
  policyVersion: string;
  event: JudgedEvent;
  observerLine: string;
  policy: PolicyConfig;
  provisionalDecision: AsyncDecision;
  l1Decision: AsyncDecision;
  queuedAt: number;
}

export interface DecisionResultJob {
  schemaVersion: 'anysentry.decision_result.v1';
  evaluationId: string;
  policyVersion: string;
  event: JudgedEvent;
  stage: DecisionStage;
  status: Exclude<DecisionStatus, 'accepted' | 'pending' | 'running'>;
  decision?: AsyncDecision;
  l1Decision?: AsyncDecision;
  nextTierEligible?: boolean;
  stageStopReason?: string;
  awaitingL3?: boolean;
  error?: string;
  startedAt: number;
  completedAt: number;
  attempt: number;
}
