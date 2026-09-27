import { useVirtualizer } from "@tanstack/react-virtual";
import type { Key, ReactNode } from "react";
import { useRef } from "react";

interface AdaptiveVirtualListProps<T> {
  items: readonly T[];
  getKey: (item: T, index: number) => Key;
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
  estimateSize: number;
  threshold?: number;
  overscan?: number;
}

export function AdaptiveVirtualList<T>({
  items,
  getKey,
  renderItem,
  className,
  estimateSize,
  threshold = 100,
  overscan = 8,
}: AdaptiveVirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualized = items.length >= threshold;
  const virtualizer = useVirtualizer({
    count: virtualized ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    getItemKey: (index) => getKey(items[index], index),
    overscan,
  });

  if (!virtualized) {
    return (
      <div className={className} data-list-mode="standard">
        {items.map((item, index) => (
          <div key={getKey(item, index)}>{renderItem(item, index)}</div>
        ))}
      </div>
    );
  }

  return (
    <div ref={scrollRef} className={className} data-list-mode="virtual">
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            {renderItem(items[virtualRow.index], virtualRow.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
