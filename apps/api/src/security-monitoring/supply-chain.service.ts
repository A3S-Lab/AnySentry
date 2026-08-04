import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { redisConnection } from './judgment-queue.service';
import {
  parseRuntimeInstallEvent,
  RuntimeInstallEvent,
} from './supply-chain-install-trigger';
import {
  componentSetDigest,
  dependencySnapshotId,
  normalizeComponents,
  workspacePathFingerprint,
} from './supply-chain-normalizer';
import { SupplyChainStore } from './supply-chain-store';
import {
  RegisterWorkspaceRequest,
  ScanReason,
  SubmitScanResultRequest,
  SUPPLY_CHAIN_ASSESSMENT_QUEUE,
  SupplyChainAssessmentJob,
  SupplyChainOverview,
  WorkspaceRegistration,
  WorkspaceScanTask,
} from './supply-chain.types';
import { JudgedEvent } from './types';

const TASK_PREFIX = 'anysentry:supply-chain:scan-task:';
const PENDING_PREFIX = 'anysentry:supply-chain:scanner-pending:';
const WORKSPACE_TASK_PREFIX = 'anysentry:supply-chain:workspace-task:';
const LEASED_TASKS_KEY = 'anysentry:supply-chain:leased-tasks';
const INSTALL_INTENT_PREFIX = 'anysentry:supply-chain:install-intent:';
const INSTALL_DUE_KEY = 'anysentry:supply-chain:runtime-install-due';
const INSTALL_OBSERVED_PREFIX = 'anysentry:supply-chain:runtime-install-observed:';
const LEASE_MS = 2 * 60_000;
const INSTALL_INTENT_TTL_SECONDS = 15 * 60;
const INSTALL_DEBOUNCE_MS = Math.max(
  1_000,
  Number(process.env.ANYSENTRY_RUNTIME_INSTALL_DEBOUNCE_MS || 10_000),
);
const MAX_COMPONENTS = 100_000;

interface RuntimeInstallIntent {
  workspacePath: string;
  packageManager: string;
  startTimeNs?: string;
  observedAt: number;
}

function safeId(value: unknown, field: string): string {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/.test(text)) {
    throw new Error(`${field} must be a stable identifier between 3 and 192 characters`);
  }
  return text;
}

function safeText(value: unknown, fallback: string, maxLength = 256): string {
  return String(value ?? '').trim().slice(0, maxLength) || fallback;
}

function safePathFingerprint(value: unknown): string {
  const fingerprint = String(value ?? '').trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error('workspacePathFingerprint must be a SHA-256 digest');
  }
  return fingerprint;
}

function taskKey(taskId: string): string {
  return `${TASK_PREFIX}${taskId}`;
}

function pendingKey(scannerId: string): string {
  return `${PENDING_PREFIX}${scannerId}`;
}

function workspaceTaskKey(workspaceId: string): string {
  return `${WORKSPACE_TASK_PREFIX}${workspaceId}`;
}

function shortDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function eventIdentity(event: JudgedEvent): string {
  return [
    event.sourceId,
    event.collectorId,
    event.process?.hostId,
    event.attribution?.agentScopeId,
    event.agentId,
  ].find((value) => typeof value === 'string' && value.trim()) ?? 'local';
}

function installIntentKey(event: JudgedEvent, observed: RuntimeInstallEvent): string {
  return `${INSTALL_INTENT_PREFIX}${shortDigest(`${eventIdentity(event)}\u0000${observed.pid}`)}`;
}

@Injectable()
export class SupplyChainService implements OnModuleInit, OnModuleDestroy {
  readonly enabled = process.env.ANYSENTRY_SUPPLY_CHAIN === 'on';
  private readonly store = new SupplyChainStore();
  private redis?: IORedis;
  private assessmentQueue?: Queue<SupplyChainAssessmentJob>;
  private installTimer?: NodeJS.Timeout;
  private drainingInstallScans = false;

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    if (!process.env.ANYSENTRY_WORKSPACE_SCANNER_TOKEN?.trim()
      && !process.env.ANYSENTRY_WORKSPACE_SCANNER_TOKENS?.trim()) {
      throw new Error('a Workspace Scanner token is required when supply-chain scanning is enabled');
    }
    if (!(await this.store.init())) throw new Error('supply-chain ClickHouse store is unavailable');
    this.redis = new IORedis(
      process.env.ANYSENTRY_REDIS_URL || 'redis://redis:6379/0',
      { maxRetriesPerRequest: null },
    );
    this.assessmentQueue = new Queue<SupplyChainAssessmentJob>(
      SUPPLY_CHAIN_ASSESSMENT_QUEUE,
      {
        connection: redisConnection(),
        defaultJobOptions: {
          attempts: 4,
          backoff: { type: 'exponential', delay: 15_000 },
          removeOnComplete: { age: 7 * 24 * 60 * 60, count: 50_000 },
          removeOnFail: { age: 30 * 24 * 60 * 60, count: 100_000 },
        },
      },
    );
    this.installTimer = setInterval(() => {
      void this.drainRuntimeInstallScans();
    }, 2_000);
    this.installTimer.unref();
    await this.drainRuntimeInstallScans();
  }

  private requireRedis(): IORedis {
    if (!this.enabled || !this.redis) throw new Error('supply-chain service is disabled');
    return this.redis;
  }

  async registerWorkspace(input: RegisterWorkspaceRequest): Promise<{
    workspace: WorkspaceRegistration;
    initialTask?: WorkspaceScanTask;
    activeDependencySnapshotId?: string;
    activeDescriptorDigest?: string;
  }> {
    const now = Date.now();
    const workspaceId = safeId(input.workspaceId, 'workspaceId');
    const repositoryId = safeId(input.repositoryId, 'repositoryId');
    const scannerId = safeId(input.scannerId, 'scannerId');
    const workspacePathFingerprint = safePathFingerprint(input.workspacePathFingerprint);
    const previous = await this.store.workspace(workspaceId);
    if (previous && (previous.repositoryId !== repositoryId || previous.scannerId !== scannerId)) {
      throw new Error('workspaceId is already registered to a different repository or scanner');
    }
    const pathOwner = await this.store.workspaceByPathFingerprint(workspacePathFingerprint);
    if (pathOwner && pathOwner.workspaceId !== workspaceId) {
      throw new Error('workspacePathFingerprint is already registered to another workspace');
    }
    const workspace: WorkspaceRegistration = {
      schemaVersion: 'anysentry.workspace_registration.v1',
      repositoryId,
      workspaceId,
      scannerId,
      workspacePathFingerprint,
      displayName: safeText(input.displayName, repositoryId),
      sourceId: input.sourceId ? safeId(input.sourceId, 'sourceId') : undefined,
      environmentId: input.environmentId ? safeId(input.environmentId, 'environmentId') : undefined,
      registeredAt: previous?.registeredAt ?? now,
      updatedAt: now,
    };
    await this.store.upsertWorkspace(workspace);
    const active = await this.store.activeBinding(workspaceId);
    const initialTask = active ? undefined : await this.enqueueScan(workspaceId, 'initial');
    const activeSnapshot = active ? await this.store.snapshot(active.dependencySnapshotId) : undefined;
    return {
      workspace,
      initialTask,
      activeDependencySnapshotId: activeSnapshot?.dependencySnapshotId,
      activeDescriptorDigest: activeSnapshot?.descriptorDigest,
    };
  }

  async enqueueScan(workspaceIdInput: string, reason: ScanReason): Promise<WorkspaceScanTask> {
    const redis = this.requireRedis();
    const workspaceId = safeId(workspaceIdInput, 'workspaceId');
    const workspace = await this.store.workspace(workspaceId);
    if (!workspace) throw new Error('workspace is not registered');
    const existingTaskId = await redis.get(workspaceTaskKey(workspaceId));
    if (existingTaskId) {
      const existing = await this.task(existingTaskId);
      if (existing && (existing.status === 'pending' || existing.status === 'leased')) return existing;
      await redis.del(workspaceTaskKey(workspaceId));
    }
    const now = Date.now();
    if (reason === 'dependency_descriptor_changed') {
      await this.store.markSnapshotPending(workspaceId, now);
    }
    const task: WorkspaceScanTask = {
      schemaVersion: 'anysentry.workspace_scan_task.v1',
      taskId: `scan_${randomUUID()}`,
      workspaceId,
      scannerId: workspace.scannerId,
      reason,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      attempt: 0,
    };
    const reserved = await redis.set(
      workspaceTaskKey(workspaceId),
      task.taskId,
      'EX',
      30 * 24 * 60 * 60,
      'NX',
    );
    if (!reserved) {
      const competingTaskId = await redis.get(workspaceTaskKey(workspaceId));
      const competing = competingTaskId ? await this.task(competingTaskId) : undefined;
      if (competing && (competing.status === 'pending' || competing.status === 'leased')) return competing;
      throw new Error('workspace scan task reservation is temporarily unavailable');
    }
    await redis
      .multi()
      .set(taskKey(task.taskId), JSON.stringify(task), 'EX', 30 * 24 * 60 * 60)
      .lpush(pendingKey(task.scannerId), task.taskId)
      .exec();
    return task;
  }

  async notifyDescriptorChange(workspaceIdInput: string, scannerIdInput: string): Promise<WorkspaceScanTask> {
    const workspaceId = safeId(workspaceIdInput, 'workspaceId');
    const scannerId = safeId(scannerIdInput, 'scannerId');
    const workspace = await this.store.workspace(workspaceId);
    if (!workspace || workspace.scannerId !== scannerId) {
      throw new Error('workspace registration does not match scanner');
    }
    return this.enqueueScan(workspaceId, 'dependency_descriptor_changed');
  }

  /**
   * Observe package-manager execution without changing the event judgment path.
   * A scan is scheduled only after the matching process exits successfully.
   */
  async observeRuntimeInstall(event: JudgedEvent, observerLine: string): Promise<void> {
    if (!this.enabled || event.source !== 'observer') return;
    const observed = parseRuntimeInstallEvent(observerLine);
    if (!observed) return;
    const redis = this.requireRedis();
    const key = installIntentKey(event, observed);
    if (observed.phase === 'started') {
      if (!event.workspacePath.startsWith('/')) return;
      const intent: RuntimeInstallIntent = {
        workspacePath: event.workspacePath,
        packageManager: observed.packageManager ?? 'unknown',
        startTimeNs: observed.startTimeNs,
        observedAt: event.at,
      };
      await redis.set(key, JSON.stringify(intent), 'EX', INSTALL_INTENT_TTL_SECONDS);
      return;
    }

    const raw = await redis.getdel(key);
    if (!raw || !observed.succeeded) return;
    const intent = JSON.parse(raw) as RuntimeInstallIntent;
    if (intent.startTimeNs && observed.startTimeNs && intent.startTimeNs !== observed.startTimeNs) return;
    let fingerprint: string;
    try {
      fingerprint = workspacePathFingerprint(intent.workspacePath);
    } catch {
      return;
    }
    const workspace = await this.store.workspaceByPathFingerprint(fingerprint);
    if (!workspace) return;
    const dueAt = Date.now() + INSTALL_DEBOUNCE_MS;
    await redis
      .multi()
      .zadd(INSTALL_DUE_KEY, dueAt, workspace.workspaceId)
      .set(
        `${INSTALL_OBSERVED_PREFIX}${workspace.workspaceId}`,
        String(intent.observedAt),
        'EX',
        24 * 60 * 60,
      )
      .exec();
  }

  private async drainRuntimeInstallScans(): Promise<void> {
    if (!this.enabled || !this.redis || this.drainingInstallScans) return;
    this.drainingInstallScans = true;
    try {
      const due = await this.redis.zrangebyscore(INSTALL_DUE_KEY, 0, Date.now(), 'LIMIT', 0, 100);
      for (const workspaceId of due) {
        if (await this.redis.zrem(INSTALL_DUE_KEY, workspaceId) !== 1) continue;
        const observedAt = Number(
          await this.redis.get(`${INSTALL_OBSERVED_PREFIX}${workspaceId}`),
        ) || Date.now();
        try {
          const task = await this.enqueueScan(workspaceId, 'runtime_install');
          // If an older scan was already leased, run again after it has had time to finish so an
          // installation completed mid-scan cannot be missed.
          if (task.createdAt < observedAt && task.reason !== 'runtime_install') {
            await this.redis.zadd(INSTALL_DUE_KEY, Date.now() + 30_000, workspaceId);
          } else {
            await this.redis.del(`${INSTALL_OBSERVED_PREFIX}${workspaceId}`);
          }
        } catch (error) {
          await this.redis.zadd(INSTALL_DUE_KEY, Date.now() + 30_000, workspaceId);
          console.error('[supply-chain] runtime install scan scheduling failed', {
            workspaceId,
            error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
          });
        }
      }
    } finally {
      this.drainingInstallScans = false;
    }
  }

  async requestAssessment(workspaceIdInput: string): Promise<{ dependencySnapshotId: string }> {
    const workspaceId = safeId(workspaceIdInput, 'workspaceId');
    const active = await this.store.activeBinding(workspaceId);
    if (!active || active.state !== 'active') {
      throw new Error('workspace does not have an active dependency snapshot');
    }
    await this.enqueueAssessment(workspaceId, active.dependencySnapshotId, 'manual');
    return { dependencySnapshotId: active.dependencySnapshotId };
  }

  private async reclaimExpired(): Promise<void> {
    const redis = this.requireRedis();
    const now = Date.now();
    const expired = await redis.zrangebyscore(LEASED_TASKS_KEY, 0, now, 'LIMIT', 0, 100);
    for (const taskId of expired) {
      const raw = await redis.get(taskKey(taskId));
      if (!raw) {
        await redis.zrem(LEASED_TASKS_KEY, taskId);
        continue;
      }
      const task = JSON.parse(raw) as WorkspaceScanTask;
      if (task.status !== 'leased' || (task.leaseExpiresAt ?? 0) > now) continue;
      const recovered: WorkspaceScanTask = {
        ...task,
        status: 'pending',
        updatedAt: now,
        leaseOwner: undefined,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      };
      await redis
        .multi()
        .set(taskKey(taskId), JSON.stringify(recovered), 'EX', 30 * 24 * 60 * 60)
        .lpush(pendingKey(task.scannerId), taskId)
        .zrem(LEASED_TASKS_KEY, taskId)
        .exec();
    }
  }

  async claimTask(scannerIdInput: string): Promise<WorkspaceScanTask | undefined> {
    const redis = this.requireRedis();
    const scannerId = safeId(scannerIdInput, 'scannerId');
    await this.reclaimExpired();
    for (let index = 0; index < 20; index += 1) {
      const taskId = await redis.rpop(pendingKey(scannerId));
      if (!taskId) return undefined;
      const raw = await redis.get(taskKey(taskId));
      if (!raw) continue;
      const task = JSON.parse(raw) as WorkspaceScanTask;
      if (task.status !== 'pending' || task.scannerId !== scannerId) continue;
      const now = Date.now();
      const leased: WorkspaceScanTask = {
        ...task,
        status: 'leased',
        updatedAt: now,
        attempt: task.attempt + 1,
        leaseOwner: scannerId,
        leaseToken: randomBytes(24).toString('hex'),
        leaseExpiresAt: now + LEASE_MS,
      };
      await redis
        .multi()
        .set(taskKey(taskId), JSON.stringify(leased), 'EX', 30 * 24 * 60 * 60)
        .zadd(LEASED_TASKS_KEY, leased.leaseExpiresAt!, taskId)
        .exec();
      return leased;
    }
    return undefined;
  }

  async heartbeat(taskIdInput: string, scannerIdInput: string, leaseToken: string): Promise<WorkspaceScanTask> {
    const redis = this.requireRedis();
    const taskId = safeId(taskIdInput, 'taskId');
    const scannerId = safeId(scannerIdInput, 'scannerId');
    const task = await this.task(taskId);
    if (!task || task.status !== 'leased') throw new Error('scan task is not leased');
    if (task.scannerId !== scannerId || task.leaseToken !== leaseToken) throw new Error('scan task lease does not match');
    if ((task.leaseExpiresAt ?? 0) < Date.now()) throw new Error('scan task lease expired');
    const now = Date.now();
    const updated = { ...task, updatedAt: now, leaseExpiresAt: now + LEASE_MS };
    await redis
      .multi()
      .set(taskKey(taskId), JSON.stringify(updated), 'EX', 30 * 24 * 60 * 60)
      .zadd(LEASED_TASKS_KEY, updated.leaseExpiresAt, taskId)
      .exec();
    return updated;
  }

  async submitResult(taskIdInput: string, input: SubmitScanResultRequest): Promise<{
    task: WorkspaceScanTask;
    dependencySnapshotId?: string;
    assessmentQueued: boolean;
  }> {
    const redis = this.requireRedis();
    const taskId = safeId(taskIdInput, 'taskId');
    const scannerId = safeId(input.scannerId, 'scannerId');
    const task = await this.task(taskId);
    if (task && (task.status === 'completed' || task.status === 'failed')) {
      if (task.scannerId !== scannerId) throw new Error('scan task does not match scanner');
      return {
        task,
        dependencySnapshotId: task.resultDependencySnapshotId,
        assessmentQueued: task.assessmentQueued ?? false,
      };
    }
    if (!task || task.status !== 'leased') throw new Error('scan task is not leased');
    if (task.scannerId !== scannerId || task.leaseToken !== input.leaseToken) {
      throw new Error('scan task lease does not match');
    }
    if ((task.leaseExpiresAt ?? 0) < Date.now()) throw new Error('scan task lease expired');
    if (!['complete', 'partial', 'failed'].includes(input.extractionStatus)) {
      throw new Error('invalid extractionStatus');
    }
    if (!Array.isArray(input.components) || input.components.length > MAX_COMPONENTS) {
      throw new Error(`components must contain at most ${MAX_COMPONENTS} entries`);
    }
    const workspace = await this.store.workspace(task.workspaceId);
    if (!workspace || workspace.scannerId !== scannerId) throw new Error('workspace registration does not match scanner');
    const components = normalizeComponents(input.components);
    const digest = componentSetDigest(components);
    const policyVersion = safeText(input.extractionPolicyVersion, 'workspace-components-v1', 128);
    const snapshotId = dependencySnapshotId(task.workspaceId, digest, policyVersion);
    const confirmedAt = Date.now();
    const currentBinding = await this.store.activeBinding(task.workspaceId);
    const snapshot = {
      schemaVersion: 'anysentry.dependency_snapshot.v1',
      dependencySnapshotId: snapshotId,
      componentSetDigest: digest,
      repositoryId: workspace.repositoryId,
      workspaceId: workspace.workspaceId,
      scannerId,
      extractionPolicyVersion: policyVersion,
      scannerName: safeText(input.scannerName, 'osv-scanner', 128),
      scannerVersion: safeText(input.scannerVersion, 'unknown', 128),
      snapshotExtractionStatus: input.extractionStatus,
      descriptorDigest: input.descriptorDigest ? safeText(input.descriptorDigest, '', 256) : undefined,
      components,
      observedChangeAt: Math.min(
        confirmedAt,
        Math.max(0, Number(input.observedChangeAt) || task.createdAt),
      ),
      confirmedAt,
      warnings: Array.isArray(input.warnings)
        ? input.warnings.map((warning) => safeText(warning, '', 500)).filter(Boolean).slice(0, 100)
        : [],
      error: input.error ? safeText(input.error, '', 1_000) : undefined,
    } as const;
    await this.store.insertSnapshot(snapshot);
    let assessmentQueued = false;
    if (input.extractionStatus === 'complete') {
      await this.store.activateSnapshot(snapshot);
      if (currentBinding?.dependencySnapshotId !== snapshotId) {
        await this.enqueueAssessment(task.workspaceId, snapshotId, 'snapshot_confirmed');
        assessmentQueued = true;
      }
    }
    const shouldRetry = input.extractionStatus !== 'complete' && task.attempt < 3;
    const completed: WorkspaceScanTask = {
      ...task,
      status: shouldRetry ? 'pending' : input.extractionStatus === 'complete' ? 'completed' : 'failed',
      updatedAt: confirmedAt,
      leaseExpiresAt: undefined,
      leaseToken: undefined,
      leaseOwner: undefined,
      resultDependencySnapshotId: snapshotId,
      assessmentQueued,
    };
    const update = redis
      .multi()
      .set(taskKey(taskId), JSON.stringify(completed), 'EX', 30 * 24 * 60 * 60)
      .zrem(LEASED_TASKS_KEY, taskId);
    if (shouldRetry) update.lpush(pendingKey(task.scannerId), taskId);
    else update.del(workspaceTaskKey(task.workspaceId));
    await update.exec();
    return { task: completed, dependencySnapshotId: snapshotId, assessmentQueued };
  }

  async enqueueAssessment(
    workspaceId: string,
    dependencySnapshot: string,
    reason: SupplyChainAssessmentJob['reason'],
  ): Promise<void> {
    if (!this.assessmentQueue) throw new Error('supply-chain assessment queue is unavailable');
    const now = Date.now();
    const job: SupplyChainAssessmentJob = {
      schemaVersion: 'anysentry.supply_chain_assessment_job.v1',
      jobId: `sca_${randomUUID()}`,
      workspaceId,
      dependencySnapshotId: dependencySnapshot,
      reason,
      queuedAt: now,
    };
    await this.assessmentQueue.add('assess-dependency-snapshot', job, {
      jobId: reason === 'retry' || reason === 'manual'
        ? `${dependencySnapshot}-${reason}-${now}`
        : `${dependencySnapshot}-${new Date(now).toISOString().slice(0, 10)}`,
    });
  }

  async task(taskIdInput: string): Promise<WorkspaceScanTask | undefined> {
    const raw = await this.requireRedis().get(taskKey(safeId(taskIdInput, 'taskId')));
    return raw ? JSON.parse(raw) as WorkspaceScanTask : undefined;
  }

  async overview(limit?: number): Promise<SupplyChainOverview> {
    if (!this.enabled) {
      return {
        enabled: false,
        runtimeCorrelationEnabled: false,
        workspaces: 0,
        activeSnapshots: 0,
        openFindings: 0,
        staleFindings: 0,
        findings: [],
      };
    }
    return {
      ...await this.store.overview(limit),
      runtimeCorrelationEnabled: process.env.ANYSENTRY_SUPPLY_CHAIN_RUNTIME === 'on'
        && process.env.ANYSENTRY_STREAMING === 'on',
    };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.installTimer) clearInterval(this.installTimer);
    await Promise.all([
      this.assessmentQueue?.close(),
      this.redis?.quit(),
      this.store.close(),
    ]);
  }
}
