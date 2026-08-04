import { AgentClassification } from './types';

export type EventVisibilityScope = 'agent' | 'raw';

/** Page visibility is intentionally independent from collector retention and judgment routing. */
export function isEventClassificationVisible(
  classification: AgentClassification,
  scope: EventVisibilityScope,
  includeUnknown = true,
  pinned = false,
): boolean {
  if (pinned) return true;
  if (scope === 'agent') return classification === 'confirmed_agent' || classification === 'probable_agent';
  if (classification === 'non_agent') return false;
  return includeUnknown || classification !== 'unknown';
}
