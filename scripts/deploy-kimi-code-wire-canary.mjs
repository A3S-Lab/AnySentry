// One-shot canary for anysentry-api:kimi-code-wire-20261009.
// Preserves existing config/secrets in memory, renames the old container for rollback,
// and extends Kimi discovery roots to the kimi-code (~/.kimi-code) session directory.
// Never prints Env or writes it to disk; does not alter any volume contents.
import http from 'node:http';
const name = 'anysentry-anysentry-1';
const image = 'anysentry-api:kimi-code-wire-20261009';
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
const backup = `${name}-before-kimi-code-wire-${Date.now()}`;
const config = { ...old.Config };
const hostConfig = { ...old.HostConfig };
const env = new Map(config.Env.map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
// /proc/1/root magic links do not survive realpath() in discovery; use a real read-only bind mount.
const KIMI_CODE_DIR = '/host-agent-state/kimi-code/sessions';
const KIMI_CODE_HOST_DIR = '/home/zhongyule/.kimi-code/sessions';
hostConfig.Binds = [...new Set([...(hostConfig.Binds ?? []), `${KIMI_CODE_HOST_DIR}:${KIMI_CODE_DIR}:ro`])];
// These arrays are positional pairs. Two different container paths may legitimately map to
// the same host directory; de-duplicating the host array breaks the final bind mount's identity.
const rootKey = 'ANYSENTRY_LOCAL_KIMI_SESSIONS_DIRS';
const hostKey = 'ANYSENTRY_LOCAL_KIMI_SESSIONS_HOST_DIRS';
const roots = (env.get(rootKey) ?? '').split(':').filter(Boolean);
const hostRoots = (env.get(hostKey) ?? '').split(':').filter(Boolean);
if (!roots.includes(KIMI_CODE_DIR)) roots.push(KIMI_CODE_DIR);
const mountIndex = roots.indexOf(KIMI_CODE_DIR);
hostRoots[mountIndex] = KIMI_CODE_HOST_DIR;
env.set(rootKey, roots.join(':'));
env.set(hostKey, hostRoots.join(':'));
config.Env = [...env].map(([key, value]) => `${key}=${value}`);
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
    Labels: { ...old.Config.Labels, 'com.docker.compose.image': target.Id, 'anysentry.canary': 'kimi-code-wire-20261009' },
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
    await request('POST', `/containers/${newId}/rename?name=${name}-failed-kimi-code-wire-${Date.now()}`);
  }
  if (renamed) await request('POST', `/containers/${old.Id}/rename?name=${name}`);
  if (old.State.Running) await request('POST', `/containers/${old.Id}/start`);
  throw error;
}
