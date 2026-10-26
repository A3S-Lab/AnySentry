// Display classification only. Never rewrite Session/Thread/Turn attribution.
export type ObserverRequestScope = "main" | "auto_review" | "related_thread";

export function observerRequestScope(
  request: { model?: string; threadId?: string },
  nativeSessionId: string,
): ObserverRequestScope {
  if (request.model?.trim().toLowerCase() === "codex-auto-review") return "auto_review";
  const threadId = request.threadId?.trim();
  if (threadId && nativeSessionId && threadId !== nativeSessionId) return "related_thread";
  // Missing identity is not evidence of a different thread. Retain existing handling.
  return "main";
}
