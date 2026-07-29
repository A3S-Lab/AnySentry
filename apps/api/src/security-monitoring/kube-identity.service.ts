import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import * as https from 'node:https';
import { EventMeta, WorkloadIdentitySnapshot, WorkloadIdentitySnapshotEntry } from './types';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const DEFAULT_AGENT_SELECTOR = 'anysentry.io/workload-kind=agent';
const WORKLOAD_KIND_LABEL = 'anysentry.io/workload-kind';
const AGENT_ID_LABEL = 'anysentry.io/agent-id';
const AGENT_CONTAINER_LABEL = 'anysentry.io/agent-container';
const WATCH_TIMEOUT_SECONDS = 300;

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
}

interface KubePod {
  metadata?: KubeMetadata;
  spec?: {
    nodeName?: string;
    containers?: Array<{ name?: string; image?: string }>;
  };
  status?: {
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

interface KubeWatchEvent {
  type?: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';
  object?: KubePod & { code?: number };
}

interface Tombstone {
  entries: WorkloadIdentitySnapshotEntry[];
  expiresAt: number;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedContainerId(value: unknown): string | undefined {
  const id = String(value ?? '').trim().replace(/^[a-z0-9._-]+:\/\//i, '');
  return id || undefined;
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
  private readonly resourceVersions = new Map<string, string>();
  private readonly readyNamespaces = new Set<string>();
  private readonly watches = new Map<string, ReturnType<typeof https.request>>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly tombstones = new Map<string, Tombstone>();
  private byId = new Map<string, WorkloadIdentitySnapshotEntry>();
  private entries: WorkloadIdentitySnapshotEntry[] = [];
  private version = 0;
  private errorCount = 0;
  private destroyed = false;

  private readonly enabled =
    Boolean(process.env.KUBERNETES_SERVICE_HOST) &&
    process.env.ANYSENTRY_KUBE_ENRICH !== 'off';
  private readonly agentNs = (process.env.ANYSENTRY_AGENT_NAMESPACES ?? 'default')
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

  private async relistAndWatch(namespace: string): Promise<void> {
    if (this.destroyed) return;
    try {
      const { pods, resourceVersion } = await this.listAllPods(namespace);
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
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?${params.toString()}`,
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
    const explicitNonAgent = ['non-agent', 'non_agent', 'infrastructure'].includes(
      labels[WORKLOAD_KIND_LABEL]?.trim().toLowerCase(),
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
    const owner =
      metadata.ownerReferences?.find((candidate) => candidate.controller) ??
      metadata.ownerReferences?.[0];
    const singleContainer = configuredContainers.length === 1 ? configuredContainers[0] : undefined;
    const selectedContainer = explicitContainer || singleContainer;
    const statuses = pod.status?.containerStatuses ?? [];
    const baseEvidence = explicitNonAgent
      ? [`label:${WORKLOAD_KIND_LABEL}=${labels[WORKLOAD_KIND_LABEL]}`]
      : selectedAgent
        ? [`label:${this.agentSelector}`, `label:${AGENT_ID_LABEL}=${agentId}`]
        : [`selector_miss:${this.agentSelector}`];
    const podClassification = explicitNonAgent
      ? 'non_agent'
      : !selectedAgent
        ? 'unknown'
      : selectedContainer
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
        evidence: baseEvidence,
      },
    ];

    for (const status of statuses) {
      const containerId = normalizedContainerId(status.containerID);
      if (!containerId) continue;
      const containerName = status.name?.trim();
      const isAgentContainer =
        selectedAgent && Boolean(selectedContainer) && containerName === selectedContainer;
      const classification = explicitNonAgent
        ? 'non_agent'
        : !selectedAgent
          ? 'unknown'
        : isAgentContainer
          ? 'confirmed_agent'
          : selectedContainer
            ? 'non_agent'
            : 'unknown';
      entries.push({
        ids: [containerId, containerId.slice(0, 12)].filter(Boolean),
        classification,
        physicalWorkloadId: `${podPhysicalId}:${containerId}`,
        ...common,
        containerName,
        containerImage: containerName ? imagesByContainer.get(containerName) : undefined,
        agentScopeId: isAgentContainer ? agentId : undefined,
        agentDisplayName: isAgentContainer ? agentId : undefined,
        agentInstanceId: isAgentContainer ? `${podUid}/${containerId}` : undefined,
        evidence: [
          ...baseEvidence,
          ...(selectedContainer ? [`container:${selectedContainer}`] : ['container:ambiguous']),
        ],
      });
    }
    return entries;
  }

  private async listAllPods(namespace: string): Promise<{ pods: KubePod[]; resourceVersion?: string }> {
    const pods: KubePod[] = [];
    let continuation = '';
    let resourceVersion: string | undefined;
    do {
      const params = new URLSearchParams({ limit: '2000' });
      if (continuation) params.set('continue', continuation);
      const page = await this.requestJson<KubePodList>(
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?${params.toString()}`,
      );
      pods.push(...(page.items ?? []));
      resourceVersion = page.metadata?.resourceVersion ?? resourceVersion;
      continuation = page.metadata?.continue ?? '';
    } while (continuation);
    return { pods, resourceVersion };
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
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443';
    const token = readFileSync(`${SA}/token`, 'utf8').trim();
    const ca = readFileSync(`${SA}/ca.crt`);
    return https.request(
      {
        host,
        port,
        path,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        ca,
      },
      onResponse,
    );
  }
}
