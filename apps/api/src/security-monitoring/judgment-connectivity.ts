import { L2CodeJudge, L2CodeJudgeOptions } from './l2-code-judge';
import { L3AgentPool } from './l3-agent-pool';
import { parseL3Decision } from './l3-decision-parser';
import { cleanText } from './redaction';
import { RuntimeModelConnection, RuntimeModelProfile } from './runtime-model-config';

export type JudgmentConnectivityStatus =
  | 'connected'
  | 'unauthorized'
  | 'rate_limited'
  | 'timeout'
  | 'unreachable'
  | 'invalid_response';

export interface JudgmentConnectivityResult {
  schemaVersion: 'anysentry.judgment_connectivity_result.v2';
  profile: RuntimeModelProfile;
  ok: boolean;
  status: JudgmentConnectivityStatus;
  checkedAt: string;
  latencyMs: number;
  runtime: 'api-a3s-code-sdk';
  endpoint: string;
  model: string;
  message: string;
}

type ConnectivityL2Judge = Pick<L2CodeJudge, 'judge' | 'close'>;
type ConnectivityL2Factory = (options: L2CodeJudgeOptions) => ConnectivityL2Judge;
type ConnectivityL3Pool = Pick<L3AgentPool, 'initialize' | 'run' | 'close'>;

function failureStatus(error: unknown): JudgmentConnectivityStatus {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|authentication|invalid api.?key/iu.test(message)) return 'unauthorized';
  if (/\b429\b|rate.?limit|too many requests/iu.test(message)) return 'rate_limited';
  if (/timeout|timed out|exceeded .*ms/iu.test(message)) return 'timeout';
  if (/invalid verdict|invalid severity|empty reason|no valid json|parse|unexpected token/iu.test(message)) return 'invalid_response';
  return 'unreachable';
}

function result(
  profile: RuntimeModelProfile,
  connection: RuntimeModelConnection,
  startedAt: number,
  fields: Pick<JudgmentConnectivityResult, 'ok' | 'status' | 'message'>,
): JudgmentConnectivityResult {
  return {
    schemaVersion: 'anysentry.judgment_connectivity_result.v2',
    profile,
    runtime: 'api-a3s-code-sdk',
    checkedAt: new Date().toISOString(),
    latencyMs: Math.max(0, Date.now() - startedAt),
    endpoint: connection.url,
    model: connection.model,
    ...fields,
  };
}

export async function testFastReviewConnection(
  connection: RuntimeModelConnection,
  judgeFactory: ConnectivityL2Factory = (options) => new L2CodeJudge(options),
): Promise<JudgmentConnectivityResult> {
  const startedAt = Date.now();
  const judge = judgeFactory({
    url: connection.url,
    model: connection.model,
    key: connection.apiKey,
    timeoutMs: connection.timeoutS * 1_000,
    contextLimit: connection.contextTokens,
  });
  try {
    await judge.judge({
      observerLine: '{"identity":{"agent":"anysentry-connectivity-test"},"event":{"ToolExec":{"argv":["echo","connectivity-test"],"cwd":"/tmp"}}}',
      eventKind: 'ToolExec',
      subject: 'AnySentry fast-review connectivity test',
      actor: 'anysentry-connectivity-test',
      provider: 'configuration-page',
    });
    return result('fast_review', connection, startedAt, {
      ok: true,
      status: 'connected',
      message: '连接成功，已通过 A3S Code 完成一次最小结构化研判',
    });
  } catch (error) {
    return result('fast_review', connection, startedAt, {
      ok: false,
      status: failureStatus(error),
      message: cleanText(error instanceof Error ? error.message : error, 500) || '连接测试失败',
    });
  } finally {
    await judge.close().catch(() => undefined);
  }
}

export async function testDeepInvestigationConnection(
  connection: RuntimeModelConnection,
  skills: string,
  poolFactory: (options: ConstructorParameters<typeof L3AgentPool>[0]) => ConnectivityL3Pool = (options) => new L3AgentPool(options),
): Promise<JudgmentConnectivityResult> {
  const startedAt = Date.now();
  const pool = poolFactory({
    size: 1,
    timeoutMs: connection.timeoutS * 1_000,
    executionTimeoutMs: Math.max(1_000, connection.timeoutS * 1_000 - 2_000),
    maxJobsPerSession: 1,
    modelConfig: {
      url: connection.url,
      model: connection.model,
      key: connection.apiKey,
      contextLimit: connection.contextTokens,
    },
  });
  try {
    await pool.initialize();
    const run = await pool.run(
      skills,
      'This is a connectivity test, not an incident. Do not use tools. Return only {"verdict":"allow","severity":"low","reason":"connectivity ok"}.',
      (text) => { parseL3Decision(text); },
      { timeoutMs: connection.timeoutS * 1_000 },
    );
    parseL3Decision(run.text);
    return result('deep_investigation', connection, startedAt, {
      ok: true,
      status: 'connected',
      message: '连接成功，已通过 A3S Code 完成一次最小深度研判',
    });
  } catch (error) {
    return result('deep_investigation', connection, startedAt, {
      ok: false,
      status: failureStatus(error),
      message: cleanText(error instanceof Error ? error.message : error, 500) || '连接测试失败',
    });
  } finally {
    await pool.close().catch(() => undefined);
  }
}
