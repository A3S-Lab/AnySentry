function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function securityCapabilitiesEndpoint() {
  if (typeof window === "undefined") return "/security-center/capabilities";
  return `${window.location.origin}/security-center/capabilities`;
}

export function generatedSecurityCapabilityCurl(request: string | unknown) {
  const body =
    typeof request === "string"
      ? (() => {
          try {
            return formatJson(parseJson(request));
          } catch {
            return request;
          }
        })()
      : formatJson(request);

  return [
    `curl -fsS -X POST ${shellQuote(securityCapabilitiesEndpoint())} \\`,
    "  -H 'Content-Type: application/json' \\",
    `  -d ${shellQuote(body)}`,
  ].join("\n");
}
