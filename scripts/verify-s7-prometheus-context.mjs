#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  response.setHeader('content-type', 'application/json');
  if (request.url?.startsWith('/api/v1/targets')) {
    response.end(JSON.stringify({ status: 'success', data: { activeTargets: [{
      labels: { service_name: 'clickhouse', service_namespace: 'anysentry', instance: 'clickhouse:8123' },
      discoveredLabels: {}, scrapeUrl: 'http://clickhouse:9363/metrics', health: 'up',
      lastScrape: new Date(Date.now() - 1_000).toISOString(), lastScrapeDuration: 0.021,
    }] } }));
    return;
  }
  if (request.url?.startsWith('/api/v1/query')) {
    response.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{
      metric: { service_name: 'clickhouse', service_namespace: 'anysentry' },
      value: [Date.now() / 1_000, '12.5'],
    }] } }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ status: 'error' }));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert(address && typeof address === 'object');
process.env.ANYSENTRY_PROMETHEUS_URL = `http://127.0.0.1:${address.port}`;

try {
  const { PrometheusContextService } = await import('../apps/api/dist/security-monitoring/prometheus-context.service.js');
  const service = new PrometheusContextService();
  await service.poll();
  const asset = {
    serviceAssetId: 'service:k8s:test:anysentry:clickhouse', name: 'clickhouse', namespace: 'anysentry',
    clusterId: 'test', kind: 'database', role: 'anysentry_internal', revision: 'revision', images: [],
    replicas: { observed: 1, ready: 1 }, restarts: 0, phaseCounts: { Running: 1 },
    physicalWorkloadIds: [], runtimeInstanceIds: [], endpointAliases: ['clickhouse', 'clickhouse.anysentry.svc'],
    metrics: [], observedAt: Date.now(),
  };
  const facts = service.metricsForAssets([asset]);
  assert(facts.some((fact) => fact.name === 'prometheus.target.up' && fact.value === 1 && fact.status === 'normal'));
  assert(facts.some((fact) => fact.name === 'prometheus.scrape.duration' && fact.value === 0.021));
  assert(facts.some((fact) => fact.name === 'http.server.request.rate' && fact.value === 12.5));
  assert(facts.every((fact) => fact.resourceId === asset.serviceAssetId));
  assert.equal(service.sourceStatus().state, 'complete');
  assert.equal(requests.filter((path) => path?.startsWith('/api/v1/query')).length, 3);
  service.onModuleDestroy();
} finally {
  delete process.env.ANYSENTRY_PROMETHEUS_URL;
  await new Promise((resolve) => server.close(resolve));
}

console.log('S7 Prometheus service context verification passed');
