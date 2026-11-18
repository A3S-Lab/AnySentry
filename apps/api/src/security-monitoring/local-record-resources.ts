import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ResourceSample { at: number; rssBytes?: number; cpuPercent?: number }
export interface LocalRecordResources {
  recordId: string;
  state: 'observed' | 'unavailable' | 'unbound' | 'shared';
  source: 'host_proc';
  scope: 'session_process';
  pid?: number;
  generation?: string;
  samples: ResourceSample[];
}

/** Linux aggregate excludes guest counters (already included in user/nice). */
export function parseResourceCounters(stat: string, status: string, hostStat: string) {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const ticks = Number(fields[11]) + Number(fields[12]);
  const generation = fields[19];
  const total = hostStat.split('\n').find(line => /^cpu\s/.test(line))?.trim().split(/\s+/).slice(1, 9).map(Number);
  const cpus = hostStat.split('\n').filter(line => /^cpu\d+\s/.test(line)).length;
  const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
  if (!generation || !/^\d+$/.test(generation) || !Number.isFinite(ticks) || ticks < 0
    || !total?.length || !total.every(Number.isFinite) || cpus < 1) throw new Error('Invalid proc counters');
  return { generation, ticks, total: total.reduce((a, b) => a + b, 0), cpus,
    ...(rss ? { rssBytes: Number(rss[1]) * 1024 } : {}) };
}

type Counters = ReturnType<typeof parseResourceCounters>;
export class LocalRecordResourceSampler {
  private histories = new Map<string, { key: string; counters: Counters; samples: ResourceSample[] }>();
  private pending = new Map<string, Promise<LocalRecordResources>>();

  read(recordId: string, root: string, pid: number, generation: string): Promise<LocalRecordResources> {
    const key = `${recordId}:${root}:${pid}:${generation}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const task = this.collect(recordId, root, pid, generation).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  private async collect(recordId: string, root: string, pid: number, generation: string): Promise<LocalRecordResources> {
    const base = { recordId, source: 'host_proc' as const, scope: 'session_process' as const, pid, generation };
    try {
      const path = join(root, String(pid));
      const [stat, status, hostStat] = await Promise.all([
        readFile(join(path, 'stat'), 'utf8'), readFile(join(path, 'status'), 'utf8'), readFile(join(root, 'stat'), 'utf8'),
      ]);
      const current = parseResourceCounters(stat, status, hostStat);
      const after = await readFile(join(path, 'stat'), 'utf8');
      if (current.generation !== generation || parseResourceCounters(after, status, hostStat).generation !== generation) {
        return { ...base, state: 'unbound', samples: [] };
      }
      const key = `${root}:${pid}:${generation}`;
      const previous = this.histories.get(recordId);
      const history = previous?.key === key ? previous : undefined;
      const at = Date.now();
      // Refreshes cannot produce artificially dense samples or unbounded history.
      if (history && at - history.samples.at(-1)!.at < 5_000) {
        return { ...base, state: 'observed', samples: [...history.samples] };
      }
      const elapsed = history ? current.total - history.counters.total : 0;
      const work = history ? current.ticks - history.counters.ticks : -1;
      const cpuPercent = elapsed > 0 && work >= 0 && current.cpus === history?.counters.cpus
        && at - history.samples.at(-1)!.at <= 60_000
        ? work / elapsed * current.cpus * 100 : undefined;
      const samples = [...(history?.samples ?? []), { at, rssBytes: current.rssBytes, cpuPercent }].slice(-240);
      this.histories.delete(recordId);
      this.histories.set(recordId, { key, counters: current, samples });
      while (this.histories.size > 64) this.histories.delete(this.histories.keys().next().value!);
      return { ...base, state: 'observed', samples };
    } catch {
      return { ...base, state: 'unavailable', samples: [] };
    }
  }
}
