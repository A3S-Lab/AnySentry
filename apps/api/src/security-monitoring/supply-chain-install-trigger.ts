export interface RuntimeInstallEvent {
  phase: 'started' | 'exited';
  pid: number;
  startTimeTicks?: string;
  startTimeNs?: string;
  packageManager?: string;
  command?: string;
  succeeded?: boolean;
}

interface ObserverEnvelope {
  process?: Record<string, unknown>;
  event?: Record<string, Record<string, unknown>>;
}

const COMMAND_START = String.raw`(?:^|(?:&&|\|\||[;|])\s*)`;
const EXECUTABLE_PATH = String.raw`(?:[A-Za-z0-9_.@+-]+[\\/])*`;
const INSTALL_PATTERNS: Array<[string, RegExp]> = [
  ['npm', new RegExp(`${COMMAND_START}${EXECUTABLE_PATH}(?:npm|npm\\.cmd)\\s+(?:i|install|add|update)\\b`, 'iu')],
  ['pnpm', new RegExp(`${COMMAND_START}${EXECUTABLE_PATH}(?:pnpm|pnpm\\.cmd)\\s+(?:i|install|add|update|up)\\b`, 'iu')],
  ['yarn', new RegExp(`${COMMAND_START}${EXECUTABLE_PATH}(?:yarn|yarn\\.cmd)\\s+(?:install|add|upgrade|up)\\b`, 'iu')],
  ['bun', new RegExp(`${COMMAND_START}${EXECUTABLE_PATH}(?:bun|bunx)\\s+(?:install|add|update)\\b`, 'iu')],
  ['pip', new RegExp(`${COMMAND_START}${EXECUTABLE_PATH}(?:pip|pip3|pipx)\\s+install\\b`, 'iu')],
  ['pip', new RegExp(`${COMMAND_START}${EXECUTABLE_PATH}(?:python|python3|py)\\s+-m\\s+pip\\s+install\\b`, 'iu')],
  ['cargo', new RegExp(`${COMMAND_START}${EXECUTABLE_PATH}cargo\\s+(?:add|install|update)\\b`, 'iu')],
  ['go', new RegExp(`${COMMAND_START}${EXECUTABLE_PATH}go\\s+(?:get|install)\\b`, 'iu')],
  ['go', new RegExp(`${COMMAND_START}${EXECUTABLE_PATH}go\\s+mod\\s+(?:download|tidy)\\b`, 'iu')],
  ['ruby', new RegExp(`${COMMAND_START}${EXECUTABLE_PATH}gem\\s+install\\b`, 'iu')],
  ['ruby', new RegExp(`${COMMAND_START}${EXECUTABLE_PATH}bundle\\s+(?:install|update|add)\\b`, 'iu')],
  ['composer', new RegExp(`${COMMAND_START}${EXECUTABLE_PATH}composer\\s+(?:install|require|update)\\b`, 'iu')],
  ['dotnet', new RegExp(`${COMMAND_START}${EXECUTABLE_PATH}dotnet\\s+(?:restore|add(?:\\s+\\S+)?\\s+package)\\b`, 'iu')],
];

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function identityText(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    const normalized = String(value).trim();
    return normalized || undefined;
  }
  return undefined;
}

function commandFromArgv(argv: unknown): string | undefined {
  if (!Array.isArray(argv) || argv.length === 0) return undefined;
  const values = argv
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) return undefined;
  const executable = values[0].split('/').pop()?.toLowerCase() ?? '';
  if (['bash', 'sh', 'zsh', 'dash', 'fish'].includes(executable)) {
    const commandIndex = values.findIndex((value, index) => index > 0 && /^-[^-]*c[^-]*$/u.test(value));
    if (commandIndex >= 0 && values[commandIndex + 1]) return values[commandIndex + 1];
  }
  values[0] = executable;
  return values.join(' ');
}

export function detectPackageManagerInstall(command: string): string | undefined {
  const normalized = command.replace(/\s+/gu, ' ').trim();
  for (const [manager, pattern] of INSTALL_PATTERNS) {
    if (pattern.test(normalized)) return manager;
  }
  return undefined;
}

/**
 * Extract only facts needed to correlate an install command with its process exit.
 * Trusted workspace/source identity is supplied separately by the ingest pipeline.
 */
export function parseRuntimeInstallEvent(line: string): RuntimeInstallEvent | undefined {
  let envelope: ObserverEnvelope;
  try {
    envelope = JSON.parse(line) as ObserverEnvelope;
  } catch {
    return undefined;
  }
  const [kind, payload] = Object.entries(envelope.event ?? {})[0] ?? [];
  if (!kind || !payload) return undefined;
  const process = envelope.process ?? {};
  const pid = positiveInteger(payload.pid) ?? positiveInteger(process.pid);
  if (!pid) return undefined;
  const startTimeTicks = identityText(process.startTimeTicks)
    ?? identityText(process.start_time_ticks)
    ?? identityText(payload.startTimeTicks)
    ?? identityText(payload.start_time_ticks);
  const startTimeNs = identityText(process.startTimeNs)
    ?? identityText(process.start_time_ns)
    ?? identityText(payload.startTimeNs)
    ?? identityText(payload.start_time_ns);

  if (kind === 'ToolExec') {
    const command = commandFromArgv(payload.argv);
    if (!command) return undefined;
    const packageManager = detectPackageManagerInstall(command);
    if (!packageManager) return undefined;
    return {
      phase: 'started',
      pid,
      startTimeTicks,
      startTimeNs,
      packageManager,
      command: command.slice(0, 1_000),
    };
  }

  if (kind !== 'ProcessExit') return undefined;
  const exitCode = Number(payload.exit_code ?? payload.exitCode ?? payload.status);
  const signal = Number(payload.signal ?? 0);
  return {
    phase: 'exited',
    pid,
    startTimeTicks,
    startTimeNs,
    succeeded: Number.isFinite(exitCode) && exitCode === 0
      && (!Number.isFinite(signal) || signal === 0),
  };
}
