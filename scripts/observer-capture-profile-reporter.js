'use strict';

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

/**
 * Drives the local ACK -> central materialization -> generation-bound grant handshake.
 *
 * File parsing and every safety decision remain inside FilterRulePublisher. This class only owns
 * bounded polling/retry and transport coordination, which keeps the Forwarder integration small
 * and makes the complete handshake independently testable with a mock central endpoint.
 */
class CaptureProfileReporter {
  constructor(options = {}) {
    this.publisher = options.publisher;
    this.postReport = options.postReport;
    this.pollIntervalMs = boundedNumber(options.pollIntervalMs, 250, 50, 60_000);
    this.retryBaseMs = boundedNumber(options.retryBaseMs, 1_000, this.pollIntervalMs, 60_000);
    this.retryMaxMs = boundedNumber(options.retryMaxMs, 30_000, this.retryBaseMs, 300_000);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.setInterval = options.setInterval ?? setInterval;
    this.clearInterval = options.clearInterval ?? clearInterval;
    this.onError = typeof options.onError === 'function' ? options.onError : () => {};
    this.timer = undefined;
    this.inFlight = false;
    this.retryAt = 0;
    this.consecutiveFailures = 0;
    this.stats = {
      polls: 0,
      ackAccepted: 0,
      ackRejected: 0,
      reports: 0,
      reportErrors: 0,
      centralAccepted: 0,
      centralRejected: 0,
    };
  }

  start() {
    if (this.timer || !this.publisher || typeof this.postReport !== 'function') return false;
    this.poll();
    this.timer = this.setInterval(() => this.poll(), this.pollIntervalMs);
    this.timer?.unref?.();
    return true;
  }

  close() {
    if (this.timer) this.clearInterval(this.timer);
    this.timer = undefined;
  }

  scheduleRetry() {
    this.consecutiveFailures++;
    const exponent = Math.min(8, this.consecutiveFailures - 1);
    this.retryAt = this.now() + Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** exponent));
  }

  poll() {
    this.stats.polls++;
    const consumed = this.publisher?.consumeAckFile?.();
    if (consumed?.accepted === true) this.stats.ackAccepted++;
    else if (consumed?.accepted === false) this.stats.ackRejected++;
    if (this.inFlight || this.now() < this.retryAt) return consumed;
    const request = this.publisher?.materializationReport?.();
    if (!request) return consumed;
    this.inFlight = true;
    this.stats.reports++;
    this.postReport(request, (error, response) => {
      this.inFlight = false;
      if (error) {
        this.stats.reportErrors++;
        this.scheduleRetry();
        this.onError(error);
        return;
      }
      if (!this.publisher.acceptCentralMaterialization(request.ack, response)) {
        this.stats.centralRejected++;
        this.scheduleRetry();
        return;
      }
      this.stats.centralAccepted++;
      this.consecutiveFailures = 0;
      this.retryAt = 0;
      // Publish the generation-bound grant immediately. Waiting for an unrelated event or the
      // normal debounce timer would leave central acceptance and local wire state inconsistent.
      this.publisher.flush();
    });
    return consumed;
  }

  metrics() {
    return {
      enabled: Boolean(this.publisher && typeof this.postReport === 'function'),
      inFlight: this.inFlight,
      retryAt: this.retryAt ? new Date(this.retryAt).toISOString() : undefined,
      consecutiveFailures: this.consecutiveFailures,
      ...this.stats,
    };
  }
}

module.exports = { CaptureProfileReporter };
