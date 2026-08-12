import { useLang, useSite, withBase } from '@rspress/core/runtime';
import { AgentRuntimeStory } from './AgentRuntimeStory';
import { ContextComparison } from './ContextComparison';
import { GovernanceLoop } from './GovernanceLoop';
import { copy, type HomeLabels, type Locale } from './home-copy';
import { Icon } from './icons';
import { InstallCommand } from './InstallCommand';
import { PageEffects } from './PageEffects';
import { ProductConsole } from './ProductConsole';
import { SignalFlow } from './SignalFlow';
import { SystemContextField } from './SystemContextField';
import { SystemSignature } from './SystemSignature';

function MarkdownHome({ labels }: { labels: HomeLabels }) {
  return (
    <main>
      <h1>
        {labels.hero.titleLine1} {labels.hero.titleLead}{' '}
        {labels.hero.titleFocus} {labels.hero.titleTail}
      </h1>
      <p>{labels.hero.body}</p>

      <h2>{labels.signature.title}</h2>
      <p>{labels.signature.body}</p>
      <h3>
        {labels.signature.agents.value} · {labels.signature.agents.title}
      </h3>
      <ol>
        {labels.signature.agents.items.map((agent) => (
          <li key={agent.name}>
            <strong>{agent.name}:</strong> {agent.body}
          </li>
        ))}
      </ol>
      <h3>
        {labels.signature.domains.value} · {labels.signature.domains.title}
      </h3>
      <ul>
        {labels.signature.domains.items.map((domain) => (
          <li key={domain.name}>
            <strong>{domain.name}:</strong> {domain.risks.join('、')}
          </li>
        ))}
      </ul>
      <h3>
        {labels.signature.paths.value} · {labels.signature.paths.title}
      </h3>
      <ul>
        {labels.signature.paths.items.map((path) => (
          <li key={path.name}>
            <strong>{path.name}:</strong> {path.steps.join(' → ')}
          </li>
        ))}
      </ul>

      <h2>{labels.context.title}</h2>
      <p>{labels.context.body}</p>
      <h2>{labels.governance.title}</h2>
      <p>{labels.governance.body}</p>
      <h2>{labels.runtimeStory.title}</h2>
      <p>{labels.runtimeStory.body}</p>
      <h2>{labels.loop.title}</h2>
      <p>{labels.loop.body}</p>
      <h2>{labels.console.title}</h2>
      <p>{labels.console.body}</p>
    </main>
  );
}

function SectionLink({ href, label }: { href: string; label: string }) {
  return (
    <a className="as-section-link" href={href}>
      <span>{label}</span>
      <Icon name="arrow" />
    </a>
  );
}

export function HomeLayout() {
  const rawLang = useLang();
  const locale: Locale = rawLang === 'zh' ? 'zh' : 'en';
  const labels = copy[locale];
  const { site } = useSite();
  const route = (pathname: string) => {
    const normalized = pathname.replace(/^\/+/, '');
    const prefix = locale === site.lang ? '' : locale;
    return withBase(`/${[prefix, normalized].filter(Boolean).join('/')}`);
  };

  if (import.meta.env.SSG_MD) {
    return <MarkdownHome labels={labels} />;
  }

  return (
    <main className="as-home">
      <PageEffects />
      <div className="as-home__ambient" aria-hidden="true">
        <i />
        <i />
        <i />
        <span className="as-home__cursor-light" />
      </div>

      <section className="as-hero">
        <div className="as-hero__copy">
          <div className="as-eyebrow">
            <span />
            {labels.hero.eyebrow}
          </div>
          <h1 className="as-hero-title">
            <span>{labels.hero.titleLine1}</span>
            <span>
              {labels.hero.titleLead} <strong>{labels.hero.titleFocus}</strong>{' '}
              {labels.hero.titleTail}
            </span>
          </h1>
          <p>{labels.hero.body}</p>
          <div className="as-hero__actions">
            <a className="as-button as-button--primary" href={route('/guide/')}>
              {labels.hero.primary}
              <Icon name="arrow" />
            </a>
            <a className="as-button as-button--secondary" href="#governance">
              {labels.hero.secondary}
            </a>
          </div>
          <InstallCommand labels={labels.hero} />
          <div className="as-hero__support">
            <Icon name="check" />
            <span>{labels.hero.support}</span>
          </div>
        </div>
        <div className="as-hero__visual">
          <SystemContextField labels={labels.hero.visual} />
        </div>
      </section>

      <div className="as-proof-strip" aria-label="Project facts">
        {labels.proof.map((fact) => (
          <span key={fact}>
            <i />
            {fact}
          </span>
        ))}
      </div>

      <section className="as-section as-signature" id="system-map">
        <header className="as-section-header" data-reveal>
          <div>
            <span className="as-section-eyebrow">
              {labels.signature.eyebrow}
            </span>
            <h2 className="as-heading-balanced">{labels.signature.title}</h2>
          </div>
          <p>{labels.signature.body}</p>
        </header>
        <SystemSignature labels={labels.signature} route={route} />
      </section>

      <section className="as-section as-context" id="context">
        <header className="as-editorial-heading" data-reveal>
          <span className="as-section-eyebrow">{labels.context.eyebrow}</span>
          <div>
            <h2>{labels.context.title}</h2>
            <p>{labels.context.body}</p>
            <SectionLink
              href={route('/architecture/')}
              label={labels.context.detailLabel}
            />
          </div>
        </header>
        <ContextComparison labels={labels.context} />
      </section>

      <section className="as-section as-governance" id="governance">
        <header
          className="as-editorial-heading as-editorial-heading--center"
          data-reveal
        >
          <span className="as-section-eyebrow">
            {labels.governance.eyebrow}
          </span>
          <div>
            <h2>{labels.governance.title}</h2>
            <p>{labels.governance.body}</p>
            <SectionLink
              href={route('/safety-loop/')}
              label={labels.governance.detailLabel}
            />
          </div>
        </header>
        <GovernanceLoop labels={labels.governance} />
      </section>

      <section
        className="as-section as-runtime-story-section"
        id="agent-runtime-story"
      >
        <header className="as-section-header" data-reveal>
          <div>
            <span className="as-section-eyebrow">
              {labels.runtimeStory.eyebrow}
            </span>
            <h2 className="as-heading-balanced">{labels.runtimeStory.title}</h2>
            <SectionLink
              href={route('/safety-loop/')}
              label={labels.runtimeStory.detailLabel}
            />
          </div>
          <p>{labels.runtimeStory.body}</p>
        </header>
        <div className="as-agent-story-slot">
          <AgentRuntimeStory locale={locale} />
        </div>
      </section>

      <section className="as-section as-loop" id="evidence-loop">
        <header className="as-section-header" data-reveal>
          <div>
            <span className="as-section-eyebrow">{labels.loop.eyebrow}</span>
            <h2 className="as-heading-balanced">{labels.loop.title}</h2>
            <SectionLink
              href={route('/evidence/')}
              label={labels.loop.detailLabel}
            />
          </div>
          <p>{labels.loop.body}</p>
        </header>
        <SignalFlow labels={labels.loop} />
      </section>

      <section className="as-section as-console-section" id="product">
        <header className="as-section-header" data-reveal>
          <div>
            <span className="as-section-eyebrow">{labels.console.eyebrow}</span>
            <h2 className="as-heading-balanced">{labels.console.title}</h2>
            <SectionLink
              href={route('/scenarios/')}
              label={labels.console.detailLabel}
            />
          </div>
          <p>{labels.console.body}</p>
        </header>
        <div data-reveal>
          <ProductConsole labels={labels.console} />
        </div>
      </section>

      <section className="as-cta" data-reveal>
        <div>
          <span className="as-section-eyebrow">{labels.cta.eyebrow}</span>
          <h2>{labels.cta.title}</h2>
          <p>{labels.cta.body}</p>
        </div>
        <div className="as-cta__actions">
          <a className="as-button as-button--primary" href={route('/guide/')}>
            {labels.cta.primary}
            <Icon name="arrow" />
          </a>
          <a
            className="as-button as-button--secondary"
            href="https://github.com/A3S-Lab/AnySentry"
          >
            <Icon name="github" />
            {labels.cta.secondary}
          </a>
        </div>
      </section>

      <footer className="as-footer">
        <a href={route('/')}>
          <img
            alt="AnySentry"
            src={withBase('/anysentry-logo-horizontal-reversed.svg')}
          />
        </a>
        <span>{labels.footer}</span>
        <a href="https://github.com/A3S-Lab/AnySentry">
          GitHub <span aria-hidden="true">↗</span>
        </a>
      </footer>
    </main>
  );
}
