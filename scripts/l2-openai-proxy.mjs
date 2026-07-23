import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const targetBase = process.env.L2_TARGET_BASE || "https://api.pjlab.org.cn/v1";
const apiKey = process.env.PJLAB_API_KEY;
const host = process.env.L2_PROXY_HOST || "0.0.0.0";
const port = Number(process.env.L2_PROXY_PORT || 18051);
const upstreamTimeoutMs = Number(process.env.L2_PROXY_UPSTREAM_TIMEOUT_MS || 58_000);
let activeRequests = 0;
let requestSequence = 0;

if (!apiKey) {
  console.error("PJLAB_API_KEY is required");
  process.exit(1);
}

function upstreamUrl(requestUrl) {
  const incomingPath = requestUrl || "/";
  const relativePath = incomingPath.startsWith("/v1/")
    ? incomingPath.slice(4)
    : incomingPath.replace(/^\/+/, "");
  return new URL(relativePath, `${targetBase.replace(/\/+$/, "")}/`);
}

const server = http.createServer(async (req, res) => {
  const requestId = ++requestSequence;
  const startedAt = Date.now();
  const controller = new AbortController();
  let completed = false;
  let timedOut = false;
  let upstream;
  activeRequests += 1;

  const abortUpstream = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onAborted = () => abortUpstream(new Error("downstream request aborted"));
  const onFinished = () => { completed = true; };
  const onClosed = () => {
    if (!completed) abortUpstream(new Error("downstream connection closed"));
  };
  req.once("aborted", onAborted);
  res.once("finish", onFinished);
  res.once("close", onClosed);
  const timeout = setTimeout(() => {
    timedOut = true;
    abortUpstream(new Error(`upstream exceeded ${upstreamTimeoutMs}ms`));
  }, upstreamTimeoutMs);

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    upstream = await fetch(upstreamUrl(req.url), {
      method: req.method,
      headers: {
        "content-type": req.headers["content-type"] || "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      signal: controller.signal,
    });

    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": upstream.headers.get("cache-control") || "no-cache",
    });
    if (upstream.body) {
      // Preserve the upstream SSE stream. Buffering the whole response hides time-to-first-token
      // and prevents a timed-out L3 client from promptly releasing its upstream model request.
      await pipeline(Readable.fromWeb(upstream.body), res);
    } else {
      res.end();
    }
    console.log(JSON.stringify({ requestId, status: upstream.status, durationMs: Date.now() - startedAt, activeRequests }));
  } catch (error) {
    const message = String(error?.message || error);
    const status = timedOut ? 504 : controller.signal.aborted ? 499 : 502;
    console.warn(JSON.stringify({ requestId, status, durationMs: Date.now() - startedAt, activeRequests, cancelled: controller.signal.aborted, error: message }));
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(status === 499 ? 502 : status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: timedOut ? "upstream timeout" : message }));
    } else if (!res.destroyed) {
      res.destroy();
    }
  } finally {
    clearTimeout(timeout);
    req.off("aborted", onAborted);
    res.off("finish", onFinished);
    res.off("close", onClosed);
    activeRequests -= 1;
  }
});

server.listen(port, host, () => {
  console.log(`L2 proxy listening on http://${host}:${port}/v1`);
});
