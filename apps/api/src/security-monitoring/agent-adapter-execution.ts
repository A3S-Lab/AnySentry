/**
 * Executes declarative AgentAdapterManifest rules against an ingested interaction.
 * Product-specific behavior belongs only in Manifest declarations; this module is generic.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import type * as T from './types';
import {
  DEFAULT_AGENT_ADAPTER_MANIFESTS,
  type AgentAdapterCanonicalToolKind,
  type AgentAdapterIdentityPath,
  type AgentAdapterManifest,
  type AgentAdapterTrafficRole,
  type AgentAdapterTrafficRule,
} from './canonical-observability';

const MAX_PATH_DEPTH = 8;
const MAX_IDENTITY_HINTS = 32;
const SESSION_UUID = /session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu;

export interface AgentAdapterMatchHints {
  product?: string;
  displayName?: string;
  comm?: string;
  exe?: string;
  argv0?: string;
}

export interface AgentAdapterIdentityHint {
  entityType: AgentAdapterIdentityPath['entityType'];
  value: string;
  valueHash: string;
  strength: AgentAdapterIdentityPath['strength'];
  sourcePath: string;
  anchorKind: NonNullable<AgentAdapterIdentityPath['anchorKind']>;
}

export interface AgentAdapterToolNameView {
  rawName: string;
  canonicalKind: AgentAdapterCanonicalToolKind;
}

export interface AgentAdapterApplication {
  adapterId: string;
  trafficRole?: AgentAdapterTrafficRole;
  identityHints: AgentAdapterIdentityHint[];
  toolNameViews: AgentAdapterToolNameView[];
}

function text(value: unknown, max = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000]/u.test(normalized)) return undefined;
  return normalized;
}

function normalizeToken(value: unknown): string | undefined {
  const normalized = text(value)?.toLowerCase()
    .replace(/[\s_]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  return normalized || undefined;
}

function basenameToken(value: unknown): string | undefined {
  const normalized = text(value);
  if (!normalized) return undefined;
  return normalizeToken(path.posix.basename(normalized.replace(/\\/gu, '/')));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hashValue(namespace: string, value: string): string {
  return createHash('sha256').update(`${namespace}\0${value}`).digest('hex');
}

function detectionTokens(manifest: AgentAdapterManifest): string[] {
  return [...new Set([
    normalizeToken(manifest.id),
    ...(manifest.detection.commands ?? []).map(normalizeToken),
    ...(manifest.detection.executableHints ?? []).map(normalizeToken),
    ...(manifest.detection.productAliases ?? []).map(normalizeToken),
  ].filter((value): value is string => Boolean(value)))];
}

function hintTokens(hints: AgentAdapterMatchHints): string[] {
  return [...new Set([
    normalizeToken(hints.product),
    normalizeToken(hints.displayName),
    normalizeToken(hints.comm),
    basenameToken(hints.exe),
    basenameToken(hints.argv0),
    normalizeToken(hints.argv0),
  ].filter((value): value is string => Boolean(value)))];
}

function scoreManifest(manifest: AgentAdapterManifest, hints: AgentAdapterMatchHints): number {
  if (manifest.status === 'deprecated') return 0;
  const detected = detectionTokens(manifest);
  if (detected.length === 0) return 0;
  const observed = hintTokens(hints);
  if (observed.length === 0) return 0;
  let score = 0;
  for (const token of observed) {
    for (const candidate of detected) {
      if (token === candidate) score = Math.max(score, 100 + candidate.length);
      else if (token.startsWith(`${candidate}-`) || token.endsWith(`-${candidate}`)) {
        score = Math.max(score, 80 + candidate.length);
      } else if (token.includes(candidate) && candidate.length >= 3) {
        score = Math.max(score, 60 + candidate.length);
      }
    }
  }
  if (score > 0 && manifest.status === 'future') score = Math.max(1, Math.floor(score / 4));
  return score;
}

/** Select the best current Manifest for process/product hints. Future slots lose to current. */
export function matchAgentAdapterManifest(
  hints: AgentAdapterMatchHints,
  manifests: readonly AgentAdapterManifest[] = DEFAULT_AGENT_ADAPTER_MANIFESTS,
): AgentAdapterManifest | undefined {
  let best: AgentAdapterManifest | undefined;
  let bestScore = 0;
  for (const manifest of manifests) {
    const score = scoreManifest(manifest, hints);
    if (score > bestScore) {
      best = manifest;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : undefined;
}

function pathMatches(rule: AgentAdapterTrafficRule, pathValue: string | undefined): boolean {
  if (!rule.path || !pathValue) return false;
  const declared = rule.path.trim();
  const observed = pathValue.trim();
  if (!declared || !observed) return false;
  if (rule.match === 'exact') return observed === declared;
  return observed === declared || observed.startsWith(declared);
}

/**
 * classifyTraffic: path prefix/exact and wireTemplateId only. Never consults host/domain.
 * Longest matching path rule wins; wireTemplate conversation rules win over path control
 * only when both match (a Responses/Messages exchange is conversation even on shared hosts).
 */
export function classifyTraffic(
  manifest: AgentAdapterManifest,
  input: { path?: string; wireTemplateId?: string },
): AgentAdapterTrafficRole | undefined {
  const rules = manifest.trafficRoles ?? [];
  if (rules.length === 0) return undefined;

  const wireMatches = rules.filter((rule) =>
    rule.wireTemplateId
    && input.wireTemplateId
    && rule.wireTemplateId === input.wireTemplateId
    && rule.match === 'exact');
  if (wireMatches.some((rule) => rule.role === 'conversation')) return 'conversation';
  if (wireMatches.length > 0) return wireMatches[0].role;

  let best: AgentAdapterTrafficRule | undefined;
  for (const rule of rules) {
    if (!rule.path || !pathMatches(rule, input.path)) continue;
    if (!best || (rule.path?.length ?? 0) > (best.path?.length ?? 0)) best = rule;
    else if (rule.path?.length === best.path?.length && rule.match === 'exact') best = rule;
  }
  return best?.role;
}

function readDotted(
  root: unknown,
  dotted: string,
  depth = 0,
): unknown {
  if (depth > MAX_PATH_DEPTH || !dotted) return undefined;
  const [head, ...rest] = dotted.split('.');
  if (!head) return undefined;
  if (rest.length === 0) {
    if (Array.isArray(root)) return undefined;
    const object = record(root);
    return object?.[head];
  }
  const object = record(root);
  if (!object) return undefined;
  return readDotted(object[head], rest.join('.'), depth + 1);
}

function resolveStructuredPath(
  interaction: Pick<T.AgentInteractionRecord, 'request' | 'response'>,
  declaredPath: string,
): unknown {
  const trimmed = declaredPath.trim();
  if (!trimmed || trimmed.length > 240) return undefined;
  if (trimmed.startsWith('request.')) {
    const relative = trimmed.slice('request.'.length);
    return readDotted(interaction.request.structured, relative)
      ?? readDotted(interaction.request, relative);
  }
  if (trimmed.startsWith('response.')) {
    const relative = trimmed.slice('response.'.length);
    return readDotted(interaction.response.structured, relative)
      ?? readDotted(interaction.response, relative);
  }
  return readDotted(interaction.request.structured, trimmed)
    ?? readDotted(interaction.response.structured, trimmed);
}

function coerceIdentityValue(value: unknown): string | undefined {
  const direct = text(value, 1_024);
  if (direct) {
    const sessionMatch = direct.match(SESSION_UUID);
    if (sessionMatch) return sessionMatch[1];
    return direct;
  }
  return undefined;
}

function defaultAnchorKind(
  entityType: AgentAdapterIdentityPath['entityType'],
): NonNullable<AgentAdapterIdentityPath['anchorKind']> {
  switch (entityType) {
    case 'session':
    case 'thread':
    case 'parent':
      return 'provider_conversation';
    case 'turn':
      return 'turn_id';
    case 'continuity':
      return 'continuity_key';
    case 'response':
      return 'response_id';
    default:
      return 'continuity_key';
  }
}

export function extractIdentityHints(
  manifest: AgentAdapterManifest,
  interaction: Pick<T.AgentInteractionRecord, 'request' | 'response'>,
): AgentAdapterIdentityHint[] {
  const hints: AgentAdapterIdentityHint[] = [];
  const seen = new Set<string>();
  for (const declared of manifest.identityPaths ?? []) {
    if (hints.length >= MAX_IDENTITY_HINTS) break;
    const raw = resolveStructuredPath(interaction, declared.path);
    const value = coerceIdentityValue(raw);
    if (!value) continue;
    const anchorKind = declared.anchorKind ?? defaultAnchorKind(declared.entityType);
    const valueHash = hashValue(anchorKind, value);
    const key = `${anchorKind}\0${valueHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push({
      entityType: declared.entityType,
      value,
      valueHash,
      strength: declared.strength,
      sourcePath: declared.path,
      anchorKind,
    });
  }
  return hints;
}

export function mapToolNameView(
  manifest: AgentAdapterManifest,
  rawName: string,
): AgentAdapterCanonicalToolKind | undefined {
  const rules = manifest.toolNameView ?? [];
  const exact = rules.find((rule) => rule.rawNames?.includes(rawName));
  if (exact) return exact.canonicalKind;
  let bestPrefix: { length: number; kind: AgentAdapterCanonicalToolKind } | undefined;
  for (const rule of rules) {
    const prefix = rule.rawNamePrefix;
    if (!prefix || !rawName.startsWith(prefix)) continue;
    if (!bestPrefix || prefix.length > bestPrefix.length) {
      bestPrefix = { length: prefix.length, kind: rule.canonicalKind };
    }
  }
  return bestPrefix?.kind;
}

export function extractToolNameViews(
  manifest: AgentAdapterManifest,
  toolCalls: T.AgentInteractionToolCall[],
): AgentAdapterToolNameView[] {
  return toolCalls
    .map((call) => {
      const rawName = text(call.name, 240);
      if (!rawName) return undefined;
      const canonicalKind = mapToolNameView(manifest, rawName);
      if (!canonicalKind) return undefined;
      return { rawName, canonicalKind };
    })
    .filter((item): item is AgentAdapterToolNameView => Boolean(item));
}

function mergeAnchors(
  existing: T.AgentConversationAnchor[] | undefined,
  hints: AgentAdapterIdentityHint[],
): T.AgentConversationAnchor[] {
  const merged = [...(existing ?? [])];
  const seen = new Set(merged.map((anchor) =>
    `${anchor.kind}\0${anchor.namespace}\0${anchor.valueHash}`));
  for (const hint of hints) {
    if (merged.length >= 512) break;
    const key = `${hint.anchorKind}\0provider\0${hint.valueHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      kind: hint.anchorKind,
      namespace: 'provider',
      valueHash: hint.valueHash,
      strength: hint.strength,
      sourcePath: hint.sourcePath,
    });
  }
  return merged;
}

/**
 * Apply Manifest declarations to a parsed interaction. Never deletes fields; only fills
 * trafficRole when missing/unclassified, merges Identity anchors, and annotates toolCalls.
 */
export function applyAgentAdapter(
  interaction: T.AgentInteractionRecord,
  manifests: readonly AgentAdapterManifest[] = DEFAULT_AGENT_ADAPTER_MANIFESTS,
): T.AgentInteractionRecord {
  const manifest = matchAgentAdapterManifest({
    product: interaction.agentProduct,
    displayName: interaction.agentProduct,
    comm: interaction.process?.comm,
    exe: interaction.process?.exe,
  }, manifests);
  if (!manifest) return interaction;

  const application: AgentAdapterApplication = {
    adapterId: manifest.id,
    trafficRole: classifyTraffic(manifest, {
      path: interaction.path,
      wireTemplateId: interaction.wireTemplateId,
    }),
    identityHints: extractIdentityHints(manifest, interaction),
    toolNameViews: extractToolNameViews(manifest, interaction.toolCalls),
  };

  const trafficRole = interaction.trafficRole && interaction.trafficRole !== 'unclassified'
    ? interaction.trafficRole
    : application.trafficRole ?? interaction.trafficRole;

  const toolCalls = interaction.toolCalls.map((call) => {
    const view = application.toolNameViews.find((item) => item.rawName === call.name);
    if (!view || call.canonicalKind) return call;
    return { ...call, canonicalKind: view.canonicalKind };
  });

  const conversationAnchors = mergeAnchors(
    interaction.conversationAnchors,
    application.identityHints,
  );

  return {
    ...interaction,
    agentAdapterId: manifest.id,
    ...(trafficRole ? { trafficRole } : {}),
    ...(conversationAnchors.length ? { conversationAnchors } : {}),
    toolCalls,
  };
}
