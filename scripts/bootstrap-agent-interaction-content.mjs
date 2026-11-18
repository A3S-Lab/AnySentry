#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const output = path.resolve(
  process.env.ANYSENTRY_INTERACTION_CONTENT_ENV_FILE
    ?? '.local/interaction-content.env',
);
const force = process.argv.includes('--force');

if (fs.existsSync(output) && !force) {
  const mode = fs.statSync(output).mode & 0o777;
  if (mode !== 0o600) fs.chmodSync(output, 0o600);
  console.log(
    `Existing Interaction content credentials preserved at ${output}; pass --force to rotate them.`,
  );
  process.exit(0);
}

const parent = path.dirname(output);
fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
fs.chmodSync(parent, 0o700);

const adminToken = `anadm_${randomBytes(32).toString('base64url')}`;
const rawViewToken = `anraw_${randomBytes(32).toString('base64url')}`;
const contentKey = randomBytes(32).toString('base64');
const serialized = [
  '# Generated local/isolated Interaction content credentials. Never commit this file.',
  `ANYSENTRY_ADMIN_TOKEN=${adminToken}`,
  'ANYSENTRY_INTERACTION_CONTENTS=on',
  'ANYSENTRY_INTERACTION_CONTENT_CAPTURE_MODE=local_runtime',
  'ANYSENTRY_INTERACTION_CONTENT_KEY_TENANT=tenant_default',
  'ANYSENTRY_INTERACTION_CONTENT_KEY_VERSION=v1',
  `ANYSENTRY_INTERACTION_CONTENT_KEY=${contentKey}`,
  'ANYSENTRY_INTERACTION_RAW_VIEW=on',
  `ANYSENTRY_INTERACTION_RAW_VIEW_TOKEN=${rawViewToken}`,
  '',
].join('\n');
const temporary = `${output}.tmp-${process.pid}`;
fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' });
fs.renameSync(temporary, output);
fs.chmodSync(output, 0o600);
console.log(`Interaction content credentials written to ${output} (mode 0600).`);
console.log(
  'The management and independent Raw View tokens remain only in that local file.',
);
