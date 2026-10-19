# Observer request body display repair — 2026-09-14

The Session detail showed `not_authorized` while all 83 Observer request bodies were readable.
Metadata-only reads shared the authorization-denied status. In the browser, the detail merge
memo omitted the asynchronously loaded content dependency; manual refresh omitted the content
request, and its 15-second freshness cache could suppress explicit revalidation.

Changes:
- Metadata-only reads return `not_requested`; actual permission denial remains `not_authorized`.
- Body completion invalidates the detail memo. Content is merged by interaction ID against current
  metadata so an older body response does not remove newly observed requests.
- Refresh and retry revalidate body state; new request IDs also trigger a body fetch on the active tab.
- Loading and request failure have explicit status/retry UI. Authorized empty bodies remain valid.
- Request counters say “模型请求”; Turn groups state their loaded-window scope rather than claiming
  an absolute Session turn number. This does not implement Tool Call-to-kernel-event causality.

Validation:
- API build, Web build, Web TypeScript check passed.
- `verify-observer-content-availability.mjs`: metadata-only, denied, readable empty body, deleted,
  unavailable, and foreign Session exclusion passed; metadata-only/denied paths never read bodies.
- Existing interaction service, content service and local-record regressions passed.
- `verify-observer-content-browser.mjs`: delayed completion rerenders, metadata does not claim denial,
  refresh observes permission denial and removes content, request failure/retry, and Turn labels passed
  on both development and deployed production bundles. Browser test bodies are synthetic.
- Real Session `01a01383-65fc-7c01-9401-1cc0cdef1ce9`, record `d11e7897d0401de8daa0bd33`:
  live API returned 83 `not_requested` rows for metadata and 83 `available` rows with content enabled.

Deployment:
- Narrow images `anysentry-api:observer-content-20260914` and
  `anysentry-web:observer-content-20260914` were built and deployed, retaining old containers.
- A concurrent deployment subsequently replaced both with `:modules`. We did not overwrite it.
  Current modules containers are healthy and contain the verified files:
  - Interaction service SHA256 `377887523dae98275b2399e2fe6315c2685b128a43860d306fa1f5ed24eba178`.
  - Web page chunk SHA256 `c7b23c9689137ddb577a1729f27b8cad2b7411be020051ba27c4ef416bddb74a`.
- No capture permission setting, Observer process, or historical event data was changed by this repair.

Build narrow images with an explicit archive context (the standard dockerignore excludes dist):

```bash
tar -cf - deploy/Dockerfile.observer-content-canary apps/api/dist/security-monitoring/interaction.service.js | docker build -f deploy/Dockerfile.observer-content-canary --target api -t anysentry-api:observer-content-20260914 -
tar -cf - deploy/Dockerfile.observer-content-canary apps/web/dist | docker build -f deploy/Dockerfile.observer-content-canary --target web -t anysentry-web:observer-content-20260914 -
```
