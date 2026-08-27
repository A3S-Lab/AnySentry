export type ChapterKey =
  | 'scan'
  | 'reveal'
  | 'work'
  | 'intent'
  | 'turn'
  | 'walk'
  | 'command'
  | 'transmit'
  | 'kernel'
  | 'l1'
  | 'l1-escalate'
  | 'l2'
  | 'l2-escalate'
  | 'l3-arrival'
  | 'l3-review'
  | 'report'
  | 'rule'
  | 'retry'
  | 'block'
  | 'finale';

export type ChapterTone = 'observe' | 'runtime' | 'judge' | 'danger' | 'safe';

export type StoryChapter = {
  key: ChapterKey;
  duration: number;
  announcement: string;
  announcementEn?: string;
  tone: ChapterTone;
};

/**
 * Visible copy stays deliberately terse. These longer announcements are
 * screen-reader-only and preserve the full meaning of every physical action.
 */
export const CHAPTERS: StoryChapter[] = [
  {
    key: 'scan',
    duration: 1300,
    announcement: '初始化安全智能体以只读方式扫描本机中的智能体。',
    announcementEn:
      'The initialization security agent scans local agents in read-only mode.',
    tone: 'observe',
  },
  {
    key: 'reveal',
    duration: 3000,
    announcement:
      '扫描锁定目标后，初始化智能体擦开黑幕，显露已经存在并运行的工作环境。',
    announcementEn:
      'After locating a target, the initialization agent reveals the live workspace behind the curtain.',
    tone: 'observe',
  },
  {
    key: 'work',
    duration: 2200,
    announcement:
      '工作智能体先完成版本检查、测试和读取配置等低风险任务，随后接收到一个未签名远程任务。',
    announcementEn:
      'The worker agent completes low-risk checks, tests, and configuration reads before receiving an unsigned remote task.',
    tone: 'runtime',
  },
  {
    key: 'intent',
    duration: 2000,
    announcement: '工作智能体停止安全任务并自主产生远程代码植入意图。',
    announcementEn:
      'The worker agent stops its safe tasks and forms an intent to implant remote code.',
    tone: 'danger',
  },
  {
    key: 'turn',
    duration: 800,
    announcement: '攻击智能体向右转头，红色目镜锁定电话。',
    announcementEn:
      'The compromised agent turns right and locks its red visor onto the phone.',
    tone: 'danger',
  },
  {
    key: 'walk',
    duration: 2000,
    announcement: '攻击智能体以恒定速度移动到电话旁。',
    announcementEn:
      'The compromised agent moves at a steady pace toward the phone.',
    tone: 'danger',
  },
  {
    key: 'command',
    duration: 4500,
    announcement:
      '攻击智能体拿起听筒，逐字发出获取远程载荷、写入临时路径并交给 Shell 执行的三段命令。',
    announcementEn:
      'The compromised agent sends commands to fetch a remote payload, write it to a temporary path, and execute it through the shell.',
    tone: 'danger',
  },
  {
    key: 'transmit',
    duration: 1500,
    announcement: '危险动作沿电话线进入 AnySentry 运行时边界。',
    announcementEn:
      'The dangerous action travels down the line and enters the AnySentry runtime boundary.',
    tone: 'danger',
  },
  {
    key: 'kernel',
    duration: 3500,
    announcement:
      'Linux 内核侧探针捕获执行、外联、写入和 Shell 四类事实并生成证据包。',
    announcementEn:
      'Linux kernel probes capture execution, egress, write, and shell facts and assemble an evidence bundle.',
    tone: 'runtime',
  },
  {
    key: 'l1',
    duration: 3300,
    announcement:
      'L1 快速筛查命中远程获取和管道执行模式，但没有现成规则能够终局判断。',
    announcementEn:
      'L1 detects remote fetch and piped execution patterns, but no existing rule can make a final decision.',
    tone: 'judge',
  },
  {
    key: 'l1-escalate',
    duration: 1100,
    announcement: 'L1 将初筛结果与内核证据一起升级到 L2。',
    announcementEn:
      'L1 escalates its preliminary result and kernel evidence to L2.',
    tone: 'judge',
  },
  {
    key: 'l2',
    duration: 3900,
    announcement:
      'L2 将外联、写入和 Shell 串成高风险行为链，但仍需 Agent 上下文。',
    announcementEn:
      'L2 correlates egress, write, and shell facts into a high-risk behavior chain that still requires agent context.',
    tone: 'judge',
  },
  {
    key: 'l2-escalate',
    duration: 1100,
    announcement: 'L2 把结构化行为链升级到 L3 安全审查智能体。',
    announcementEn:
      'L2 escalates the structured behavior chain to the L3 security review agent.',
    tone: 'judge',
  },
  {
    key: 'l3-arrival',
    duration: 900,
    announcement: 'L3 安全审查智能体主动进入调查室并接手升级案件。',
    announcementEn:
      'The L3 security review agent enters the investigation and takes over the escalated case.',
    tone: 'judge',
  },
  {
    key: 'l3-review',
    duration: 6000,
    announcement:
      'L3 安全审查智能体依次核验攻击意图、行为轨迹和主机指标，并锁定三类证据。',
    announcementEn:
      'L3 verifies malicious intent, the behavior trace, and host indicators, then locks in three evidence categories.',
    tone: 'judge',
  },
  {
    key: 'report',
    duration: 4200,
    announcement: 'L3 将证据收敛为远程代码植入安全报告，并给出严重风险结论。',
    announcementEn:
      'L3 consolidates the evidence into a remote-code-implant report and reaches a critical-risk conclusion.',
    tone: 'danger',
  },
  {
    key: 'rule',
    duration: 4700,
    announcement:
      '系统从安全报告中抽取获取、写入和 Shell 行为链，生成拒绝规则并安装到执行前门控。',
    announcementEn:
      'The system extracts the fetch, write, and shell chain, generates a deny rule, and installs it at the pre-execution gate.',
    tone: 'safe',
  },
  {
    key: 'retry',
    duration: 3000,
    announcement: '攻击智能体再次主动发出相似的远程植入命令。',
    announcementEn:
      'The compromised agent attempts a similar remote implant command again.',
    tone: 'danger',
  },
  {
    key: 'block',
    duration: 3000,
    announcement: '新规则在执行前完成匹配，相似危险动作被直接拒绝。',
    announcementEn:
      'The new rule matches before execution and rejects the similar dangerous action.',
    tone: 'safe',
  },
  {
    key: 'finale',
    duration: 3000,
    announcement: 'AnySentry 让一次被看见的风险，在下一次执行前直接被治理。',
    announcementEn:
      'AnySentry turns a risk seen once into governance before the next execution.',
    tone: 'safe',
  },
];

export const TOTAL_DURATION = CHAPTERS.reduce(
  (total, chapter) => total + chapter.duration,
  0,
);

export const CHAPTER_INDEX = Object.fromEntries(
  CHAPTERS.map((chapter, index) => [chapter.key, index]),
) as Record<ChapterKey, number>;

export function getChapterAt(elapsed: number) {
  let cursor = 0;

  for (let index = 0; index < CHAPTERS.length; index += 1) {
    const chapter = CHAPTERS[index];
    const end = cursor + chapter.duration;
    if (elapsed < end) {
      return {
        chapter,
        index,
        chapterElapsed: Math.max(0, elapsed - cursor),
        progress: Math.max(
          0,
          Math.min(1, (elapsed - cursor) / chapter.duration),
        ),
      };
    }
    cursor = end;
  }

  const index = CHAPTERS.length - 1;
  return {
    chapter: CHAPTERS[index],
    index,
    chapterElapsed: CHAPTERS[index].duration,
    progress: 1,
  };
}

export function formatDuration(milliseconds: number) {
  return `${Math.round(milliseconds / 1000)}s`;
}
