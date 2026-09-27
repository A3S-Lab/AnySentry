#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { QueryClient } = webRequire("@tanstack/react-query");
const { Virtualizer } = webRequire("@tanstack/react-virtual");

async function initialAssetBytes() {
  const dist = path.join(root, "apps/web/dist");
  const html = await readFile(path.join(dist, "index.html"), "utf8");
  const assetPaths = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/gu)]
    .map((match) => match[1])
    .filter((asset) => asset.endsWith(".js"));

  let raw = 0;
  let gzip = 0;
  for (const asset of assetPaths) {
    const file = path.join(dist, asset.replace(/^\/+/u, ""));
    const bytes = await readFile(file);
    raw += bytes.byteLength;
    gzip += gzipSync(bytes).byteLength;
  }
  return { assets: assetPaths.length, raw, gzip };
}

async function allJavaScriptBytes() {
  const jsRoot = path.join(root, "apps/web/dist/static/js");
  const pending = [jsRoot];
  let bytes = 0;
  let files = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        bytes += (await stat(target)).size;
        files += 1;
      }
    }
  }
  return { files, bytes };
}

async function verifyQueryDeduplication() {
  const client = new QueryClient();
  let calls = 0;
  const fetchShared = () => client.fetchQuery({
    queryKey: ["performance-contract", "shared"],
    staleTime: 5_000,
    queryFn: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "ok";
    },
  });
  await Promise.all([fetchShared(), fetchShared(), fetchShared()]);
  client.clear();
  assert.equal(calls, 1, "same-key concurrent queries must share one request");
  return { callers: 3, networkCalls: calls, avoidedCalls: 3 - calls };
}

function verifyVirtualWindow() {
  const scrollElement = {
    scrollHeight: 19_000,
    scrollWidth: 800,
    scrollTop: 0,
    scrollLeft: 0,
  };
  const virtualizer = new Virtualizer({
    count: 250,
    getScrollElement: () => scrollElement,
    estimateSize: () => 76,
    getItemKey: (index) => `row-${index}`,
    overscan: 8,
    scrollToFn: () => {},
    observeElementRect: (_instance, callback) => {
      callback({ width: 800, height: 600 });
      return () => {};
    },
    observeElementOffset: (_instance, callback) => {
      callback(0, true);
      return () => {};
    },
  });
  virtualizer._willUpdate();
  const renderedRows = virtualizer.getVirtualItems().length;
  assert.ok(renderedRows > 0 && renderedRows <= 24, `expected <=24 rendered rows, received ${renderedRows}`);
  return {
    totalRows: 250,
    renderedRows,
    avoidedDomRows: 250 - renderedRows,
    reduction: Number(((1 - renderedRows / 250) * 100).toFixed(1)),
  };
}

async function verifySourceContracts() {
  const router = await readFile(path.join(root, "apps/web/src/router.tsx"), "utf8");
  const loaders = await readFile(path.join(root, "apps/web/src/lib/performance/route-loaders.ts"), "utf8");
  const adaptiveList = await readFile(path.join(root, "apps/web/src/components/performance/adaptive-virtual-list.tsx"), "utf8");
  const eagerPageImports = [...router.matchAll(/from "@\/pages\//gu)].length;
  const lazyPageImports = [...loaders.matchAll(/import\("@\/pages\//gu)].length;
  assert.equal(eagerPageImports, 1, "only the primary dashboard should remain eagerly imported");
  assert.ok(lazyPageImports >= 20, "secondary pages should be split into lazy chunks");
  assert.match(adaptiveList, /items\.length >= threshold/u);
  return { eagerPageImports, lazyPageImports };
}

const initial = await initialAssetBytes();
const allJs = await allJavaScriptBytes();
const query = await verifyQueryDeduplication();
const virtual = verifyVirtualWindow();
const source = await verifySourceContracts();

// Baseline captured before this change on 2026-08-24 from the same worktree.
const baseline = {
  initialRawBytes: 3_327_914,
  initialGzipBytes: 885_999,
};
const comparison = {
  initialRawChangePercent: Number((((initial.raw - baseline.initialRawBytes) / baseline.initialRawBytes) * 100).toFixed(1)),
  initialGzipChangePercent: Number((((initial.gzip - baseline.initialGzipBytes) / baseline.initialGzipBytes) * 100).toFixed(1)),
};

assert.ok(initial.raw < baseline.initialRawBytes, "initial JavaScript must be smaller than the captured baseline");
assert.ok(initial.gzip < baseline.initialGzipBytes, "initial gzip JavaScript must be smaller than the captured baseline");

console.log(JSON.stringify({
  baseline,
  after: {
    initial,
    allJavaScript: allJs,
  },
  comparison,
  query,
  virtual,
  source,
}, null, 2));
