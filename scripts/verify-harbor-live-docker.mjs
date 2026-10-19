// Real Docker bind-mount + host /proc regression. Synthetic sessions only; no models or DB writes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const bench = resolve(repo, '../terminal-bench');
const root = await fs.mkdtemp(join(tmpdir(), 'harbor-live-docker-'));
const containers = [];
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
const writer = String.raw`
import ctypes, json, os, time
from pathlib import Path
from datetime import datetime, timezone
ctypes.CDLL(None).prctl(15, b'codex', 0, 0, 0)
path = Path('/tmp/codex-home/sessions/2026/09/13/rollout-live.jsonl')
path.parent.mkdir(parents=True, exist_ok=True)
with path.open('a', buffering=1) as f:
    for i in range(240):
        now = datetime.now(timezone.utc).isoformat()
        value = {'timestamp': now, 'type': 'session_meta', 'payload': {'id': os.environ['TEST_SESSION'], 'cwd': '/app'}} if i == 0 else {'timestamp': now, 'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'SYNTHETIC LIVE SESSION'}]}}
        f.write(json.dumps(value) + '\n')
        time.sleep(0.25)
`;
const verify = String.raw`
import assert from 'node:assert/strict';
import { LocalRecordTrackingService } from '/repo/apps/api/dist/security-monitoring/local-record-tracking.service.js';
const expected = JSON.parse(process.env.TEST_PIDS);
let bindings = [];
const service = new LocalRecordTrackingService({status: () => ({enabled: false})}, {
  async resolveBinding(candidate, options) {
    assert.notEqual(options.persist, false, 'background must persist exact binding');
    bindings.push(candidate);
    return {bindingId: candidate.nativeSessionId};
  },
  async evidence() {},
});
const entries = (await service.discover()).entries;
assert.equal(entries.length, 2);
assert(entries.every(e => e.fileIdentity));
const index = new Map(entries.map(e => ['codex:' + e.fileIdentity, e]));
for (const [session, pid] of Object.entries(expected)) {
  const match = await service.processCandidate('/proc', pid, new Map(), new Map(), index);
  assert(match, 'real Codex-like process not visible');
  assert.equal(match.recordIds.length, 1, 'live FD did not bind exactly once');
  assert.equal(entries.find(e => e.recordId === match.recordIds[0]).path.includes('/' + session + '/'), true, 'cross-trial inode binding');
}
const list = await service.listRecords({limit: 10});
assert.equal(list.total, 2);
assert(list.items.every(i => i.processStatus === 'running'), JSON.stringify(list.items.map(i => ({session: i.sessionId, status: i.processStatus}))));
await service.activeAttributionInFlight;
assert.equal(bindings.length, 2, 'list must schedule both exact live bindings');
assert.deepEqual(new Set(bindings.map(b => b.nativeSessionId)), new Set(Object.keys(expected)));
console.log('PASS real Docker: two live Session files, same-inode FD binding, trial isolation, background persistence invoked');
`;
try {
  const link = execFileSync(join(bench, '.venv-harbor/bin/python'), ['-c',
    'from scripts.harbor_live_codex import link_command; print(link_command("/tmp/codex-home", "/logs/agent"))'],
    { cwd: bench, encoding: 'utf8' });
  const pids = {};
  for (const session of ['trial-a', 'trial-b']) {
    const name = `harbor-live-${session}-${root.split('-').at(-1).toLowerCase()}`;
    const logs = join(root, 'job', session, 'agent');
    await fs.mkdir(logs, { recursive: true });
    containers.push(name);
    docker('run', '-d', '--rm', '--pull=never', '--name', name, '--network=none', '--memory=128m',
      '--user', `${process.getuid()}:${process.getgid()}`,
      '-v', `${logs}:/logs/agent`, '-e', `TEST_SESSION=${session}`, 'python:3.12-slim',
      'bash', '-c', 'mkdir -p /tmp/codex-home\n' + link + '\nexec python3 -u -c "$1"', 'synthetic', writer);
    pids[session] = Number(docker('inspect', name, '--format', '{{.State.Pid}}'));
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await Promise.all(Object.keys(pids).map(s => fs.stat(join(root, 'job', s, 'agent/sessions/2026/09/13/rollout-live.jsonl')).then(d => d.size > 100).catch(() => false)))).every(Boolean)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  for (let round = 1; round <= 3; round++) {
    const output = docker('run', '--rm', '--pull=never', '--privileged', '--pid=host', '--network=none', '--memory=512m',
      '-v', `${repo}:/repo:ro`, '-v', `${root}:/fixture:ro`, '-v', `${process.execPath}:/node:ro`,
      '-e', `TEST_PIDS=${JSON.stringify(pids)}`, '-e', 'ANYSENTRY_LOCAL_RECORD_TRACKING=on',
      '-e', 'ANYSENTRY_LOCAL_PROCESS_TRACKING=on', '-e', 'ANYSENTRY_LOCAL_HARBOR_JOBS_DIR=/fixture',
      '-e', 'ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR=/missing', '-e', 'ANYSENTRY_SESSION_ATTRIBUTION_BACKGROUND=on',
      'ubuntu:24.04', '/node', '--input-type=module', '-e', verify);
    console.log(`Round ${round}: ${output}`);
  }
  for (const name of containers) docker('stop', '-t', '1', name);
  containers.length = 0;
  for (const session of Object.keys(pids)) {
    const text = await fs.readFile(join(root, 'job', session, 'agent/sessions/2026/09/13/rollout-live.jsonl'), 'utf8');
    assert(text.split('\n').length > 2, 'archive missing after container exit');
  }
  console.log('PASS real Docker: archived sessions survive writer/container exit');
} finally {
  for (const name of containers) {
    try { docker('stop', '-t', '1', name); } catch { /* already removed */ }
  }
  await fs.rm(root, { recursive: true, force: true });
}
