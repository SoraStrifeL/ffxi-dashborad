# Map Pan Arrow Controls

## Problem

The Map tab (`client/src/components/pages/Map.tsx`) only supports panning by
click-and-drag. That's imprecise on touch/phone screens for fine
positioning. Zoom already has discrete +/−/reset buttons in the bottom-right
canvas overlay; pan has no discrete equivalent.

## Scope

Map tab only — a new button cluster inside the existing canvas overlay
(`canvasWrapRef`'s children, alongside the existing zoom controls). No
changes to drag-panning, zoom, or any other Map behavior.

## Component: pan D-pad

Rendered as a new sibling block immediately before the existing "Zoom
controls" block (`Map.tsx:1424-1434`), gated the same way
(`{zone !== null && (...)}`), positioned at the opposite bottom corner:

```
{/* Pan controls */}
{zone !== null && (
  <div style={{ position: 'absolute', bottom: 16, left: 16, zIndex: 10 }}>
    {/* 3x3 grid, only the 4 edge cells populated (plus-sign layout) */}
  </div>
)}
```

Each of the 4 buttons is 28×28px, styled identically to the existing zoom
buttons (`background: rgba(10,10,18,.85)`, `border: 1px solid
var(--color-border)`, `borderRadius: 5`, `color: var(--color-text1)`,
`fontSize: 16`) so it visually reads as part of the same control family.
Glyphs: `▲` `▼` `◀` `▶`. Laid out via CSS grid (`gridTemplateColumns: repeat(3,
28px)`, `gridTemplateRows: repeat(3, 28px)`, `gap: 4px`) with the up/down/left/
right buttons placed in the 4 edge cells and the other 5 cells empty
(no element rendered — grid gaps show through to the canvas below).

## Pan mechanics

Reuses the exact mechanism drag-panning already uses —
`stageTransform.current` (`Map.tsx:181`, `{ zoom, panX, panY }`) and
`applyContainerTransform()` (`Map.tsx:285-291`, which just does
`app.stage.scale.set(st.zoom); app.stage.position.set(st.panX, st.panY);`).
No new coordinate math.

**Step size:** computed from the canvas's current rendered size, not a fixed
constant, so it scales sensibly across phone/tablet/desktop:

```ts
function panStep(): number {
  const app = appRef.current;
  const dim = app ? Math.min(app.screen.width, app.screen.height) : 400;
  return Math.max(60, dim * 0.15);
}
```

**Direction → transform delta** (matches drag-panning's existing sign
convention, where dragging the pointer down/right reveals content that was
above/left by increasing `panY`/`panX`):

| Button | Effect | Delta |
|---|---|---|
| ▲ Up | reveal content above | `st.panY += step` |
| ▼ Down | reveal content below | `st.panY -= step` |
| ◀ Left | reveal content to the left | `st.panX += step` |
| ▶ Right | reveal content to the right | `st.panX -= step` |

Each direction is a function `pan(dx: number, dy: number)`:

```ts
function panBy(dx: number, dy: number) {
  const st = stageTransform.current;
  st.panX += dx;
  st.panY += dy;
  applyContainerTransform();
}
```

called as `panBy(step, 0)` (left), `panBy(-step, 0)` (right), `panBy(0,
step)` (up), `panBy(0, -step)` (down) — step recomputed via `panStep()` on
every fire, not cached, so it stays correct if the window is resized while a
hold-repeat is in progress.

## Hold-to-repeat

Press-and-hold fires once immediately on press, then (after a 400ms initial
delay) repeats every 60ms until release. Implemented with a single `useRef`
holding the active timer handle(s), following this file's existing
ref-for-mutable-interaction-state convention (e.g. `dragRef`,
`toastTimer`):

```ts
const panRepeatRef = useRef<{ timeout: ReturnType<typeof setTimeout> | null; interval: ReturnType<typeof setInterval> | null }>({ timeout: null, interval: null });

function startPanRepeat(dx: number, dy: number) {
  panBy(dx, dy); // fire immediately
  panRepeatRef.current.timeout = setTimeout(() => {
    panRepeatRef.current.interval = setInterval(() => panBy(dx, dy), 60);
  }, 400);
}
function stopPanRepeat() {
  if (panRepeatRef.current.timeout) clearTimeout(panRepeatRef.current.timeout);
  if (panRepeatRef.current.interval) clearInterval(panRepeatRef.current.interval);
  panRepeatRef.current = { timeout: null, interval: null };
}
```

Each of the 4 buttons wires `onPointerDown={() => startPanRepeat(dx, dy)}`,
`onPointerUp={stopPanRepeat}`, `onPointerLeave={stopPanRepeat}` (the
`onPointerLeave` fallback matches the existing pattern already used for the
canvas drag itself, so a press that drags off the button before release
still stops cleanly).

`dx`/`dy` are computed fresh inside each handler via `panStep()` (called at
press time, and again on every repeat tick) rather than closed over once, so
step size stays correct across a resize mid-hold.

## Interaction with the earlier pointer-capture fix

These are new `<button>` elements inside `canvasWrapRef`, whose
`onPointerDown` already guards `if ((e.target as HTMLElement).closest('button')) return;`
(added earlier this session to fix zoom/collapse-toggle buttons not
responding to real clicks). This guard applies automatically to the new
pan buttons too — no additional change needed there, and it's a good
regression check that the earlier fix generalizes.

## Edge cases

- Buttons are unmounted (via the `{zone !== null && ...}` gate) when no zone
  is selected — `stopPanRepeat()`'s timers are cleared naturally since a
  hold can't be in progress across that transition (the button itself
  disappears, taking its pointer capture/events with it).
- If a hold-repeat is in progress and the component unmounts (route away
  from Map entirely), the interval would leak without cleanup — add a
  `useEffect` cleanup that calls `stopPanRepeat()` on unmount.

## Out of scope

- Keyboard arrow-key support (explicitly deferred — this is a touch-focused
  feature).
- Any change to the existing zoom or drag-pan behavior.
