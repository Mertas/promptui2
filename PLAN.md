# PromptUI2 — Пошаговый план разработки

---

## 1. Инициализация проекта

- [x] `package.json` — имя, скрипты (dev, build, lint, typecheck, check)
- [x] `tsconfig.json` — target ES2022, module NodeNext, strict
- [x] `eslint.config.js` — TypeScript-правила (flat config)
- [x] `.prettierrc` — форматирование
- [x] `.env` — порт, БД, API-ключ, модель, таймаут
- [x] Установка зависимостей: `express`, `ws`, `better-sqlite3`, `uuid`, `dotenv`, `openai`
- [x] Установка dev-зависимостей: `typescript`, `tsx`, `esbuild`, `eslint`, `prettier`, `@types/*`
- [x] Структура папок: `src/server/`, `src/client/`, `src/db/`, `data/`, `dist/client/`

## 2. База данных

- [x] `src/db/schema.ts` — SQL-схема: `chats`, `clients`, `llm_messages`, `forks` + индексы
- [x] `src/db/index.ts` — singleton, WAL, foreign_keys

## 3. Сервер — ядро

- [x] `src/server/index.ts` — Express + HTTP-сервер, WS-сервер, все роуты
- [x] `src/server/config.ts` — загрузка `.env`
- [x] `src/server/ws.ts` — WebSocket: подписки с chatId, scoped broadcast

## 4. Сервер — роуты

- [x] `GET /` → `index.html`
- [x] `GET /chat/:id` → `app.html` (с `__INITIAL_MESSAGES__`)
- [x] `GET /chat/:id/messages` → JSON replay
- [x] `GET /api/runtime.js` → `dist/client/runtime.js`
- [x] `GET /api/bridge.js` → `dist/client/bridge.js`
- [x] `GET /api/default-chat.js` → `dist/client/default-chat.js`
- [x] `GET /api/chat-list.js` → `dist/client/chat-list.js`
- [x] `GET /api/chats` → JSON: список чатов с превью
- [x] `POST /api/chats` → создать чат, вернуть `{ id, clientId, clientSecret }`
- [x] `POST /chat/:id/prompt` → обработка промпта + вызов LLM (async)
- [x] `POST /chat/:id/undo` → удалить последнюю пару сообщений
- [x] `POST /chat/:id/snapshot` → форк чата

## 5. Сервер — LLM-клиент

- [x] `src/server/llm.ts` — вызов DeepSeek API (stream, timeout)
- [x] Парсинг JSON-ответа: `text` + `ui` (прямой парсинг → code block → regex)
- [x] Broadcast: user bubble → thinking → stream → update → done
- [x] Fallback при ошибках LLM (невалидный JSON, отсутствует text)

## 6. Файловая система

- [x] `GET /api/fs/ls` — список файлов в виртуальной ФС
- [x] `GET /api/fs/read` — чтение файла
- [x] `POST /api/fs/write` — запись файла
- [x] `POST /api/fs/mkdir` — создание папки
- [x] Sandbox: `safePath()` — проверка на выход за `FS_ROOT`

## 7. Клиент — runtime.ts

- [x] WebSocket connection + reconnect (1с → 2с → ... → 30с)
- [x] Subscription manager: subscribe / unsubscribe / dispatch
- [x] `/body` handler: классификация message / script
- [x] `/chat/stream` handler: thinking / chunk / done

## 8. Клиент — bridge.ts

- [x] `PromptUI.messages` — get, on('add'), on('thinking'), send, undo, snapshot, thinking, clientId
- [x] `PromptUI.ui` — set, append, activateScripts
- [x] `PromptUI.fs` — ls, read, write, mkdir
- [x] DOM helpers: el, $, $$, on, append, clear
- [x] Initial messages from `window.__INITIAL_MESSAGES__`

## 9. Клиент — default-chat.ts

- [x] Эталонная реализация чата из README
- [x] Стили, рендеринг сообщений, отправка, thinking, undo/snapshot, меню

## 10. Клиент — chat-list.ts

- [x] Список чатов: фетч `/api/chats`, рендеринг карточек
- [x] Создание нового чата + сохранение credentials в localStorage
- [x] esc (XSS-защита), ago (время)

## 11. Страницы

- [x] `index.html` — генерируется сервером, загружает chat-list.js
- [x] `app.html` — генерируется сервером, preloads initial messages

## 12. Линтер и проверки

- [x] `npm run check` — ошибок нет
- [x] `npm run lint` — ошибок нет
- [x] `npm run typecheck` — ошибок нет
- [x] `npm run build:client` — сборка esbuild

## 13. Тесты

- [ ] Cypress: e2e-тесты главной страницы
- [ ] Cypress: e2e-тесты чата (отправка, стриминг, undo, snapshot)

## 14. Полировка

- [ ] sessionStorage для сохранения UI-состояния
- [ ] Анимации переходов
- [ ] Крайние случаи: пустой чат, потеря соединения, таймаут LLM
