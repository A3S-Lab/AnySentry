import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [
  store,
  directory,
  moduleSource,
  controller,
  aggregation,
  supplyChain,
  types,
  webTypes,
] = await Promise.all([
  read('apps/api/src/security-monitoring/relational-business-store.service.ts'),
  read('apps/api/src/security-monitoring/workspace-directory.service.ts'),
  read('apps/api/src/security-monitoring/security-monitoring.module.ts'),
  read('apps/api/src/security-monitoring/security-monitoring.controller.ts'),
  read('apps/api/src/security-monitoring/aggregation.service.ts'),
  read('apps/api/src/security-monitoring/supply-chain.service.ts'),
  read('apps/api/src/security-monitoring/types.ts'),
  read('apps/web/src/lib/api/security-center.ts'),
]);

assert.match(store, /CREATE TABLE IF NOT EXISTS anysentry_workspace_directory/);
assert.match(store, /workspace_id TEXT PRIMARY KEY/);
assert.match(store, /workspace_path_fingerprint TEXT NOT NULL/);
assert.match(store, /CREATE TABLE IF NOT EXISTS anysentry_agent_workspace_bindings/);
assert.match(store, /valid_from BIGINT NOT NULL/);
assert.match(store, /valid_to BIGINT/);
assert.match(store, /WHERE valid_to IS NULL/);
assert.match(store, /ON CONFLICT \(workspace_id\) DO UPDATE/);
assert.match(store, /ON CONFLICT \(binding_id\) DO UPDATE/);
assert.match(store, /loadWorkspaceDirectory/);
assert.match(store, /loadAgentWorkspaceBindings/);
assert.match(store, /await client\.query\('BEGIN'\)/);
assert.match(store, /await client\.query\('COMMIT'\)/);
assert.match(store, /await client\.query\('ROLLBACK'\)/);

assert.match(directory, /class WorkspaceDirectoryService/);
assert.match(directory, /resolveWorkspaceId/);
assert.match(directory, /observeEvent/);
assert.match(directory, /registerWorkspace/);
assert.match(directory, /resolved\.effectiveClassification !== 'confirmed_agent'/);
assert.match(directory, /resolved\.effectiveClassification !== 'probable_agent'/);
assert.match(directory, /agent\.reviewDecision !== 'confirmed_agent'/);
assert.match(directory, /activeBindingByAgent/);
assert.match(directory, /validTo: Math\.max\(active\.validFrom, observedAt - 1\)/);
assert.match(directory, /A late event must not replace the current association/);
assert.match(directory, /this\.relational\.saveWorkspaceDirectory\(workspaces\)/);
assert.match(directory, /this\.relational\.saveAgentWorkspaceBindings\(bindings\)/);
assert.match(directory, /postgresqlBacked: this\.relational\.isReady\(\)/);

assert.match(moduleSource, /WorkspaceDirectoryService/);
assert.match(controller, /this\.workspaceDirectory\.observeEvent\(event\)/);
assert.match(controller, /@Get\('workspaces\/directory'\)/);
assert.match(controller, /@Get\('workspaces\/bindings'\)/);
assert.match(controller, /workspaceDirectory: this\.workspaceDirectory\.status\(\)/);
assert.equal(
  (controller.match(/this\.observeWorkspaceAssociation\(rec\)/g) ?? []).length,
  2,
  'both universal and Observer ingestion paths must project Workspace membership',
);

assert.match(supplyChain, /private readonly workspaceDirectory: WorkspaceDirectoryService/);
assert.match(supplyChain, /this\.workspaceDirectory\.registerWorkspace\(workspace\)/);
assert.match(supplyChain, /const registeredWorkspaces = await this\.store\.registeredWorkspaces\(\)/);
assert.equal(
  (aggregation.match(/workspaceId: this\.workspaceDirectory\.resolveWorkspaceId/g) ?? []).length,
  2,
  'both persisted and migration-fallback inventory paths must expose stable workspaceId',
);
assert.match(types, /interface WorkspaceDirectoryRecord/);
assert.match(types, /interface AgentWorkspaceBindingRecord/);
assert.match(types, /interface WorkspaceInventoryItem[\s\S]*workspaceId\?: string/);
assert.match(webTypes, /interface WorkspaceInventoryItem[\s\S]*workspaceId\?: string/);

console.log('Data lifecycle Phase 6 verification passed');
