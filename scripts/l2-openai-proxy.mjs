import http from "node:http";

const targetBase = process.env.L2_TARGET_BASE || "https://api.pjlab.org.cn/v1";
const apiKey = process.env.PJLAB_API_KEY;
const host = process.env.L2_PROXY_HOST || "0.0.0.0";
const port = Number(process.env.L2_PROXY_PORT || 18051);

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
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const upstream = await fetch(upstreamUrl(req.url), {
      method: req.method,
      headers: {
        "content-type": req.headers["content-type"] || "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });

    const responseBody = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json",
    });
    res.end(responseBody);
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(error?.message || error) }));
  }
});

server.listen(port, host, () => {
  console.log(`L2 proxy listening on http://${host}:${port}/v1`);
});
