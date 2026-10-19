import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRecordTrackingService } from '../apps/api/dist/security-monitoring/local-record-tracking.service.js';

const root = await fs.mkdtemp(join(tmpdir(), 'anysentry-fd-ownership-'));
const pid = 4243;
const directory = join(root, String(pid));
const session = join(root, 'session.jsonl');
const fd = join(directory, 'fd', '7');
const info = join(directory, 'fdinfo', '7');
const originalReadFile = fs.readFile;
const stat = start => `${pid} (codex) ${['S', '1', ...Array(17).fill('0'), String(start)].join(' ')}\n`;
const entry = { adapter: 'codex', recordId: 'session-a', path: session };
const byPath = new Map([[`codex:${session}`, entry]]);
const scan = () => new LocalRecordTrackingService().processCandidate(root, pid, byPath, new Map());
async function reset(flags) {
  fs.readFile = originalReadFile;
  await fs.mkdir(join(directory, 'fd'), { recursive: true });
  await fs.mkdir(join(directory, 'fdinfo'), { recursive: true });
  await fs.writeFile(join(directory, 'comm'), 'codex\n');
  await fs.writeFile(join(directory, 'cmdline'), '/usr/local/bin/codex\0resume\0');
  await fs.writeFile(join(directory, 'stat'), stat(1001));
  await fs.rm(fd, { force: true });
  await fs.symlink(session, fd);
  await fs.rm(info, { force: true });
  if (flags !== undefined) await fs.writeFile(info, flags);
}
let cases = 0;
try {
  await fs.writeFile(session, '{}\n');
  for (const [flags, accepted] of [
    ['flags:\t0100000\n', false], // O_RDONLY
    ['flags:\t0100001\n', true],  // O_WRONLY
    ['flags:\t0102001\n', true],  // O_WRONLY|O_APPEND
    ['flags:\t0100002\n', true],  // O_RDWR
    ['flags:\t010000003\n', false], // O_PATH + invalid access mode
    ['flags:\t010000001\n', false], // O_PATH even with write bit
    ['flags:\tinvalid\n', false],
    ['flags:\t999\n', false],
    ['pos:\t0\n', false],
    [undefined, false],
  ]) {
    await reset(flags);
    const result = await scan();
    assert.equal(result?.recordIds.includes('session-a'), accepted, `flags=${flags}`);
    cases++;
  }
  for (const race of ['pid_reused', 'process_exited', 'exec_changed', 'fd_replaced', 'fdinfo_denied', 'fd_access_changed']) {
    await reset('flags:\t0102001\n');
    fs.readFile = async (path, ...args) => {
      if (path === info) {
        if (race === 'fdinfo_denied') throw Object.assign(new Error('denied'), { code: 'EACCES' });
        const value = await originalReadFile(path, ...args);
        if (race === 'fd_access_changed') await fs.writeFile(info, 'flags:\t0100000\n');
        if (race === 'pid_reused') await fs.writeFile(join(directory, 'stat'), stat(9999));
        if (race === 'process_exited') await fs.rm(join(directory, 'stat'));
        if (race === 'exec_changed') await fs.writeFile(join(directory, 'cmdline'), '/usr/bin/other\0');
        if (race === 'fd_replaced') {
          await fs.rm(fd);
          await fs.symlink(join(root, 'other-session.jsonl'), fd);
        }
        return value;
      }
      return originalReadFile(path, ...args);
    };
    const result = await scan();
    assert.ok(!result?.recordIds.includes('session-a'), race);
    cases++;
  }
  console.log(JSON.stringify({ ok: true, cases, readonlyRejected: true, writableRetained: true,
    missingEvidenceRejected: true, fdAndProcessRacesRejected: true }));
} finally {
  fs.readFile = originalReadFile;
  await fs.rm(root, { recursive: true, force: true });
}
