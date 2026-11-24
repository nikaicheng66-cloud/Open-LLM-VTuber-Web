/* eslint-disable no-underscore-dangle */
// [deskpet] Body actions driven by tags in the AI's reply and by the user's own words:
//   pose:<name>                play one of the pose motions
//   walk:<place>               walk to left|right|top|bottom|center|top_left|... with the walk cycle
//   nudge:left|right|up|down   a few steps that way ("往右走一点")
//   hide:left|right|bottom|top tuck into a screen edge, leaving half the head visible
//   vanish                     fully invisible and click-through
//   come_out                   back into sight, and out of hiding to where she was before
//   sleep | wake               the sleepy face while she isn't listening
import { LAppDelegate } from '../../WebSDK/src/lappdelegate';
import * as LAppDefine from '../../WebSDK/src/lappdefine';

// Model-local units (the model canvas is 1.0 wide and ~1.79 tall, origin at its centre).
const BODY_HALF_W = 0.3; // half the width of the character herself
const HEAD_Y = 0.7; // height of the middle of her head
const HALF_H = 0.9; // half her height, used to keep her on screen when walking up/down
const PEEK_EDGE = 0.55; // where the screen edge cuts her when peeking (just below the eyes)
// The walk frames are drawn facing screen-right. Set to false if she walks backwards.
const WALK_FACES_RIGHT = true;
const SCREEN_CROSS_SECONDS = 7; // time to walk the full width of the screen
const NUDGE_SHARE = 0.18; // a nudge moves her this share of the screen width (or height, going up/down)
const POSES = ['wave', 'point', 'chin', 'cheer', 'reading', 'parasol'];

type Mat = number[];

let rafId: number | null = null;
let walking = false;
let walkTimer: ReturnType<typeof setInterval> | null = null;
let beforeHide: Mat | null = null;
let vanished = false;

function env() {
  const adapter = (window as any).getLAppAdapter?.();
  const model = adapter?.getModel?.();
  const view = LAppDelegate.getInstance()?.getView?.();
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  if (!model || !model._modelMatrix || !view || !canvas) return null;
  const d = view._deviceToScreen;
  return {
    model,
    left: d.transformX(0),
    right: d.transformX(canvas.width),
    top: d.transformY(0),
    bottom: d.transformY(canvas.height),
  };
}

const getM = (model: any): Mat => [...model._modelMatrix.getArray()];
const setM = (model: any, m: Mat) => model._modelMatrix.setMatrix(m);
const scaleOf = (m: Mat) => Math.hypot(m[0], m[1]);

function stopAnim() {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
}

let pendingDone: (() => void) | undefined;

function animate(model: any, from: Mat, to: Mat, ms: number, ease: boolean, onDone?: () => void) {
  stopAnim();
  pendingDone = onDone;
  const t0 = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / Math.max(ms, 1));
    const e = ease ? (k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2) : k;
    setM(model, from.map((v, i) => v + (to[i] - v) * e));
    if (k < 1) rafId = requestAnimationFrame(step);
    else {
      rafId = null;
      pendingDone = undefined;
      onDone?.();
    }
  };
  rafId = requestAnimationFrame(step);
}

// [deskpet] the user grabbed her while she was walking: stop where she is (the walk's own
// finish runs so the command queue moves on), so the walk and the drag don't fight over her position
function interruptWalk() {
  if (!walking || rafId === null) return;
  stopAnim();
  const done = pendingDone;
  pendingDone = undefined;
  done?.();
}

function startWalkCycle(model: any) {
  walking = true;
  model.startMotion('Walk', 0, LAppDefine.PriorityForce);
  // the walk motion is ~2.9 s long; restart it a little before it ends
  walkTimer = setInterval(() => {
    if (walking) model.startMotion('Walk', 0, LAppDefine.PriorityForce);
  }, 2700);
}

function stopWalkCycle(model: any) {
  walking = false;
  if (walkTimer) clearInterval(walkTimer);
  walkTimer = null;
  model.startMotion('Idle', 0, LAppDefine.PriorityForce);
}

function upright(m: Mat): Mat {
  const s = scaleOf(m);
  const r = [...m];
  r[0] = s; r[1] = 0; r[4] = 0; r[5] = s;
  return r;
}

// asked to step towards an edge she is already at: a little lean that way and back,
// so it is clear she heard and simply can't go further
function bump(model: any, cur: Mat, dir: string, after?: () => void) {
  const s = scaleOf(cur);
  const d = s * 0.04;
  const out = [...cur];
  if (dir === 'left') out[12] -= d;
  if (dir === 'right') out[12] += d;
  if (dir === 'up') out[13] += d;
  if (dir === 'down') out[13] -= d;
  animate(model, cur, out, 160, true, () => animate(model, out, cur, 220, true, after));
}

function walkTo(where: string, after?: () => void) {
  const e = env();
  if (!e) { after?.(); return; }
  const { model } = e;
  const cur = upright(getM(model));
  const s = scaleOf(cur);
  const marginX = s * BODY_HALF_W;
  const marginY = s * HALF_H;
  // where = left | right | top | bottom | center | top_left | bottom_right ...
  //       | nudge_left | nudge_right | nudge_up | nudge_down (a few steps from where she is)
  const parts = where.split('_');
  let targetX = cur[12];
  let targetY = cur[13];
  if (parts[0] === 'nudge') {
    const w = (e.right - e.left) * NUDGE_SHARE;
    const h = (e.top - e.bottom) * NUDGE_SHARE;
    if (parts[1] === 'left') targetX -= w;
    if (parts[1] === 'right') targetX += w;
    if (parts[1] === 'up') targetY += h; // model y grows upwards
    if (parts[1] === 'down') targetY -= h;
  } else {
    if (where === 'center') {
      targetX = (e.left + e.right) / 2;
      targetY = (e.top + e.bottom) / 2;
    }
    if (parts.includes('left')) targetX = e.left + marginX;
    if (parts.includes('right')) targetX = e.right - marginX;
    if (parts.includes('top')) targetY = e.top - marginY;
    if (parts.includes('bottom')) targetY = e.bottom + marginY;
  }
  // never walk (or nudge) off the screen; if the screen is narrower than she is, stay centred
  const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi));
  const isNudge = parts[0] === 'nudge';
  if (isNudge) {
    // a nudge only ever goes the way asked: stop at the edge, never step back from it
    // (she may already stand a little past the walking margin, e.g. at her start position)
    if (parts[1] === 'left') targetX = Math.min(cur[12], Math.max(targetX, e.left + marginX));
    if (parts[1] === 'right') targetX = Math.max(cur[12], Math.min(targetX, e.right - marginX));
    if (parts[1] === 'up') targetY = Math.max(cur[13], Math.min(targetY, e.top - marginY));
    if (parts[1] === 'down') targetY = Math.min(cur[13], Math.max(targetY, e.bottom + marginY));
  } else {
    targetX = clamp(targetX, e.left + marginX, e.right - marginX);
    targetY = clamp(targetY, e.bottom + marginY, e.top - marginY);
  }

  const dx = targetX - cur[12];
  const dy = targetY - cur[13];
  const dist = Math.hypot(dx, dy);
  if (dist < s * 0.02) {
    if (isNudge) { bump(model, cur, parts[1], after); return; } // already at that edge: show she tried
    after?.();
    return;
  }

  // face the way she is going (straight up/down: keep facing as is)
  const facingRight = Math.abs(dx) < s * 0.02 ? true : dx > 0;
  const mirror = facingRight === WALK_FACES_RIGHT ? 1 : -1;
  const from = [...cur];
  from[0] = s * mirror;
  const to = [...from];
  to[12] = targetX;
  to[13] = targetY;
  const ms = (dist / (e.right - e.left)) * SCREEN_CROSS_SECONDS * 1000;

  setM(model, from);
  startWalkCycle(model);
  animate(model, from, to, ms, false, () => {
    stopWalkCycle(model);
    setM(model, upright(getM(model)));
    after?.();
  });
}

function canvasEl(): HTMLCanvasElement | null {
  return document.getElementById('canvas') as HTMLCanvasElement | null;
}

// fully invisible (and click-through) until called back
function vanish() {
  const e = env();
  const c = canvasEl();
  if (!e || !c || vanished) return;
  vanished = true;
  c.style.transition = 'opacity 0.6s';
  c.style.opacity = '0';
  // her hit-test ignores a transparent model, so the mouse passes through
  setTimeout(() => { if (vanished) e.model.setOpacity?.(0); }, 600);
}

function appear(after?: () => void) {
  const e = env();
  const c = canvasEl();
  if (!e || !c || !vanished) { after?.(); return; }
  vanished = false;
  e.model.setOpacity?.(1);
  c.style.transition = 'opacity 0.6s';
  c.style.opacity = '1';
  setTimeout(() => after?.(), 600);
}

function hide(side: string, after?: () => void) {
  const e = env();
  if (!e) { after?.(); return; }
  const { model } = e;
  const cur = getM(model);
  if (!beforeHide) beforeHide = upright(cur);
  const base = beforeHide;
  const s = scaleOf(base);
  const headY = Math.min(Math.max(base[13] + s * HEAD_Y, e.bottom + s * 0.2), e.top - s * 0.2);
  const to = [...base];
  if (side === 'left') {
    // lie sideways so the head pokes in from the left edge
    to[0] = 0; to[1] = -s; to[4] = s; to[5] = 0;
    to[12] = e.left - s * PEEK_EDGE;
    to[13] = headY;
  } else if (side === 'right') {
    to[0] = 0; to[1] = s; to[4] = -s; to[5] = 0;
    to[12] = e.right + s * PEEK_EDGE;
    to[13] = headY;
  } else if (side === 'top') {
    // hang upside down from the top edge, eyes just below it
    to[0] = -s; to[1] = 0; to[4] = 0; to[5] = -s;
    to[13] = e.top + s * PEEK_EDGE;
  } else {
    // sink below the bottom edge, eyes just above it
    to[13] = e.bottom - s * PEEK_EDGE;
  }
  animate(model, cur, to, 700, true, after);
}

function comeOut(after?: () => void) {
  const e = env();
  if (!e || !beforeHide) { after?.(); return; }
  const target = beforeHide;
  beforeHide = null;
  animate(e.model, getM(e.model), target, 700, true, after);
}

function pose(name: string) {
  const e = env();
  if (!e || walking || beforeHide) return; // no poses while walking or hidden
  const idx = POSES.indexOf(name);
  if (idx >= 0) e.model.startMotion('Pose', idx, LAppDefine.PriorityForce);
}

// sleeping = not listening; shown with the sleepy face until woken
let asleep = false;
function setFace(name: string) {
  try { (window as any).getLAppAdapter?.()?.setExpression?.(name); } catch { /* model not ready */ }
}

// run one command; resolves when it has finished moving
function runOne(cmd: string, fromUser: boolean): Promise<void> {
  return new Promise((done) => {
    const [kind, arg = ''] = cmd.split(':');
    if (kind === 'sleep') { asleep = true; setFace('sleepy'); done(); return; }
    if (kind === 'wake') { asleep = false; setFace('normal'); done(); return; }
    if (kind === 'vanish') { vanish(); setTimeout(done, 600); return; }
    if (kind === 'come_out') {
      if (vanished) appear(() => comeOut(done));
      else comeOut(done);
      return;
    }
    if (vanished) {
      // invisible: the chat model's own tags can't bring her back, but the user asking her to
      // go somewhere or hide somewhere means he wants to see her there - reappear first
      const moves = kind === 'walk' || kind === 'nudge' || kind === 'hide';
      if (!(fromUser && moves)) { done(); return; }
      appear(() => runOne(cmd, fromUser).then(done));
      return;
    }
    if (kind === 'pose') { pose(arg); done(); return; }
    if (kind === 'walk' || kind === 'nudge') {
      const where = kind === 'nudge' ? `nudge_${arg}` : arg;
      if (beforeHide) comeOut(() => walkTo(where, done));
      else walkTo(where, done);
      return;
    }
    if (kind === 'hide') {
      // hide from where she is now (after any walk in the same request)
      if (beforeHide) comeOut(() => hide(arg, done)); // already hiding somewhere else: come out first
      else hide(arg, done);
      return;
    }
    done();
  });
}

// Where she is on the page, in CSS pixels: her head and her bounding box.
// Used by the chat bubbles so they follow her and flip to the side with room.
export interface PetScreenRect {
  headX: number;
  headY: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function screenRect(): PetScreenRect | null {
  const e = env();
  const c = canvasEl();
  if (!e || !c) return null;
  const m = getM(e.model);
  const rect = c.getBoundingClientRect();
  const toX = (lx: number) => rect.left + ((lx - e.left) / (e.right - e.left)) * rect.width;
  const toY = (ly: number) => rect.top + ((e.top - ly) / (e.top - e.bottom)) * rect.height;
  // apply the (possibly rotated/mirrored) model matrix to a model-local point
  const map = (x: number, y: number) => [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13]];
  const [hx, hy] = map(0, HEAD_Y);
  const corners = [
    map(-BODY_HALF_W, -HALF_H), map(BODY_HALF_W, -HALF_H),
    map(-BODY_HALF_W, HALF_H), map(BODY_HALF_W, HALF_H),
  ];
  const xs = corners.map((p) => toX(p[0]));
  const ys = corners.map((p) => toY(p[1]));
  return {
    headX: toX(hx),
    headY: toY(hy),
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

// commands from one request run in order: "walk to the top right, then hide" works
let queue: Promise<void> = Promise.resolve();
let lastPetActionAt = 0;
let tapTimer: ReturnType<typeof setTimeout> | undefined;

export const petActions = {
  run(cmds?: string[] | null, fromUser = false) {
    if (!cmds || cmds.length === 0) return;
    // the user's own words already moved her: ignore the chat model's tags for a moment,
    // so it can't add a different move (e.g. vanish) on top of the one asked for
    if (fromUser) lastPetActionAt = Date.now();
    else if (Date.now() - lastPetActionAt < 8000) return;
    // the chat model may walk and hide on its own, but disappearing completely only on the user's word
    if (!fromUser) cmds = cmds.filter((c) => c !== 'vanish');
    cmds.forEach((c) => {
      queue = queue.then(() => runOne(c, fromUser)).catch((err) => console.error('[deskpet] action failed', c, err));
    });
  },
  // clicked: only an angry or blushing face, then back to how she was
  tapReact() {
    if (vanished) return;
    setFace(Math.random() < 0.5 ? 'pout' : 'shy');
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => setFace(asleep ? 'sleepy' : 'normal'), 2500);
  },
  screenRect,
  interruptWalk,
  isHidden: () => beforeHide !== null,
  isVanished: () => vanished,
  isAsleep: () => asleep,
};

(window as any).petActions = petActions;
