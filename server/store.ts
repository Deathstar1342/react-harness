import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Approval, ApprovalMode, Chat, ChatDetail, Message, Plan, Project, RunEvent, TestReport } from '../shared/types.js';

const now = () => new Date().toISOString();
export class Store {
  readonly db: DatabaseSync;
  readonly changes = new EventEmitter();
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, chat_id TEXT NOT NULL REFERENCES chats(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL REFERENCES chats(id), type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_chat ON events(chat_id,id);
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id,seq);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS test_reports (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), data TEXT NOT NULL);
    `);
    this.changes.setMaxListeners(100);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getState<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT data FROM state WHERE key=?').get(key);
    return row ? JSON.parse(String(row.data)) as T : fallback;
  }
  setState(key: string, value: unknown) { this.db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(value)); }
  projects(): Project[] { return this.db.prepare('SELECT data FROM projects ORDER BY rowid DESC').all().map(row => JSON.parse(String(row.data))); }
  project(id: string): Project {
    const row = this.db.prepare('SELECT data FROM projects WHERE id=?').get(id);
    if (!row) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    return JSON.parse(String(row.data));
  }
  createProject(name: string, root: string): Project {
    const existing = this.db.prepare('SELECT data FROM projects WHERE root=?').get(root);
    if (existing) return JSON.parse(String(existing.data));
    const project = { id: randomUUID(), name, path: root, createdAt: now() };
    this.db.prepare('INSERT INTO projects VALUES (?,?,?)').run(project.id, root, JSON.stringify(project));
    return project;
  }
  chats(projectId?: string): Chat[] {
    return (projectId ? this.db.prepare('SELECT data FROM chats WHERE project_id=?').all(projectId) : this.db.prepare('SELECT data FROM chats').all()).map(row => JSON.parse(String(row.data))).sort((a: Chat,b: Chat) => b.updatedAt.localeCompare(a.updatedAt));
  }
  chat(id: string): Chat {
    const row = this.db.prepare('SELECT data FROM chats WHERE id=?').get(id);
    if (!row) throw Object.assign(new Error('Chat not found'), { statusCode: 404 });
    return JSON.parse(String(row.data));
  }
  createChat(projectId: string, title: string, approvalMode: ApprovalMode): Chat {
    this.project(projectId);
    const chat: Chat = { id: randomUUID(), projectId, title, approvalMode, status: 'idle', createdAt: now(), updatedAt: now() };
    this.db.prepare('INSERT INTO chats VALUES (?,?,?)').run(chat.id, projectId, JSON.stringify(chat));
    return chat;
  }
  updateChat(id: string, patch: Partial<Pick<Chat,'title'|'approvalMode'|'status'>>): Chat {
    const chat = { ...this.chat(id), ...patch, updatedAt: now() };
    this.db.prepare('UPDATE chats SET data=? WHERE id=?').run(JSON.stringify(chat), id);
    this.event(id, 'status', chat);
    return chat;
  }
  messages(chatId: string): Message[] { return this.db.prepare('SELECT data FROM messages WHERE chat_id=? ORDER BY seq').all(chatId).map(row => JSON.parse(String(row.data))); }
  message(chatId: string, role: Message['role'], content: string, metadata?: Record<string,unknown>): Message {
    const item: Message = { id: randomUUID(), chatId, role, content, createdAt: now(), ...(metadata ? { metadata } : {}) };
    this.db.prepare('INSERT INTO messages(id,chat_id,data) VALUES (?,?,?)').run(item.id, chatId, JSON.stringify(item));
    this.event(chatId, 'message', item);
    return item;
  }
  event(chatId: string, type: string, data: unknown): RunEvent {
    const createdAt = now();
    const result = this.db.prepare('INSERT INTO events(chat_id,type,data,created_at) VALUES (?,?,?,?)').run(chatId,type,JSON.stringify(data),createdAt);
    const event = { id: Number(result.lastInsertRowid), chatId, type, data, createdAt };
    // Emission after the synchronous statement; listeners only send data, never mutate state.
    this.changes.emit(chatId, event);
    this.changes.emit('event', event);
    return event;
  }
  events(chatId: string, after = 0, limit = 2000): RunEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE chat_id=? AND id>? ORDER BY id LIMIT ?').all(chatId,after,limit).map(row => ({ id: Number(row.id), chatId: String(row.chat_id), type: String(row.type), data: JSON.parse(String(row.data)), createdAt: String(row.created_at) }));
  }
  approval(item: Approval): void {
    this.db.prepare('INSERT INTO approvals VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(item.id,item.chatId,JSON.stringify(item));
    this.event(item.chatId,'approval',item);
  }
  getApproval(id: string): Approval {
    const row = this.db.prepare('SELECT data FROM approvals WHERE id=?').get(id);
    if (!row) throw Object.assign(new Error('Approval not found'), { statusCode: 404 });
    return JSON.parse(String(row.data));
  }
  approvals(chatId: string): Approval[] { return this.db.prepare('SELECT data FROM approvals WHERE chat_id=? ORDER BY rowid').all(chatId).map(row => JSON.parse(String(row.data))); }
  invalidateApprovals(chatId: string): void { for (const approval of this.approvals(chatId)) if (approval.status === 'pending' || approval.status === 'approved') this.approval({ ...approval, status: 'stale' }); }
  plan(chatId: string): Plan { return this.getState(`plan:${chatId}`, { phases: [] }); }
  setPlan(chatId: string, plan: Plan) { this.setState(`plan:${chatId}`, plan); this.event(chatId,'plan',plan); }
  testReport(chatId: string, report: TestReport) {
    this.db.prepare('INSERT INTO test_reports VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(report.id,chatId,JSON.stringify(report));
    this.event(chatId,'tests',report);
  }
  detail(chatId: string): ChatDetail {
    return { chat: this.chat(chatId), messages: this.messages(chatId), plan: this.plan(chatId), approvals: this.approvals(chatId), events: this.events(chatId,0,1000), tests: this.db.prepare('SELECT data FROM test_reports WHERE chat_id=? ORDER BY rowid').all(chatId).map(row => JSON.parse(String(row.data))) };
  }
  recover() {
    for (const chat of this.chats()) if (chat.status === 'running') {
      this.updateChat(chat.id, { status: 'interrupted' });
      this.message(chat.id,'system','The backend restarted during this task. Resume will reconcile recorded actions; uncertain commands will not be rerun automatically.');
    }
  }
  close() { this.changes.removeAllListeners(); this.db.close(); }
}
