import type { JudgedEvent } from './types';

export interface BehaviorAgentScore {
  scopeKey: string;
  score: number;
  threshold: number;
  candidate: boolean;
  windowStartMs: number;
  windowEndMs: number;
  evidence: Record<string, number>;
  reason: string;
}

interface WindowState extends BehaviorAgentScore {
  lastSeenMs: number;
}

export interface BehaviorAgentScorerOptions {
  windowMs?: number;
  threshold?: number;
  maxScopes?: number;
  ttlMs?: number;
}

/**
 * Kernel-shaped, product-neutral candidate discovery. It deliberately consumes event classes,
 * process generation and workload identity only; tool names, ports, vendors and argv strings are
 * never part of the score. State is bounded so cold-start discovery cannot become a new buffer.
 */
export class BehaviorAgentScorer {
  private readonly states = new Map<string, WindowState>();
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly maxScopes: number;
  private readonly ttlMs: number;

  constructor(options: BehaviorAgentScorerOptions = {}) {
    this.windowMs = clamp(options.windowMs ?? 60_000, 10_000, 15 * 60_000);
    this.threshold = clamp(options.threshold ?? 8, 3, 100);
    this.maxScopes = clamp(options.maxScopes ?? 1024, 16, 100_000);
    this.ttlMs = clamp(options.ttlMs ?? 10 * 60_000, this.windowMs, 60 * 60_000);
  }

  observe(event: JudgedEvent, now = Date.now()): BehaviorAgentScore | undefined {
    const scopeKey = stableScope(event);
    if (!scopeKey || !Number.isSafeInteger(event.at)) return undefined;
    this.expire(now);
    const windowStartMs = Math.floor(event.at / this.windowMs) * this.windowMs;
    const existing = this.states.get(scopeKey);
    const state = existing && existing.windowStartMs === windowStartMs
      ? existing
      : this.newState(scopeKey, windowStartMs);
    const points = behaviorPoints(event);
    const bucket = pointBucket(event);
    if (points > 0) {
      state.score = Math.min(100, state.score + points);
      state.evidence[bucket] = (state.evidence[bucket] ?? 0) + 1;
    }
    state.lastSeenMs = now;
    state.candidate = state.score >= state.threshold && !infraSuppressed(event);
    state.reason = state.candidate
      ? 'bounded_kernel_behavior_threshold'
      : infraSuppressed(event) ? 'infrastructure_guardrail' : 'insufficient_behavior_evidence';
    this.states.set(scopeKey, state);
    this.trim();
    return snapshot(state);
  }

  get(scopeKey: string): BehaviorAgentScore | undefined {
    const state = this.states.get(scopeKey);
    return state && snapshot(state);
  }

  clear(): void { this.states.clear(); }

  private newState(scopeKey: string, windowStartMs: number): WindowState {
    return { scopeKey, score: 0, threshold: this.threshold, candidate: false,
      windowStartMs, windowEndMs: windowStartMs + this.windowMs, evidence: {}, lastSeenMs: 0,
      reason: 'insufficient_behavior_evidence' };
  }

  private expire(now: number): void {
    for (const [key, state] of this.states) if (now - state.lastSeenMs > this.ttlMs) this.states.delete(key);
  }

  private trim(): void {
    while (this.states.size > this.maxScopes) {
      const oldest = [...this.states.entries()].sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs)[0];
      if (!oldest) break;
      this.states.delete(oldest[0]);
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : min;
}

function stableScope(event: JudgedEvent): string | undefined {
  return event.process?.processGenerationKey || event.attribution?.physicalWorkloadId ||
    event.runtimeInstanceId || event.subjectAssetId;
}

function behaviorPoints(event: JudgedEvent): number {
  if (event.activityContext === 'platform_healthcheck' || event.activityContext === 'collector_heartbeat') return 0;
  return ({ LlmCall: 4, LlmInteraction: 4, ToolExec: 3, Egress: 2, Dns: 1, FileAccess: 1, FileRead: 1, Exec: 1 } as Record<string, number>)[event.eventKind] ?? 0;
}

function pointBucket(event: JudgedEvent): string { return event.eventKind.trim().toLowerCase(); }

function infraSuppressed(event: JudgedEvent): boolean {
  const role = event.classificationSemantics?.workloadRole;
  return role === 'anysentry_internal' || role === 'platform_infrastructure' ||
    event.activityContext === 'platform_healthcheck' || event.activityContext === 'collector_heartbeat';
}

function snapshot(state: WindowState): BehaviorAgentScore {
  const { lastSeenMs: _lastSeenMs, ...publicState } = state;
  return { ...publicState, evidence: { ...state.evidence } };
}
