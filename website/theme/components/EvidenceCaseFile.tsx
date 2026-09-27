import type { HomeLabels, Locale } from './home-copy';
import { Icon } from './icons';

export function EvidenceCaseFile({
  labels,
  locale,
}: {
  labels: HomeLabels;
  locale: Locale;
}) {
  const auditRows = labels.loop.audit;
  const events = labels.console.evidence.events;
  const english = locale === 'en';
  const finding = english
    ? 'A privileged production agent reached the link-local cloud metadata endpoint without a declared deployment need. L1 matched the reserved address; L2 and L3 confirmed that the action conflicted with task intent and the system boundary.'
    : '生产高权限 Agent 在部署任务未声明需求时访问了云元数据保留地址。L1 命中地址规则，L2 与 L3 进一步确认该动作与任务意图和系统边界冲突。';
  const outcome = english
    ? 'A later matching attempt is denied by Runtime Guard before it reaches the kernel.'
    : '后续相似动作再次出现时，Runtime Guard 在请求触达内核前完成阻断。';
  const chainLabel = english ? 'EVIDENCE CHAIN' : '证据链';
  const chainStatus = english
    ? `${events.length} linked events`
    : `${events.length} 个关联事件`;
  const sourceLinked = english ? 'source linked' : '来源已关联';

  return (
    <div className="as-case-file">
      <article className="as-case-file__identity">
        <header>
          <span>CASE / EVT-8C5667A9</span>
          <small>{labels.loop.identity.integrity}</small>
        </header>
        <div className="as-case-file__event">
          <span className="as-case-file__event-icon">
            <Icon name="bundle" />
          </span>
          <div>
            <small>{labels.loop.identity.label}</small>
            <strong>{labels.loop.identity.value}</strong>
            <code>{labels.loop.identity.trace}</code>
          </div>
        </div>
        <dl className="as-case-file__identity-facts">
          <div>
            <dt>source</dt>
            <dd>observer-node-07</dd>
          </div>
          <div>
            <dt>intent</dt>
            <dd>deploy-42</dd>
          </div>
          <div>
            <dt>scope</dt>
            <dd>prod-eu-1</dd>
          </div>
        </dl>
      </article>

      <article className="as-case-file__timeline">
        <header>
          <span>{chainLabel}</span>
          <small>{chainStatus}</small>
        </header>
        <ol>
          {events.map((event, index) => (
            <li key={event}>
              <span>0{index + 1}</span>
              <div>
                <strong>{event}</strong>
                <small>
                  18:32:0{index + 2} · {sourceLinked}
                </small>
              </div>
            </li>
          ))}
        </ol>
      </article>

      <article className="as-case-file__finding">
        <span>FINDING</span>
        <Icon name="shield" />
        <strong>systemic_risk</strong>
        <p>{finding}</p>
        <small>critical · L1 → L2 → L3</small>
      </article>

      <article className="as-case-file__decision">
        <span>CONTROL</span>
        <Icon name="decision" />
        <strong>require_approval</strong>
        <p>{labels.governance.approval.body}</p>
        <small>Runtime Guard · scope confirmed</small>
      </article>

      <article className="as-case-file__rule">
        <header>
          <span>APPROVED RULE</span>
          <strong>R1 / deny_metadata_access</strong>
        </header>
        <dl>
          <div>
            <dt>subject</dt>
            <dd>release-agent</dd>
          </div>
          <div>
            <dt>workspace</dt>
            <dd>repo://payments</dd>
          </div>
          <div>
            <dt>destination</dt>
            <dd>169.254.169.254/32</dd>
          </div>
          <div>
            <dt>action</dt>
            <dd>deny · record</dd>
          </div>
        </dl>
      </article>

      <article className="as-case-file__audit">
        <header>
          <span>AUDIT TRAIL</span>
          <Icon name="timeline" />
        </header>
        <dl>
          {auditRows.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </article>

      <article className="as-case-file__outcome">
        <span>OUTCOME</span>
        <div>
          <Icon name="action" />
          <strong>blocked before execution</strong>
        </div>
        <p>{outcome}</p>
        <small>kernel untouched · decision recorded</small>
      </article>
    </div>
  );
}
