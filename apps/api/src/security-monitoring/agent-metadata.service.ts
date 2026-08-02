import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClickHouseStore } from './clickhouse-store';
import { agentAssetIdForIdentityKey, detectedAgentIdentity } from './agent-identity';
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

function legacyKey(workspacePath: string, agentId: string): string {
  return `${workspacePath}\0${agentId}`;
}

function assetKey(agentAssetId: string): string {
  return `asset\0${agentAssetId}`;
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
  private readonly legacyIndex = new Map<string, string | null>();
  private readonly aliasIndex = new Map<string, string | null>();
  private persistTimer?: NodeJS.Timeout;
  private initialized = false;
  private reviewVersion = 0;

  async onModuleInit(): Promise<void> {
    if (await this.ch.init()) {
      for (const record of await this.ch.loadAgentMetadata()) {
        if (record.agentId && record.workspacePath) this.storeNormalized(this.normalize(record));
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
    const recordKey = this.legacyIndex.get(legacyKey(workspacePath, agentId));
    const record = recordKey ? this.records.get(recordKey) : undefined;
    return record ? { ...record, tags: [...record.tags] } : undefined;
  }

  canonicalAgentAssetId(agentAssetId: string): string {
    const normalized = clean(agentAssetId, 160) ?? agentAssetId;
    const recordKey = this.assetIndex.get(normalized) ?? this.aliasIndex.get(normalized);
    if (!recordKey) return normalized;
    return this.records.get(recordKey)?.agentAssetId ?? normalized;
  }

  update(agentId: string, input: AgentMetadataUpdateRequest): AgentMetadataListItem {
    const workspacePath = clean(input.workspacePath, 500) ?? 'unknown';
    const inputAssetId = clean(input.agentAssetId, 160);
    const curKey = this.findRecordKey(inputAssetId, workspacePath, agentId, input.identityKeys);
    const cur = curKey ? this.records.get(curKey) : undefined;
    const canonicalAssetId = this.canonicalAssetIdForMutation(agentId, workspacePath, input, cur);
    const next: AgentMetadataRecord = {
      agentId: cur?.agentId ?? clean(agentId, 240) ?? agentId,
      agentAssetId: canonicalAssetId,
      agentAssetAliases: this.assetAliases(cur, canonicalAssetId, workspacePath, agentId),
      workspacePath: cur?.workspacePath ?? workspacePath,
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
    this.storeNormalized(next, curKey);
    this.trim();
    this.rebuildReviewIndex();
    this.persistSoon();
    return this.item(next);
  }

  review(agentId: string, input: AgentReviewRequest, reviewer?: string): AgentMetadataListItem {
    const workspacePath = clean(input.workspacePath, 500) ?? 'unknown';
    const inputAssetId = clean(input.agentAssetId, 160);
    const recordKey = this.findRecordKey(inputAssetId, workspacePath, agentId, input.identityKeys);
    const cur = recordKey ? this.records.get(recordKey) : undefined;
    const canonicalAssetId = this.canonicalAssetIdForMutation(agentId, workspacePath, input, cur);
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
      agentId: cur?.agentId ?? clean(agentId, 240) ?? agentId,
      agentAssetId: canonicalAssetId,
      agentAssetAliases: this.assetAliases(cur, canonicalAssetId, workspacePath, agentId),
      workspacePath: cur?.workspacePath ?? workspacePath,
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
    this.storeNormalized(next, recordKey);
    this.trim();
    this.reviewVersion += 1;
    this.rebuildReviewIndex();
    this.persistSoon();
    return this.item(next);
  }

  identityKeysForEvent(event: Pick<JudgedEvent, 'agentId' | 'sessionId' | 'process' | 'attribution'>): string[] {
    const attribution = event.attribution;
    const strongValues: unknown[] = [
      attribution?.physicalWorkloadId,
      attribution?.agentInstanceId,
      attribution?.workloadRef?.podUid,
    ];
    for (const candidate of [attribution?.physicalWorkloadId, attribution?.agentInstanceId]) {
      const normalized = normalizeIdentityKey(candidate);
      if (normalized?.startsWith('container:')) strongValues.push(normalized.slice('container:'.length));
    }
    const cgroup = event.process?.cgroup ?? '';
    for (const match of cgroup.matchAll(/(?:cri-containerd|docker|crio|libpod)[-/]([a-f0-9]{12,64})(?:\.scope)?/gi)) {
      strongValues.push(match[1], match[1]?.slice(0, 12));
    }
    for (const match of cgroup.matchAll(/kubepods[^/]*[-/]pod([a-f0-9_-]{16,})/gi)) {
      const podUid = match[1]?.replace(/_/g, '-');
      strongValues.push(podUid);
    }
    const strong = cleanIdentityKeys(strongValues);
    if (strong.length > 0) return strong;

    const host = clean(event.process?.hostId, 240) ?? 'host';
    const boot = clean(event.process?.bootId, 240) ?? 'boot';
    if (attribution?.rootPid) {
      return cleanIdentityKeys([
        `host:${host}:${boot}:root:${attribution.rootPid}:${attribution.agentScopeId ?? attribution.agentDisplayName ?? event.agentId}`,
      ]);
    }
    if (event.process?.pid && (event.process.startTimeTicks || event.process.startTimeNs)) {
      return cleanIdentityKeys([
        `host:${host}:${boot}:process:${event.process.pid}:${event.process.startTimeTicks ?? event.process.startTimeNs}:${event.process.exe ?? event.process.comm ?? event.agentId}`,
      ]);
    }
    const systemdUnit = clean(event.process?.systemdUnit, 240);
    if (systemdUnit?.endsWith('.service') && !systemdUnit.startsWith('session-')) {
      return cleanIdentityKeys([`systemd:${host}:${systemdUnit}`]);
    }
    // session-*.scope is a shared runtime boundary, never an Agent review or suppression key.
    return cleanIdentityKeys([
      event.agentId,
      event.sessionId?.startsWith('session-') ? undefined : event.sessionId,
    ]);
  }

  resolveEvent(event: JudgedEvent): ResolvedAgentMetadata {
    const detected = detectedAgentIdentity(event);
    const exactRecordKey = this.legacyIndex.get(legacyKey(event.workspacePath, event.agentId));
    const exact = exactRecordKey ? this.records.get(exactRecordKey) : undefined;
    const assetRecordKey = this.assetIndex.get(detected.agentAssetId) ?? this.aliasIndex.get(detected.agentAssetId);
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
      agentAssetId: metadata?.agentAssetId ?? this.canonicalAgentAssetId(detected.agentAssetId),
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
    const agentId = clean(record.agentId, 240) ?? 'unknown';
    const workspacePath = clean(record.workspacePath, 500) ?? 'unknown';
    const agentAssetId = clean(record.agentAssetId, 160) ?? this.derivedAgentAssetId(record, workspacePath, agentId);
    return {
      agentId,
      agentAssetId,
      agentAssetAliases: cleanIdentityKeys([
        ...(record.agentAssetAliases ?? []),
        agentAssetIdForIdentityKey(`${workspacePath}\0${agentId}`),
      ]).filter((alias) => alias !== agentAssetId),
      workspacePath,
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
      agentAssetAliases: record.agentAssetAliases ? [...record.agentAssetAliases] : undefined,
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
    for (const record of keep) this.records.set(assetKey(record.agentAssetId), record);
    this.rebuildReviewIndex();
  }

  private rebuildReviewIndex(): void {
    this.reviewIndex.clear();
    this.identityIndex.clear();
    this.assetIndex.clear();
    this.legacyIndex.clear();
    this.aliasIndex.clear();
    for (const [recordKey, record] of this.records) {
      const assetId = clean(record.agentAssetId, 160);
      if (assetId) this.addIndexEntry(this.assetIndex, assetId, recordKey);
      this.addIndexEntry(this.legacyIndex, legacyKey(record.workspacePath, record.agentId), recordKey);
      for (const alias of record.agentAssetAliases ?? []) {
        this.addIndexEntry(this.aliasIndex, alias, recordKey);
      }
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

  private derivedAgentAssetId(
    record: Partial<AgentMetadataRecord>,
    workspacePath: string,
    agentId: string,
  ): string {
    const workload = record.workloadRef ?? record.reviewWorkloadRef;
    const identityKey =
      clean(record.physicalWorkloadId ?? record.reviewPhysicalWorkloadId, 500) ??
      clean(record.agentInstanceId ?? record.reviewAgentInstanceId, 500) ??
      (
        workload?.podUid
          ? `k8s:${workload.podUid}:${workload.containerName ?? workload.name ?? 'container'}`
          : undefined
      ) ??
      cleanIdentityKeys(record.identityKeys ?? record.reviewIdentityKeys)[0] ??
      `${workspacePath}\0${agentId}`;
    return agentAssetIdForIdentityKey(identityKey);
  }

  private canonicalAssetIdForMutation(
    agentId: string,
    workspacePath: string,
    input: AgentMetadataUpdateRequest | AgentReviewRequest,
    current?: AgentMetadataRecord,
  ): string {
    const requested = clean(input.agentAssetId, 160);
    if (requested) return this.canonicalAgentAssetId(requested);
    if (current) return current.agentAssetId;
    return this.derivedAgentAssetId({
      agentId,
      workspacePath,
      identityKeys: input.identityKeys,
      physicalWorkloadId: input.physicalWorkloadId,
      agentInstanceId: input.agentInstanceId,
      workloadRef: input.workloadRef,
    }, workspacePath, agentId);
  }

  private assetAliases(
    current: AgentMetadataRecord | undefined,
    canonicalAssetId: string,
    workspacePath: string,
    agentId: string,
  ): string[] {
    return cleanIdentityKeys([
      ...(current?.agentAssetAliases ?? []),
      current?.agentAssetId,
      agentAssetIdForIdentityKey(`${workspacePath}\0${agentId}`),
    ]).filter((alias) => alias !== canonicalAssetId);
  }

  private findRecordKey(
    requestedAssetId: string | undefined,
    workspacePath: string,
    agentId: string,
    identityKeys?: string[],
  ): string | undefined {
    if (requestedAssetId) {
      const direct = this.assetIndex.get(requestedAssetId) ?? this.aliasIndex.get(requestedAssetId);
      if (direct) return direct;
    }
    const legacy = this.legacyIndex.get(legacyKey(workspacePath, agentId));
    if (legacy) return legacy;
    for (const identity of cleanIdentityKeys(identityKeys)) {
      const indexed = this.identityIndex.get(identity);
      if (indexed) return indexed;
    }
    return undefined;
  }

  private storeNormalized(record: AgentMetadataRecord, previousKey?: string): void {
    const normalized = this.normalize(record);
    const nextKey = assetKey(normalized.agentAssetId);
    if (previousKey && previousKey !== nextKey) this.records.delete(previousKey);
    const existing = this.records.get(nextKey);
    this.records.set(nextKey, existing ? this.mergeRecords(existing, normalized) : normalized);
    this.rebuildReviewIndex();
  }

  private mergeRecords(left: AgentMetadataRecord, right: AgentMetadataRecord): AgentMetadataRecord {
    const newer = right.updatedAt >= left.updatedAt ? right : left;
    const older = newer === right ? left : right;
    return this.normalize({
      ...older,
      ...newer,
      displayName: newer.displayName ?? older.displayName,
      owner: newer.owner ?? older.owner,
      team: newer.team ?? older.team,
      environment: newer.environment ?? older.environment,
      criticality: newer.criticality ?? older.criticality,
      note: newer.note ?? older.note,
      tags: [...new Set([...(older.tags ?? []), ...(newer.tags ?? [])])],
      identityKeys: cleanIdentityKeys([...(older.identityKeys ?? []), ...(newer.identityKeys ?? [])]),
      reviewIdentityKeys: cleanIdentityKeys([...(older.reviewIdentityKeys ?? []), ...(newer.reviewIdentityKeys ?? [])]),
      agentAssetAliases: cleanIdentityKeys([...(older.agentAssetAliases ?? []), ...(newer.agentAssetAliases ?? [])]),
    });
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
