import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClickHouseStore } from './clickhouse-store';
import { detectedAgentIdentity } from './agent-identity';
import {
  AgentClassification,
  AgentCriticality,
  AgentMetadataListItem,
  AgentMetadataRecord,
  AgentMetadataUpdateRequest,
  AgentReviewDecision,
  AgentReviewRequest,
  AgentWorkloadRef,
  EventMeta,
  JudgedEvent,
  WorkloadIdentitySnapshotEntry,
} from './types';
import { cleanText } from './redaction';

const RETAIN_LIMIT = 10_000;

function key(workspacePath: string, agentId: string): string {
  return `${workspacePath}\0${agentId}`;
}

function iso(t = Date.now()): string {
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

function clean(value: unknown, limit: number): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags
    .map((tag) => cleanText(tag, 48))
    .filter((tag): tag is string => Boolean(tag)))]
    .slice(0, 24);
}

function cleanCriticality(value: unknown): AgentCriticality | undefined {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical' ? value : undefined;
}

function cleanReviewDecision(value: unknown): AgentReviewDecision | undefined {
  return value === 'confirmed_agent' || value === 'unknown' || value === 'non_agent' ? value : undefined;
}

function normalizeIdentityKey(value: unknown): string | undefined {
  const normalized = clean(value, 500)?.toLowerCase();
  return normalized || undefined;
}

function cleanIdentityKeys(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((value) => normalizeIdentityKey(value))
    .filter((value): value is string => Boolean(value)))]
    .slice(0, 32);
}

function cleanWorkloadRef(value: unknown): AgentWorkloadRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const ref = value as AgentWorkloadRef;
  const environment =
    ref.environment === 'kubernetes' || ref.environment === 'docker' || ref.environment === 'host'
      ? ref.environment
      : undefined;
  const kind =
    ref.kind === 'pod' || ref.kind === 'container' || ref.kind === 'service' || ref.kind === 'process' || ref.kind === 'cgroup'
      ? ref.kind
      : undefined;
  const next: AgentWorkloadRef = {
    environment,
    kind,
    name: clean(ref.name, 240),
    namespace: clean(ref.namespace, 160),
    podName: clean(ref.podName, 240),
    podUid: clean(ref.podUid, 240),
    nodeName: clean(ref.nodeName, 240),
    containerName: clean(ref.containerName, 240),
    containerImage: clean(ref.containerImage, 500),
    ownerKind: clean(ref.ownerKind, 120),
    ownerName: clean(ref.ownerName, 240),
    systemdUnit: clean(ref.systemdUnit, 240),
    processName: clean(ref.processName, 240),
    executable: clean(ref.executable, 500),
  };
  return Object.values(next).some(Boolean) ? next : undefined;
}

const REVIEW_TRANSITIONS: Record<AgentClassification, ReadonlySet<AgentReviewDecision>> = {
  confirmed_agent: new Set(['unknown']),
  probable_agent: new Set(['confirmed_agent', 'unknown']),
  unknown: new Set(['confirmed_agent', 'non_agent']),
  non_agent: new Set(['unknown']),
};

export function isReviewTransitionAllowed(
  from: AgentClassification,
  to: AgentReviewDecision | 'clear',
): boolean {
  return to === 'clear' || from === to || REVIEW_TRANSITIONS[from].has(to);
}

export interface ResolvedAgentMetadata {
  agentAssetId: string;
  displayName?: string;
  detectedName?: string;
  detectedClassification: AgentClassification;
  effectiveClassification: AgentClassification;
  metadata?: AgentMetadataRecord;
  reviewConflict: boolean;
}

@Injectable()
export class AgentMetadataService implements OnModuleInit, OnModuleDestroy {
  private readonly ch = new ClickHouseStore();
  private readonly records = new Map<string, AgentMetadataRecord>();
  private readonly reviewIndex = new Map<string, string | null>();
  private readonly identityIndex = new Map<string, string | null>();
  private readonly assetIndex = new Map<string, string | null>();
  private persistTimer?: NodeJS.Timeout;
  private initialized = false;
  private reviewVersion = 0;

  async onModuleInit(): Promise<void> {
    if (await this.ch.init()) {
      for (const record of await this.ch.loadAgentMetadata()) {
        if (record.agentId && record.workspacePath) this.records.set(key(record.workspacePath, record.agentId), this.normalize(record));
      }
      this.rebuildReviewIndex();
    }
    this.initialized = true;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    await this.persist();
    await this.ch.close();
  }

  get(workspacePath: string, agentId: string): AgentMetadataRecord | undefined {
    const record = this.records.get(key(workspacePath, agentId));
    return record ? { ...record, tags: [...record.tags] } : undefined;
  }

  update(agentId: string, input: AgentMetadataUpdateRequest): AgentMetadataListItem {
    const workspacePath = clean(input.workspacePath, 500) ?? 'unknown';
    const cur = this.records.get(key(workspacePath, agentId));
    const next: AgentMetadataRecord = {
      agentId: clean(agentId, 240) ?? agentId,
      agentAssetId: clean(input.agentAssetId, 160) ?? cur?.agentAssetId,
      workspacePath,
      displayName: 'displayName' in input ? cleanText(input.displayName, 160) : cur?.displayName,
      owner: 'owner' in input ? cleanText(input.owner, 160) : cur?.owner,
      team: 'team' in input ? cleanText(input.team, 160) : cur?.team,
      environment: 'environment' in input ? cleanText(input.environment, 80) : cur?.environment,
      criticality: 'criticality' in input ? cleanCriticality(input.criticality) : cur?.criticality,
      tags: 'tags' in input ? cleanTags(input.tags) : cur?.tags ?? [],
      note: 'note' in input ? cleanText(input.note, 2_000) : cur?.note,
      identityKeys: 'identityKeys' in input ? cleanIdentityKeys(input.identityKeys) : cur?.identityKeys,
      physicalWorkloadId: 'physicalWorkloadId' in input
        ? clean(input.physicalWorkloadId, 500)
        : cur?.physicalWorkloadId,
      agentInstanceId: 'agentInstanceId' in input
        ? clean(input.agentInstanceId, 500)
        : cur?.agentInstanceId,
      workloadRef: 'workloadRef' in input ? cleanWorkloadRef(input.workloadRef) : cur?.workloadRef,
      reviewDecision: cur?.reviewDecision,
      reviewedBy: cur?.reviewedBy,
      reviewedAt: cur?.reviewedAt,
      reviewNote: cur?.reviewNote,
      reviewIdentityKeys: cur?.reviewIdentityKeys,
      reviewPhysicalWorkloadId: cur?.reviewPhysicalWorkloadId,
      reviewAgentInstanceId: cur?.reviewAgentInstanceId,
      reviewWorkloadRef: cur?.reviewWorkloadRef,
      updatedAt: Date.now(),
    };
    this.records.set(key(workspacePath, agentId), next);
    this.trim();
    this.rebuildReviewIndex();
    this.persistSoon();
    return this.item(next);
  }

  review(agentId: string, input: AgentReviewRequest, reviewer?: string): AgentMetadataListItem {
    const workspacePath = clean(input.workspacePath, 500) ?? 'unknown';
    const recordKey = key(workspacePath, agentId);
    const cur = this.records.get(recordKey);
    const decision = cleanReviewDecision(input.decision);
    const currentClassification =
      cur?.reviewDecision ??
      (
        input.currentClassification === 'confirmed_agent' ||
        input.currentClassification === 'probable_agent' ||
        input.currentClassification === 'unknown' ||
        input.currentClassification === 'non_agent'
          ? input.currentClassification
          : 'unknown'
      );
    if (!isReviewTransitionAllowed(currentClassification, input.decision)) {
      throw new BadRequestException(
        `cannot change Agent classification from ${currentClassification} to ${input.decision}`,
      );
    }
    const identityKeys = cleanIdentityKeys([
      ...(input.identityKeys ?? []),
      input.physicalWorkloadId,
      input.agentInstanceId,
      ...(decision && !(input.identityKeys?.length || input.physicalWorkloadId || input.agentInstanceId)
        ? [agentId]
        : []),
    ]);
    const next: AgentMetadataRecord = {
      agentId: clean(agentId, 240) ?? agentId,
      agentAssetId: clean(input.agentAssetId, 160) ?? cur?.agentAssetId,
      workspacePath,
      displayName: cur?.displayName,
      owner: cur?.owner,
      team: cur?.team,
      environment: cur?.environment,
      criticality: cur?.criticality,
      tags: cur?.tags ?? [],
      note: cur?.note,
      identityKeys: decision ? identityKeys : cur?.identityKeys,
      physicalWorkloadId: decision
        ? clean(input.physicalWorkloadId, 500) ?? cur?.physicalWorkloadId
        : cur?.physicalWorkloadId,
      agentInstanceId: decision
        ? clean(input.agentInstanceId, 500) ?? cur?.agentInstanceId
        : cur?.agentInstanceId,
      workloadRef: decision
        ? cleanWorkloadRef(input.workloadRef) ?? cur?.workloadRef
        : cur?.workloadRef,
      reviewDecision: decision,
      reviewedBy: decision ? clean(reviewer, 240) : undefined,
      reviewedAt: decision ? Date.now() : undefined,
      reviewNote: decision ? cleanText(input.note, 2_000) : undefined,
      reviewIdentityKeys: decision ? identityKeys : undefined,
      reviewPhysicalWorkloadId: decision ? clean(input.physicalWorkloadId, 500) : undefined,
      reviewAgentInstanceId: decision ? clean(input.agentInstanceId, 500) : undefined,
      reviewWorkloadRef: decision ? cleanWorkloadRef(input.workloadRef) : undefined,
      updatedAt: Date.now(),
    };
    this.records.set(recordKey, next);
    this.trim();
    this.reviewVersion += 1;
    this.rebuildReviewIndex();
    this.persistSoon();
    return this.item(next);
  }

  identityKeysForEvent(event: Pick<JudgedEvent, 'agentId' | 'sessionId' | 'process' | 'attribution'>): string[] {
    const values: unknown[] = [];
    const attribution = event.attribution;
    values.push(
      attribution?.physicalWorkloadId,
      attribution?.agentInstanceId,
      attribution?.workloadRef?.podUid,
      attribution?.workloadRef?.systemdUnit,
    );
    for (const candidate of [attribution?.physicalWorkloadId, attribution?.agentInstanceId]) {
      const normalized = normalizeIdentityKey(candidate);
      if (normalized?.startsWith('container:')) values.push(normalized.slice('container:'.length));
    }
    const cgroup = event.process?.cgroup ?? '';
    for (const match of cgroup.matchAll(/(?:cri-containerd|docker|crio|libpod)[-/]([a-f0-9]{12,64})(?:\.scope)?/gi)) {
      values.push(match[1], match[1]?.slice(0, 12));
    }
    for (const match of cgroup.matchAll(/kubepods[^/]*[-/]pod([a-f0-9_-]{16,})/gi)) {
      const podUid = match[1]?.replace(/_/g, '-');
      values.push(podUid);
    }
    if (event.process?.systemdUnit) values.push(event.process.systemdUnit);
    const stable = cleanIdentityKeys(values);
    return stable.length > 0
      ? stable
      : cleanIdentityKeys([event.agentId, event.sessionId]);
  }

  resolveEvent(event: JudgedEvent): ResolvedAgentMetadata {
    const detected = detectedAgentIdentity(event);
    const exactKey = key(event.workspacePath, event.agentId);
    const exact = this.records.get(exactKey);
    const assetRecordKey = this.assetIndex.get(detected.agentAssetId);
    const identityKeys = this.identityKeysForEvent(event);
    let identityRecordKey: string | null | undefined;
    let reviewRecordKey: string | null | undefined;
    for (const identityKey of identityKeys) {
      const indexed = this.identityIndex.get(identityKey);
      if (indexed === null) {
        identityRecordKey = null;
        break;
      }
      if (indexed) identityRecordKey = indexed;
    }
    for (const identityKey of identityKeys) {
      const indexed = this.reviewIndex.get(identityKey);
      if (indexed === null) {
        reviewRecordKey = null;
        break;
      }
      if (indexed) reviewRecordKey = indexed;
    }
    const metadataRecordKey =
      assetRecordKey === null || identityRecordKey === null
        ? undefined
        : assetRecordKey ?? identityRecordKey;
    const metadata =
      (metadataRecordKey ? this.records.get(metadataRecordKey) : undefined) ??
      exact;
    const reviewConflict = reviewRecordKey === null;
    const review =
      reviewConflict
        ? undefined
        : reviewRecordKey
          ? this.records.get(reviewRecordKey)
          : exact?.reviewDecision
            ? exact
            : undefined;
    return {
      agentAssetId: metadata?.agentAssetId ?? detected.agentAssetId,
      displayName: metadata?.displayName,
      detectedName: detected.detectedName,
      detectedClassification: detected.detectedClassification,
      effectiveClassification:
        review?.reviewDecision ?? detected.detectedClassification,
      metadata,
      reviewConflict,
    };
  }

  applyReview(meta: EventMeta): EventMeta {
    const identityKeys = this.identityKeysForEvent(meta as JudgedEvent);
    if (identityKeys.some((identityKey) => this.reviewIndex.get(identityKey) === null)) {
      // One conflicting stable key invalidates weaker aliases of the same event. Selecting the
      // first short ID here could silently apply the wrong human decision.
      return meta;
    }
    let record: AgentMetadataRecord | undefined;
    for (const identityKey of identityKeys) {
      const recordKey = this.reviewIndex.get(identityKey);
      if (recordKey === null) return meta;
      if (!recordKey) continue;
      record = this.records.get(recordKey);
      if (record?.reviewDecision) break;
    }
    if (!record?.reviewDecision) return meta;
    const confirmed = record.reviewDecision === 'confirmed_agent';
    const rejected = record.reviewDecision === 'non_agent';
    const previous = meta.attribution;
    const evidence = [
      ...(previous?.evidence ?? []),
      `manual_review:${record.reviewDecision}`,
      ...(record.reviewedBy ? [`manual_review:reviewer=${record.reviewedBy}`] : []),
    ].slice(-16);
    return {
      ...meta,
      attribution: {
        monitored: confirmed,
        classification: record.reviewDecision,
        agentScopeId: confirmed ? record.agentId : previous?.agentScopeId,
        agentDisplayName:
          record.displayName ??
          previous?.agentDisplayName ??
          record.reviewWorkloadRef?.podName ??
          record.reviewWorkloadRef?.containerName ??
          record.reviewWorkloadRef?.processName ??
          record.agentId,
        agentSessionId: previous?.agentSessionId,
        agentInstanceId: record.reviewAgentInstanceId ?? previous?.agentInstanceId,
        physicalWorkloadId: record.reviewPhysicalWorkloadId ?? previous?.physicalWorkloadId,
        workloadRef: record.reviewWorkloadRef ?? previous?.workloadRef,
        rootPid: previous?.rootPid,
        confidence: 1,
        reason: confirmed ? 'human_confirmed' : rejected ? 'human_rejected' : 'human_deferred',
        source: 'manual_review',
        evidence,
      },
    };
  }

  identitySnapshotEntries(nodeName?: string): WorkloadIdentitySnapshotEntry[] {
    const normalizedNode = clean(nodeName, 240);
    return [...this.records.values()]
      .filter((record) =>
        Boolean(record.reviewDecision && record.reviewIdentityKeys?.length) &&
        (!normalizedNode || !record.reviewWorkloadRef?.nodeName || record.reviewWorkloadRef.nodeName === normalizedNode)
      )
      .map((record): WorkloadIdentitySnapshotEntry => {
        const workload = record.reviewWorkloadRef;
        const environment = workload?.environment;
        const source =
          environment === 'kubernetes'
            ? 'kubernetes'
            : environment === 'docker'
              ? 'docker'
              : 'host';
        return {
          ids: [...(record.reviewIdentityKeys ?? [])],
          classification: record.reviewDecision!,
          physicalWorkloadId:
            record.reviewPhysicalWorkloadId ??
            record.physicalWorkloadId ??
            record.reviewAgentInstanceId ??
            record.agentInstanceId ??
            `manual:${record.workspacePath}:${record.agentId}`,
          source,
          attributionSource: 'manual_review',
          agentScopeId: record.reviewDecision === 'confirmed_agent' ? record.agentId : undefined,
          agentDisplayName:
            record.displayName ??
            workload?.podName ??
            workload?.containerName ??
            workload?.processName ??
            record.agentId,
          agentInstanceId: record.reviewAgentInstanceId ?? record.agentInstanceId,
          namespace: workload?.namespace,
          podName: workload?.podName,
          podUid: workload?.podUid,
          nodeName: workload?.nodeName,
          containerName: workload?.containerName,
          containerImage: workload?.containerImage,
          ownerKind: workload?.ownerKind,
          ownerName: workload?.ownerName,
          systemdUnit: workload?.systemdUnit,
          evidence: [
            `manual_review:${record.reviewDecision}`,
            ...(record.reviewedBy ? [`manual_review:reviewer=${record.reviewedBy}`] : []),
          ],
        };
      });
  }

  identitySnapshotVersion(): number {
    return this.reviewVersion;
  }

  list(): AgentMetadataListItem[] {
    return [...this.records.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((record) => this.item(record));
  }

  private normalize(record: AgentMetadataRecord): AgentMetadataRecord {
    return {
      agentId: clean(record.agentId, 240) ?? 'unknown',
      agentAssetId: clean(record.agentAssetId, 160),
      workspacePath: clean(record.workspacePath, 500) ?? 'unknown',
      displayName: cleanText(record.displayName, 160),
      owner: cleanText(record.owner, 160),
      team: cleanText(record.team, 160),
      environment: cleanText(record.environment, 80),
      criticality: cleanCriticality(record.criticality),
      tags: cleanTags(record.tags),
      note: cleanText(record.note, 2_000),
      identityKeys: cleanIdentityKeys(record.identityKeys ?? record.reviewIdentityKeys),
      physicalWorkloadId: clean(record.physicalWorkloadId ?? record.reviewPhysicalWorkloadId, 500),
      agentInstanceId: clean(record.agentInstanceId ?? record.reviewAgentInstanceId, 500),
      workloadRef: cleanWorkloadRef(record.workloadRef ?? record.reviewWorkloadRef),
      reviewDecision: cleanReviewDecision(record.reviewDecision),
      reviewedBy: clean(record.reviewedBy, 240),
      reviewedAt: Number(record.reviewedAt) || undefined,
      reviewNote: cleanText(record.reviewNote, 2_000),
      reviewIdentityKeys: cleanIdentityKeys(record.reviewIdentityKeys),
      reviewPhysicalWorkloadId: clean(record.reviewPhysicalWorkloadId, 500),
      reviewAgentInstanceId: clean(record.reviewAgentInstanceId, 500),
      reviewWorkloadRef: cleanWorkloadRef(record.reviewWorkloadRef),
      updatedAt: Number(record.updatedAt) || Date.now(),
    };
  }

  private item(record: AgentMetadataRecord): AgentMetadataListItem {
    const { reviewedAt, ...rest } = record;
    return {
      ...rest,
      tags: [...record.tags],
      identityKeys: record.identityKeys ? [...record.identityKeys] : undefined,
      workloadRef: record.workloadRef ? { ...record.workloadRef } : undefined,
      reviewIdentityKeys: record.reviewIdentityKeys ? [...record.reviewIdentityKeys] : undefined,
      reviewWorkloadRef: record.reviewWorkloadRef ? { ...record.reviewWorkloadRef } : undefined,
      reviewedAt: reviewedAt ? iso(reviewedAt) : undefined,
      updatedAt: iso(record.updatedAt),
    };
  }

  private trim(): void {
    if (this.records.size <= RETAIN_LIMIT) return;
    const keep = [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RETAIN_LIMIT);
    this.records.clear();
    for (const record of keep) this.records.set(key(record.workspacePath, record.agentId), record);
  }

  private rebuildReviewIndex(): void {
    this.reviewIndex.clear();
    this.identityIndex.clear();
    this.assetIndex.clear();
    for (const [recordKey, record] of this.records) {
      const assetId = clean(record.agentAssetId, 160);
      if (assetId) this.addIndexEntry(this.assetIndex, assetId, recordKey);
      for (const identityKey of record.identityKeys ?? record.reviewIdentityKeys ?? []) {
        const normalized = normalizeIdentityKey(identityKey);
        if (normalized) this.addIndexEntry(this.identityIndex, normalized, recordKey);
      }
      if (!record.reviewDecision) continue;
      for (const identityKey of record.reviewIdentityKeys ?? []) {
        const normalized = normalizeIdentityKey(identityKey);
        if (!normalized) continue;
        this.addIndexEntry(this.reviewIndex, normalized, recordKey);
      }
    }
  }

  private addIndexEntry(index: Map<string, string | null>, identity: string, recordKey: string): void {
    const existingKey = index.get(identity);
    if (existingKey === undefined) {
      index.set(identity, recordKey);
      return;
    }
    if (existingKey !== recordKey) index.set(identity, null);
  }

  private persistSoon(): void {
    if (!this.initialized) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, 500);
  }

  private async persist(): Promise<void> {
    const records = [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RETAIN_LIMIT);
    await this.ch.saveAgentMetadata(records);
  }
}
