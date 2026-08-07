import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { redisConnection } from './judgment-queue.service';
import { assessDependencySnapshot } from './supply-chain-assessment';
import { SupplyChainStore } from './supply-chain-store';
import {
  buildSupplyChainRuntimeContext,
  SupplyChainRuntimePublisher,
} from './supply-chain-runtime';
import {
  SUPPLY_CHAIN_ASSESSMENT_QUEUE,
  SUPPLY_CHAIN_ASSESSMENT_WORKER_HEARTBEAT_KEY,
  SupplyChainAssessmentJob,
} from './supply-chain.types';

const connection = redisConnection();
const store = new SupplyChainStore();
const runtimePublisher = new SupplyChainRuntimePublisher();
const queue = new Queue<SupplyChainAssessmentJob>(SUPPLY_CHAIN_ASSESSMENT_QUEUE, { connection });
const heartbeatRedis = new IORedis(
  process.env.ANYSENTRY_REDIS_URL || 'redis://redis:6379/0',
  { maxRetriesPerRequest: null },
);
const refreshIntervalMs = Math.max(
  60 * 60_000,
  Number(process.env.ANYSENTRY_OSV_REFRESH_INTERVAL_MS || 24 * 60 * 60_000),
);
let closing = false;
let refreshTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;

async function heartbeat(): Promise<void> {
  await heartbeatRedis.set(
    SUPPLY_CHAIN_ASSESSMENT_WORKER_HEARTBEAT_KEY,
    String(Date.now()),
    'PX',
    20_000,
  );
}

async function enqueueDueAssessments(): Promise<void> {
  const control = await store.loadControl();
  if (!control?.enabled || !control.dailyRefreshEnabled) return;
  const now = Date.now();
  for (const snapshot of await store.activeSnapshots()) {
    if (control.selectedWorkspaceIds.length > 0
      && !control.selectedWorkspaceIds.includes(snapshot.workspaceId)) continue;
    const latest = await store.latestAssessmentAt(snapshot.dependencySnapshotId);
    if (latest && now - latest < refreshIntervalMs) continue;
    await queue.add('assess-dependency-snapshot', {
      schemaVersion: 'anysentry.supply_chain_assessment_job.v1',
      jobId: `refresh-${snapshot.dependencySnapshotId}-${new Date(now).toISOString().slice(0, 10)}`,
      workspaceId: snapshot.workspaceId,
      dependencySnapshotId: snapshot.dependencySnapshotId,
      reason: 'intelligence_refresh',
      queuedAt: now,
    }, {
      jobId: `${snapshot.dependencySnapshotId}-${new Date(now).toISOString().slice(0, 10)}`,
      attempts: 4,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 50_000 },
      removeOnFail: { age: 30 * 24 * 60 * 60, count: 100_000 },
    });
  }
}

async function start(): Promise<void> {
  if (!(await store.init())) throw new Error('supply-chain ClickHouse store is unavailable');
  await runtimePublisher.connect();
  const worker = new Worker<SupplyChainAssessmentJob>(
    SUPPLY_CHAIN_ASSESSMENT_QUEUE,
    async (job) => {
      const control = await store.loadControl();
      if (!control?.enabled) {
        console.log('[supply-chain] assessment skipped because scanning is disabled', {
          jobId: job.id,
          workspaceId: job.data.workspaceId,
        });
        return;
      }
      if (control.selectedWorkspaceIds.length > 0
        && !control.selectedWorkspaceIds.includes(job.data.workspaceId)) {
        console.log('[supply-chain] assessment skipped for an unselected Workspace', {
          jobId: job.id,
          workspaceId: job.data.workspaceId,
        });
        return;
      }
      const snapshot = await store.snapshot(job.data.dependencySnapshotId);
      if (!snapshot) throw new Error('dependency snapshot does not exist');
      if (snapshot.snapshotExtractionStatus !== 'complete') {
        throw new Error('only complete dependency snapshots may be assessed');
      }
      const assessment = await assessDependencySnapshot(snapshot);
      await store.insertAssessment(assessment);
      if (assessment.assessmentStatus === 'complete' && control.runtimeCorrelationEnabled) {
        const workspace = await store.workspace(assessment.workspaceId);
        if (!workspace?.workspacePathFingerprint) {
          throw new Error('workspace path fingerprint is missing; restart its Workspace Scanner');
        }
        await runtimePublisher.publish(buildSupplyChainRuntimeContext(workspace, assessment));
      }
      console.log('[supply-chain] assessment completed', {
        workspaceId: assessment.workspaceId,
        dependencySnapshotId: assessment.dependencySnapshotId,
        vulnerabilityAssessmentId: assessment.vulnerabilityAssessmentId,
        status: assessment.assessmentStatus,
        components: assessment.plannedComponentCount,
        findings: assessment.findings.length,
        failures: assessment.failedComponentCount,
      });
    },
    {
      connection,
      concurrency: Math.max(1, Number(process.env.ANYSENTRY_SUPPLY_CHAIN_ASSESSMENT_CONCURRENCY || 2)),
    },
  );
  worker.on('failed', (job, error) => {
    console.error('[supply-chain] assessment failed', {
      jobId: job?.id,
      dependencySnapshotId: job?.data.dependencySnapshotId,
      error: error.message.split('\n')[0].slice(0, 500),
    });
  });
  await enqueueDueAssessments();
  await heartbeat();
  heartbeatTimer = setInterval(() => {
    void heartbeat().catch((error) => {
      if (!closing) console.error('[supply-chain] worker heartbeat failed', error instanceof Error ? error.message : String(error));
    });
  }, 5_000);
  heartbeatTimer.unref();
  refreshTimer = setInterval(() => {
    void enqueueDueAssessments().catch((error) => {
      if (!closing) console.error('[supply-chain] refresh scheduling failed', error instanceof Error ? error.message : String(error));
    });
  }, Math.min(refreshIntervalMs, 60 * 60_000));
  console.log('AnySentry supply-chain assessment worker started');

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    if (refreshTimer) clearInterval(refreshTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await Promise.all([
      worker.close(),
      queue.close(),
      store.close(),
      runtimePublisher.close(),
      heartbeatRedis.quit(),
    ]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void start().catch(async (error) => {
  console.error('[supply-chain] worker failed to start', error instanceof Error ? error.stack : String(error));
  await Promise.allSettled([
    queue.close(),
    store.close(),
    runtimePublisher.close(),
    heartbeatRedis.quit(),
  ]);
  process.exit(1);
});
