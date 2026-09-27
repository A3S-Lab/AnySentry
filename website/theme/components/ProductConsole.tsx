import { useRef, useState, type KeyboardEvent } from 'react';
import type { HomeLabels } from './home-copy';
import { Icon } from './icons';
import { useAnimatedSequence } from './useAnimatedSequence';
import { withBase } from '@rspress/core/runtime';

type ConsoleLabels = HomeLabels['console'];

function Overview({
  labels,
  chrome,
}: {
  labels: ConsoleLabels['overview'];
  chrome: ConsoleLabels['chrome'];
}) {
  return (
    <div className="as-console-view as-console-overview">
      <div className="as-console-view__title">
        <div>
          <span className="as-view-icon">
            <Icon name="eye" />
          </span>
          <strong>{labels.label}</strong>
        </div>
        <span className="as-live-chip">{labels.status}</span>
      </div>
      <div className="as-overview-stats">
        {labels.stats.map(([label, value], index) => (
          <div className={`as-stat as-stat--${index}`} key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <i>
              <span />
            </i>
          </div>
        ))}
      </div>
      <div className="as-overview-bottom">
        <div className="as-chart-card">
          <div className="as-card-title">
            <Icon name="timeline" />
            <span>{labels.chart}</span>
          </div>
          <div className="as-chart">
            <span>100</span>
            <span>50</span>
            <span>0</span>
            <svg
              aria-label={labels.chart}
              role="img"
              viewBox="0 0 620 160"
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="as-safe-area" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="#42dbc4" stopOpacity=".24" />
                  <stop offset="1" stopColor="#42dbc4" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="as-risk-area" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="#ff788f" stopOpacity=".28" />
                  <stop offset="1" stopColor="#ff788f" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                className="as-chart__grid"
                d="M0 22H620M0 80H620M0 138H620"
              />
              <path
                className="as-chart__safe-area"
                d="M0 36 C90 34 135 39 205 35 S330 33 410 39 S520 32 620 37V160H0Z"
              />
              <path
                className="as-chart__risk-area"
                d="M0 139 C110 138 170 138 250 137 S355 139 410 134 S465 120 500 133 S555 130 620 136V160H0Z"
              />
              <path
                className="as-chart__safe"
                d="M0 36 C90 34 135 39 205 35 S330 33 410 39 S520 32 620 37"
              />
              <path
                className="as-chart__risk"
                d="M0 139 C110 138 170 138 250 137 S355 139 410 134 S465 120 500 133 S555 130 620 136"
              />
              <circle
                className="as-chart__point is-safe"
                cx="410"
                cy="39"
                r="4"
              />
              <circle
                className="as-chart__point is-risk"
                cx="465"
                cy="120"
                r="5"
              />
            </svg>
            <div className="as-chart__axis" aria-hidden="true">
              <span>18:20</span>
              <span>18:24</span>
              <span>18:28</span>
              <span>18:32</span>
            </div>
            <div className="as-chart__legend">
              <span>
                <i />
                98 {chrome.safe}
              </span>
              <span>
                <i />2 {chrome.risk}
              </span>
            </div>
          </div>
        </div>
        <div className="as-tier-card">
          <div className="as-card-title">
            <Icon name="layers" />
            <span>{labels.tiers}</span>
          </div>
          <div className="as-tier-row">
            <span>L1 · Rules</span>
            <strong>100%</strong>
            <i>
              <b />
            </i>
          </div>
          <div className="as-tier-row is-l2">
            <span>L2 · LLM</span>
            <strong>60%</strong>
            <i>
              <b />
            </i>
          </div>
          <div className="as-tier-row is-l3">
            <span>L3 · Agent</span>
            <strong>opt-in</strong>
            <i>
              <b />
            </i>
          </div>
          <div className="as-tier-result">
            <span>GUARD</span>
            <strong>{chrome.requireApproval}</strong>
          </div>
        </div>
      </div>
    </div>
  );
}

function Topology({
  labels,
  chrome,
}: {
  labels: ConsoleLabels['topology'];
  chrome: ConsoleLabels['chrome'];
}) {
  return (
    <div className="as-console-view as-console-topology">
      <div className="as-console-view__title">
        <div>
          <span className="as-view-icon">
            <Icon name="network" />
          </span>
          <strong>{labels.label}</strong>
        </div>
        <span>{labels.meta}</span>
      </div>
      <div className="as-topology-counts">
        {labels.counts.map(([label, value], index) => (
          <div
            className={`as-topology-count as-topology-count--${index}`}
            key={label}
          >
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="as-topology-map">
        <div className="as-topology-zone as-topology-zone--intent">
          {chrome.intentZone}
        </div>
        <div className="as-topology-zone as-topology-zone--runtime">
          {chrome.runtimeZone}
        </div>
        <div className="as-topology-zone as-topology-zone--control">
          {chrome.controlZone}
        </div>
        <svg
          aria-hidden="true"
          className="as-topology-lines"
          viewBox="0 0 1000 320"
          preserveAspectRatio="none"
        >
          <defs>
            <filter id="as-topology-glow">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <path
            className="is-observed"
            d="M178 94C300 94 315 58 430 58M178 94C300 94 315 142 430 142M178 94C340 94 415 236 650 236"
          />
          <path
            className="is-risk"
            d="M560 58C650 58 676 96 760 96M560 142C650 142 676 96 760 96"
          />
          <path
            className="is-control"
            d="M560 142C650 142 676 174 760 174M650 236C730 236 744 174 760 174"
          />
          <circle className="is-observed" cx="315" cy="78" r="4" />
          <circle className="is-risk" cx="676" cy="96" r="4" />
          <circle className="is-control" cx="676" cy="174" r="4" />
        </svg>
        <div className="as-topology-node as-topology-node--agent">
          <span>
            <Icon name="identity" />
          </span>
          <div>
            <strong>release-agent</strong>
            <small>repo://payments</small>
          </div>
          <code>26 events</code>
        </div>
        <div className="as-topology-node as-topology-node--tool">
          <span>
            <Icon name="terminal" />
          </span>
          <div>
            <strong>bash</strong>
            <small>ToolExec</small>
          </div>
          <code>12</code>
        </div>
        <div className="as-topology-node as-topology-node--network">
          <span>
            <Icon name="network" />
          </span>
          <div>
            <strong>169.254.169.254</strong>
            <small>metadata endpoint</small>
          </div>
          <code>1</code>
        </div>
        <div className="as-topology-node as-topology-node--file">
          <span>
            <Icon name="bundle" />
          </span>
          <div>
            <strong>deploy.yaml</strong>
            <small>workspace file</small>
          </div>
          <code>4</code>
        </div>
        <div className="as-topology-node as-topology-node--risk">
          <span>
            <Icon name="shield" />
          </span>
          <div>
            <strong>systemic_risk</strong>
            <small>critical · L1</small>
          </div>
          <code>open</code>
        </div>
        <div className="as-topology-node as-topology-node--approval">
          <span>
            <Icon name="action" />
          </span>
          <div>
            <strong>require approval</strong>
            <small>guard decision</small>
          </div>
          <code>pending</code>
        </div>
        <div className="as-topology-legend">
          <span>
            <i /> {chrome.observedEdge}
          </span>
          <span>
            <i /> {chrome.riskPropagation}
          </span>
          <span>
            <i /> {chrome.controlDecision}
          </span>
        </div>
      </div>
    </div>
  );
}

function Evidence({ labels }: { labels: ConsoleLabels['evidence'] }) {
  return (
    <div className="as-console-view as-console-evidence">
      <div className="as-console-view__title">
        <div>
          <span className="as-view-icon">
            <Icon name="bundle" />
          </span>
          <strong>{labels.label}</strong>
        </div>
        <span>{labels.meta}</span>
      </div>
      <div className="as-evidence-layout">
        <div className="as-evidence-primary">
          <div className="as-card-title">
            <Icon name="timeline" />
            <span>{labels.timeline}</span>
            <code>4</code>
          </div>
          <div className="as-evidence-timeline">
            {labels.events.map((event, index) => (
              <div
                className={`as-evidence-event as-evidence-event--${index}`}
                key={event}
              >
                <span>{index + 1}</span>
                <div>
                  <strong>{event}</strong>
                  <small>18:32:0{index + 2} · evt_8c5667…</small>
                  <span className="as-evidence-event__hash">
                    sha256:
                    {
                      ['09af…e12c', 'e12c…77bd', '77bd…04a8', '04a8…b91f'][
                        index
                      ]
                    }
                  </span>
                </div>
                <code>
                  {index < 2 ? 'observed' : index === 2 ? 'pending' : 'opened'}
                </code>
              </div>
            ))}
          </div>
        </div>
        <div className="as-evidence-side">
          <div>
            <span>SCOPE</span>
            <strong>{labels.scope}</strong>
            <small>release-agent · deploy-42</small>
          </div>
          <div>
            <span>RISK</span>
            <strong className="is-risk">critical</strong>
            <small>systemic_risk</small>
          </div>
          <div>
            <span>ACTION</span>
            <strong className="is-action">require_approval</strong>
            <small>decision recorded</small>
          </div>
          <div>
            <span>INTEGRITY</span>
            <strong className="is-safe">source-linked</strong>
            <small>redaction applied</small>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ProductConsole({ labels }: { labels: ConsoleLabels }) {
  const [paused, setPaused] = useState(false);
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const { containerRef, setStep, step } = useAnimatedSequence({
    interval: 5200,
    length: labels.tabs.length,
    paused,
    reducedStep: 0,
  });

  const moveFocus = (index: number) => {
    setStep(index);
    tabsRef.current[index]?.focus();
  };
  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') return moveFocus(0);
    if (event.key === 'End') return moveFocus(labels.tabs.length - 1);
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    moveFocus((index + direction + labels.tabs.length) % labels.tabs.length);
  };

  return (
    <div
      className="as-product-window"
      data-step={step}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setPaused(false);
      }}
      onFocus={() => setPaused(true)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      ref={containerRef}
    >
      <div className="as-product-window__bar">
        <div className="as-product-window__signals" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div className="as-product-brand">
          <span>
            <img alt="" src={withBase('/anysentry-mark-reversed.svg')} />
          </span>
          <strong>AnySentry</strong>
          <small>SECURITY CENTER</small>
        </div>
        <div
          className="as-product-tabs"
          role="tablist"
          aria-label={labels.eyebrow}
        >
          {labels.tabs.map((tab, index) => (
            <button
              aria-controls="as-product-panel"
              aria-label={labels.tabLabels[index]}
              aria-selected={step === index}
              className={step === index ? 'is-active' : ''}
              id={`as-product-tab-${index}`}
              key={tab}
              onClick={() => setStep(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
              ref={(node) => {
                tabsRef.current[index] = node;
              }}
              role="tab"
              tabIndex={step === index ? 0 : -1}
              type="button"
            >
              {tab}
            </button>
          ))}
        </div>
        <div className="as-product-window__status">
          <span>
            <i /> prod-eu-1
          </span>
          <span className="as-demo-chip">{labels.synthetic}</span>
        </div>
      </div>
      <div className="as-product-window__body">
        <aside className="as-product-nav" aria-label={labels.navigationLabel}>
          {labels.nav.map((item, index) => (
            <span
              className={
                index === (step === 0 ? 0 : step === 1 ? 3 : 4)
                  ? 'is-active'
                  : ''
              }
              key={item}
            >
              <i>
                <Icon
                  name={
                    index === 2
                      ? 'identity'
                      : index === 3
                        ? 'network'
                        : index === 6
                          ? 'bundle'
                          : 'timeline'
                  }
                />
              </i>
              {item}
            </span>
          ))}
        </aside>
        <div
          aria-labelledby={`as-product-tab-${step}`}
          className="as-product-panel"
          id="as-product-panel"
          role="tabpanel"
        >
          {step === 0 && (
            <Overview labels={labels.overview} chrome={labels.chrome} />
          )}
          {step === 1 && (
            <Topology labels={labels.topology} chrome={labels.chrome} />
          )}
          {step === 2 && <Evidence labels={labels.evidence} />}
        </div>
      </div>
    </div>
  );
}
