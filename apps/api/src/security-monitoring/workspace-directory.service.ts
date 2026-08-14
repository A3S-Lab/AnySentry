import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AgentMetadataService } from './agent-metadata.service';
import { RelationalBusinessStore } from './relational-business-store.service';
import {
  AgentWorkspaceBindingRecord,
  JudgedEvent,
  WorkspaceDirectoryRecord,
} from './types';

const PERSIST_DELAY_MS = 250;
const REFRESH_INTERVAL_MS = 15_000;
const RETAIN_BINDINGS = 100_000;

function hashId(prefix: string, ...parts: Array<string | number>): string {
  return `${prefix}_${createHash('sha256')
    .update(parts.map(String).join('\0'))
    .digest('hex')
    .slice(0, 24)}`;
}

function clean(value: unknown, limit: number): string | undefined {
  const result = typeof value === 'string' ? value.trim() : '';
  return result ? result.slice(0, limit) : undefined;
}

function canonicalPath(value: unknown): string | undefined {
  const raw = clean(value, 1_024);
  if (!raw || raw === 'unknown' || raw.startsWith('agent://')) return undefined;
  const normalized = raw.replaceAll('\\', '/');
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '');
}

function workspaceFingerprint(path: string): string {
  return `sha256:${createHash('sha256').update(path).digest('hex')}`;
}

function displayNameForPath(path: string): string {
  if (path.startsWith('workspace://')) return path.slice('workspace://'.length);
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

function nodeScopeForEvent(event: JudgedEvent): string {
  return clean(event.process?.hostId, 240)
    ?? clean(event.collectorId, 240)
    ?? clean(event.sourceId, 240)
    ?? 'local';
}

/**
 * Stable Workspace directory and temporal Agent-to-Workspace membership.
 *
 * Event rows remain immutable facts. This service records the mutable directory projection and
 * closes the previous active binding when an Agent instance is observed in a different Workspace.
 */
@Injectable()
export class WorkspaceDirectoryService implements OnModuleInit, OnModuleDestroy {
  private readonly workspaces = new Map<string, WorkspaceDirectoryRecord>();
  private readonly workspaceByScopeFingerprint = new Map<string, string>();
  private readonly workspaceByFingerprint = new Map<string, Set<string>>();
  private readonly bindings = new Map<string, AgentWorkspaceBindingRecord>();
  private readonly activeBindingByAgent = new Map<string, string>();
  private readonly dirtyWorkspaceIds = new Set<string>();
  private readonly dirtyBindingIds = new Set<string>();
  private persistTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    private readonly relational: RelationalBusinessStore,
    private readonly agentMetadata: AgentMetadataService,
  ) {}

  async onModuleInit(): Promise<void> {
    const [workspaces, bindings] = await Promise.all([
      this.relational.loadWorkspaceDirectory(),
      this.relational.loadAgentWorkspaceBindings(),
    ]);
    for (const workspace of workspaces) this.storeWorkspace(workspace);
    for (const binding of bindings) this.storeBinding(binding);

    // Agent metadata predates the directory. Seed its current association without rewriting the
    // historical event timeline; future observations refine first/last-seen and validity.
    for (const agent of this.agentMetadata.list()) {
      if (agent.reviewDecision !== 'confirmed_agent') continue;
      const observedAt = Date.parse(agent.updatedAt);
      this.observeAssociation(
        agent.agentAssetId,
        agent.workspacePath,
        Number.isFinite(observedAt) ? observedAt : Date.now(),
        agent.workloadRef?.nodeName ?? 'local',
      );
    }
    await this.persist();

    if (this.relational.configured()) {
      this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
      this.refreshTimer.unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    await this.persist();
  }

  status(): {
    workspaceCount: number;
    bindingCount: number;
    activeBindingCount: number;
    postgresqlBacked: boolean;
  } {
    return {
      workspaceCount: this.workspaces.size,
      bindingCount: this.bindings.size,
      activeBindingCount: this.activeBindingByAgent.size,
      postgresqlBacked: this.relational.isReady(),
    };
  }

  directory(): WorkspaceDirectoryRecord[] {
    return [...this.workspaces.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  bindingHistory(agentAssetId?: string, workspaceId?: string): AgentWorkspaceBindingRecord[] {
    return [...this.bindings.values()]
      .filter((binding) =>
        (!agentAssetId || binding.agentAssetId === agentAssetId)
        && (!workspaceId || binding.workspaceId === workspaceId))
      .sort((a, b) => b.validFrom - a.validFrom);
  }

  observeEvent(event: JudgedEvent): WorkspaceDirectoryRecord | undefined {
    const resolved = this.agentMetadata.resolveEvent(event);
    if (
      resolved.effectiveClassification !== 'confirmed_agent'
      && resolved.effectiveClassification !== 'probable_agent'
    ) {
      return undefined;
    }
    const rootEventWorkspace =
      event.process?.pid
      && event.attribution?.rootPid === event.process.pid
        ? event.workspacePath
        : undefined;
    const workspacePath = canonicalPath(
      resolved.metadata?.workspacePath
      ?? event.attribution?.agentWorkspacePath
      ?? rootEventWorkspace,
    );
    if (!workspacePath) return undefined;
    return this.observeAssociation(
      resolved.agentAssetId,
      workspacePath,
      event.at,
      nodeScopeForEvent(event),
      event.sourceId,
    );
  }

  registerWorkspace(input: {
    workspaceId: string;
    repositoryId: string;
    workspacePathFingerprint: string;
    displayName: string;
    scannerId: string;
    sourceId?: string;
    environmentId?: string;
    registeredAt: number;
    updatedAt: number;
  }): WorkspaceDirectoryRecord {
    const prior = this.workspaces.get(input.workspaceId);
    const record: WorkspaceDirectoryRecord = {
      workspaceId: input.workspaceId,
      workspacePath: prior?.workspacePath ?? `workspace://${input.workspaceId}`,
      workspacePathFingerprint: input.workspacePathFingerprint,
      displayName: input.displayName,
      repositoryId: input.repositoryId,
      sourceId: input.sourceId,
      environmentId: input.environmentId,
      nodeScope: input.scannerId,
      firstSeenAt: Math.min(prior?.firstSeenAt ?? input.registeredAt, input.registeredAt),
      lastSeenAt: Math.max(prior?.lastSeenAt ?? input.updatedAt, input.updatedAt),
      updatedAt: Math.max(prior?.updatedAt ?? 0, input.updatedAt),
    };
    this.storeWorkspace(record);
    this.dirtyWorkspaceIds.add(record.workspaceId);
    this.persistSoon();
    return record;
  }

  resolveWorkspaceId(workspacePath: string, nodeScope = 'local'): string | undefined {
    const canonical = canonicalPath(workspacePath);
    if (!canonical) return undefined;
    const fingerprint = workspaceFingerprint(canonical);
    return this.workspaceByScopeFingerprint.get(`${nodeScope}\0${fingerprint}`)
      ?? this.uniqueWorkspaceForFingerprint(fingerprint);
  }

  private observeAssociation(
    agentAssetId: string,
    workspacePathValue: string,
    observedAt: number,
    nodeScope: string,
    sourceId?: string,
  ): WorkspaceDirectoryRecord | undefined {
    const workspacePath = canonicalPath(workspacePathValue);
    if (!workspacePath || !agentAssetId) return undefined;
    const fingerprint = workspaceFingerprint(workspacePath);
    const scopedKey = `${nodeScope}\0${fingerprint}`;
    const workspaceId =
      this.workspaceByScopeFingerprint.get(scopedKey)
      ?? this.uniqueWorkspaceForFingerprint(fingerprint)
      ?? hashId('wsp', nodeScope, fingerprint);
    const priorWorkspace = this.workspaces.get(workspaceId);
    const workspace: WorkspaceDirectoryRecord = {
      workspaceId,
      workspacePath,
      workspacePathFingerprint: fingerprint,
      displayName: priorWorkspace?.displayName ?? displayNameForPath(workspacePath),
      repositoryId: priorWorkspace?.repositoryId,
      sourceId: priorWorkspace?.sourceId ?? clean(sourceId, 240),
      environmentId: priorWorkspace?.environmentId,
      nodeScope: priorWorkspace?.nodeScope ?? nodeScope,
      firstSeenAt: Math.min(priorWorkspace?.firstSeenAt ?? observedAt, observedAt),
      lastSeenAt: Math.max(priorWorkspace?.lastSeenAt ?? observedAt, observedAt),
      updatedAt: Math.max(priorWorkspace?.updatedAt ?? 0, observedAt),
    };
    this.storeWorkspace(workspace);
    this.dirtyWorkspaceIds.add(workspaceId);

    const activeId = this.activeBindingByAgent.get(agentAssetId);
    const active = activeId ? this.bindings.get(activeId) : undefined;
    if (active?.workspaceId === workspaceId) {
      const next = {
        ...active,
        lastObservedAt: Math.max(active.lastObservedAt, observedAt),
        updatedAt: Math.max(active.updatedAt, observedAt),
      };
      this.storeBinding(next);
      this.dirtyBindingIds.add(next.bindingId);
    } else if (!active || observedAt >= active.validFrom) {
      if (active) {
        const closed = {
          ...active,
          validTo: Math.max(active.validFrom, observedAt - 1),
          updatedAt: Math.max(active.updatedAt, observedAt),
        };
        this.storeBinding(closed);
        this.dirtyBindingIds.add(closed.bindingId);
      }
      const binding: AgentWorkspaceBindingRecord = {
        bindingId: hashId('awb', agentAssetId, workspaceId, observedAt),
        agentAssetId,
        workspaceId,
        workspacePath,
        validFrom: observedAt,
        lastObservedAt: observedAt,
        updatedAt: observedAt,
      };
      this.storeBinding(binding);
      this.dirtyBindingIds.add(binding.bindingId);
    } else {
      // A late event must not replace the current association. Preserve it as bounded historical
      // evidence ending before the current binding began.
      const binding: AgentWorkspaceBindingRecord = {
        bindingId: hashId('awb', agentAssetId, workspaceId, observedAt),
        agentAssetId,
        workspaceId,
        workspacePath,
        validFrom: observedAt,
        validTo: Math.max(observedAt, active.validFrom - 1),
        lastObservedAt: observedAt,
        updatedAt: observedAt,
      };
      this.storeBinding(binding);
      this.dirtyBindingIds.add(binding.bindingId);
    }
    this.trimBindings();
    this.persistSoon();
    return workspace;
  }

  private storeWorkspace(record: WorkspaceDirectoryRecord): void {
    const current = this.workspaces.get(record.workspaceId);
    if (current && current.updatedAt > record.updatedAt) return;
    this.workspaces.set(record.workspaceId, record);
    const scopeKey = `${record.nodeScope ?? 'local'}\0${record.workspacePathFingerprint}`;
    this.workspaceByScopeFingerprint.set(scopeKey, record.workspaceId);
    const ids = this.workspaceByFingerprint.get(record.workspacePathFingerprint) ?? new Set<string>();
    ids.add(record.workspaceId);
    this.workspaceByFingerprint.set(record.workspacePathFingerprint, ids);
  }

  private storeBinding(record: AgentWorkspaceBindingRecord): void {
    const current = this.bindings.get(record.bindingId);
    if (current && current.updatedAt > record.updatedAt) return;
    this.bindings.set(record.bindingId, record);
    if (record.validTo === undefined) {
      const activeId = this.activeBindingByAgent.get(record.agentAssetId);
      const active = activeId ? this.bindings.get(activeId) : undefined;
      if (!active || active.validFrom <= record.validFrom) {
        this.activeBindingByAgent.set(record.agentAssetId, record.bindingId);
      }
    } else if (this.activeBindingByAgent.get(record.agentAssetId) === record.bindingId) {
      this.activeBindingByAgent.delete(record.agentAssetId);
    }
  }

  private uniqueWorkspaceForFingerprint(fingerprint: string): string | undefined {
    const ids = this.workspaceByFingerprint.get(fingerprint);
    return ids?.size === 1 ? [...ids][0] : undefined;
  }

  private trimBindings(): void {
    if (this.bindings.size <= RETAIN_BINDINGS) return;
    const retained = [...this.bindings.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RETAIN_BINDINGS);
    this.bindings.clear();
    this.activeBindingByAgent.clear();
    for (const binding of retained) this.storeBinding(binding);
  }

  private persistSoon(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, PERSIST_DELAY_MS);
    this.persistTimer.unref();
  }

  private async persist(): Promise<void> {
    const workspaces = [...this.dirtyWorkspaceIds]
      .map((id) => this.workspaces.get(id))
      .filter((record): record is WorkspaceDirectoryRecord => Boolean(record));
    const bindings = [...this.dirtyBindingIds]
      .map((id) => this.bindings.get(id))
      .filter((record): record is AgentWorkspaceBindingRecord => Boolean(record));
    const [workspaceSaved, bindingSaved] = await Promise.all([
      this.relational.saveWorkspaceDirectory(workspaces),
      this.relational.saveAgentWorkspaceBindings(bindings),
    ]);
    if (workspaceSaved) for (const record of workspaces) this.dirtyWorkspaceIds.delete(record.workspaceId);
    if (bindingSaved) for (const record of bindings) this.dirtyBindingIds.delete(record.bindingId);
  }

  private async refresh(): Promise<void> {
    const [workspaces, bindings] = await Promise.all([
      this.relational.loadWorkspaceDirectory(),
      this.relational.loadAgentWorkspaceBindings(),
    ]);
    for (const workspace of workspaces) this.storeWorkspace(workspace);
    for (const binding of bindings) this.storeBinding(binding);
  }
}
