import { Kafka, logLevel, Producer, SASLOptions } from 'kafkajs';
import {
  SupplyChainRuntimeContext,
  VulnerabilityAssessment,
  WorkspaceRegistration,
} from './supply-chain.types';

export const DEFAULT_SUPPLY_CHAIN_CONTEXT_TOPIC = 'anysentry.supply-chain.context.v1';

export function buildSupplyChainRuntimeContext(
  workspace: WorkspaceRegistration,
  assessment: VulnerabilityAssessment,
): SupplyChainRuntimeContext {
  return {
    schemaVersion: 'anysentry.supply_chain_runtime_context.v1',
    workspaceId: workspace.workspaceId,
    workspacePathFingerprint: workspace.workspacePathFingerprint,
    dependencySnapshotId: assessment.dependencySnapshotId,
    vulnerabilityAssessmentId: assessment.vulnerabilityAssessmentId,
    assessedAt: assessment.assessedAt,
    assessmentStatus: assessment.assessmentStatus,
    intelligenceRevision: assessment.intelligenceRevision,
    findings: assessment.findings
      .filter((finding) => finding.status === 'open')
      .map((finding) => ({
        findingId: finding.findingId,
        ecosystem: finding.component.ecosystem,
        packageName: finding.component.packageName,
        version: finding.component.version,
        dependencyScope: finding.component.dependencyScope,
        direct: finding.component.direct,
        purl: finding.component.purl,
        vulnerabilityId: finding.vulnerability.id,
        aliases: finding.vulnerability.aliases,
        summary: finding.vulnerability.summary,
      })),
    shadow: true,
  };
}

function kafkaSasl(): SASLOptions | undefined {
  const username = process.env.ANYSENTRY_STREAM_USERNAME;
  const password = process.env.ANYSENTRY_STREAM_PASSWORD;
  const mechanism = process.env.ANYSENTRY_STREAM_SASL_MECHANISM;
  if (!username || !password) return undefined;
  if (mechanism === 'plain') return { mechanism: 'plain', username, password };
  if (mechanism === 'scram-sha-256') return { mechanism: 'scram-sha-256', username, password };
  if (mechanism === 'scram-sha-512') return { mechanism: 'scram-sha-512', username, password };
  return undefined;
}

export class SupplyChainRuntimePublisher {
  readonly enabled = process.env.ANYSENTRY_SUPPLY_CHAIN_RUNTIME === 'on';
  private producer?: Producer;
  private readonly topic = process.env.ANYSENTRY_SUPPLY_CHAIN_CONTEXT_TOPIC
    || DEFAULT_SUPPLY_CHAIN_CONTEXT_TOPIC;

  async connect(): Promise<void> {
    if (!this.enabled || this.producer) return;
    const brokers = (process.env.ANYSENTRY_STREAM_BOOTSTRAP_SERVERS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (brokers.length === 0) {
      throw new Error('ANYSENTRY_STREAM_BOOTSTRAP_SERVERS is required for supply-chain runtime publishing');
    }
    const sasl = kafkaSasl();
    const kafka = new Kafka({
      clientId: 'anysentry-supply-chain-assessment',
      brokers,
      logLevel: logLevel.WARN,
      ssl: process.env.ANYSENTRY_STREAM_SECURITY_PROTOCOL === 'SSL'
        || process.env.ANYSENTRY_STREAM_SECURITY_PROTOCOL === 'SASL_SSL',
      ...(sasl ? { sasl } : {}),
    });
    this.producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    await this.producer.connect();
  }

  async publish(context: SupplyChainRuntimeContext): Promise<void> {
    if (!this.enabled) return;
    if (!this.producer) await this.connect();
    await this.producer!.send({
      topic: this.topic,
      acks: -1,
      messages: [{
        key: context.workspacePathFingerprint,
        value: JSON.stringify(context),
        headers: {
          'content-type': 'application/json',
          'schema-version': context.schemaVersion,
          'workspace-id': context.workspaceId,
        },
      }],
    });
  }

  async close(): Promise<void> {
    await this.producer?.disconnect();
    this.producer = undefined;
  }
}
