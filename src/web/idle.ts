// Hide the UI after a few seconds without input (mouse, touch, keys, wheel); any input brings it back.
// Adds `idle` to <body>; each page's CSS fades its own controls out under `body.idle`.
// While the pointer rests on a control, the UI stays.

export function autoHideUi(controls: () => (HTMLElement | null)[], ms = 3000): void {
  let timer = 0;
  const hide = () => {
    if (controls().some((e) => e?.matches(':hover') || e?.contains(document.activeElement) && document.activeElement?.tagName === 'SELECT')) { arm(); return; }
    document.body.classList.add('idle');
  };
  const arm = () => { clearTimeout(timer); timer = window.setTimeout(hide, ms); };
  const wake = () => { document.body.classList.remove('idle'); arm(); };
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, wake, { passive: true, capture: true });
  arm();
}
