// runtime.ts — WebSocket connection, subscription manager, message dispatch

const CHAT_ID = (window as Record<string, unknown>).__CHAT_ID__ as string;
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/chat/${CHAT_ID}/socket`;

const subscriptions: Record<string, (content: string) => void> = {};
let ws: WebSocket | null = null;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connect(): void {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    reconnectDelay = 1000;
    for (const path of Object.keys(subscriptions)) {
      ws!.send(JSON.stringify({ type: 'subscribe', path }));
    }
  };

  ws.onmessage = (event: MessageEvent) => {
    const raw = event.data as string;

    try {
      const data = JSON.parse(raw);
      if (data.path && subscriptions[data.path]) {
        subscriptions[data.path](raw);
        return;
      }
    } catch { /* not JSON */ }

    if (subscriptions['/body']) {
      subscriptions['/body'](raw);
    }
  };

  ws.onclose = () => {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

(window as Record<string, unknown>).__runtime_subscribe = (
  path: string,
  handler: (content: string) => void,
): void => {
  subscriptions[path] = handler;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'subscribe', path }));
  }
};

connect();
