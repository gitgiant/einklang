// Double-tap (double-click) on the background hides the UI until the next one. Pointer events cover
// mouse, touch and pen alike. Pages also set `touch-action: manipulation` so iOS doesn't zoom.

/** A press longer than this, or one that moved further, isn't a tap. */
const TAP_MS = 350, TAP_PX = 12;
/** The second tap must lift this soon after the first, and land this close to it. */
const GAP_MS = 450, GAP_PX = 40;

export class DoubleTap {
  private press: { t: number; x: number; y: number; id: number } | null = null;
  private tap: { t: number; x: number; y: number } | null = null;

  down(t: number, x: number, y: number, id = 0): void {
    // a second finger: a pinch or a two-finger tap, not a double-tap
    if (this.press && this.press.id !== id) return this.reset();
    this.press = { t, x, y, id };
  }

  /** True when this release completes a double-tap. */
  up(t: number, x: number, y: number, id = 0): boolean {
    const p = this.press; this.press = null;
    if (!p || p.id !== id || t - p.t > TAP_MS || Math.hypot(x - p.x, y - p.y) > TAP_PX) { this.tap = null; return false; }
    const a = this.tap;
    if (a && t - a.t <= GAP_MS && Math.hypot(x - a.x, y - a.y) <= GAP_PX) { this.tap = null; return true; }
    this.tap = { t, x, y };
    return false;
  }

  reset(): void { this.press = this.tap = null; }
}

/** Toggle `ui-off` on <body> (each page's CSS hides its UI under it) on a double-tap on the background. */
export function toggleUiOnDoubleTap(isBackground: (target: Element) => boolean): void {
  const d = new DoubleTap(), bg = (e: PointerEvent) => e.target instanceof Element && isBackground(e.target);
  addEventListener('pointerdown', (e) => { if (bg(e) && e.button === 0) d.down(e.timeStamp, e.clientX, e.clientY, e.pointerId); else d.reset(); }, { capture: true });
  addEventListener('pointercancel', () => d.reset(), { capture: true });
  addEventListener('pointerup', (e) => {
    if (!bg(e) || !d.up(e.timeStamp, e.clientX, e.clientY, e.pointerId)) return;
    if (document.body.classList.toggle('ui-off')) (document.activeElement as HTMLElement | null)?.blur();
  }, { capture: true });
}
