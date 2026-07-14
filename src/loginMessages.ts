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
  try {
    const parsed = JSON.parse(fs.readFileSync(LOGIN_MESSAGES_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed as LoginMessage[] : [];
  } catch { return []; }
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
