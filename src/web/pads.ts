// Gamepad relay: every pad on this host is polled each frame and its state (buttons, sticks,
// triggers) is sent when it changes, at most once per tick. FX come back as tick-stamped events
// like everyone else's. Edge-triggered buttons map straight to room actions.
import { BTN } from '../core/fx.ts';
import type { ClientMsg, Quant } from '../core/protocol.ts';

const DEAD = 0.14;
const q = (v: number) => (Math.abs(v) < DEAD ? 0 : Math.round(((v - Math.sign(v) * DEAD) / (1 - DEAD)) * 100));

export interface PadActions {
  scene(step: number): void;
  view(step: number): void;
}

interface Sent { b: number; a: number[]; t: number[]; at: number }

export class PadRelay {
  private sent = new Map<number, Sent>();
  private prevButtons = new Map<number, number>();
  readonly connected = new Map<number, string>();
  private send: (m: ClientMsg) => void;
  private actions: PadActions;

  constructor(send: (m: ClientMsg) => void, actions: PadActions) {
    this.send = send; this.actions = actions;
    addEventListener('gamepadconnected', (e) => this.connected.set(e.gamepad.index, e.gamepad.id));
    addEventListener('gamepaddisconnected', (e) => {
      this.connected.delete(e.gamepad.index);
      this.send({ t: 'ev', type: 'pad', payload: { l: e.gamepad.index, b: 0, a: [0, 0, 0, 0], t: [0, 0] } });
      this.sent.delete(e.gamepad.index);
    });
  }

  /** Call every frame. */
  poll(quant: Quant): void {
    if (!navigator.getGamepads) return;
    const now = performance.now();
    for (const gp of navigator.getGamepads()) {
      if (!gp || !gp.connected) continue;
      this.connected.set(gp.index, gp.id);
      let b = 0;
      gp.buttons.forEach((x, i) => { if (x.pressed && i < 17) b |= 1 << i; });
      const ax = gp.axes, a = [q(ax[0] ?? 0), q(ax[1] ?? 0), q(ax[2] ?? 0), q(ax[3] ?? 0)];
      const t = [Math.round((gp.buttons[BTN.L2]?.value ?? 0) * 100), Math.round((gp.buttons[BTN.R2]?.value ?? 0) * 100)];

      // edges: room actions
      const prev = this.prevButtons.get(gp.index) ?? 0, down = b & ~prev;
      this.prevButtons.set(gp.index, b);
      const hit = (bit: number) => (down >> bit) & 1;
      if (hit(BTN.L1)) this.send({ t: 'scene', step: -1, quant });
      if (hit(BTN.R1)) this.send({ t: 'scene', step: 1, quant });
      if (hit(BTN.LEFT)) this.send({ t: 'ev', type: 'palette', payload: { step: -1 } });
      if (hit(BTN.RIGHT)) this.send({ t: 'ev', type: 'palette', payload: { step: 1 } });
      if (hit(BTN.UP)) this.actions.view(-1);
      if (hit(BTN.DOWN)) this.actions.view(1);
      if (hit(BTN.L3)) this.send({ t: 'ev', type: 'hit' });
      if (hit(BTN.R3)) this.send({ t: 'ev', type: 'freeze' });
      if (hit(BTN.OPTIONS)) this.send({ t: 'tap' });

      // state: on change, at most once per tick; small stick jitter (<3) only goes out with other changes
      const s = this.sent.get(gp.index);
      const moved = !s || s.b !== b || s.t.some((v, i) => Math.abs(v - t[i]) >= 3) || s.a.some((v, i) => Math.abs(v - a[i]) >= 3 || (v !== 0) !== (a[i] !== 0));
      if (!moved || (s && now - s.at < 16)) continue;
      this.sent.set(gp.index, { b, a, t, at: now });
      this.send({ t: 'ev', type: 'pad', payload: { l: gp.index, b, a, t } });
    }
  }
}
