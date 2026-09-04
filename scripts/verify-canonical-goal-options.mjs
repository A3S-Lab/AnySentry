#!/usr/bin/env node

/**
 * Static, no-network contract check for the canonical-goal verifier options.
 *
 * The CLI probe is intentionally kept separate from this check: importing the verifier would
 * execute its read-only environment probes. Reading the source lets CI verify that an explicit
 * --api-base reaches host and Docker probes while the existing environment-variable overrides
 * remain authoritative.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const verifierPath = fileURLToPath(new URL('./verify-canonical-goal.mjs', import.meta.url));
const source = await readFile(verifierPath, 'utf8');

assert.match(source, /function inspectHost\(apiBase\s*=\s*['"]http:\/\/127\.0\.0\.1:29653\/security-center['"]\)/u,
  'host probe accepts the CLI API base with the legacy default');
assert.match(source, /function inspectDocker\(apiBase\s*=\s*['"]http:\/\/127\.0\.0\.1:29653\/security-center['"]\)/u,
  'Docker probe accepts the CLI API base with the legacy default');
assert.match(source, /process\.env\.ANYSENTRY_API_BASE\s*\|\|\s*apiBase/u,
  'ANYSENTRY_API_BASE remains the host override');
assert.match(source, /process\.env\.ANYSENTRY_DOCKER_API_BASE\s*\|\|\s*apiBase/u,
  'ANYSENTRY_DOCKER_API_BASE remains the Docker override');
assert.match(source, /inspectHost\(options\.apiBase\)/u,
  'main passes the parsed API base to the host probe');
assert.match(source, /inspectDocker\(options\.apiBase\)/u,
  'main passes the parsed API base to the Docker probe');

console.log('Canonical-goal verifier option propagation static check passed (no network).');
