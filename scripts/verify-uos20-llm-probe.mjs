const base = process.env.ANYSENTRY_API_BASE;
if (!base) throw new Error('ANYSENTRY_API_BASE is required');

const ingest = await fetch(`${base}/ingest/events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    sourceType: 'custom',
    sourceName: 'uos20-mock-llm-verifier',
    workspacePath: 'repo://uos20/mock-llm',
    agentId: 'uos20-mock-llm-agent',
    sessionId: 'uos20-mock-llm-session',
    events: [{ kind: 'file', path: '/home/agent/.ssh/id_rsa', write: false }],
  }),
});
const result = await ingest.json();
const ingestData = result.data ?? result;
if (!ingest.ok || ingestData.acceptedEvents !== 1) {
  throw new Error(`mock LLM ingest failed: ${JSON.stringify(result)}`);
}
const decision = ingestData.items?.[0];
if (decision?.tier !== 'Llm' || decision?.verdict !== 'block' || decision?.severity !== 'high') {
  throw new Error(`unexpected L2 decision: ${JSON.stringify(decision)}`);
}

const configResponse = await fetch(`${base}/config`);
const configText = await configResponse.text();
if (!configResponse.ok) throw new Error(`config read failed: ${configText}`);
if (configText.includes('uos20-secret-key')) throw new Error('LLM API key leaked through config response');
const config = JSON.parse(configText);
const configData = config.data ?? config;
if (configData.status?.l2 !== true || configData.status?.l3 !== false) {
  throw new Error(`unexpected tier status: ${configText}`);
}
console.log('UOS ARM64 Mock OpenAI L2 probe passed');
