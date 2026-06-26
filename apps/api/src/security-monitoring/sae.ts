// SAE explainability scorer — the dashboard's side of a3s-sentry's `SaeJudge`.
//
// a3s-power serves the model in a TEE, taps the residual stream, and emits an `LlmActivations` event
// carrying ONLY sparse (feature_id, activation) pairs — never the prompt/completion text. This scorer
// turns those features into an explainable safety score against a labeled feature dictionary:
//   white-box (judges the model's internal concepts) · confidential (no text) · explainable (linear
//   in named features → ranked drivers).
//
// It is config-driven (see policy-config.ts): the SAE tier is OFF until enabled via the config panel,
// and its dictionary + thresholds are live-tunable. configureSae() is called by SentryJudgeService
// whenever the policy changes.

import { readFileSync } from 'node:fs';
import { SaeConfig, SaeDictEntry } from './policy-config';
import { SaeDriver, SaeExplain, Severity, Verdict } from './types';

interface FeatureLabel {
  concept: string;
  category: string;
  weight: number;
  severity: Severity;
}
type Dict = Record<number, FeatureLabel>;

// A small built-in dictionary, offered as the seed when an operator enables SAE before mounting an
// offline-trained one. Production: supply the real dict via the config panel (or ANYSENTRY_SAE_DICT).
const DEFAULT_DICT: Dict = {
  8801: { concept: 'exploit-code-synthesis', category: 'cyber_offense', weight: 0.9, severity: 'high' },
  221: { concept: 'jailbreak-compliance', category: 'jailbreak', weight: 0.6, severity: 'medium' },
  4002: { concept: 'pii-disclosure', category: 'pii_exfil', weight: 0.7, severity: 'high' },
  1503: { concept: 'cbrn-weapons', category: 'cbrn', weight: 0.95, severity: 'critical' },
  3310: { concept: 'deception-scam', category: 'deception', weight: 0.6, severity: 'medium' },
  5120: { concept: 'self-harm-instructions', category: 'self_harm', weight: 0.8, severity: 'high' },
  907: { concept: 'malware-payload', category: 'cyber_offense', weight: 0.85, severity: 'high' },
};

function dictFromEnv(): Dict | null {
  const path = process.env.ANYSENTRY_SAE_DICT;
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, FeatureLabel>;
    const d: Dict = {};
    for (const [k, v] of Object.entries(raw)) {
      const id = Number(k);
      if (Number.isInteger(id)) d[id] = v;
    }
    return d;
  } catch {
    return null;
  }
}

// Live config (mutated by configureSae). Disabled by default — SAE is opt-in.
let enabled = false;
let activeDict: Dict = dictFromEnv() ?? DEFAULT_DICT;
let escalateAt = 0.3;
let blockAt = 0.6;

/** Apply the SAE part of the policy. Null/disabled → the tier is off (LlmActivations are dropped). */
export function configureSae(cfg: SaeConfig | null): void {
  enabled = !!cfg?.enabled;
  if (!cfg) return;
  escalateAt = cfg.escalateAt;
  blockAt = cfg.blockAt;
  activeDict = cfg.dict.length ? Object.fromEntries(cfg.dict.map((e) => [e.id, { concept: e.concept, category: e.category, weight: e.weight, severity: e.severity }])) : dictFromEnv() ?? DEFAULT_DICT;
}

export function saeEnabled(): boolean {
  return enabled;
}

/** The seed dictionary the config panel offers when enabling SAE for the first time. */
export function defaultSaeDict(): SaeDictEntry[] {
  return Object.entries(activeDict).map(([id, l]) => ({ id: Number(id), concept: l.concept, category: l.category, weight: l.weight, severity: l.severity }));
}

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
    const label = activeDict[id];
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
  return h >= blockAt ? 'block' : h >= escalateAt ? 'escalate' : 'allow';
}

export function severityForHarmful(h: number): Severity {
  if (h >= 0.85) return 'critical';
  if (h >= 0.6) return 'high';
  if (h >= 0.3) return 'medium';
  if (h >= 0.1) return 'low';
  return 'info';
}
