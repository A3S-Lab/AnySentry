#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const forbidden = [
  /(?:^|\/)Snipaste_[^/]*\.(?:png|jpe?g)$/iu,
  /^docs\/agent-llm-observability-validation-[^/]*\.json$/u,
  /^docs\/technical-report\.md$/u,
  /^docs\/technical-report-assets\//u,
  /(?:^|\/)\.DS_Store$/u,
  /(?:^|\/)(?:id_rsa|id_ed25519|credentials|secrets?)$/iu,
  /\.(?:pem|p12|pfx|key)$/iu,
];

const secretPatterns = [
  {
    name: 'private-key-block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  },
  {
    name: 'local-absolute-workspace-path',
    pattern: /\/home\/chensicheng\/a3s\/security\//u,
  },
  {
    name: 'high-confidence-api-key',
    pattern: /\bsk-(?!x{4,}\b)(?!example\b)(?!fixture\b)[A-Za-z0-9_-]{24,}\b/iu,
  },
  {
    name: 'high-confidence-bearer-token',
    pattern: /\bBearer\s+(?!must-not-export\b)(?!example\b)(?!fixture\b)[A-Za-z0-9._~-]{32,}\b/iu,
  },
];

const errors = [];
for (const path of tracked) {
  if (forbidden.some((pattern) => pattern.test(path))) {
    errors.push('forbidden tracked path: ' + path);
    continue;
  }
  let stat;
  try {
    stat = statSync(path);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  for (const { name, pattern } of secretPatterns) {
    if (pattern.test(text)) errors.push(name + ': ' + path);
  }
}

if (errors.length) {
  console.error('repository hygiene verification failed');
  for (const error of errors) console.error('- ' + error);
  process.exit(1);
}

console.log('repository hygiene verification passed (' + tracked.length + ' tracked files)');
