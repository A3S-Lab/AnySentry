// SAE explainability scorer — the dashboard's side of a3s-sentry's `SaeJudge`.
//
// a3s-power serves the model in a TEE, taps the residual stream, and emits an `LlmActivations` event
// carrying ONLY sparse (feature_id, activation) pairs — never the prompt/completion text. This scorer
// turns those features into an explainable safety score against a labeled feature dictionary:
//   white-box (judges the model's internal concepts) · confidential (no text) · explainable (linear
//   in named features → ranked drivers). Production: load the offline-trained dict via ANYSENTRY_SAE_DICT.

import { readFileSync } from 'node:fs';
import { SaeDriver, SaeExplain, Severity, Verdict } from './types';

interface FeatureLabel {
  concept: string;
  category: string;
  weight: number;
  severity: Severity;
}

// Placeholder labeled dictionary until the offline-trained SAE feature dict is mounted
// (ANYSENTRY_SAE_DICT=path to a JSON map: { "8801": {concept, category, weight, severity}, ... }).
const DEFAULT_DICT: Record<number, FeatureLabel> = {
  8801: { concept: 'exploit-code-synthesis', category: 'cyber_offense', weight: 0.9, severity: 'high' },
  221: { concept: 'jailbreak-compliance', category: 'jailbreak', weight: 0.6, severity: 'medium' },
  4002: { concept: 'pii-disclosure', category: 'pii_exfil', weight: 0.7, severity: 'high' },
  1503: { concept: 'cbrn-weapons', category: 'cbrn', weight: 0.95, severity: 'critical' },
  3310: { concept: 'deception-scam', category: 'deception', weight: 0.6, severity: 'medium' },
  5120: { concept: 'self-harm-instructions', category: 'self_harm', weight: 0.8, severity: 'high' },
  907: { concept: 'malware-payload', category: 'cyber_offense', weight: 0.85, severity: 'high' },
};

function loadDict(): Record<number, FeatureLabel> {
  const path = process.env.ANYSENTRY_SAE_DICT;
  if (path) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, FeatureLabel>;
      const dict: Record<number, FeatureLabel> = {};
      for (const [k, v] of Object.entries(raw)) {
        const id = Number(k);
        if (Number.isInteger(id)) dict[id] = v;
      }
      return dict;
    } catch {
      // fall back to the default dict on a bad/missing file
    }
  }
  return DEFAULT_DICT;
}

const DICT = loadDict();

/** Parse the sparse SAE features from a power/observer `LlmActivations` NDJSON line. */
export function parseActivations(line: string): Array<[number, number]> {
  try {
    const o = JSON.parse(line) as { event?: { LlmActivations?: { features?: Array<[number, number]> } } };
    return o.event?.LlmActivations?.features ?? [];
  } catch {
    return [];
  }
}

/** Score sparse features into an explainable safety score (harmful = worst category; ranked drivers). */
export function scoreActivations(features: Array<[number, number]>): SaeExplain {
  const perCategory: Record<string, number> = {};
  const drivers: SaeDriver[] = [];
  for (const [id, act] of features) {
    const label = DICT[id];
    if (!label) continue;
    const contribution = Math.min(1, Math.max(0, label.weight * act));
    if (contribution <= 0) continue;
    perCategory[label.category] = Math.min(1, (perCategory[label.category] ?? 0) + contribution);
    drivers.push({ concept: label.concept, category: label.category, source: `sae_feature:#${id}`, activation: act, contribution });
  }
  const harmful = Object.values(perCategory).reduce((m, v) => Math.max(m, v), 0);
  drivers.sort((a, b) => b.contribution - a.contribution);
  return { harmful, safety: 1 - harmful, perCategory, drivers: drivers.slice(0, 6), channel: 'activation' };
}

export function verdictForHarmful(h: number): Verdict {
  return h >= 0.6 ? 'block' : h >= 0.3 ? 'escalate' : 'allow';
}

export function severityForHarmful(h: number): Severity {
  if (h >= 0.85) return 'critical';
  if (h >= 0.6) return 'high';
  if (h >= 0.3) return 'medium';
  if (h >= 0.1) return 'low';
  return 'info';
}
