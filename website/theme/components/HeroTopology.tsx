import { withBase } from '@rspress/core/runtime';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { HomeLabels, Locale } from './home-copy';
import { Icon, type IconName } from './icons';

type ConsoleLabels = HomeLabels['console'];

type HeroTopologyProps = {
  labels: ConsoleLabels;
  locale: Locale;
};

type PlaybackState = 'active' | 'complete' | 'pending';

const FINAL_STAGE = 4;
const STEP_DELAY = 820;

const nodeIcons: Record<string, IconName> = {
  agent: 'identity',
  tool: 'terminal',
  network: 'network',
  file: 'bundle',
  risk: 'shield',
  approval: 'action',
};

function stateAt(stage: number, requiredStage: number): PlaybackState {
  if (stage < requiredStage) return 'pending';
  if (stage === requiredStage) return 'active';
  return 'complete';
}

export function HeroTopology({ labels, locale }: HeroTopologyProps) {
  const frameRef = useRef<HTMLElement>(null);
  const hasAutoPlayedRef = useRef(false);
  const [stage, setStage] = useState(0);
  const [runId, setRunId] = useState(0);
  const [running, setRunning] = useState(false);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const titleId = useId();
  const summaryId = useId();
  const english = locale === 'en';

  const replayLabel = english ? 'Replay runtime judgment' : '重播判断过程';
  const summary = english
    ? `Agent topology: release-agent invokes bash, reaches the metadata endpoint and deploy.yaml, propagates a systemic risk, then records ${labels.chrome.requireApproval}.`
    : `智能体拓扑：release-agent 调用 bash，触达云元数据端点并关联 deploy.yaml，风险传播为系统性风险，最终记录${labels.chrome.requireApproval}。`;

  const startPlayback = useCallback(() => {
    const shouldReduce =
      reducedMotion ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    hasAutoPlayedRef.current = true;
    setRunId((current) => current + 1);
    setStage(shouldReduce ? FINAL_STAGE : 0);
    setRunning(!shouldReduce);
  }, [reducedMotion]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => {
      setReducedMotion(media.matches);
      if (media.matches) {
        setStage(FINAL_STAGE);
        setRunning(false);
      }
    };

    updatePreference();
    media.addEventListener('change', updatePreference);
    return () => media.removeEventListener('change', updatePreference);
  }, []);

  useEffect(() => {
    const updateVisibility = () => setPageVisible(!document.hidden);
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () =>
      document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    if (!('IntersectionObserver' in window)) {
      setInView(true);
      if (!hasAutoPlayedRef.current) startPlayback();
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = Boolean(entry?.isIntersecting);
        const ready = visible && (entry?.intersectionRatio ?? 0) >= 0.25;
        setInView(visible);
        if (ready && !hasAutoPlayedRef.current) startPlayback();
      },
      { rootMargin: '-6% 0px -6%', threshold: [0, 0.25, 0.6] },
    );

    observer.observe(frame);
    return () => observer.disconnect();
  }, [startPlayback]);

  useEffect(() => {
    if (
      !running ||
      !inView ||
      !pageVisible ||
      reducedMotion ||
      stage >= FINAL_STAGE
    ) {
      if (running && stage >= FINAL_STAGE) setRunning(false);
      return;
    }

    const timer = window.setTimeout(
      () => setStage((current) => Math.min(current + 1, FINAL_STAGE)),
      STEP_DELAY,
    );
    return () => window.clearTimeout(timer);
  }, [inView, pageVisible, reducedMotion, runId, running, stage]);

  const nodes = [
    {
      key: 'agent',
      stage: 0,
      title: 'release-agent',
      meta: 'repo://payments',
      value: '26 events',
    },
    {
      key: 'tool',
      stage: 1,
      title: 'bash',
      meta: 'ToolExec',
      value: '12',
    },
    {
      key: 'network',
      stage: 2,
      title: '169.254.169.254',
      meta: 'metadata endpoint',
      value: '1',
    },
    {
      key: 'file',
      stage: 2,
      title: 'deploy.yaml',
      meta: 'workspace file',
      value: '4',
    },
    {
      key: 'risk',
      stage: 3,
      title: 'systemic_risk',
      meta: 'critical · L1',
      value: 'open',
    },
    {
      key: 'approval',
      stage: 4,
      title: labels.chrome.requireApproval,
      meta: 'guard decision',
      value: 'pending',
    },
  ] as const;

  return (
    <figure
      aria-describedby={summaryId}
      aria-labelledby={titleId}
      className="as-hero-topology"
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      data-running={running ? 'true' : 'false'}
      data-stage={stage}
      ref={frameRef}
    >
      <header className="as-hero-topology__bar">
        <div className="as-hero-topology__signals" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div className="as-hero-topology__brand">
          <span>
            <img alt="" src={withBase('/anysentry-mark-reversed.svg')} />
          </span>
          <strong>AnySentry</strong>
          <small>SECURITY CENTER</small>
        </div>
        <div className="as-hero-topology__status">
          <i aria-hidden="true" />
          <span>prod-eu-1</span>
          <small>{labels.synthetic}</small>
        </div>
        <button
          aria-label={replayLabel}
          className="as-hero-topology__replay"
          onClick={startPlayback}
          type="button"
        >
          <Icon name="replay" />
          <span>{replayLabel}</span>
        </button>
      </header>

      <div className="as-hero-topology__body">
        <aside
          aria-label={labels.navigationLabel}
          className="as-hero-topology__rail"
        >
          {labels.nav.slice(0, 6).map((item, index) => (
            <span
              data-current={index === 3 ? 'true' : 'false'}
              key={item}
              title={item}
            >
              <Icon
                name={
                  index === 2
                    ? 'identity'
                    : index === 3
                      ? 'network'
                      : index === 5
                        ? 'action'
                        : 'timeline'
                }
              />
              <small>{item}</small>
            </span>
          ))}
        </aside>

        <section className="as-hero-topology__workspace">
          <div className="as-hero-topology__heading">
            <div>
              <span className="as-hero-topology__heading-icon">
                <Icon name="network" />
              </span>
              <div>
                <small>{labels.eyebrow}</small>
                <strong id={titleId}>{labels.topology.label}</strong>
              </div>
            </div>
            <code>{labels.topology.meta}</code>
          </div>

          <div className="as-hero-topology__metrics">
            {labels.topology.counts.map(([label, value], index) => (
              <div data-tone={index} key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>

          <div className="as-hero-topology__map">
            <div className="as-hero-topology__zones" aria-hidden="true">
              <span>{labels.chrome.intentZone}</span>
              <span>{labels.chrome.runtimeZone}</span>
              <span>{labels.chrome.controlZone}</span>
            </div>

            <svg
              aria-hidden="true"
              className="as-hero-topology__edges"
              preserveAspectRatio="none"
              viewBox="0 0 760 360"
            >
              <path
                className="as-hero-topology__edge as-hero-topology__edge--observed"
                d="M122 155C208 155 218 83 310 83"
                data-state={stateAt(stage, 1)}
              />
              <path
                className="as-hero-topology__edge as-hero-topology__edge--observed"
                d="M390 83C465 83 458 158 523 158M390 83C455 83 424 275 523 275"
                data-state={stateAt(stage, 2)}
              />
              <path
                className="as-hero-topology__edge as-hero-topology__edge--risk"
                d="M588 158C630 158 630 122 671 122M588 275C658 275 614 122 671 122"
                data-state={stateAt(stage, 3)}
              />
              <path
                className="as-hero-topology__edge as-hero-topology__edge--control"
                d="M713 144C713 178 713 203 713 237"
                data-state={stateAt(stage, 4)}
              />
            </svg>

            <div className="as-hero-topology__nodes">
              {nodes.map((node) => (
                <article
                  className="as-hero-topology__node"
                  data-node={node.key}
                  data-state={stateAt(stage, node.stage)}
                  key={node.key}
                >
                  <span className="as-hero-topology__node-icon">
                    <Icon name={nodeIcons[node.key]} />
                  </span>
                  <div>
                    <strong>{node.title}</strong>
                    <small>{node.meta}</small>
                  </div>
                  <code>{node.value}</code>
                </article>
              ))}
            </div>

            <div className="as-hero-topology__legend" aria-hidden="true">
              <span data-edge="observed">
                <i /> {labels.chrome.observedEdge}
              </span>
              <span data-edge="risk">
                <i /> {labels.chrome.riskPropagation}
              </span>
              <span data-edge="control">
                <i /> {labels.chrome.controlDecision}
              </span>
            </div>
          </div>
        </section>
      </div>

      <figcaption className="as-hero-topology__sr" id={summaryId}>
        {summary}
      </figcaption>
    </figure>
  );
}
