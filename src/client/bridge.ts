// bridge.ts — PromptUI API: messages, filesystem, UI, DOM helpers

interface PromptUIMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  timestamp: number;
}

interface PromptUIMessages {
  get(): PromptUIMessage[];
  on(event: 'add' | 'thinking' | 'stream', fn: (arg: PromptUIMessage | boolean | string) => void): () => void;
  send(text?: string): Promise<boolean> | boolean;
  undo(): Promise<Response>;
  snapshot(): Promise<{ id: string; clientId: string; clientSecret: string }>;
  get thinking(): boolean;
  get clientId(): string;
}

interface PatchData {
  html?: Record<string, string>;
  css?: string;
  exec?: string;
}

interface PromptUIUi {
  set(html: string): void;
  append(html: string): void;
  activateScripts(container?: Element): void;
  patch(data: PatchData): void;
}

interface FileItem {
  name: string;
  isDirectory: boolean;
  size: number;
  modified: number;
}

interface PromptUIFs {
  ls(path: string): Promise<{ path: string; items: FileItem[] }>;
  read(path: string): Promise<{ path: string; content: string; size: number }>;
  write(path: string, content: string): Promise<{ path: string; written: number }>;
  mkdir(path: string): Promise<{ path: string; created: boolean }>;
}

interface PromptUI {
  messages: PromptUIMessages;
  ui: PromptUIUi;
  fs: PromptUIFs;
  el: (tag: string, attrs?: Record<string, unknown> | string, ...children: unknown[]) => HTMLElement;
  $: (sel: string, ctx?: Element | Document) => Element | null;
  $$: (sel: string, ctx?: Element | Document) => Element[];
  on: (target: string | Element, event: string, arg2: string | ((e: Event) => void), arg3?: (e: Event, el: Element) => void) => void;
  append: (parent: Element, ...children: (Node | string)[]) => void;
  clear: (el: Element) => void;
}

declare global {
  interface Window {
    __CHAT_ID__: string;
    __CHAT_THINKING__: boolean;
    __INITIAL_MESSAGES__: { id: string; role: string; text: string; timestamp: number }[];
    __runtime_subscribe: (path: string, handler: (content: string) => void) => void;
    __messagesAdd: (html: string) => void;
    __messagesRemove: (agentId: number | null, userId: number | null) => void;
    __pui2_setCredentials: (clientId: string, clientSecret: string) => void;
    __puiBooted?: boolean;
    PromptUI: PromptUI;
  }
}

const CHAT_ID = window.__CHAT_ID__;
const CLIENT_ID = localStorage.getItem(`pui2_clientId_${CHAT_ID}`) || '';
const CLIENT_SECRET = localStorage.getItem(`pui2_secret_${CHAT_ID}`) || '';

const _messages: PromptUIMessage[] = [];
const _listeners: {
  add: ((msg: PromptUIMessage) => void)[];
  thinking: ((v: boolean) => void)[];
  stream: ((chunk: string) => void)[];
} = {
  add: [],
  thinking: [],
  stream: [],
};
let _thinking = false;

// Loading indicator — shown until first ui.set() replaces the body
(function showLoader() {
  if (document.body.querySelector('#pui2-loader')) return;
  const loader = document.createElement('div');
  loader.id = 'pui2-loader';
  loader.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0a0a14;z-index:999999;color:#7a7d90;font-family:system-ui,sans-serif;font-size:14px;';
  loader.innerHTML = '<div style="text-align:center"><div style="margin-bottom:12px;font-size:28px">◇</div><div>Loading...</div></div>';
  document.body.appendChild(loader);
})();

window.__pui2_setCredentials = (clientId: string, clientSecret: string): void => {
  localStorage.setItem(`pui2_clientId_${CHAT_ID}`, clientId);
  localStorage.setItem(`pui2_secret_${CHAT_ID}`, clientSecret);
};

// ─── Messages ──────────────────────────────────────────────

window.__messagesAdd = (html: string): void => {
  const div = document.createElement('div');
  div.innerHTML = html;
  const msgEls = div.querySelectorAll('.message');
  if (msgEls.length === 0) return;

  for (const msgEl of msgEls) {
    const isUser = msgEl.classList.contains('message-user');
    const isAgent = msgEl.classList.contains('message-agent');
    const text = msgEl.textContent || '';

    const msg: PromptUIMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      role: isUser ? 'user' : isAgent ? 'agent' : 'system',
      text,
      timestamp: Date.now(),
    };

    if (_messages.find((m) => m.text === text && m.role === msg.role)) continue;

    _messages.push(msg);
    // Fire registered listeners
    for (const fn of _listeners.add) {
      try { fn(msg); } catch { /* old handler, detached DOM */ }
    }
    // Safety net: if no listeners registered, render directly
    if (_listeners.add.length === 0) {
      renderFallback(msg);
    }
  }
};

window.__messagesRemove = (agentId: number | null, userId: number | null): void => {
  // Remove last agent and user from internal array + DOM
  if (agentId !== null) {
    for (let i = _messages.length - 1; i >= 0; i--) {
      if (_messages[i].role === 'agent') {
        _messages.splice(i, 1);
        break;
      }
    }
  }
  if (userId !== null) {
    for (let i = _messages.length - 1; i >= 0; i--) {
      if (_messages[i].role === 'user') {
        _messages.splice(i, 1);
        break;
      }
    }
  }

  // Remove last two .msg elements from DOM (skip streaming)
  const msgs = document.querySelectorAll('.msg:not(.streaming)');

  if (msgs.length >= 2) {
    msgs[msgs.length - 1].remove();
    msgs[msgs.length - 2].remove();
  } else if (msgs.length === 1) {
    msgs[0].remove();
  }
};

function renderFallback(msg: PromptUIMessage): void {
  const container = document.querySelector('#chat') || document.querySelector('.msg-container') || document.body;
  if (!container) return;
  const div = document.createElement('div');
  div.className = `msg msg-${msg.role}`;
  div.textContent = msg.text;
  div.style.cssText = 'max-width:80%;padding:8px 12px;border-radius:12px;margin:4px 16px;' +
    (msg.role === 'user'
      ? 'align-self:flex-end;background:#e94560;color:#fff;margin-left:auto;'
      : 'align-self:flex-start;background:#16213e;color:#eee;');
  container.appendChild(div);
  container.scrollTo?.({ top: container.scrollHeight, behavior: 'smooth' });
}

const messages: PromptUIMessages = {
  get() {
    return _messages.slice();
  },

  on(event, fn) {
    if (event === 'add') {
      _listeners.add.push(fn as (msg: PromptUIMessage) => void);
    } else if (event === 'thinking') {
      _listeners.thinking.push(fn as (v: boolean) => void);
    } else if (event === 'stream') {
      _listeners.stream.push(fn as (chunk: string) => void);
    }
    return () => {
      const list = _listeners[event];
      const idx = list.indexOf(fn as never);
      if (idx !== -1) list.splice(idx, 1);
    };
  },

  send(text?: string) {
    if (_thinking) {
      return fetch(`/chat/${CHAT_ID}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
      }).then(() => true);
    }
    if (!text) return false as unknown as Promise<boolean>;
    return fetch(`/chat/${CHAT_ID}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, prompt: text }),
    }).then(() => true);
  },

  undo() {
    return fetch(`/chat/${CHAT_ID}/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    });
  },

  snapshot() {
    return fetch(`/chat/${CHAT_ID}/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    })
      .then((r) => r.json())
      .then((data: { id: string; clientId: string; clientSecret: string }) => {
        window.__pui2_setCredentials(data.clientId, data.clientSecret);
        location.href = `/chat/${data.id}`;
        return data;
      });
  },

  get thinking() {
    return _thinking;
  },

  get clientId() {
    return CLIENT_ID;
  },
};

// ─── UI ─────────────────────────────────────────────────────

const ui: PromptUIUi = {
  set(html) {
    // Clear old add listeners — their DOM refs are stale after set()
    _listeners.add.length = 0;
    document.body.innerHTML = html;
    window.__puiBooted = true;
  },
  append(html) {
    if (!document.body) return;
    const t = document.createElement('template');
    t.innerHTML = html;
    while (t.content.firstChild) document.body.appendChild(t.content.firstChild);
  },
  activateScripts(container) {
    const ctx = container || document;
    for (const old of ctx.querySelectorAll('script')) {
      const src = old.textContent || '';
      try { new Function(src); } catch (syntaxErr) {
        console.error('[bridge] UI script syntax error:', syntaxErr);
        showScriptError((syntaxErr as Error).message, src.slice(0, 200));
        old.replaceWith(document.createComment('broken script'));
        continue;
      }
      const ns = document.createElement('script');
      for (const { name, value } of old.attributes) ns.setAttribute(name, value);
      ns.textContent = `(function(){${src}})();`;
      old.replaceWith(ns);
    }
  },
  patch(data) {
    if (data.html) {
      for (const [selector, innerHTML] of Object.entries(data.html)) {
        const el = document.querySelector(selector);
        if (!el) {
          console.warn('[bridge] patch: selector not found:', selector);
          continue;
        }
        // Warn if clearing a container with children — likely a mistake
        if (innerHTML === '' && el.children.length > 0) {
          console.warn('[bridge] patch: clearing non-empty container', selector, '— this destroys', el.children.length, 'child elements. Did you mean to clear this?');
        }
        el.innerHTML = innerHTML;
      }
    }
    if (data.css) {
      let style = document.getElementById('pui2-patch') as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement('style');
        style.id = 'pui2-patch';
        document.head.appendChild(style);
      }
      style.textContent = (style.textContent || '') + '\n' + data.css;
    }
    if (data.exec) {
      try { new Function(data.exec)(); } catch (e) {
        console.error('[bridge] patch exec error:', e);
      }
    }
  },
};

// ─── Filesystem ─────────────────────────────────────────────

const fs: PromptUIFs = {
  ls(path) {
    return fetch(`/api/fs/ls?path=${encodeURIComponent(path)}&chatId=${encodeURIComponent(CHAT_ID)}`).then((r) => r.json());
  },
  read(path) {
    return fetch(`/api/fs/read?path=${encodeURIComponent(path)}&chatId=${encodeURIComponent(CHAT_ID)}`).then((r) => r.json());
  },
  write(path, content) {
    return fetch('/api/fs/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content, chatId: CHAT_ID }),
    }).then((r) => r.json());
  },
  mkdir(path) {
    return fetch('/api/fs/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, chatId: CHAT_ID }),
    }).then((r) => r.json());
  },
};

// ─── DOM helpers ────────────────────────────────────────────

const el = (tag: string, attrs?: Record<string, unknown> | string, ...children: unknown[]): HTMLElement => {
  const e = document.createElement(tag);
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v as string;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'innerHTML') (e as HTMLElement).innerHTML = v as string;
      else if (k === 'textContent') e.textContent = v as string;
      else if (k === 'value') (e as HTMLInputElement).value = v as string;
      else if (k === 'style' && typeof v === 'string') (e as HTMLElement).style.cssText = v as string;
      else if (k === 'disabled') (e as HTMLButtonElement).disabled = !!v;
      else if (k === 'checked') (e as HTMLInputElement).checked = !!v;
      else if (k === 'href') (e as HTMLAnchorElement).href = v as string;
      else if (k === 'src') (e as HTMLImageElement).src = v as string;
      else if (k === 'placeholder') (e as HTMLInputElement).placeholder = v as string;
      else e.setAttribute(k, v as string);
    }
  } else if (attrs !== undefined) {
    children.unshift(attrs);
  }
  for (const c of children) e.append(typeof c === 'string' ? document.createTextNode(c) : (c as Node) ?? '');
  return e;
};

const $ = (sel: string, ctx: Element | Document = document): Element | null => ctx.querySelector(sel);
const $$ = (sel: string, ctx: Element | Document = document): Element[] => [...ctx.querySelectorAll(sel)];

const on = (
  target: string | Element,
  event: string,
  arg2: string | ((e: Event) => void),
  arg3?: (e: Event, el: Element) => void,
): void => {
  const el: Element | null = typeof target === 'string' ? $(target) : target;
  if (!el) return;
  if (typeof arg2 === 'string') {
    el.addEventListener(event, (e) => {
      const match = (e.target as Element).closest(arg2);
      if (match && arg3) arg3(e, match);
    });
  } else {
    el.addEventListener(event, arg2);
  }
};

const append = (parent: Element, ...children: (Node | string)[]): void => {
  if (!parent) return;
  children.forEach((c) => parent.append(c));
};

const clear = (el: Element): void => {
  el.innerHTML = '';
};

// ─── Subscribe to runtime paths ─────────────────────────────

function showScriptError(msg: string, snippet: string): void {
  if (!document.body) return;
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#c0392b;color:#fff;padding:12px 16px;z-index:99999;font:13px/1.4 monospace;white-space:pre-wrap;max-height:50vh;overflow:auto;cursor:pointer;';
  banner.textContent = 'UI Script Error: ' + msg + '\n\n' + snippet;
  banner.onclick = () => banner.remove();
  document.body.insertBefore(banner, document.body.firstChild);
}

window.__runtime_subscribe('/body', (content: string) => {
  try {
    const cmd = JSON.parse(content);
    if (cmd.type === 'undo') {
      window.__messagesRemove(cmd.agentId, cmd.userId);
      return;
    }
    if (cmd.type === 'patch' && cmd.data) {
      PromptUI.ui.patch(cmd.data as PatchData);
      return;
    }
  } catch { /* not JSON */ }

  if (content.includes('<script>')) {
    // Skip replay scripts if UI was already bootstrapped inline
    if (window.__puiBooted) {
      // Still process text bubbles from the replayed content
      const div = document.createElement('div');
      div.innerHTML = content;
      for (const s of div.querySelectorAll('script')) s.remove();
      const htmlOnly = div.innerHTML.trim();
      if (htmlOnly && htmlOnly.includes('<div class="message')) {
        window.__messagesAdd(htmlOnly);
      }
      return;
    }
    const div = document.createElement('div');
        div.innerHTML = content;
        const scripts = div.querySelectorAll('script');
        for (const s of scripts) {
          const src = s.textContent || '';
          try { new Function(src); } catch (syntaxErr) {
            console.error('[bridge] UI script syntax error:', syntaxErr);
            showScriptError((syntaxErr as Error).message, src.slice(0, 200));
            s.remove();
            continue;
          }
          if (!document.body) { s.remove(); continue; }
          try {
            const ns = document.createElement('script');
            ns.textContent = `(function(){${src}})();`;
            document.body.appendChild(ns);
      } catch (e) {
        console.error('[bridge] script exec error:', e);
      }
      s.remove();
    }
    const htmlOnly = div.innerHTML.trim();
    if (htmlOnly && htmlOnly.includes('<div class="message')) {
      window.__messagesAdd(htmlOnly);
    }
    return;
  }

  if (content.includes('<div class="message')) {
    window.__messagesAdd(content);
  }
});

window.__runtime_subscribe('/chat/stream', (data: string) => {
  let parsed = data;
  try {
    parsed = JSON.parse(data);
  } catch {
    // keep as string
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { type: string; value?: boolean; content?: string };
    if (obj.type === 'thinking') {
      _thinking = obj.value ?? false;
      for (const fn of _listeners.thinking) fn(_thinking);
    } else if (obj.type === 'chunk' && obj.content) {
      for (const fn of _listeners.stream) fn(obj.content);
    } else if (obj.type === 'done') {
      _thinking = false;
      for (const fn of _listeners.thinking) fn(false);
      for (const fn of _listeners.stream) fn('');
    }
  }
});

window.__runtime_subscribe('/page/reload', () => {
  location.reload();
});

// ─── Expose ─────────────────────────────────────────────────

window.PromptUI = { messages, ui, fs, el, $, $$, on, append, clear };

// ─── Populate initial messages from server ──────────────────

if (window.__INITIAL_MESSAGES__) {
  for (const m of window.__INITIAL_MESSAGES__) {
    _messages.push(m as PromptUIMessage);
  }
}

// ─── Restore thinking state (synchronous, before UI runs) ───

if (window.__CHAT_THINKING__) {
  _thinking = true;
}
