const PAN_IGNORE_SELECTOR =
  '[data-testid="kanban-card"], button, a, input, textarea, select, [role="menu"], [data-dnd-handle]';

export function shouldStartPan(input: {
  readonly button: number;
  readonly pointerType: string;
  readonly onInteractive: boolean;
}): boolean {
  return input.button === 0 && input.pointerType === "mouse" && !input.onInteractive;
}

/** Horizontal scroll amount for a mostly vertical wheel gesture, or null to leave it native. */
export function wheelToHorizontalDelta(deltaX: number, deltaY: number): number | null {
  return Math.abs(deltaY) > Math.abs(deltaX) ? deltaY : null;
}

function canScrollY(el: HTMLElement, dy: number) {
  const { overflowY } = getComputedStyle(el);
  if (overflowY !== "auto" && overflowY !== "scroll") return false;
  return dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0;
}

function scrollableAncestorY(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (canScrollY(node, 1) || canScrollY(node, -1)) return node;
  }
  return null;
}

/** Callback ref: drag-to-pan with the mouse and vertical wheel to horizontal scroll. */
export function boardPanRef(el: HTMLElement | null) {
  {
    if (el === null) return;
    let pan: { x: number; y: number; id: number; page: HTMLElement | null } | null = null;

    const onDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (
        !shouldStartPan({
          button: e.button,
          pointerType: e.pointerType,
          onInteractive: target?.closest(PAN_IGNORE_SELECTOR) != null,
        })
      ) {
        return;
      }
      pan = { x: e.clientX, y: e.clientY, id: e.pointerId, page: scrollableAncestorY(el) };
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
      el.style.userSelect = "none";
    };
    const onMove = (e: PointerEvent) => {
      if (pan === null || e.pointerId !== pan.id) return;
      el.scrollLeft -= e.clientX - pan.x;
      if (pan.page) pan.page.scrollTop -= e.clientY - pan.y;
      pan.x = e.clientX;
      pan.y = e.clientY;
    };
    const onEnd = (e: PointerEvent) => {
      if (pan === null || e.pointerId !== pan.id) return;
      pan = null;
      el.style.cursor = "";
      el.style.userSelect = "";
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.shiftKey) return;
      const dx = wheelToHorizontalDelta(e.deltaX, e.deltaY);
      if (dx === null) return;
      for (let node = e.target instanceof HTMLElement ? e.target : null; node && node !== el;) {
        if (canScrollY(node, e.deltaY)) return;
        node = node.parentElement;
      }
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0 || (dx > 0 ? el.scrollLeft >= max : el.scrollLeft <= 0)) return;
      e.preventDefault();
      el.scrollLeft += dx;
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onEnd);
    el.addEventListener("pointercancel", onEnd);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onEnd);
      el.removeEventListener("pointercancel", onEnd);
      el.removeEventListener("wheel", onWheel);
    };
  }
}
