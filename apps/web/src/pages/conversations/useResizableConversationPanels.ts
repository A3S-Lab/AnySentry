import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

const STORAGE_KEY = "anysentry.conversations.panel-layout.v1";
const DEFAULT_LEFT = 300;
const DEFAULT_RIGHT = 420;
const LEFT_MIN = 240;
const LEFT_MAX = 520;
const RIGHT_MIN = 320;
const CENTER_MIN = 480;

type Side = "left" | "right";

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function storedLayout() {
  if (typeof window === "undefined") return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT };
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as {
      left?: number;
      right?: number;
    };
    return {
      left: Number.isFinite(value.left) ? clamp(value.left!, LEFT_MIN, LEFT_MAX) : DEFAULT_LEFT,
      right: Number.isFinite(value.right) ? Math.max(RIGHT_MIN, value.right!) : DEFAULT_RIGHT,
    };
  } catch {
    return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT };
  }
}

export function useResizableConversationPanels() {
  const initial = useRef(storedLayout());
  const [leftWidth, setLeftWidth] = useState(initial.current.left);
  const [rightWidth, setRightWidth] = useState(initial.current.right);
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    side: Side;
    pointerId: number;
    startX: number;
    startWidth: number;
  }>();

  const bounds = (side: Side) => {
    const available = containerRef.current?.clientWidth
      ?? (typeof window === "undefined" ? 1_440 : window.innerWidth);
    if (side === "left") {
      return { minimum: LEFT_MIN, maximum: Math.max(LEFT_MIN, Math.min(LEFT_MAX, available - CENTER_MIN)) };
    }
    return {
      minimum: RIGHT_MIN,
      maximum: Math.max(
        RIGHT_MIN,
        Math.min(Math.floor(available * 0.5), available - leftWidth - CENTER_MIN),
      ),
    };
  };
  const resize = (side: Side, value: number) => {
    const { minimum, maximum } = bounds(side);
    if (side === "left") setLeftWidth(clamp(value, minimum, maximum));
    else setRightWidth(clamp(value, minimum, maximum));
  };
  const reset = (side: Side) => resize(side, side === "left" ? DEFAULT_LEFT : DEFAULT_RIGHT);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: leftWidth, right: rightWidth }));
  }, [leftWidth, rightWidth]);

  useEffect(() => {
    const fit = () => {
      const left = bounds("left");
      const right = bounds("right");
      setLeftWidth((value) => clamp(value, left.minimum, left.maximum));
      setRightWidth((value) => clamp(value, right.minimum, right.maximum));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  });

  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const active = drag.current;
      if (!active || event.pointerId !== active.pointerId) return;
      const delta = event.clientX - active.startX;
      resize(active.side, active.startWidth + (active.side === "left" ? delta : -delta));
    };
    const end = (event: globalThis.PointerEvent) => {
      if (drag.current?.pointerId === event.pointerId) drag.current = undefined;
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
  });

  const separatorProps = (side: Side) => {
    const { minimum, maximum } = bounds(side);
    const value = side === "left" ? leftWidth : rightWidth;
    return {
      role: "separator" as const,
      tabIndex: 0,
      "aria-orientation": "vertical" as const,
      "aria-label": side === "left" ? "调整 Agent 目录宽度" : "调整事件检查器宽度",
      "aria-valuemin": minimum,
      "aria-valuemax": maximum,
      "aria-valuenow": Math.round(value),
      onDoubleClick: () => reset(side),
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          side,
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: value,
        };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      },
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Enter") {
          event.preventDefault();
          reset(side);
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const step = event.shiftKey ? 32 : 16;
        const direction = event.key === "ArrowRight" ? 1 : -1;
        resize(side, value + (side === "left" ? direction : -direction) * step);
      },
    };
  };

  return {
    containerRef,
    panelStyle: {
      "--conversation-left": `${leftWidth}px`,
      "--conversation-right": `${rightWidth}px`,
    } as CSSProperties,
    leftSeparatorProps: separatorProps("left"),
    rightSeparatorProps: separatorProps("right"),
  };
}
