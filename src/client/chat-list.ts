// chat-list.ts — main page with list of all chats

interface ChatPreview {
  id: string;
  title: string;
  lastMessage: string | null;
  lastRole: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

(async () => {
  const chats: ChatPreview[] = await fetch('/api/chats').then((r) => r.json());

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

  const list = document.getElementById('chat-list')!;

  if (chats.length === 0) {
    list.innerHTML = '<div class="empty">No chats. Click "New Chat" to start.</div>';
  } else {
    for (const c of chats) {
      const card = document.createElement('a');
      card.className = 'chat-card';
      card.href = `/chat/${c.id}`;
      card.innerHTML = `
        <div class="chat-title">${esc(c.title)}</div>
        <div class="chat-preview">${esc(c.lastMessage ?? 'No messages')}</div>
        <div class="chat-meta">
          <span>${c.messageCount} messages</span>
          <span>${ago(c.updatedAt)}</span>
        </div>
      `;
      list.appendChild(card);
    }
  }

  document.getElementById('new-chat')!.onclick = async () => {
    const res = await fetch('/api/chats', { method: 'POST' });
    const data = (await res.json()) as { id: string; clientId: string; clientSecret: string };
    localStorage.setItem(`pui2_clientId_${data.id}`, data.clientId);
    localStorage.setItem(`pui2_secret_${data.id}`, data.clientSecret);
    location.href = `/chat/${data.id}`;
  };

  function esc(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function ago(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
})();
