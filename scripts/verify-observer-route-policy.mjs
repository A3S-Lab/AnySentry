#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const collector = path.resolve(here, '../../Observer/a3s-observer-collector/src/main.rs');
const source = fs.readFileSync(collector, 'utf8');

assert.match(
  source,
  /std::env::var\("A3S_OBSERVER_AGENT_RPC_ROUTES"\)\.unwrap_or_default\(\)/u,
  'agent RPC routes must be an explicit deployment capability with an empty default',
);
assert.doesNotMatch(
  source,
  /A3S_OBSERVER_AGENT_RPC_ROUTES"\)\s*\.unwrap_or_else\(\|_\|\s*"\/runs"/u,
  'the collector must not inject the framework-specific /runs route',
);
assert.doesNotMatch(
  source,
  /configured_agent_rpc\s*=\s*"\/runs"/u,
  'the collector must not assign a framework-specific RPC route directly',
);

console.log('Observer generic RPC route policy verification passed');
