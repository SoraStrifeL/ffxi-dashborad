# Map Pan Arrow Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a touch-friendly directional pan D-pad to the Map tab's canvas overlay, per `docs/superpowers/specs/2026-07-15-map-pan-arrow-controls-design.md`.

**Architecture:** A new bottom-left button cluster in `Map.tsx`'s canvas overlay (mirroring the existing bottom-right zoom controls), driving the same `stageTransform` ref and `applyContainerTransform()` function that drag-panning and zoom already use. Hold-to-repeat is implemented with a ref-held timer/interval pair, matching this file's existing ref-for-interaction-state convention.

**Tech Stack:** React 18, TypeScript, inline styles (matching the rest of `Map.tsx` — no CSS/Tailwind classes used in this file).

## Global Constraints

- Step size: `Math.max(60, Math.min(app.screen.width, app.screen.height) * 0.15)` — recomputed on every fire, not cached.
- Direction → delta (exact signs, matching drag-pan's existing convention): Up → `panY += step`, Down → `panY -= step`, Left → `panX += step`, Right → `panX -= step`.
- Hold-to-repeat timing: fire immediately on press, then a 400ms initial delay, then repeat every 60ms until release.
- Button styling must match the existing zoom buttons exactly: `width: 28, height: 28, background: 'rgba(10,10,18,.85)', border: '1px solid var(--color-border)', borderRadius: 5, color: 'var(--color-text1)', fontSize: 16, cursor: 'pointer', lineHeight: 1`.
- Position: `bottom: 16, left: 16` (zoom controls are `bottom: 16, right: 16`), gated by `{zone !== null && (...)}` exactly like the zoom controls block.
- No test framework exists in `client/` — verification is `npx tsc -b --noEmit` (run from `client/`) plus manual/live browser verification, per this repo's established convention this session.
- Scope: `client/src/components/pages/Map.tsx` only. No changes to drag-pan, zoom, or any other Map behavior.

---

### Task 1: Add the pan D-pad with hold-to-repeat

**Files:**
- Modify: `client/src/components/pages/Map.tsx`
  - Add a ref near `stageTransform` (`Map.tsx:181`)
  - Add `panStep()`, `panBy()`, `startPanRepeat()`, `stopPanRepeat()` functions near `applyContainerTransform()` (`Map.tsx:285`)
  - Add an unmount-cleanup `useEffect`
  - Add the D-pad JSX block immediately before the existing "Zoom controls" block (`Map.tsx:1424`)

**Interfaces:**
- Consumes: `stageTransform` (existing ref, `{ zoom, panX, panY }`), `applyContainerTransform()` (existing function), `appRef` (existing ref to the PIXI `Application`), `zone` (existing state, for the render gate).
- Produces: nothing consumed by other tasks — this is the only task in this plan.

- [ ] **Step 1: Add the hold-repeat ref**

In `client/src/components/pages/Map.tsx`, immediately after line 181 (`const stageTransform = useRef({ zoom: 1, panX: 0, panY: 0 });`), add:

```typescript
  const panRepeatRef = useRef<{ timeout: ReturnType<typeof setTimeout> | null; interval: ReturnType<typeof setInterval> | null }>({ timeout: null, interval: null });
```

- [ ] **Step 2: Add panStep/panBy/startPanRepeat/stopPanRepeat**

Immediately after `applyContainerTransform()`'s closing brace (the function currently at `Map.tsx:285-291`:
```typescript
  function applyContainerTransform() {
    const app = appRef.current;
    if (!app) return;
    const st = stageTransform.current;
    app.stage.scale.set(st.zoom);
    app.stage.position.set(st.panX, st.panY);
  }
```
), add these four new functions:

```typescript
  function panStep(): number {
    const app = appRef.current;
    const dim = app ? Math.min(app.screen.width, app.screen.height) : 400;
    return Math.max(60, dim * 0.15);
  }

  function panBy(dx: number, dy: number) {
    const st = stageTransform.current;
    st.panX += dx;
    st.panY += dy;
    applyContainerTransform();
  }

  function startPanRepeat(dir: 'up' | 'down' | 'left' | 'right') {
    const fire = () => {
      const step = panStep();
      if (dir === 'up')    panBy(0, step);
      if (dir === 'down')  panBy(0, -step);
      if (dir === 'left')  panBy(step, 0);
      if (dir === 'right') panBy(-step, 0);
    };
    fire(); // fire immediately on press
    panRepeatRef.current.timeout = setTimeout(() => {
      panRepeatRef.current.interval = setInterval(fire, 60);
    }, 400);
  }

  function stopPanRepeat() {
    if (panRepeatRef.current.timeout)  clearTimeout(panRepeatRef.current.timeout);
    if (panRepeatRef.current.interval) clearInterval(panRepeatRef.current.interval);
    panRepeatRef.current = { timeout: null, interval: null };
  }
```

- [ ] **Step 3: Add unmount cleanup**

Find the component's other simple lifecycle `useEffect`s (e.g. `useEffect(() => { zoneDrawRef.current = zone; }, [zone]);` around `Map.tsx:817`, search for the exact current line with `grep -n "zoneDrawRef.current   = zone" client/src/components/pages/Map.tsx` since line numbers shift after Steps 1-2's insertions). Immediately after that block of ref-mirror effects, add a new effect:

```typescript
  // Stop any in-progress pan hold-repeat if the page unmounts mid-press
  useEffect(() => stopPanRepeat, []);
```

- [ ] **Step 4: Add the D-pad JSX**

Find the current line of `{/* Zoom controls */}` (shifted from `Map.tsx:1424` by the earlier insertions — locate via `grep -n "Zoom controls" client/src/components/pages/Map.tsx`). Immediately before that comment/block, insert:

```typescript
        {/* Pan controls */}
        {zone !== null && (
          <div style={{
            position: 'absolute', bottom: 16, left: 16, zIndex: 10,
            display: 'grid', gridTemplateColumns: 'repeat(3, 28px)', gridTemplateRows: 'repeat(3, 28px)', gap: 4,
          }}>
            <button
              onPointerDown={() => startPanRepeat('up')} onPointerUp={stopPanRepeat} onPointerLeave={stopPanRepeat}
              style={{ gridColumn: 2, gridRow: 1, width: 28, height: 28, background: 'rgba(10,10,18,.85)', border: '1px solid var(--color-border)', borderRadius: 5, color: 'var(--color-text1)', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>▲</button>
            <button
              onPointerDown={() => startPanRepeat('left')} onPointerUp={stopPanRepeat} onPointerLeave={stopPanRepeat}
              style={{ gridColumn: 1, gridRow: 2, width: 28, height: 28, background: 'rgba(10,10,18,.85)', border: '1px solid var(--color-border)', borderRadius: 5, color: 'var(--color-text1)', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>◀</button>
            <button
              onPointerDown={() => startPanRepeat('right')} onPointerUp={stopPanRepeat} onPointerLeave={stopPanRepeat}
              style={{ gridColumn: 3, gridRow: 2, width: 28, height: 28, background: 'rgba(10,10,18,.85)', border: '1px solid var(--color-border)', borderRadius: 5, color: 'var(--color-text1)', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>▶</button>
            <button
              onPointerDown={() => startPanRepeat('down')} onPointerUp={stopPanRepeat} onPointerLeave={stopPanRepeat}
              style={{ gridColumn: 2, gridRow: 3, width: 28, height: 28, background: 'rgba(10,10,18,.85)', border: '1px solid var(--color-border)', borderRadius: 5, color: 'var(--color-text1)', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>▼</button>
          </div>
        )}

```

Note: do NOT add a `title`/`onClick` — these buttons are hold-driven via `onPointerDown`/`onPointerUp`/`onPointerLeave`, not click-driven (unlike the zoom buttons). This is intentional per the spec's hold-to-repeat requirement.

- [ ] **Step 5: Type-check**

Run (from `client/`): `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 6: Manual verification against the live deployment**

This project has no test framework in `client/`; verification is manual/live, per this session's established convention (rebuild the Docker image with `npm run docker:build`, `docker compose up -d --force-recreate` from the repo root, then drive it with a real browser — e.g. Playwright — against the deployed instance, not just the dev server, since that's what's been used for every other fix/feature this session).

Verify:
1. Load the Map tab, select a zone. Confirm a 4-button D-pad appears bottom-left, visually matching the zoom buttons' style (same size/background/border), and does NOT overlap the zoom controls (bottom-right) or the collapse-toggle button (top-left, near the panel).
2. Click-and-hold the ▲ button for ~1.5s: confirm the map pans immediately on press, pauses briefly, then continuously pans upward (content moves down) until release. Repeat for ▼/◀/▶, confirming each moves the correct direction (Up reveals content above; Left reveals content to the left, etc. — the map should visibly scroll in the direction the pressed arrow points).
3. Release mid-hold (pointerup) and confirm panning stops immediately — no runaway interval.
4. Press a button and drag the pointer off it before releasing (triggering `onPointerLeave` instead of `onPointerUp`) — confirm panning still stops (the `onPointerLeave` fallback should catch this).
5. Confirm dragging the canvas background to pan (pre-existing feature) still works unaffected, and the existing zoom +/−/reset buttons still work (regression check that this addition didn't break anything already fixed this session).
6. Check the browser console for errors — expect zero.
7. Resize the browser between phone/tablet/desktop widths and confirm the D-pad remains visible, correctly positioned, and doesn't get clipped or overlap other UI at any width (the Map tab's own responsive behavior, e.g. the collapsible zone/layers panel from earlier this session, should be unaffected).

- [ ] **Step 7: Commit**

```bash
git add client/src/components/pages/Map.tsx
git commit -m "feat: add touch-friendly pan arrow controls to Map tab"
```
