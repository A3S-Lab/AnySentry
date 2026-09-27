#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  componentSetDigest,
  dependencySnapshotId,
  normalizeComponents,
  workspacePathFingerprint,
} from '../apps/api/dist/security-monitoring/supply-chain-normalizer.js';
import {
  assessDependencySnapshot,
} from '../apps/api/dist/security-monitoring/supply-chain-assessment.js';
import {
  buildSupplyChainRuntimeContext,
} from '../apps/api/dist/security-monitoring/supply-chain-runtime.js';
import { SupplyChainService } from '../apps/api/dist/security-monitoring/supply-chain.service.js';

const previousRedisUrl = process.env.ANYSENTRY_REDIS_URL;
delete process.env.ANYSENTRY_REDIS_URL;
const disabledService = new SupplyChainService();
let disabledStoreInitCalls = 0;
disabledService.store.init = async () => {
  disabledStoreInitCalls += 1;
  throw new Error('disabled supply-chain must not initialize its ClickHouse store');
};
let disabledInitTimeout;
try {
  await Promise.race([
    disabledService.onModuleInit(),
    new Promise((_, reject) => {
      disabledInitTimeout = setTimeout(() => reject(new Error('disabled supply-chain initialization attempted external I/O')), 500);
    }),
  ]);
  const disabledOverview = await disabledService.overview();
  assert.equal(disabledStoreInitCalls, 0);
  assert.equal(disabledOverview.enabled, false);
  assert.equal(disabledOverview.workspaces, 0);
  const disabledControl = await disabledService.controlConfig();
  assert.equal(disabledControl.readiness.serviceReady, false);
} finally {
  if (disabledInitTimeout) clearTimeout(disabledInitTimeout);
  await disabledService.onModuleDestroy();
  if (previousRedisUrl === undefined) delete process.env.ANYSENTRY_REDIS_URL;
  else process.env.ANYSENTRY_REDIS_URL = previousRedisUrl;
}

const components = normalizeComponents([
  {
    relativeSourcePath: 'pnpm-lock.yaml',
    ecosystem: 'npm',
    packageName: 'safe-package',
    version: '1.0.0',
    dependencyScope: 'runtime',
    direct: true,
  },
  {
    relativeSourcePath: 'Cargo.lock',
    ecosystem: 'crates.io',
    packageName: 'vulnerable-crate',
    version: '0.1.0',
    dependencyScope: 'runtime',
    direct: false,
  },
]);
assert.equal(components.length, 2);
assert.equal(
  componentSetDigest(components),
  componentSetDigest([...components].reverse()),
  'component digest must be independent of scanner output order',
);
assert.notEqual(
  dependencySnapshotId('wsp-test', componentSetDigest(components), 'policy-v1'),
  dependencySnapshotId('wsp-test', componentSetDigest(components), 'policy-v2'),
  'extraction semantics must participate in dependencySnapshotId',
);
assert.throws(() => normalizeComponents([{
  ...components[0],
  relativeSourcePath: '../outside/lockfile',
}]), /safe relative path/);
assert.match(workspacePathFingerprint('/workspace/project'), /^sha256:[a-f0-9]{64}$/);

const server = http.createServer(async (request, response) => {
  if (request.url === '/v1/querybatch' && request.method === 'POST') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (input.queries.some((query) => query.package.name === 'failure-package')) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'synthetic partial outage' }));
      return;
    }
    const results = input.queries.map((query) => query.package.name === 'vulnerable-crate'
      ? { vulns: [
          { id: 'OSV-TEST-1', modified: '2026-07-29T00:00:00Z' },
          { id: 'GHSA-TEST-0001', modified: '2026-07-29T00:00:00Z' },
        ] }
      : {});
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ results }));
    return;
  }
  if (request.url === '/v1/vulns/OSV-TEST-1') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'OSV-TEST-1',
      modified: '2026-07-29T00:00:00Z',
      aliases: ['CVE-2026-0001'],
      summary: 'Synthetic verifier advisory',
      database_specific: { severity: 'HIGH' },
      severity: [{
        type: 'CVSS_V3',
        score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      }],
      affected: [{
        package: { ecosystem: 'crates.io', name: 'vulnerable-crate' },
        ranges: [{
          type: 'SEMVER',
          events: [{ introduced: '0' }, { fixed: '0.2.0' }],
        }],
      }],
    }));
    return;
  }
  if (request.url === '/v1/vulns/GHSA-TEST-0001') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'GHSA-TEST-0001',
      modified: '2026-07-29T00:00:00Z',
      aliases: ['CVE-2026-0001'],
      summary: 'The same synthetic verifier advisory from another database',
      affected: [{
        package: { ecosystem: 'crates.io', name: 'vulnerable-crate' },
        ranges: [{
          type: 'SEMVER',
          events: [{ introduced: '0' }, { fixed: '0.2.0' }],
        }],
      }],
    }));
    return;
  }
  response.writeHead(404);
  response.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const address = server.address();
  assert(address && typeof address === 'object');
  const snapshot = {
    schemaVersion: 'anysentry.dependency_snapshot.v1',
    dependencySnapshotId: dependencySnapshotId(
      'wsp-test',
      componentSetDigest(components),
      'policy-v1',
    ),
    componentSetDigest: componentSetDigest(components),
    repositoryId: 'repo-test',
    workspaceId: 'wsp-test',
    scannerId: 'scanner-test',
    extractionPolicyVersion: 'policy-v1',
    scannerName: 'osv-scanner',
    scannerVersion: '2.3.8',
    snapshotExtractionStatus: 'complete',
    components,
    observedChangeAt: 1_785_283_200_000,
    confirmedAt: 1_785_283_201_000,
    warnings: [],
  };
  const assessment = await assessDependencySnapshot(snapshot, {
    apiBase: `http://127.0.0.1:${address.port}`,
    timeoutMs: 5_000,
    assessedAt: 1_785_283_202_000,
  });
  assert.equal(assessment.assessmentStatus, 'complete');
  assert.equal(assessment.plannedComponentCount, 2);
  assert.equal(assessment.successfulComponentCount, 2);
  assert.equal(assessment.failedComponentCount, 0);
  assert.equal(assessment.findings.length, 1);
  assert.equal(assessment.findings[0].vulnerability.id, 'OSV-TEST-1');
  assert.equal(assessment.findings[0].vulnerability.canonicalId, 'CVE-2026-0001');
  assert.deepEqual(
    assessment.findings[0].vulnerability.aliases,
    ['CVE-2026-0001', 'GHSA-TEST-0001'],
  );
  assert.equal(assessment.findings[0].vulnerability.severityLevel, 'high');
  assert.equal(assessment.findings[0].vulnerability.cvssScore, 9.8);
  assert.deepEqual(assessment.findings[0].vulnerability.fixedVersions, ['0.2.0']);
  assert.equal(assessment.findings[0].priority, 'P1');
  assert.equal(assessment.findings[0].priorityScore, 65);
  assert.deepEqual(
    assessment.findings[0].priorityFactors.map((factor) => [factor.code, factor.score]),
    [['severity', 60], ['runtime_scope', 5]],
  );
  assert.equal(assessment.findings[0].deploymentStatus, 'unknown');
  assert.equal(assessment.findings[0].remediation.action, 'upgrade_parent_dependency');
  assert.equal(assessment.findings[0].remediation.candidateFixedVersion, '0.2.0');
  assert.equal(assessment.findings[0].remediation.requiresArtifactRebuild, false);
  assert.equal(assessment.findings[0].shadow, true);
  const runtimeContext = buildSupplyChainRuntimeContext({
    schemaVersion: 'anysentry.workspace_registration.v1',
    repositoryId: 'repo-test',
    workspaceId: 'wsp-test',
    workspacePathFingerprint: workspacePathFingerprint('/workspace/project'),
    scannerId: 'scanner-test',
    displayName: 'test',
    environmentId: 'test',
    sourceId: 'source-test',
    registeredAt: 1_785_283_200_000,
    updatedAt: 1_785_283_200_000,
  }, assessment);
  assert.equal(runtimeContext.schemaVersion, 'anysentry.supply_chain_runtime_context.v1');
  assert.equal(runtimeContext.findings.length, 1);
  assert.equal(runtimeContext.findings[0].vulnerabilityId, 'OSV-TEST-1');

  const partialComponents = normalizeComponents([
    components[0],
    {
      relativeSourcePath: 'package-lock.json',
      ecosystem: 'npm',
      packageName: 'failure-package',
      version: '2.0.0',
      dependencyScope: 'runtime',
      direct: true,
    },
  ]);
  const partialAssessment = await assessDependencySnapshot({
    ...snapshot,
    dependencySnapshotId: dependencySnapshotId(
      'wsp-test',
      componentSetDigest(partialComponents),
      'policy-v1',
    ),
    componentSetDigest: componentSetDigest(partialComponents),
    components: partialComponents,
  }, {
    apiBase: `http://127.0.0.1:${address.port}`,
    timeoutMs: 5_000,
    assessedAt: 1_785_283_203_000,
  });
  assert.equal(partialAssessment.assessmentStatus, 'partial');
  assert.equal(partialAssessment.successfulComponentCount, 1);
  assert.equal(partialAssessment.failedComponentCount, 1);
  assert.equal(partialAssessment.failures[0].component.packageName, 'failure-package');
  assert.match(partialAssessment.failedComponentDigest, /^sha256:/);
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('Supply-chain phase 1 and runtime context verification passed');
