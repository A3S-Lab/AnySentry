import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import * as https from 'node:https';
import { EventMeta } from './types';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

/**
 * Maps an observer identity (k8s pod-uid or container-id) to the real pod name + namespace, by
 * listing pods from the in-cluster k8s API every 30s. This turns "agent://<uuid>" into the real
 * agent name and lets the dashboard FOCUS ON AGENT WORKLOADS — dropping node/infra activity
 * (kube-system, the platform namespace, host processes) so the view is about agents, not the node.
 *
 * Fail-open: until the pod map loads (or if the API is unreachable), nothing is filtered — events
 * are recorded raw, so the dashboard is never accidentally emptied.
 */
@Injectable()
export class KubeIdentityService implements OnModuleInit, OnModuleDestroy {
  private byId = new Map<string, { name: string; namespace: string }>();
  private ready = false;
  private timer?: NodeJS.Timeout;
  // Pod-identity enrichment only makes sense in-cluster: auto-enabled when running in Kubernetes
  // (KUBERNETES_SERVICE_HOST is set), and a no-op standalone so it never probes the K8s API.
  // Set ANYSENTRY_KUBE_ENRICH=off to disable it even in-cluster.
  private readonly enabled = !!process.env.KUBERNETES_SERVICE_HOST && process.env.ANYSENTRY_KUBE_ENRICH !== 'off';
  // The namespaces where AI-agent workloads run. We list only these (least-privilege: a namespaced
  // Role, not cluster-wide). Anything not resolved to a pod here is host/infra → dropped.
  private readonly agentNs = (process.env.ANYSENTRY_AGENT_NAMESPACES ?? 'default')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  onModuleInit(): void {
    if (!this.enabled) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 30_000);
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Enrich an event's identity to the real agent pod, or return null to DROP it (infra / host). */
  enrich(meta: EventMeta): EventMeta | null {
    const pod = this.byId.get(meta.agentId);
    if (!pod) return this.ready ? null : meta; // ready: not an agent workload → drop; else fail-open
    return { ...meta, agentId: pod.name, sessionId: pod.name, workspacePath: `${pod.namespace}/${pod.name}` };
  }

  private async refresh(): Promise<void> {
    const next = new Map<string, { name: string; namespace: string }>();
    for (const ns of this.agentNs) {
      try {
        const pods = await this.listPods(ns);
        for (const p of pods.items ?? []) {
          const info = { name: p.metadata?.name ?? 'unknown', namespace: p.metadata?.namespace ?? ns };
          if (p.metadata?.uid) next.set(p.metadata.uid, info);
          for (const cs of p.status?.containerStatuses ?? []) {
            const id = String(cs.containerID ?? '').replace(/^[a-z0-9]+:\/\//, '');
            if (id) {
              next.set(id, info);
              next.set(id.slice(0, 12), info);
            }
          }
        }
      } catch {
        // keep going; one namespace's transient error shouldn't blank the rest
      }
    }
    if (next.size > 0) {
      this.byId = next;
      this.ready = true;
    }
  }

  private listPods(ns: string): Promise<{ items?: Array<Record<string, any>> }> {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443';
    const token = readFileSync(`${SA}/token`, 'utf8');
    const ca = readFileSync(`${SA}/ca.crt`);
    return new Promise((resolve, reject) => {
      const req = https.get(
        { host, port, path: `/api/v1/namespaces/${ns}/pods?limit=2000`, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, ca },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(8000, () => req.destroy(new Error('k8s api timeout')));
    });
  }
}
