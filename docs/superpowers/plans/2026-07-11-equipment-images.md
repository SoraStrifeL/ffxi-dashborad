# Equipment Images on the Characters Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an icon next to each equipped item on the Characters tab's Gear panel when a custom image has been uploaded for that item, reusing the existing item-image infrastructure already used by the Database tab's Items detail panel.

**Architecture:** Client-only change to `client/src/components/pages/Characters.tsx`. After equipment loads, fetch `api.uploadCheck('item', itemId)` for each equipped item in parallel, build an itemId→URL map, pass it into `CharGear`, and render a small `<img>` before each slot's existing text button when a URL exists for that slot. No backend changes — `/api/upload/check/:type` already exists and already serves exactly this shape of data.

**Tech Stack:** React 18 + TypeScript (`client/`).

## Global Constraints

- All backend fixes go in `src/routes/*.ts` — not applicable here, this plan has no backend changes.
- Deploy only via `npm run docker:build && docker compose up -d --force-recreate`.
- `public/index.html`'s Vite-hashed bundle reference must be committed alongside any client rebuild.
- This repo has no client-side test harness. `Characters.tsx` changes are verified live (build clean, deploy, exercise the feature in the browser via Playwright — including actually uploading a test image and confirming it renders), not with client unit tests.

---

### Task 1: Fetch and render equipped-item images

**Files:**
- Modify: `client/src/components/pages/Characters.tsx` (the `CharacterDetail` component's equipment-loading effect, currently lines 119-127; the `CharGear` component, currently lines 470-497)
- Modify: `public/index.html` (Vite bundle hash bump — commit alongside `Characters.tsx`)

**Interfaces:**
- Consumes: `api.uploadCheck(type: 'item'|'npc'|'mob', id?: number, name?: string) => Promise<{exists: boolean; url: string|null}>` (`client/src/api.ts:241`, already exists and already used identically by `Database.tsx:318` for the Items detail panel — same call shape, same response shape).
- Produces: nothing consumed by other tasks — this is the only task in this plan.

- [ ] **Step 1: Add an image-map state and fetch it after equipment loads**

Open `client/src/components/pages/Characters.tsx`. Find this exact block:

```tsx
  const [char, setChar] = useState<CharBasic | null>(null);
  const [ext, setExt]   = useState<CharExtended | null>(null);
  const [equip, setEquip] = useState<{ slot: number; itemId: number; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('overview');

  useEffect(() => {
    if (!id) return;
    const nid = Number(id);
    setLoading(true);
    // Single aggregate request: basic + extended + equipment (was 3 requests).
    api.charFull(nid)
      .then(({ basic, extended, equipment }) => { setChar(basic); setExt(extended); setEquip(equipment); })
      .catch(() => navigate('/chars'))
      .finally(() => setLoading(false));
  }, [id, navigate]);
```

Replace it with (adds `equipImages` state and a second effect that fetches image URLs once `equip` changes):

```tsx
  const [char, setChar] = useState<CharBasic | null>(null);
  const [ext, setExt]   = useState<CharExtended | null>(null);
  const [equip, setEquip] = useState<{ slot: number; itemId: number; name: string }[]>([]);
  const [equipImages, setEquipImages] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('overview');

  useEffect(() => {
    if (!id) return;
    const nid = Number(id);
    setLoading(true);
    // Single aggregate request: basic + extended + equipment (was 3 requests).
    api.charFull(nid)
      .then(({ basic, extended, equipment }) => { setChar(basic); setExt(extended); setEquip(equipment); })
      .catch(() => navigate('/chars'))
      .finally(() => setLoading(false));
  }, [id, navigate]);

  // Fetch any custom-uploaded images for the currently-equipped items —
  // reuses the same /api/upload/check/item endpoint the Database tab's
  // Items detail panel already uses. Missing/failed checks are treated as
  // "no image" (matches the Database tab's existing error-handling), never
  // block rendering the rest of the gear panel.
  useEffect(() => {
    if (equip.length === 0) { setEquipImages(new Map()); return; }
    let cancelled = false;
    Promise.all(equip.map((i) =>
      api.uploadCheck('item', i.itemId).catch(() => ({ exists: false, url: null }))
    )).then((results) => {
      if (cancelled) return;
      const m = new Map<number, string>();
      results.forEach((r, idx) => { if (r.exists && r.url) m.set(equip[idx].itemId, r.url); });
      setEquipImages(m);
    });
    return () => { cancelled = true; };
  }, [equip]);
```

`cancelled` guards against a stale response landing after a fast character-switch (same pattern as the rest of this file's data-loading effects).

- [ ] **Step 2: Pass `equipImages` into `CharGear` and render icons**

Find this exact line (where `CharGear` is invoked):

```tsx
        {tab === 'gear'     && <CharGear char={char} equip={equip} />}
```

Replace it with:

```tsx
        {tab === 'gear'     && <CharGear char={char} equip={equip} equipImages={equipImages} />}
```

Find this exact block (the `CharGear` component):

```tsx
function CharGear({ char, equip }: { char: CharBasic; equip: { slot: number; itemId: number; name: string }[] }) {
  const navigate = useNavigate();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
      <Panel title="Equipped">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
          {(Object.entries(SLOT) as [string, string][]).map(([slotKey, label]) => {
            const item = equip.find((i) => i.slot === Number(slotKey));
            return (
              <div key={slotKey} style={{ display: 'flex', gap: 8, padding: '5px 2px', borderBottom: '1px solid var(--color-border)', fontSize: 12, alignItems: 'center' }}>
                <span style={{ color: 'var(--color-text3)', fontSize: 10, width: 56, flexShrink: 0, textAlign: 'right', paddingRight: 6 }}>{label}</span>
                {item
                  ? <button onClick={() => navigate('/database', { state: { cat: 'items', search: item.name } })}
                      className="btn btn-ghost btn-xs" style={{ padding: '1px 4px', fontSize: 11, color: 'var(--color-text1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
                      {item.name}
                    </button>
                  : <span style={{ color: 'var(--color-text3)' }}>—</span>
                }
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--color-text3)' }}>
          Gear HP bonus: <strong style={{ color: 'var(--color-teal)' }}>+{char.gear_hp ?? 0}</strong> · MP bonus: <strong style={{ color: '#6aa0f0' }}>+{char.gear_mp ?? 0}</strong>
        </div>
      </Panel>
    </div>
  );
```

Replace it with (adds the `equipImages` prop and renders an `<img>` before the button when a URL exists for that slot's item):

```tsx
function CharGear({ char, equip, equipImages }: { char: CharBasic; equip: { slot: number; itemId: number; name: string }[]; equipImages: Map<number, string> }) {
  const navigate = useNavigate();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
      <Panel title="Equipped">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
          {(Object.entries(SLOT) as [string, string][]).map(([slotKey, label]) => {
            const item = equip.find((i) => i.slot === Number(slotKey));
            const imgUrl = item ? equipImages.get(item.itemId) : undefined;
            return (
              <div key={slotKey} style={{ display: 'flex', gap: 8, padding: '5px 2px', borderBottom: '1px solid var(--color-border)', fontSize: 12, alignItems: 'center' }}>
                <span style={{ color: 'var(--color-text3)', fontSize: 10, width: 56, flexShrink: 0, textAlign: 'right', paddingRight: 6 }}>{label}</span>
                {item
                  ? <button onClick={() => navigate('/database', { state: { cat: 'items', search: item.name } })}
                      className="btn btn-ghost btn-xs" style={{ padding: '1px 4px', fontSize: 11, color: 'var(--color-text1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120, display: 'flex', alignItems: 'center', gap: 4 }}>
                      {imgUrl && <img src={imgUrl} alt="" style={{ width: 20, height: 20, borderRadius: 4, border: '1px solid var(--color-border)', objectFit: 'cover', flexShrink: 0 }} />}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                    </button>
                  : <span style={{ color: 'var(--color-text3)' }}>—</span>
                }
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--color-text3)' }}>
          Gear HP bonus: <strong style={{ color: 'var(--color-teal)' }}>+{char.gear_hp ?? 0}</strong> · MP bonus: <strong style={{ color: '#6aa0f0' }}>+{char.gear_mp ?? 0}</strong>
        </div>
      </Panel>
    </div>
  );
```

(The trailing `}` that closes the function was already present after this block in the original file — it is unchanged, not shown here since the Find/Replace only covers through the function body's closing brace of the JSX return.)

- [ ] **Step 3: Type-check and build**

Run: `npm run build:all`
Expected: exit 0, no TypeScript errors.

- [ ] **Step 4: Deploy and verify live in the browser**

```bash
npm run docker:build
docker compose up -d --force-recreate
```

Then, using Playwright (headless chromium, login via `Sora`/`YourPassword1`, click "Characters" then the character card, then "Gear" tab — this is an SPA, do not `page.goto()` a sub-route directly), verify:

1. With zero images uploaded (current state — confirm via `ls public/uploads/items/` on the host, should be empty or not contain any of this character's equipped itemids), the Gear panel renders exactly as before: text-only, no broken image icons, no console errors. This is the no-regression baseline check.
2. Upload a test image for one of the character's equipped items via the **Database tab's existing Items detail panel** (search for the item name, open its detail panel, click "Upload", select any small PNG/JPG — this reuses existing, already-working upload UI, not anything new from this task).
3. Navigate back to the Characters tab, reopen the same character's Gear tab, and confirm the corresponding slot now shows the small icon next to the item name.
4. Confirm every OTHER equipped slot (without an uploaded image) still renders text-only with no broken-image icon or layout shift.
5. Switch to a different character (if one exists) or reload the page and confirm no stale image reference leaks across character switches (the `cancelled` flag from Step 1 exists specifically to guard this).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/pages/Characters.tsx public/index.html
git commit -m "$(cat <<'EOF'
characters: show item images on the Gear panel when uploaded

Reuses the existing item-image infrastructure (api.uploadCheck,
/api/upload/check/item) already proven on the Database tab's Items
detail panel — no backend changes. Gear panel was text-only despite
equipment data being correct; now shows a small icon per slot once an
image has been uploaded for that itemid via the existing Database tab
upload flow. Falls back to today's text-only look when no image
exists, which is every slot until someone uploads one.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** the spec's single requirement (reuse existing image infra, show icon per slot when present, no new upload UI) is fully covered by Steps 1-2.
- **No placeholders:** all code blocks are complete and copy-pasteable, matching the verified current file content exactly (re-read via `Bash` immediately before writing this plan). Note on the `CharGear` replacement block: the Find block's closing brace intentionally stops at the function body (matching how the file is actually structured — the very next line after `);` is the function's own closing `}`, which is untouched and not part of either Find or Replace text since it doesn't change).
- **Type consistency:** `equipImages` is `Map<number, string>` throughout (state declaration, effect, prop passed to `CharGear`, `CharGear`'s own prop type) — matches `item.itemId`'s existing `number` type used as the map key.
