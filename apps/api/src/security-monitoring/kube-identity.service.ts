import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import * as https from 'node:https';
import { parse as parseYaml } from 'yaml';
import {
  EventMeta,
  PlatformHealthcheckSpec,
  WorkloadRole,
  WorkloadIdentitySnapshot,
  WorkloadIdentitySnapshotEntry,
} from './types';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const DEFAULT_AGENT_SELECTOR = 'anysentry.io/workload-kind=agent';
const WORKLOAD_KIND_LABEL = 'anysentry.io/workload-kind';
const WORKLOAD_ROLE_LABEL = 'anysentry.io/workload-role';
const LEGACY_OBSERVE_LABEL = 'io.anysentry.observe';
const AGENT_ID_LABEL = 'anysentry.io/agent-id';
const AGENT_CONTAINER_LABEL = 'anysentry.io/agent-container';
const WATCH_TIMEOUT_SECONDS = 300;
const WORKLOAD_ROLES = new Set<WorkloadRole>([
  'agent',
  'anysentry_internal',
  'platform_infrastructure',
  'business_service',
  'ordinary_process',
  'unknown',
]);

interface KubeMetadata {
  uid?: string;
  name?: string;
  namespace?: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: Array<{
    kind?: string;
    name?: string;
    uid?: string;
    controller?: boolean;
  }>;
}

interface KubeContainerStatus {
  name?: string;
  containerID?: string;
  image?: string;
  imageID?: string;
  ready?: boolean;
  restartCount?: number;
}

interface KubeProbe {
  exec?: { command?: string[] };
}

interface KubeContainer {
  name?: string;
  image?: string;
  env?: Array<{ name?: string; value?: string; valueFrom?: unknown }>;
  envFrom?: Array<{ configMapRef?: { name?: string; optional?: boolean }; secretRef?: unknown }>;
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
  livenessProbe?: KubeProbe;
  readinessProbe?: KubeProbe;
  startupProbe?: KubeProbe;
}

interface KubePod {
  metadata?: KubeMetadata;
  spec?: {
    nodeName?: string;
    containers?: KubeContainer[];
  };
  status?: {
    phase?: string;
    podIP?: string;
    startTime?: string;
    containerStatuses?: KubeContainerStatus[];
  };
}

interface KubePodList {
  metadata?: {
    resourceVersion?: string;
    continue?: string;
  };
  items?: KubePod[];
}

interface KubeService {
  metadata?: KubeMetadata;
  spec?: {
    selector?: Record<string, string>;
    clusterIP?: string;
    clusterIPs?: string[];
    type?: string;
    ports?: Array<{ name?: string; port?: number; targetPort?: string | number }>;
  };
}

interface KubeServiceList {
  metadata?: { continue?: string };
  items?: KubeService[];
}

interface KubeConfigMap {
  metadata?: KubeMetadata;
  data?: Record<string, string>;
}

interface KubeConfigMapList {
  metadata?: { continue?: string };
  items?: KubeConfigMap[];
}

export interface KubeServiceMetric {
  name: string;
  value: number;
  unit: string;
  category: 'availability' | 'capacity' | 'saturation';
  status: 'normal' | 'anomalous' | 'unknown';
  observedAt: number;
}

export interface KubeServiceAsset {
  serviceAssetId: string;
  name: string;
  namespace: string;
  clusterId: string;
  kind: 'service' | 'database' | 'queue';
  role: WorkloadRole;
  ownerKind?: string;
  ownerName?: string;
  revision: string;
  images: string[];
  replicas: { observed: number; ready: number };
  restarts: number;
  phaseCounts: Record<string, number>;
  cpuRequestCores?: number;
  cpuLimitCores?: number;
  memoryRequestBytes?: number;
  memoryLimitBytes?: number;
  physicalWorkloadIds: string[];
  runtimeInstanceIds: string[];
  endpointAliases: string[];
  metrics: KubeServiceMetric[];
  observedAt: number;
}

export interface KubeServiceDependency {
  edgeId: string;
  sourceServiceAssetId: string;
  targetServiceAssetId: string;
  relation: 'calls' | 'queries' | 'publishes';
  source: 'kubernetes_declared_configuration';
  confidence: number;
  observedAt: number;
}

export interface KubeServiceChange {
  changeId: string;
  serviceAssetId: string;
  type: 'deployment' | 'image' | 'restart' | 'scale';
  summary: string;
  revision: string;
  at: number;
}

export interface KubeServiceInventorySnapshot {
  schemaVersion: 'anysentry.service_inventory.v1';
  version: number;
  generatedAt: string;
  ready: boolean;
  errors: number;
  items: KubeServiceAsset[];
  dependencies: KubeServiceDependency[];
  changes: KubeServiceChange[];
}

interface KubeReplicaSet {
  metadata?: KubeMetadata;
}

interface KubeReplicaSetList {
  metadata?: { continue?: string };
  items?: KubeReplicaSet[];
}

interface KubeWatchEvent {
  type?: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';
  object?: KubePod & { code?: number };
}

interface Tombstone {
  entries: WorkloadIdentitySnapshotEntry[];
  expiresAt: number;
}

export interface AuthenticatedAgentSemanticEnrichment {
  meta: EventMeta;
  inventoryObserved: boolean;
  reason:
    | 'matched'
    | 'agent_scope_missing'
    | 'agent_scope_not_bound'
    | 'inventory_miss'
    | 'inventory_ambiguous'
    | 'physical_scope_conflict';
}

interface KubeConfigDocument {
  'current-context'?: string;
  clusters?: Array<{
    name?: string;
    cluster?: {
      server?: string;
      'certificate-authority'?: string;
      'certificate-authority-data'?: string;
      'insecure-skip-tls-verify'?: boolean;
    };
  }>;
  contexts?: Array<{
    name?: string;
    context?: {
      cluster?: string;
      user?: string;
    };
  }>;
  users?: Array<{
    name?: string;
    user?: {
      token?: string;
      'tokenFile'?: string;
      'client-certificate'?: string;
      'client-certificate-data'?: string;
      'client-key'?: string;
      'client-key-data'?: string;
    };
  }>;
}

interface KubeConnection {
  server: URL;
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  token?: string;
  rejectUnauthorized: boolean;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedContainerId(value: unknown): string | undefined {
  const id = String(value ?? '').trim().replace(/^[a-z0-9._-]+:\/\//i, '');
  return id || undefined;
}

function explicitWorkloadRole(labels: Record<string, string>): WorkloadRole | undefined {
  const role = labels[WORKLOAD_ROLE_LABEL] as WorkloadRole | undefined;
  return role && WORKLOAD_ROLES.has(role) ? role : undefined;
}

function selectorMatches(labels: Record<string, string>, selector: string): boolean {
  const requirements = selector.split(',').map((item) => item.trim()).filter(Boolean);
  if (!requirements.length) return false;
  return requirements.every((requirement) => {
    const match = /^([^!=\s]+)\s*(?:==|=)\s*(.+)$/.exec(requirement);
    return Boolean(match && labels[match[1]] === match[2]);
  });
}

function boundedLabels(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels)
      .slice(0, 64)
      .map(([key, value]) => [key.slice(0, 128), String(value).slice(0, 256)]),
  );
}

function stableDigest(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function cpuCores(value: unknown): number | undefined {
  const text = String(value ?? '').trim();
  const match = /^(\d+(?:\.\d+)?)(n|u|m)?$/u.exec(text);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const scale = match[2] === 'n' ? 1e-9 : match[2] === 'u' ? 1e-6 : match[2] === 'm' ? 1e-3 : 1;
  return Number.isFinite(amount) ? amount * scale : undefined;
}

function memoryBytes(value: unknown): number | undefined {
  const text = String(value ?? '').trim();
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/u.exec(text);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const scales: Record<string, number> = {
    Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40,
    K: 1e3, M: 1e6, G: 1e9, T: 1e12,
  };
  const result = amount * (scales[match[2] ?? ''] ?? 1);
  return Number.isFinite(result) ? result : undefined;
}

function selectorMatchesLabels(labels: Record<string, string>, selector: Record<string, string>): boolean {
  const entries = Object.entries(selector);
  return entries.length > 0 && entries.every(([key, value]) => labels[key] === value);
}

function serviceKind(name: string, images: readonly string[]): KubeServiceAsset['kind'] {
  const value = `${name} ${images.join(' ')}`.toLowerCase();
  if (/(?:^|[^a-z])(clickhouse|postgres(?:ql)?|mysql|mariadb|mongodb|redis|elasticsearch)(?:[^a-z]|$)/u.test(value)) {
    return 'database';
  }
  if (/(?:^|[^a-z])(kafka|rabbitmq|nats|pulsar)(?:[^a-z]|$)/u.test(value)) return 'queue';
  return 'service';
}

function inferredServiceRole(
  namespace: string,
  name: string,
  images: readonly string[],
  stableService = false,
): WorkloadRole {
  const value = `${namespace} ${name} ${images.join(' ')}`.toLowerCase();
  if ((namespace === 'default' && name === 'kubernetes') ||
      namespace === 'kube-system' || /(?:kube-apiserver|etcd|coredns|containerd|kindnet)/u.test(value)) {
    return 'platform_infrastructure';
  }
  if (namespace === 'anysentry' || /(?:^|[^a-z])anysentry(?:[^a-z]|$)/u.test(value)) {
    return 'anysentry_internal';
  }
  if (serviceKind(name, images) !== 'service') return 'platform_infrastructure';
  // A Kubernetes Service/managed workload is already a stable service fact even when it has no
  // AnySentry-specific label. Keep raw container identity conservative: only the Service Asset
  // builder opts into this business role after proving a stable Service/owner/app identity.
  return stableService ? 'business_service' : 'unknown';
}

function endpointHost(value: string): string {
  const normalized = value.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '');
  const authority = normalized.split('/')[0].split('@').at(-1) ?? normalized;
  if (authority.startsWith('[')) return authority.slice(1, authority.indexOf(']'));
  return authority.replace(/:\d+$/u, '').replace(/\.$/u, '').toLowerCase();
}

function declaredDependencyHosts(key: string, value: string): string[] {
  const normalizedKey = key.trim().toUpperCase();
  // Only endpoint-bearing configuration participates in topology. Values such as
  // CLICKHOUSE_USER/CLICKHOUSE_DB frequently equal another Service name and previously created
  // convincing but reversed dependency edges.
  if (!/(?:^|_)(?:URL|URI|ENDPOINTS?|HOSTS?|ADDR|ADDRESS|BROKERS?|BOOTSTRAP_SERVERS?|SERVICE_ADDR|SERVICE_ADDRESS)$/u
    .test(normalizedKey)) return [];
  return [...new Set(value
    .split(/[\s,]+/u)
    .map(endpointHost)
    .filter((host) => host && host.length <= 253 && /^[a-z0-9_.:-]+$/u.test(host)))];
}

function boundedProbeCommand(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined;
  if (value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 2_048)) {
    return undefined;
  }
  return value.map((item) => item as string);
}

function platformHealthchecksForContainer(container: KubeContainer | undefined): PlatformHealthcheckSpec[] {
  if (!container) return [];
  const probes: Array<[PlatformHealthcheckSpec['activitySubtype'], KubeProbe | undefined]> = [
    ['k8s_liveness_probe', container.livenessProbe],
    ['k8s_readiness_probe', container.readinessProbe],
    ['k8s_startup_probe', container.startupProbe],
  ];
  return probes.flatMap(([activitySubtype, probe]) => {
    const argv = boundedProbeCommand(probe?.exec?.command);
    return argv ? [{ activitySubtype, argv }] : [];
  });
}

function firstKubeconfigPath(): string {
  const configured =
    process.env.ANYSENTRY_KUBECONFIG?.trim() ||
    process.env.KUBECONFIG?.split(delimiter).map((value) => value.trim()).find(Boolean);
  return resolve(configured || `${homedir()}/.kube/config`);
}

function configBytes(
  configDirectory: string,
  encoded: string | undefined,
  filename: string | undefined,
): Buffer | undefined {
  if (encoded?.trim()) return Buffer.from(encoded.trim(), 'base64');
  if (!filename?.trim()) return undefined;
  return readFileSync(isAbsolute(filename) ? filename : resolve(configDirectory, filename));
}

/**
 * Kubernetes workload registry for the observation filter.
 *
 * The service performs an initial list and then watches Pod lifecycle updates. Its snapshot is
 * consumed by node forwarders outside their event hot path. It never blocks or rejects workload
 * operations, and API-side enrichment is deliberately fail-open.
 */
@Injectable()
export class KubeIdentityService implements OnModuleInit, OnModuleDestroy {
  private readonly podsByNamespace = new Map<string, Map<string, KubePod>>();
  private readonly servicesByNamespace = new Map<string, Map<string, KubeService>>();
  private readonly configMapsByNamespace = new Map<string, Map<string, KubeConfigMap>>();
  private readonly replicaSetOwners = new Map<string, { kind?: string; name?: string }>();
  private readonly resourceVersions = new Map<string, string>();
  private readonly readyNamespaces = new Set<string>();
  private readonly serviceReadyNamespaces = new Set<string>();
  private readonly watches = new Map<string, ReturnType<typeof https.request>>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly tombstones = new Map<string, Tombstone>();
  private byId = new Map<string, WorkloadIdentitySnapshotEntry>();
  private entries: WorkloadIdentitySnapshotEntry[] = [];
  private serviceAssets: KubeServiceAsset[] = [];
  private serviceAssetById = new Map<string, KubeServiceAsset>();
  private serviceOwnerByPhysicalPrefix = new Map<string, string | null>();
  private serviceDependencies: KubeServiceDependency[] = [];
  private readonly serviceChanges: KubeServiceChange[] = [];
  private serviceStates = new Map<string, {
    revision: string;
    images: string[];
    replicas: number;
    restarts: number;
  }>();
  private version = 0;
  private errorCount = 0;
  private serviceErrorCount = 0;
  private destroyed = false;
  private connection?: KubeConnection;

  private readonly enabled =
    (
      Boolean(process.env.KUBERNETES_SERVICE_HOST) ||
      existsSync(firstKubeconfigPath())
    ) &&
    process.env.ANYSENTRY_KUBE_ENRICH !== 'off';
  private readonly agentNs = (
    process.env.ANYSENTRY_IDENTITY_NAMESPACES ??
    process.env.ANYSENTRY_AGENT_NAMESPACES ??
    '*'
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  private readonly agentSelector =
    process.env.ANYSENTRY_AGENT_LABEL_SELECTOR?.trim() || DEFAULT_AGENT_SELECTOR;
  private readonly clusterId =
    process.env.ANYSENTRY_CLUSTER_ID?.trim() || 'kubernetes';
  private readonly tombstoneTtlMs = positiveNumber(
    process.env.ANYSENTRY_IDENTITY_TOMBSTONE_SECS,
    120,
  ) * 1000;
  private readonly maxTombstones = positiveNumber(
    process.env.ANYSENTRY_IDENTITY_MAX_TOMBSTONES,
    10_000,
  );

  onModuleInit(): void {
    if (!this.enabled) return;
    for (const namespace of this.agentNs) void this.relistAndWatch(namespace);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    for (const request of this.watches.values()) request.destroy();
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.watches.clear();
    this.reconnectTimers.clear();
  }

  /**
   * Compatibility enrichment for direct `/ingest` producers. Filtering belongs to the
   * forwarder; this method never drops an event.
   */
  enrich(meta: EventMeta): EventMeta {
    if (meta.attribution?.classification) return meta;
    const entry = this.byId.get(meta.sessionId) ?? this.byId.get(meta.agentId);
    if (!entry) return meta;
    const monitored =
      entry.classification === 'confirmed_agent' ||
      entry.classification === 'probable_agent';
    return {
      ...meta,
      ...(monitored && entry.agentScopeId
        ? {
            agentId: entry.agentScopeId,
            sessionId: entry.agentInstanceId ?? entry.agentScopeId,
            workspacePath: `${entry.namespace ?? 'kubernetes'}/${entry.podName ?? entry.agentScopeId}`,
          }
        : {}),
      attribution: {
        monitored,
        classification: entry.classification,
        agentScopeId: entry.agentScopeId,
        agentDisplayName: entry.agentDisplayName,
        agentInstanceId: entry.agentInstanceId,
        physicalWorkloadId: entry.physicalWorkloadId,
        workloadRef: {
          environment: 'kubernetes',
          kind: entry.containerName ? 'container' : 'pod',
          name: entry.podName ?? entry.containerName,
          namespace: entry.namespace,
          podName: entry.podName,
          podUid: entry.podUid,
          nodeName: entry.nodeName,
          containerName: entry.containerName,
          containerImage: entry.containerImage,
          ownerKind: entry.ownerKind,
          ownerName: entry.ownerName,
        },
        confidence: entry.classification === 'confirmed_agent' ? 1 : entry.classification === 'probable_agent' ? 0.7 : 0,
        reason:
          entry.classification === 'confirmed_agent'
            ? 'authoritative_anchor'
            : entry.classification === 'non_agent'
              ? 'not_agent'
              : 'not_evaluated',
        source: 'kubernetes',
        evidence: entry.evidence,
      },
    };
  }

  /**
   * Joins an authenticated semantic Agent event to server-owned Kubernetes inventory.
   *
   * The caller is responsible for proving Source authentication and adapter authority before
   * invoking this method. `meta.agentId` is only a lookup key: the positive identity and runtime
   * come from an exact inventory label/container entry. Ambiguous replicas and physical-scope
   * conflicts deliberately remain unmerged.
   */
  enrichAuthenticatedAgentSemantic(
    meta: EventMeta,
    boundAgentScopeIds: readonly string[] = [],
  ): AuthenticatedAgentSemanticEnrichment {
    const claimedAgentScopeId = meta.agentId?.trim();
    if (!claimedAgentScopeId) {
      return { meta, inventoryObserved: false, reason: 'agent_scope_missing' };
    }
    if (boundAgentScopeIds.length > 0 && !boundAgentScopeIds.includes(claimedAgentScopeId)) {
      return { meta, inventoryObserved: false, reason: 'agent_scope_not_bound' };
    }

    const activeEntries = this.entries.filter((entry) =>
      !entry.evidence.includes('kubernetes:deleted'),
    );
    const physicalIds = new Set<string>();
    const cgroup = meta.process?.cgroup ?? '';
    for (const match of cgroup.matchAll(/[a-f0-9]{32,64}/giu)) {
      physicalIds.add(match[0].toLowerCase());
    }
    const exactPhysicalEntries = physicalIds.size > 0
      ? activeEntries.filter((entry) => entry.ids.some((id) => physicalIds.has(id.toLowerCase())))
      : [];
    if (
      exactPhysicalEntries.length > 0 &&
      exactPhysicalEntries.every((entry) => entry.agentScopeId !== claimedAgentScopeId)
    ) {
      return { meta, inventoryObserved: false, reason: 'physical_scope_conflict' };
    }

    const candidates = activeEntries.filter((entry) =>
      entry.agentScopeId === claimedAgentScopeId &&
      (entry.classification === 'confirmed_agent' || entry.classification === 'probable_agent') &&
      (exactPhysicalEntries.length === 0 || exactPhysicalEntries.includes(entry)),
    );
    const preferred = candidates.filter((entry) => entry.classification === 'confirmed_agent');
    const classifiedCandidates = preferred.length > 0 ? preferred : candidates;
    const exactContainerCandidates = classifiedCandidates.filter((entry) =>
      entry.ids.some((id) => /^[a-f0-9]{32,64}$/iu.test(id)),
    );
    // A single-container Pod produces both a Pod fallback and an exact CRI container entry. They
    // describe one runtime, not an ambiguity; the exact container generation always wins.
    const runtimeCandidates = exactContainerCandidates.length > 0
      ? exactContainerCandidates
      : classifiedCandidates;
    const uniqueRuntimes = new Map<string, WorkloadIdentitySnapshotEntry>();
    for (const entry of runtimeCandidates) {
      const runtimeKey = entry.agentInstanceId ?? entry.physicalWorkloadId;
      if (!uniqueRuntimes.has(runtimeKey)) uniqueRuntimes.set(runtimeKey, entry);
    }
    if (uniqueRuntimes.size === 0) {
      return { meta, inventoryObserved: false, reason: 'inventory_miss' };
    }
    if (uniqueRuntimes.size !== 1) {
      return { meta, inventoryObserved: false, reason: 'inventory_ambiguous' };
    }

    const entry = [...uniqueRuntimes.values()][0];
    const monitored = entry.classification !== 'non_agent';
    const evidence = [
      ...(entry.evidence ?? []),
      'server:authenticated-agent-adapter',
      'server:kubernetes-agent-scope-match',
      ...(exactPhysicalEntries.length > 0 ? ['server:kubernetes-container-match'] : []),
    ].slice(-16);
    const workloadRole = entry.workloadRole ?? 'agent';
    const captureProfile = entry.classification === 'confirmed_agent'
      ? 'agent_full' as const
      : 'probable_investigation' as const;
    return {
      inventoryObserved: true,
      reason: 'matched',
      meta: {
        ...meta,
        // Legacy IDs and the Source-bound canonical workspace remain byte-for-byte unchanged.
        classificationSemantics: {
          schemaVersion: 'anysentry.classification_semantics.v1',
          identityClassification: entry.classification,
          workloadRole,
          captureProfile,
        },
        attribution: {
          monitored,
          classification: entry.classification,
          agentScopeId: entry.agentScopeId,
          agentDisplayName: entry.agentDisplayName,
          agentInstanceId: entry.agentInstanceId,
          physicalWorkloadId: entry.physicalWorkloadId,
          workloadRef: {
            environment: 'kubernetes',
            kind: entry.containerName ? 'container' : 'pod',
            name: entry.podName ?? entry.containerName,
            namespace: entry.namespace,
            podName: entry.podName,
            podUid: entry.podUid,
            nodeName: entry.nodeName,
            containerName: entry.containerName,
            containerImage: entry.containerImage,
            ownerKind: entry.ownerKind,
            ownerName: entry.ownerName,
          },
          confidence: entry.classification === 'confirmed_agent' ? 1 : 0.7,
          reason: entry.classification === 'confirmed_agent' ? 'authoritative_anchor' : 'hint_only',
          source: 'kubernetes',
          evidence,
        },
      },
    };
  }

  snapshot(nodeName?: string): WorkloadIdentitySnapshot {
    this.expireTombstones();
    const normalizedNode = nodeName?.trim();
    return {
      schemaVersion: 'anysentry.workload_identity_snapshot.v1',
      version: this.version,
      generatedAt: new Date().toISOString(),
      ready: !this.enabled || this.readyNamespaces.size === this.agentNs.length,
      ...(normalizedNode ? { nodeName: normalizedNode } : {}),
      entries: this.entries.filter(
        (entry) => !normalizedNode || !entry.nodeName || entry.nodeName === normalizedNode,
      ),
      errors: this.errorCount,
    };
  }

  serviceInventory(): KubeServiceInventorySnapshot {
    return {
      schemaVersion: 'anysentry.service_inventory.v1',
      version: this.version,
      generatedAt: new Date().toISOString(),
      ready: !this.enabled || this.serviceReadyNamespaces.size === this.agentNs.length,
      errors: this.serviceErrorCount,
      items: structuredClone(this.serviceAssets),
      dependencies: structuredClone(this.serviceDependencies),
      changes: structuredClone(this.serviceChanges),
    };
  }

  resolveServiceEndpoint(value: string, namespace?: string): KubeServiceAsset | undefined {
    const host = endpointHost(value);
    if (!host) return undefined;
    const candidates = this.serviceAssets.filter((asset) =>
      asset.endpointAliases.some((alias) => endpointHost(alias) === host) &&
      (!namespace || asset.namespace === namespace),
    );
    if (candidates.length === 1) return structuredClone(candidates[0]);
    if (namespace) return undefined;
    const exactFqdn = candidates.filter((asset) =>
      host === `${asset.name}.${asset.namespace}.svc` ||
      host === `${asset.name}.${asset.namespace}.svc.cluster.local`,
    );
    return exactFqdn.length === 1 ? structuredClone(exactFqdn[0]) : undefined;
  }

  serviceForPhysicalWorkload(physicalWorkloadId: string | undefined): KubeServiceAsset | undefined {
    return this.resolveServiceForPhysicalWorkload(physicalWorkloadId).asset;
  }

  resolveServiceForPhysicalWorkload(physicalWorkloadId: string | undefined): {
    asset?: KubeServiceAsset;
    ambiguous: boolean;
    ready: boolean;
    version: number;
  } {
    const id = physicalWorkloadId?.trim();
    if (!id) return { ambiguous: false, ready: false, version: this.version };
    const parts = id.split(':');
    const prefix = parts[0] === 'k8s' && parts.length >= 3 ? parts.slice(0, 3).join(':') : id;
    const owner = this.serviceOwnerByPhysicalPrefix.get(prefix);
    if (owner === null) return { ambiguous: true, ready: this.serviceReadyNamespaces.size === this.agentNs.length, version: this.version };
    const asset = owner ? this.serviceAssetById.get(owner) : undefined;
    return {
      ...(asset ? { asset: structuredClone(asset) } : {}),
      ambiguous: false,
      ready: !this.enabled || this.serviceReadyNamespaces.size === this.agentNs.length,
      version: this.version,
    };
  }

  private async relistAndWatch(namespace: string): Promise<void> {
    if (this.destroyed) return;
    try {
      const [{ pods, resourceVersion }, replicaSetOwners, services, configMaps] = await Promise.all([
        this.listAllPods(namespace),
        this.listReplicaSetOwners(namespace).catch(() => {
          // Owner-chain enrichment is authoritative when available, but a missing apps/v1 RBAC
          // grant must not make the Pod identity snapshot unavailable.
          this.errorCount += 1;
          return new Map<string, { kind?: string; name?: string }>();
        }),
        this.listAllServices(namespace).then((items) => ({ ok: true as const, items })).catch(() => {
          // Service inventory enriches context but must not make Agent identity discovery fail.
          this.serviceErrorCount += 1;
          return { ok: false as const, items: [...(this.servicesByNamespace.get(namespace)?.values() ?? [])] };
        }),
        this.listAllConfigMaps(namespace).then((items) => ({ ok: true as const, items })).catch(() => {
          this.serviceErrorCount += 1;
          return { ok: false as const, items: [...(this.configMapsByNamespace.get(namespace)?.values() ?? [])] };
        }),
      ]);
      for (const key of [...this.replicaSetOwners.keys()]) {
        if (namespace === '*' || key.startsWith(`${namespace}/`)) this.replicaSetOwners.delete(key);
      }
      for (const [key, owner] of replicaSetOwners) this.replicaSetOwners.set(key, owner);
      const previous = this.podsByNamespace.get(namespace) ?? new Map<string, KubePod>();
      const next = new Map<string, KubePod>();
      for (const pod of pods) {
        const uid = pod.metadata?.uid;
        if (uid) next.set(uid, pod);
      }
      for (const [uid, pod] of previous) {
        if (!next.has(uid)) this.rememberTombstone(uid, pod);
      }
      this.podsByNamespace.set(namespace, next);
      const nextServices = new Map<string, KubeService>();
      for (const service of services.items) {
        const uid = service.metadata?.uid ?? `${service.metadata?.namespace}/${service.metadata?.name}`;
        if (uid) nextServices.set(uid, service);
      }
      this.servicesByNamespace.set(namespace, nextServices);
      const nextConfigMaps = new Map<string, KubeConfigMap>();
      for (const configMap of configMaps.items) {
        const name = configMap.metadata?.name;
        const itemNamespace = configMap.metadata?.namespace ?? namespace;
        if (name) nextConfigMaps.set(`${itemNamespace}/${name}`, configMap);
      }
      this.configMapsByNamespace.set(namespace, nextConfigMaps);
      if (services.ok && configMaps.ok) this.serviceReadyNamespaces.add(namespace);
      else this.serviceReadyNamespaces.delete(namespace);
      this.readyNamespaces.add(namespace);
      if (resourceVersion) this.resourceVersions.set(namespace, resourceVersion);
      this.rebuild();
      this.startWatch(namespace);
    } catch {
      this.errorCount += 1;
      this.scheduleRelist(namespace);
    }
  }

  private startWatch(namespace: string): void {
    if (this.destroyed) return;
    this.watches.get(namespace)?.destroy();
    const resourceVersion = this.resourceVersions.get(namespace);
    const params = new URLSearchParams({
      watch: '1',
      allowWatchBookmarks: 'true',
      timeoutSeconds: String(WATCH_TIMEOUT_SECONDS),
      ...(resourceVersion ? { resourceVersion } : {}),
    });
    const request = this.request(
      this.podsPath(namespace, params),
      (response) => {
        if ((response.statusCode ?? 500) >= 400) {
          response.resume();
          this.errorCount += 1;
          this.scheduleRelist(namespace);
          return;
        }
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          buffer += chunk;
          for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline < 0) break;
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) this.applyWatchLine(namespace, line);
          }
        });
        response.on('end', () => this.scheduleRelist(namespace, 250));
      },
    );
    request.on('error', () => {
      if (!this.destroyed) {
        this.errorCount += 1;
        this.scheduleRelist(namespace);
      }
    });
    request.setTimeout((WATCH_TIMEOUT_SECONDS + 15) * 1000, () =>
      request.destroy(new Error('kubernetes watch timeout')),
    );
    request.end();
    this.watches.set(namespace, request);
  }

  private applyWatchLine(namespace: string, line: string): void {
    let event: KubeWatchEvent;
    try {
      event = JSON.parse(line) as KubeWatchEvent;
    } catch {
      this.errorCount += 1;
      return;
    }
    const resourceVersion = event.object?.metadata?.resourceVersion;
    if (resourceVersion) this.resourceVersions.set(namespace, resourceVersion);
    if (event.type === 'BOOKMARK') return;
    if (event.type === 'ERROR') {
      this.errorCount += 1;
      this.scheduleRelist(namespace);
      return;
    }
    const uid = event.object?.metadata?.uid;
    if (!uid || !event.object) return;
    const pods = this.podsByNamespace.get(namespace) ?? new Map<string, KubePod>();
    if (event.type === 'DELETED') {
      this.rememberTombstone(uid, pods.get(uid) ?? event.object);
      pods.delete(uid);
    } else if (event.type === 'ADDED' || event.type === 'MODIFIED') {
      pods.set(uid, event.object);
      this.tombstones.delete(uid);
    }
    this.podsByNamespace.set(namespace, pods);
    this.rebuild();
  }

  private scheduleRelist(namespace: string, delayMs = 2_000): void {
    if (this.destroyed || this.reconnectTimers.has(namespace)) return;
    this.watches.get(namespace)?.destroy();
    this.watches.delete(namespace);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(namespace);
      void this.relistAndWatch(namespace);
    }, delayMs);
    timer.unref();
    this.reconnectTimers.set(namespace, timer);
  }

  private rememberTombstone(uid: string, pod: KubePod): void {
    this.tombstones.set(uid, {
      entries: this.entriesForPod(pod).map((entry) => ({
        ...entry,
        evidence: [...entry.evidence, 'kubernetes:deleted'],
      })),
      expiresAt: Date.now() + this.tombstoneTtlMs,
    });
    while (this.tombstones.size > this.maxTombstones) {
      const oldest = this.tombstones.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tombstones.delete(oldest);
    }
  }

  private expireTombstones(): void {
    const now = Date.now();
    let changed = false;
    for (const [uid, tombstone] of this.tombstones) {
      if (tombstone.expiresAt <= now) {
        this.tombstones.delete(uid);
        changed = true;
      }
    }
    if (changed) this.rebuild();
  }

  private rebuild(incrementVersion = true): void {
    const entries: WorkloadIdentitySnapshotEntry[] = [];
    for (const pods of this.podsByNamespace.values()) {
      for (const pod of pods.values()) entries.push(...this.entriesForPod(pod));
    }
    for (const tombstone of this.tombstones.values()) entries.push(...tombstone.entries);

    const byId = new Map<string, WorkloadIdentitySnapshotEntry>();
    for (const entry of entries) {
      for (const id of entry.ids) {
        if (!byId.has(id)) byId.set(id, entry);
      }
    }
    this.entries = entries;
    this.byId = byId;
    this.rebuildServiceInventory();
    if (incrementVersion) this.version += 1;
  }

  private entriesForPod(pod: KubePod): WorkloadIdentitySnapshotEntry[] {
    const metadata = pod.metadata ?? {};
    const podUid = metadata.uid;
    if (!podUid) return [];
    const namespace = metadata.namespace ?? 'default';
    const podName = metadata.name ?? podUid;
    const nodeName = pod.spec?.nodeName;
    const labels = metadata.labels ?? {};
    const annotations = metadata.annotations ?? {};
    const selectedAgent = selectorMatches(labels, this.agentSelector);
    const workloadKind = labels[WORKLOAD_KIND_LABEL]?.trim().toLowerCase();
    const inferredRole = inferredServiceRole(
      namespace,
      podName,
      (pod.spec?.containers ?? []).map((container) => container.image?.trim()).filter((value): value is string => Boolean(value)),
    );
    const declaredWorkloadRole = explicitWorkloadRole(labels);
    const workloadRole = declaredWorkloadRole ?? (
      selectedAgent
        ? 'agent'
        : inferredRole === 'unknown'
          ? undefined
          : inferredRole
    );
    const observeValue = labels[LEGACY_OBSERVE_LABEL]?.trim().toLowerCase();
    const legacyInfrastructure = ['0', 'false', 'off', 'no', 'disabled'].includes(observeValue);
    const explicitNonAgent = !selectedAgent && (
      ['non-agent', 'non_agent', 'infrastructure'].includes(workloadKind) || legacyInfrastructure
    );
    const agentId = selectedAgent ? labels[AGENT_ID_LABEL]?.trim() || podName : undefined;
    const explicitContainer =
      labels[AGENT_CONTAINER_LABEL]?.trim() || annotations[AGENT_CONTAINER_LABEL]?.trim();
    const configuredContainers = (pod.spec?.containers ?? [])
      .map((container) => container.name?.trim())
      .filter((name): name is string => Boolean(name));
    const imagesByContainer = new Map(
      (pod.spec?.containers ?? [])
        .filter((container) => container.name)
        .map((container) => [container.name as string, container.image?.trim()]),
    );
    const specsByContainer = new Map(
      (pod.spec?.containers ?? [])
        .filter((container) => container.name)
        .map((container) => [container.name as string, container]),
    );
    const directOwner =
      metadata.ownerReferences?.find((candidate) => candidate.controller) ??
      metadata.ownerReferences?.[0];
    const replicaSetOwner = directOwner?.kind === 'ReplicaSet' && directOwner.name
      ? this.replicaSetOwners.get(`${namespace}/${directOwner.name}`)
      : undefined;
    const owner = replicaSetOwner?.kind && replicaSetOwner.name ? replicaSetOwner : directOwner;
    const singleContainer = configuredContainers.length === 1 ? configuredContainers[0] : undefined;
    const selectedContainer = explicitContainer || singleContainer;
    const selectedContainerConfigured = Boolean(
      selectedContainer && configuredContainers.includes(selectedContainer),
    );
    const singleAgentContainer = Boolean(
      selectedAgent &&
      singleContainer &&
      (!explicitContainer || explicitContainer === singleContainer),
    );
    const statuses = pod.status?.containerStatuses ?? [];
    const identityEvidence = explicitNonAgent
      ? [legacyInfrastructure
          ? `label:${LEGACY_OBSERVE_LABEL}=${labels[LEGACY_OBSERVE_LABEL]}`
          : `label:${WORKLOAD_KIND_LABEL}=${labels[WORKLOAD_KIND_LABEL]}`]
      : selectedAgent
        ? [`label:${this.agentSelector}`, `label:${AGENT_ID_LABEL}=${agentId}`]
        : [`selector_miss:${this.agentSelector}`];
    const baseEvidence = [
      ...identityEvidence,
      ...(workloadRole ? [`label:${WORKLOAD_ROLE_LABEL}=${workloadRole}`] : []),
    ];
    const podClassification = explicitNonAgent
      ? 'non_agent'
      : !selectedAgent
        ? 'unknown'
        : singleAgentContainer
          ? 'confirmed_agent'
          : 'probable_agent';
    const podPhysicalId = `k8s:${this.clusterId}:${podUid}`;
    const common = {
      namespace,
      podName,
      podUid,
      nodeName,
      source: 'kubernetes' as const,
      environment: 'kubernetes' as const,
      ownerKind: owner?.kind,
      ownerName: owner?.name,
      labels: boundedLabels(labels),
      workloadRole,
      agentScopeId: agentId,
      agentDisplayName: agentId,
      agentInstanceId: selectedAgent ? `${podUid}/${selectedContainer ?? 'pod'}` : undefined,
    };
    const entries: WorkloadIdentitySnapshotEntry[] = [
      {
        ids: [podUid],
        classification: podClassification,
        physicalWorkloadId: podPhysicalId,
        ...common,
        ...(singleContainer ? {
          containerName: singleContainer,
          containerImage: imagesByContainer.get(singleContainer),
        } : {}),
        agentInstanceId: selectedAgent
          ? `${podUid}/${singleAgentContainer ? singleContainer : 'pod'}`
          : undefined,
        evidence: baseEvidence,
      },
    ];

    for (const status of statuses) {
      const containerId = normalizedContainerId(status.containerID);
      if (!containerId) continue;
      const containerName = status.name?.trim();
      const isAgentContainer =
        selectedAgent && selectedContainerConfigured && containerName === selectedContainer;
      const classification = explicitNonAgent
        ? 'non_agent'
        : !selectedAgent
          ? 'unknown'
        : isAgentContainer
          ? 'confirmed_agent'
          : selectedContainerConfigured
            ? 'non_agent'
            : 'unknown';
      const platformHealthchecks = containerName
        ? platformHealthchecksForContainer(specsByContainer.get(containerName))
        : [];
      entries.push({
        ids: [containerId, containerId.slice(0, 12)].filter(Boolean),
        classification,
        physicalWorkloadId: `${podPhysicalId}:${containerId}`,
        ...common,
        containerName,
        containerImage: containerName ? imagesByContainer.get(containerName) : undefined,
        ...(platformHealthchecks.length ? { platformHealthchecks } : {}),
        agentScopeId: isAgentContainer ? agentId : undefined,
        agentDisplayName: isAgentContainer ? agentId : undefined,
        agentInstanceId: isAgentContainer ? `${podUid}/${containerId}` : undefined,
        evidence: [
          ...baseEvidence,
          ...(selectedContainerConfigured ? [`container:${selectedContainer}`] : ['container:ambiguous']),
        ],
      });
    }
    return entries;
  }

  private rebuildServiceInventory(): void {
    const observedAt = Date.now();
    const pods = new Map<string, KubePod>();
    for (const namespacePods of this.podsByNamespace.values()) {
      for (const [uid, pod] of namespacePods) pods.set(uid, pod);
    }
    const services = new Map<string, KubeService>();
    for (const namespaceServices of this.servicesByNamespace.values()) {
      for (const [uid, service] of namespaceServices) services.set(uid, service);
    }
    const configMaps = new Map<string, KubeConfigMap>();
    for (const namespaceConfigMaps of this.configMapsByNamespace.values()) {
      for (const [key, configMap] of namespaceConfigMaps) configMaps.set(key, configMap);
    }

    type Group = {
      name: string;
      namespace: string;
      service?: KubeService;
      ownerKind?: string;
      ownerName?: string;
      pods: KubePod[];
      roles: WorkloadRole[];
      declaredEndpoints: string[];
      configRevisions: string[];
    };
    const groups = new Map<string, Group>();
    const servicesByNamespace = new Map<string, KubeService[]>();
    for (const service of services.values()) {
      const namespace = service.metadata?.namespace ?? 'default';
      const list = servicesByNamespace.get(namespace) ?? [];
      list.push(service);
      servicesByNamespace.set(namespace, list);
    }

    for (const pod of pods.values()) {
      const metadata = pod.metadata ?? {};
      const podUid = metadata.uid;
      if (!podUid) continue;
      const namespace = metadata.namespace ?? 'default';
      const labels = metadata.labels ?? {};
      const directOwner = metadata.ownerReferences?.find((candidate) => candidate.controller)
        ?? metadata.ownerReferences?.[0];
      const replicaSetOwner = directOwner?.kind === 'ReplicaSet' && directOwner.name
        ? this.replicaSetOwners.get(`${namespace}/${directOwner.name}`)
        : undefined;
      const owner = replicaSetOwner?.kind && replicaSetOwner.name ? replicaSetOwner : directOwner;
      const matchingServices = (servicesByNamespace.get(namespace) ?? [])
        .filter((service) => selectorMatchesLabels(labels, service.spec?.selector ?? {}))
        .sort((left, right) => {
          const appName = labels['app.kubernetes.io/name'] ?? labels.app;
          return Number(right.metadata?.name === appName) - Number(left.metadata?.name === appName) ||
            String(left.metadata?.name).localeCompare(String(right.metadata?.name));
        });
      const service = matchingServices[0];
      const name = service?.metadata?.name ??
        labels['app.kubernetes.io/name'] ??
        labels.app ??
        owner?.name ??
        metadata.name ??
        podUid;
      const role = explicitWorkloadRole(labels) ?? explicitWorkloadRole(service?.metadata?.labels ?? {});
      // A pure Agent runtime is represented by Agent Asset/Runtime. An explicitly embedded Agent
      // in a service role still produces both views, as required by the three-axis model.
      if ((role === 'agent' || selectorMatches(labels, this.agentSelector)) && !role) continue;
      if (role === 'agent' && !service) continue;
      if (!role && !service && !owner?.name && !labels['app.kubernetes.io/name'] && !labels.app) continue;
      const key = `${namespace}\0${name}`;
      const group = groups.get(key) ?? {
        name,
        namespace,
        service,
        ownerKind: owner?.kind,
        ownerName: owner?.name,
        pods: [],
        roles: [],
        declaredEndpoints: [],
        configRevisions: [],
      };
      group.service ??= service;
      group.pods.push(pod);
      if (role) group.roles.push(role);
      for (const container of pod.spec?.containers ?? []) {
        for (const env of container.env ?? []) {
          if (typeof env.value === 'string' && env.value.length <= 4_096) {
            group.declaredEndpoints.push(...declaredDependencyHosts(env.name ?? '', env.value));
          }
        }
        for (const source of container.envFrom ?? []) {
          const configMapName = source.configMapRef?.name?.trim();
          if (!configMapName) continue;
          const configMap = configMaps.get(`${namespace}/${configMapName}`);
          if (!configMap) continue;
          group.configRevisions.push(`${configMapName}:${configMap.metadata?.resourceVersion ?? 'unknown'}`);
          for (const [key, value] of Object.entries(configMap.data ?? {})) {
            if (typeof value === 'string' && value.length <= 16_384) {
              group.declaredEndpoints.push(...declaredDependencyHosts(key, value));
            }
          }
        }
      }
      groups.set(key, group);
    }

    for (const service of services.values()) {
      const namespace = service.metadata?.namespace ?? 'default';
      const name = service.metadata?.name;
      if (!name || groups.has(`${namespace}\0${name}`)) continue;
      const role = explicitWorkloadRole(service.metadata?.labels ?? {}) ??
        inferredServiceRole(namespace, name, [], true);
      if (role === 'unknown') continue;
      groups.set(`${namespace}\0${name}`, {
        name,
        namespace,
        service,
        pods: [],
        roles: [role],
        declaredEndpoints: [],
        configRevisions: [],
      });
    }

    const nextAssets: KubeServiceAsset[] = [];
    const endpointsByAsset = new Map<string, string[]>();
    const declaredByAsset = new Map<string, string[]>();
    for (const group of groups.values()) {
      const serviceAssetId = `service:k8s:${this.clusterId}:${group.namespace}:${group.name}`;
      const images = [...new Set(group.pods.flatMap((pod) =>
        (pod.spec?.containers ?? []).map((container) => container.image?.trim()).filter((value): value is string => Boolean(value)),
      ))].sort();
      const explicitRoles = [...new Set(group.roles)];
      const role = explicitRoles.length === 1
        ? explicitRoles[0]
        : explicitRoles.length > 1
          ? 'unknown'
          : inferredServiceRole(group.namespace, group.name, images, true);
      const statuses = group.pods.flatMap((pod) => pod.status?.containerStatuses ?? []);
      const ready = group.pods.filter((pod) => {
        const containerStatuses = pod.status?.containerStatuses ?? [];
        return pod.status?.phase === 'Running' &&
          containerStatuses.length > 0 &&
          containerStatuses.every((status) => status.ready === true);
      }).length;
      const restarts = statuses.reduce((sum, status) => sum + Math.max(0, status.restartCount ?? 0), 0);
      const phaseCounts: Record<string, number> = {};
      for (const pod of group.pods) {
        const phase = pod.status?.phase?.trim() || 'Unknown';
        phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;
      }
      let cpuRequest = 0;
      let cpuLimit = 0;
      let memoryRequest = 0;
      let memoryLimit = 0;
      let hasCpuRequest = false;
      let hasCpuLimit = false;
      let hasMemoryRequest = false;
      let hasMemoryLimit = false;
      for (const pod of group.pods) {
        for (const container of pod.spec?.containers ?? []) {
          const requestedCpu = cpuCores(container.resources?.requests?.cpu);
          const limitedCpu = cpuCores(container.resources?.limits?.cpu);
          const requestedMemory = memoryBytes(container.resources?.requests?.memory);
          const limitedMemory = memoryBytes(container.resources?.limits?.memory);
          if (requestedCpu !== undefined) { cpuRequest += requestedCpu; hasCpuRequest = true; }
          if (limitedCpu !== undefined) { cpuLimit += limitedCpu; hasCpuLimit = true; }
          if (requestedMemory !== undefined) { memoryRequest += requestedMemory; hasMemoryRequest = true; }
          if (limitedMemory !== undefined) { memoryLimit += limitedMemory; hasMemoryLimit = true; }
        }
      }
      const endpoints = new Set<string>();
      endpoints.add(group.name);
      endpoints.add(`${group.name}.${group.namespace}`);
      endpoints.add(`${group.name}.${group.namespace}.svc`);
      endpoints.add(`${group.name}.${group.namespace}.svc.cluster.local`);
      for (const clusterIP of [group.service?.spec?.clusterIP, ...(group.service?.spec?.clusterIPs ?? [])]) {
        if (clusterIP && clusterIP !== 'None') endpoints.add(clusterIP);
      }
      for (const port of group.service?.spec?.ports ?? []) {
        if (port.port) {
          endpoints.add(`${group.name}:${port.port}`);
          endpoints.add(`${group.name}.${group.namespace}.svc:${port.port}`);
        }
      }
      for (const pod of group.pods) if (pod.status?.podIP) endpoints.add(pod.status.podIP);
      const physicalWorkloadIds = group.pods.flatMap((pod) =>
        pod.metadata?.uid ? [`k8s:${this.clusterId}:${pod.metadata.uid}`] : [],
      );
      const runtimeInstanceIds = statuses.flatMap((status) => {
        const id = normalizedContainerId(status.containerID);
        return id ? [id] : [];
      });
      const safeRevisions = group.pods.flatMap((pod) => Object.entries(pod.metadata?.annotations ?? {})
        .filter(([key]) => /(?:revision|checksum|rollout)/iu.test(key))
        .map(([key, value]) => [key.slice(0, 160), String(value).slice(0, 240)]));
      const revision = stableDigest({
        ownerKind: group.ownerKind,
        ownerName: group.ownerName,
        images,
        safeRevisions,
        configRevisions: [...new Set(group.configRevisions)].sort(),
      });
      const metrics: KubeServiceMetric[] = [
        {
          name: 'kubernetes.replicas.ready_ratio',
          value: group.pods.length ? ready / group.pods.length : 0,
          unit: 'ratio',
          category: 'availability',
          status: group.pods.length > 0 && ready === group.pods.length ? 'normal' : 'anomalous',
          observedAt,
        },
        {
          name: 'kubernetes.container.restart_count',
          value: restarts,
          unit: 'restarts',
          category: 'availability',
          status: restarts > 0 ? 'anomalous' : 'normal',
          observedAt,
        },
        ...(hasCpuRequest ? [{
          name: 'kubernetes.cpu.request_cores', value: cpuRequest, unit: 'cores',
          category: 'capacity' as const, status: 'unknown' as const, observedAt,
        }] : []),
        ...(hasCpuLimit ? [{
          name: 'kubernetes.cpu.limit_cores', value: cpuLimit, unit: 'cores',
          category: 'capacity' as const, status: 'unknown' as const, observedAt,
        }] : []),
        ...(hasMemoryRequest ? [{
          name: 'kubernetes.memory.request_bytes', value: memoryRequest, unit: 'bytes',
          category: 'capacity' as const, status: 'unknown' as const, observedAt,
        }] : []),
        ...(hasMemoryLimit ? [{
          name: 'kubernetes.memory.limit_bytes', value: memoryLimit, unit: 'bytes',
          category: 'capacity' as const, status: 'unknown' as const, observedAt,
        }] : []),
      ];
      nextAssets.push({
        serviceAssetId,
        name: group.name,
        namespace: group.namespace,
        clusterId: this.clusterId,
        kind: serviceKind(group.name, images),
        role,
        ownerKind: group.ownerKind,
        ownerName: group.ownerName,
        revision,
        images,
        replicas: { observed: group.pods.length, ready },
        restarts,
        phaseCounts,
        ...(hasCpuRequest ? { cpuRequestCores: cpuRequest } : {}),
        ...(hasCpuLimit ? { cpuLimitCores: cpuLimit } : {}),
        ...(hasMemoryRequest ? { memoryRequestBytes: memoryRequest } : {}),
        ...(hasMemoryLimit ? { memoryLimitBytes: memoryLimit } : {}),
        physicalWorkloadIds,
        runtimeInstanceIds,
        endpointAliases: [...endpoints].sort(),
        metrics,
        observedAt,
      });
      endpointsByAsset.set(serviceAssetId, [...endpoints]);
      declaredByAsset.set(serviceAssetId, group.declaredEndpoints);
    }
    nextAssets.sort((left, right) =>
      left.namespace.localeCompare(right.namespace) || left.name.localeCompare(right.name),
    );

    const nextStates = new Map<string, {
      revision: string;
      images: string[];
      replicas: number;
      restarts: number;
    }>();
    const appendChange = (
      asset: KubeServiceAsset,
      type: KubeServiceChange['type'],
      summary: string,
      at = observedAt,
    ) => {
      const changeId = `change_${stableDigest([asset.serviceAssetId, type, asset.revision, summary, at]).slice(0, 24)}`;
      this.serviceChanges.push({
        changeId,
        serviceAssetId: asset.serviceAssetId,
        type,
        summary,
        revision: asset.revision,
        at,
      });
    };
    for (const asset of nextAssets) {
      const state = {
        revision: asset.revision,
        images: asset.images,
        replicas: asset.replicas.observed,
        restarts: asset.restarts,
      };
      nextStates.set(asset.serviceAssetId, state);
      const previous = this.serviceStates.get(asset.serviceAssetId);
      if (!previous) {
        const startedAt = Math.min(...groups.get(`${asset.namespace}\0${asset.name}`)?.pods
          .map((pod) => Date.parse(pod.status?.startTime ?? ''))
          .filter(Number.isFinite) ?? [observedAt]);
        appendChange(asset, 'deployment', `Service ${asset.name} discovered with ${asset.replicas.observed} runtime(s)`, Number.isFinite(startedAt) ? startedAt : observedAt);
      } else {
        if (previous.images.join('\0') !== asset.images.join('\0')) {
          appendChange(asset, 'image', `Service ${asset.name} image revision changed`);
        } else if (previous.revision !== asset.revision) {
          appendChange(asset, 'deployment', `Service ${asset.name} deployment revision changed`);
        }
        if (previous.replicas !== asset.replicas.observed) {
          appendChange(asset, 'scale', `Service ${asset.name} replicas changed from ${previous.replicas} to ${asset.replicas.observed}`);
        }
        if (asset.restarts > previous.restarts) {
          appendChange(asset, 'restart', `Service ${asset.name} container restart count increased to ${asset.restarts}`);
        }
      }
    }
    while (this.serviceChanges.length > 1_000) this.serviceChanges.shift();

    const endpointOwners = new Map<string, string | null>();
    const namespaceEndpointOwners = new Map<string, string | null>();
    const rememberOwner = (owners: Map<string, string | null>, key: string, serviceAssetId: string) => {
      const current = owners.get(key);
      owners.set(key, current === undefined || current === serviceAssetId ? serviceAssetId : null);
    };
    for (const asset of nextAssets) {
      for (const alias of endpointsByAsset.get(asset.serviceAssetId) ?? []) {
        const host = endpointHost(alias);
        if (!host) continue;
        rememberOwner(endpointOwners, host, asset.serviceAssetId);
        rememberOwner(namespaceEndpointOwners, `${asset.namespace}\0${host}`, asset.serviceAssetId);
      }
    }
    const dependencies = new Map<string, KubeServiceDependency>();
    for (const asset of nextAssets) {
      for (const declared of declaredByAsset.get(asset.serviceAssetId) ?? []) {
        const host = endpointHost(declared);
        const targetId = namespaceEndpointOwners.get(`${asset.namespace}\0${host}`) ?? endpointOwners.get(host);
        if (!targetId || targetId === asset.serviceAssetId) continue;
        const target = nextAssets.find((candidate) => candidate.serviceAssetId === targetId);
        if (!target) continue;
        const relation = target.kind === 'database'
          ? 'queries' as const
          : target.kind === 'queue'
            ? 'publishes' as const
            : 'calls' as const;
        const edgeId = `edge_${stableDigest([asset.serviceAssetId, targetId, relation]).slice(0, 24)}`;
        dependencies.set(edgeId, {
          edgeId,
          sourceServiceAssetId: asset.serviceAssetId,
          targetServiceAssetId: targetId,
          relation,
          source: 'kubernetes_declared_configuration',
          confidence: 1,
          observedAt,
        });
      }
    }
    this.serviceStates = nextStates;
    this.serviceAssets = nextAssets;
    this.serviceAssetById = new Map(nextAssets.map((asset) => [asset.serviceAssetId, asset]));
    const physicalOwners = new Map<string, string | null>();
    for (const asset of nextAssets) {
      for (const physical of asset.physicalWorkloadIds) {
        const current = physicalOwners.get(physical);
        physicalOwners.set(
          physical,
          current === undefined || current === asset.serviceAssetId ? asset.serviceAssetId : null,
        );
      }
    }
    this.serviceOwnerByPhysicalPrefix = physicalOwners;
    this.serviceDependencies = [...dependencies.values()];
  }

  private async listAllPods(namespace: string): Promise<{ pods: KubePod[]; resourceVersion?: string }> {
    const pods: KubePod[] = [];
    let continuation = '';
    let resourceVersion: string | undefined;
    do {
      const params = new URLSearchParams({ limit: '2000' });
      if (continuation) params.set('continue', continuation);
      const page = await this.requestJson<KubePodList>(
        this.podsPath(namespace, params),
      );
      pods.push(...(page.items ?? []));
      resourceVersion = page.metadata?.resourceVersion ?? resourceVersion;
      continuation = page.metadata?.continue ?? '';
    } while (continuation);
    return { pods, resourceVersion };
  }

  private async listAllServices(namespace: string): Promise<KubeService[]> {
    const services: KubeService[] = [];
    let continuation = '';
    do {
      const params = new URLSearchParams({ limit: '2000' });
      if (continuation) params.set('continue', continuation);
      const base = namespace === '*'
        ? '/api/v1/services'
        : `/api/v1/namespaces/${encodeURIComponent(namespace)}/services`;
      const page = await this.requestJson<KubeServiceList>(`${base}?${params.toString()}`);
      services.push(...(page.items ?? []));
      continuation = page.metadata?.continue ?? '';
    } while (continuation);
    return services;
  }

  private async listAllConfigMaps(namespace: string): Promise<KubeConfigMap[]> {
    const configMaps: KubeConfigMap[] = [];
    let continuation = '';
    do {
      const params = new URLSearchParams({ limit: '2000' });
      if (continuation) params.set('continue', continuation);
      const base = namespace === '*'
        ? '/api/v1/configmaps'
        : `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps`;
      const page = await this.requestJson<KubeConfigMapList>(`${base}?${params.toString()}`);
      configMaps.push(...(page.items ?? []));
      continuation = page.metadata?.continue ?? '';
    } while (continuation);
    return configMaps;
  }

  private async listReplicaSetOwners(namespace: string): Promise<Map<string, { kind?: string; name?: string }>> {
    const result = new Map<string, { kind?: string; name?: string }>();
    let continuation = '';
    do {
      const params = new URLSearchParams({ limit: '2000' });
      if (continuation) params.set('continue', continuation);
      const base = namespace === '*'
        ? '/apis/apps/v1/replicasets'
        : `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/replicasets`;
      const page = await this.requestJson<KubeReplicaSetList>(`${base}?${params.toString()}`);
      for (const replicaSet of page.items ?? []) {
        const metadata = replicaSet.metadata;
        if (!metadata?.name || !metadata.namespace) continue;
        const owner = metadata.ownerReferences?.find((candidate) => candidate.controller)
          ?? metadata.ownerReferences?.[0];
        if (!owner?.kind || !owner.name) continue;
        result.set(`${metadata.namespace}/${metadata.name}`, { kind: owner.kind, name: owner.name });
      }
      continuation = page.metadata?.continue ?? '';
    } while (continuation);
    return result;
  }

  private podsPath(namespace: string, params: URLSearchParams): string {
    return namespace === '*'
      ? `/api/v1/pods?${params.toString()}`
      : `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?${params.toString()}`;
  }

  private requestJson<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const request = this.request(path, (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          data += chunk;
        });
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`kubernetes api returned ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on('error', reject);
      request.setTimeout(8_000, () => request.destroy(new Error('kubernetes api timeout')));
      request.end();
    });
  }

  private request(
    path: string,
    onResponse: (response: import('node:http').IncomingMessage) => void,
  ): ReturnType<typeof https.request> {
    const connection = this.connection ?? this.loadConnection();
    this.connection = connection;
    const prefix = connection.server.pathname.replace(/\/+$/, '');
    return https.request(
      {
        hostname: connection.server.hostname,
        port: connection.server.port || '443',
        path: `${prefix}${path}`,
        method: 'GET',
        headers: {
          ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}),
          Accept: 'application/json',
        },
        ca: connection.ca,
        cert: connection.cert,
        key: connection.key,
        rejectUnauthorized: connection.rejectUnauthorized,
      },
      onResponse,
    );
  }

  private loadConnection(): KubeConnection {
    const host = process.env.KUBERNETES_SERVICE_HOST?.trim();
    if (host) {
      const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS?.trim() || '443';
      return {
        server: new URL(`https://${host}:${port}`),
        token: readFileSync(`${SA}/token`, 'utf8').trim(),
        ca: readFileSync(`${SA}/ca.crt`),
        rejectUnauthorized: true,
      };
    }

    const configPath = firstKubeconfigPath();
    const document = parseYaml(readFileSync(configPath, 'utf8')) as KubeConfigDocument;
    const contextName =
      process.env.ANYSENTRY_KUBE_CONTEXT?.trim() ||
      document['current-context']?.trim();
    const context = document.contexts?.find((candidate) => candidate.name === contextName)?.context;
    if (!context?.cluster) throw new Error(`kubeconfig context is missing: ${contextName || '<current-context>'}`);
    const cluster = document.clusters?.find((candidate) => candidate.name === context.cluster)?.cluster;
    if (!cluster?.server) throw new Error(`kubeconfig cluster is missing: ${context.cluster}`);
    const server = new URL(process.env.ANYSENTRY_KUBE_SERVER?.trim() || cluster.server);
    if (server.protocol !== 'https:') throw new Error(`kubeconfig server must use https: ${server.protocol}`);
    const user = document.users?.find((candidate) => candidate.name === context.user)?.user;
    const configDirectory = dirname(configPath);
    const tokenFile = user?.tokenFile?.trim();
    return {
      server,
      ca: configBytes(
        configDirectory,
        cluster['certificate-authority-data'],
        cluster['certificate-authority'],
      ),
      cert: configBytes(
        configDirectory,
        user?.['client-certificate-data'],
        user?.['client-certificate'],
      ),
      key: configBytes(
        configDirectory,
        user?.['client-key-data'],
        user?.['client-key'],
      ),
      token:
        user?.token?.trim() ||
        (tokenFile
          ? readFileSync(isAbsolute(tokenFile) ? tokenFile : resolve(configDirectory, tokenFile), 'utf8').trim()
          : undefined),
      rejectUnauthorized: cluster['insecure-skip-tls-verify'] !== true,
    };
  }
}
