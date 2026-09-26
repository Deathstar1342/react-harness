import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";

export function useEditorLayout() {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(440);
  const [available, setAvailable] = useState(1000);
  const [expanded, setExpanded] = useState(false);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const observer = new ResizeObserver(() => setAvailable(workspace.clientWidth));
    setAvailable(workspace.clientWidth);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  // Leave room for the conversation; expand mode uses the entire workspace.
  const maximum = Math.max(310, available - 360);
  const actualWidth = Math.min(maximum, Math.max(310, width));
  const updateWidth = (next: number) => setWidth(Math.min(maximum, Math.max(310, next)));
  const finishDrag = () => {
    drag.current = null;
    setResizing(false);
  };

  return {
    workspaceRef,
    expanded,
    toggleExpanded: () => setExpanded((value) => !value),
    resizing,
    style: { "--editor-width": `${actualWidth}px` } as CSSProperties,
    separatorProps: {
      role: "separator",
      tabIndex: 0,
      "aria-label": "Resize file editor",
      "aria-orientation": "vertical" as const,
      "aria-controls": "workspace-file-editor",
      "aria-valuemin": 310,
      "aria-valuemax": maximum,
      "aria-valuenow": actualWidth,
      "aria-valuetext": `${Math.round(actualWidth)} pixels wide`,
      title: "Drag to resize · Arrow keys to adjust · Double-click to reset",
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, width: actualWidth };
        setResizing(true);
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        updateWidth(drag.current.width + drag.current.x - event.clientX);
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        finishDrag();
        event.currentTarget.releasePointerCapture(event.pointerId);
      },
      onPointerCancel: finishDrag,
      onLostPointerCapture: finishDrag,
      onDoubleClick: () => setWidth(440),
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? 80 : 20;
        const next = {
          ArrowLeft: actualWidth + step,
          ArrowRight: actualWidth - step,
          Home: 310,
          End: maximum,
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        updateWidth(next);
      },
    },
  };
}
