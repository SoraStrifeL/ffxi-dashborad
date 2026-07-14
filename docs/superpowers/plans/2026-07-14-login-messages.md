# Login-Screen Messages with Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins publish a list of title+body+optional-image messages that render on the logged-out login screen, managed from a new Settings tab.

**Architecture:** A new JSON-file-backed data module (`src/loginMessages.ts`, same load/save pattern as `src/settings.ts`'s dashboard settings) backs a new Express router (`src/routes/loginMessages.ts`) with one public read endpoint and five admin CRUD/reorder endpoints. Image upload reuses the existing `makeUploader`/`MIME_EXT`/`removeStaleVariants` helpers already in `src/routes/upload.ts`. The client gets a new Settings tab (`LoginMessagesPanel`) for admin management and a small addition to `Login.tsx` to render active messages next to the sign-in form.

**Tech Stack:** Express (backend routes), Node `fs`/`crypto.randomUUID` (JSON file storage, no DB), multer (image upload, existing pattern), React 18 + TypeScript (client), Vitest + supertest (tests).

## Global Constraints

- `title` is truncated to 100 chars, `body` to 1000 chars server-side (`.slice()`, same pattern as `motd`/`serverName` in `src/routes/settings.ts`).
- `GET /api/login-messages` takes **no auth** (same reasoning as `/api/health` — the login screen has no JWT yet) and never throws: file read/parse errors return `[]`.
- All other login-message routes require `requireAuth` + `requirePermission('manage:settings')`; the image-upload route requires `requireAuth` + `requirePermission('upload:images')`.
- Every mutating route calls `audit(req.user!.login, 'settings.loginMessage.<action>', ...)`.
- Missing `id` on `PUT`/`DELETE`/`move`/upload → `404`. Malformed body → `400`.
- Data is stored as a JSON array in `data/login-messages.json` — already covered by the `data/*.json` gitignore rule (matches `dashboard.json`, `calibrations.json`, etc.), never commit it.
- Image upload reuses the **exact** existing helpers in `src/routes/upload.ts` (`makeUploader`, `ALLOWED_IMG_MIME`, `MIME_EXT`, `removeStaleVariants`) — same 8 MB limit, same allowed mime types, no new validation code.
- When zero messages are configured (default/fresh install), the login screen must be pixel-identical to today — no regression for servers that never configure any messages.
- Every commit touching a client file must also commit the resulting hashed-bundle-filename diff in `public/index.html`, in the same commit.

---

### Task 1: Backend data module — `src/loginMessages.ts`

**Files:**
- Create: `src/loginMessages.ts`
- Test: `tests/unit/loginMessages.test.ts`

**Interfaces:**
- Consumes: nothing (self-contained, no imports from other new files).
- Produces (used by Tasks 2 and 3):
  - `interface LoginMessage { id: string; title: string; body: string; imageUrl: string | null; active: boolean; createdAt: number; }`
  - `type LoginMessagePublic = Pick<LoginMessage, 'id' | 'title' | 'body' | 'imageUrl'>`
  - `readLoginMessages(): LoginMessage[]`
  - `writeLoginMessages(messages: LoginMessage[]): void`
  - `createLoginMessage(title: string, body: string, active: boolean): LoginMessage`
  - `updateLoginMessage(id: string, patch: { title?: string; body?: string; active?: boolean }): LoginMessage | null`
  - `deleteLoginMessage(id: string): LoginMessage | null`
  - `moveLoginMessage(id: string, direction: 'up' | 'down'): LoginMessage[] | null`
  - `setLoginMessageImage(id: string, imageUrl: string): LoginMessage | null`
  - `toPublic(m: LoginMessage): LoginMessagePublic`
  - `LOGIN_MESSAGES_FILE: string` (path, overridable via `process.env.LOGIN_MESSAGES_FILE` — same pattern as `AUDIT_FILE` in `src/audit.ts`, needed so tests don't touch the real `data/` dir)

- [ ] **Step 1: Write the failing test file**

Create `tests/unit/loginMessages.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the module at a temp file so tests don't touch data/login-messages.json
const tmpFile = path.join(os.tmpdir(), `ffxi-login-messages-test-${process.pid}.json`);
process.env.LOGIN_MESSAGES_FILE = tmpFile;

// Import AFTER setting env so the module captures the correct path
const {
  readLoginMessages, createLoginMessage, updateLoginMessage,
  deleteLoginMessage, moveLoginMessage, setLoginMessageImage, toPublic,
} = await import('../../src/loginMessages');

beforeEach(() => { try { fs.unlinkSync(tmpFile); } catch {} });
afterEach(() => { try { fs.unlinkSync(tmpFile); } catch {} });

describe('loginMessages CRUD', () => {
  it('starts empty when the file does not exist', () => {
    expect(readLoginMessages()).toEqual([]);
  });

  it('creates a message with a generated id and timestamp', () => {
    const msg = createLoginMessage('Patch Notes', 'v1.2 is live', true);
    expect(msg.id).toBeTruthy();
    expect(msg.title).toBe('Patch Notes');
    expect(msg.body).toBe('v1.2 is live');
    expect(msg.active).toBe(true);
    expect(msg.imageUrl).toBeNull();
    expect(readLoginMessages()).toHaveLength(1);
  });

  it('truncates title to 100 chars and body to 1000 chars', () => {
    const msg = createLoginMessage('T'.repeat(150), 'B'.repeat(1500), true);
    expect(msg.title).toHaveLength(100);
    expect(msg.body).toHaveLength(1000);
  });

  it('updates title, body, and active independently', () => {
    const msg = createLoginMessage('Original', 'Body', true);
    const updated = updateLoginMessage(msg.id, { title: 'Changed' });
    expect(updated?.title).toBe('Changed');
    expect(updated?.body).toBe('Body');
    expect(updated?.active).toBe(true);
  });

  it('returns null when updating a nonexistent id', () => {
    expect(updateLoginMessage('missing-id', { title: 'X' })).toBeNull();
  });

  it('deletes a message by id', () => {
    const msg = createLoginMessage('Bye', 'Body', true);
    const removed = deleteLoginMessage(msg.id);
    expect(removed?.id).toBe(msg.id);
    expect(readLoginMessages()).toHaveLength(0);
  });

  it('returns null when deleting a nonexistent id', () => {
    expect(deleteLoginMessage('missing-id')).toBeNull();
  });

  it('moves a message up, swapping it with its neighbor', () => {
    const a = createLoginMessage('A', 'a', true);
    const b = createLoginMessage('B', 'b', true);
    moveLoginMessage(b.id, 'up');
    expect(readLoginMessages().map(m => m.id)).toEqual([b.id, a.id]);
  });

  it('moves a message down, swapping it with its neighbor', () => {
    const a = createLoginMessage('A', 'a', true);
    const b = createLoginMessage('B', 'b', true);
    moveLoginMessage(a.id, 'down');
    expect(readLoginMessages().map(m => m.id)).toEqual([b.id, a.id]);
  });

  it('is a no-op when moving the first message up', () => {
    const a = createLoginMessage('A', 'a', true);
    const b = createLoginMessage('B', 'b', true);
    moveLoginMessage(a.id, 'up');
    expect(readLoginMessages().map(m => m.id)).toEqual([a.id, b.id]);
  });

  it('is a no-op when moving the last message down', () => {
    const a = createLoginMessage('A', 'a', true);
    const b = createLoginMessage('B', 'b', true);
    moveLoginMessage(b.id, 'down');
    expect(readLoginMessages().map(m => m.id)).toEqual([a.id, b.id]);
  });

  it('returns null moving a nonexistent id', () => {
    expect(moveLoginMessage('missing-id', 'up')).toBeNull();
  });

  it('sets the image url on a message', () => {
    const msg = createLoginMessage('Img', 'body', true);
    const updated = setLoginMessageImage(msg.id, '/uploads/login-messages/abc.png');
    expect(updated?.imageUrl).toBe('/uploads/login-messages/abc.png');
  });

  it('toPublic strips active and createdAt', () => {
    const msg = createLoginMessage('Pub', 'body', true);
    const pub = toPublic(msg);
    expect(pub).toEqual({ id: msg.id, title: 'Pub', body: 'body', imageUrl: null });
    expect(pub).not.toHaveProperty('active');
    expect(pub).not.toHaveProperty('createdAt');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/loginMessages.test.ts`
Expected: FAIL — `Cannot find module '../../src/loginMessages'`

- [ ] **Step 3: Write the implementation**

Create `src/loginMessages.ts`:

```ts
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export const LOGIN_MESSAGES_FILE = process.env.LOGIN_MESSAGES_FILE
  ?? path.join(__dirname, '..', 'data', 'login-messages.json');

export interface LoginMessage {
  id: string;
  title: string;
  body: string;
  imageUrl: string | null;
  active: boolean;
  createdAt: number;
}

export type LoginMessagePublic = Pick<LoginMessage, 'id' | 'title' | 'body' | 'imageUrl'>;

export function readLoginMessages(): LoginMessage[] {
  try { return JSON.parse(fs.readFileSync(LOGIN_MESSAGES_FILE, 'utf8')) as LoginMessage[]; }
  catch { return []; }
}

export function writeLoginMessages(messages: LoginMessage[]): void {
  fs.mkdirSync(path.dirname(LOGIN_MESSAGES_FILE), { recursive: true });
  fs.writeFileSync(LOGIN_MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

export function createLoginMessage(title: string, body: string, active: boolean): LoginMessage {
  const messages = readLoginMessages();
  const msg: LoginMessage = {
    id: randomUUID(),
    title: title.slice(0, 100),
    body: body.slice(0, 1000),
    imageUrl: null,
    active,
    createdAt: Date.now(),
  };
  messages.push(msg);
  writeLoginMessages(messages);
  return msg;
}

export function updateLoginMessage(
  id: string,
  patch: { title?: string; body?: string; active?: boolean },
): LoginMessage | null {
  const messages = readLoginMessages();
  const idx = messages.findIndex(m => m.id === id);
  if (idx === -1) return null;
  const current = messages[idx];
  const updated: LoginMessage = {
    ...current,
    title:  typeof patch.title  === 'string'  ? patch.title.slice(0, 100)  : current.title,
    body:   typeof patch.body   === 'string'  ? patch.body.slice(0, 1000)  : current.body,
    active: typeof patch.active === 'boolean' ? patch.active               : current.active,
  };
  messages[idx] = updated;
  writeLoginMessages(messages);
  return updated;
}

export function deleteLoginMessage(id: string): LoginMessage | null {
  const messages = readLoginMessages();
  const idx = messages.findIndex(m => m.id === id);
  if (idx === -1) return null;
  const [removed] = messages.splice(idx, 1);
  writeLoginMessages(messages);
  return removed;
}

export function moveLoginMessage(id: string, direction: 'up' | 'down'): LoginMessage[] | null {
  const messages = readLoginMessages();
  const idx = messages.findIndex(m => m.id === id);
  if (idx === -1) return null;
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= messages.length) return messages; // no-op at either end
  [messages[idx], messages[swapWith]] = [messages[swapWith], messages[idx]];
  writeLoginMessages(messages);
  return messages;
}

export function setLoginMessageImage(id: string, imageUrl: string): LoginMessage | null {
  const messages = readLoginMessages();
  const idx = messages.findIndex(m => m.id === id);
  if (idx === -1) return null;
  messages[idx] = { ...messages[idx], imageUrl };
  writeLoginMessages(messages);
  return messages[idx];
}

export function toPublic(m: LoginMessage): LoginMessagePublic {
  return { id: m.id, title: m.title, body: m.body, imageUrl: m.imageUrl };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/loginMessages.test.ts`
Expected: PASS — 15 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/loginMessages.ts tests/unit/loginMessages.test.ts
git commit -m "settings: add login-messages data module"
```

---

### Task 2: Backend CRUD routes — `src/routes/loginMessages.ts`

**Files:**
- Create: `src/routes/loginMessages.ts`
- Modify: `src/server.ts` (import + mount)
- Test: `tests/integration/login-messages.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces from `../loginMessages` (`readLoginMessages`, `createLoginMessage`, `updateLoginMessage`, `deleteLoginMessage`, `moveLoginMessage`, `toPublic`), plus existing `requireAuth` (`../auth`), `requirePermission` (`../rbac`), `audit` (`../audit`).
- Produces (used by Task 4's client): `createLoginMessagesRouter(): Router` mounted at these exact paths:
  - `GET /api/login-messages` → `LoginMessagePublic[]` (public)
  - `GET /api/dashboard/login-messages` → `LoginMessage[]` (admin)
  - `POST /api/dashboard/login-messages` body `{title, body, active}` → `{ok: true, message: LoginMessage}`
  - `PUT /api/dashboard/login-messages/:id` body `{title?, body?, active?}` → `{ok: true, message: LoginMessage}`
  - `DELETE /api/dashboard/login-messages/:id` → `{ok: true}`
  - `POST /api/dashboard/login-messages/:id/move` body `{direction: 'up'|'down'}` → `{ok: true, messages: LoginMessage[]}`

- [ ] **Step 1: Write the failing test file**

Create `tests/integration/login-messages.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpFile = path.join(os.tmpdir(), `ffxi-login-messages-route-test-${process.pid}.json`);
process.env.LOGIN_MESSAGES_FILE = tmpFile;

vi.mock('../../src/audit', () => ({
  audit:                  vi.fn(),
  setBroadcastAuditEvent: vi.fn(),
  broadcastAuditEvent:    null,
}));

const { issueToken } = await import('../../src/auth');
const { createLoginMessagesRouter } = await import('../../src/routes/loginMessages');

const app = express();
app.use(express.json());
app.use(createLoginMessagesRouter());

const ADMIN_TOKEN  = issueToken({ accid: 1, tier: 'admin',  login: 'Sora' });
const PLAYER_TOKEN = issueToken({ accid: 2, tier: 'player', login: 'Rando' });

beforeEach(() => { try { fs.unlinkSync(tmpFile); } catch {} });
afterEach(() => { try { fs.unlinkSync(tmpFile); } catch {} });

async function createMsg(title: string, body: string, active = true) {
  const res = await request(app).post('/api/dashboard/login-messages')
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    .send({ title, body, active });
  return res.body.message as { id: string };
}

describe('login messages routes', () => {
  it('GET /api/login-messages requires no auth and returns [] with no messages', async () => {
    const res = await request(app).get('/api/login-messages');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('GET /api/dashboard/login-messages requires auth', async () => {
    const res = await request(app).get('/api/dashboard/login-messages');
    expect(res.status).toBe(401);
  });

  it('GET /api/dashboard/login-messages requires manage:settings', async () => {
    const res = await request(app).get('/api/dashboard/login-messages')
      .set('Authorization', `Bearer ${PLAYER_TOKEN}`);
    expect(res.status).toBe(403);
  });

  it('creates and lists a message, exposing only public fields on the public endpoint', async () => {
    const { id } = await createMsg('Patch Notes', 'v1.2 is live', true);

    const pub = await request(app).get('/api/login-messages');
    expect(pub.body).toEqual([{ id, title: 'Patch Notes', body: 'v1.2 is live', imageUrl: null }]);

    const admin = await request(app).get('/api/dashboard/login-messages')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(admin.body).toHaveLength(1);
    expect(admin.body[0]).toMatchObject({ id, active: true });
  });

  it('inactive messages are hidden from the public endpoint but visible to admin', async () => {
    const { id } = await createMsg('Draft', 'not yet', false);

    const pub = await request(app).get('/api/login-messages');
    expect(pub.body).toEqual([]);

    const admin = await request(app).get('/api/dashboard/login-messages')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(admin.body[0]).toMatchObject({ id, active: false });
  });

  it('updates a message', async () => {
    const { id } = await createMsg('Old', 'old body');
    const update = await request(app).put(`/api/dashboard/login-messages/${id}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ title: 'New' });
    expect(update.status).toBe(200);
    expect(update.body.message.title).toBe('New');
    expect(update.body.message.body).toBe('old body');
  });

  it('returns 404 updating a nonexistent message', async () => {
    const res = await request(app).put('/api/dashboard/login-messages/missing')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ title: 'X' });
    expect(res.status).toBe(404);
  });

  it('deletes a message', async () => {
    const { id } = await createMsg('Bye', 'bye');
    const del = await request(app).delete(`/api/dashboard/login-messages/${id}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(del.status).toBe(200);
    const admin = await request(app).get('/api/dashboard/login-messages')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(admin.body).toEqual([]);
  });

  it('returns 404 deleting a nonexistent message', async () => {
    const res = await request(app).delete('/api/dashboard/login-messages/missing')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('moves a message up, reordering the list', async () => {
    const a = await createMsg('A', 'a');
    const b = await createMsg('B', 'b');
    await request(app).post(`/api/dashboard/login-messages/${b.id}/move`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ direction: 'up' });
    const admin = await request(app).get('/api/dashboard/login-messages')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(admin.body.map((m: { id: string }) => m.id)).toEqual([b.id, a.id]);
  });

  it('rejects an invalid move direction', async () => {
    const { id } = await createMsg('A', 'a');
    const res = await request(app).post(`/api/dashboard/login-messages/${id}/move`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ direction: 'sideways' });
    expect(res.status).toBe(400);
  });

  it('returns 404 moving a nonexistent message', async () => {
    const res = await request(app).post('/api/dashboard/login-messages/missing/move')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ direction: 'up' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/login-messages.test.ts`
Expected: FAIL — `Cannot find module '../../src/routes/loginMessages'`

- [ ] **Step 3: Write the implementation**

Create `src/routes/loginMessages.ts`:

```ts
import { Router } from 'express';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { audit } from '../audit';
import {
  readLoginMessages, createLoginMessage, updateLoginMessage,
  deleteLoginMessage, moveLoginMessage, toPublic,
} from '../loginMessages';

export function createLoginMessagesRouter(): Router {
  const router = Router();

  router.get('/api/login-messages', (_req, res) => {
    res.json(readLoginMessages().filter(m => m.active).map(toPublic));
  });

  router.get('/api/dashboard/login-messages', requireAuth, requirePermission('manage:settings'), (_req, res) => {
    res.json(readLoginMessages());
  });

  router.post('/api/dashboard/login-messages', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const { title, body, active } = (req.body as { title?: string; body?: string; active?: boolean }) || {};
    if (typeof title !== 'string' || typeof body !== 'string') {
      res.status(400).json({ error: 'title and body are required strings' });
      return;
    }
    const msg = createLoginMessage(title, body, active !== false);
    audit(req.user!.login, 'settings.loginMessage.create', msg.id, { title: msg.title });
    res.json({ ok: true, message: msg });
  });

  router.put('/api/dashboard/login-messages/:id', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const { title, body, active } = (req.body as { title?: string; body?: string; active?: boolean }) || {};
    const updated = updateLoginMessage(req.params.id, { title, body, active });
    if (!updated) { res.status(404).json({ error: 'not found' }); return; }
    audit(req.user!.login, 'settings.loginMessage.update', updated.id, { title: updated.title });
    res.json({ ok: true, message: updated });
  });

  router.delete('/api/dashboard/login-messages/:id', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const removed = deleteLoginMessage(req.params.id);
    if (!removed) { res.status(404).json({ error: 'not found' }); return; }
    audit(req.user!.login, 'settings.loginMessage.delete', removed.id, { title: removed.title });
    res.json({ ok: true });
  });

  router.post('/api/dashboard/login-messages/:id/move', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const { direction } = (req.body as { direction?: string }) || {};
    if (direction !== 'up' && direction !== 'down') {
      res.status(400).json({ error: 'direction must be "up" or "down"' });
      return;
    }
    const messages = moveLoginMessage(req.params.id, direction);
    if (!messages) { res.status(404).json({ error: 'not found' }); return; }
    audit(req.user!.login, 'settings.loginMessage.move', req.params.id, { direction });
    res.json({ ok: true, messages });
  });

  return router;
}
```

Note: the image-file deletion side-effect described in the design spec ("DELETE also deletes its image file from disk") is deliberately deferred to Task 3, since it needs `UPLOADS_DIR` and `fs`/`path` — those live in `src/routes/upload.ts`'s territory. Task 3 adds that cleanup by importing `deleteLoginMessage`'s return value inline; see Task 3 Step 3 for the final `DELETE` handler.

Now wire it into `src/server.ts`. Add the import after the `createSettingsRouter` import (`src/server.ts:27`):

```ts
import { createSettingsRouter }  from './routes/settings';
import { createLoginMessagesRouter } from './routes/loginMessages';
```

And mount it after `app.use(createSettingsRouter(pool));` (`src/server.ts:84`):

```ts
app.use(createSettingsRouter(pool));
app.use(createLoginMessagesRouter());
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/integration/login-messages.test.ts`
Expected: PASS — 12 tests passing.

Also run the full suite to confirm no regression:

Run: `npm test`
Expected: all tests passing (previous baseline count + 15 from Task 1 + 12 from this task).

- [ ] **Step 5: Compile check**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/loginMessages.ts src/server.ts tests/integration/login-messages.test.ts
git commit -m "settings: add login-messages CRUD API routes"
```

---

### Task 3: Image upload route + delete-time cleanup

**Files:**
- Modify: `src/routes/upload.ts` (new route + import; also updates the `DELETE /api/dashboard/login-messages/:id` cleanup — see below)
- Modify: `src/loginMessages.ts` is NOT touched here — image cleanup lives in the route layer, matching how `removeStaleVariants` and delete-time cleanup already work for items/npcs/mobs in `upload.ts`.
- Modify: `src/routes/loginMessages.ts` (delete handler gains the image-file cleanup)
- Modify: `src/catalog.ts` (add `login-messages` to the `UPLOADS_DIR` mkdir list)

**Interfaces:**
- Consumes: `readLoginMessages`, `setLoginMessageImage` from `../loginMessages` (Task 1); `makeUploader`, `ALLOWED_IMG_MIME`, `MIME_EXT`, `removeStaleVariants`, `UPLOADS_DIR` already in `src/routes/upload.ts`.
- Produces: `POST /api/upload/login-message/:id` → `{ok: true, url: string}`.

- [ ] **Step 1: Add the upload-dir to the mkdir list**

In `src/catalog.ts`, find (line 27):

```ts
['items', 'npcs', 'mobs'].forEach(d => fs.mkdirSync(path.join(UPLOADS_DIR, d), { recursive: true }));
```

Replace with:

```ts
['items', 'npcs', 'mobs', 'login-messages'].forEach(d => fs.mkdirSync(path.join(UPLOADS_DIR, d), { recursive: true }));
```

- [ ] **Step 2: Add the upload route**

In `src/routes/upload.ts`, add to the imports (line 9):

```ts
import { MAPS_DIR, UPLOADS_DIR, normZoneName, buildZoneMaps } from '../catalog';
import { readLoginMessages, setLoginMessageImage } from '../loginMessages';
```

Add a new route after the `/api/upload/mob` handler (after line 165, before `return router;`):

```ts
  router.post('/api/upload/login-message/:id', requireAuth, requirePermission('upload:images'), (req: any, res) => {
    const id = req.params.id as string;
    if (!readLoginMessages().some(m => m.id === id)) return void res.status(404).json({ error: 'message not found' });
    req._uploadFilename = `${id}.png`;
    makeUploader(path.join(UPLOADS_DIR, 'login-messages'))(req, res, (err: any) => {
      if (err) return void res.status(400).json({ error: err.message });
      if (!req.file) return void res.status(400).json({ error: 'image file required' });
      const ext = MIME_EXT[req.file.mimetype] || 'png';
      const newName = `${id}.${ext}`;
      if (newName !== req.file.filename) {
        fs.renameSync(req.file.path, path.join(UPLOADS_DIR, 'login-messages', newName));
      }
      removeStaleVariants(path.join(UPLOADS_DIR, 'login-messages'), id, ext);
      const url = `/uploads/login-messages/${newName}`;
      setLoginMessageImage(id, url);
      audit(req.user!.login, 'upload.loginMessage', `loginMessage:${id}`);
      res.json({ ok: true, url });
    });
  });
```

- [ ] **Step 3: Wire image-file cleanup into the delete route**

In `src/routes/loginMessages.ts`, add `fs`/`path`/`UPLOADS_DIR` imports and update the `DELETE` handler:

```ts
import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { audit } from '../audit';
import { UPLOADS_DIR } from '../catalog';
import {
  readLoginMessages, createLoginMessage, updateLoginMessage,
  deleteLoginMessage, moveLoginMessage, toPublic,
} from '../loginMessages';
```

Replace the `DELETE` handler body with:

```ts
  router.delete('/api/dashboard/login-messages/:id', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const removed = deleteLoginMessage(req.params.id);
    if (!removed) { res.status(404).json({ error: 'not found' }); return; }
    if (removed.imageUrl) {
      const file = path.join(UPLOADS_DIR, 'login-messages', path.basename(removed.imageUrl));
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
    }
    audit(req.user!.login, 'settings.loginMessage.delete', removed.id, { title: removed.title });
    res.json({ ok: true });
  });
```

- [ ] **Step 4: Compile check**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests still passing (Task 2's delete test still passes — it doesn't set an `imageUrl`, so the new cleanup branch is skipped for that test).

- [ ] **Step 6: Manual verification (live server)**

This route isn't covered by an automated test — no existing route in `src/routes/upload.ts` has one either (file uploads write into `public/uploads/`, which isn't mockable without touching disk). Verify it live instead:

```bash
npm run docker:build && docker compose up -d --force-recreate
```

Get an admin token (replace credentials with a real admin account), create a message, upload a 1x1 PNG, and confirm the file lands on disk:

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/login -H 'Content-Type: application/json' \
  -d '{"username":"Sora","password":"YourPassword1"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

MSG_ID=$(curl -s -X POST http://localhost:3001/api/dashboard/login-messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Test","body":"Test body","active":true}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).message.id')

# 1x1 transparent PNG
echo 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' | base64 -d > /tmp/test.png

curl -s -X POST http://localhost:3001/api/upload/login-message/$MSG_ID \
  -H "Authorization: Bearer $TOKEN" -F "image=@/tmp/test.png"
# Expected: {"ok":true,"url":"/uploads/login-messages/<MSG_ID>.png"}

docker compose exec app ls /app/public/uploads/login-messages/
# Expected: <MSG_ID>.png present

curl -s http://localhost:3001/api/login-messages | node -pe 'JSON.parse(require("fs").readFileSync(0))'
# Expected: [{"id":"<MSG_ID>","title":"Test","body":"Test body","imageUrl":"/uploads/login-messages/<MSG_ID>.png"}]

curl -s -X DELETE http://localhost:3001/api/dashboard/login-messages/$MSG_ID -H "Authorization: Bearer $TOKEN"
docker compose exec app ls /app/public/uploads/login-messages/
# Expected: file is gone (cleanup verified)
```

- [ ] **Step 7: Commit**

```bash
git add src/routes/upload.ts src/routes/loginMessages.ts src/catalog.ts
git commit -m "settings: add login-message image upload + delete-time cleanup"
```

---

### Task 4: Client types, API client, and Settings admin panel

**Files:**
- Modify: `client/src/types.ts` (add `LoginMessage`/`LoginMessagePublic`)
- Modify: `client/src/api.ts` (add client functions)
- Modify: `client/src/components/pages/Settings.tsx` (new `LoginMessagesPanel` + `TABS` entry)
- Modify: `public/index.html` (bundle hash, committed alongside)

**Interfaces:**
- Consumes: `POST/PUT/DELETE /api/dashboard/login-messages*` and `POST /api/upload/login-message/:id` from Tasks 2–3.
- Produces (used by Task 5): `LoginMessagePublic` type in `client/src/types.ts`, `api.loginMessages()` in `client/src/api.ts`.

- [ ] **Step 1: Add the client types**

In `client/src/types.ts`, append after the `NpcEntry` interface (end of file, after line 168):

```ts

export interface LoginMessage {
  id: string;
  title: string;
  body: string;
  imageUrl: string | null;
  active: boolean;
  createdAt: number;
}

export type LoginMessagePublic = Pick<LoginMessage, 'id' | 'title' | 'body' | 'imageUrl'>;
```

- [ ] **Step 2: Add API client functions**

In `client/src/api.ts`, add near the `dashboardSettings`/`saveDashboardSettings` pair (after line 171):

```ts
  loginMessages:      () => req<import('./types').LoginMessagePublic[]>('/api/login-messages'),
  loginMessagesAdmin: () => req<import('./types').LoginMessage[]>('/api/dashboard/login-messages'),
  createLoginMessage: (d: { title: string; body: string; active: boolean }) =>
    req<{ ok: boolean; message: import('./types').LoginMessage }>('/api/dashboard/login-messages', { method: 'POST', body: JSON.stringify(d) }),
  updateLoginMessage: (id: string, d: Partial<{ title: string; body: string; active: boolean }>) =>
    req<{ ok: boolean; message: import('./types').LoginMessage }>(`/api/dashboard/login-messages/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
  deleteLoginMessage: (id: string) => req<{ ok: boolean }>(`/api/dashboard/login-messages/${id}`, { method: 'DELETE' }),
  moveLoginMessage:   (id: string, direction: 'up' | 'down') =>
    req<{ ok: boolean; messages: import('./types').LoginMessage[] }>(`/api/dashboard/login-messages/${id}/move`, { method: 'POST', body: JSON.stringify({ direction }) }),
```

Add near the other multipart uploaders (after line 240, `uploadMobImage`):

```ts
  uploadLoginMessageImage: (id: string, file: File) => { const f = new FormData(); f.append('image', file); const token = getToken(); return fetch(`/api/upload/login-message/${id}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: f }).then(r => r.ok ? r.json() : r.json().then((e: {error?:string}) => Promise.reject(new Error(e.error)))); },
```

- [ ] **Step 3: Add the `LoginMessagesPanel` component and wire up the tab**

In `client/src/components/pages/Settings.tsx`, update the `TABS` tuple (line 9):

```ts
const TABS = ['Rates', 'Dashboard', 'Server Vars', 'Settings Scan', 'DB Config', 'Paths', 'Crash Log', 'Quest Settings', 'FS Browser', 'Login Messages'] as const;
```

Add the import at the top (line 3, alongside `useStore`):

```ts
import type { LoginMessage } from '../../types';
```

Add the panel component before `// ── Main Settings page ──` (before line 408):

```tsx
// ── Login messages panel ──────────────────────────────────────────────────────
function LoginMessagesPanel() {
  const [messages, setMessages] = useState<LoginMessage[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error,    setError]    = useState('');
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadTargetId = useRef<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try { setMessages(await api.loginMessagesAdmin()); } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }

  function patchLocal(id: string, patch: Partial<LoginMessage>) {
    setMessages(prev => prev.map(m => (m.id === id ? { ...m, ...patch } : m)));
  }

  async function addMessage() {
    try {
      const res = await api.createLoginMessage({ title: '', body: '', active: true });
      setMessages(prev => [...prev, res.message]);
    } catch (e) { setError((e as Error).message); }
  }

  async function saveMessage(m: LoginMessage) {
    setSavingId(m.id); setError('');
    try {
      const res = await api.updateLoginMessage(m.id, { title: m.title, body: m.body, active: m.active });
      patchLocal(m.id, res.message);
    } catch (e) { setError((e as Error).message); }
    setSavingId(null);
  }

  async function deleteMessage(id: string) {
    if (!confirm('Delete this login message?')) return;
    try {
      await api.deleteLoginMessage(id);
      setMessages(prev => prev.filter(m => m.id !== id));
    } catch (e) { setError((e as Error).message); }
  }

  async function move(id: string, direction: 'up' | 'down') {
    try {
      const res = await api.moveLoginMessage(id, direction);
      setMessages(res.messages);
    } catch (e) { setError((e as Error).message); }
  }

  function triggerUpload(id: string) {
    uploadTargetId.current = id;
    uploadRef.current?.click();
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const id = uploadTargetId.current;
    if (!file || !id) return;
    try {
      const res = await api.uploadLoginMessageImage(id, file);
      patchLocal(id, { imageUrl: res.url });
    } catch (err) { alert((err as Error).message); }
    e.target.value = '';
  }

  return (
    <div>
      <input ref={uploadRef} type="file" accept="image/*" onChange={handleUpload} style={{ display: 'none' }} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Login Messages</span>
        <span className="pill pill-muted" style={{ fontSize: 11 }}>{messages.length}</span>
        <button onClick={load} className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}>{loading ? '…' : 'Refresh'}</button>
        <button onClick={addMessage} className="btn btn-primary btn-sm">+ Add message</button>
      </div>
      {error && <div style={{ color: 'var(--color-red)', fontSize: 12, marginBottom: 10 }}>{error}</div>}
      {messages.length === 0 && !loading && <div style={{ color: 'var(--color-text3)', fontSize: 13 }}>No login messages configured.</div>}
      {messages.map((m, i) => (
        <div key={m.id} className="card" style={{ marginBottom: 10, padding: '12px 16px' }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ width: 72, flexShrink: 0 }}>
              {m.imageUrl
                ? <img src={m.imageUrl} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--color-border)' }} />
                : <div style={{ width: 72, height: 72, borderRadius: 6, background: 'var(--color-surface2)', border: '1px dashed var(--color-border)' }} />}
              <button onClick={() => triggerUpload(m.id)} className="btn btn-ghost btn-xs" style={{ fontSize: 10, padding: '3px 7px', marginTop: 6, width: '100%' }}>Upload</button>
            </div>
            <div style={{ flex: 1 }}>
              <input className="input" style={{ width: '100%', marginBottom: 8, fontSize: 13 }} placeholder="Title" value={m.title}
                onChange={e => patchLocal(m.id, { title: e.target.value })} />
              <textarea className="input" style={{ width: '100%', marginBottom: 8, fontSize: 13, minHeight: 60, resize: 'vertical' }} placeholder="Body" value={m.body}
                onChange={e => patchLocal(m.id, { body: e.target.value })} />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--color-text2)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={m.active} onChange={e => patchLocal(m.id, { active: e.target.checked })} />
                  Active
                </label>
                <button onClick={() => saveMessage(m)} disabled={savingId === m.id} className="btn btn-primary btn-sm">
                  {savingId === m.id ? '…' : 'Save'}
                </button>
                <button onClick={() => move(m.id, 'up')} disabled={i === 0} className="btn btn-ghost btn-sm">↑</button>
                <button onClick={() => move(m.id, 'down')} disabled={i === messages.length - 1} className="btn btn-ghost btn-sm">↓</button>
                <button onClick={() => deleteMessage(m.id)} className="btn btn-ghost btn-sm" style={{ color: 'var(--color-red)', marginLeft: 'auto' }}>Delete</button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
```

Add the render branch in the `Settings()` component (after line 513, `{tab === 'FS Browser' && <FsBrowserPanel />}`):

```tsx
        {tab === 'FS Browser'      && <FsBrowserPanel />}
        {tab === 'Login Messages'  && <LoginMessagesPanel />}
```

Confirm `useRef` is already imported at the top of `Settings.tsx` (it is not currently — line 1 only imports `useState, useEffect, useCallback`). Update the import:

```ts
import React, { useState, useEffect, useCallback, useRef } from 'react';
```

- [ ] **Step 4: Build the client**

Run: `npm run build:all`
Expected: no TypeScript errors; Vite emits new hashed bundle filenames.

- [ ] **Step 5: Live verification**

```bash
npm run docker:build && docker compose up -d --force-recreate
```

Log in as an admin, open Settings → Login Messages, click "+ Add message", fill in a title/body, click Save, upload an image, click ↑/↓ to reorder (with 2+ messages), then Delete one and confirm it disappears from the list and `docker compose exec app ls /app/public/uploads/login-messages/` no longer has its file.

- [ ] **Step 6: Commit**

```bash
git add client/src/types.ts client/src/api.ts client/src/components/pages/Settings.tsx public/index.html
git commit -m "settings: add Login Messages admin panel"
```

---

### Task 5: Render active messages on the login screen

**Files:**
- Modify: `client/src/components/pages/Login.tsx`
- Modify: `public/index.html` (bundle hash, committed alongside)

**Interfaces:**
- Consumes: `api.loginMessages()` (Task 4), `LoginMessagePublic` type (Task 4).
- Produces: nothing further downstream — this is the final consumer.

- [ ] **Step 1: Add message fetching and rendering**

Replace the full contents of `client/src/components/pages/Login.tsx`:

```tsx
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setTokens } from '../../api';
import { useStore } from '../../store';
import type { LoginMessagePublic } from '../../types';

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [messages, setMessages] = useState<LoginMessagePublic[]>([]);
  const setToken = useStore((s) => s.setToken);
  const navigate = useNavigate();

  useEffect(() => { api.loginMessages().then(setMessages).catch(() => {}); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password) return;
    setLoading(true); setError('');
    try {
      const { token, refreshToken } = await api.login(username, password);
      setTokens(token, refreshToken);  // persist both (access + rotating refresh)
      setToken(token);                 // update store state
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 24,
      overflowY: 'auto',
      padding: 24,
      background: 'radial-gradient(ellipse at 50% 30%, #16162a, #0a0a12)',
    }}>
      {messages.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: 360 }}>
          {messages.map((m) => (
            <div key={m.id} style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 16,
              padding: '20px 22px',
              boxShadow: '0 20px 60px rgba(0,0,0,.6)',
            }}>
              {m.imageUrl && (
                <img src={m.imageUrl} alt="" style={{ width: '100%', maxHeight: 160, objectFit: 'cover', borderRadius: 10, marginBottom: 12 }} />
              )}
              <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text1)', marginBottom: 6 }}>{m.title}</h2>
              <p style={{ fontSize: 13, color: 'var(--color-text2)', whiteSpace: 'pre-wrap', margin: 0 }}>{m.body}</p>
            </div>
          ))}
        </div>
      )}

      <div style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 16,
        padding: '36px 32px',
        width: 360,
        boxShadow: '0 20px 60px rgba(0,0,0,.6)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>⚔</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text1)', marginBottom: 4 }}>
            FFXI Dashboard
          </h1>
          <p style={{ fontSize: 12, color: 'var(--color-text3)' }}>
            Sign in with your game account
          </p>
        </div>

        <form onSubmit={submit}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--color-text2)', marginBottom: 6, fontWeight: 500 }}>
              Username
            </label>
            <input
              className="input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              placeholder="Your game account name"
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--color-text2)', marginBottom: 6, fontWeight: 500 }}>
              Password
            </label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div style={{ color: 'var(--color-red)', fontSize: 12, marginBottom: 12, textAlign: 'center' }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center', padding: '10px 16px', opacity: loading ? .6 : 1 }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build the client**

Run: `npm run build:all`
Expected: no TypeScript errors.

- [ ] **Step 3: Live verification — no messages (regression check)**

```bash
npm run docker:build && docker compose up -d --force-recreate
```

With zero login messages configured (fresh state, or after deleting all from Settings → Login Messages), log out and load `/login`. Confirm the layout is pixel-identical to before this change — centered single login card, no extra panel, no layout shift.

- [ ] **Step 4: Live verification — with messages**

In Settings → Login Messages, add a message with a title, body, and an uploaded image, and confirm it's active. Log out and reload `/login`. Confirm:
- The message panel renders next to the login card (image, title, body).
- Toggling the message inactive in Settings and reloading `/login` makes it disappear.
- On a narrow viewport (resize browser to ~500px wide), the message panel stacks above the login card rather than overlapping or clipping.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/pages/Login.tsx public/index.html
git commit -m "auth: render active login messages on the login screen"
```

---

## Self-Review

**Spec coverage:**
- Data model & storage → Task 1.
- Backend routes (all 7 endpoints) → Tasks 2–3.
- Image upload (reusing `makeUploader`/`MIME_EXT`/`removeStaleVariants`, `UPLOADS_DIR` mkdir, delete-time cleanup) → Task 3.
- Settings UI (tab, panel, per-row save, image upload, reorder, delete-with-confirm, add-message) → Task 4.
- Login screen (fetch, render, flex-wrap layout, zero-message regression) → Task 5.
- API client → Task 4.
- Error handling (public endpoint never throws, 404s, mime/size validation reuse) → covered inline in Tasks 1–3.
- Testing (unit test for `loginMessages.ts`, live verification for the rest) → Task 1's unit tests plus Task 2's integration tests (a stronger version of the spec's minimum bar, matching this repo's established `db-items-filters.test.ts` convention) plus Tasks 3–5's live verification steps.

**Placeholder scan:** No TBD/TODO markers; every step has complete, runnable code and exact commands with expected output.

**Type consistency:** `LoginMessage`/`LoginMessagePublic` field names (`id`, `title`, `body`, `imageUrl`, `active`, `createdAt`) are identical across `src/loginMessages.ts` (Task 1), `src/routes/loginMessages.ts` and `src/routes/upload.ts` (Tasks 2–3), and `client/src/types.ts`/`api.ts`/`Settings.tsx`/`Login.tsx` (Tasks 4–5). Route response envelopes (`{ok, message}` for create/update, `{ok, messages}` for move, `{ok}` for delete, `{ok, url}` for upload) match what the API client and `LoginMessagesPanel` expect exactly.

**Deviation from spec:** the design doc says `id` is a "nanoid"; this plan uses Node's built-in `crypto.randomUUID()` instead, matching the exact existing convention in `src/routes/timers.ts` and `src/routes/scripts.ts` (both list-in-JSON-file CRUD modules) rather than adding a new dependency for an equivalent unique-id generator.
