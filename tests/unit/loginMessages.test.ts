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
