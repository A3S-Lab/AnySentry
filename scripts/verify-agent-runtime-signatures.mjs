#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  RuntimeSignatureRegistry,
  RuntimeSignatureReloader,
  SCHEMA_VERSION,
  canonicalDocument,
  defaultSignatureDocument,
} = require('./observer-agent-runtime-signatures.js');

const registry = new RuntimeSignatureRegistry(defaultSignatureDocument(), { source: 'test' });
for (const [comm, expected] of [
  ['codex', 'codex'],
  ['pi', 'pi'],
  ['Kimi Code', 'kimi-cli'],
  ['gemini', 'gemini-cli'],
  ['claude', 'Claude Code'],
]) {
  const match = registry.match({ comm });
  assert.equal(match?.agentId, expected);
  assert.equal(match?.registryVersion, 1);
  assert.match(match?.registryHash ?? '', /^[a-f0-9]{64}$/);
}
assert.equal(registry.match({ comm: 'node', exe: '/usr/bin/node', argv: 'node server.js' }), undefined);
assert.equal(
  registry.match({ comm: 'node', exe: '/usr/bin/node', argv: 'node prompt mentioning codex' }),
  undefined,
  'untrusted prompt text must not become an Agent signature',
);

assert.throws(
  () => canonicalDocument({
    schemaVersion: SCHEMA_VERSION,
    runtimes: [{ id: 'unsafe', variants: [{ commExact: ['node'] }] }],
  }),
  /generic launcher/,
);
assert.throws(
  () => new RuntimeSignatureRegistry({
    schemaVersion: SCHEMA_VERSION,
    runtimes: [
      { id: 'one', variants: [{ commExact: ['shared-name'] }] },
      { id: 'two', variants: [{ commExact: ['shared-name'] }] },
    ],
  }),
  /conflicts/,
);
assert.throws(
  () => canonicalDocument({
    schemaVersion: SCHEMA_VERSION,
    runtimes: [
      { id: 'duplicate', variants: [{ commExact: ['one'] }] },
      { id: 'duplicate', variants: [{ commExact: ['two'] }] },
    ],
  }),
  /duplicated/,
);
assert.throws(
  () => canonicalDocument({ schemaVersion: 'wrong', runtimes: [] }),
  /must use/,
);

const before = registry.metrics();
const invalid = registry.replaceSafely({
  schemaVersion: SCHEMA_VERSION,
  runtimes: [{ id: 'unsafe', variants: [{ exeBasename: ['python3'] }] }],
}, 'invalid-test');
assert.equal(invalid.ok, false);
assert.equal(registry.metrics().hash, before.hash, 'invalid reload must preserve last-known-good');
assert.equal(registry.match({ comm: 'pi' })?.agentId, 'pi');

const dynamic = {
  schemaVersion: SCHEMA_VERSION,
  version: 9,
  runtimes: [{
    id: 'new-agent',
    displayName: 'New Agent',
    variants: [
      { commExact: ['new-agent'] },
      { exeBasename: ['node'], argvPrefix: ['node /opt/new-agent/cli.js'] },
    ],
  }],
};
const replaced = registry.replaceSafely(dynamic, '/tmp/signatures.json');
assert.equal(replaced.ok, true);
assert.equal(replaced.changed, true);
assert.equal(registry.match({ comm: 'new-agent' })?.displayName, 'New Agent');
assert.equal(registry.match({ exe: '/usr/bin/node', argv: 'node /opt/new-agent/cli.js run' })?.agentId, 'new-agent');
assert.equal(registry.match({ comm: 'pi' }), undefined, 'replacement is atomic rather than an implicit merge');
const unchanged = registry.replaceSafely(dynamic, '/tmp/signatures.json');
assert.equal(unchanged.ok, true);
assert.equal(unchanged.changed, false);
assert.equal(registry.metrics().reloads, 1);
assert.equal(registry.metrics().unchanged, 1);

let contents = JSON.stringify(dynamic);
let reloadNotifications = 0;
let errors = 0;
const reloader = new RuntimeSignatureReloader({
  registry,
  filePath: '/tmp/agent-runtime-signatures.json',
  readFile: () => contents,
  watch: () => ({ on() {}, close() {} }),
  onReload: () => { reloadNotifications += 1; },
  onError: () => { errors += 1; },
});
assert.equal(reloader.reload('same').changed, false);
assert.equal(reloadNotifications, 0);

contents = JSON.stringify({
  ...dynamic,
  version: 10,
  runtimes: [{ id: 'hot-agent', displayName: 'Hot Agent', variants: [{ commExact: ['hot-agent'] }] }],
});
assert.equal(reloader.reload('test').changed, true);
assert.equal(reloadNotifications, 1);
assert.equal(registry.match({ comm: 'hot-agent' })?.agentId, 'hot-agent');

contents = '{not-json';
assert.equal(reloader.reload('invalid').ok, false);
assert.equal(errors, 1);
assert.equal(registry.match({ comm: 'hot-agent' })?.agentId, 'hot-agent');
assert.equal(reloader.metrics().reloadAttempts, 3);
assert.equal(reloader.metrics().reloadErrors, 1);
reloader.close();

console.log('Dynamic Agent runtime signature verification passed.');
