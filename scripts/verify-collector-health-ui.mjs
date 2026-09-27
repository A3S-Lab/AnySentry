#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../apps/web/src/pages/CollectorsPage.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../apps/web/src/lib/api/security-center.ts', import.meta.url), 'utf8');

assert.match(api, /healthChannels:\s*\{[\s\S]*capture:[\s\S]*delivery:[\s\S]*control:/u);
assert.match(page, /当前链路状态/u);
assert.match(page, /eBPF → Ring → Collector/u);
assert.match(page, /Forwarder → WAL → API/u);
assert.match(page, /Identity → Rules → Runtime Snapshot/u);
assert.match(page, /所选时间范围只影响下方历史统计/u);
assert.match(page, /当前永久丢失/u);
assert.match(page, /所选窗口 Drop 峰值/u);
assert.match(page, /summary\.warningCollectors/u);

console.log('Collector channel health UI contract verification passed');
