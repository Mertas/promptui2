import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { getDb, closeDb } from '../db/index.js';
import { PORT, FS_ROOT } from './config.js';
import { setupWebSocket, broadcast, setReplayHandler } from './ws.js';
import { handlePrompt, stopGeneration, isProcessing } from './llm.js';
import { v4 as uuid } from 'uuid';
import type { LlmMessage, ChatPreview } from '../db/schema.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, dirname, normalize } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
setupWebSocket(wss);

// ─── Replay handler for WS reconnect ─────────────────────────

setReplayHandler((chatId: string, path: string) => {
  const db = getDb();
  if (path === '/body') {
    const rows = db
      .prepare('SELECT id, role, content, ui, created_at FROM llm_messages WHERE chat_id = ? ORDER BY created_at ASC')
      .all(chatId) as LlmMessage[];

    return rows
      .map((r) => {
        const html = `<div class="message message-${r.role}">${escapeHtml(r.content)}</div>`;
        // Append UI script for agent messages that have one
        if (r.role === 'agent' && r.ui) {
          return html + '\n' + r.ui;
        }
        return html;
      })
      .join('\n');
  }
  return null;
});

// ─── Static client scripts ───────────────────────────────────

function sendClientFile(res: express.Response, filename: string) {
  const filePath = resolve(__dirname, '..', '..', 'dist', 'client', filename);
  if (existsSync(filePath)) {
    res.type('application/javascript').send(readFileSync(filePath, 'utf-8'));
  } else {
    res.status(404).send('// not found');
  }
}

// ─── Pages ───────────────────────────────────────────────────

function indexHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PromptUI2</title>
</head>
<body>
  <script src="/api/chat-list.js"></script>
</body>
</html>`;
}

function appHtml(chatId: string) {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, role, content, created_at FROM llm_messages WHERE chat_id = ? ORDER BY created_at ASC')
    .all(chatId) as LlmMessage[];

  const messages = rows.map((r) => ({
    id: String(r.id),
    role: r.role,
    text: r.content,
    timestamp: r.created_at,
  }));

  const chat = db.prepare('SELECT thinking FROM chats WHERE id = ?').get(chatId) as { thinking: number } | undefined;
  const thinking = chat?.thinking === 1;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PromptUI2 — Chat</title>
</head>
<body>
  <script>window.__CHAT_ID__ = '${chatId}';</script>
  <script>window.__CHAT_THINKING__ = ${thinking};</script>
  <script>window.__INITIAL_MESSAGES__ = ${JSON.stringify(messages).replace(/<\//g, '<\\/')};</script>
  <script src="/api/runtime.js"></script>
  <script src="/api/bridge.js"></script>
  <script src="/api/default-chat.js"></script>
</body>
</html>`;
}

// ─── Routes ──────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.send(indexHtml());
});

app.get('/chat/:id', (req, res) => {
  const db = getDb();
  const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) {
    return res.status(404).send('Chat not found');
  }
  res.send(appHtml(req.params.id));
});

// ─── API: Chat list ──────────────────────────────────────────

app.get('/api/chats', (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
        c.id, c.title, c.created_at as createdAt,
        (SELECT content FROM llm_messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as lastMessage,
        (SELECT role FROM llm_messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as lastRole,
        (SELECT COUNT(*) FROM llm_messages WHERE chat_id = c.id) as messageCount,
        (SELECT MAX(created_at) FROM llm_messages WHERE chat_id = c.id) as updatedAt
      FROM chats c
      ORDER BY updatedAt DESC, c.created_at DESC`,
    )
    .all() as ChatPreview[];

  const previews = rows.map((r) => ({
    id: r.id,
    title: r.title,
    lastMessage: r.lastMessage || null,
    lastRole: r.lastRole || null,
    messageCount: r.messageCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt || r.createdAt,
  }));

  res.json(previews);
});

app.post('/api/chats', (_req, res) => {
  const db = getDb();
  const chatId = uuid();
  const clientId = uuid();
  const secret = uuid();

  db.transaction(() => {
    db.prepare('INSERT INTO chats (id, title) VALUES (?, ?)').run(chatId, 'New Chat');
    db.prepare('INSERT INTO clients (client_id, secret, chat_id) VALUES (?, ?, ?)').run(clientId, secret, chatId);
  })();

  res.json({ id: chatId, clientId, clientSecret: secret });
});

// ─── API: Get messages for replay ────────────────────────────

app.get('/chat/:id/messages', (req, res) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, role, content, created_at FROM llm_messages WHERE chat_id = ? ORDER BY created_at ASC')
    .all(req.params.id) as LlmMessage[];

  const messages = rows.map((r) => ({
    id: String(r.id),
    role: r.role,
    text: r.content,
    timestamp: r.created_at,
  }));

  res.json(messages);
});

// ─── API: Chat operations ────────────────────────────────────

app.post('/chat/:id/prompt', (req, res) => {
  const { clientId, clientSecret, prompt } = req.body;
  const chatId = req.params.id;

// Verify credentials
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'Prompt must be a non-empty string' });
  }

  const db = getDb();
  const client = db
    .prepare('SELECT * FROM clients WHERE client_id = ? AND secret = ? AND chat_id = ?')
    .get(clientId, clientSecret, chatId);

  if (!client) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Guard concurrent requests
  if (isProcessing(chatId)) {
    return res.status(429).json({ error: 'Already processing a request' });
  }

  res.json({ status: 'processing' });

  handlePrompt(chatId, prompt, (type, data) => {
    switch (type) {
      case 'user-bubble':
        broadcast(chatId, '/body', data as string);
        break;
      case 'thinking':
        broadcast(chatId, '/chat/stream', JSON.stringify({ path: '/chat/stream', type: 'thinking', value: data }));
        break;
      case 'stream':
        broadcast(chatId, '/chat/stream', JSON.stringify({ path: '/chat/stream', type: 'chunk', content: data }));
        break;
      case 'update':
        broadcast(chatId, '/body', data as string);
        break;
      case 'done':
        broadcast(chatId, '/chat/stream', JSON.stringify({ path: '/chat/stream', type: 'done' }));
        break;
      case 'fallback':
        broadcast(
          chatId,
          '/body',
          `<div class="message message-agent">An error occurred. Try again.</div>`,
        );
        broadcast(chatId, '/chat/stream', JSON.stringify({ path: '/chat/stream', type: 'done' }));
        break;
    }
  }).catch(() => {
    broadcast(
      chatId,
      '/body',
      `<div class="message message-agent">An error occurred. Try again.</div>`,
    );
    broadcast(chatId, '/chat/stream', JSON.stringify({ path: '/chat/stream', type: 'done' }));
  });
});

app.post('/chat/:id/stop', (req, res) => {
  const { clientId, clientSecret } = req.body;
  const chatId = req.params.id;

  const db = getDb();
  const client = db
    .prepare('SELECT * FROM clients WHERE client_id = ? AND secret = ? AND chat_id = ?')
    .get(clientId, clientSecret, chatId);

  if (!client) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  stopGeneration(chatId);
  res.json({ status: 'stopped' });
});

app.post('/chat/:id/undo', (req, res) => {
  const { clientId, clientSecret } = req.body;
  const chatId = req.params.id;

  const db = getDb();
  const client = db
    .prepare('SELECT * FROM clients WHERE client_id = ? AND secret = ? AND chat_id = ?')
    .get(clientId, clientSecret, chatId);

  if (!client) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Remove last user + agent pair
  const lastAgent = db
    .prepare('SELECT id FROM llm_messages WHERE chat_id = ? AND role = ? ORDER BY id DESC LIMIT 1')
    .get(chatId, 'agent') as LlmMessage | undefined;

  let agentId: number | null = null;
  let userId: number | null = null;

  if (lastAgent) {
    const lastUser = db
      .prepare('SELECT id FROM llm_messages WHERE chat_id = ? AND role = ? AND id < ? ORDER BY id DESC LIMIT 1')
      .get(chatId, 'user', lastAgent.id) as LlmMessage | undefined;

    agentId = lastAgent.id;
    if (lastUser) userId = lastUser.id;

    db.prepare('DELETE FROM llm_messages WHERE id = ?').run(lastAgent.id);
    if (lastUser) {
      db.prepare('DELETE FROM llm_messages WHERE id = ?').run(lastUser.id);
    }
  }

  // Notify client to remove messages from DOM (no full reload)
  broadcast(
    chatId,
    '/body',
    JSON.stringify({ path: '/body', type: 'undo', agentId, userId }),
  );

  res.json({ status: 'ok' });
});

app.post('/chat/:id/snapshot', (req, res) => {
  const { clientId, clientSecret } = req.body;
  const chatId = req.params.id;

  const db = getDb();
  const client = db
    .prepare('SELECT * FROM clients WHERE client_id = ? AND secret = ? AND chat_id = ?')
    .get(clientId, clientSecret, chatId);

  if (!client) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const newChatId = uuid();
  const newClientId = uuid();
  const newSecret = uuid();

  const snapshot = db.transaction(() => {
    db.prepare('INSERT INTO chats (id, title) SELECT ?, title FROM chats WHERE id = ?').run(newChatId, chatId);
    db.prepare('INSERT INTO clients (client_id, secret, chat_id) VALUES (?, ?, ?)').run(
      newClientId,
      newSecret,
      newChatId,
    );
    db.prepare(
      'INSERT INTO llm_messages (chat_id, role, content, created_at) SELECT ?, role, content, created_at FROM llm_messages WHERE chat_id = ?',
    ).run(newChatId, chatId);
    db.prepare('INSERT INTO forks (id, chat_id, parent_id) VALUES (?, ?, ?)').run(uuid(), newChatId, chatId);
  });

  snapshot();

  res.json({ id: newChatId, clientId: newClientId, clientSecret: newSecret });
});

// ─── API: Filesystem ─────────────────────────────────────────

function safePath(virtualPath: string): string {
  const resolved = resolve(FS_ROOT, normalize(virtualPath).replace(/\\/g, '/'));
  const root = resolve(FS_ROOT);
  if (!resolved.startsWith(root)) {
    throw new Error('Path traversal blocked');
  }
  return resolved;
}

app.get('/api/fs/ls', (req, res) => {
  try {
    const vpath = (req.query.path as string) || '/';
    const realPath = safePath(vpath);
    const entries = readdirSync(realPath, { withFileTypes: true });
    const items = entries.map((e) => {
      const fullPath = join(realPath, e.name);
      const stat = statSync(fullPath);
      return {
        name: e.name,
        isDirectory: e.isDirectory(),
        size: stat.size,
        modified: stat.mtimeMs,
      };
    });
    res.json({ path: vpath, items });
  } catch (err) {
    res.status(404).json({ path: req.query.path as string || '/', items: [], error: String(err) });
  }
});

app.get('/api/fs/read', (req, res) => {
  try {
    const vpath = req.query.path as string;
    const realPath = safePath(vpath);
    const content = readFileSync(realPath, 'utf-8');
    const stat = statSync(realPath);
    res.json({ path: vpath, content, size: stat.size });
  } catch (err) {
    res.status(404).json({ path: req.query.path as string || '/', content: '', size: 0, error: String(err) });
  }
});

app.post('/api/fs/write', (req, res) => {
  try {
    const vpath = req.body.path as string;
    const content = req.body.content as string;
    const realPath = safePath(vpath);
    writeFileSync(realPath, content, 'utf-8');
    res.json({ path: vpath, written: Buffer.byteLength(content, 'utf-8') });
  } catch (err) {
    res.status(400).json({ path: req.body.path, written: 0, error: String(err) });
  }
});

app.post('/api/fs/mkdir', (req, res) => {
  try {
    const vpath = req.body.path as string;
    const realPath = safePath(vpath);
    mkdirSync(realPath, { recursive: true });
    res.json({ path: vpath, created: true });
  } catch (err) {
    res.status(400).json({ path: req.body.path, created: false, error: String(err) });
  }
});

// ─── API: Static scripts ─────────────────────────────────────

app.get('/api/runtime.js', (_req, res) => sendClientFile(res, 'runtime.js'));
app.get('/api/bridge.js', (_req, res) => sendClientFile(res, 'bridge.js'));
app.get('/api/default-chat.js', (_req, res) => sendClientFile(res, 'default-chat.js'));
app.get('/api/chat-list.js', (_req, res) => sendClientFile(res, 'chat-list.js'));

// ─── Start ───────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`PromptUI2 server running at http://localhost:${PORT}`);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  console.log('\nShutting down...');
  // Close WebSocket server
  wss.close();
  // Close HTTP server
  server.close();
  // Close database (flush WAL)
  closeDb();
  process.exit(0);
}

export { server };

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
