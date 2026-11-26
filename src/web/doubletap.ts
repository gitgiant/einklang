// Double-tap (double-click) on the background hides the UI until the next one. Pointer events cover
// mouse, touch and pen alike. Pages also set `touch-action: manipulation` so iOS doesn't zoom.
// A page may also act on single taps (the gallery's tap zones): one counts only once the double-tap
// window has passed without its second tap, so a double-tap never acts as a single one too.

/** A press longer than this, or one that moved further, isn't a tap. */
const TAP_MS = 350, TAP_PX = 12;
/** The second tap must lift this soon after the first, and land this close to it. */
const GAP_MS = 450, GAP_PX = 40;
/** How long a tap waits before it counts as single: the pair window, plus slack for a late event. */
export const SINGLE_MS = GAP_MS + 30;

/** The screen third a tap at `x` is in: -1 left, 0 middle, 1 right. */
export const tapZone = (x: number, width: number): -1 | 0 | 1 => (x < width / 3 ? -1 : x > (width * 2) / 3 ? 1 : 0);

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

  /** When the tap still waiting for its pair lifted. */
  get waiting(): number | null { return this.tap?.t ?? null; }

  reset(): void { this.press = this.tap = null; }
}

/** Tells single taps from double ones. */
export class Taps {
  private pair = new DoubleTap();
  private singles: { t: number; x: number }[] = [];

  down(t: number, x: number, y: number, id = 0): void { this.pair.down(t, x, y, id); }

  /** True when this release completes a double-tap, which takes its first tap back. */
  up(t: number, x: number, y: number, id = 0): boolean {
    const first = this.pair.waiting;
    if (this.pair.up(t, x, y, id)) { this.singles = this.singles.filter((s) => s.t !== first); return true; }
    if (this.pair.waiting === t) this.singles.push({ t, x });
    return false;
  }

  /** The x of each tap that has turned out single by `now`, each reported once. */
  due(now: number): number[] {
    const ready = this.singles.filter((s) => now - s.t >= SINGLE_MS);
    this.singles = this.singles.filter((s) => !ready.includes(s));
    return ready.map((s) => s.x);
  }

  /** Forget the gesture and any tap still waiting. */
  reset(): void { this.pair.reset(); this.singles = []; }
}

/**
 * Toggle `ui-off` on <body> (each page's CSS hides its UI under it) on a double-tap on the background,
 * and report single taps there to `single`. A press anywhere else drops a tap still waiting.
 */
export function toggleUiOnDoubleTap(isBackground: (target: Element) => boolean, single?: (x: number) => void): void {
  const d = new Taps(), bg = (e: PointerEvent) => e.target instanceof Element && isBackground(e.target);
  addEventListener('pointerdown', (e) => { if (bg(e) && e.button === 0) d.down(e.timeStamp, e.clientX, e.clientY, e.pointerId); else d.reset(); }, { capture: true });
  addEventListener('pointercancel', () => d.reset(), { capture: true });
  addEventListener('pointerup', (e) => {
    if (!bg(e)) return;
    if (!d.up(e.timeStamp, e.clientX, e.clientY, e.pointerId)) {
      if (single) setTimeout(() => d.due(performance.now()).forEach(single), SINGLE_MS);
      return;
    }
    if (document.body.classList.toggle('ui-off')) (document.activeElement as HTMLElement | null)?.blur();
  }, { capture: true });
}
