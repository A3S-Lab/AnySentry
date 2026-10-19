#!/usr/bin/env node
/**
 * Live multi-round A3S Code Session→PID probe against host Session tree + /proc.
 * Exercises the rebuilt LocalRecordTrackingService without requiring a Docker API rebuild.
 * eBPF attribution still depends on a live Observer with FileAccess writing ClickHouse.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { LocalRecordTrackingService } = require(
  '../apps/api/dist/security-monitoring/local-record-tracking.service.js',
);

async function main() {
  const ROUNDS = Number(process.env.A3S_LIVE_ROUNDS ?? 3);
  const A3S_BIN = process.env.A3S_BIN ?? '/home/zhongyule/.local/bin/a3s';
  const SESSIONS_DIR = process.env.ANYSENTRY_LOCAL_A3S_SESSIONS_DIR
    ?? '/home/zhongyule/code/.a3s/tui/sessions';
  const WORKSPACE = process.env.A3S_LIVE_WORKSPACE
    ?? await mkdtemp(join(tmpdir(), 'anysentry-a3s-live-'));

  process.env.ANYSENTRY_LOCAL_RECORD_TRACKING = 'on';
  process.env.ANYSENTRY_LOCAL_A3S_SESSIONS_DIR = SESSIONS_DIR;
  process.env.ANYSENTRY_LOCAL_A3S_SESSIONS_HOST_DIR = SESSIONS_DIR;
  process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR = join(tmpdir(), 'missing-codex-live');
  process.env.ANYSENTRY_LOCAL_PROCESS_TRACKING = 'on';
  process.env.ANYSENTRY_LOCAL_PROCESS_ROOT = '/proc';
  process.env.ANYSENTRY_LOCAL_PROCESS_CACHE_MS = '1000';

  await mkdir(WORKSPACE, { recursive: true });

  const sessionAttribution = {
    resolveBinding: async () => undefined,
    resolveBindingFromSessionFile: async () => undefined,
    evidence: async () => undefined,
  };
  const interactions = {
    status: () => ({ enabled: false, projection: { postgresql: false, clickhouse: false } }),
    listObservedLlmRequestsForConversation: async () => [],
  };
  const service = new LocalRecordTrackingService(interactions, sessionAttribution);

  function marker(round) {
    return `ANYSENTRY_A3S_LIVE_ROUND${round}_OK`;
  }

  async function snapshot(label) {
    const list = await service.listRecords({ limit: 300 });
    const a3s = list.items.filter((item) => item.adapter === 'a3s_code');
    const bound = a3s.filter((item) => item.processPid);
    const running = a3s.filter((item) => item.processStatus === 'running');
    return {
      label,
      totalA3s: a3s.length,
      bound: bound.length,
      running: running.length,
      sample: running.slice(0, 8).map((item) => ({
        sessionId: item.sessionId,
        title: (item.title ?? '').slice(0, 100),
        processPid: item.processPid,
        processEvidence: item.processEvidence,
        activityStatus: item.activityStatus,
        updatedAt: item.updatedAt,
      })),
      newest: a3s
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5)
        .map((item) => ({
          sessionId: item.sessionId,
          title: (item.title ?? '').slice(0, 100),
          processPid: item.processPid,
          processStatus: item.processStatus,
          processEvidence: item.processEvidence,
          updatedAt: item.updatedAt,
        })),
    };
  }

  async function runRound(round) {
    const prompt = [
      `这是 AnySentry A3S Code 全链路实测 ROUND${round}。`,
      `不要调用工具。只回复唯一标记 ${marker(round)}。`,
    ].join('');
    const promptFile = join(WORKSPACE, `round-${round}.txt`);
    await writeFile(promptFile, prompt);
    const args = [
      'code',
      'exec',
      '-C', WORKSPACE,
      '-q',
      '--tool-policy', 'read-only',
      '--prompt-file', promptFile,
    ];
    const child = spawn(A3S_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });

    const during = [];
    const pollUntil = Date.now() + 180_000;
    while (Date.now() < pollUntil && child.exitCode === null) {
      during.push(await snapshot(`round${round}-during`));
      if (during.at(-1)?.running > 0) break;
      await sleep(1_200);
    }

    const exitCode = await new Promise((resolve) => {
      child.on('close', resolve);
    });
    await sleep(1_500);
    const after = await snapshot(`round${round}-after`);
    const hay = [
      ...during.flatMap((item) => item.sample.map((row) => row.title ?? '')),
      ...during.flatMap((item) => item.newest.map((row) => row.title ?? '')),
      ...after.newest.map((row) => row.title ?? ''),
      stdout,
    ].join('\n');
    return {
      round,
      exitCode,
      marker: marker(round),
      stdoutTail: stdout.slice(-800),
      stderrTail: stderr.slice(-800),
      duringBound: during.some((item) => item.running > 0),
      duringSamples: during.flatMap((item) => item.sample).slice(0, 8),
      after,
      titleMatched: hay.includes(marker(round)) || hay.includes(`ROUND${round}`),
    };
  }

  const baseline = await snapshot('baseline');
  const rounds = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    rounds.push(await runRound(round));
  }
  const finalSnap = await snapshot('final');
  const pidBindingLikeCodex = rounds.some((item) => item.duringBound)
    || finalSnap.running > 0
    || rounds.some((item) => item.after.bound > baseline.bound);

  const summary = {
    ok: pidBindingLikeCodex,
    workspace: WORKSPACE,
    sessionsDir: SESSIONS_DIR,
    baseline,
    rounds: rounds.map((item) => ({
      round: item.round,
      exitCode: item.exitCode,
      duringBound: item.duringBound,
      titleMatched: item.titleMatched,
      afterNewest: item.after.newest,
      duringSamples: item.duringSamples,
      stdoutTail: item.stdoutTail,
      stderrTail: item.stderrTail,
    })),
    final: finalSnap,
    interpretation: {
      pidBindingLikeCodex,
      note: 'Host /proc FD Session→PID with rebuilt service. eBPF still needs Observer FileAccess → ClickHouse → API attribution.',
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(pidBindingLikeCodex ? 0 : 2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
