import { Injectable } from '@nestjs/common';
import type { JudgedEvent } from './types';
import { BehaviorAgentScorer, type BehaviorAgentScore } from './behavior-agent-scorer';

/** Process-generation scoped bridge from cold-start behavior to the unified rule context. */
@Injectable()
export class BehaviorCandidateRegistry {
  private readonly scorer = new BehaviorAgentScorer({
    windowMs: envInt('ANYSENTRY_BEHAVIOR_CANDIDATE_WINDOW_MS', 60_000, 10_000, 15 * 60_000),
    threshold: envInt('ANYSENTRY_BEHAVIOR_CANDIDATE_THRESHOLD', 8, 3, 100),
    maxScopes: envInt('ANYSENTRY_BEHAVIOR_CANDIDATE_MAX_SCOPES', 1024, 16, 100_000),
  });

  observe(event: JudgedEvent): BehaviorAgentScore | undefined {
    const semantic = event.classificationSemantics?.identityClassification;
    const attributed = event.attribution?.classification;
    // Cold-start events often have no identity envelope yet. Treat an absent classification as
    // unknown; only an explicit confirmed/probable/non-agent fact fences behavior discovery.
    if ((semantic && semantic !== 'unknown') || (attributed && attributed !== 'unknown')) return undefined;
    return this.scorer.observe(event);
  }

  scoreFor(event: JudgedEvent): BehaviorAgentScore | undefined {
    const key = event.process?.processGenerationKey || event.attribution?.physicalWorkloadId ||
      event.runtimeInstanceId || event.subjectAssetId;
    return key ? this.scorer.get(key) : undefined;
  }

  get(scopeKey: string): BehaviorAgentScore | undefined {
    return this.scorer.get(scopeKey);
  }

  clear(): void { this.scorer.clear(); }
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
