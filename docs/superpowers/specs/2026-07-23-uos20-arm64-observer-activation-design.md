# UOS 20 ARM64 Observer Activation Design

## Objective

Prevent a healthy UOS Linux 4.19 Observer from being rolled back because its
journal output contains ANSI formatting, and expose accurate probe metadata in
collector health.

## Confirmed Failure

The `0.2.0-compat5` collector attached all eight legacy probes and started the
forwarder. `verify.sh` nevertheless counted zero because ANSI control sequences
separated `legacy probe attached` from the structured `program=` field. The
exact journal text was treated as a runtime health contract and caused a false
rollback.

## Design

1. Disable ANSI output in the Linux 4.19 legacy collector.
2. Track the latest CollectorHeartbeat metadata in `observer-forward.js` and
   include `attachedProbes` and `enabledFeatures` in forwarder heartbeats.
3. Make end-to-end event acceptance and collector health the activation gate.
   Require `attachedProbes >= 8`, `outputDropped = 0`, and `errorCount = 0`.
   Journal attachment lines remain diagnostic and never trigger rollback.
4. Suppress transient curl errors while waiting for the API; retain the final
   readiness timeout as the actionable failure.

## Acceptance

- Observer logs contain no ANSI escape bytes.
- Forwarder heartbeats preserve eight attached probes and enabled features.
- Installer verification triggers real exec/file activity and observes Source
  `acceptedEvents` increase without rejection.
- A missing or unhealthy collector still fails activation.
- Package checksums, ARM64/glibc/page-size checks, Redis, ClickHouse, API,
  Sentry, workers, and rollback behavior remain unchanged.

