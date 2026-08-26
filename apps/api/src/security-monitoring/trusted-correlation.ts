import { createHash } from 'node:crypto';

export const TRUSTED_CORRELATION_SCHEMA_VERSION = 'anysentry.trusted_correlation.v1' as const;
export const TRUSTED_CORRELATION_IDENTITY_VERSION = 'trusted_correlation.v1' as const;

export type TrustedCorrelationMethod =
  | 'application_trace'
  | 'agent_adapter'
  | 'runtime_root'
  | 'physical_workload'
  | 'inferred_episode'
  | 'unassigned';

export type TrustedCorrelationScope =
  | 'invocation'
  | 'agent_session'
  | 'runtime'
  | 'workload'
  | 'event';

export type TrustedCorrelationAuthority =
  | 'authenticated_application'
  | 'authenticated_agent_adapter'
  | 'attested_observer'
  | 'server_process_graph'
  | 'server_inventory'
  | 'inferred'
  | 'none';

export type TrustedCorrelationTraceOrigin =
  | 'incoming'
  | 'adapter'
  | 'legacy_synthetic'
  | 'none';

export type TrustedCorrelationProvenance =
  | 'source_authenticated'
  | 'source_scope_bound'
  | 'application_invocation'
  | 'application_trace'
  | 'adapter_invocation'
  | 'adapter_tool_call'
  | 'adapter_session'
  | 'runtime_root_key'
  | 'runtime_agent_instance'
  | 'physical_workload'
  | 'process_tuple'
  | 'legacy_synthetic_trace'
  | 'inferred_episode'
  | 'unassigned';

export type TrustedCorrelationClaimRejectionReason =
  | 'source_unverified'
  | 'source_unauthenticated'
  | 'authority_mismatch'
  | 'claim_not_allowed'
  | 'binding_incomplete'
  | 'binding_mismatch'
  | 'claim_scope_mismatch'
  | 'invalid_claim'
  | 'claim_empty'
  | 'legacy_synthetic_trace';

const METHODS: readonly TrustedCorrelationMethod[] = [
  'application_trace',
  'agent_adapter',
  'runtime_root',
  'physical_workload',
  'inferred_episode',
  'unassigned',
];
const SCOPES: readonly TrustedCorrelationScope[] = ['invocation', 'agent_session', 'runtime', 'workload', 'event'];
const AUTHORITIES: readonly TrustedCorrelationAuthority[] = [
  'authenticated_application',
  'authenticated_agent_adapter',
  'attested_observer',
  'server_process_graph',
  'server_inventory',
  'inferred',
  'none',
];
const TRACE_ORIGINS: readonly TrustedCorrelationTraceOrigin[] = ['incoming', 'adapter', 'legacy_synthetic', 'none'];
const PROVENANCE_VALUES: readonly TrustedCorrelationProvenance[] = [
  'source_authenticated',
  'source_scope_bound',
  'application_invocation',
  'application_trace',
  'adapter_invocation',
  'adapter_tool_call',
  'adapter_session',
  'runtime_root_key',
  'runtime_agent_instance',
  'physical_workload',
  'process_tuple',
  'legacy_synthetic_trace',
  'inferred_episode',
  'unassigned',
];
const CLAIM_REJECTION_REASONS: readonly TrustedCorrelationClaimRejectionReason[] = [
  'source_unverified',
  'source_unauthenticated',
  'authority_mismatch',
  'claim_not_allowed',
  'binding_incomplete',
  'binding_mismatch',
  'claim_scope_mismatch',
  'invalid_claim',
  'claim_empty',
  'legacy_synthetic_trace',
];

export interface TrustedCorrelationClaimReceipt {
  kind: TrustedCorrelationClaimKind;
  decision: 'accepted' | 'rejected';
  reason: 'authorized' | TrustedCorrelationClaimRejectionReason;
}

export interface TrustedCorrelationV1 {
  schemaVersion: typeof TRUSTED_CORRELATION_SCHEMA_VERSION;
  identityVersion: typeof TRUSTED_CORRELATION_IDENTITY_VERSION;
  method: TrustedCorrelationMethod;
  scope: TrustedCorrelationScope;
  confidence: number;
  authority: TrustedCorrelationAuthority;
  inferred: boolean;
  traceOrigin: TrustedCorrelationTraceOrigin;
  provenance: TrustedCorrelationProvenance[];
  claimReceipts?: TrustedCorrelationClaimReceipt[];
  invocationId?: string;
  toolCallId?: string;
  agentRootInstanceId?: string;
  processInstanceId?: string;
  inferredEpisodeId?: string;
}

export interface TrustedCorrelationBindingScope {
  tenantId?: string;
  environmentId?: string;
  workspaceId?: string;
  workspacePath?: string;
  physicalWorkloadId?: string;
  agentScopeId?: string;
}

export type TrustedCorrelationClaimKind = 'application_trace' | 'agent_adapter';

/**
 * A capability created by API-side source authentication. Callers must not construct it from
 * event payload fields. `sourceId`, an ingest acceptance result, and inbound attribution are not
 * trust signals and are deliberately absent from this interface.
 */
export interface ServerSourceTrustContext {
  verification: 'server_verified';
  authenticated: boolean;
  authority: 'application' | 'agent_adapter';
  allowedClaims: TrustedCorrelationClaimKind[];
  bindings: TrustedCorrelationBindingScope;
  /** Low-cardinality server decision; producer payloads cannot set this value. */
  rejectionReason?: TrustedCorrelationClaimRejectionReason;
}

export interface TrustedApplicationClaim {
  /** Raw producer values. The resolver is the first component allowed to validate them. */
  invocationId?: unknown;
  traceId?: unknown;
  /** Server comparison against the immutable legacy field after legacy normalization. */
  traceConsistent?: boolean;
  scope?: TrustedCorrelationBindingScope;
}

export interface TrustedAgentAdapterClaim {
  /** Raw producer values. The resolver is the first component allowed to validate them. */
  invocationId?: unknown;
  toolCallId?: unknown;
  sessionId?: unknown;
  traceId?: unknown;
  /** Server comparisons against the immutable legacy fields after legacy normalization. */
  sessionConsistent?: boolean;
  traceConsistent?: boolean;
  scope?: TrustedCorrelationBindingScope;
}

export interface ServerObservedProcessIdentity {
  authority: 'attested_observer' | 'server_process_graph';
  /** Server-computed Canonical v1 ProcessInstance ID; producer payloads cannot supply it. */
  processInstanceId?: string;
  hostId?: string;
  bootId?: string;
  pid?: number;
  startTime?: string | number;
}

export interface ServerObservedRuntimeRoot {
  authority: 'attested_observer' | 'server_process_graph';
  agentScopeId?: string;
  rootKey?: string;
  agentInstanceId?: string;
}

export interface ServerObservedPhysicalWorkload {
  authority: 'attested_observer' | 'server_inventory';
  physicalWorkloadId?: string;
}

export interface ServerObservedInference {
  episodeId?: string;
  reason: 'temporal_proximity' | 'behavioral_window';
  confidence?: number;
}

export interface ServerObservedCorrelationContext {
  verification: 'server_observed';
  process?: ServerObservedProcessIdentity;
  runtimeRoot?: ServerObservedRuntimeRoot;
  physicalWorkload?: ServerObservedPhysicalWorkload;
  inferredEpisode?: ServerObservedInference;
}

export interface TrustedCorrelationInput {
  /** Scope assigned to the event by the server, never copied from an inbound attribution object. */
  eventContext: TrustedCorrelationBindingScope;
  sourceTrust?: ServerSourceTrustContext;
  claims?: {
    application?: TrustedApplicationClaim;
    agentAdapter?: TrustedAgentAdapterClaim;
  };
  observations?: ServerObservedCorrelationContext;
  legacy?: {
    traceId?: string;
    traceOrigin?: 'incoming' | 'legacy_synthetic' | 'none';
  };
}

export interface ServerTrustedCorrelationContext {
  sourceTrust?: ServerSourceTrustContext;
  claims?: TrustedCorrelationInput['claims'];
  /** True only after an observer_runtime Source policy matched an authenticated collector. */
  observerAttested?: boolean;
  /** Reserved for a server-owned process graph/snapshot implementation, never producer input. */
  serverProcessGraphObserved?: boolean;
  /** True only when the API joined the event to its own inventory/review state. */
  serverInventoryObserved?: boolean;
}

// Trust state deliberately travels out-of-band. EventMeta is a public ingest shape, so placing
// this capability on the payload would let a producer attempt to forge server authentication.
const SERVER_CONTEXTS = new WeakMap<object, ServerTrustedCorrelationContext>();

export function bindServerTrustedCorrelationContext<T extends object>(
  eventMeta: T,
  context: ServerTrustedCorrelationContext,
): T {
  SERVER_CONTEXTS.set(eventMeta, context);
  return eventMeta;
}

export function serverTrustedCorrelationContext(
  eventMeta: object,
): ServerTrustedCorrelationContext | undefined {
  return SERVER_CONTEXTS.get(eventMeta);
}

const MAX_SCOPE_TEXT = 500;
const MAX_ID_TEXT = 512;
const MAX_ROOT_KEY_TEXT = 1_024;
const SCOPE_KEYS = [
  'tenantId',
  'environmentId',
  'workspaceId',
  'workspacePath',
  'physicalWorkloadId',
  'agentScopeId',
] as const;

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Strictly validates persisted/public correlation data and returns a bounded v1 projection. */
export function parseTrustedCorrelation(value: unknown): TrustedCorrelationV1 | undefined {
  const input = record(value);
  if (!input) return undefined;
  if (input.schemaVersion !== TRUSTED_CORRELATION_SCHEMA_VERSION) return undefined;
  if (input.identityVersion !== TRUSTED_CORRELATION_IDENTITY_VERSION) return undefined;
  if (!METHODS.includes(input.method as TrustedCorrelationMethod)) return undefined;
  if (!SCOPES.includes(input.scope as TrustedCorrelationScope)) return undefined;
  if (!AUTHORITIES.includes(input.authority as TrustedCorrelationAuthority)) return undefined;
  if (!TRACE_ORIGINS.includes(input.traceOrigin as TrustedCorrelationTraceOrigin)) return undefined;
  if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) return undefined;
  if (typeof input.inferred !== 'boolean') return undefined;
  if (!Array.isArray(input.provenance) || input.provenance.length > 16) return undefined;
  const parsedProvenance = input.provenance.every((item) => PROVENANCE_VALUES.includes(item as TrustedCorrelationProvenance))
    ? [...new Set(input.provenance as TrustedCorrelationProvenance[])]
    : undefined;
  if (!parsedProvenance) return undefined;

  const optionalId = (key: keyof Pick<TrustedCorrelationV1,
    'invocationId' | 'toolCallId' | 'agentRootInstanceId' | 'processInstanceId' | 'inferredEpisodeId'>): string | undefined | null => {
    if (input[key] === undefined) return undefined;
    return boundedText(input[key], MAX_ID_TEXT) ?? null;
  };
  const invocationId = optionalId('invocationId');
  const toolCallId = optionalId('toolCallId');
  const agentRootInstanceId = optionalId('agentRootInstanceId');
  const processInstanceId = optionalId('processInstanceId');
  const inferredEpisodeId = optionalId('inferredEpisodeId');
  if ([invocationId, toolCallId, agentRootInstanceId, processInstanceId, inferredEpisodeId].includes(null)) return undefined;

  let claimReceipts: TrustedCorrelationClaimReceipt[] | undefined;
  if (input.claimReceipts !== undefined) {
    if (!Array.isArray(input.claimReceipts) || input.claimReceipts.length > 4) return undefined;
    claimReceipts = [];
    for (const item of input.claimReceipts) {
      const receipt = record(item);
      if (!receipt) return undefined;
      if (receipt.kind !== 'application_trace' && receipt.kind !== 'agent_adapter') return undefined;
      if (receipt.decision !== 'accepted' && receipt.decision !== 'rejected') return undefined;
      if (receipt.reason !== 'authorized' && !CLAIM_REJECTION_REASONS.includes(receipt.reason as TrustedCorrelationClaimRejectionReason)) return undefined;
      if ((receipt.decision === 'accepted') !== (receipt.reason === 'authorized')) return undefined;
      claimReceipts.push({
        kind: receipt.kind,
        decision: receipt.decision,
        reason: receipt.reason as TrustedCorrelationClaimReceipt['reason'],
      });
    }
  }

  const method = input.method as TrustedCorrelationMethod;
  const scope = input.scope as TrustedCorrelationScope;
  const authority = input.authority as TrustedCorrelationAuthority;
  const acceptedKinds = new Set(
    (claimReceipts ?? [])
      .filter((receipt) => receipt.decision === 'accepted')
      .map((receipt) => receipt.kind),
  );
  const hasProvenance = (value: TrustedCorrelationProvenance): boolean => parsedProvenance.includes(value);
  if (method === 'application_trace') {
    if (authority !== 'authenticated_application' || acceptedKinds.size !== 1 || !acceptedKinds.has('application_trace')) return undefined;
    if (!hasProvenance('source_authenticated') || !hasProvenance('source_scope_bound')) return undefined;
    if (invocationId) {
      if (scope !== 'invocation' || !hasProvenance('application_invocation')) return undefined;
    } else if (scope !== 'event' || !hasProvenance('application_trace')) return undefined;
  }
  if (method === 'agent_adapter') {
    if (authority !== 'authenticated_agent_adapter' || acceptedKinds.size !== 1 || !acceptedKinds.has('agent_adapter')) return undefined;
    if (!hasProvenance('source_authenticated') || !hasProvenance('source_scope_bound')) return undefined;
    if (invocationId) {
      if (scope !== 'invocation' || !hasProvenance('adapter_invocation')) return undefined;
    } else if (hasProvenance('adapter_session')) {
      if (scope !== 'agent_session') return undefined;
    } else if (scope !== 'event') return undefined;
    if (toolCallId && !hasProvenance('adapter_tool_call')) return undefined;
  }
  if (method === 'runtime_root' && (
    scope !== 'runtime' ||
    !['attested_observer', 'server_process_graph'].includes(authority) ||
    !agentRootInstanceId ||
    !hasProvenance('runtime_root_key')
  )) return undefined;
  if (method === 'physical_workload' && (
    scope !== 'workload' ||
    !['attested_observer', 'server_inventory'].includes(authority) ||
    !hasProvenance('physical_workload')
  )) return undefined;
  if (method === 'inferred_episode' && (
    scope !== 'event' ||
    authority !== 'inferred' ||
    input.inferred !== true ||
    !inferredEpisodeId ||
    !hasProvenance('inferred_episode')
  )) return undefined;
  if (method === 'unassigned' && (
    scope !== 'event' ||
    input.confidence !== 0 ||
    !['none', 'attested_observer', 'server_process_graph'].includes(authority) ||
    !hasProvenance('unassigned')
  )) return undefined;
  if (method !== 'application_trace' && method !== 'agent_adapter' && acceptedKinds.size > 0) return undefined;
  if (method !== 'inferred_episode' && input.inferred !== false) return undefined;
  if (invocationId && method !== 'application_trace' && method !== 'agent_adapter') return undefined;
  if (toolCallId && method !== 'agent_adapter') return undefined;
  if (inferredEpisodeId && method !== 'inferred_episode') return undefined;
  if (agentRootInstanceId && !['application_trace', 'agent_adapter', 'runtime_root'].includes(method)) return undefined;
  if (agentRootInstanceId && !/^agent-root:v1:[a-f0-9]{64}$/u.test(agentRootInstanceId)) return undefined;
  if (agentRootInstanceId && !hasProvenance('runtime_root_key')) return undefined;
  if (!agentRootInstanceId && hasProvenance('runtime_root_key')) return undefined;
  if (processInstanceId && !/^pri_[a-f0-9]{24}$/u.test(processInstanceId)) return undefined;
  if (processInstanceId && !hasProvenance('process_tuple')) return undefined;
  if (!processInstanceId && hasProvenance('process_tuple')) return undefined;

  return {
    schemaVersion: TRUSTED_CORRELATION_SCHEMA_VERSION,
    identityVersion: TRUSTED_CORRELATION_IDENTITY_VERSION,
    method,
    scope,
    confidence: input.confidence,
    authority,
    inferred: input.inferred,
    traceOrigin: input.traceOrigin as TrustedCorrelationTraceOrigin,
    provenance: parsedProvenance,
    ...(claimReceipts ? { claimReceipts } : {}),
    ...(typeof invocationId === 'string' ? { invocationId } : {}),
    ...(typeof toolCallId === 'string' ? { toolCallId } : {}),
    ...(typeof agentRootInstanceId === 'string' ? { agentRootInstanceId } : {}),
    ...(typeof processInstanceId === 'string' ? { processInstanceId } : {}),
    ...(typeof inferredEpisodeId === 'string' ? { inferredEpisodeId } : {}),
  };
}

function scopeValue(scope: TrustedCorrelationBindingScope | undefined, key: typeof SCOPE_KEYS[number]): string | undefined {
  return boundedText(scope?.[key], MAX_SCOPE_TEXT);
}

function scopeIsWellFormed(scope: TrustedCorrelationBindingScope | undefined): boolean {
  if (!scope) return true;
  return SCOPE_KEYS.every((key) => scope[key] === undefined || scopeValue(scope, key) !== undefined);
}

function sourceHasRequiredBinding(bindings: TrustedCorrelationBindingScope): boolean {
  return Boolean(
    scopeValue(bindings, 'tenantId') &&
    scopeValue(bindings, 'environmentId') &&
    (
      scopeValue(bindings, 'workspaceId') ||
      scopeValue(bindings, 'workspacePath') ||
      scopeValue(bindings, 'physicalWorkloadId') ||
      scopeValue(bindings, 'agentScopeId')
    ),
  );
}

function boundScopeMatchesEvent(
  bindings: TrustedCorrelationBindingScope,
  eventContext: TrustedCorrelationBindingScope,
): boolean {
  if (!scopeIsWellFormed(bindings) || !scopeIsWellFormed(eventContext)) return false;
  return SCOPE_KEYS.every((key) => {
    const bound = scopeValue(bindings, key);
    return !bound || bound === scopeValue(eventContext, key);
  });
}

function claimScopeMatchesEvent(
  claimScope: TrustedCorrelationBindingScope | undefined,
  eventContext: TrustedCorrelationBindingScope,
): boolean {
  if (!scopeIsWellFormed(claimScope) || !scopeIsWellFormed(eventContext)) return false;
  return SCOPE_KEYS.every((key) => {
    const claimed = scopeValue(claimScope, key);
    return !claimed || claimed === scopeValue(eventContext, key);
  });
}

function claimAuthorization(
  input: TrustedCorrelationInput,
  kind: TrustedCorrelationClaimKind,
  claimScope: TrustedCorrelationBindingScope | undefined,
): 'authorized' | TrustedCorrelationClaimRejectionReason {
  const trust = input.sourceTrust;
  const expectedAuthority = kind === 'application_trace' ? 'application' : 'agent_adapter';
  if (!trust || trust.verification !== 'server_verified') return 'source_unverified';
  if (trust.authenticated !== true) return 'source_unauthenticated';
  if (trust.rejectionReason) return trust.rejectionReason;
  if (trust.authority !== expectedAuthority) return 'authority_mismatch';
  if (!Array.isArray(trust.allowedClaims) || !trust.allowedClaims.includes(kind)) return 'claim_not_allowed';
  if (!sourceHasRequiredBinding(trust.bindings)) return 'binding_incomplete';
  if (!boundScopeMatchesEvent(trust.bindings, input.eventContext)) return 'binding_mismatch';
  if (!claimScopeMatchesEvent(claimScope, input.eventContext)) return 'claim_scope_mismatch';
  return 'authorized';
}

function processIdentity(process: ServerObservedProcessIdentity | undefined): {
  processInstanceId?: string;
  authority?: 'attested_observer' | 'server_process_graph';
} {
  if (process?.authority !== 'attested_observer' && process?.authority !== 'server_process_graph') return {};
  const hostId = boundedText(process?.hostId, MAX_ID_TEXT);
  const bootId = boundedText(process?.bootId, MAX_ID_TEXT);
  const pid = process?.pid;
  const rawStartTime = process?.startTime;
  const startTime = typeof rawStartTime === 'number'
    ? (Number.isSafeInteger(rawStartTime) && rawStartTime >= 0 ? String(rawStartTime) : undefined)
    : boundedText(rawStartTime, MAX_ID_TEXT);
  const processInstanceId = boundedText(process?.processInstanceId, MAX_ID_TEXT);
  if (!hostId || !bootId || !Number.isSafeInteger(pid) || (pid ?? 0) <= 0 || !startTime || !processInstanceId) return {};
  return {
    processInstanceId,
    authority: process.authority,
  };
}

function rootIdentity(root: ServerObservedRuntimeRoot | undefined): {
  agentRootInstanceId?: string;
  provenance?: TrustedCorrelationProvenance;
  authority?: 'attested_observer' | 'server_process_graph';
} {
  if (root?.authority !== 'attested_observer' && root?.authority !== 'server_process_graph') return {};
  const scope = boundedText(root?.agentScopeId, MAX_SCOPE_TEXT);
  const rootKey = boundedText(root?.rootKey, MAX_ROOT_KEY_TEXT);
  if (!scope || !rootKey) return {};
  const digest = createHash('sha256')
    .update(JSON.stringify(['root', scope, rootKey]))
    .digest('hex');
  return {
    agentRootInstanceId: `agent-root:v1:${digest}`,
    provenance: 'runtime_root_key',
    authority: root.authority,
  };
}

function legacyTraceOrigin(input: TrustedCorrelationInput): TrustedCorrelationTraceOrigin {
  const traceId = boundedText(input.legacy?.traceId, MAX_ID_TEXT);
  if (!traceId) return 'none';
  return input.legacy?.traceOrigin === 'legacy_synthetic'
    ? 'legacy_synthetic'
    : input.legacy?.traceOrigin === 'incoming'
      ? 'incoming'
      : 'none';
}

function provenance(
  values: Array<TrustedCorrelationProvenance | undefined>,
): TrustedCorrelationProvenance[] {
  return [...new Set(values.filter((value): value is TrustedCorrelationProvenance => Boolean(value)))].slice(0, 16);
}

function result(
  fields: Omit<TrustedCorrelationV1, 'schemaVersion' | 'identityVersion' | 'confidence' | 'provenance'> & {
    confidence: number;
    provenance: Array<TrustedCorrelationProvenance | undefined>;
  },
): TrustedCorrelationV1 {
  return {
    schemaVersion: TRUSTED_CORRELATION_SCHEMA_VERSION,
    identityVersion: TRUSTED_CORRELATION_IDENTITY_VERSION,
    ...fields,
    confidence: Math.min(1, Math.max(0, Number.isFinite(fields.confidence) ? fields.confidence : 0)),
    provenance: provenance(fields.provenance),
  };
}

function claimReceipt(
  kind: TrustedCorrelationClaimKind,
  authorization: 'authorized' | TrustedCorrelationClaimRejectionReason,
  usable: boolean,
  invalid: boolean,
  unusableReason: 'claim_empty' | 'legacy_synthetic_trace' = 'claim_empty',
): TrustedCorrelationClaimReceipt {
  if (authorization !== 'authorized') return { kind, decision: 'rejected', reason: authorization };
  if (invalid) return { kind, decision: 'rejected', reason: 'invalid_claim' };
  if (!usable) return { kind, decision: 'rejected', reason: unusableReason };
  return { kind, decision: 'accepted', reason: 'authorized' };
}

function hasInvalidText(values: Array<{ value: unknown; maxLength: number }>): boolean {
  return values.some(({ value, maxLength }) => value !== undefined && boundedText(value, maxLength) === undefined);
}

/**
 * Resolves an additive trusted-correlation view. The function never returns or rewrites legacy
 * `agentId`, `sessionId`, `traceId`, or `runId`; callers dual-write this result separately.
 */
export function resolveTrustedCorrelation(input: TrustedCorrelationInput): TrustedCorrelationV1 {
  const observerVerified = input.observations?.verification === 'server_observed';
  const process = observerVerified ? processIdentity(input.observations?.process) : {};
  const processId = process.processInstanceId;
  const root = observerVerified ? rootIdentity(input.observations?.runtimeRoot) : {};
  const workloadAuthority = input.observations?.physicalWorkload?.authority;
  const physicalWorkloadId = observerVerified &&
    (workloadAuthority === 'attested_observer' || workloadAuthority === 'server_inventory')
    ? boundedText(input.observations?.physicalWorkload?.physicalWorkloadId, MAX_SCOPE_TEXT)
    : undefined;
  const previousTraceOrigin = legacyTraceOrigin(input);
  const observerProvenance = [root.provenance, processId ? 'process_tuple' as const : undefined];

  const application = input.claims?.application;
  const applicationInvocationId = boundedText(application?.invocationId, MAX_ID_TEXT);
  const rawApplicationTraceId = boundedText(application?.traceId, MAX_ID_TEXT);
  const applicationTraceId = application?.traceConsistent === false ? undefined : rawApplicationTraceId;
  const applicationTraceConflictsWithLegacySynthetic = Boolean(
    applicationTraceId &&
    previousTraceOrigin === 'legacy_synthetic' &&
    applicationTraceId === boundedText(input.legacy?.traceId, MAX_ID_TEXT),
  );
  const trustedApplicationTraceId = applicationTraceConflictsWithLegacySynthetic
    ? undefined
    : applicationTraceId;
  const applicationAuthorization = claimAuthorization(input, 'application_trace', application?.scope);
  const applicationInvocationInvalid = hasInvalidText([
    { value: application?.invocationId, maxLength: MAX_ID_TEXT },
  ]);
  const applicationTraceInvalid = hasInvalidText([
    { value: application?.traceId, maxLength: MAX_ID_TEXT },
  ]) || application?.traceConsistent === false;
  // A valid Invocation remains useful even when an optional legacy Trace claim was normalized by
  // the old pipeline. Without an Invocation, the Trace itself must match the stored legacy value.
  const applicationInvalid = applicationInvocationInvalid ||
    (!applicationInvocationId && applicationTraceInvalid);
  const applicationUsable = Boolean(applicationInvocationId || trustedApplicationTraceId);
  const applicationReceipt = application
    ? claimReceipt(
      'application_trace',
      applicationAuthorization,
      applicationUsable,
      applicationInvalid,
      applicationTraceConflictsWithLegacySynthetic ? 'legacy_synthetic_trace' : 'claim_empty',
    )
    : undefined;
  if (applicationReceipt?.decision === 'accepted') {
    return result({
      method: 'application_trace',
      scope: applicationInvocationId ? 'invocation' : 'event',
      confidence: applicationInvocationId && trustedApplicationTraceId ? 1 : 0.97,
      authority: 'authenticated_application',
      inferred: false,
      traceOrigin: trustedApplicationTraceId ? 'incoming' : previousTraceOrigin,
      provenance: [
        'source_authenticated',
        'source_scope_bound',
        applicationInvocationId ? 'application_invocation' : undefined,
        trustedApplicationTraceId ? 'application_trace' : undefined,
        previousTraceOrigin === 'legacy_synthetic' ? 'legacy_synthetic_trace' : undefined,
        ...observerProvenance,
      ],
      claimReceipts: [applicationReceipt],
      invocationId: applicationInvocationId,
      agentRootInstanceId: root.agentRootInstanceId,
      processInstanceId: processId,
    });
  }

  const adapter = input.claims?.agentAdapter;
  const adapterInvocationId = boundedText(adapter?.invocationId, MAX_ID_TEXT);
  const adapterToolCallId = boundedText(adapter?.toolCallId, MAX_ID_TEXT);
  const rawAdapterSessionId = boundedText(adapter?.sessionId, MAX_ID_TEXT);
  const rawAdapterTraceId = boundedText(adapter?.traceId, MAX_ID_TEXT);
  const adapterSessionId = adapter?.sessionConsistent === false ? undefined : rawAdapterSessionId;
  const adapterTraceId = adapter?.traceConsistent === false ? undefined : rawAdapterTraceId;
  const adapterAuthorization = claimAuthorization(input, 'agent_adapter', adapter?.scope);
  const adapterPrimaryInvalid = hasInvalidText([
    { value: adapter?.invocationId, maxLength: MAX_ID_TEXT },
    { value: adapter?.toolCallId, maxLength: MAX_ID_TEXT },
  ]);
  const adapterSessionInvalid = hasInvalidText([
    { value: adapter?.sessionId, maxLength: MAX_ID_TEXT },
  ]) || adapter?.sessionConsistent === false;
  const adapterTraceInvalid = hasInvalidText([
    { value: adapter?.traceId, maxLength: MAX_ID_TEXT },
  ]) || adapter?.traceConsistent === false;
  const adapterInvalid = adapterPrimaryInvalid ||
    (!adapterInvocationId && !adapterToolCallId && adapterSessionInvalid) ||
    (!adapterInvocationId && !adapterToolCallId && !adapterSessionId && adapterTraceInvalid);
  const adapterReceipt = adapter
    ? claimReceipt(
      'agent_adapter',
      adapterAuthorization,
      Boolean(adapterInvocationId || adapterToolCallId || adapterSessionId || adapterTraceId),
      adapterInvalid,
    )
    : undefined;
  const rejectedReceipts = [applicationReceipt, adapterReceipt]
    .filter((receipt): receipt is TrustedCorrelationClaimReceipt => Boolean(receipt));
  if (adapterReceipt?.decision === 'accepted') {
    return result({
      method: 'agent_adapter',
      scope: adapterInvocationId
        ? 'invocation'
        : adapterSessionId
          ? 'agent_session'
          : 'event',
      confidence: adapterInvocationId ? 0.99 : adapterSessionId ? 0.95 : 0.9,
      authority: 'authenticated_agent_adapter',
      inferred: false,
      traceOrigin: adapterTraceId ? 'adapter' : previousTraceOrigin,
      provenance: [
        'source_authenticated',
        'source_scope_bound',
        adapterInvocationId ? 'adapter_invocation' : undefined,
        adapterToolCallId ? 'adapter_tool_call' : undefined,
        adapterSessionId ? 'adapter_session' : undefined,
        previousTraceOrigin === 'legacy_synthetic' ? 'legacy_synthetic_trace' : undefined,
        ...observerProvenance,
      ],
      claimReceipts: rejectedReceipts,
      invocationId: adapterInvocationId,
      toolCallId: adapterToolCallId,
      agentRootInstanceId: root.agentRootInstanceId,
      processInstanceId: processId,
    });
  }

  if (root.agentRootInstanceId) {
    return result({
      method: 'runtime_root',
      scope: 'runtime',
      confidence: processId ? 0.92 : 0.85,
      authority: root.authority ?? 'none',
      inferred: false,
      traceOrigin: previousTraceOrigin,
      provenance: [
        root.provenance,
        processId ? 'process_tuple' : undefined,
        previousTraceOrigin === 'legacy_synthetic' ? 'legacy_synthetic_trace' : undefined,
      ],
      claimReceipts: rejectedReceipts.length ? rejectedReceipts : undefined,
      agentRootInstanceId: root.agentRootInstanceId,
      processInstanceId: processId,
    });
  }

  if (physicalWorkloadId) {
    return result({
      method: 'physical_workload',
      scope: 'workload',
      confidence: 0.7,
      authority: workloadAuthority === 'attested_observer' ? 'attested_observer' : 'server_inventory',
      inferred: false,
      traceOrigin: previousTraceOrigin,
      provenance: [
        'physical_workload',
        processId ? 'process_tuple' : undefined,
        previousTraceOrigin === 'legacy_synthetic' ? 'legacy_synthetic_trace' : undefined,
      ],
      claimReceipts: rejectedReceipts.length ? rejectedReceipts : undefined,
      processInstanceId: processId,
    });
  }

  const inference = observerVerified ? input.observations?.inferredEpisode : undefined;
  const inferredEpisodeId = boundedText(inference?.episodeId, MAX_ID_TEXT);
  if (inferredEpisodeId && (inference?.reason === 'temporal_proximity' || inference?.reason === 'behavioral_window')) {
    return result({
      method: 'inferred_episode',
      scope: 'event',
      confidence: Math.min(0.49, inference.confidence ?? 0.3),
      authority: 'inferred',
      inferred: true,
      traceOrigin: previousTraceOrigin,
      provenance: [
        'inferred_episode',
        processId ? 'process_tuple' : undefined,
        previousTraceOrigin === 'legacy_synthetic' ? 'legacy_synthetic_trace' : undefined,
      ],
      claimReceipts: rejectedReceipts.length ? rejectedReceipts : undefined,
      processInstanceId: processId,
      inferredEpisodeId,
    });
  }

  return result({
    method: 'unassigned',
    scope: 'event',
    confidence: 0,
    authority: process.authority ?? 'none',
    inferred: false,
    traceOrigin: previousTraceOrigin,
    provenance: [
      processId ? 'process_tuple' : undefined,
      previousTraceOrigin === 'legacy_synthetic' ? 'legacy_synthetic_trace' : undefined,
      'unassigned',
    ],
    claimReceipts: rejectedReceipts.length ? rejectedReceipts : undefined,
    processInstanceId: processId,
  });
}
