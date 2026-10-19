# Local Session timeline disclosure — 2026-09-14

## Scope

`LocalRecordTrackingPage.tsx` / `TimelineEvent`: all local timeline event kinds
start collapsed as one line (original title, bounded text preview, desktop timestamp,
disclosure arrow). Click, Enter or Space toggles the full original body and metadata.
The shared tools tab uses the same component. Conversation bubbles, the model-request
tree, native event names, parsers, collection and attribution are unchanged.

Preview whitespace normalization and 500-character bounding affect only the summary;
the expanded command/content are unchanged. Collapsed bodies are not mounted.
Per-event React state survives normal data refresh via the existing eventId keys;
tab navigation or page reload may reset it. Failure badges remain visible when folded.
Keyboard focus and expanded state follow the ui-ux-pro-max accessibility guidance.

## Validation

- Web TypeScript check and production build passed.
- `verify-local-timeline-collapse-browser.mjs` passed against development, the isolated
  production canary (29655), and the deployed page (29654): seven synthetic rows covering
  all event kinds plus failure; original titles/full bodies; mouse and keyboard toggles;
  refresh preserves expansion; 375px card overflow/single-line checks; shared tools tab.
- Existing `verify-observer-content-browser.mjs` passed on the deployed page, including
  delayed content, authorization denial, refresh, and failure/retry behavior.
- Browser fixtures replace responses only inside the isolated test browser. No Session
  files, permission settings, historical events, or backend facts were edited.

## Deployment / rollback

Only the `web` Compose service was recreated. Current image:
`anysentry-web:timeline-collapse-20260914`, port 29654, health verified.
Old image retained as `anysentry-web:before-timeline-collapse-20260914`.
The old disposable Web container was replaced; its static assets are recoverable from
that image. API, databases, Observer (still stopped), and AgentSight were not restarted.

To retain this image on subsequent Compose updates, pass
`ANYSENTRY_WEB_IMAGE=anysentry-web:timeline-collapse-20260914`.
To roll back, use `ANYSENTRY_WEB_IMAGE=anysentry-web:before-timeline-collapse-20260914`
with the same `docker compose ... up -d --no-deps --no-build web` invocation and files:
`docker-compose.yml`, `docker-compose.override.yml`, `deploy/docker-compose.modules.yml`,
`deploy/docker-compose.harbor-records.yml`, project `anysentry`.
