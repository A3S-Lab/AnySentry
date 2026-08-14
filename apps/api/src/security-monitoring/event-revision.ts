import { JudgedEvent } from './types';

function revisionOf(event: JudgedEvent): number {
  return Math.max(1, Math.trunc(event.decisionRevision ?? 1));
}

function updatedAtOf(event: JudgedEvent): number {
  return event.decisionUpdatedAt ?? event.at;
}

/**
 * Compare two deliveries for the same canonical event.
 *
 * Delivery deduplication is `(eventId, decisionRevision)`, while the effective dashboard state is
 * the greatest revision for each `eventId`. Timestamps only break ties between duplicate
 * deliveries of the same revision.
 */
export function isNewerEventRevision(next: JudgedEvent, previous: JudgedEvent): boolean {
  const nextRevision = revisionOf(next);
  const previousRevision = revisionOf(previous);
  return nextRevision > previousRevision || (
    nextRevision === previousRevision &&
    updatedAtOf(next) >= updatedAtOf(previous)
  );
}

/** Fold persisted facts and hot deliveries into one effective event per stable eventId. */
export function foldLatestEventRevisions(events: Iterable<JudgedEvent>): JudgedEvent[] {
  const latest = new Map<string, JudgedEvent>();
  for (const event of events) {
    const previous = latest.get(event.eventId);
    if (!previous || isNewerEventRevision(event, previous)) latest.set(event.eventId, event);
  }
  return [...latest.values()];
}
