import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { HomeLabels } from './home-copy';
import { Icon, type IconName } from './icons';

type FeatureRailProps = {
  labels: HomeLabels;
  route: (pathname: string) => string;
};

type Chapter = {
  code: string;
  title: string;
  kicker: string;
  body: string;
  icon: IconName;
  href: string;
  detailLabel: string;
};

function StageShell({
  children,
  eyebrow,
  title,
}: {
  children: ReactNode;
  eyebrow: string;
  title: string;
}) {
  return (
    <div className="as-feature-rail__stage-shell">
      <header className="as-feature-rail__stage-heading">
        <span>{eyebrow}</span>
        <h3>{title}</h3>
      </header>
      {children}
    </div>
  );
}

function CaptureStage({ labels }: { labels: HomeLabels }) {
  const stage = labels.loop.stages[0];

  return (
    <StageShell
      eyebrow={labels.loop.input}
      title={labels.hero.visual.eventLabel}
    >
      <div className="as-feature-rail__capture">
        <div className="as-feature-rail__stream">
          <header>
            <span>{labels.loop.input}</span>
            <small>18:32:02.184</small>
          </header>
          <div className="as-feature-rail__signal">
            <span className="as-feature-rail__signal-icon">
              <Icon name="terminal" />
            </span>
            <div>
              <strong>curl 169.254.169.254/latest/meta-data</strong>
              <small>release-agent · payments-api · deploy-42</small>
            </div>
            <i>ToolExec</i>
          </div>
          <ol className="as-feature-rail__event-list">
            {stage.rows.map(([key, value], index) => (
              <li key={key}>
                <span>0{index + 1}</span>
                <code>{key}</code>
                <strong>{value}</strong>
              </li>
            ))}
          </ol>
        </div>

        <aside className="as-feature-rail__capture-facts">
          {labels.context.facts.map((fact) => (
            <article key={fact.label}>
              <span>{fact.value}</span>
              <div>
                <strong>{fact.label}</strong>
                <p>{fact.detail}</p>
              </div>
            </article>
          ))}
        </aside>
      </div>
    </StageShell>
  );
}

function IdentityStage({ labels }: { labels: HomeLabels }) {
  const stage = labels.loop.stages[1];
  const context = labels.context.comparison.contexts[1];

  return (
    <StageShell
      eyebrow={labels.hero.visual.contextLabel}
      title={context.environment}
    >
      <div className="as-feature-rail__identity-map">
        <div className="as-feature-rail__identity-chain">
          {stage.rows.slice(0, 3).map(([key, value], index) => (
            <div className="as-feature-rail__entity" key={key}>
              <span>0{index + 1}</span>
              <small>{key}</small>
              <strong>{value}</strong>
            </div>
          ))}
          <div className="as-feature-rail__identity-line" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        </div>

        <div className="as-feature-rail__context-record">
          <header>
            <span>{labels.context.comparison.systemLabel}</span>
            <strong>{context.environment}</strong>
            <small>{context.meta}</small>
          </header>
          <dl>
            {context.signals.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <footer>
            <Icon name="identity" />
            <span>{stage.rows[3]?.[0]}</span>
            <strong>{stage.rows[3]?.[1]}</strong>
          </footer>
        </div>
      </div>
    </StageShell>
  );
}

function JudgmentStage({ labels }: { labels: HomeLabels }) {
  const stage = labels.loop.stages[2];

  return (
    <StageShell
      eyebrow={labels.hero.visual.decision}
      title={`${labels.hero.visual.riskLabel} · ${labels.hero.visual.risk}`}
    >
      <div className="as-feature-rail__judgment">
        <div className="as-feature-rail__judgment-input">
          <header>
            <Icon name="terminal" />
            <span>{labels.hero.visual.eventLabel}</span>
          </header>
          <code>{labels.hero.visual.event}</code>
          <small>{labels.hero.visual.eventMeta}</small>
          <dl>
            {stage.rows.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <footer className="as-feature-rail__judgment-identity">
            <div>
              <span>{labels.loop.identity.label}</span>
              <strong>{labels.loop.identity.value}</strong>
            </div>
            <code>{labels.loop.identity.trace}</code>
          </footer>
        </div>

        <ol className="as-feature-rail__tiers">
          {labels.hero.visual.stages.map((tier, index) => (
            <li key={tier.tier}>
              <span>{tier.tier}</span>
              <div>
                <small>0{index + 1}</small>
                <strong>{tier.label}</strong>
                <p>{tier.value}</p>
              </div>
              <i aria-hidden="true" />
            </li>
          ))}
        </ol>

        <div className="as-feature-rail__verdict">
          <small>{labels.hero.visual.riskLabel}</small>
          <strong>{labels.hero.visual.risk}</strong>
          <span>{labels.hero.visual.verdict}</span>
        </div>
      </div>
    </StageShell>
  );
}

function GuardStage({ labels }: { labels: HomeLabels }) {
  const { approval } = labels.governance;
  const captureRows = labels.loop.stages[0].rows;
  const contextRows = labels.loop.stages[1].rows;
  const governanceRows = labels.loop.stages[3].rows;

  return (
    <StageShell eyebrow={approval.label} title={approval.title}>
      <div className="as-feature-rail__guard">
        <article className="as-feature-rail__approval-card">
          <header>
            <span>
              <Icon name="decision" />
            </span>
            <div>
              <small>{labels.governance.loop[3].number}</small>
              <strong>{labels.governance.loop[3].title}</strong>
            </div>
            <i>APPROVED</i>
          </header>
          <p>{approval.body}</p>
          <dl className="as-feature-rail__approval-facts">
            {governanceRows.slice(0, 2).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <div className="as-feature-rail__approval-integrity">
            <Icon name="check" />
            <span>{labels.loop.identity.integrity}</span>
          </div>
          <ul>
            {approval.meta.map((item) => (
              <li key={item}>
                <Icon name="check" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </article>

        <div className="as-feature-rail__guard-gate">
          <span>{labels.governance.loop[4].number}</span>
          <Icon name="shield" />
          <strong>{labels.governance.loop[4].title}</strong>
          <small>{labels.hero.visual.guard}</small>
        </div>

        <article className="as-feature-rail__guard-result">
          <header>
            <span>{labels.hero.visual.verdictLabel}</span>
            <small>policy/runtime-metadata-v3</small>
          </header>
          <div>
            <code>{labels.hero.visual.event}</code>
            <dl className="as-feature-rail__guard-facts">
              {[captureRows[0], contextRows[2], governanceRows[0]].map(
                ([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                  </div>
                ),
              )}
            </dl>
            <strong>{labels.hero.visual.verdict}</strong>
          </div>
          <footer>
            <span>scope</span>
            <strong>prod-payments/*</strong>
            <i>18:33:14.806</i>
          </footer>
        </article>
      </div>
    </StageShell>
  );
}

function EvidenceStage({ labels }: { labels: HomeLabels }) {
  return (
    <StageShell
      eyebrow={labels.console.evidence.meta}
      title={labels.loop.identity.integrity}
    >
      <div className="as-feature-rail__evidence">
        <div className="as-feature-rail__evidence-manifest">
          <header>
            <span>
              <Icon name="bundle" />
            </span>
            <div>
              <small>{labels.console.evidence.scope}</small>
              <strong>{labels.console.evidence.label}</strong>
            </div>
            <i>sha256 · verified</i>
          </header>
          <dl>
            {labels.loop.audit.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="as-feature-rail__audit-timeline">
          <header>
            <span>{labels.console.evidence.timeline}</span>
            <small>{labels.loop.identity.value}</small>
          </header>
          <ol>
            {labels.console.evidence.events.map((event, index) => (
              <li key={event}>
                <span>0{index + 1}</span>
                <i aria-hidden="true" />
                <strong>{event}</strong>
                <small>18:32:0{index + 2}</small>
              </li>
            ))}
          </ol>
          <footer>
            <Icon name="check" />
            <span>{labels.loop.identity.integrity}</span>
          </footer>
        </div>
      </div>
    </StageShell>
  );
}

export function FeatureRail({ labels, route }: FeatureRailProps) {
  const [activeChapter, setActiveChapter] = useState(0);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const instanceId = useId().replace(/:/g, '');

  const chapters: Chapter[] = [
    {
      code: '01',
      title: labels.governance.loop[0].title,
      kicker: labels.loop.stages[0].subtitle,
      body: labels.loop.stages[0].summary,
      icon: 'network',
      href: route('/architecture/'),
      detailLabel: labels.context.detailLabel,
    },
    {
      code: '02',
      title: labels.governance.loop[1].title,
      kicker: labels.loop.stages[1].subtitle,
      body: labels.loop.stages[1].summary,
      icon: 'identity',
      href: route('/architecture/'),
      detailLabel: labels.context.detailLabel,
    },
    {
      code: '03',
      title: labels.governance.loop[2].title,
      kicker: labels.loop.stages[2].subtitle,
      body: labels.loop.stages[2].summary,
      icon: 'layers',
      href: route('/judgment/'),
      detailLabel: labels.governance.detailLabel,
    },
    {
      code: '04',
      title: `${labels.governance.loop[3].title} + ${labels.governance.loop[4].title}`,
      kicker: labels.governance.paths[1].code,
      body: labels.governance.approval.body,
      icon: 'shield',
      href: route('/safety-loop/'),
      detailLabel: labels.governance.detailLabel,
    },
    {
      code: '05',
      title: `${labels.console.evidence.label} / ${labels.governance.loop[5].title}`,
      kicker: labels.trust.items[1].code,
      body: labels.trust.items[1].body,
      icon: 'bundle',
      href: route('/evidence/'),
      detailLabel: labels.trust.detailLabel,
    },
  ];

  const selectChapter = (index: number) => {
    setActiveChapter(index);
    buttonRefs.current[index]?.focus();
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex = index;

    if (event.key === 'ArrowDown') {
      nextIndex = (index + 1) % chapters.length;
    } else if (event.key === 'ArrowUp') {
      nextIndex = (index - 1 + chapters.length) % chapters.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = chapters.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    selectChapter(nextIndex);
  };

  const active = chapters[activeChapter];
  const stages = [
    <CaptureStage labels={labels} key="capture" />,
    <IdentityStage labels={labels} key="identity" />,
    <JudgmentStage labels={labels} key="judgment" />,
    <GuardStage labels={labels} key="guard" />,
    <EvidenceStage labels={labels} key="evidence" />,
  ];

  return (
    <div className="as-feature-rail">
      <aside className="as-feature-rail__chapters">
        <div
          aria-label={labels.governance.title}
          className="as-feature-rail__tablist"
          role="tablist"
          aria-orientation="vertical"
        >
          {chapters.map((chapter, index) => {
            const selected = index === activeChapter;
            const tabId = `${instanceId}-feature-tab-${index}`;
            const panelId = `${instanceId}-feature-panel-${index}`;

            return (
              <button
                aria-controls={panelId}
                aria-selected={selected}
                className={selected ? 'is-active' : undefined}
                id={tabId}
                key={chapter.code}
                onClick={() => setActiveChapter(index)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                ref={(node) => {
                  buttonRefs.current[index] = node;
                }}
                role="tab"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                <span className="as-feature-rail__tab-number">
                  {chapter.code}
                </span>
                <span className="as-feature-rail__tab-copy">
                  <small>{chapter.kicker}</small>
                  <strong>{chapter.title}</strong>
                  <span>{chapter.body}</span>
                </span>
                <span className="as-feature-rail__tab-icon">
                  <Icon name={chapter.icon} />
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="as-feature-rail__product-window">
        <header className="as-feature-rail__window-bar">
          <div>
            <i />
            <strong>AnySentry</strong>
            <span>RUNTIME CONTROL PLANE</span>
          </div>
          <div>
            <span className="as-feature-rail__live-dot" />
            <small>{labels.console.synthetic}</small>
            <b className="as-feature-rail__window-step" key={activeChapter}>
              0{activeChapter + 1} / 05
            </b>
          </div>
        </header>

        {stages.map((stage, index) => {
          const selected = index === activeChapter;
          const direction =
            index < activeChapter
              ? 'previous'
              : index > activeChapter
                ? 'next'
                : 'current';

          return (
            <div
              aria-hidden={!selected}
              aria-labelledby={`${instanceId}-feature-tab-${index}`}
              className="as-feature-rail__tabpanel"
              data-direction={direction}
              data-state={selected ? 'active' : 'inactive'}
              id={`${instanceId}-feature-panel-${index}`}
              inert={!selected}
              key={chapters[index].code}
              role="tabpanel"
              tabIndex={selected ? 0 : -1}
            >
              {stage}
            </div>
          );
        })}

        <footer className="as-feature-rail__window-footer">
          <span key={`kicker-${activeChapter}`}>{active.kicker}</span>
          <a href={active.href} key={`detail-${activeChapter}`}>
            {active.detailLabel}
            <Icon name="arrow" />
          </a>
        </footer>
      </section>
    </div>
  );
}
