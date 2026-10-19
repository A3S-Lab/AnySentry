// One-shot canary for anysentry-api:container-evidence-link-20261012.
// Preserves existing config/secrets in memory, renames the old container for rollback.
// Kimi-code session mounts/env are inherited from the running container (added by the
// kimi-code-wire canary); this script only swaps the image.
// Never prints Env or writes it to disk; does not alter any volume contents.
import http from 'node:http';
const name = 'anysentry-anysentry-1';
const image = 'anysentry-api:container-evidence-link-20261012';
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ socketPath: '/var/run/docker.sock', method, path,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => {
        if (res.statusCode >= 300) return reject(new Error(`${method} ${path}: HTTP ${res.statusCode}`));
        resolve(text ? JSON.parse(text) : undefined);
      });
    });
    req.setTimeout(65_000, () => req.destroy(new Error('Docker request timed out')));
    req.on('error', reject); req.end(data);
  });
}
const old = await request('GET', `/containers/${name}/json`);
const target = await request('GET', `/images/${image}/json`);
const backup = `${name}-before-transient-fd-bind-${Date.now()}`;
const config = { ...old.Config };
const hostConfig = { ...old.HostConfig };
const endpoints = Object.fromEntries(Object.entries(old.NetworkSettings.Networks).map(([network, x]) => [network, {
  Aliases: (x.Aliases ?? []).filter(a => a !== old.Id && a !== old.Id.slice(0, 12)),
  ...(x.IPAMConfig ? { IPAMConfig: x.IPAMConfig } : {}),
}]));
let newId;
let renamed = false;
try {
  if (old.State.Running) await request('POST', `/containers/${old.Id}/stop?t=30`);
  await request('POST', `/containers/${old.Id}/rename?name=${backup}`);
  renamed = true;
  const created = await request('POST', `/containers/create?name=${name}`, {
    ...config, Image: image,
    Labels: { ...old.Config.Labels, 'com.docker.compose.image': target.Id, 'anysentry.canary': 'container-evidence-link-20261012' },
    HostConfig: hostConfig, NetworkingConfig: { EndpointsConfig: endpoints },
  });
  newId = created.Id;
  await request('POST', `/containers/${newId}/start`);
  let healthy = false;
  for (let i = 0; i < 45; i++) {
    try {
      const res = await fetch('http://127.0.0.1:29653/security-center/healthz', { signal: AbortSignal.timeout(1500) });
      const body = await res.json();
      if (res.ok && body.data?.status === 'ok' && body.data?.storage?.clickhouseReady) { healthy = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!healthy) throw new Error('API health check failed');
  console.log(JSON.stringify({ service: name, image, backup, state: 'started', preservedConfiguration: true }));
} catch (error) {
  if (newId) {
    try { await request('POST', `/containers/${newId}/stop?t=5`); } catch {}
    await request('POST', `/containers/${newId}/rename?name=${name}-failed-transient-fd-bind-${Date.now()}`);
  }
  if (renamed) await request('POST', `/containers/${old.Id}/rename?name=${name}`);
  if (old.State.Running) await request('POST', `/containers/${old.Id}/start`);
  throw error;
}
