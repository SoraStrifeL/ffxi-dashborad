# Equipment Images on the Characters Tab — Design

## Problem

The Characters tab's Gear panel (`CharGear` in `Characters.tsx`) shows a
character's 16 equipment slots as plain text buttons (item name, clicking
navigates to the Database tab's Items search). No image/icon is shown
anywhere, even though the item-image infrastructure already exists and
is fully functional — the Database tab's Items detail panel already
displays and manages custom-uploaded images per itemid
(`api.checkImage('item', id)` / `api.uploadItemImage(id, file)` /
`GET /api/upload/check/:type` / `POST /api/upload/item/:itemid`).

Checked directly against Sora's live equipment (6 items: Onion Rod,
Destrier Beret, Chocobo Shirt, Tarutaru Mitts/Braccae/Clomps) and
`public/uploads/items/` — the data and rendering are both correct today,
just entirely text-only; separately, no item on this server currently
has an uploaded image (the directory is empty), which is expected since
image upload is an opt-in, manual admin action, not auto-populated.

## Decision (confirmed with user)

Reuse the existing item-image infrastructure as-is — no new backend
routes, no new upload UI. Show a small icon (~28px) next to each equipped
item's existing text button when an image exists for that itemid; fall
back to the current text-only look when none exists (which, right now,
is every slot — the feature displays real images the moment someone
uploads one via the Database tab's existing Items detail panel Upload
button, which the equipped-item name button already links to).

## Client change (`client/src/components/pages/Characters.tsx`)

- After `equip` loads (existing `useEffect` around line 125), fetch image
  URLs for all equipped itemids in parallel:
  `Promise.all(equip.map(i => api.checkImage('item', i.itemId).catch(() => ({ exists: false, url: null }))))`,
  building a `Map<number, string>` (itemId → url, only for items that
  have one) stored in new state.
- In `CharGear`'s per-slot render (currently just the name `<button>`),
  render a small `<img>` before the button text when a URL exists for
  that slot's `item.itemId`, matching the Database Items detail panel's
  existing image styling convention (`border-radius`, `border`,
  `object-fit: cover`) scaled down to icon size.
- No change to `loadCharEquipment()` (`src/routes/characters.ts`) — it
  already returns `itemId` per equipped slot, which is all the image
  lookup needs.

## Data flow

`GET /api/character/:charid` (aggregate, already includes `equipment`)
→ client has `{slot, itemId, name}[]` → for each, `GET
/api/upload/check/item?id=<itemId>` (existing route, unchanged) → icon
rendered if `exists`. No new network round-trips beyond the per-item
image-check calls, which run in parallel and are cheap (filesystem
existence checks, no DB query).

## Error handling

Matches the existing Database tab pattern exactly: a failed/missing
image check is treated as "no image" (`.catch(() => ({ exists: false,
url: null }))`), never blocks rendering the rest of the gear panel.

## Testing

No new pure logic to unit test (this is UI wiring reusing an existing,
already-tested backend endpoint). Live verification: confirm the gear
panel still renders correctly with zero images uploaded (current state —
no regression to today's text-only look), then upload an image for one
of Sora's equipped items via the Database tab's existing Upload button
and confirm the corresponding slot on the Characters tab's Gear panel
now shows that icon.
