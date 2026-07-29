export const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New Chat',
  thinking INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS llm_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','agent','system')),
  content TEXT NOT NULL,
  ui TEXT,
  patch TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS forks (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_llm_messages_chat_id ON llm_messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_clients_chat_id ON clients(chat_id);
CREATE INDEX IF NOT EXISTS idx_forks_parent_id ON forks(parent_id);

CREATE TABLE IF NOT EXISTS llm_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  request TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_llm_logs_chat_id ON llm_logs(chat_id);
`;

export interface Chat {
  id: string;
  title: string;
  thinking: number;
  created_at: number;
}

export interface Client {
  client_id: string;
  secret: string;
  chat_id: string;
  created_at: number;
}

export interface LlmMessage {
  id: number;
  chat_id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  ui: string | null;
  patch: string | null;
  created_at: number;
}

export interface Fork {
  id: string;
  chat_id: string;
  parent_id: string;
  created_at: number;
}

export interface ChatPreview {
  id: string;
  title: string;
  lastMessage: string | null;
  lastRole: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface LlmLog {
  id: number;
  chat_id: string;
  request: string;
  response: string;
  created_at: number;
}
