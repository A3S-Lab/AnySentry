import { PolicyConfig } from './policy-config';
import { JudgedEvent } from './types';

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
  schemaVersion: 'anysentry.fast_judge_job.v1';
  evaluationId: string;
  policyVersion: string;
  event: JudgedEvent;
  observerLine: string;
  policy: PolicyConfig;
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
  awaitingL3?: boolean;
  error?: string;
  startedAt: number;
  completedAt: number;
  attempt: number;
}
