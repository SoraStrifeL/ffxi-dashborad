# Map Keyboard Panning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add arrow-key panning to the Map tab, per `docs/superpowers/specs/2026-07-15-map-keyboard-panning-design.md`.

**Architecture:** A single `window`-level `keydown`/`keyup` listener pair, added once on mount, reusing the existing `startPanRepeat`/`stopPanRepeat` functions (already built for the D-pad) verbatim. A new ref tracks which key is currently driving the repeat so release behavior is correct when keys are pressed in sequence without releasing the first.

**Tech Stack:** React 18, TypeScript, native `KeyboardEvent` handling (no new dependencies).

## Global Constraints

- Keys: `ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight` only — no WASD.
- Activation gate: `zoneDrawRef.current !== null` (checked inside the handler, not via effect deps).
- Must ignore keydown events where `e.target` is an `<input>`, `<textarea>`, or `<select>`.
- Must ignore the browser's native key-repeat (`e.repeat === true`) — repeat is driven entirely by the existing `startPanRepeat` timer mechanism.
- Must call `e.preventDefault()` on every handled arrow key (after the text-input and zone-loaded guards pass) so the page doesn't also scroll.
- No test framework exists in `client/` — verification is `npx tsc -b --noEmit` (run from `client/`) plus manual/live browser verification against the deployed instance, per this session's established convention.
- Scope: `client/src/components/pages/Map.tsx` only.

---

### Task 1: Add keyboard arrow-key panning

**Files:**
- Modify: `client/src/components/pages/Map.tsx`
  - Add `KEY_TO_DIR` module-level constant near the other module-level constants (`Map.tsx:11-12`)
  - Add `activePanKeyRef` near `panRepeatRef` (`Map.tsx:182`)
  - Add the keydown/keyup `useEffect` — placement doesn't matter much since it's self-contained, but put it near the existing `useEffect(() => stopPanRepeat, []);` at `Map.tsx:859` for locality (both are pan-related lifecycle effects)

**Interfaces:**
- Consumes: `startPanRepeat(dir: 'up'|'down'|'left'|'right')`, `stopPanRepeat()` (existing, `Map.tsx:307` / `Map.tsx:322`), `zoneDrawRef` (existing, `Map.tsx:185`).
- Produces: nothing consumed elsewhere — this is the only task in this plan.

- [ ] **Step 1: Add the `KEY_TO_DIR` constant**

In `client/src/components/pages/Map.tsx`, immediately after line 12 (`const DETECT_LABELS: Record<number, string> = {...};`), add:

```typescript
const KEY_TO_DIR: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};
```

- [ ] **Step 2: Add the `activePanKeyRef` ref**

Immediately after the `panRepeatRef` declaration (`Map.tsx:182`), add:

```typescript
  const activePanKeyRef = useRef<string | null>(null);
```

- [ ] **Step 3: Add the keydown/keyup effect**

Find the current line of `useEffect(() => stopPanRepeat, []);` (search via `grep -n "useEffect(() => stopPanRepeat" client/src/components/pages/Map.tsx` since line numbers shift after Steps 1-2's insertions). Immediately after that line, add:

```typescript
  // Arrow-key panning — reuses the same startPanRepeat/stopPanRepeat the
  // D-pad buttons use, so hold timing is identical between input methods.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (zoneDrawRef.current === null) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const dir = KEY_TO_DIR[e.key];
      if (!dir) return;
      e.preventDefault();
      if (e.repeat) return; // browser's own OS-level key-repeat — we drive repeat ourselves
      activePanKeyRef.current = e.key;
      startPanRepeat(dir);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === activePanKeyRef.current) {
        activePanKeyRef.current = null;
        stopPanRepeat();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);
```

- [ ] **Step 4: Type-check**

Run (from `client/`): `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 5: Deploy and manually verify against the live instance**

Rebuild (`npm run docker:build` from the repo root) and redeploy (`docker compose up -d --force-recreate`), confirm via `curl -s http://localhost:3001/api/version`, then drive the live deployment (`http://soraxi.duckdns.org:3001`) with Playwright (existing install at `/tmp/pw-task1/node_modules/playwright`), logged in as `Sora`/`YourPassword1`, on the Map tab with a zone selected.

Verify:
1. Pressing and releasing each of the 4 arrow keys individually pans the map in the correct direction (Up reveals content above, etc. — same directions as the equivalent D-pad button). Use the same before/after canvas-screenshot-byte-diff technique used earlier this session for the D-pad's own verification.
2. Press-and-hold an arrow key for ~1.5s: confirm immediate pan on press, a brief pause, then continuous repeat — timing should look the same as holding the corresponding D-pad button.
3. Press Left, then (without releasing Left) press Right: confirm the map switches to panning right. Then release Left: confirm panning does NOT stop (Right should still be the active, repeating direction). Then release Right: confirm panning stops.
4. Click into the "Search zones…" input (or the entity search input) and press an arrow key: confirm the map does NOT pan, and confirm the input's cursor moves / text selection behaves normally (i.e., the keydown reached the input, it wasn't swallowed).
5. Click somewhere that is NOT a text input (e.g. the canvas background) and confirm arrow keys pan again.
6. With no zone selected (fresh page load before selecting a zone), press an arrow key: confirm nothing happens (no error, no pan) — the `zoneDrawRef.current === null` guard should no-op cleanly.
7. Check the browser console for errors across all of the above — expect zero.
8. Confirm the D-pad buttons, drag-to-pan, and zoom still work unaffected (regression check).

- [ ] **Step 6: Commit**

```bash
git add client/src/components/pages/Map.tsx
git commit -m "feat: add arrow-key panning to Map tab"
```
