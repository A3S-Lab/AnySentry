#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const {
  RuntimeSignatureRegistry,
  RuntimeSignatureReloader,
  SCHEMA_VERSION,
  canonicalDocument,
  defaultSignatureDocument,
  loadSignatureDocument,
} = require('./observer-agent-runtime-signatures.js');

function signatureDocument(runtimes, version = 1) {
  return { schemaVersion: SCHEMA_VERSION, version, runtimes };
}

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
  assert.match(match?.registryDocumentHash ?? '', /^[a-f0-9]{64}$/);
  assert.match(match?.registryMatcherHash ?? '', /^[a-f0-9]{64}$/);
}
assert.equal(registry.match({ comm: 'node', exe: '/usr/bin/node', argv: 'node server.js' }), undefined);
assert.equal(
  registry.match({ comm: 'node', exe: '/usr/bin/node', argv: 'node prompt mentioning codex' }),
  undefined,
  'untrusted prompt text must not become an Agent signature',
);
assert.equal(
  registry.match({ comm: 'node', argv: '/home/chensicheng/.local/bin/a3s code' })?.agentId,
  'a3s code',
  'the builtin registry is the source of truth for an A3S argv0 path',
);
assert.equal(
  registry.match({ comm: 'claude' })?.agentId,
  'Claude Code',
  'the stable external Claude scope remains backward-compatible',
);

// All possible alternatives must contain an Agent-specific anchor. Adding more generic fields is
// not sufficient, and every argvPrefix alternative is validated independently.
for (const variants of [
  [{ commExact: ['node'] }],
  [{ commExact: ['node'], exeBasename: ['python3'] }],
  [{ commExact: ['node', 'new-agent'], exeBasename: ['node', 'bash'] }],
  [{ argvPrefix: ['node'] }],
  [{ argvPrefix: ['node server.js'] }],
  [{ argvPrefix: ['npx'] }],
  [{ argvPrefix: ['node /opt/new-agent/cli.js', 'python3 worker.py'] }],
]) {
  assert.throws(
    () => canonicalDocument(signatureDocument([{ id: 'new-agent', variants }])),
    /generic launcher|Agent-specific/,
  );
}
assert.throws(
  () => canonicalDocument(signatureDocument([{ id: 'pi', variants: [{ argvPrefix: ['node pipeline.js'] }] }])),
  /Agent-specific/,
  'short runtime IDs must match argv path components, not arbitrary substrings',
);

const genericLauncherBound = new RuntimeSignatureRegistry(signatureDocument([{
  id: 'new-agent',
  displayName: 'New Agent',
  variants: [{ exeBasename: ['node'], argvPrefix: ['node /opt/new-agent/cli.js'] }],
}]));
assert.equal(
  genericLauncherBound.match({ exe: '/usr/bin/node', argv: 'node /opt/new-agent/cli.js run' })?.agentId,
  'new-agent',
);
assert.equal(
  genericLauncherBound.match({ exe: '/usr/bin/node', argv: 'node /opt/other/cli.js run' }),
  undefined,
);

for (const document of [
  signatureDocument([{ id: 42, variants: [{ commExact: ['agent'] }] }]),
  signatureDocument([{ id: 'bad-value', variants: [{ commExact: [42] }] }]),
  signatureDocument([{ id: 'bad-display', displayName: 'bad\nname', variants: [{ commExact: ['agent'] }] }]),
  signatureDocument([{ id: 'bad-scope', agentScopeId: 'bad\u0000scope', variants: [{ commExact: ['agent'] }] }]),
  signatureDocument([{ id: 'bad-enabled', enabled: 'yes', variants: [{ commExact: ['agent'] }] }]),
  { schemaVersion: SCHEMA_VERSION, version: '2', runtimes: [] },
  { schemaVersion: SCHEMA_VERSION, runtimes: [], unexpected: true },
]) {
  assert.throws(() => canonicalDocument(document), /string|invalid|boolean|positive safe integer|unknown fields/);
}

assert.throws(
  () => new RuntimeSignatureRegistry(signatureDocument([
    { id: 'one', variants: [{ commExact: ['shared-name'] }] },
    { id: 'two', variants: [{ commExact: ['shared-name'] }] },
  ])),
  /conflicts/,
);
assert.throws(
  () => new RuntimeSignatureRegistry(signatureDocument([
    { id: 'one', agentScopeId: 'shared-scope', variants: [{ commExact: ['shared-name'] }] },
    { id: 'two', agentScopeId: 'shared-scope', variants: [{ commExact: ['shared-name'] }] },
  ])),
  /conflicts/,
  'sharing a display scope must not hide conflicting runtime registrations',
);
assert.throws(
  () => new RuntimeSignatureRegistry(signatureDocument([
    { id: 'one', variants: [{ commExact: ['shared'], exeBasename: ['shared-bin'] }] },
    { id: 'two', variants: [{ exeBasename: ['shared-bin'], commExact: ['shared'] }] },
  ])),
  /variant conflicts/,
  'semantically identical multi-field variants must not depend on document order',
);
assert.throws(
  () => new RuntimeSignatureRegistry(signatureDocument([
    {
      id: 'one',
      agentScopeId: 'shared-scope',
      variants: [{ commExact: ['shared'], exeBasename: ['shared-bin'] }],
    },
    {
      id: 'two',
      agentScopeId: 'shared-scope',
      variants: [{ exeBasename: ['shared-bin'], commExact: ['shared'] }],
    },
  ])),
  /variant conflicts/,
  'same-scope duplicate predicates must still be rejected',
);
assert.throws(
  () => canonicalDocument(signatureDocument([
    { id: 'duplicate', variants: [{ commExact: ['one'] }] },
    { id: 'duplicate', variants: [{ commExact: ['two'] }] },
  ])),
  /duplicated/,
);
assert.throws(
  () => canonicalDocument({ schemaVersion: 'wrong', runtimes: [] }),
  /must use/,
);
assert.throws(
  () => loadSignatureDocument({
    env: {
      ANYSENTRY_AGENT_RUNTIME_SIGNATURES_JSON: JSON.stringify(signatureDocument([
        { id: 'unsafe-startup', variants: [{ commExact: ['node'] }] },
      ])),
    },
  }),
  /generic launcher/,
  'startup loading validates rules inside the forwarder fallback boundary',
);
assert.equal(
  loadSignatureDocument({
    env: { ANYSENTRY_AGENT_RUNTIME_SIGNATURES_FILE: '/tmp/signatures-buffer.json' },
    readFile: () => Buffer.from(JSON.stringify(signatureDocument([]))),
  }).source,
  '/tmp/signatures-buffer.json',
);

// Partially overlapping variants are allowed to coexist, but a process satisfying both identities
// is explicitly unknown instead of being assigned to whichever rule happened to come first.
const ambiguousRegistry = new RuntimeSignatureRegistry(signatureDocument([
  { id: 'broad-agent', variants: [{ commExact: ['shared-process'] }] },
  {
    id: 'specific-agent',
    variants: [{ commExact: ['shared-process'], exeBasename: ['specific-agent-bin'] }],
  },
]));
assert.equal(
  ambiguousRegistry.match({ comm: 'shared-process', exe: '/opt/specific-agent-bin' }),
  undefined,
);
assert.equal(ambiguousRegistry.metrics().ambiguous, 1);
assert.equal(ambiguousRegistry.metrics().ambiguousCandidates, 2);
assert.equal(ambiguousRegistry.metrics().matches, 0);

assert.throws(
  () => new RuntimeSignatureRegistry(signatureDocument([
    {
      id: 'agent-one',
      variants: [
        { argvPrefix: ['node /opt/agent-one/one.js'] },
        { argvPrefix: ['node /opt/agent-one/two.js'] },
        { argvPrefix: ['node /opt/agent-one/three.js'] },
      ],
    },
  ]), { maxIndexBucketCandidates: 2 }),
  /index bucket.*exceeds 2/,
  'a common interpreter bucket must have a hard candidate bound',
);
assert.throws(
  () => canonicalDocument(signatureDocument([{
    id: 'too-many',
    variants: [
      { commExact: ['one'] },
      { commExact: ['two'] },
      { commExact: ['three'] },
    ],
  }]), { maxTotalVariants: 2 }),
  /total variants/,
);

const before = registry.metrics();
const invalid = registry.replaceSafely(signatureDocument([
  { id: 'unsafe', variants: [{ exeBasename: ['python3'] }] },
]), 'invalid-test');
assert.equal(invalid.ok, false);
assert.equal(registry.metrics().documentHash, before.documentHash, 'invalid reload preserves LKG document');
assert.equal(registry.metrics().matcherHash, before.matcherHash, 'invalid reload preserves LKG matcher');
assert.equal(registry.match({ comm: 'pi' })?.agentId, 'pi');

const dynamic = signatureDocument([{
  id: 'new-agent',
  displayName: 'New Agent',
  variants: [
    { commExact: ['new-agent'] },
    { exeBasename: ['node'], argvPrefix: ['node /opt/new-agent/cli.js'] },
  ],
}], 9);
const replaced = registry.replaceSafely(dynamic, '/tmp/signatures.json');
assert.equal(replaced.ok, true);
assert.equal(replaced.changed, true);
assert.equal(replaced.matcherChanged, true);
assert.equal(registry.match({ comm: 'new-agent' })?.displayName, 'New Agent');
assert.equal(registry.match({ exe: '/usr/bin/node', argv: 'node /opt/new-agent/cli.js run' })?.agentId, 'new-agent');
assert.equal(registry.match({ comm: 'pi' }), undefined, 'replacement is atomic rather than an implicit merge');

const versionOnly = registry.replaceSafely({ ...dynamic, version: 10 }, '/tmp/signatures.json');
assert.equal(versionOnly.changed, true);
assert.equal(versionOnly.matcherChanged, false);
assert.notEqual(versionOnly.documentHash, replaced.documentHash);
assert.equal(versionOnly.matcherHash, replaced.matcherHash);
const unchanged = registry.replaceSafely({ ...dynamic, version: 10 }, '/tmp/signatures.json');
assert.equal(unchanged.ok, true);
assert.equal(unchanged.changed, false);
assert.equal(registry.metrics().reloads, 2);
assert.equal(registry.metrics().documentChanges, 2);
assert.equal(registry.metrics().matcherChanges, 1);
assert.equal(registry.metrics().unchanged, 1);

let contents = JSON.stringify({ ...dynamic, version: 10 });
let statRevision = 1;
let readCalls = 0;
let reloadNotifications = 0;
let callbackThrows = false;
let errors = 0;
const reloader = new RuntimeSignatureReloader({
  registry,
  filePath: '/tmp/agent-runtime-signatures.json',
  readFile: () => {
    readCalls += 1;
    return contents;
  },
  stat: () => ({
    dev: 1,
    ino: 1,
    size: Buffer.byteLength(contents),
    mtimeMs: statRevision,
    ctimeMs: statRevision,
  }),
  watch: () => ({ on() {}, close() {} }),
  onReload: () => {
    reloadNotifications += 1;
    if (callbackThrows) throw new Error('reconciliation failed');
  },
  onError: () => { errors += 1; },
});
assert.equal(reloader.reload('same').changed, false);
assert.equal(reloadNotifications, 0);
assert.equal(readCalls, 1);

assert.equal(reloader.reload('poll').skipped, 'stat');
assert.equal(readCalls, 1, 'unchanged poll stat must skip the file read');
statRevision += 1;
assert.equal(reloader.reload('manual').skipped, 'raw_hash');
assert.equal(readCalls, 2, 'same bytes after a watch/manual event must skip JSON validation by raw hash');

contents = JSON.stringify(signatureDocument([
  { id: 'hot-agent', displayName: 'Hot Agent', variants: [{ commExact: ['hot-agent'] }] },
], 11));
statRevision += 1;
assert.equal(reloader.reload('test').changed, true);
assert.equal(reloadNotifications, 1);
assert.equal(registry.match({ comm: 'hot-agent' })?.agentId, 'hot-agent');

const registryInvalidBeforeFileErrors = registry.metrics().invalid;
contents = '{not-json';
statRevision += 1;
assert.equal(reloader.reload('invalid-json').ok, false);
assert.equal(errors, 1);
assert.equal(registry.metrics().invalid, registryInvalidBeforeFileErrors, 'JSON errors are not registry-invalid');
assert.equal(registry.match({ comm: 'hot-agent' })?.agentId, 'hot-agent');
assert.equal(reloader.reload('poll').skipped, 'stat');
assert.equal(errors, 1, 'an unchanged invalid file is not reparsed or reported repeatedly');

contents = JSON.stringify(signatureDocument([
  { id: 'unsafe-hot', variants: [{ commExact: ['node'], exeBasename: ['python3'] }] },
], 12));
statRevision += 1;
assert.equal(reloader.reload('invalid-registry').ok, false);
assert.equal(errors, 2);
assert.equal(registry.metrics().invalid, registryInvalidBeforeFileErrors + 1);
assert.equal(registry.match({ comm: 'hot-agent' })?.agentId, 'hot-agent', 'registry-invalid reload preserves LKG');

callbackThrows = true;
contents = JSON.stringify(signatureDocument([
  { id: 'callback-agent', variants: [{ commExact: ['callback-agent'] }] },
], 13));
statRevision += 1;
const callbackFailure = reloader.reload('callback-error');
assert.equal(callbackFailure.ok, true, 'the registry reload succeeded even if reconciliation failed');
assert.equal(callbackFailure.callbackOk, false);
assert.equal(registry.match({ comm: 'callback-agent' })?.agentId, 'callback-agent');
assert.equal(errors, 3);
assert.equal(
  registry.metrics().invalid,
  registryInvalidBeforeFileErrors + 1,
  'onReload callback errors are not registry-invalid',
);

const reloadMetrics = reloader.metrics();
assert.equal(reloadMetrics.reloadAttempts, 8);
assert.equal(reloadMetrics.reloadErrors, 3);
assert.equal(reloadMetrics.parseErrors, 1);
assert.equal(reloadMetrics.registryInvalid, 1);
assert.equal(reloadMetrics.callbackErrors, 1);
assert.equal(reloadMetrics.statSkips, 2);
assert.equal(reloadMetrics.rawHashSkips, 1);
assert.match(reloadMetrics.lastGoodRawHash ?? '', /^[a-f0-9]{64}$/);
assert.equal(reloadMetrics.documentHash, registry.documentHash);
assert.equal(reloadMetrics.matcherHash, registry.matcherHash);
reloader.close();

let oversizedReads = 0;
let oversizedRevision = 1;
const oversizedReloader = new RuntimeSignatureReloader({
  registry,
  filePath: '/tmp/oversized-agent-runtime-signatures.json',
  maxFileBytes: 1_024,
  readFile: () => {
    oversizedReads += 1;
    return 'x'.repeat(2_048);
  },
  stat: () => ({ dev: 1, ino: 2, size: 2_048, mtimeMs: oversizedRevision, ctimeMs: oversizedRevision }),
  watch: () => ({ on() {}, close() {} }),
});
assert.equal(oversizedReloader.reload('manual').ok, false);
assert.equal(oversizedReads, 0, 'oversized stat must reject before allocating/reading the file');
assert.equal(oversizedReloader.reload('poll').skipped, 'stat');
assert.equal(oversizedReloader.metrics().fileTooLarge, 1);
assert.equal(oversizedReloader.metrics().reloadErrors, 1);
oversizedRevision += 1;
oversizedReloader.close();

// The indexed matcher must remain proportional to matching buckets, not the configured rule count.
// Each rule below is multi-field, so the former fallback implementation scanned all 4,096 rules.
const largeRuntimes = Array.from({ length: 512 }, (_, runtimeIndex) => ({
  id: `perf-agent-${runtimeIndex}`,
  variants: Array.from({ length: 8 }, (_, variantIndex) => ({
    commExact: [`perf-comm-${runtimeIndex}-${variantIndex}`],
    exeBasename: [`perf-exe-${runtimeIndex}-${variantIndex}`],
  })),
}));
const largeRegistry = new RuntimeSignatureRegistry(signatureDocument(largeRuntimes));
assert.equal(largeRegistry.metrics().indexCandidates, 4_096);
const evaluationsBeforeMisses = largeRegistry.metrics().candidatesEvaluated;
const startedAt = performance.now();
for (let index = 0; index < 25_000; index += 1) {
  assert.equal(largeRegistry.match({
    comm: 'ordinary-process',
    exe: '/usr/bin/ordinary-process',
    argv: 'ordinary-process --serve',
  }), undefined);
}
const missDurationMs = performance.now() - startedAt;
assert.equal(
  largeRegistry.metrics().candidatesEvaluated,
  evaluationsBeforeMisses,
  'an ordinary miss must not inspect any configured candidate',
);
assert.ok(
  missDurationMs < 1_500,
  `25,000 indexed misses exceeded the 1,500ms safety budget (${missDurationMs.toFixed(1)}ms)`,
);
assert.equal(
  largeRegistry.match({ comm: 'perf-comm-100-3', exe: '/opt/perf-exe-100-3' })?.agentId,
  'perf-agent-100',
);
assert.ok(largeRegistry.metrics().maxCandidatesEvaluated <= 1);

console.log(
  `Dynamic Agent runtime signature verification passed (25,000 indexed misses: ` +
  `${missDurationMs.toFixed(1)}ms).`,
);
