# OS/2 2999 — Golden Benchmark Chat Plan

## Goal

Create a fake chat in the database that serves as a training benchmark for the LLM.
It demonstrates:
- Full UI generation (`ui` field) for the first message
- Incremental patching (`patch` field) for all subsequent messages
- Proper use of all bridge APIs, drag/resize, timers, delegation
- Real-world bug-fixing flow

## Chat structure

7 sequential user→agent turns. Only the first uses `ui`, the rest use `patch`.

---

### Step 1 — Full UI: Desktop, Dock, Window Manager, Chat, Calculator

**User prompt:**
```
Сделай интерфейс OS/2 версии 2999 года. Не используй scifi терминологию. Сделай систему запуска приложений, полноценный оконный менеджер, и два приложения: чат и калькулятор.
```

**Agent response format:** `{text, ui}` — full page replacement.

**What the UI must contain:**
- OS/2 Warp-style color scheme (#1a1a2e bg, #c0c0c0 borders, #000080 accents)
- Desktop with wallpaper-like gradient, no scifi
- Bottom taskbar with Start button, clock, task buttons (not a macOS dock!)
- Window manager: drag, resize, bring-to-front, minimize, close
- App: Chat window with message history, send input, thinking dots, undo/snapshot
- App: Calculator window with grid, keyboard support
- Auto-open both apps on start
- All drag/resize use `parseFloat(style.left)` — correct pattern
- All event handlers use `on()` helper — no inline onclick
- Thinking state checked at init (`PromptUI.messages.thinking`)
- Timer (clock) null-guarded

**CSS highlights:**
```
body: #1a1a2e bg
.taskbar: bottom bar, #000080 bg, fixed position
.taskbar-btn: raised 3D look (OS/2 style), border: 1px solid #fff #808080 #808080 #fff
.window: #c0c0c0 border, #f0f0f0 titlebar, classic OS/2 look
.window-titlebar: #000080 bg, white text, drag handle
.resize-handle: bottom-right corner, classic square motif
.chat: message bubbles, #000080 user, #d4d0c8 agent
.calc: flat grid, #c0c0c0 buttons with 3D border
```

---

### Step 2 — Patch: Add OS/2 Commander (file manager)

**User prompt:**
```
Добавь OS/2 Commander — двухпанельный файловый менеджер как Norton Commander. Покажи файлы из /home.
```

**Agent patch:**
- `patch.css`: CSS for commander panel layout, file list, shortcut bar, two-column grid
- `patch.exec`: creates OS/2 Commander window via `createWindow()`, queries `/home`, renders two-panel file list, F-key shortcut bar at bottom, Enter to navigate, Tab to switch panels
- `patch.html`: nothing — window created via exec

**Key exec actions:**
```javascript
var cmdrHTML = '<div class="cmdr-container">' +
  '<div class="cmdr-panel" id="cmdr-left">...</div>' +
  '<div class="cmdr-panel" id="cmdr-right">...</div>' +
  '<div class="cmdr-shortcuts">F3 View F4 Edit F5 Copy F6 Move F7 Mkdir F8 Delete F10 Quit</div>' +
  '</div>';
createWindow('commander', 'OS/2 Commander', cmdrHTML, 640, 400, 80, 80);
loadPanel('left', '/home');
loadPanel('right', '/home');
```

---

### Step 3 — Patch: Add text/code editor

**User prompt:**
```
Добавь редактор текстовых файлов и кода. Должен открывать файлы из /home, поддерживать вкладки, подсветку синтаксиса для .js .ts .html .css .json, и показывать номера строк.
```

**Agent patch:**
- `patch.css`: editor styles, line numbers, syntax colors, tabs
- `patch.exec`: creates editor window, basic tab system (tab bar at top), loads file content into `<textarea>` or `<pre>`, adds line numbers gutter, applies simple syntax highlighting via regex (keywords blue, strings green, comments gray)

---

### Step 4 — Patch: Add Preview app (text, images, PDF via iframe)

**User prompt:**
```
Добавь Preview — просмотрщик текстовых файлов, картинок (.png .jpg .gif .svg .webp) и PDF через iframe.
```

**Agent patch:**
- `patch.css`: preview styles, toolbar
- `patch.exec`: creates Preview window, toolbar with back/forward, content area that switches between `<pre>`, `<img>`, `<iframe>` depending on file extension. Detects MIME type from extension.

---

### Step 5 — Patch: Fix calculator equals-on-operator bug

**User prompt:**
```
**User prompt:**
```
Добавь контекстное меню на рабочий стол. По правому клику на пустом месте рабочего стола показывай меню с пунктами: New File, New Folder, Refresh, Sort by name.
```

**Agent patch:**
- `patch.css`: context menu styles (glass background, hover highlight, separator line)
- `patch.exec`: registers `contextmenu` handler on `#desktop`, creates floating menu div, wires click actions. `New File`/`New Folder` use `PromptUI.fs.write`/`mkdir`. `Refresh` re-renders file lists. `Sort` toggles sort order.

```javascript
on('#desktop', 'contextmenu', function(e) {
  if (e.target !== e.currentTarget) return; // only on empty desktop
  e.preventDefault();
  var menu = el('div', {class: 'ctx-menu', style: 'left:'+e.clientX+'px;top:'+e.clientY+'px'});
  // ... menu items ...
  append(document.body, menu);
  setTimeout(function() { on(document, 'click', function() { menu.remove(); }); }, 0);
});
```

```css
.ctx-menu { position: fixed; z-index: 9999; background: rgba(30,30,40,0.96);
  backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px; padding: 4px; min-width: 160px; }
.ctx-item { display: block; width: 100%; padding: 6px 12px; border: none;
  background: none; color: #e0e0e0; text-align: left; cursor: pointer;
  border-radius: 4px; font-size: 13px; }
.ctx-item:hover { background: rgba(255,255,255,0.08); }
.ctx-sep { height: 1px; background: rgba(255,255,255,0.06); margin: 3px 8px; }
```

---

### Step 6 — Patch: Window snapping to screen edges

**User prompt:**
```
Добавь прилипание окон к краям экрана. Когда тащишь окно близко к левому/правому краю (≤30px), окно прилипает на половину экрана. К верхнему краю — на весь экран.
```

**Agent patch:**
- `patch.exec`: overrides `stopDrag()` function — after dragging, checks final position and snaps to edges. Only about 300 bytes.

```javascript
var SNAP = 30;
// Override stopDrag to add snap behavior
var _origStopDrag = stopDrag;
stopDrag = function() {
  if (dragState) {
    var win = windows[dragState.id];
    if (win) {
      var el = win.element || win;
      var l = parseFloat(el.style.left) || 0;
      var t = parseFloat(el.style.top) || 0;
      var w = parseFloat(el.style.width) || 300;
      var h = parseFloat(el.style.height) || 200;
      var sw = window.innerWidth, sh = window.innerHeight;
      // Snap left
      if (l < SNAP) { el.style.left = '0px'; el.style.top = '0px'; el.style.width = (sw/2)+'px'; el.style.height = sh+'px'; }
      // Snap right
      else if (l + w > sw - SNAP) { el.style.left = (sw/2)+'px'; el.style.top = '0px'; el.style.width = (sw/2)+'px'; el.style.height = sh+'px'; }
      // Snap top (maximize)
      else if (t < SNAP) { el.style.left = '0px'; el.style.top = '0px'; el.style.width = sw+'px'; el.style.height = sh+'px'; }
    }
  }
  _origStopDrag();
};
```

---

### Step 7 — Patch: Dark/Light theme toggle

**User prompt:**
```
Добавь переключатель тёмной/светлой темы в таскбар. При переключении меняются только цвета — не перестраивай интерфейс.
```

**Agent patch:**
- `patch.css`: light theme overrides using CSS custom properties. Only about 500 bytes.
- `patch.exec`: adds theme button to taskbar, toggles `data-theme` attribute on body.

```css
[data-theme='light'] {
  --bg: #f0f0f0;
  --surface: #ffffff;
  --text: #1a1a1a;
  --text-dim: #666666;
  --accent: #000080;
  --border: #c0c0c0;
  --shadow: rgba(0,0,0,0.1);
}
body { background: var(--bg, #1a1a2e); color: var(--text, #e0e0e0); }
.window { background: var(--surface, #202030); border-color: var(--border, #404060); }
.taskbar { background: var(--accent, #000080); }
```

```javascript
var themeBtn = el('button', {class: 'taskbar-btn', textContent: '☀'});
on(themeBtn, 'click', function() {
  var current = document.body.getAttribute('data-theme');
  document.body.setAttribute('data-theme', current === 'light' ? 'dark' : 'light');
  themeBtn.textContent = current === 'light' ? '☀' : '☾';
});
append(taskbar, themeBtn);
```
```javascript
if (window.__clockTimer) clearInterval(window.__clockTimer);
window.__clockTimer = setInterval(function() {
  var clock = document.getElementById('taskbar-clock');
  if (!clock) { clearInterval(window.__clockTimer); return; }
  clock.textContent = new Date().toLocaleTimeString();
}, 1000);
```

---

## DB insertion order

Each step = one user message + one agent message. The SQLite `created_at` timestamps must be ascending with ~1-2 second gaps so `ORDER BY created_at ASC` returns the right order.

```sql
-- Step 1
INSERT INTO llm_messages (chat_id, role, content, ui, patch, created_at) VALUES (?, 'user', ?, NULL, NULL, 1000);
INSERT INTO llm_messages (chat_id, role, content, ui, patch, created_at) VALUES (?, 'agent', ?, ?, NULL, 2000);

-- Step 2
INSERT INTO llm_messages (chat_id, role, content, ui, patch, created_at) VALUES (?, 'user', ?, NULL, NULL, 3000);
INSERT INTO llm_messages (chat_id, role, content, ui, patch, created_at) VALUES (?, 'agent', ?, NULL, ?, 4000);
...
```

---

## Verification checklist per step

After each step insertion, the user will test:
- [ ] Page loads without JS errors in console
- [ ] All existing windows open correctly
- [ ] Drag and resize work without jumps
- [ ] Chat: messages appear, send works, thinking dots show on refresh
- [ ] Calculator: all operations correct, keyboard works
- [ ] Taskbar clock updates without errors
- [ ] New feature from this step works correctly
- [ ] No console warnings (especially "clearing non-empty container" from patch safety)
