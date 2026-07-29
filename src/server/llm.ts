import OpenAI from 'openai';
import { getDb } from '../db/index.js';
import { DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, LLM_TIMEOUT_MS } from './config.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { LlmMessage } from '../db/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const openai = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: DEEPSEEK_BASE_URL,
  timeout: LLM_TIMEOUT_MS,
});

interface LlmResponse {
  text?: string;
  ui?: string;
  patch?: {
    html?: Record<string, string>;
    css?: string;
    exec?: string;
  };
}

type Broadcaster = (type: string, data: unknown) => void;

const activeRequests = new Map<string, AbortController>();

export function stopGeneration(chatId: string): void {
  const ctrl = activeRequests.get(chatId);
  if (ctrl) {
    ctrl.abort();
    activeRequests.delete(chatId);
  }
}

export function isProcessing(chatId: string): boolean {
  return activeRequests.has(chatId);
}

function getSystemPrompt(): string {
  const promptPath = resolve(__dirname, '..', '..', 'llm-prompt.md');
  if (existsSync(promptPath)) {
    return readFileSync(promptPath, 'utf-8');
  }
  return 'You are a helpful assistant. Use ASD-STE100.';
}

function buildMessageHistory(chatId: string): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const db = getDb();
  const messages = db
    .prepare(
      `SELECT role, content FROM (
        SELECT role, content, created_at FROM llm_messages
        WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?
      ) ORDER BY created_at ASC`,
    )
    .all(chatId, 40) as Pick<LlmMessage, 'role' | 'content'>[];

  const history: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: getSystemPrompt() },
  ];

  for (const msg of messages) {
    history.push({
      role: msg.role === 'agent' ? 'assistant' : (msg.role as 'system' | 'user'),
      content: msg.content,
    });
  }

  return history;
}

export function parseLlmResponse(raw: string): LlmResponse | null {
  let text = raw.trim();

  // Strip surrounding markdown code block ```
  text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');

  // Direct JSON parse
  try { return JSON.parse(text) as LlmResponse; } catch { /* continue */ }

  // Find balanced JSON object, sanitize literal newlines in strings, then parse
  const startIdx = text.indexOf('{');
  if (startIdx !== -1) {
    let endIdx = -1;
    let depth = 0, inString = false, escaped = false;
    for (let i = startIdx; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { endIdx = i; break; }
        }
      }
    }

    if (endIdx !== -1) {
      // Sanitize: escape literal newlines inside JSON strings
      let sanitized = '';
      inString = false; escaped = false;
      for (let i = startIdx; i <= endIdx; i++) {
        const ch = text[i];
        if (escaped) { sanitized += ch; escaped = false; continue; }
        if (ch === '\\') { sanitized += ch; escaped = true; continue; }
        if (ch === '"') { sanitized += ch; inString = !inString; continue; }
        if (inString && ch === '\n') { sanitized += '\\n'; continue; }
        if (inString && ch === '\r') { sanitized += '\\r'; continue; }
        if (inString && ch === '\t') { sanitized += '\\t'; continue; }
        sanitized += ch;
      }
      try { return JSON.parse(sanitized) as LlmResponse; } catch { /* still broken, fall through */ }
    }
  }

  // Fallback: extract "text" and "ui" fields manually
  // First try to extract "text" with standard regex
  const textMatch = text.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!textMatch) return null;

  const result: LlmResponse = { text: JSON.parse(`"${textMatch[1]}"`) as string };

  // Extract "ui" field — search for "</script>" pattern to find true end
  const uiKeyIdx = text.indexOf('"ui"');
  if (uiKeyIdx !== -1) {
    const colonIdx = text.indexOf(':', uiKeyIdx);
    if (colonIdx !== -1) {
      const valStart = text.indexOf('"', colonIdx);
      if (valStart !== -1) {
        // Search backwards from the end for "</script>" followed by optional whitespace and a closing quote
        // This is more reliable than scanning forward through unescaped quotes in template literals
        const scriptEnd = text.lastIndexOf('</script>');
        if (scriptEnd > valStart) {
          // Find the closing " after </script>
          const afterScript = text.indexOf('"', scriptEnd + 9);
          if (afterScript !== -1) {
            const uiVal = text.substring(valStart + 1, afterScript);
            try {
              result.ui = JSON.parse(
                '"' + uiVal.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"',
              ) as string;
            } catch { /* ignore */ }
          }
        }

        // If </script> approach didn't work, fall back to simple scan (breaks on first ")
        if (!result.ui) {
          let uiVal = '';
          let esc = false;
          for (let i = valStart + 1; i < text.length; i++) {
            const ch = text[i];
            if (esc) { uiVal += ch; esc = false; continue; }
            if (ch === '\\') { uiVal += ch; esc = true; continue; }
            if (ch === '"') break;
            uiVal += ch;
          }
          try {
            result.ui = JSON.parse(`"${uiVal.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`) as string;
          } catch { /* ignore */ }
        }
      }
    }
  }

  return result;
}

export async function handlePrompt(
  chatId: string,
  prompt: string,
  emit: Broadcaster,
): Promise<void> {
  const db = getDb();

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    emit('done', null);
    return;
  }

  // Save user message to DB immediately
  db.prepare('INSERT INTO llm_messages (chat_id, role, content) VALUES (?, ?, ?)').run(chatId, 'user', prompt);
  updateChatTitle(chatId, prompt);

  // Broadcast user bubble
  emit('user-bubble', `<div class="message message-user">${escapeHtml(prompt)}</div>`);

  // Set thinking = true
  db.prepare('UPDATE chats SET thinking = 1 WHERE id = ?').run(chatId);

  const aborter = new AbortController();
  activeRequests.set(chatId, aborter);

  emit('thinking', true);

  let fullResponse = '';

  try {
    const messages = buildMessageHistory(chatId);
    messages.push({ role: 'user', content: prompt });

    const stream = await openai.chat.completions.create(
      {
        model: DEEPSEEK_MODEL,
        messages,
        stream: true,
      },
      { signal: aborter.signal },
    );

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        fullResponse += delta;
        emit('stream', delta);
      }
    }

    // Save raw request + response for diagnostics
    db.prepare('INSERT INTO llm_logs (chat_id, request, response) VALUES (?, ?, ?)').run(
      chatId,
      JSON.stringify(messages),
      fullResponse,
    );

    const parsed = parseLlmResponse(fullResponse);
    console.log('[LLM] parsed:', parsed ? `text=${parsed.text?.slice(0,40)} ui=${parsed.ui ? 'present' : 'none'}` : 'null');

    if (!parsed || !parsed.text) {
      const text = fullResponse.trim() || 'No response was generated.';

      db.prepare('INSERT INTO llm_messages (chat_id, role, content) VALUES (?, ?, ?)').run(chatId, 'agent', text);

      emit('update', `<div class="message message-agent">${escapeHtml(text)}</div>`);
      emit('done', null);
      return;
    }

    const text = parsed.text;
    const ui = parsed.ui || null;
    const patch = parsed.patch || null;

    db.prepare('INSERT INTO llm_messages (chat_id, role, content, ui, patch) VALUES (?, ?, ?, ?, ?)').run(
      chatId, 'agent', text, ui,
      patch ? JSON.stringify(patch) : null,
    );

    const agentHtml = `<div class="message message-agent">${escapeHtml(text)}</div>`;
    emit('update', agentHtml);

    if (ui) emit('update', ui);
    if (patch) emit('update', JSON.stringify({ path: '/body', type: 'patch', data: patch }));

    emit('done', null);
  } catch (err) {
    // Save raw request + partial response for diagnostics
    try {
      const messages = buildMessageHistory(chatId);
      messages.push({ role: 'user', content: prompt });
      db.prepare('INSERT INTO llm_logs (chat_id, request, response) VALUES (?, ?, ?)').run(
        chatId,
        JSON.stringify(messages),
        fullResponse || String(err),
      );
    } catch { /* log failure is non-critical */ }

    if (aborter.signal.aborted) {
      const partial = fullResponse.trim();
      if (partial) {
        db.prepare('INSERT INTO llm_messages (chat_id, role, content) VALUES (?, ?, ?)').run(chatId, 'agent', partial);
        emit('update', `<div class="message message-agent">${escapeHtml(partial)}</div>`);
      }
      emit('done', null);
    } else {
      console.error('LLM error:', err);
      emit('fallback', null);
    }
  } finally {
    activeRequests.delete(chatId);
    db.prepare('UPDATE chats SET thinking = 0 WHERE id = ?').run(chatId);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updateChatTitle(chatId: string, userPrompt: string): void {
  const db = getDb();
  const { count } = db
    .prepare('SELECT COUNT(*) as count FROM llm_messages WHERE chat_id = ? AND role IN (?, ?)')
    .get(chatId, 'user', 'agent') as { count: number };

  if (count <= 2) {
    const title = userPrompt.slice(0, 60) + (userPrompt.length > 60 ? '...' : '');
    db.prepare('UPDATE chats SET title = ? WHERE id = ? AND title = ?').run(title, chatId, 'New Chat');
  }
}
