import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';

type Subscriber = {
  ws: WebSocket;
  chatId: string;
  path: string;
};

const subscribers: Subscriber[] = [];
let onReplay: ((chatId: string, path: string) => string | null) | null = null;

export function setReplayHandler(handler: (chatId: string, path: string) => string | null): void {
  onReplay = handler;
}

function extractChatId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const match = url.match(/\/chat\/([^/]+)\/socket/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function setupWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const chatId = extractChatId(req.url) || 'unknown';

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe' && msg.path) {
          // Remove old subscription for this ws+path, keep other paths
          for (let i = subscribers.length - 1; i >= 0; i--) {
            if (subscribers[i].ws === ws && subscribers[i].path === msg.path) {
              subscribers.splice(i, 1);
            }
          }
          subscribers.push({ ws, chatId, path: msg.path });

          // Replay existing data for reconnect
          if (onReplay) {
            const replay = onReplay(chatId, msg.path);
            if (replay && ws.readyState === WebSocket.OPEN) {
              ws.send(replay);
            }
          }
        }
      } catch {
        // ignore
      }
    });

    ws.on('close', () => {
      for (let i = subscribers.length - 1; i >= 0; i--) {
        if (subscribers[i].ws === ws) {
          subscribers.splice(i, 1);
        }
      }
    });
  });
}

export function broadcast(chatId: string, path: string, data: string): void {
  let sent = 0;
  for (const sub of subscribers) {
    if (sub.chatId === chatId && sub.path === path && sub.ws.readyState === WebSocket.OPEN) {
      try {
        sub.ws.send(data);
        sent++;
      } catch {
        // connection closed mid-send
      }
    }
  }
  if (sent === 0) {
    console.log(`[WS] broadcast to ${chatId}${path}: no subscribers (total subs: ${subscribers.length})`);
  }
}

export function hasSubscribers(chatId: string, path: string): boolean {
  return subscribers.some(
    (s) => s.chatId === chatId && s.path === path && s.ws.readyState === WebSocket.OPEN,
  );
}
