# PromptUI2

Чат-приложение, где LLM управляет интерфейсом исключительно через JavaScript API. Никакой обязательной HTML-структуры. LLM получает `PromptUI.*` API и строит интерфейс как хочет — окна, терминал, игру, панель управления.

Две страницы: главная (`index.html`) со списком всех чатов и превью, и страница чата (`app.html`) — shell, управляемый LLM через PromptUI API. Эталонная реализация чата (`default-chat.js`) использует тот же API.

---

## 1. Архитектура

```
┌──────────────────────────────────────────────────────────┐
│                       Браузер                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │  index.html (главная: список чатов)                │  │
│  │  <script src="/api/chat-list.js"></script>        │  │
│  ├────────────────────────────────────────────────────┤  │
│  │  app.html (shell чата: только <script> теги)       │  │
│  │  <script src="/api/runtime.js"></script>           │  │
│  │  <script src="/api/bridge.js"></script>            │  │
│  │  <script src="/api/default-chat.js"></script>      │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │  PromptUI API                                      │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌───────────┐  │  │
│  │  │ messages.*   │ │ fs.*         │ │ ui.*      │  │  │
│  │  └──────────────┘ └──────────────┘ └───────────┘  │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Runtime: Subscription / dispatch / replay / WS   │  │
│  └────────────────────────────────────────────────────┘  │
│                           │ WebSocket                    │
│                           ▼                              │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Сервер (Node.js + Express + tsx)                  │  │
│  │  Роуты REST+WS / LLM-клиент / SQLite               │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Принципы

1. **Только JS API.** LLM не привязана к HTML-структуре. Весь UI — через `PromptUI.ui.*` и стандартный DOM API.
2. **Дефолтный чат — эталон.** `default-chat.js` использует то же API. LLM может скопировать подход или придумать свой.
3. **Нет токенов в разметке.** `clientId` и `clientSecret` доступны через `PromptUI.messages.clientId`.
4. **Отправка через API.** `PromptUI.messages.send()` делает HTTP-запрос сам. Никаких форм и iframe.

---

## 3. JavaScript API

### 3.1. Messages API

```typescript
PromptUI.messages.get(): Message[]
PromptUI.messages.on('add', (msg: Message) => void): () => void
PromptUI.messages.on('thinking', (v: boolean) => void): () => void
PromptUI.messages.send(text: string): boolean
PromptUI.messages.undo(): void
PromptUI.messages.snapshot(): void
PromptUI.messages.thinking: boolean   // read-only
PromptUI.messages.clientId: string    // read-only

interface Message {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  timestamp: number;
}
```

**Правила:**
- `get()` — копия массива.
- `on('add')` — не реплеит историю. Для истории — `get()`.
- `send()` при `thinking === true` — останавливает генерацию.
- Дедупликация по `id`.
- Никогда не читать сообщения из DOM — использовать API.

### 3.2. UI API

```typescript
// Page-level operations
PromptUI.ui.set(html: string): void          // Replace entire <body>
PromptUI.ui.append(html: string): void       // Add HTML to <body>
PromptUI.ui.activateScripts(container?: Element): void  // Execute <script> tags
```

#### DOM helpers

Короткие функции для сокращения boilerplate. Доступны как `PromptUI.el`, `PromptUI.$`, `PromptUI.on`.

```typescript
// Create an element: el(tag, attrs?, ...children)
PromptUI.el('div', {class: 'msg msg-user', id: 'm1'}, 'Hello!');
PromptUI.el('button', {onclick: () => send()}, '▶');
PromptUI.el('span', 'text only');
PromptUI.el('br');  // self-closing

// Query
PromptUI.$('selector')            // document.querySelector
PromptUI.$$('selector')           // document.querySelectorAll → real Array

// Events
PromptUI.on(el, 'click', fn)             // addEventListener
PromptUI.on('.msg', 'click', fn)         // delegation: $('.msg')?.addEventListener
PromptUI.on(document, 'click', '.msg', fn) // live delegation

// Append helpers
PromptUI.append(parent, ...children)     // parent.append(...children)
PromptUI.clear(el)                       // el.innerHTML = ''
```

### 3.3. Filesystem API

```typescript
PromptUI.fs.ls(path): Promise<{path, items: FileItem[]}>
PromptUI.fs.read(path): Promise<{path, content, size}>
PromptUI.fs.write(path, content): Promise<{path, written}>
PromptUI.fs.mkdir(path): Promise<{path, created}>
```

Файловая система изолирована в рабочей директории сервера. Пути — виртуальные, без выхода за пределы рабочего каталога.

---

## 4. Протокол обмена

### 4.1. Запрос пользователя

`PromptUI.messages.send(text)` → POST `/chat/:id/prompt`:

```json
{ "clientId": "...", "clientSecret": "...", "prompt": "text" }
```

### 4.2. Ответ LLM

LLM возвращает JSON. Никаких маркеров, префиксов или плейсхолдеров.

**Только текст:**
```json
{ "text": "Привет! Чем могу помочь?" }
```

**Текст + смена интерфейса:**
```json
{
  "text": "Создаю интерфейс...",
  "ui": "<script>PromptUI.ui.set(`...`);PromptUI.ui.activateScripts(document.body);</script>"
}
```

**Правила валидации на сервере:**
- `text` обязателен. Если отсутствует — `fallbackUpdate`.
- `ui` опционален. Если есть, должен содержать хотя бы один `<script>` тег. Иначе игнорируется.
- JSON должен быть валидным. Битый JSON → `fallbackUpdate`.

### 4.3. HTML-обёртка для text

Сервер заворачивает `text` в HTML и отправляет в WebSocket на путь `/body`:

```html
<div class="message message-agent">{{text}}</div>
```

Рантайм на клиенте видит `<div class="message ...">` → вызывает `_messagesAdd()`, что триггерит `on('add')`.

### 4.4. Исполнение ui-скрипта

Сервер отправляет содержимое `ui` также на `/body`. Рантайм видит `<script>...</script>` → выполняет его через `activateScripts()`.

---

## 5. Функциональные требования к интерфейсу

Обязательны только возможности. Воплощение — любое.

| Возможность | API |
|------------|-----|
| Видеть историю сообщений | `messages.get()` |
| Новые сообщения в real-time | `messages.on('add', fn)` |
| Отправить сообщение | `messages.send(text)` |
| Остановить генерацию | `messages.send()` при `thinking` |
| Индикатор «думает» | `messages.on('thinking', fn)` |
| Отменить ход | `messages.undo()` |
| Копия чата | `messages.snapshot()` |

### Дефолтный чат (default-chat.js)

Эталонная реализация:

```javascript
// default-chat.js
(() => {
  const { el, $, on, append, clear } = PromptUI;

  PromptUI.ui.set(`
    <style>
      body { font-family: system-ui; background: #1a1a2e; color: #eee; }
      #chat { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
      .msg { max-width: 80%; padding: 8px 12px; border-radius: 12px; }
      .msg-user { align-self: flex-end; background: #e94560; }
      .msg-agent { align-self: flex-start; background: #16213e; }
      #toolbar { display: flex; gap: 8px; padding: 12px; background: #0f0f23; }
      #input { flex: 1; padding: 8px 12px; border: none; border-radius: 8px; background: #1a1a2e; color: #eee; resize: none; }
      #send { padding: 8px 16px; border: none; border-radius: 8px; background: #e94560; color: #fff; cursor: pointer; }
      #menu-drop { display: none; position: absolute; bottom: 100%; right: 0; background: #16213e; border-radius: 8px; padding: 4px; }
    </style>
    <div id="chat"></div>
    <div id="toolbar">
      <textarea id="input" placeholder="Type a message..." rows="1"></textarea>
      <button id="send">▶</button>
      <div id="menu" style="position:relative">
        <button id="menu-btn">···</button>
        <div id="menu-drop">
          <button id="undo-btn">↩ Undo</button>
          <button id="snapshot-btn">📋 Snapshot</button>
        </div>
      </div>
    </div>
  `);
  PromptUI.ui.activateScripts(document.body);

  // ---- Messages ----
  const chat = $('#chat');

  function render(msg) {
    return el('div', {class: `msg msg-${msg.role}`}, msg.text);
  }

  const msgs = PromptUI.messages.get();
  for (const m of msgs) append(chat, render(m));

  PromptUI.messages.on('add', m => {
    append(chat, render(m));
    scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  });

  // ---- Send ----
  const input = $('#input');
  const sendBtn = $('#send');

  on(sendBtn, 'click', () => {
    const text = input.value.trim();
    if (text) PromptUI.messages.send(text);
    input.value = '';
  });

  on(input, 'keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
  });

  // ---- Thinking ----
  PromptUI.messages.on('thinking', v => { sendBtn.textContent = v ? '■' : '▶'; });

  // ---- Menu ----
  const menuDrop = $('#menu-drop');

  on('#menu-btn', 'click', e => {
    e.stopPropagation();
    menuDrop.style.display = menuDrop.style.display === 'block' ? 'none' : 'block';
    const r = $('#menu-btn').getBoundingClientRect();
    Object.assign(menuDrop.style, { left: `${r.right - 100}px`, bottom: `${innerHeight - r.top + 2}px` });
  });

  on('#undo-btn', 'click', () => PromptUI.messages.undo());
  on('#snapshot-btn', 'click', () => PromptUI.messages.snapshot());
  on(document, 'click', '.msg', e => { if (!e.target.closest('#menu')) menuDrop.style.display = 'none'; });
})();
```

---

## 6. Сервер

### 6.1. Стек
- Node.js 20+, TypeScript (`tsx`)
- Express.js + `ws`
- SQLite (`better-sqlite3`)
- DeepSeek API

### 6.2. Конфигурация

Переменные окружения (`.env`):
```
PORT=3042
DB_PATH=./data/promptui.db
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-chat
LLM_TIMEOUT_MS=60000
FS_ROOT=./workspace
```

### 6.3. Роуты

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/` | Главная страница — список всех чатов |
| `GET` | `/api/chats` | JSON: список чатов с превью |
| `POST` | `/api/chats` | Создать новый чат → редирект на `/chat/:id` |
| `GET` | `/chat/:id` | HTML-страница чата |
| `GET` | `/api/runtime.js` | Рантайм |
| `GET` | `/api/bridge.js` | PromptUI API |
| `GET` | `/api/default-chat.js` | Эталонный чат |
| `GET` | `/api/chat-list.js` | Скрипт главной страницы |
| `GET` | `/api/fs/ls?path=...` | Список файлов |
| `GET` | `/api/fs/read?path=...` | Чтение файла |
| `POST` | `/api/fs/write` | Запись |
| `POST` | `/api/fs/mkdir` | Создание папки |
| `POST` | `/chat/:id/prompt` | Отправка |
| `POST` | `/chat/:id/undo` | Отмена |
| `POST` | `/chat/:id/snapshot` | Форк |
| `WS` | `/chat/:id/socket` | Real-time |

### 6.4. БД

```sql
chats         (id TEXT PK, title TEXT, created_at INTEGER)
clients       (client_id TEXT, secret TEXT, chat_id TEXT, created_at INTEGER)
llm_messages  (id INTEGER PK, chat_id TEXT, role TEXT, content TEXT, created_at INTEGER)
forks         (id TEXT PK, chat_id TEXT, parent_id TEXT, created_at INTEGER)

CREATE INDEX idx_llm_messages_chat_id ON llm_messages(chat_id);
CREATE INDEX idx_clients_chat_id ON clients(chat_id);
```

### 6.5. Жизненный цикл запроса

```
POST /chat/:id/prompt
  → валидация clientId + clientSecret (возврат 401 при ошибке)
  → вызов DeepSeek API (stream)
  → при успехе: сохранение user-сообщения + assistant-сообщения в БД
  → broadcastUserBubble (WS → /body)
  → broadcastStream(thinking=true)
  → broadcastStream(чанки текста по мере стриминга)
  → парсинг JSON-ответа (извлечение text и ui)
  → broadcastUpdate (WS → /body: HTML-обёртка text + ui-скрипт)
  → broadcastStream(done=true)
```

При ошибке LLM: user-сообщение не сохраняется, клиенту — `fallbackUpdate`.

### 6.6. app.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PromptUI2</title>
</head>
<body>
  <script src="/api/runtime.js"></script>
  <script src="/api/bridge.js"></script>
  <script src="/api/default-chat.js"></script>
</body>
</html>
```

### 6.7. Главная страница (index.html)

Отдаётся по `GET /`. Показывает список всех чатов с превью последнего сообщения. Не использует PromptUI API.

**Данные:** `GET /api/chats` возвращает JSON:
```json
[
  {
    "id": "abc123",
    "title": "Обсуждение архитектуры",
    "lastMessage": "Да, WebSocket подходит лучше...",
    "lastRole": "agent",
    "messageCount": 14,
    "createdAt": 1712345678000,
    "updatedAt": 1712345999000
  }
]
```

**index.html:**
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PromptUI2</title>
</head>
<body>
  <script src="/api/chat-list.js"></script>
</body>
</html>
```

**chat-list.js:**
```javascript
// chat-list.js — главная страница со списком всех чатов
(async () => {
  const chats = await fetch('/api/chats').then(r => r.json());

  document.body.innerHTML = `
    <style>
      body { font-family: system-ui; background: #0f0f23; color: #eee; margin: 0; }
      header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; background: #1a1a2e; }
      header h1 { margin: 0; font-size: 20px; }
      #new-chat { padding: 8px 16px; border: none; border-radius: 8px; background: #e94560; color: #fff; cursor: pointer; font-size: 14px; }
      #new-chat:hover { background: #c73652; }
      #chat-list { max-width: 800px; margin: 0 auto; padding: 16px; }
      .chat-card { display: block; padding: 16px; margin-bottom: 8px; background: #16213e; border-radius: 12px; text-decoration: none; color: #eee; transition: background .2s; }
      .chat-card:hover { background: #1f3060; }
      .chat-title { font-weight: 600; margin-bottom: 4px; }
      .chat-preview { font-size: 14px; color: #8892b0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .chat-meta { display: flex; gap: 12px; margin-top: 8px; font-size: 12px; color: #5a6680; }
      .empty { text-align: center; padding: 40px; color: #5a6680; }
    </style>
    <header>
      <h1>PromptUI2</h1>
      <button id="new-chat">+ New Chat</button>
    </header>
    <div id="chat-list"></div>
  `;

  const list = document.getElementById('chat-list');

  if (chats.length === 0) {
    list.innerHTML = '<div class="empty">No chats yet. Click "New Chat" to start.</div>';
  } else {
    for (const c of chats) {
      const card = document.createElement('a');
      card.className = 'chat-card';
      card.href = `/chat/${c.id}`;
      card.innerHTML = `
        <div class="chat-title">${esc(c.title)}</div>
        <div class="chat-preview">${esc(c.lastMessage ?? 'Empty chat')}</div>
        <div class="chat-meta">
          <span>${c.messageCount} messages</span>
          <span>${ago(c.updatedAt)}</span>
        </div>
      `;
      list.appendChild(card);
    }
  }

  document.getElementById('new-chat').onclick = async () => {
    const res = await fetch('/api/chats', { method: 'POST' });
    const { id } = await res.json();
    location.href = `/chat/${id}`;
  };

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function ago(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
})();
```

**POST /api/chats (создание нового чата):**
- Генерирует `id` (UUID v4)
- Создаёт запись в `chats` с title = `"New Chat"`
- Создаёт `client` запись с `clientId` + `clientSecret`
- Возвращает `{ id, clientId, clientSecret }`

---

## 7. Клиентский рантайм

### 7.1. Файлы

| Файл | Содержание |
|------|-----------|
| `runtime.js` | Subscription, dispatch, replay, WebSocket |
| `bridge.js` | PromptUI.messages, PromptUI.fs, PromptUI.ui |
| `default-chat.js` | Эталонный чат |
| `chat-list.js` | Главная страница со списком чатов |

### 7.2. Встроенные подписки

| Путь | Действие |
|------|----------|
| `/body` | Классификация: `<div class="message">` → `_messagesAdd()`, `<script>` → выполнить |
| `/chat/stream` | Стриминг: thinking dots → текст → done |
| `/page/reload` | `location.reload()` |

### 7.3. PromptUI.ui + DOM helpers

```javascript
// Page-level
PromptUI.ui = {
  set(html) { document.body.innerHTML = html; },
  append(html) {
    const t = document.createElement('template');
    t.innerHTML = html;
    while (t.content.firstChild) document.body.appendChild(t.content.firstChild);
  },
  activateScripts(container = document) {
    for (const old of container.querySelectorAll('script')) {
      const ns = document.createElement('script');
      for (const { name, value } of old.attributes) ns.setAttribute(name, value);
      ns.textContent = old.textContent;
      old.replaceWith(ns);
    }
  }
};

// DOM helpers — short functions, less boilerplate
const el = (tag, attrs, ...children) => {
  const e = document.createElement(tag);
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
  } else if (attrs !== undefined) {
    children.unshift(attrs);
  }
  for (const c of children) e.append(typeof c === 'string' ? document.createTextNode(c) : c ?? '');
  return e;
};

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

const on = (target, event, arg2, arg3) => {
  if (typeof target === 'string') target = $(target);
  if (!target) return;
  if (typeof arg2 === 'string') target.addEventListener(event, e => {
    const match = e.target.closest(arg2);
    if (match) arg3(e, match);
  });
  else target.addEventListener(event, arg2);
};

const append = (parent, ...children) => children.forEach(c => parent.append(c));
const clear = el => { el.innerHTML = ''; };

Object.assign(PromptUI, { el, $, $$, on, append, clear });
```

---

## 8. Обработка ошибок

| Ситуация | Поведение |
|----------|----------|
| Сеть | WS реконнект: 1с → 2с → 4с → ... → 30с |
| LLM: невалидный JSON | `fallbackUpdate` |
| LLM: отсутствует `text` | `fallbackUpdate` |
| Очередь переполнена | 429 |
| Таймаут LLM (60с) | `fallbackUpdate` |
| Дубликат сообщения | Пропускается по ID |
| Невалидный clientId/secret | 401 |

---

## 9. Безопасность

- **Валидация путей файловой системы**: все пути проверяются на выход за пределы `FS_ROOT`. Path traversal-атаки блокируются.
- **Санитизация text**: сервер экранирует HTML-сущности в `text` перед вставкой в `<div class="message message-agent">`.
- **CSP-заголовки**: `app.html` отдаётся с Content-Security-Policy, ограничивающим источники скриптов.
- **CSRF-защита**: `clientSecret` обязателен для всех мутирующих запросов, проверяется на сервере.
- **ui-скрипт — доверенный код**: исполняется в контексте страницы. LLM считается доверенным источником. Пользовательский ввод в `ui`-скриптах должен экранироваться самой LLM.

---

## 10. Известные ограничения

- **JSON-экранирование в ui**: HTML-шаблоны внутри JSON-строки требуют экранирования кавычек, что повышает риск ошибок при генерации LLM. В будущем — поддержка base64-кодированного `ui` или многострочных строк.
- **Одновременные запросы**: клиент должен блокировать отправку, пока `thinking === true`. Сервер дополнительно ставит запросы в очередь.

---

## 11. План

### Этап 1: Ядро (2 недели)
- Сервер: роуты, БД, конфигурация
- `index.html` + `chat-list.js` (главная страница)
- `runtime.js`
- `bridge.js`
- `default-chat.js`
- `app.html`

### Этап 2: Протокол (1 неделя)
- `/body` handler
- `/chat/stream` handler
- Парсер JSON-ответа LLM
- Fallback

### Этап 3: Интеграция (1 неделя)
- Системный промпт для LLM (`llm-prompt.md`)
- Cypress-тесты

### Этап 4: Полировка (1 неделя)
- sessionStorage для UI-состояния
- Анимации
- Крайние случаи

---

## 12. Инструменты разработки

### Линтер и форматирование

- **ESLint** — статический анализ `.ts` и `.js` файлов, поиск ошибок и неиспользуемого кода.
- **Prettier** — автоформатирование, единый стиль кода.

Конфигурация:

```
.eslintrc.json     — правила ESLint (+ @typescript-eslint)
.prettierrc        — настройки Prettier
```

Скрипты в `package.json`:

```json
{
  "scripts": {
    "lint": "eslint 'src/**/*.{ts,js}'",
    "lint:fix": "eslint 'src/**/*.{ts,js}' --fix",
    "format": "prettier --write 'src/**/*.{ts,js,json,css,html}'",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm run lint"
  }
}
```

### Проверки перед коммитом

- `npm run check` → `tsc --noEmit` + `eslint` — обязательно перед PR.
- Линтер и typecheck должны проходить чисто, без warnings и errors.
- В будущем — pre-commit hook через `husky` + `lint-staged`.
