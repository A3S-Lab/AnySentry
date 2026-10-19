import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { LocalRecordTrackingService } = require('../apps/api/dist/security-monitoring/local-record-tracking.service.js');
const root = await mkdtemp(join(tmpdir(), 'harbor-discovery-'));
const saved = { ...process.env };
try {
  process.env.ANYSENTRY_LOCAL_RECORD_TRACKING = 'on';
  process.env.ANYSENTRY_LOCAL_PROCESS_TRACKING = 'off';
  process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR = join(root, 'missing');
  process.env.ANYSENTRY_LOCAL_HARBOR_JOBS_DIR = root;
  process.env.ANYSENTRY_LOCAL_A3S_SESSIONS_DIR = join(root, 'missing-a3s');
  process.env.ANYSENTRY_LOCAL_CLAUDE_SESSIONS_DIR = join(root, 'missing-claude');
  const data = [
    { timestamp: '2026-09-09T07:00:00Z', type: 'session_meta', payload: { id: 'harbor-test-session', cwd: '/app' } },
    {
      timestamp: '2026-09-09T07:00:01Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<recommended_plugins>synthetic platform context</recommended_plugins>' }],
      },
    },
    {
      timestamp: '2026-09-09T07:00:02Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Reverse-engineer /app/data/layout.png' }],
      },
    },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
  const dir = join(root, 'job', 'trial', 'agent', 'sessions', '2026', '09', '09');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'rollout-test.jsonl'), data);
  for (const relative of ['job/trial/verifier', 'job/trial/artifacts', 'job/trial/agent/other']) {
    const path = join(root, relative);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'rollout-not-a-session.jsonl'), data);
  }
  await writeFile(join(dir, 'arbitrary.jsonl'), data);
  await symlink(join(dir, 'rollout-test.jsonl'), join(dir, 'rollout-link.jsonl'));
  const service = new LocalRecordTrackingService();
  const discovered = await service.discover();
  assert.equal(discovered.entries.length, 1);
  assert.ok(discovered.entries[0].path.endsWith('rollout-test.jsonl'));
  const records = await service.listRecords({ limit: 10 });
  assert.equal(records.total, 1);
  assert.equal(records.items[0].title, 'Reverse-engineer /app/data/layout.png');
  console.log('PASS: Harbor archives discovered; synthetic context ignored; task title selected');
} finally {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  await rm(root, { recursive: true, force: true });
}
