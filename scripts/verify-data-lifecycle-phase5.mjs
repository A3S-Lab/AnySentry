import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [store, metadata, moduleSource, controller, compose, apiPackage, deployment, deploymentDocs] = await Promise.all([
  read('apps/api/src/security-monitoring/relational-business-store.service.ts'),
  read('apps/api/src/security-monitoring/agent-metadata.service.ts'),
  read('apps/api/src/security-monitoring/security-monitoring.module.ts'),
  read('apps/api/src/security-monitoring/security-monitoring.controller.ts'),
  read('docker-compose.yml'),
  read('apps/api/package.json'),
  read('deploy/anysentry.yaml'),
  read('deploy/README.md'),
]);

assert.match(store, /class RelationalBusinessStore/);
assert.match(store, /CREATE TABLE IF NOT EXISTS anysentry_agent_metadata/);
assert.match(store, /agent_asset_id TEXT PRIMARY KEY/);
assert.match(store, /record JSONB NOT NULL/);
assert.match(store, /ON CONFLICT \(agent_asset_id\) DO UPDATE/);
assert.match(store, /DELETE FROM anysentry_agent_metadata/);
assert.match(store, /agent_asset_id = ANY\(\$1::text\[\]\)/);
assert.match(store, /AND updated_at <= \$3/);
assert.ok(
  store.indexOf('ON CONFLICT (agent_asset_id) DO UPDATE') <
    store.indexOf('DELETE FROM anysentry_agent_metadata'),
  'canonical upsert must precede alias cleanup',
);
assert.match(
  store,
  /WHERE EXCLUDED\.updated_at >= anysentry_agent_metadata\.updated_at/,
  'an older replica must not overwrite a newer review',
);
assert.match(store, /using migration fallback/);

assert.match(metadata, /private readonly relational: RelationalBusinessStore/);
assert.match(metadata, /this\.relational\.loadAgentMetadata\(\)/);
assert.match(metadata, /this\.relational\.saveAgentMetadata\(canonicalRecords\)/);
assert.match(metadata, /this\.relational\.saveAgentMetadata\(dirtyRecords\)/);
assert.match(metadata, /RELATIONAL_REFRESH_MS = 15_000/);
assert.match(metadata, /this\.ch\.saveAgentMetadata\(records\)/);

assert.match(moduleSource, /RelationalBusinessStore/);
assert.match(controller, /postgresqlConfigured: this\.relational\.configured\(\)/);
assert.match(controller, /postgresqlReady: this\.relational\.isReady\(\)/);
assert.match(compose, /\n  postgres:\n/);
assert.match(compose, /image: postgres:17-alpine/);
assert.match(compose, /ANYSENTRY_DATABASE_URL:/);
assert.match(compose, /postgres-data:\/var\/lib\/postgresql\/data/);
assert.match(apiPackage, /"pg":/);
assert.match(deployment, /name: ANYSENTRY_DATABASE_URL/);
assert.match(deployment, /name: anysentry-database/);
assert.match(deployment, /optional: true/);
const anySentryDeployment = deployment.match(
  /kind: Deployment\nmetadata:\n  name: anysentry[\s\S]*?(?=\n---\n)/,
)?.[0] ?? '';
assert.match(anySentryDeployment, /name: ANYSENTRY_DATABASE_URL/);
assert.match(anySentryDeployment, /name: anysentry-database/);
assert.match(deploymentDocs, /PostgreSQL for mutable business state/);
assert.match(deploymentDocs, /healthz\.businessState\.postgresqlReady/);

console.log('Data lifecycle Phase 5 verification passed');
