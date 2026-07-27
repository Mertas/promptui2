// default-chat.ts — reference chat interface, uses PromptUI API

const { el, $, on, append } = window.PromptUI;

window.PromptUI.ui.set(`
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui; background: #1a1a2e; color: #eee; margin: 0; height: 100vh; display: flex; flex-direction: column; }
    #chat { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
    .msg { max-width: 80%; padding: 8px 12px; border-radius: 12px; word-break: break-word; }
    .msg-user { align-self: flex-end; background: #e94560; }
    .msg-agent { align-self: flex-start; background: #16213e; }
    .streaming { opacity: 0.8; }
    .streaming::after { content: '\u25a0'; animation: blink 0.8s infinite; margin-left: 2px; }
    .thinking-dots { opacity: 0.7; }
    .thinking-dots span { animation: dotBounce 1.2s infinite; }
    .thinking-dots span:nth-child(1) { animation-delay: 0s; }
    .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
    .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes blink { 50% { opacity: 0; } }
    @keyframes dotBounce { 0%, 60%, 100% { opacity: 0.2; } 30% { opacity: 1; } }
    #toolbar { display: flex; gap: 8px; padding: 12px; background: #0f0f23; align-items: flex-end; }
    #input { flex: 1; padding: 8px 12px; border: none; border-radius: 8px; background: #1a1a2e; color: #eee; resize: none; min-height: 38px; max-height: 120px; overflow-y: auto; line-height: 1.4; font-family: inherit; font-size: 14px; }
    #input:focus { outline: 2px solid #e94560; outline-offset: -2px; }
    .tool-btn { padding: 8px 14px; border: none; border-radius: 8px; color: #fff; cursor: pointer; font-size: 14px; line-height: 1; min-height: 38px; }
    .tool-btn:hover { opacity: 0.85; }
    #send { background: #e94560; }
    #menu-btn { background: #16213e; }
    #menu { position: relative; }
    #menu-drop { display: none; position: absolute; bottom: calc(100% + 8px); right: 0; background: #1a1a2e; border: 1px solid #2a2a4e; border-radius: 8px; padding: 4px; min-width: 120px; z-index: 100; }
    .menu-item { display: block; width: 100%; padding: 8px 12px; border: none; background: none; color: #eee; cursor: pointer; text-align: left; border-radius: 6px; font-size: 13px; font-family: inherit; }
    .menu-item:hover { background: #e94560; }
  </style>
  <div id="chat"></div>
  <div id="toolbar">
    <textarea id="input" placeholder="Type a message" rows="1"></textarea>
    <button id="send" class="tool-btn">\u25b6</button>
    <div id="menu">
      <button id="menu-btn" class="tool-btn">\u00b7\u00b7\u00b7</button>
      <div id="menu-drop">
        <button class="menu-item" id="undo-btn">\u21a9 Undo</button>
        <button class="menu-item" id="snapshot-btn">\ud83d\udccb Snapshot</button>
      </div>
    </div>
  </div>
`);
window.PromptUI.ui.activateScripts(document.body);

// Messages
const chat = $('#chat') as Element;
let pendingBubble: HTMLElement | null = null;

function render(msg: { role: string; text: string }): HTMLElement {
  return el('div', { class: `msg msg-${msg.role}` }, msg.text);
}

function createThinkingBubble(): HTMLElement {
  return el('div', { class: 'msg msg-agent thinking-dots' },
    el('span', '\u25cf'),
    el('span', '\u25cf'),
    el('span', '\u25cf'),
  );
}

function removePendingBubble(): void {
  if (pendingBubble) {
    pendingBubble.remove();
    pendingBubble = null;
  }
}

const msgs = window.PromptUI.messages.get();
for (const m of msgs) append(chat, render(m));
scrollBottom();

window.PromptUI.messages.on('add', (m) => {
  removePendingBubble();
  append(chat, render(m as { role: string; text: string }));
  scrollBottom();
});

// Stream handling
window.PromptUI.messages.on('stream', (chunk) => {
  const chunkStr = chunk as string;
  if (chunkStr === '') {
    removePendingBubble();
    return;
  }
  if (pendingBubble && pendingBubble.classList.contains('thinking-dots')) {
    // Replace dots with real text
    pendingBubble.remove();
    pendingBubble = null;
  }
  if (!pendingBubble) {
    pendingBubble = el('div', { class: 'msg msg-agent streaming' }, chunkStr);
    append(chat, pendingBubble);
  } else {
    pendingBubble.textContent = (pendingBubble.textContent || '') + chunkStr;
  }
  scrollBottom();
});

window.PromptUI.messages.on('thinking', (v) => {
  sendBtn.textContent = v ? '\u25a0' : '\u25b6';
  if (v) {
    if (!pendingBubble) {
      pendingBubble = createThinkingBubble();
      append(chat, pendingBubble);
      scrollBottom();
    }
  } else {
    // Only remove if it's still a thinking dots (not streaming text)
    if (pendingBubble && pendingBubble.classList.contains('thinking-dots')) {
      removePendingBubble();
    }
  }
});

function scrollBottom() {
  chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' });
}

// Send
const input = $('#input') as HTMLTextAreaElement;
const sendBtn = $('#send') as HTMLButtonElement;

// Initial thinking state
if (window.PromptUI.messages.thinking) {
  sendBtn.textContent = '\u25a0';
  pendingBubble = createThinkingBubble();
  append(chat, pendingBubble);
  scrollBottom();
}

function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

input.addEventListener('input', autoResize);

on(sendBtn, 'click', () => {
  const text = input.value.trim();
  if (text) window.PromptUI.messages.send(text);
  input.value = '';
  input.style.height = 'auto';
});

on(input, 'keydown', (e: Event) => {
  const ke = e as KeyboardEvent;
  if (ke.key === 'Enter' && !ke.shiftKey) {
    ke.preventDefault();
    sendBtn.click();
  }
});

// Menu
const menuDrop = $('#menu-drop') as HTMLElement;

on('#menu-btn', 'click', (e: Event) => {
  e.stopPropagation();
  const isOpen = menuDrop.style.display === 'block';
  menuDrop.style.display = isOpen ? 'none' : 'block';
});

on('#undo-btn', 'click', () => { menuDrop.style.display = 'none'; window.PromptUI.messages.undo(); });
on('#snapshot-btn', 'click', () => { menuDrop.style.display = 'none'; window.PromptUI.messages.snapshot(); });
on(document, 'click', (e: Event) => {
  if (!(e.target as Element).closest('#menu')) menuDrop.style.display = 'none';
});
