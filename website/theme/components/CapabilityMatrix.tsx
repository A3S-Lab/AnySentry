import { useId } from 'react';
import type { HomeLabels } from './home-copy';
import { Icon } from './icons';
import { SemanticTitle } from './SemanticTitle';

type CapabilityMatrixProps = {
  labels: HomeLabels;
  route: (pathname: string) => string;
};

type Capability = {
  body: string;
  category: string;
  href: string;
  metric: {
    label: string;
    value: string;
  };
  number: string;
  span: 4 | 5 | 7;
  tags: readonly string[];
  title: string;
};

export function CapabilityMatrix({ labels, route }: CapabilityMatrixProps) {
  const titleId = useId();
  const capabilities: Capability[] = [
    {
      body: labels.trust.items[0].body,
      category: 'OBSERVE',
      href: route('/architecture/'),
      metric: {
        label: labels.context.facts[2].label,
        value: labels.context.facts[2].value,
      },
      number: '01',
      span: 7,
      tags: labels.trust.items[0].meta,
      title: labels.trust.items[0].title,
    },
    {
      body: labels.context.body,
      category: 'CONTEXT',
      href: route('/architecture/'),
      metric: {
        label: labels.context.facts[1].label,
        value: labels.context.facts[1].value,
      },
      number: '02',
      span: 5,
      tags: labels.hero.visual.contexts.map((context) => context.label),
      title: labels.context.title,
    },
    {
      body: labels.signature.domains.body,
      category: 'JUDGE',
      href: route('/judgment/'),
      metric: {
        label: labels.signature.domains.coreLabel,
        value: labels.signature.domains.coreMeta,
      },
      number: '03',
      span: 4,
      tags: labels.signature.domains.items.map((domain) => domain.name),
      title: labels.signature.domains.title,
    },
    {
      body: labels.governance.body,
      category: 'GOVERN',
      href: route('/safety-loop/'),
      metric: {
        label: labels.signature.paths.label,
        value: labels.signature.paths.value,
      },
      number: '04',
      span: 4,
      tags: labels.governance.loop.slice(3).map((step) => step.title),
      title: labels.governance.title,
    },
    {
      body: labels.trust.items[1].body,
      category: 'VERIFY',
      href: route('/evidence/'),
      metric: {
        label: labels.loop.identity.label,
        value: '01',
      },
      number: '05',
      span: 4,
      tags: labels.trust.items[1].meta,
      title: labels.trust.items[1].title,
    },
  ];

  return (
    <div aria-labelledby={titleId} className="as-capability-matrix">
      <header className="as-capability-header">
        <div className="as-capability-header__intro">
          <span className="as-section-eyebrow">{labels.signature.eyebrow}</span>
          <SemanticTitle id={titleId} lines={labels.signature.titleLines} />
        </div>
        <p className="as-capability-header__summary">{labels.signature.body}</p>
      </header>

      <div className="as-capability-grid">
        {capabilities.map((capability) => (
          <article
            className={`as-capability-card as-capability-card--span-${capability.span}`}
            key={capability.number}
          >
            <header className="as-capability-card__meta">
              <span>{capability.number}</span>
              <small>{capability.category}</small>
            </header>

            <div className="as-capability-card__content">
              <h3>{capability.title}</h3>
              <p>{capability.body}</p>
            </div>

            <footer className="as-capability-card__footer">
              <div className="as-capability-card__metric">
                <strong>{capability.metric.value}</strong>
                <span>{capability.metric.label}</span>
              </div>
              <ul aria-label={capability.title}>
                {capability.tags.map((tag) => (
                  <li key={tag}>{tag}</li>
                ))}
              </ul>
              <a
                aria-label={capability.title}
                className="as-capability-card__link"
                href={capability.href}
              >
                <Icon name="arrow" />
              </a>
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}
