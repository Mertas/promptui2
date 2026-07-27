import { describe, it, expect } from 'vitest';
import { parseLlmResponse } from './llm.js';

describe('parseLlmResponse', () => {
  // ── Step 1: Markdown stripping ──────────────────────────

  it('parses JSON inside markdown code block with ```json', () => {
    const raw = '```json\n{"text":"hello","ui":"<script>x</script>"}\n```';
    expect(parseLlmResponse(raw)).toEqual({ text: 'hello', ui: '<script>x</script>' });
  });

  it('parses JSON inside markdown code block without language tag', () => {
    const raw = '```\n{"text":"hello"}\n```';
    expect(parseLlmResponse(raw)).toEqual({ text: 'hello' });
  });

  it('parses JSON inside markdown code block on same line', () => {
    const raw = '```json {"text":"hello"}```';
    expect(parseLlmResponse(raw)).toEqual({ text: 'hello' });
  });

  it('parses JSON inside markdown with trailing whitespace', () => {
    const raw = '```json\n{"text":"hello"}\n```\n';
    expect(parseLlmResponse(raw)).toEqual({ text: 'hello' });
  });

  // ── Step 2: Direct JSON ──────────────────────────────────

  it('parses plain JSON with text only', () => {
    const raw = '{"text":"Hello world"}';
    expect(parseLlmResponse(raw)).toEqual({ text: 'Hello world' });
  });

  it('parses plain JSON with text and ui', () => {
    const raw = '{"text":"Built!","ui":"<script>ui.set(\\"<div/>\\")</script>"}';
    expect(parseLlmResponse(raw)).toEqual({
      text: 'Built!',
      ui: '<script>ui.set("<div/>")</script>',
    });
  });

  it('parses JSON with unicode in text', () => {
    const raw = '{"text":"Привет 🌌"}';
    expect(parseLlmResponse(raw)).toEqual({ text: 'Привет 🌌' });
  });

  it('parses JSON with escaped quotes in text', () => {
    const raw = '{"text":"He said \\"hello\\""}';
    expect(parseLlmResponse(raw)).toEqual({ text: 'He said "hello"' });
  });

  // ── Step 3: Sanitized parsing (literal newlines) ─────────

  it('sanitizes literal newlines inside ui string', () => {
    const raw = '{"text":"ok","ui":"<script>\nconsole.log(1)\n</script>"}';
    const result = parseLlmResponse(raw);
    expect(result).toBeTruthy();
    expect(result!.text).toBe('ok');
    expect(result!.ui).toContain('<script>');
    expect(result!.ui).toContain('console.log(1)');
    expect(result!.ui).toContain('</script>');
  });

  it('sanitizes literal newlines in real-world ui response', () => {
    const raw = `{"text":"Windows 95 Chat ready.","ui":"<script>
const { el, $ } = PromptUI;
PromptUI.ui.set(\`<div id='app'></div>\`);
</script>"}`;
    const result = parseLlmResponse(raw);
    expect(result).toBeTruthy();
    expect(result!.text).toBe('Windows 95 Chat ready.');
    expect(result!.ui).toContain('const { el, $ } = PromptUI');
    expect(result!.ui).toContain('PromptUI.ui.set');
  });

  it('sanitizes literal tabs inside ui string', () => {
    const raw = '{"text":"ok","ui":"<script>\tconsole.log(1)\t</script>"}';
    const result = parseLlmResponse(raw);
    expect(result!.ui).toContain('\tconsole.log(1)\t');
  });

  it('sanitizes literal carriage returns', () => {
    const raw = '{"text":"ok","ui":"<script>\r\nconsole.log(1)\r\n</script>"}';
    const result = parseLlmResponse(raw);
    expect(result!.ui).toContain('console.log(1)');
  });

  // ── Step 3: Balanced braces ──────────────────────────────

  it('finds JSON object among surrounding text', () => {
    const raw = 'Some text before {"text":"hello"} and after';
    expect(parseLlmResponse(raw)).toEqual({ text: 'hello' });
  });

  it('handles nested braces in ui value', () => {
    const raw = '{"text":"ok","ui":"<script>function foo() { return 1; }</script>"}';
    const result = parseLlmResponse(raw);
    expect(result!.text).toBe('ok');
    expect(result!.ui).toContain('function foo() { return 1; }');
  });

  it('handles nested objects in ui value', () => {
    const raw = '{"text":"ok","ui":"<script>const x = {a:{b:1}};</script>"}';
    const result = parseLlmResponse(raw);
    expect(result!.text).toBe('ok');
  });

  // ── Step 4: Regex fallback ──────────────────────────────

  it('extracts text even when ui is broken', () => {
    const raw = '{"text":"hello","ui":"<script>broken"json</script>"}';
    const result = parseLlmResponse(raw);
    expect(result).toBeTruthy();
    expect(result!.text).toBe('hello');
  });

  it('extracts text from near-valid JSON', () => {
    const raw = '{"text":"all good","ui":"<script>oops unescaped " quote</script>"}';
    const result = parseLlmResponse(raw);
    expect(result!.text).toBe('all good');
  });

  it('extracts text with escaped backslashes', () => {
    const raw = '{"text":"path\\\\to\\\\file"}';
    expect(parseLlmResponse(raw)).toEqual({ text: 'path\\to\\file' });
  });

  // ── Edge cases ───────────────────────────────────────────

  it('returns null for empty string', () => {
    expect(parseLlmResponse('')).toBeNull();
  });

  it('returns null for whitespace only', () => {
    expect(parseLlmResponse('   \n  ')).toBeNull();
  });

  it('returns null for non-JSON text', () => {
    expect(parseLlmResponse('Hello, how are you?')).toBeNull();
  });

  it('parses JSON without text field (caller handles validation)', () => {
    expect(parseLlmResponse('{"other":"value"}')).toEqual({ other: 'value' });
  });

  it('handles text field with empty string', () => {
    expect(parseLlmResponse('{"text":""}')).toEqual({ text: '' });
  });

  it('handles ui field with empty string', () => {
    expect(parseLlmResponse('{"text":"ok","ui":""}')).toEqual({ text: 'ok', ui: '' });
  });

  it('handles very long ui (10000+ chars)', () => {
    const longScript = '<script>' + 'x'.repeat(10000) + '</script>';
    const raw = `{"text":"built","ui":"${longScript.replace(/"/g, '\\"')}"}`;
    const result = parseLlmResponse(raw);
    expect(result).toBeTruthy();
    expect(result!.text).toBe('built');
    expect(result!.ui!.length).toBeGreaterThan(10000);
  });

  it('parses JSON with only ui, no text (caller handles validation)', () => {
    const raw = '{"ui":"<script>x</script>"}';
    expect(parseLlmResponse(raw)).toEqual({ ui: '<script>x</script>' });
  });

  it('handles text with special JSON characters', () => {
    const raw = '{"text":"line1\\nline2\\ttabbed\\r\\nslash\\\\"}';
    expect(parseLlmResponse(raw)).toEqual({ text: 'line1\nline2\ttabbed\r\nslash\\' });
  });

  // ── Real-world responses from DeepSeek ───────────────────

  it('parses DeepSeek response: theme-switching chat', () => {
    const raw = `{"text":"Вот чат с переключением светлой/тёмной темы.","ui":"<script>const {el,$}=PromptUI;PromptUI.ui.set(\`<div id='chat'></div>\`);</script>"}`;
    const result = parseLlmResponse(raw);
    expect(result).toBeTruthy();
    expect(result!.text).toContain('переключением');
    expect(result!.ui).toContain('PromptUI.ui.set');
  });

  it('parses DeepSeek response: Windows 95 UI with multiline', () => {
    const raw = `{
  "text": "Welcome to Windows 95 Chat. Your chat application is ready.",
  "ui": "<script>
const { el, $, on, append } = PromptUI;
PromptUI.ui.set(\`
  <style>
    body { background: #008080; }
  </style>
  <div id='chat'></div>
\`);
</script>"
}`;
    const result = parseLlmResponse(raw);
    expect(result).toBeTruthy();
    expect(result!.text).toContain('Windows 95');
    expect(result!.ui).toContain('PromptUI.ui.set');
    expect(result!.ui).toContain('background: #008080');
  });

  // ── Template literal edge cases ───────────────────────────

  it('extracts ui with template literals using single-quoted attributes', () => {
    const raw = `{"text":"ok","ui":"<script>grid.querySelector(\\\`[data-action='digit'][data-value='\\\${key}']\\\`)</script>"}`;
    const result = parseLlmResponse(raw);
    expect(result).toBeTruthy();
    expect(result!.text).toBe('ok');
    expect(result!.ui).toContain(`[data-action='digit']`);
    expect(result!.ui).toContain(`</script>`);
  });

  it('extracts ui with escaped double-quotes in template literals', () => {
    const raw = `{"text":"ok","ui":"<script>grid.querySelector(\\\`[data-action=\\\\\\"digit\\\\\\"]\\\`)</script>"}`;
    const result = parseLlmResponse(raw);
    expect(result).toBeTruthy();
    expect(result!.text).toBe('ok');
    expect(result!.ui).toContain('querySelector');
    expect(result!.ui).toContain('</script>');
  });

  it('handles unescaped double-quotes in template literals via </script> anchor', () => {
    // Simulates the real-world bug: " inside \`...\` not escaped in JSON
    const raw = '{"text":"Built!","ui":"<script>const el=document.querySelector(`[data-action=\\"digit\\"]`);console.log(1);initCalc();</script>"}';
    const result = parseLlmResponse(raw);
    expect(result).toBeTruthy();
    expect(result!.text).toBe('Built!');
    // Must extract the FULL script including everything after the unescaped quote
    expect(result!.ui).toContain('initCalc()');
    expect(result!.ui).toContain('console.log(1)');
    expect(result!.ui).toContain('</script>');
  });

  it('handles multiple unescaped double-quotes in template literals', () => {
    // Multiple " in template literal — all inside same ui string
    const raw = '{"text":"ok","ui":"<script>const a=`[data-x=\\"a\\"][data-y=\\"b\\"]`;const b=42;done();</script>"}';
    const result = parseLlmResponse(raw);
    expect(result).toBeTruthy();
    expect(result!.text).toBe('ok');
    expect(result!.ui).toContain('const b=42');
    expect(result!.ui).toContain('done()');
    expect(result!.ui).toContain('</script>');
  });

  it('extracts full ui even when </script> appears inside a JS string', () => {
    // The text '</script>' might appear inside JS code as a string, but we use lastIndexOf
    // so we find the TRUE end of the ui value. JSON.parse converts \/ to /.
    const raw = `{"text":"ok","ui":"<script>const s='<\\/script>';const x=1;realEnd();</script>"}`;
    const result = parseLlmResponse(raw);
    expect(result).toBeTruthy();
    expect(result!.text).toBe('ok');
    // After JSON parsing, \/ becomes / — so the script contains </script> as literal text
    expect(result!.ui).toContain("const s='</script>'");
    expect(result!.ui).toContain('realEnd()');
    expect(result!.ui!.endsWith('</script>')).toBe(true);
  });

  it('extracts ui with complex nested braces and mixed quotes', () => {
    const raw = `{"text":"done","ui":"<script>const win={el:document.querySelector(\\\`[data-id=\\\\\\"main\\\\\\"]\\\`)};app.init({x:1});</script>"}`;
    const result = parseLlmResponse(raw);
    expect(result).toBeTruthy();
    expect(result!.text).toBe('done');
    expect(result!.ui).toContain('app.init');
    expect(result!.ui).toContain('</script>');
  });

  // ── Regression: </script> anchor must not break valid JSON ──

  it('parses valid JSON with properly escaped ui (direct parse still works)', () => {
    const raw = '{"text":"hello","ui":"<script>const x=1;</script>"}';
    const result = parseLlmResponse(raw);
    expect(result).toEqual({ text: 'hello', ui: '<script>const x=1;</script>' });
  });

  it('parses valid JSON with ui containing no script tags', () => {
    const raw = '{"text":"ok","ui":"plain text no script"}';
    const result = parseLlmResponse(raw);
    expect(result).toEqual({ text: 'ok', ui: 'plain text no script' });
  });
});
