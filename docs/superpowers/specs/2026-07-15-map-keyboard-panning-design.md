# Map Keyboard Panning

## Problem

The Map tab's pan D-pad (added earlier this session) is touch-focused and
explicitly deferred keyboard support. Arrow-key panning is now wanted as a
complementary input method — same panning mechanism, different trigger.

## Scope

`client/src/components/pages/Map.tsx` only. No changes to the D-pad, drag-pan,
or zoom. Reuses `startPanRepeat`/`stopPanRepeat` (`Map.tsx:307-330`) and
`panRepeatRef` (`Map.tsx:182`) verbatim — no new pan mechanism.

## Listener

A single `window`-level `keydown`/`keyup` pair, added once on mount:

```typescript
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

`KEY_TO_DIR` is a module-level constant (alongside the file's other constants
like `ECOSYSTEM_COLOR`, `DETECT_LABELS`):

```typescript
const KEY_TO_DIR: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};
```

`activePanKeyRef` is a new ref alongside `panRepeatRef`:

```typescript
const activePanKeyRef = useRef<string | null>(null);
```

## Behavior

- **Activation**: as soon as a zone is loaded (`zoneDrawRef.current !== null`)
  — no click-to-focus step needed. `zoneDrawRef` already mirrors current zone
  synchronously (added earlier this session), so this is a ref check, not a
  new state dependency.
- **Text input safety**: `e.target instanceof HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement`
  short-circuits the handler before anything else, so typing in the zone
  search, entity search, or pop-watch mob-name field is never intercepted.
- **Repeat timing**: identical to the D-pad buttons — immediate fire on
  first press, 400ms delay, then 60ms repeat — because it's the literal same
  `startPanRepeat` function. The browser's own native key-repeat (`e.repeat
  === true` on auto-fired subsequent keydown events while held) is ignored
  so it doesn't fight with our own interval.
- **Superseding**: pressing a second arrow key before releasing the first
  supersedes it — `startPanRepeat` already calls `stopPanRepeat()` at its own
  start (added earlier this session for the D-pad's multitouch-safety fix),
  so this falls out for free. `activePanKeyRef` then tracks the newly-active
  key.
- **Release correctness**: `onKeyUp` only calls `stopPanRepeat()` if the
  released key matches `activePanKeyRef.current` — releasing an
  already-superseded key (e.g. pressed Left, then Right without releasing
  Left, then released Left) is a no-op, so it can't stop the wrong
  direction's repeat.
- **Scroll prevention**: `e.preventDefault()` on every handled arrow key
  (i.e. once the text-input and zone-loaded guards pass) so the arrow keys
  don't also scroll the page.

## Cleanup

The effect's own return function removes both listeners on unmount — this is
a *new*, separate cleanup from the existing `useEffect(() => stopPanRepeat,
[])` at `Map.tsx:859` (which stops any in-flight repeat timer on unmount);
both remain, doing their own distinct jobs. No change needed to the existing
one.

## Out of scope

- WASD keys — arrow keys only, per your choice.
- Any visual indicator of keyboard-pan state (e.g. highlighting the
  corresponding D-pad button while its key is held) — not requested.
