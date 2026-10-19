// Two filesystem views of one Session inode; same filename is not ownership evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRecordTrackingService } from '../apps/api/dist/security-monitoring/local-record-tracking.service.js';

const root = await fs.mkdtemp(join(tmpdir(), 'harbor-live-fd-'));
try {
  const proc = join(root, 'proc');
  const pid = 4243;
  const dir = join(proc, String(pid));
  await fs.mkdir(join(dir, 'fd'), { recursive: true });
  await fs.mkdir(join(dir, 'fdinfo'), { recursive: true });
  await fs.writeFile(join(dir, 'comm'), 'codex\n');
  await fs.writeFile(join(dir, 'cmdline'), '/usr/local/bin/codex\0exec\0');
  await fs.writeFile(join(dir, 'stat'), `${pid} (codex) ${['S', '1', ...Array(17).fill('0'), '1001'].join(' ')}\n`);
  const archived = join(root, 'job/trial/agent/sessions/rollout-test.jsonl');
  const live = join(root, 'container-view/sessions/rollout-test.jsonl');
  await fs.mkdir(join(root, 'job/trial/agent/sessions'), { recursive: true });
  await fs.mkdir(join(root, 'container-view/sessions'), { recursive: true });
  await fs.writeFile(archived, '{}\n');
  await fs.link(archived, live);
  const details = await fs.stat(archived, { bigint: true });
  const identity = `${details.dev}:${details.ino}`;
  const entry = { recordId: 'trial-a', adapter: 'codex', path: archived, fileIdentity: identity };
  const byInode = new Map([[`codex:${identity}`, entry]]);
  const fd = join(dir, 'fd/7');
  await fs.symlink(live, fd);
  const scan = () => new LocalRecordTrackingService().processCandidate(proc, pid, new Map(), new Map(), byInode);
  for (let round = 1; round <= 3; round++) {
    await fs.writeFile(join(dir, 'fdinfo/7'), 'flags:\t0102001\n');
    assert.deepEqual((await scan()).recordIds, ['trial-a']);
    await fs.appendFile(live, '{}\n');
    assert.equal((await fs.stat(archived, { bigint: true })).ino, details.ino);
    await fs.writeFile(join(dir, 'fdinfo/7'), 'flags:\t0100000\n');
    assert.deepEqual((await scan()).recordIds, [], 'read-only transcript reader is not owner');
    await fs.writeFile(join(dir, 'fdinfo/7'), 'flags:\t0102001\n');
    byInode.set(`codex:${identity}`, null);
    assert.deepEqual((await scan()).recordIds, [], 'ambiguous inode alias must not be assigned');
    const exactPath = new Map([[`codex:${live}`, entry]]);
    assert.deepEqual((await new LocalRecordTrackingService().processCandidate(proc, pid, exactPath, new Map(), byInode)).recordIds, [],
      'ambiguous Harbor inode must not fall back to an exact path');
    byInode.set(`codex:${identity}`, entry);
    console.log(`PASS round ${round}: namespace path differs, same writable inode binds; readonly/ambiguous rejected`);
  }
  await fs.unlink(live);
  await fs.writeFile(live, '{}\n');
  assert.deepEqual((await scan()).recordIds, [], 'same basename with different inode cannot bind');
  await fs.unlink(live);
  await fs.link(archived, live);
  await fs.rename(archived, `${archived}.old`);
  await fs.writeFile(archived, '{}\n');
  assert.deepEqual((await scan()).recordIds, [], 'replaced archive inode invalidates cached ownership');
  console.log('PASS: parallel-file isolation and file replacement race');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
