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
      .prepare('SELECT id, role, content, ui, patch, created_at FROM llm_messages WHERE chat_id = ? ORDER BY created_at ASC')
      .all(chatId) as LlmMessage[];

    return rows
      .map((r) => {
        const html = `<div class="message message-${r.role}">${escapeHtml(r.content)}</div>`;
        const parts = [html];
        if (r.role === 'agent' && r.ui) {
          parts.push(r.ui);
        }
        if (r.role === 'agent' && r.patch) {
          parts.push(`<script>window.PromptUI.ui.patch(${r.patch.replace(/<\//g, '<\\/')})</script>`);
        }
        return parts.join('\n');
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

const seededChats = new Set<string>();

function seedWorkspace(chatId: string): void {
  if (seededChats.has(chatId)) return;
  const root = resolve(FS_ROOT, chatId);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });

  const dirs = ['documents', 'scripts', 'images', 'data', 'tmp'];
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });

  writeFileSync(join(root, 'hello.txt'), 'Hello from OS/2 2999!\nThis is a test file in your workspace.\nFeel free to edit or delete it.\n');
  writeFileSync(join(root, 'welcome.html'), '<!DOCTYPE html>\n<html>\n<head><title>Welcome</title></head>\n<body>\n  <h1>Welcome to OS/2 2999</h1>\n  <p>This file system is your playground.</p>\n</body>\n</html>\n');
  writeFileSync(join(root, '.hidden'), 'This file is hidden (starts with a dot).\n');

  writeFileSync(join(root, 'documents', 'readme.txt'), 'OS/2 2999 — Project README\n========================\n\nOverview:\n  This workspace simulates a local file system.\n  Use OS/2 Commander to browse, the Editor to modify files,\n  and Preview to view images and PDFs.\n\nGetting Started:\n  1. Open Commander from the Start menu\n  2. Browse the workspace directories\n  3. Use F4 to edit a file in the Editor\n');
  writeFileSync(join(root, 'documents', 'notes.md'), '# Meeting Notes\n\n## 2999-01-15 — Project Kickoff\n\n- Team assembled\n- Workspace initialized\n- File system operational\n\n## TODO\n\n- [x] Commander file browser\n- [ ] Code editor\n- [ ] Preview application\n- [ ] Performance benchmarks\n');

  writeFileSync(join(root, 'scripts', 'app.js'), '// OS/2 2999 — Application bootstrap\nconst APP_VERSION = \'1.0.0\';\n\nfunction init() {\n  console.log(\'OS/2 2999 booting...\');\n  registerServices();\n  mountFileSystem();\n  startWindowManager();\n}\n\nfunction registerServices() {\n  // Service registration\n  const services = [\'fs\', \'wm\', \'net\', \'audio\'];\n  for (const s of services) {\n    console.log(`  Registering ${s}...`);\n  }\n}\n\nfunction mountFileSystem() {\n  console.log(\'  Mounting volumes...\');\n}\n\nfunction startWindowManager() {\n  console.log(\'  Window manager ready.\');\n}\n\ninit();\n');
  writeFileSync(join(root, 'scripts', 'utils.ts'), '// OS/2 2999 — Utility functions\n\nexport function formatBytes(bytes: number): string {\n  if (bytes < 1024) return bytes + \' B\';\n  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + \' KB\';\n  return (bytes / (1024 * 1024)).toFixed(1) + \' MB\';\n}\n\nexport function formatDate(timestamp: number): string {\n  const d = new Date(timestamp);\n  const pad = (n: number) => String(n).padStart(2, \'0\');\n  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;\n}\n\nexport function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {\n  let timer: ReturnType<typeof setTimeout>;\n  return ((...args: unknown[]) => {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn(...args), ms);\n  }) as T;\n}\n');

  writeFileSync(join(root, 'images', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">\n  <rect width="100" height="100" rx="12" fill="#000080"/>\n  <text x="50" y="62" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="32" font-weight="bold">OS/2</text>\n  <text x="50" y="82" text-anchor="middle" fill="#c0c0c0" font-family="sans-serif" font-size="12">2999</text>\n</svg>\n');
  writeFileSync(join(root, 'images', 'photo.png'), 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==\n');
  writeFileSync(join(root, 'images', 'readme.txt'), 'Image files in this directory:\n  logo.svg   — OS/2 2999 logo (vector)\n  photo.png  — sample photo (base64 placeholder)\n');

  writeFileSync(join(root, 'data', 'config.json'), JSON.stringify({ app: 'OS/2 2999', version: '1.0.0', theme: 'dark', features: { fs: true, wm: true, net: true }, paths: { home: '/home', documents: '/documents', scripts: '/scripts', images: '/images', data: '/data', tmp: '/tmp' } }, null, 2) + '\n');
  writeFileSync(join(root, 'data', 'styles.css'), '/* OS/2 2999 — Global Styles */\n:root {\n  --bg: #0a0a14;\n  --surface: rgba(18, 18, 32, 0.92);\n  --accent: #5b6cf0;\n  --text: #e4e6f0;\n}\n\nbody {\n  background: var(--bg);\n  color: var(--text);\n  font-family: system-ui, sans-serif;\n}\n\n.container {\n  max-width: 1200px;\n  margin: 0 auto;\n  padding: 16px;\n}\n');

  writeFileSync(join(root, 'tmp', '.gitkeep'), '');

  seededChats.add(chatId);
}

function safePath(chatId: string, virtualPath: string): string {
  const clean = normalize(virtualPath).replace(/\\/g, '/').replace(/^\//, '');
  const resolved = resolve(FS_ROOT, chatId, clean);
  const root = resolve(FS_ROOT, chatId);
  if (!resolved.startsWith(root)) {
    throw new Error('Path traversal blocked');
  }
  return resolved;
}

app.get('/api/fs/ls', (req, res) => {
  try {
    const chatId = (req.query.chatId as string) || '_global';
    seedWorkspace(chatId);
    const vpath = (req.query.path as string) || '/';
    const realPath = safePath(chatId, vpath);
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
    const chatId = (req.query.chatId as string) || '_global';
    seedWorkspace(chatId);
    const vpath = req.query.path as string;
    const realPath = safePath(chatId, vpath);
    const content = readFileSync(realPath, 'utf-8');
    const stat = statSync(realPath);
    res.json({ path: vpath, content, size: stat.size });
  } catch (err) {
    res.status(404).json({ path: req.query.path as string || '/', content: '', size: 0, error: String(err) });
  }
});

app.post('/api/fs/write', (req, res) => {
  try {
    const chatId = (req.body.chatId as string) || '_global';
    seedWorkspace(chatId);
    const vpath = req.body.path as string;
    const content = req.body.content as string;
    const realPath = safePath(chatId, vpath);
    writeFileSync(realPath, content, 'utf-8');
    res.json({ path: vpath, written: Buffer.byteLength(content, 'utf-8') });
  } catch (err) {
    res.status(400).json({ path: req.body.path, written: 0, error: String(err) });
  }
});

app.post('/api/fs/mkdir', (req, res) => {
  try {
    const chatId = (req.body.chatId as string) || '_global';
    seedWorkspace(chatId);
    const vpath = req.body.path as string;
    const realPath = safePath(chatId, vpath);
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
