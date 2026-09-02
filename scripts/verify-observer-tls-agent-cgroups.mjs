#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  TLS_AGENT_CGROUPS_SCHEMA,
  TlsAgentCgroupPublisher,
  tlsAgentCgroupDocument,
} = require('./observer-tls-agent-cgroups.js');

const snapshot = {
  version: 17,
  generatedAt: '2026-08-30T00:00:00.000Z',
  entries: [
    {
      classification: 'confirmed_agent',
      cgroupId: '14967',
      agentScopeId: 'dify',
      physicalWorkloadId: 'docker:node:agent-one',
    },
    {
      classification: 'confirmed_agent',
      cgroupId: 14967,
      agentScopeId: 'duplicate-must-not-win',
    },
    { classification: 'probable_agent', cgroupId: '20000', agentScopeId: 'probable' },
    {
      classification: 'probable_agent',
      runtimeState: 'running',
      agentInstanceId: 'ari-host-session',
      cgroupId: '27000',
      agentScopeId: 'codex',
    },
    { classification: 'confirmed_agent', cgroupId: '0', agentScopeId: 'invalid-zero' },
    { classification: 'confirmed_agent', cgroupId: 'not-a-number', agentScopeId: 'invalid' },
    { classification: 'confirmed_agent', cgroupId: '25000', agentScopeId: 'codex' },
  ],
};

const document = tlsAgentCgroupDocument(snapshot);
assert.equal(document.schemaVersion, TLS_AGENT_CGROUPS_SCHEMA);
assert.equal(document.version, 17);
assert.deepEqual(document.entries.map((entry) => entry.cgroupId), ['14967', '25000', '27000']);
assert.equal(document.entries[0].agentScopeId, 'dify');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anysentry-tls-cgroups-'));
const file = path.join(directory, 'tls-agent-cgroups.json');
try {
  const publisher = new TlsAgentCgroupPublisher({ file });
  assert.equal(publisher.publish(snapshot), 3);
  assert.equal(publisher.publish(snapshot), 3, 'an identical snapshot is idempotent');
  assert.equal(publisher.metrics().writes, 1);
  assert.equal(publisher.metrics().errors, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), document);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.equal(
    fs.readdirSync(directory).some((entry) => entry.includes('.tmp-')),
    false,
    'atomic publication must not leave a temporary file',
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('Observer TLS Agent cgroup publication verification passed');
