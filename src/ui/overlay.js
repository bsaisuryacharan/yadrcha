// Overlays (full player, bottom sheets) participate in browser history so
// the phone's back gesture closes them instead of leaving the page.

import { h } from '../util.js';

const stack = [];   // [{ name, close }]
let ignorePop = 0;
let afterPop = [];

window.addEventListener('popstate', () => {
  if (ignorePop > 0) {
    ignorePop--;
    if (!ignorePop) { const cbs = afterPop; afterPop = []; cbs.forEach((f) => f()); }
    return;
  }
  const top = stack.pop();
  if (top) top.close(true);
});

export function pushOverlay(name, close) {
  stack.push({ name, close });
  history.pushState({ overlay: name, depth: stack.length }, '');
}

function unwind(fromIndex, then) {
  const closing = stack.splice(fromIndex);
  if (!closing.length) {
    // A close is still travelling through history — navigate after it lands.
    if (then && ignorePop > 0) afterPop.push(then); else then?.();
    return;
  }
  ignorePop++;
  if (then) afterPop.push(then);
  history.go(-closing.length);
  closing.reverse().forEach((o) => o.close(true));
}

/** Close an overlay from UI (button/drag), popping its history entry too.
 *  `then` runs once history has settled (safe to navigate). */
export function popOverlay(name, then) {
  const i = stack.map((o) => o.name).lastIndexOf(name);
  if (i < 0) { then?.(); return; }
  unwind(i, then);
}
export const hasOverlay = (name) => stack.some((o) => o.name === name);
export function closeAllOverlays(then) { unwind(0, then); }

/** Drag-down-to-dismiss for a sheet/panel element. */
export function dragToDismiss(handle, panel, onDismiss, { threshold = 110 } = {}) {
  let y0 = null, dy = 0, t0 = 0, captured = false;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    y0 = e.clientY; dy = 0; t0 = performance.now(); captured = false;
  });
  handle.addEventListener('pointermove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.clientY - y0);
    // Only take over once it's clearly a drag, so taps on buttons inside
    // the handle still click.
    if (!captured && dy > 6) {
      captured = true;
      panel.classList.add('dragging');
      try { handle.setPointerCapture(e.pointerId); } catch {}
    }
    if (captured) panel.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (y0 == null) return;
    const v = dy / Math.max(1, performance.now() - t0);
    y0 = null;
    if (!captured) return;
    captured = false;
    panel.classList.remove('dragging');
    panel.style.transform = '';
    if (dy > threshold || v > 0.6) onDismiss();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/** Generic bottom sheet. build(body, close) fills it. */
export function openSheet(build, { name = 'sheet', className = '' } = {}) {
  const root = document.getElementById('sheets');
  const grab = h('div.sheet-grab', h('i'));
  const body = h('div.sheet-body');
  const sheet = h('div.sheet' + (className ? '.' + className : ''), { role: 'dialog', 'aria-modal': 'true' }, grab);
  const scrim = h('div.sheet-scrim');
  const wrap = h('div.sheet-wrap', scrim, sheet);
  let closed = false;
  const close = (fromHistory) => {
    if (closed) return;
    closed = true;
    if (!fromHistory) { popOverlay(name); return; }
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 380);
  };
  const api = { close: () => { if (!closed) popOverlay(name); } };
  const head = build(body, api.close);
  if (head) sheet.append(head);
  sheet.append(body);
  scrim.addEventListener('click', api.close);
  dragToDismiss(grab, sheet, api.close);
  if (head) dragToDismiss(head, sheet, api.close);
  root.append(wrap);
  pushOverlay(name, close);
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')));
  return api;
}
