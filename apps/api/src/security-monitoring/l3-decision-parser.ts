import { AsyncDecision } from './async-judgment.types';

function jsonObjects(text: string): unknown[] {
  const objects: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start < 0) {
      if (char === '{') {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          objects.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          // Continue scanning after malformed evidence; a valid terminal verdict may follow it.
        }
        start = -1;
      }
    }
  }

  return objects;
}

function isL3Decision(value: unknown): value is AsyncDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const decision = value as Partial<AsyncDecision>;
  return (
    ['allow', 'block'].includes(decision.verdict ?? '') &&
    ['low', 'medium', 'high', 'critical'].includes(decision.severity ?? '') &&
    typeof decision.reason === 'string' &&
    decision.reason.trim().length > 0
  );
}

export function parseL3Decision(text: string): AsyncDecision {
  const decisions = jsonObjects(text).filter(isL3Decision);
  const parsed = decisions.at(-1);
  if (!parsed) throw new Error('L3 returned no valid JSON verdict');
  return { ...parsed, tier: 'Agent', reason: parsed.reason.slice(0, 2_000) };
}
