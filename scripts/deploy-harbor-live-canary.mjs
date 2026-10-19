// Explicit two-service canary. Preserve existing config/secrets in memory and old containers for rollback.
// Never prints Env or writes it to disk; does not alter any volume contents.
import http from 'node:http';
const targets = {
  'api-live-agent-status': ['anysentry-anysentry-1', 'anysentry-api:live-agent-status-20260923'],
  'web-link-kernel-timeline': ['anysentry-web-1', 'anysentry-web:link-kernel-timeline-20260923'],
  'web-conversation-fit': ['anysentry-web-1', 'anysentry-web:conversation-fit-20260923'],
  'web-conversation-fluid': ['anysentry-web-1', 'anysentry-web:conversation-fluid-20260923'],
  'web-link-banners-trim': ['anysentry-web-1', 'anysentry-web:link-banners-trim-20260923'],
  'web-kernel-after-link': ['anysentry-web-1', 'anysentry-web:kernel-after-link-20260923'],
  'web-live-agent-status': ['anysentry-web-1', 'anysentry-web:live-agent-status-20260923'],
  'web-page-notes-trim': ['anysentry-web-1', 'anysentry-web:page-notes-trim-20260923'],
  'web-link-notes-trim': ['anysentry-web-1', 'anysentry-web:link-notes-trim-20260923'],
  'web-tab-order': ['anysentry-web-1', 'anysentry-web:tab-order-20260923'],
  'web-trace-notes-trim': ['anysentry-web-1', 'anysentry-web:trace-notes-trim-20260923'],
  'web-kernel-events': ['anysentry-web-1', 'anysentry-web:kernel-events-20260923'],
  'web-filter-select-contrast': ['anysentry-web-1', 'anysentry-web:filter-select-contrast-20260923'],
  'web-filter-select': ['anysentry-web-1', 'anysentry-web:filter-select-20260923'],
  'web-record-copy-trim': ['anysentry-web-1', 'anysentry-web:record-copy-trim-20260923'],
  'web-trace-refresh': ['anysentry-web-1', 'anysentry-web:trace-refresh-20260918'],
  'web-trace-no-source': ['anysentry-web-1', 'anysentry-web:trace-no-source-20260918'],
  'api-evidence-dedup': ['anysentry-anysentry-1', 'anysentry-api:evidence-dedup-20260917'],
  'web-evidence-dedup': ['anysentry-web-1', 'anysentry-web:evidence-dedup-20260917'],
  'api-analysis': ['anysentry-anysentry-1', 'anysentry-api:session-analysis-20260917'],
  'web-analysis': ['anysentry-web-1', 'anysentry-web:session-analysis-20260917'],
  'web-trace-icons': ['anysentry-web-1', 'anysentry-web:trace-icons-20260917'],
  'web-opencode-trace': ['anysentry-web-1', 'anysentry-web:opencode-trace-20260917'],
  'api-opencode-v3': ['anysentry-anysentry-1', 'anysentry-api:opencode-v3-20260917'],
  'api-opencode-v2': ['anysentry-anysentry-1', 'anysentry-api:opencode-v2-20260917'],
  'web-trace': ['anysentry-web-1', 'anysentry-web:trace-20260917'],
  'api-opencode': ['anysentry-anysentry-1', 'anysentry-api:opencode-20260917'],
  'web-opencode': ['anysentry-web-1', 'anysentry-web:opencode-20260917'],
  'observer-opencode': ['anysentry-observer-1', 'anysentry-observer-wrapper:opencode-20260917'],
  'api-kimi-startup-context': ['anysentry-anysentry-1', 'anysentry-api:kimi-startup-context-20260916'],
  'web-kimi-startup-context': ['anysentry-web-1', 'anysentry-web:kimi-startup-context-20260916'],
  'api-kimi-v3': ['anysentry-anysentry-1', 'anysentry-api:kimi-monitoring-v3-20260916'],
  'observer-kimi-v3': ['anysentry-observer-1', 'anysentry-observer-wrapper:kimi-monitoring-v3-20260916'],
  'api-kimi-v2': ['anysentry-anysentry-1', 'anysentry-api:kimi-monitoring-v2-20260916'],
  'observer-kimi-v2': ['anysentry-observer-1', 'anysentry-observer-wrapper:kimi-monitoring-v2-20260916'],
  'api-kimi': ['anysentry-anysentry-1', 'anysentry-api:kimi-monitoring-20260916'],
  'web-kimi': ['anysentry-web-1', 'anysentry-web:kimi-monitoring-20260916'],
  'observer-kimi': ['anysentry-observer-1', 'anysentry-observer-wrapper:kimi-monitoring-20260916'],
  'web-turn-newest-first': ['anysentry-web-1', 'anysentry-web:turn-newest-first-20260916'],
  'web-newest-first': ['anysentry-web-1', 'anysentry-web:newest-first-20260916'],
  'api-normal-dialogue-v3': ['anysentry-anysentry-1', 'anysentry-api:normal-dialogue-v3-20260916'],
  'api-normal-dialogue-v2': ['anysentry-anysentry-1', 'anysentry-api:normal-dialogue-v2-20260916'],
  'api-normal-dialogue': ['anysentry-anysentry-1', 'anysentry-api:normal-dialogue-20260916'],
  'web-normal-dialogue': ['anysentry-web-1', 'anysentry-web:normal-dialogue-20260916'],
  'api-tool-candidates': ['anysentry-anysentry-1', 'anysentry-api:tool-candidates-20260916'],
  'web-tool-candidates': ['anysentry-web-1', 'anysentry-web:tool-candidates-20260916'],
  'observer-ws-connection': ['anysentry-observer-1', 'anysentry-observer-wrapper:ws-connection-20260914'],
  'observer-ws-connection-v2': ['anysentry-observer-1', 'anysentry-observer-wrapper:ws-connection-v2-20260914'],
  'web-prompt-color': ['anysentry-web-1', 'anysentry-web:prompt-color-20260914'],
  'web-turn-content': ['anysentry-web-1', 'anysentry-web:turn-content-20260914'],
  'api-observer-content': ['anysentry-anysentry-1', 'anysentry-api:observer-content-20260914'],
  'web-observer-content': ['anysentry-web-1', 'anysentry-web:observer-content-20260914'],
  api: ['anysentry-anysentry-1', 'anysentry-api:harbor-live-20260913'],
  observer: ['anysentry-observer-1', 'anysentry-observer-wrapper:harbor-live-20260913'],
  'api-namespace': ['anysentry-anysentry-1', 'anysentry-api:namespace-stable-20260913'],
  'api-tail-resume': ['anysentry-anysentry-1', 'anysentry-api:tail-resume-20260913'],
  'api-tail-resume-v2': ['anysentry-anysentry-1', 'anysentry-api:tail-resume-v2-20260913'],
  'observer-kimi-tls': ['anysentry-observer-1', 'anysentry-observer-wrapper:kimi-openssl-tls-20261013'],
  'observer-kimi-response': ['anysentry-observer-1', 'anysentry-observer-wrapper:kimi-response-20261014'],
  'observer-kimi-keepalive': ['anysentry-observer-1', 'anysentry-observer-wrapper:kimi-keepalive-20261015'],
  'api-kimi-tls-session': ['anysentry-anysentry-1', 'anysentry-api:kimi-tls-session-20261013'],
  'api-kimi-tls-session-v2': ['anysentry-anysentry-1', 'anysentry-api:kimi-tls-session-v2-20261013'],
  'api-kimi-response': ['anysentry-anysentry-1', 'anysentry-api:kimi-response-20261014'],
};
const [name, image] = targets[process.argv[2]] ?? [];
if (!name) throw new Error(`Choose ${Object.keys(targets).join(', ')}`);
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({socketPath: '/var/run/docker.sock', method, path,
      headers: data ? {'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(data)} : {}}, res => {
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
if (old.Config.Image === image) throw new Error('Already deployed; inspect current state instead of replacing twice');
const target = await request('GET', `/images/${image}/json`);
const backup = `${name}-before-live-${Date.now()}`;
const config = {...old.Config};
const hostConfig = {...old.HostConfig};
const kimiSessions = '/home/zhongyule/code/anysentry-e2e-work/kimi-20260916/state/sessions';
const setEnv = (updates) => {
  const env = new Map(config.Env.map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
  for (const [key, value] of Object.entries(updates)) env.set(key, value);
  config.Env = [...env].map(([key, value]) => `${key}=${value}`);
};
const openCodeData = '/home/zhongyule/code/anysentry-e2e-work/opencode-20260917/data/opencode';
if (['observer-kimi-tls', 'observer-kimi-response', 'observer-kimi-keepalive'].includes(process.argv[2])) {
  // kimi managed-OAuth and API-key providers terminate on these hosts; suffix-matched.
  const env = Object.fromEntries(config.Env.map(value => { const i = value.indexOf('='); return [value.slice(0, i), value.slice(i + 1)]; }));
  setEnv({ A3S_OBSERVER_RUNTIME_PROVIDER_HOSTS: [...new Set([...(env.A3S_OBSERVER_RUNTIME_PROVIDER_HOSTS || '').split(','),
    'api.kimi.com', 'api.moonshot.cn', 'api.moonshot.ai'].filter(Boolean))].join(',') });
}
if (process.argv[2] === 'api-opencode') {
  setEnv({ ANYSENTRY_LOCAL_OPENCODE_DATA_DIR: '',
    ANYSENTRY_LOCAL_OPENCODE_DATA_DIRS: '/host-agent-state/opencode:/proc/1/root/home/zhongyule/.local/share/opencode' });
  hostConfig.Binds = [...new Set([...(hostConfig.Binds ?? []), `${openCodeData}:/host-agent-state/opencode:ro`])];
}
if (process.argv[2] === 'observer-opencode') {
  const env = Object.fromEntries(config.Env.map(value => { const i = value.indexOf('='); return [value.slice(0, i), value.slice(i + 1)]; }));
  const paths = [openCodeData, '/home/zhongyule/code/anysentry-e2e-work/opencode-20260917/workspace'];
  setEnv({ FORWARD_AGENT_ALLOWLIST: [...new Set([...(env.FORWARD_AGENT_ALLOWLIST || 'codex').split(','), 'opencode'])].join(','),
    A3S_OBSERVER_FILE_INCLUDE_PATHS: [...new Set([...(env.A3S_OBSERVER_FILE_INCLUDE_PATHS || '').split(','), ...paths].filter(Boolean))].join(','),
    FORWARD_FILE_INCLUDE_PATHS: [...new Set([...(env.FORWARD_FILE_INCLUDE_PATHS || '').split(','), ...paths].filter(Boolean))].join(',') });
}
if (['api-kimi', 'api-kimi-v2', 'api-kimi-v3'].includes(process.argv[2])) {
  setEnv({ANYSENTRY_LOCAL_KIMI_SESSIONS_DIR:'', ANYSENTRY_LOCAL_KIMI_SESSIONS_HOST_DIR:'',
    ANYSENTRY_LOCAL_KIMI_SESSIONS_DIRS:'/host-agent-state/kimi/sessions:/proc/1/root/home/zhongyule/.kimi/sessions',
    ANYSENTRY_LOCAL_KIMI_SESSIONS_HOST_DIRS:`${kimiSessions}:/home/zhongyule/.kimi/sessions`});
  hostConfig.Binds = [...new Set([...(hostConfig.Binds ?? []), `${kimiSessions}:/host-agent-state/kimi/sessions:ro`,
    `${kimiSessions.replace(/\/sessions$/, '')}/kimi.json:/host-agent-state/kimi/kimi.json:ro`])];
}
if (['observer-kimi', 'observer-kimi-v2', 'observer-kimi-v3'].includes(process.argv[2])) {
  const env = Object.fromEntries(config.Env.map(value => {const i=value.indexOf('='); return [value.slice(0,i),value.slice(i+1)]}));
  setEnv({FORWARD_AGENT_ALLOWLIST:[...new Set([...(env.FORWARD_AGENT_ALLOWLIST || 'codex').split(','),'kimi-cli','kimi code','kimi code cli'])].join(','),
    A3S_OBSERVER_FILE_ACCESS:'1', A3S_OBSERVER_FILE_INCLUDE_PATHS:[...new Set([env.A3S_OBSERVER_FILE_INCLUDE_PATHS,kimiSessions].filter(Boolean))].join(','),
    FORWARD_FILE_INCLUDE_PATHS:`${kimiSessions},/home/zhongyule/.kimi/sessions`,
    FORWARD_FILE_AGGREGATION:'false'});
}
const endpoints = Object.fromEntries(Object.entries(old.NetworkSettings.Networks).map(([network, x]) => [network, {
  Aliases: (x.Aliases ?? []).filter(a => a !== old.Id && a !== old.Id.slice(0,12)),
  ...(x.IPAMConfig ? {IPAMConfig:x.IPAMConfig} : {}),
}]));
let newId;
let renamed = false;
try {
  if (old.State.Running) await request('POST', `/containers/${old.Id}/stop?t=30`);
  await request('POST', `/containers/${old.Id}/rename?name=${backup}`);
  renamed = true;
  const created = await request('POST', `/containers/create?name=${name}`, {
    ...config, Image:image,
    Labels:{...old.Config.Labels, 'com.docker.compose.image':target.Id, 'anysentry.canary':'harbor-live-20260913'},
    HostConfig:hostConfig, NetworkingConfig:{EndpointsConfig:endpoints},
  });
  newId = created.Id;
  await request('POST', `/containers/${newId}/start`);
  if (name === 'anysentry-anysentry-1') {
    let healthy = false;
    for (let i = 0; i < 45; i++) {
      try {
        const res = await fetch('http://127.0.0.1:29653/security-center/healthz', {signal:AbortSignal.timeout(1500)});
        const body = await res.json();
        if (res.ok && body.data?.status === 'ok' && body.data?.storage?.clickhouseReady) { healthy = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!healthy) throw new Error('API health check failed');
  }
  if (['web-link-kernel-timeline', 'web-conversation-fit', 'web-conversation-fluid', 'web-link-banners-trim', 'web-kernel-after-link', 'web-live-agent-status', 'web-page-notes-trim', 'web-link-notes-trim', 'web-tab-order', 'web-trace-notes-trim', 'web-kernel-events', 'web-filter-select-contrast', 'web-filter-select', 'web-record-copy-trim', 'web-trace-refresh', 'web-trace-no-source', 'web-evidence-dedup', 'web-analysis', 'web-tool-candidates', 'web-normal-dialogue', 'web-newest-first', 'web-turn-newest-first', 'web-kimi', 'web-kimi-startup-context', 'web-trace', 'web-trace-icons'].includes(process.argv[2])) {
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch('http://127.0.0.1:29654/record-tracking', {signal:AbortSignal.timeout(1500)});
        if (res.ok && (await res.text()).includes('<html')) { healthy = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!healthy) throw new Error('Web health check failed');
  }
  console.log(JSON.stringify({service:name,image,backup,state:'started',preservedConfiguration:true}));
} catch (error) {
  if (newId) {
    try { await request('POST', `/containers/${newId}/stop?t=5`); } catch {}
    await request('POST', `/containers/${newId}/rename?name=${name}-failed-live-${Date.now()}`);
  }
  if (renamed) await request('POST', `/containers/${old.Id}/rename?name=${name}`);
  if (old.State.Running) await request('POST', `/containers/${old.Id}/start`);
  throw error;
}
