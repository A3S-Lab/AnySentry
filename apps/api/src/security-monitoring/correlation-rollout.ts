export type TrustedCorrelationMode = 'off' | 'shadow' | 'enabled';
export type CaptureProfileMode = 'legacy' | 'shadow' | 'enforce';
export type UnknownRetentionMode = 'legacy' | 'shadow' | 'enforce';

export interface CorrelationCaptureRollout {
  trustedCorrelation: TrustedCorrelationMode;
  captureProfile: CaptureProfileMode;
  unknownRetention: UnknownRetentionMode;
}

function enumValue<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const normalized = value?.trim().toLowerCase();
  return normalized && allowed.includes(normalized as T) ? normalized as T : fallback;
}

/**
 * Independent, fail-closed rollout controls for the correlation/capture migration.
 *
 * Reading these values has no side effect. A stage must explicitly consume its own mode before it
 * may emit new fields or change capture behavior. Defaults therefore preserve the complete legacy
 * data path, including when an operator supplies an invalid value during a rolling deployment.
 */
export function correlationCaptureRollout(
  env: NodeJS.ProcessEnv = process.env,
): CorrelationCaptureRollout {
  return {
    trustedCorrelation: enumValue(
      env.ANYSENTRY_TRUSTED_CORRELATION_MODE,
      ['off', 'shadow', 'enabled'] as const,
      'off',
    ),
    captureProfile: enumValue(
      env.ANYSENTRY_CAPTURE_PROFILE_MODE,
      ['legacy', 'shadow', 'enforce'] as const,
      'legacy',
    ),
    unknownRetention: enumValue(
      env.ANYSENTRY_UNKNOWN_RETENTION_MODE,
      ['legacy', 'shadow', 'enforce'] as const,
      'legacy',
    ),
  };
}
