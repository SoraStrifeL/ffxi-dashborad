# Login-Screen Messages with Images — Design

## Problem

The login screen (`client/src/components/pages/Login.tsx`) shows only the
sign-in form — no way to communicate anything to players before they log
in (e.g. server news, event announcements, patch notes). A single-field
MOTD (`serverName`/`motd`) already exists in `src/settings.ts` /
`data/dashboard.json`, managed from Settings → Dashboard, but it is never
rendered on the login screen today and is out of scope here — it is left
as-is. This feature adds a separate, richer, admin-managed list of
messages (title + body + optional image) that render on the login screen.

## Data model & storage

New module `src/loginMessages.ts`, following the same load/save pattern
as `loadDashboardSettings`/`saveDashboardSettings` in `src/settings.ts`.

```ts
interface LoginMessage {
  id: string;          // nanoid
  title: string;       // max 100 chars
  body: string;         // max 1000 chars, plain text (newlines preserved)
  imageUrl: string | null;
  active: boolean;
  createdAt: number;
}
```

Stored as a JSON array in `data/login-messages.json`. Array order is
display order — reordering is done via `move up`/`move down` (array
swap), no separate `order` field.

## Backend routes

New file `src/routes/loginMessages.ts`, mounted in `src/server.ts`
alongside the other route modules.

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/login-messages` | **none** (public — the login screen has no JWT yet, same reasoning as `/api/health`) | Returns only `active` messages, in display order, fields `{id, title, body, imageUrl}` only (no `active`/`createdAt`) |
| `GET /api/dashboard/login-messages` | `requireAuth` + `manage:settings` | Returns all messages (active + inactive) for the Settings UI |
| `POST /api/dashboard/login-messages` | `requireAuth` + `manage:settings` | Create `{title, body, active}`, server assigns `id`/`createdAt`, appended to end of array |
| `PUT /api/dashboard/login-messages/:id` | `requireAuth` + `manage:settings` | Update `title`/`body`/`active` |
| `DELETE /api/dashboard/login-messages/:id` | `requireAuth` + `manage:settings` | Delete message; also deletes its image file from disk if present |
| `POST /api/dashboard/login-messages/:id/move` | `requireAuth` + `manage:settings` | Body `{direction:'up'\|'down'}`, swaps the message with its neighbor in the array |
| `POST /api/upload/login-message/:id` | `requireAuth` + `upload:images` | Image upload, added to `src/routes/upload.ts` reusing the existing `makeUploader()` helper |

All mutating routes call `audit(req.user!.login, 'settings.loginMessage', ...)`,
matching the audit pattern used by every other settings route.

Validation: `title` truncated to 100 chars, `body` to 1000 chars (same
`.slice()` pattern as the existing `motd`/`serverName` handling in
`src/routes/settings.ts`). `POST`/`PUT` reject if `id` doesn't exist
(404) or body fields are missing/wrong type (400), matching existing
route conventions in this file.

## Image upload

Reuses the exact pattern already in `src/routes/upload.ts`
(`makeUploader`, `ALLOWED_IMG_MIME`, `MIME_EXT`, `removeStaleVariants`):
saved to `public/uploads/login-messages/<id>.<ext>`, served statically at
`/uploads/login-messages/<id>.<ext>` (already covered by the existing
`app.use('/uploads', express.static(...))` mount — no server.ts static
config change needed). `UPLOADS_DIR` mkdir list in `src/catalog.ts` gets
`'login-messages'` added alongside `'items'`, `'npcs'`, `'mobs'`.
On successful upload, the route sets `imageUrl` on the matching message
record and persists it. On delete (`DELETE /api/dashboard/login-messages/:id`),
the image file is removed the same way `removeStaleVariants` cleans up
old extensions.

## Settings UI

`client/src/components/pages/Settings.tsx`:
- Add `'Login Messages'` to the `TABS` tuple.
- New `LoginMessagesPanel` component, structured like the other panels
  (`RatesPanel`, `ScanPanel`) — a `card`-styled list, one row per message:
  - Title text input, body textarea, active checkbox — explicit **Save**
    button per row (same UX as `RatesPanel`/`ScanPanel`), calling
    `PUT /api/dashboard/login-messages/:id`.
  - Image thumbnail (or placeholder) + hidden `<input type="file">` +
    "Upload" button, mirroring the existing pattern in `Database.tsx`
    (`uploadRef`, `handleUpload`, `api.uploadItemImage`-style call) but
    targeting the new `api.uploadLoginMessageImage(id, file)`.
  - Up/down reorder buttons (disabled at the respective ends of the list).
  - Delete button with a `confirm()` guard, matching `CrashLogPanel`'s
    `clear()` confirmation pattern.
  - "Add message" button at the top, creates a blank
    `{title:'', body:'', active:true}` via POST, then appends it to the
    visible list so the admin can fill it in immediately.

## Login screen

`client/src/components/pages/Login.tsx`:
- New `useEffect` on mount: `api.loginMessages().then(setMessages).catch(() => {})`
  — public endpoint, no token required, failure is silent (screen still
  works with just the login form, matching the existing defensive
  `.catch(() => {})` style used throughout Settings.tsx panels).
- The existing centered flex container becomes a `flexWrap: 'wrap'` row:
  when `messages.length > 0`, a message panel (stacked cards: image,
  title, body) renders alongside the existing login card. Because the
  container wraps, the message panel naturally stacks above the login
  card on narrow viewports — no new CSS file or media query needed,
  consistent with this file's existing 100%-inline-style approach.
- When `messages.length === 0` (default/fresh install), layout and
  behavior are pixel-identical to today — no regression for servers that
  never configure any messages.

## API client (`client/src/api.ts`)

Added alongside the existing `uploadItemImage`/`uploadNpcImage` etc.:
- `loginMessages: () => req<LoginMessagePublic[]>('/api/login-messages')`
- `loginMessagesAdmin: () => req<LoginMessage[]>('/api/dashboard/login-messages')`
- `createLoginMessage`, `updateLoginMessage`, `deleteLoginMessage`,
  `moveLoginMessage` — plain `req()` calls (JSON, auth header attached
  automatically by `req()`), same shape as `saveDashboardSettings`.
- `uploadLoginMessageImage: (id: string, file: File) => ...` — copy of
  the existing `uploadItemImage` multipart-`fetch` pattern.

## Error handling

- Public `GET /api/login-messages` never throws to the client — file
  read/parse errors return `[]` (empty array), same defensive style as
  `loadDashboardSettings`'s try/catch around `JSON.parse`.
- Image upload reuses `makeUploader`'s existing `fileFilter` (rejects
  non-image mimetypes) and 8 MB size limit — no new validation code.
- Missing `id` on `PUT`/`DELETE`/`move`/upload routes → 404, matching
  existing route conventions elsewhere in this codebase (e.g.
  `/api/upload/map/:zoneid`'s zone-not-found 404).

## Testing

No complex pure logic beyond array manipulation (move up/down, id
lookup) — covered by a small unit test for `src/loginMessages.ts`
(create/update/delete/move round-trip against a temp JSON file),
following the style of `tests/unit/settings.test.ts`. Live verification:
add a message with an image via Settings → Login Messages, confirm it
renders on the (logged-out) login screen; toggle it inactive and confirm
it disappears from the login screen but still appears in the Settings
list; delete it and confirm the image file is removed from
`public/uploads/login-messages/`.
