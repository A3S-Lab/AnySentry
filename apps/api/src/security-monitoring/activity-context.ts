import {
  ActivityContext,
  ActivitySubtype,
  EventCategory,
  JudgedEvent,
} from './types';

const PLATFORM_HEALTHCHECK_SUBTYPES = new Set<ActivitySubtype>([
  'docker_healthcheck',
  'k8s_exec_probe',
  'k8s_liveness_probe',
  'k8s_readiness_probe',
  'k8s_startup_probe',
]);

export interface NormalizedActivitySemantics {
  activityContext?: ActivityContext;
  activitySubtype?: ActivitySubtype;
  eventCategory?: EventCategory;
}

/**
 * Normalize untrusted ingest metadata without changing the underlying event kind.
 *
 * ToolExec is conservatively an Agent action unless the Forwarder supplied a complete, valid
 * platform-healthcheck pair. This fail-open default keeps historical rows and uncertain events in
 * command tracking instead of hiding them.
 */
export function normalizeActivitySemantics(
  eventKind: string,
  activityContext: unknown,
  activitySubtype: unknown,
): NormalizedActivitySemantics {
  if (eventKind !== 'ToolExec') return {};
  if (
    activityContext === 'platform_healthcheck' &&
    typeof activitySubtype === 'string' &&
    PLATFORM_HEALTHCHECK_SUBTYPES.has(activitySubtype as ActivitySubtype)
  ) {
    return {
      activityContext: 'platform_healthcheck',
      activitySubtype: activitySubtype as ActivitySubtype,
      eventCategory: 'runtime',
    };
  }
  return {
    activityContext: 'agent_action',
    eventCategory: 'tool',
  };
}

/** Historical ToolExec rows predate activityContext and remain visible as Agent actions. */
export function eventActivityContext(
  event: Pick<JudgedEvent, 'eventKind' | 'activityContext' | 'activitySubtype'>,
): ActivityContext | undefined {
  return normalizeActivitySemantics(
    event.eventKind,
    event.activityContext,
    event.activitySubtype,
  ).activityContext;
}

export function eventActivitySubtype(
  event: Pick<JudgedEvent, 'eventKind' | 'activityContext' | 'activitySubtype'>,
): ActivitySubtype | undefined {
  return eventActivityContext(event) === 'platform_healthcheck' &&
    event.activitySubtype &&
    PLATFORM_HEALTHCHECK_SUBTYPES.has(event.activitySubtype)
    ? event.activitySubtype
    : undefined;
}
