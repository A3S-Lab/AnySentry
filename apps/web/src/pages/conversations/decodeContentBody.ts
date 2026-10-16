import type { AgentInteractionContent } from "@/lib/api/security-center";

export function decodeContentBody(side: Pick<AgentInteractionContent, "body" | "encoding">): string {
  if (side.encoding !== "base64") return side.body;
  try {
    const bytes = Uint8Array.from(atob(side.body), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return side.body;
  }
}
