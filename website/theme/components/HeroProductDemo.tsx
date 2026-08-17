import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import type { Locale } from './home-copy';
import { Icon, type IconName } from './icons';

type HeroProductDemoProps = {
  locale: Locale;
};

type SceneId =
  'overview' | 'topology' | 'judgment' | 'runtime' | 'agents' | 'remediation';

type SceneDefinition = {
  id: SceneId;
  icon: IconName;
  revealCount: number;
  revealMs: number;
  dwellMs: number;
};

type RevealStyle = CSSProperties & { '--reveal-order': number };

const SCENES: readonly SceneDefinition[] = [
  {
    id: 'overview',
    icon: 'eye',
    revealCount: 11,
    revealMs: 210,
    dwellMs: 1900,
  },
  {
    id: 'topology',
    icon: 'network',
    revealCount: 20,
    revealMs: 280,
    dwellMs: 2100,
  },
  {
    id: 'judgment',
    icon: 'decision',
    revealCount: 7,
    revealMs: 240,
    dwellMs: 2000,
  },
  {
    id: 'runtime',
    icon: 'timeline',
    revealCount: 8,
    revealMs: 220,
    dwellMs: 2000,
  },
  {
    id: 'agents',
    icon: 'identity',
    revealCount: 15,
    revealMs: 200,
    dwellMs: 2100,
  },
  {
    id: 'remediation',
    icon: 'action',
    revealCount: 17,
    revealMs: 200,
    dwellMs: 2200,
  },
] as const;

const COPY = {
  zh: {
    product: '安全监控中台',
    productMeta: 'AnySentry',
    range: '近3小时',
    live: '实时',
    navigation: 'AnySentry 产品页面',
    pause: '暂停产品演示',
    play: '继续产品演示',
    reduced: '已减少动态',
    running: '六页产品视图自动巡览',
    paused: '产品巡览已暂停',
    progress: '页面',
    systemStatus: ['Observer 部分异常', 'L1 规则 已启用', 'L2 LLM 研判 已启用'],
    summary:
      'AnySentry 真实产品界面的紧凑示意，依次展示运行总览、拓扑、复合研判、运行链路、智能体资产和处置。',
    scenes: {
      overview: {
        nav: '运行总览',
        aria: '查看运行总览产品示意',
        kicker: '平台健康与实时状态',
        title: '运行总览',
        meta: '更新 00:18:01',
        metrics: [
          ['健康状况', '99', '健康', 'safe'],
          ['Token 消耗量', '0', '当前窗口累计', 'neutral'],
          ['组件请求数', '387', '峰值 1072', 'info'],
          ['实时 TPS', '2.2', '平均 1.6', 'review'],
          ['平均响应延迟', '14ms', '实时更新', 'info'],
        ],
        realtime: '实时智能体可观测性',
        realtimeValues: [
          ['心跳', '在线'],
          ['错误率', '3.0%'],
          ['吞吐', '81'],
          ['行为态势', '基线'],
          ['状态迁移', '8'],
        ],
        trend: '安全风险趋势',
        safe: '安全感知 97',
        risk: '风险感知 3',
        funnel: '决策层级漏斗',
        tiers: [
          ['L1 · 规则引擎', '1.7万 / 100%', '100%'],
          ['L2 · LLM 研判', '6 / 0.0%', '44%'],
          ['L3 · 智能体深判', '0 / 0.0%', '18%'],
        ],
      },
      topology: {
        nav: '拓扑',
        aria: '查看拓扑产品示意',
        kicker: 'Agent 运行时安全关系',
        title: 'AnySentry 安全拓扑',
        meta: '85% · 自动布局',
        filters: ['近3小时', '仅风险关系', 'agent / endpoint / file / risk'],
        metrics: [
          ['Agent 相关', '6', 'safe'],
          ['风险关系', '7', 'risk'],
          ['网络目标', '3', 'review'],
          ['文件 / LLM', '0', 'info'],
        ],
        graphTitle: 'AnySentry 运行时安全拓扑',
        graphMeta: 'Workspace / Collector → Agent → Tool / Network',
        legend: ['观测关系', '高风险关系', '待关注关系'],
      },
      judgment: {
        nav: '复合研判',
        aria: '查看复合研判产品示意',
        kicker: 'Flink 连续行为关联',
        title: '流式复合研判',
        meta: '智能体资产 · 6',
        intro: '集中查看智能体身份、运行状态与近期关联风险',
        metrics: [
          ['运行实例', '6'],
          ['活跃', '5'],
          ['存在风险', '0'],
          ['待处理风险', '0'],
        ],
        agents: [
          ['k8s-pi-agent-manual', '已确认 Agent', 'K8s', '4,305', '0', '安全'],
          ['Codex', '候选 Agent', '本地服务', '3,800', '198', '高危'],
          ['Codex', '候选 Agent', '本地服务', '788', '52', '高危'],
          ['Pi', '候选 Agent', 'Docker', '322', '23', '安全'],
        ],
      },
      runtime: {
        nav: '运行链路',
        aria: '查看运行链路产品示意',
        kicker: '无侵入事件时间线',
        title: '运行链路',
        meta: '约 409 条',
        filters: ['Agent 相关', '全部研判', '实时事件'],
        columns: [
          '时间',
          '类型',
          '事件',
          'Agent',
          'Trace / Span',
          '研判',
          '处置',
        ],
        rows: [
          [
            '00:18:09',
            '网络',
            'egress → 127.0.0.1:39653',
            'Codex',
            'tr_390e…083a8d',
            'L1',
            '放行',
          ],
          [
            '00:18:09',
            '网络',
            'egress → 127.0.0.1:9222',
            'Codex',
            'tr_cbdd8…7b01a1',
            'L1',
            '放行',
          ],
          [
            '00:18:08',
            '网络',
            'egress → [::1]:8888:443',
            'Codex',
            'tr_390e…083a8d',
            'L1',
            '放行',
          ],
          [
            '00:18:08',
            '工具',
            'node /tmp/anysentry-cdp.mjs',
            'Codex',
            'tr_3e0c4…6d2a4a',
            'L1',
            '放行',
          ],
          [
            '00:18:08',
            '网络',
            'egress → 127.0.0.1:9',
            'k8s-pi',
            'tr_5cc84…69d7db',
            'L1',
            '放行',
          ],
          [
            '00:18:07',
            '工具',
            '/usr/bin/test -f /tmp/agent-ready',
            'k8s-pi',
            'tr_85d26…a0521f',
            'L1',
            '放行',
          ],
        ],
      },
      agents: {
        nav: '智能体资产',
        aria: '查看智能体资产产品示意',
        kicker: 'Agent 清单与运行状态',
        title: '智能体资产',
        meta: '逻辑身份共享审核',
        filters: ['Agent 资产', '近3小时', '全部状态'],
        metrics: [
          ['运行实例', '6', 'neutral'],
          ['活跃', '5', 'safe'],
          ['风险', '0', 'risk'],
          ['失联', '0', 'neutral'],
          ['事件', '9541', 'review'],
        ],
        groups: ['已确认 Agent · 1', '候选 Agent · 5'],
        instances: [
          ['16:18:08', 'k8s-pi-agent-manual', 'K8s', '4310'],
          ['16:18:02', 'Codex', '本地服务', '3801'],
          ['16:18:09', 'Codex', '本地服务', '811'],
          ['16:17:24', 'Pi', 'Docker', '322'],
        ],
        selected: 'k8s-pi-agent-manual',
        identity: '已确认 Agent',
        details: [
          ['逻辑 Agent ID', 'agent_76a0f4eb7558…'],
          ['运行实例 ID', 'k8s:1dd883d6-6357…'],
          ['Workspace', 'agent://1dd883d6…'],
          ['First Seen', '08-16 13:55:17'],
          ['Last Event', 'egress → 127.0.0.1:9'],
          ['User', 'system'],
        ],
        review: 'AI 身份辅助审核',
      },
      remediation: {
        nav: '处置',
        aria: '查看处置产品示意',
        kicker: '响应任务与执行证据',
        title: '处置中心',
        meta: 'Incident · Alert · Coverage Runbook',
        filters: ['近3小时', '全部状态', '全部来源', '全部等级'],
        metrics: [
          ['活跃任务', '33', 'risk'],
          ['处理中', '0', 'review'],
          ['阻塞', '0', 'review'],
          ['逾期', '25', 'critical'],
          ['高优先级', '29', 'info'],
        ],
        runbooks: [
          ['22:20:51', '处置告警 · Collector 断流', 'Alert', '严重'],
          ['22:04:42', '修复覆盖问题 · Collector', 'Coverage', '严重'],
          ['12:19:11', '修复覆盖问题 · Collector', 'Coverage', '严重'],
          ['12:14:52', '检查采集链路与心跳', 'Coverage', '高'],
        ],
        task: '处置告警 · Collector 断流',
        taskMeta: [
          ['Task ID', 'rem_4c24be91faab1a39'],
          ['Collector', 'pjnl261070032'],
          ['Updated', '08-16 22:20:51'],
        ],
        description: 'last heartbeat 968s ago',
        steps: [
          '检查 Collector/forwarder 进程和 DaemonSet 状态',
          '确认 /security-center/ingest 与 heartbeat 上报可达',
          '等待新心跳或新事件验证恢复',
        ],
      },
    },
  },
  en: {
    product: 'Security Center',
    productMeta: 'AnySentry',
    range: 'Last 3 hours',
    live: 'Live',
    navigation: 'AnySentry product pages',
    pause: 'Pause product tour',
    play: 'Resume product tour',
    reduced: 'Motion reduced',
    running: 'Touring six product views',
    paused: 'Product tour paused',
    progress: 'Page',
    systemStatus: ['Observer partial', 'L1 rules enabled', 'L2 LLM enabled'],
    summary:
      'A compact reconstruction of the real AnySentry product, covering Runtime overview, Topology, Composite judgment, Runtime trail, Agent assets, and Remediation.',
    scenes: {
      overview: {
        nav: 'Overview',
        aria: 'View the Runtime overview mockup',
        kicker: 'Platform health and live state',
        title: 'Runtime overview',
        meta: 'Updated 00:18:01',
        metrics: [
          ['Health', '99', 'Healthy', 'safe'],
          ['Token usage', '0', 'Current window', 'neutral'],
          ['Requests', '387', 'Peak 1072', 'info'],
          ['Live TPS', '2.2', 'Average 1.6', 'review'],
          ['Mean latency', '14ms', 'Live update', 'info'],
        ],
        realtime: 'Live Agent observability',
        realtimeValues: [
          ['Heartbeat', 'Online'],
          ['Error rate', '3.0%'],
          ['Throughput', '81'],
          ['Behavior', 'Baseline'],
          ['Transitions', '8'],
        ],
        trend: 'Security risk trend',
        safe: 'Safe signal 97',
        risk: 'Risk signal 3',
        funnel: 'Judgment tier funnel',
        tiers: [
          ['L1 · Rule engine', '17k / 100%', '100%'],
          ['L2 · LLM judgment', '6 / 0.0%', '44%'],
          ['L3 · Agent review', '0 / 0.0%', '18%'],
        ],
      },
      topology: {
        nav: 'Topology',
        aria: 'View the Topology product mockup',
        kicker: 'Agent runtime security relations',
        title: 'AnySentry topology',
        meta: '85% · auto layout',
        filters: [
          'Last 3 hours',
          'Risk relations',
          'agent / endpoint / file / risk',
        ],
        metrics: [
          ['Agent related', '6', 'safe'],
          ['Risk relations', '7', 'risk'],
          ['Network targets', '3', 'review'],
          ['File / LLM', '0', 'info'],
        ],
        graphTitle: 'AnySentry runtime security topology',
        graphMeta: 'Workspace / Collector → Agent → Tool / Network',
        legend: ['Observed', 'High risk', 'Needs attention'],
      },
      judgment: {
        nav: 'Judgment',
        aria: 'View the Composite judgment product mockup',
        kicker: 'Flink continuous behavior correlation',
        title: 'Composite judgment',
        meta: 'Agent assets · 6',
        intro: 'Correlate Agent identity, runtime state, and recent risks',
        metrics: [
          ['Instances', '6'],
          ['Active', '5'],
          ['At risk', '0'],
          ['Open risks', '0'],
        ],
        agents: [
          [
            'k8s-pi-agent-manual',
            'Verified Agent',
            'K8s',
            '4,305',
            '0',
            'Safe',
          ],
          ['Codex', 'Candidate Agent', 'Local', '3,800', '198', 'High'],
          ['Codex', 'Candidate Agent', 'Local', '788', '52', 'High'],
          ['Pi', 'Candidate Agent', 'Docker', '322', '23', 'Safe'],
        ],
      },
      runtime: {
        nav: 'Runtime trail',
        aria: 'View the Runtime trail product mockup',
        kicker: 'Non-invasive event timeline',
        title: 'Runtime trail',
        meta: 'About 409 events',
        filters: ['Agent related', 'All judgments', 'Live events'],
        columns: [
          'Time',
          'Type',
          'Event',
          'Agent',
          'Trace / Span',
          'Tier',
          'Action',
        ],
        rows: [
          [
            '00:18:09',
            'Network',
            'egress → 127.0.0.1:39653',
            'Codex',
            'tr_390e…083a8d',
            'L1',
            'Allow',
          ],
          [
            '00:18:09',
            'Network',
            'egress → 127.0.0.1:9222',
            'Codex',
            'tr_cbdd8…7b01a1',
            'L1',
            'Allow',
          ],
          [
            '00:18:08',
            'Network',
            'egress → [::1]:8888:443',
            'Codex',
            'tr_390e…083a8d',
            'L1',
            'Allow',
          ],
          [
            '00:18:08',
            'Tool',
            'node /tmp/anysentry-cdp.mjs',
            'Codex',
            'tr_3e0c4…6d2a4a',
            'L1',
            'Allow',
          ],
          [
            '00:18:08',
            'Network',
            'egress → 127.0.0.1:9',
            'k8s-pi',
            'tr_5cc84…69d7db',
            'L1',
            'Allow',
          ],
          [
            '00:18:07',
            'Tool',
            '/usr/bin/test -f /tmp/agent-ready',
            'k8s-pi',
            'tr_85d26…a0521f',
            'L1',
            'Allow',
          ],
        ],
      },
      agents: {
        nav: 'Agent assets',
        aria: 'View the Agent assets product mockup',
        kicker: 'Agent inventory and runtime state',
        title: 'Agent assets',
        meta: 'Shared identity review',
        filters: ['Agent assets', 'Last 3 hours', 'All states'],
        metrics: [
          ['Instances', '6', 'neutral'],
          ['Active', '5', 'safe'],
          ['Risk', '0', 'risk'],
          ['Lost', '0', 'neutral'],
          ['Events', '9541', 'review'],
        ],
        groups: ['Verified Agent · 1', 'Candidate Agent · 5'],
        instances: [
          ['16:18:08', 'k8s-pi-agent-manual', 'K8s', '4310'],
          ['16:18:02', 'Codex', 'Local', '3801'],
          ['16:18:09', 'Codex', 'Local', '811'],
          ['16:17:24', 'Pi', 'Docker', '322'],
        ],
        selected: 'k8s-pi-agent-manual',
        identity: 'Verified Agent',
        details: [
          ['Logical Agent ID', 'agent_76a0f4eb7558…'],
          ['Runtime instance ID', 'k8s:1dd883d6-6357…'],
          ['Workspace', 'agent://1dd883d6…'],
          ['First seen', '08-16 13:55:17'],
          ['Last event', 'egress → 127.0.0.1:9'],
          ['User', 'system'],
        ],
        review: 'AI identity review',
      },
      remediation: {
        nav: 'Remediation',
        aria: 'View the Remediation product mockup',
        kicker: 'Response tasks and execution evidence',
        title: 'Remediation center',
        meta: 'Incident · Alert · Coverage Runbook',
        filters: [
          'Last 3 hours',
          'All states',
          'All sources',
          'All severities',
        ],
        metrics: [
          ['Active tasks', '33', 'risk'],
          ['Processing', '0', 'review'],
          ['Blocked', '0', 'review'],
          ['Overdue', '25', 'critical'],
          ['High priority', '29', 'info'],
        ],
        runbooks: [
          ['22:20:51', 'Handle alert · Collector offline', 'Alert', 'Critical'],
          ['22:04:42', 'Repair Collector coverage', 'Coverage', 'Critical'],
          ['12:19:11', 'Repair Collector coverage', 'Coverage', 'Critical'],
          ['12:14:52', 'Check ingest pipeline heartbeat', 'Coverage', 'High'],
        ],
        task: 'Handle alert · Collector offline',
        taskMeta: [
          ['Task ID', 'rem_4c24be91faab1a39'],
          ['Collector', 'pjnl261070032'],
          ['Updated', '08-16 22:20:51'],
        ],
        description: 'last heartbeat 968s ago',
        steps: [
          'Inspect Collector/forwarder and DaemonSet state',
          'Verify /security-center/ingest and heartbeat delivery',
          'Wait for a heartbeat or event to confirm recovery',
        ],
      },
    },
  },
} as const;

function revealProps(order: number, revealCount: number) {
  return {
    'data-reveal': order,
    'data-visible': order < revealCount ? 'true' : 'false',
    style: { '--reveal-order': order } as RevealStyle,
  } as const;
}

function StatusStrip({ locale }: { locale: Locale }) {
  return (
    <div className="as-product-demo__system-status">
      {COPY[locale].systemStatus.map((status, index) => (
        <span data-tone={index === 0 ? 'review' : 'safe'} key={status}>
          <i aria-hidden="true" />
          {status}
        </span>
      ))}
    </div>
  );
}

function FilterBar({
  items,
  order,
  revealCount,
}: {
  items: readonly string[];
  order: number;
  revealCount: number;
}) {
  return (
    <div
      className="as-product-demo__filterbar"
      {...revealProps(order, revealCount)}
    >
      {items.map((item, index) => (
        <span
          data-wide={index === items.length - 1 ? 'true' : 'false'}
          key={item}
        >
          {item}
          {index !== items.length - 1 ? <b aria-hidden="true">⌄</b> : null}
        </span>
      ))}
      <button aria-label="Refresh preview" tabIndex={-1} type="button">
        <Icon name="replay" />
      </button>
    </div>
  );
}

function MetricStrip({
  metrics,
  order,
  revealCount,
}: {
  metrics: readonly (readonly [string, string, string])[];
  order: number;
  revealCount: number;
}) {
  return (
    <div className="as-product-demo__metric-strip">
      {metrics.map(([label, value, tone], index) => (
        <article
          data-tone={tone}
          key={label}
          {...revealProps(order + index, revealCount)}
        >
          <span>{label}</span>
          <strong>{value}</strong>
        </article>
      ))}
    </div>
  );
}

function OverviewScene({ locale, revealCount }: HeroSceneProps) {
  const t = COPY[locale].scenes.overview;
  return (
    <div className="as-product-demo__scene as-product-demo__scene--overview">
      <div {...revealProps(0, revealCount)}>
        <StatusStrip locale={locale} />
      </div>
      <div className="as-product-demo__overview-metrics">
        {t.metrics.map(([label, value, meta, tone], index) => (
          <article
            className="as-product-demo__overview-metric"
            data-tone={tone}
            key={label}
            {...revealProps(index + 1, revealCount)}
          >
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{meta}</small>
            <i aria-hidden="true" />
          </article>
        ))}
      </div>
      <section
        className="as-product-demo__surface as-product-demo__live-panel"
        {...revealProps(6, revealCount)}
      >
        <header className="as-product-demo__surface-head">
          <strong>{t.realtime}</strong>
          <span className="as-product-demo__pill" data-tone="safe">
            <i /> 00:18:01
          </span>
        </header>
        <div>
          {t.realtimeValues.map(([label, value]) => (
            <article key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </article>
          ))}
        </div>
      </section>
      <div className="as-product-demo__overview-lower">
        <section
          className="as-product-demo__surface as-product-demo__trend-panel"
          {...revealProps(7, revealCount)}
        >
          <header className="as-product-demo__surface-head">
            <strong>{t.trend}</strong>
            <small>
              <span data-tone="safe">{t.safe}</span>
              <span data-tone="review">{t.risk}</span>
            </small>
          </header>
          <svg
            aria-label={t.trend}
            preserveAspectRatio="none"
            role="img"
            viewBox="0 0 420 120"
          >
            <path d="M0 25H420M0 60H420M0 95H420" data-grid="true" />
            <path
              d="M0 34C32 20 52 43 80 25S132 33 166 24 210 26 248 27 286 20 320 49 350 32 390 44 420 29"
              data-tone="safe"
            />
            <path
              d="M0 100C38 96 70 105 104 98S176 102 214 98 265 93 302 102 344 82 375 98 420 91"
              data-tone="review"
            />
          </svg>
        </section>
        <section
          className="as-product-demo__surface as-product-demo__funnel"
          {...revealProps(8, revealCount)}
        >
          <header className="as-product-demo__surface-head">
            <strong>{t.funnel}</strong>
            <small>Agent related</small>
          </header>
          {t.tiers.map(([label, value, width], index) => (
            <div key={label} {...revealProps(index + 8, revealCount)}>
              <span>{label}</span>
              <code>{value}</code>
              <i>
                <b style={{ width }} />
              </i>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function TopologyScene({ locale, revealCount }: HeroSceneProps) {
  const t = COPY[locale].scenes.topology;
  const canvasRef = useRef<HTMLDivElement>(null);
  const [edgePaths, setEdgePaths] = useState<Record<string, string>>({});
  const nodes = [
    [
      'workspace',
      'bundle',
      'repo://payments',
      'Workspace · 273 events',
      'observed',
      6,
    ],
    [
      'collector',
      'timeline',
      'pjnl261070032',
      'Collector · 287 events',
      'risk',
      7,
    ],
    ['agent', 'identity', 'codex', 'Agent · 3800 events', 'risk', 8],
    ['lsb', 'terminal', 'lsb_release', 'Tool · 180 events', 'risk', 11],
    ['awk', 'terminal', 'awk', 'Tool · 57 events', 'risk', 13],
    ['bash', 'terminal', 'bash', 'Tool · 24 events', 'risk', 15],
    ['getconf', 'terminal', 'getconf', 'Tool · 15 events', 'risk', 17],
  ] as const;
  const edges = [
    ['workspace-agent', 'workspace', 'agent', 'observed', 9],
    ['collector-agent', 'collector', 'agent', 'risk', 10],
    ['agent-lsb', 'agent', 'lsb', 'risk', 12],
    ['agent-awk', 'agent', 'awk', 'risk', 14],
    ['agent-bash', 'agent', 'bash', 'risk', 16],
    ['agent-getconf', 'agent', 'getconf', 'risk', 18],
  ] as const;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let animationFrame = 0;
    const measureEdges = () => {
      animationFrame = 0;
      const nextPaths: Record<string, string> = {};

      for (const [id, sourceId, targetId] of edges) {
        const source = canvas.querySelector<HTMLElement>(
          `[data-node="${sourceId}"]`,
        );
        const target = canvas.querySelector<HTMLElement>(
          `[data-node="${targetId}"]`,
        );
        if (!source || !target) continue;

        // offset geometry deliberately ignores reveal transforms, so a line
        // remains attached while its cards animate into their final position.
        const startX = source.offsetLeft + source.offsetWidth - 1;
        const startY = source.offsetTop + source.offsetHeight / 2;
        const endX = target.offsetLeft + 1;
        const endY = target.offsetTop + target.offsetHeight / 2;
        const horizontalSpace = Math.max(0, endX - startX);
        const bend = Math.max(30, Math.min(92, horizontalSpace * 0.46));
        nextPaths[id] = [
          `M${startX.toFixed(1)} ${startY.toFixed(1)}`,
          `C${(startX + bend).toFixed(1)} ${startY.toFixed(1)}`,
          `${(endX - bend).toFixed(1)} ${endY.toFixed(1)}`,
          `${endX.toFixed(1)} ${endY.toFixed(1)}`,
        ].join(' ');
      }

      setEdgePaths((current) => {
        const keys = Object.keys(nextPaths);
        if (
          keys.length === Object.keys(current).length &&
          keys.every((key) => current[key] === nextPaths[key])
        )
          return current;
        return nextPaths;
      });
    };
    const scheduleMeasure = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(measureEdges);
    };

    scheduleMeasure();
    window.addEventListener('resize', scheduleMeasure);
    const resizeObserver =
      'ResizeObserver' in window
        ? new ResizeObserver(scheduleMeasure)
        : undefined;
    resizeObserver?.observe(canvas);
    canvas
      .querySelectorAll<HTMLElement>('[data-node]')
      .forEach((node) => resizeObserver?.observe(node));

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', scheduleMeasure);
      resizeObserver?.disconnect();
    };
  }, []);

  return (
    <div className="as-product-demo__scene as-product-demo__scene--topology">
      <FilterBar items={t.filters} order={0} revealCount={revealCount} />
      <MetricStrip metrics={t.metrics} order={1} revealCount={revealCount} />
      <section
        className="as-product-demo__surface as-product-demo__topology"
        {...revealProps(5, revealCount)}
      >
        <header className="as-product-demo__surface-head">
          <div>
            <strong>{t.graphTitle}</strong>
            <small>{t.graphMeta}</small>
          </div>
          <span className="as-product-demo__pill" data-tone="safe">
            codex
          </span>
        </header>
        <div className="as-product-demo__topology-canvas" ref={canvasRef}>
          <svg aria-hidden="true">
            {edges.map(([id, , , tone, order]) => (
              <path
                className="as-product-demo__topology-edge"
                d={edgePaths[id] ?? ''}
                data-connected={edgePaths[id] ? 'true' : 'false'}
                data-tone={tone}
                key={id}
                pathLength={1}
                {...revealProps(order, revealCount)}
              />
            ))}
          </svg>
          {nodes.map(([id, icon, title, meta, tone, order]) => (
            <article
              data-node={id}
              data-tone={tone}
              key={id}
              {...revealProps(order, revealCount)}
            >
              <span>
                <Icon name={icon} />
              </span>
              <div>
                <strong>{title}</strong>
                <small>{meta}</small>
              </div>
            </article>
          ))}
          <div
            className="as-product-demo__topology-legend"
            {...revealProps(19, revealCount)}
          >
            {t.legend.map((item, index) => (
              <span
                data-tone={
                  index === 0 ? 'observed' : index === 1 ? 'risk' : 'review'
                }
                key={item}
              >
                <i />
                {item}
              </span>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function JudgmentScene({ locale, revealCount }: HeroSceneProps) {
  const t = COPY[locale].scenes.judgment;
  return (
    <div className="as-product-demo__scene as-product-demo__scene--judgment">
      <div {...revealProps(0, revealCount)}>
        <StatusStrip locale={locale} />
      </div>
      <section
        className="as-product-demo__surface as-product-demo__judgment-overview"
        {...revealProps(1, revealCount)}
      >
        <header className="as-product-demo__surface-head">
          <div>
            <strong>{t.title}</strong>
            <small>{t.intro}</small>
          </div>
          <span className="as-product-demo__pill" data-tone="safe">
            {t.meta}
          </span>
        </header>
        <div className="as-product-demo__judgment-metrics">
          {t.metrics.map(([label, value]) => (
            <article key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </article>
          ))}
        </div>
      </section>
      <div className="as-product-demo__agent-grid">
        {t.agents.map(
          ([name, identity, platform, events, risks, state], index) => (
            <article
              data-tone={
                state === '高危' || state === 'High' ? 'review' : 'safe'
              }
              key={`${name}-${events}`}
              {...revealProps(index + 2, revealCount)}
            >
              <header>
                <div>
                  <i />
                  <strong>{name}</strong>
                </div>
                <span
                  className="as-product-demo__pill"
                  data-tone={
                    state === '高危' || state === 'High' ? 'review' : 'safe'
                  }
                >
                  {state}
                </span>
              </header>
              <small>
                {identity} · {platform}
              </small>
              <dl>
                <div>
                  <dt>Events</dt>
                  <dd>{events}</dd>
                </div>
                <div>
                  <dt>Risk</dt>
                  <dd>{risks}</dd>
                </div>
                <div>
                  <dt>Pending</dt>
                  <dd>0</dd>
                </div>
              </dl>
              <footer>
                <code>egress → 127.0.0.1:39653</code>
                <span>→</span>
              </footer>
            </article>
          ),
        )}
      </div>
    </div>
  );
}

function RuntimeScene({ locale, revealCount }: HeroSceneProps) {
  const t = COPY[locale].scenes.runtime;
  return (
    <div className="as-product-demo__scene as-product-demo__scene--runtime">
      <div {...revealProps(0, revealCount)}>
        <StatusStrip locale={locale} />
      </div>
      <FilterBar items={t.filters} order={1} revealCount={revealCount} />
      <section className="as-product-demo__surface as-product-demo__event-table">
        <header className="as-product-demo__surface-head">
          <strong>{t.kicker}</strong>
          <code>{t.meta}</code>
        </header>
        <table>
          <thead>
            <tr>
              {t.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((row, index) => (
              <tr
                key={`${row[0]}-${row[2]}`}
                {...revealProps(index + 2, revealCount)}
              >
                {row.map((cell, cellIndex) => (
                  <td key={`${cell}-${cellIndex}`}>
                    {cellIndex === 1 || cellIndex === 5 || cellIndex === 6 ? (
                      <span
                        className="as-product-demo__pill"
                        data-tone={
                          cellIndex === 6
                            ? 'safe'
                            : cellIndex === 1
                              ? 'info'
                              : 'neutral'
                        }
                      >
                        {cell}
                      </span>
                    ) : cellIndex === 4 ? (
                      <code>{cell}</code>
                    ) : (
                      cell
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function AgentsScene({ locale, revealCount }: HeroSceneProps) {
  const t = COPY[locale].scenes.agents;
  return (
    <div className="as-product-demo__scene as-product-demo__scene--agents">
      <FilterBar items={t.filters} order={0} revealCount={revealCount} />
      <MetricStrip metrics={t.metrics} order={1} revealCount={revealCount} />
      <div className="as-product-demo__asset-layout">
        <section
          className="as-product-demo__surface as-product-demo__asset-list"
          {...revealProps(6, revealCount)}
        >
          <header className="as-product-demo__surface-head">
            <strong>{t.groups[0]}</strong>
            <small>{t.groups[1]}</small>
          </header>
          {t.instances.map(([time, name, platform, events], index) => (
            <article
              data-current={index === 0 ? 'true' : 'false'}
              key={`${time}-${name}`}
              {...revealProps(index + 7, revealCount)}
            >
              <code>{time}</code>
              <i />
              <div>
                <strong>{name}</strong>
                <small>{platform}</small>
              </div>
              <span>{events}</span>
            </article>
          ))}
        </section>
        <section
          className="as-product-demo__surface as-product-demo__asset-detail"
          {...revealProps(11, revealCount)}
        >
          <header className="as-product-demo__surface-head">
            <div>
              <strong>{t.selected}</strong>
              <small>anysentry-agent-test/pi-coding-agent</small>
            </div>
            <span className="as-product-demo__pill" data-tone="safe">
              {t.identity}
            </span>
          </header>
          <dl>
            {t.details.map(([label, value], index) => (
              <div
                key={label}
                {...revealProps(index < 3 ? 12 : 13, revealCount)}
              >
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <footer {...revealProps(14, revealCount)}>
            <Icon name="identity" />
            <div>
              <strong>{t.review}</strong>
              <small>
                {locale === 'zh'
                  ? '只读建议 · 原始事件始终保留'
                  : 'Read-only advice · source events retained'}
              </small>
            </div>
            <span>→</span>
          </footer>
        </section>
      </div>
    </div>
  );
}

function RemediationScene({ locale, revealCount }: HeroSceneProps) {
  const t = COPY[locale].scenes.remediation;
  return (
    <div className="as-product-demo__scene as-product-demo__scene--remediation">
      <FilterBar items={t.filters} order={0} revealCount={revealCount} />
      <MetricStrip metrics={t.metrics} order={1} revealCount={revealCount} />
      <div className="as-product-demo__remediation-layout">
        <section
          className="as-product-demo__surface as-product-demo__runbook-list"
          {...revealProps(6, revealCount)}
        >
          <header className="as-product-demo__surface-head">
            <strong>Runbooks</strong>
            <small>33</small>
          </header>
          {t.runbooks.map(([time, title, source, severity], index) => (
            <article
              data-current={index === 0 ? 'true' : 'false'}
              key={`${time}-${title}`}
              {...revealProps(index + 7, revealCount)}
            >
              <code>{time}</code>
              <div>
                <strong>{title}</strong>
                <small>{source}</small>
              </div>
              <span className="as-product-demo__pill" data-tone="risk">
                {severity}
              </span>
            </article>
          ))}
        </section>
        <section
          className="as-product-demo__surface as-product-demo__task-detail"
          {...revealProps(11, revealCount)}
        >
          <header className="as-product-demo__surface-head">
            <strong>{t.task}</strong>
            <span className="as-product-demo__pill" data-tone="risk">
              {locale === 'zh' ? '待处理' : 'Open'}
            </span>
          </header>
          <dl {...revealProps(12, revealCount)}>
            {t.taskMeta.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <div
            className="as-product-demo__task-description"
            {...revealProps(13, revealCount)}
          >
            <span>{locale === 'zh' ? '描述' : 'Description'}</span>
            <code>{t.description}</code>
          </div>
          <ol>
            {t.steps.map((step, index) => (
              <li key={step} {...revealProps(index + 14, revealCount)}>
                <i />
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

type HeroSceneProps = { locale: Locale; revealCount: number };

function SceneContent({
  locale,
  revealCount,
  scene,
}: HeroSceneProps & { scene: SceneId }) {
  if (scene === 'overview')
    return <OverviewScene locale={locale} revealCount={revealCount} />;
  if (scene === 'topology')
    return <TopologyScene locale={locale} revealCount={revealCount} />;
  if (scene === 'judgment')
    return <JudgmentScene locale={locale} revealCount={revealCount} />;
  if (scene === 'runtime')
    return <RuntimeScene locale={locale} revealCount={revealCount} />;
  if (scene === 'agents')
    return <AgentsScene locale={locale} revealCount={revealCount} />;
  return <RemediationScene locale={locale} revealCount={revealCount} />;
}

export function HeroProductDemo({ locale }: HeroProductDemoProps) {
  const labels = COPY[locale];
  const frameRef = useRef<HTMLElement>(null);
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const [viewIndex, setViewIndex] = useState(0);
  const [revealCount, setRevealCount] = useState(0);
  const [runId, setRunId] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [manualUntil, setManualUntil] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const id = useId().replace(/:/g, '');
  const panelId = `${id}-panel`;
  const summaryId = `${id}-summary`;
  const activeScene = SCENES[viewIndex];
  const activeCopy = labels.scenes[activeScene.id];
  const canReveal = playing && !reducedMotion && inView && pageVisible;
  const canAdvance = canReveal && !pointerInside && !focusWithin;

  const selectScene = useCallback(
    (index: number, manual: boolean) => {
      const nextIndex = (index + SCENES.length) % SCENES.length;
      setViewIndex(nextIndex);
      setRevealCount(
        reducedMotion || (manual && !playing)
          ? SCENES[nextIndex].revealCount
          : manual
            ? 1
            : 0,
      );
      setRunId((current) => current + 1);
      if (manual) setManualUntil(Date.now() + 8000);
    },
    [playing, reducedMotion],
  );

  const moveFocus = useCallback(
    (index: number) => {
      const nextIndex = (index + SCENES.length) % SCENES.length;
      selectScene(nextIndex, true);
      tabsRef.current[nextIndex]?.focus();
    },
    [selectScene],
  );

  const onTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const supported = [
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
    ];
    if (!supported.includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') return moveFocus(0);
    if (event.key === 'End') return moveFocus(SCENES.length - 1);
    moveFocus(
      index +
        (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1),
    );
  };

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setReducedMotion(media.matches);
    updatePreference();
    media.addEventListener('change', updatePreference);
    return () => media.removeEventListener('change', updatePreference);
  }, []);

  useEffect(() => {
    if (reducedMotion) setRevealCount(activeScene.revealCount);
  }, [activeScene.revealCount, reducedMotion]);

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
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setInView(Boolean(entry?.isIntersecting)),
      { rootMargin: '-5% 0px -5%', threshold: [0, 0.2, 0.55] },
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (revealCount < activeScene.revealCount) {
      if (!canReveal) return;
      const timer = window.setTimeout(
        () =>
          setRevealCount((current) =>
            Math.min(current + 1, activeScene.revealCount),
          ),
        activeScene.revealMs,
      );
      return () => window.clearTimeout(timer);
    }
    if (!canAdvance) return;
    const timer = window.setTimeout(
      () => selectScene(viewIndex + 1, false),
      Math.max(activeScene.dwellMs, Math.max(0, manualUntil - Date.now())),
    );
    return () => window.clearTimeout(timer);
  }, [
    activeScene.dwellMs,
    activeScene.revealCount,
    activeScene.revealMs,
    canAdvance,
    canReveal,
    manualUntil,
    revealCount,
    runId,
    selectScene,
    viewIndex,
  ]);

  const effectivelyPaused = !canAdvance;
  const playbackLabel = reducedMotion
    ? labels.reduced
    : playing
      ? labels.pause
      : labels.play;

  return (
    <figure
      aria-describedby={summaryId}
      className="as-product-demo"
      data-paused={effectivelyPaused ? 'true' : 'false'}
      data-playing={playing ? 'true' : 'false'}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      data-view={activeScene.id}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocusWithin(false);
      }}
      onFocusCapture={() => setFocusWithin(true)}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') setPointerInside(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') setPointerInside(false);
      }}
      ref={frameRef}
    >
      <header className="as-product-demo__topbar">
        <div className="as-product-demo__brand">
          <span className="as-product-demo__brand-mark">
            <Icon name="shield" />
          </span>
          <strong>{labels.product}</strong>
          <small>{labels.productMeta}</small>
        </div>
        <div className="as-product-demo__topbar-meta">
          <span>{labels.range}⌄</span>
          <code>
            <i />
            {labels.live} 00:18:22
          </code>
        </div>
        <button
          aria-label={playbackLabel}
          className="as-product-demo__playback"
          disabled={reducedMotion}
          onClick={() => setPlaying((current) => !current)}
          type="button"
        >
          <Icon name={playing && !reducedMotion ? 'pause' : 'play'} />
          <span>{playbackLabel}</span>
        </button>
      </header>

      <div className="as-product-demo__body">
        <nav
          aria-label={labels.navigation}
          aria-orientation="vertical"
          className="as-product-demo__rail"
          role="tablist"
        >
          <small className="as-product-demo__rail-label">OVERVIEW</small>
          {SCENES.map((scene, index) => {
            const sceneCopy = labels.scenes[scene.id];
            const selected = viewIndex === index;
            return (
              <button
                aria-controls={panelId}
                aria-label={sceneCopy.aria}
                aria-selected={selected}
                className="as-product-demo__nav-button"
                data-current={selected ? 'true' : 'false'}
                id={`${id}-tab-${scene.id}`}
                key={scene.id}
                onClick={() => selectScene(index, true)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
                ref={(node) => {
                  tabsRef.current[index] = node;
                }}
                role="tab"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                <span className="as-product-demo__nav-icon">
                  <Icon name={scene.icon} />
                </span>
                <span className="as-product-demo__nav-label">
                  <strong>{sceneCopy.nav}</strong>
                  <small>0{index + 1}</small>
                </span>
              </button>
            );
          })}
          <div className="as-product-demo__rail-health">
            <i />
            <span>Observer</span>
            <small>partial</small>
          </div>
        </nav>

        <section className="as-product-demo__workspace">
          <header className="as-product-demo__scene-head">
            <div className="as-product-demo__scene-heading">
              <span className="as-product-demo__scene-icon">
                <Icon name={activeScene.icon} />
              </span>
              <div>
                <h2 className="as-product-demo__scene-title">
                  {activeCopy.title}
                </h2>
                <small className="as-product-demo__scene-kicker">
                  {activeCopy.kicker}
                </small>
              </div>
            </div>
            <div className="as-product-demo__scene-progress">
              <code>{activeCopy.meta}</code>
              <span>
                {labels.progress} 0{viewIndex + 1} / 06
              </span>
            </div>
          </header>

          <div
            aria-labelledby={`${id}-tab-${activeScene.id}`}
            className="as-product-demo__panel"
            data-scene={activeScene.id}
            id={panelId}
            key={`${activeScene.id}-${runId}`}
            role="tabpanel"
            tabIndex={0}
          >
            <SceneContent
              locale={locale}
              revealCount={revealCount}
              scene={activeScene.id}
            />
          </div>

          <footer className="as-product-demo__footer">
            <div className="as-product-demo__tour-status">
              <i />
              <span>{effectivelyPaused ? labels.paused : labels.running}</span>
            </div>
            <ol aria-hidden="true">
              {SCENES.map((scene, index) => (
                <li
                  data-current={index === viewIndex ? 'true' : 'false'}
                  data-complete={index < viewIndex ? 'true' : 'false'}
                  key={scene.id}
                />
              ))}
            </ol>
            <code>prod-eu-1</code>
          </footer>
        </section>
      </div>

      <figcaption className="as-product-demo__sr" id={summaryId}>
        {labels.summary}
      </figcaption>
    </figure>
  );
}
