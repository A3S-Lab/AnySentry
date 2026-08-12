import { useRef, useState, type KeyboardEvent } from 'react';
import type { HomeLabels } from './home-copy';
import { Icon } from './icons';
import { useAnimatedSequence } from './useAnimatedSequence';

type SignatureLabels = HomeLabels['signature'];

export function SystemSignature({
  labels,
  route,
}: {
  labels: SignatureLabels;
  route: (pathname: string) => string;
}) {
  const [paused, setPaused] = useState(false);
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const { containerRef, setStep, step } = useAnimatedSequence({
    interval: 6800,
    length: 3,
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
    if (event.key === 'End') return moveFocus(2);
    moveFocus((index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3);
  };

  const groups = [labels.agents, labels.domains, labels.paths] as const;

  return (
    <div
      className="as-system-signature"
      data-active={step}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setPaused(false);
      }}
      onFocus={() => setPaused(true)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      ref={containerRef}
      data-reveal
    >
      <div
        className="as-system-signature__tabs"
        role="tablist"
        aria-label={labels.title}
      >
        {groups.map((group, index) => (
          <button
            aria-controls={`as-signature-panel-${index}`}
            aria-selected={step === index}
            className={step === index ? 'is-active' : ''}
            id={`as-signature-tab-${index}`}
            key={group.value}
            onClick={() => setStep(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
            ref={(node) => {
              tabsRef.current[index] = node;
            }}
            role="tab"
            tabIndex={step === index ? 0 : -1}
            type="button"
          >
            <strong>{group.value}</strong>
            <span>{group.label}</span>
            <i aria-hidden="true" />
          </button>
        ))}
      </div>

      <div className="as-system-signature__stage">
        {step === 0 && (
          <section
            aria-labelledby="as-signature-tab-0"
            className="as-signature-panel as-signature-panel--agents"
            id="as-signature-panel-0"
            role="tabpanel"
          >
            <header>
              <div>
                <span>01 · 角色接力</span>
                <h3>{labels.agents.title}</h3>
              </div>
              <p>{labels.agents.body}</p>
            </header>
            <ol className="as-agent-relay">
              {labels.agents.items.map((agent, index) => (
                <li
                  key={agent.name}
                  style={{ '--relay-index': index } as React.CSSProperties}
                >
                  <span className="as-agent-relay__number">0{index + 1}</span>
                  <div className="as-agent-relay__phase">{agent.phase}</div>
                  <div className="as-agent-relay__copy">
                    <small>{agent.english}</small>
                    <strong>{agent.name}</strong>
                    <p>{agent.body}</p>
                    <ul>
                      {agent.proof.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                  <i className="as-agent-relay__line" aria-hidden="true" />
                </li>
              ))}
            </ol>
            <a className="as-section-link" href={route(labels.agents.detail)}>
              {labels.agents.detailLabel}
              <Icon name="arrow" />
            </a>
          </section>
        )}

        {step === 1 && (
          <section
            aria-labelledby="as-signature-tab-1"
            className="as-signature-panel as-signature-panel--domains"
            id="as-signature-panel-1"
            role="tabpanel"
          >
            <header>
              <div>
                <span>02 · 风险面</span>
                <h3>{labels.domains.title}</h3>
              </div>
              <p>{labels.domains.body}</p>
            </header>
            <div className="as-risk-orbit">
              <div className="as-risk-orbit__core">
                <strong>08</strong>
                <span>RISK SLOTS</span>
                <small>L1 → L2 → L3</small>
              </div>
              {labels.domains.items.map((domain, index) => (
                <article
                  className={`as-risk-domain as-risk-domain--${index}`}
                  key={domain.name}
                >
                  <span>{domain.count}</span>
                  <div>
                    <strong>{domain.name}</strong>
                    <small>{domain.body}</small>
                    <ul>
                      {domain.risks.map((risk) => (
                        <li key={risk}>{risk}</li>
                      ))}
                    </ul>
                  </div>
                </article>
              ))}
              <svg
                aria-hidden="true"
                viewBox="0 0 1000 410"
                preserveAspectRatio="none"
              >
                <path d="M500 205C360 205 330 86 210 86" />
                <path d="M500 205C640 205 670 86 790 86" />
                <path d="M500 205C500 275 500 292 500 338" />
              </svg>
            </div>
            <footer>
              <span>{labels.domains.footnote}</span>
              <a
                className="as-section-link"
                href={route(labels.domains.detail)}
              >
                {labels.domains.detailLabel}
                <Icon name="arrow" />
              </a>
            </footer>
          </section>
        )}

        {step === 2 && (
          <section
            aria-labelledby="as-signature-tab-2"
            className="as-signature-panel as-signature-panel--paths"
            id="as-signature-panel-2"
            role="tabpanel"
          >
            <header>
              <div>
                <span>03 · 闭环</span>
                <h3>{labels.paths.title}</h3>
              </div>
              <p>{labels.paths.body}</p>
            </header>
            <div className="as-path-loop">
              {labels.paths.items.map((path, pathIndex) => (
                <article
                  className={`as-path-loop__rail as-path-loop__rail--${pathIndex}`}
                  key={path.name}
                >
                  <span>PATH 0{pathIndex + 1}</span>
                  <strong>{path.name}</strong>
                  <p>{path.body}</p>
                  <ol>
                    {path.steps.map((item, index) => (
                      <li key={item}>
                        <span>0{index + 1}</span>
                        <strong>{item}</strong>
                      </li>
                    ))}
                  </ol>
                </article>
              ))}
              <div className="as-path-loop__core">
                <Icon name="replay" />
                <strong>ONE LOOP</strong>
                <span>证据 · 批准 · 控制</span>
              </div>
            </div>
            <footer>
              <span>{labels.paths.footnote}</span>
              <a className="as-section-link" href={route(labels.paths.detail)}>
                {labels.paths.detailLabel}
                <Icon name="arrow" />
              </a>
            </footer>
          </section>
        )}
      </div>
    </div>
  );
}
