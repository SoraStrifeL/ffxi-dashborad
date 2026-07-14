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
