import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const terminal = new Set(['FINISHED', 'CANCELED', 'FAILED']);
const live = new Set(['INITIALIZING', 'CREATED', 'RUNNING', 'FAILING', 'RESTARTING',
  'CANCELLING', 'CANCELING', 'RECONCILING', 'SUSPENDED']);

export function classifyJobs(body, name) {
  if (!body || !Array.isArray(body.jobs)) throw new Error('invalid jobs overview');
  for (const job of body.jobs) {
    if (!job || typeof job.name !== 'string' || typeof job.state !== 'string') {
      throw new Error('invalid job entry');
    }
  }
  const matches = body.jobs.filter(job => job.name === name);
  if (matches.some(job => !terminal.has(job.state) && !live.has(job.state))) {
    throw new Error('unknown target job state; refusing submission');
  }
  const active = matches.filter(job => live.has(job.state));
  return { absent: active.length === 0, active: active.map(job => ({ id: job.jid, state: job.state })) };
}

// A failed/invalid observation breaks the consecutive-absence proof.
export class AbsenceGate {
  missing = 0;
  observe(result) {
    this.missing = result?.absent ? this.missing + 1 : 0;
    return this.missing >= 2;
  }
}

export async function supervise({ env = process.env, fetcher = fetch, run = execute,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), iterations = Infinity,
  log = console.log } = {}) {
  const manager = env.ANYSENTRY_FLINK_JOBMANAGER || 'flink-jobmanager:8081';
  const name = env.ANYSENTRY_FLINK_JOB_NAME || 'AnySentry Flink Shadow Risk';
  const endpoint = `${manager.includes('://') ? manager : `http://${manager}`}/jobs/overview`;
  const gate = new AbsenceGate();
  const observe = async () => {
    const response = await fetcher(endpoint, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`overview HTTP ${response.status}`);
    return classifyJobs(await response.json(), name);
  };
  for (let i = 0; i < iterations; i++) {
    try {
      const result = await observe();
      if (result.active.length > 1) log('[flink-guard] multiple active jobs; refusing additional submission');
      if (gate.observe(result)) {
        // Recheck immediately before invoking the expensive submission CLI.
        if ((await observe()).absent) {
          const args = ['run', '-d', '-m', manager, '-c',
            env.ANYSENTRY_FLINK_JOB_CLASS || 'org.a3s.anysentry.streaming.AnySentryStreamJob'];
          if (env.ANYSENTRY_FLINK_RESTORE_PATH) args.push('-s', env.ANYSENTRY_FLINK_RESTORE_PATH);
          args.push(env.ANYSENTRY_FLINK_JOB_JAR || '/opt/flink/usrlib/anysentry-flink-streaming.jar');
          log('[flink-guard] confirmed absent; submitting');
          try {
            await run('flink', args, { timeout: 120000, maxBuffer: 1024 * 1024 });
          } finally {
            gate.observe(null);
            // A timed-out CLI may already have submitted successfully. Never retry immediately.
            await wait(60000);
          }
        } else gate.observe(null);
      }
    } catch (error) {
      gate.observe(null);
      log(`[flink-guard] observation/submission unavailable: ${error.message}`);
    }
    if (i + 1 < iterations) await wait(15000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await supervise();
}
