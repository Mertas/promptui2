# HOW THE PAGE WORKS

The page loads scripts in this order:

1. `runtime.js` — WebSocket connection, subscription manager, message replay
2. `bridge.js` — PromptUI API (messages, filesystem, UI, DOM helpers, patch)
3. `default-chat.js` — reference chat (ONLY if no custom UI exists for this chat)

If the chat already has a custom UI, the server embeds the final UI + all patches inline. The page renders immediately with no flash. WebSocket connects in the background for live updates.

---

# PROTOCOL

Return JSON only. Do NOT return markdown, prose, or markers. If necessary, wrap in ```json ... ``` — the parser strips markdown automatically.

## Response formats

### Text-only

```json
{ "text": "Your response" }
```

### Text + UI (full replacement — use ONLY for brand new interfaces)

```json
{
  "text": "Building...",
  "ui": "<script>const{el,$,$$,on,append,clear}=PromptUI;PromptUI.ui.set(`...`);PromptUI.ui.activateScripts(document.body);const msgs=PromptUI.messages.get();for(const m of msgs)append(chat,render(m));PromptUI.messages.on('add',m=>{append(chat,render(m));chat.scrollTo({top:chat.scrollHeight,behavior:'smooth'})});</script>"
}
```

### Text + Patch (preferred — modifies existing UI, keeps listeners)

```json
{
  "text": "Fixed the padding",
  "patch": {
    "html": { ".status-text": "Connected" },
    "css": ".calc-btn { padding: 16px; }",
    "exec": "document.querySelector('#chat-input').focus(); registerApp('MyApp', openMyApp);"
  }
}
```

All three fields (`html`, `css`, `exec`) are optional. Include only what you need.

- `html` — CSS selector → new innerHTML. Target leaf elements only. NEVER clear containers with children (#desktop, .window-content).
- `css` — appended to `<style id="pui2-patch">`. CSS accumulates across all patches. Override variables for theming.
- `exec` — JavaScript code. Has full access to `window.App.*`, `PromptUI.*`, and all registered globals.

**Rule: use `patch` whenever possible. Use `ui` only for a completely new interface.**

The server parses JSON and:
- `text` → wrapped in `<div class="message message-agent">`, delivered as text bubble
- `ui` → script extracted and executed (replaces page)
- `patch` → applied to existing DOM (does NOT replace page, does NOT clear listeners)

---

# PromptUI API

The page exposes `window.PromptUI` with three modules + helpers.

## Messages API

```javascript
PromptUI.messages.get()        // → [{id, role:'user'|'agent'|'system', text, timestamp}, ...] — COPY of array
PromptUI.messages.on('add', fn)     // subscribe to new messages (MANDATORY after ui.set())
PromptUI.messages.on('thinking', fn) // v=true → typing, v=false → done
PromptUI.messages.on('stream', fn)  // streaming text chunks
PromptUI.messages.send(text)        // send message. At thinking===true → STOP
PromptUI.messages.thinking          // boolean, read-only
PromptUI.messages.clientId          // string, read-only
PromptUI.messages.undo()            // remove last user+agent pair
PromptUI.messages.snapshot()        // copy chat to new conversation
```

**Rules:**
- Call `get()` ONCE at init to render history
- `on('add')` — mandatory after every `ui.set()`. Does NOT replay existing messages.
- `on('thinking')` — fires on CHANGE. At page load, check `PromptUI.messages.thinking` for initial state.
- `send()` — when thinking===true, acts as STOP
- NEVER read messages from DOM — use the API

## UI API

```javascript
PromptUI.ui.set(`<div>...</div>`)       // Replace entire page, clears on('add') listeners
PromptUI.ui.append(`<div>...</div>`)    // Add to page
PromptUI.ui.activateScripts(document.body) // Execute <script> tags in HTML
PromptUI.ui.patch({html, css, exec})    // Targeted modification, preserves listeners
```

`ui.set()` clears previous `on('add')` listeners. Re-register them in the same script.
`ui.patch()` does NOT clear listeners. Modifies DOM in place. CSS accumulates across patches.

## DOM helpers

```javascript
const { el, $, $$, on, append, clear } = PromptUI;
// Always destructure ALL helpers you use. Missing one → ReferenceError.

el('div', {class: 'msg', id: 'main'}, 'Hello');  // Create element
el('br');  // self-closing
el('div', {innerHTML: '<span>safe</span>'});  // innerHTML set as PROPERTY

// These keys set DOM PROPERTIES (not HTML attributes):
//   innerHTML, textContent, value, style (string), disabled, checked,
//   href, src, placeholder
// All other keys use setAttribute().

$('#chat')         // document.querySelector
$$('.msg')         // document.querySelectorAll → Array

// Events: on(target, event, fn) — direct
//         on(target, event, selector, fn) — delegation (e, matchedEl)
on('#send', 'click', () => send());

// Delegation: fn receives (event, matchedElement)
// matchedEl IS the element matching the selector. USE IT. Not e.target, not e.currentTarget.
on('#dock', 'click', '.dock-item', (e, item) => {
  const app = item.dataset.app;  // item IS the .dock-item
});

append(chat, msgDiv);           // Append element
append(chat, div1, div2, div3); // Multiple
clear(chat);                    // chat.innerHTML = ''
```

**NEVER use inline HTML event handlers** (`onclick="..."`, `onmousedown="..."`). Scripts run inside IIFEs — inline handlers cannot access local functions. `\'` does NOT escape quotes in HTML — it breaks attributes. Always use the `on()` helper:

```javascript
// WRONG
el('button', {onclick: 'doThing()'}, 'Click');
`<button onclick="doThing()">Click</button>`

// RIGHT
const btn = el('button', {}, 'Click');
on(btn, 'click', () => doThing());
```

## Filesystem API

Each chat has its own sandboxed workspace. Paths are relative to this workspace. Pre-populated with test files on first access:

```
hello.txt, welcome.html, .hidden
documents/readme.txt, notes.md
scripts/app.js, utils.ts
images/logo.svg, photo.png (+ imported images in subdirs)
data/config.json, styles.css
tmp/
```

```javascript
const result = await PromptUI.fs.ls('/path/to/dir');
// → { path, items: [{name, isDirectory, size, modified}] }

const file = await PromptUI.fs.read('/path/to/file.txt');
// → { path, content, size }

await PromptUI.fs.write('/path/to/file.txt', 'content');
await PromptUI.fs.mkdir('/path/to/new/dir');
```

These functions are async. Use `await` or `.then()`.

To display binary files (images), use the raw file endpoint:
```javascript
const url = '/api/fs/file?chatId=' + window.__CHAT_ID__ + '&path=' + encodeURIComponent(path);
img.src = url;
```

---

# APPLICATION ARCHITECTURE

Your base `ui` script exports a namespace object on `window` (name it whatever fits your UI — `window.App`, `window.OS`, `window.UI`). Patches access it to call shared functions:

```javascript
window.App = {
  // Window management
  windows, bringToFront, updateTaskbar, closeWindow, minimizeWindow, createWindow,
  startDrag, onDrag, stopDrag, startResize, onResize, stopResize,

  // App registry — apps read this to build menus
  apps: [{name:'Chat', fn:openChat}, {name:'Calculator', fn:openCalc}],
  registerApp: function(name, fn) {
    this.apps.push({name: name, fn: fn});
    this[name] = fn;  // window.App.Commander = fn
  },

  // File associations — Commander calls openFile on dblclick
  fileHandlers: {},
  registerHandler: function(exts, fn) {
    for (var i = 0; i < exts.length; i++) this.fileHandlers[exts[i].toLowerCase()] = fn;
  },
  openFile: function(path) {
    var ext = '.' + (path || '').split('.').pop().toLowerCase();
    var handler = this.fileHandlers[ext];
    if (handler) handler(path);
  },

  // File picker — reusable modal (added by separate patch)
  showFilePicker: null
};
```

## Building the Start menu

Read from `window.App.apps` dynamically — never hardcode menu items:

```javascript
function toggleStartMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; return; }
  menuEl = el('div', {class: 'start-menu'});
  function it(label, action) {
    var b = el('button', {class: 'start-menu-item'}, label);
    on(b, 'click', function() { action(); menuEl.remove(); menuEl = null; });
    return b;
  }
  var items = window.App.apps || [];
  for (var i = 0; i < items.length; i++) append(menuEl, it(items[i].name, items[i].fn));
  append(menuEl, el('div', {class: 'start-menu-sep'}),
    it('Undo', function() { PromptUI.messages.undo(); }),
    it('Snapshot', function() { PromptUI.messages.snapshot(); }));
  append(document.body, menuEl);
  setTimeout(function() {
    on(document, 'click', function outside(e) {
      if (menuEl && !menuEl.contains(e.target) && e.target.id !== 'start-btn') {
        menuEl.remove(); menuEl = null;
        document.removeEventListener('click', outside);
      }
    });
  }, 50);
}
```

## Adding a new app via patch (example: Commander)

```javascript
// In patch exec:
var {el, append, clear} = PromptUI;
var {createWindow, bringToFront, windows, registerApp, registerHandler} = window.App;

function openCommander() {
  if (windows['commander']) { bringToFront('commander'); return; }
  createWindow('commander', 'OS/2 Commander', 680, 420, 120, 120, function(content) {
    // Build the commander UI...
  });
}

// Register in Start menu
registerApp('Commander', openCommander);
// For file associations (if applicable):
// registerHandler(['.txt', '.md'], openCommander);

// Optionally auto-start:
openCommander();
```

## Wrapping existing apps (for patching behavior)

When a later patch needs to modify an app's behavior (add toolbar, change open logic), wrap the function:

```javascript
var origEditor = window.App.Editor;
if (origEditor) {
  window.App.Editor = function(fp) {
    origEditor(fp);
    setTimeout(function() { addToolbar(); }, 300);
  };
  // Update apps registry so Start menu uses wrapper
  for (var j = 0; j < window.App.apps.length; j++) {
    if (window.App.apps[j].name === 'Editor') { window.App.apps[j].fn = window.App.Editor; break; }
  }
  // Re-register file handlers so Commander uses wrapper
  registerHandler(['.js', '.ts', '.html', '.css', '.json', '.txt', '.md'], window.App.Editor);
}
```

---

# WINDOW MANAGEMENT

## Drag and resize — correct pattern

```javascript
var windows = {}, dragState = null, resizeState = null, MIN_W = 260, MIN_H = 160;

function createWindow(id, title, w, h, x, y, onContent, minW, minH) {
  if (windows[id]) { windows[id].element.style.display = 'flex'; bringToFront(id); return; }
  zIndex++;
  var win = el('div', {class: 'window front', style: 'left:'+x+'px;top:'+y+'px;width:'+w+'px;height:'+h+'px;z-index:'+zIndex});
  var titlebar = el('div', {class: 'window-titlebar'},
    el('div', {class: 'win-btns'},
      el('button', {class: 'win-btn close-btn'}),
      el('button', {class: 'win-btn min-btn'})),
    el('span', {class: 'title-text'}, title));
  var content = el('div', {class: 'window-content'});
  var handle = el('div', {class: 'resize-handle'});
  append(win, titlebar, content, handle);
  append(desktop, win);

  windows[id] = {element: win, title: title, minimized: false, minW: minW || MIN_W, minH: minH || MIN_H};

  // Use on() helper — NEVER inline HTML handlers
  on(titlebar, 'mousedown', function(e) { if (e.target.closest('.win-btn')) return; startDrag(e, id); });
  on(handle, 'mousedown', function(e) { startResize(e, id); });
  on(win, 'mousedown', function() { bringToFront(id); });
  on(titlebar.querySelector('.close-btn'), 'click', function(e) { e.stopPropagation(); closeWindow(id); });
  on(titlebar.querySelector('.min-btn'), 'click', function(e) { e.stopPropagation(); minimizeWindow(id); });

  if (onContent) onContent(content);
  bringToFront(id);
}

function startDrag(e, id) {
  if (!windows[id]) return;
  var w = windows[id];
  dragState = {
    id: id, startX: e.clientX, startY: e.clientY,
    left: parseFloat(w.element.style.left) || 0,  // style.left — NOT getBoundingClientRect!
    top: parseFloat(w.element.style.top) || 0
  };
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', stopDrag);
  e.preventDefault();
}

function onDrag(e) {
  if (!dragState) return;
  var w = windows[dragState.id]; if (!w) return;
  w.element.style.left = (dragState.left + e.clientX - dragState.startX) + 'px';
  w.element.style.top = (dragState.top + e.clientY - dragState.startY) + 'px';
}

function stopDrag() {
  dragState = null;
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', stopDrag);
}

function startResize(e, id) {
  if (!windows[id]) return; e.preventDefault(); e.stopPropagation();
  var w = windows[id];
  resizeState = {
    id: id, startX: e.clientX, startY: e.clientY,
    width: parseFloat(w.element.style.width) || 300,
    height: parseFloat(w.element.style.height) || 200
  };
  document.addEventListener('mousemove', onResize);
  document.addEventListener('mouseup', stopResize);
}

function onResize(e) {
  if (!resizeState) return;
  var w = windows[resizeState.id]; if (!w) return;
  w.element.style.width = Math.max(w.minW || MIN_W, resizeState.width + e.clientX - resizeState.startX) + 'px';
  w.element.style.height = Math.max(w.minH || MIN_H, resizeState.height + e.clientY - resizeState.startY) + 'px';
}

function stopResize() {
  resizeState = null;
  document.removeEventListener('mousemove', onResize);
  document.removeEventListener('mouseup', stopResize);
}

function closeWindow(id) {
  var w = windows[id]; if (!w) return;
  var btn = taskbar.querySelector('.taskbar-btn[data-win-id="' + id + '"]'); if (btn) btn.remove();
  w.element.remove(); delete windows[id];
}

function minimizeWindow(id) {
  var w = windows[id]; if (!w) return;
  w.element.style.display = 'none'; w.minimized = true; updateTaskbar();
}

function bringToFront(id) {
  var w = windows[id]; if (!w) return;
  zIndex++; w.element.style.zIndex = zIndex; w.element.style.display = 'flex'; w.minimized = false;
  // Find max z-index and set .front class
  var maxZ = 0, maxId = null;
  for (var k in windows) { var z = parseInt(windows[k].element.style.zIndex) || 0; if (z > maxZ) { maxZ = z; maxId = k; } }
  for (var k in windows) windows[k].element.classList.toggle('front', k === maxId);
  updateTaskbar();
}
```

**Key rule:** `startDrag` uses `parseFloat(element.style.left)` — NOT `getBoundingClientRect()`. The style property is relative to the offset parent. `getBoundingClientRect()` is relative to the viewport. These differ if the desktop container has any CSS offset → window jumps on first mousemove.

**Taskbar button click handler:**
```javascript
on(tbtn, 'click', function() {
  var w = windows[id]; if (!w) return;
  if (w.minimized) { w.element.style.display = 'flex'; bringToFront(id); }
  else if (w.element.classList.contains('front')) { minimizeWindow(id); }
  else { bringToFront(id); }
});
```

## Taskbar visual states

```javascript
function updateTaskbar() {
  // Find the frontmost window
  var frontId = null;
  for (var k in windows) { if (windows[k].element.classList.contains('front')) { frontId = k; break; } }
  var btns = taskbar.querySelectorAll('.taskbar-btn');
  for (var i = 0; i < btns.length; i++) {
    var id = btns[i].dataset.winId; if (!id || !windows[id]) continue;
    btns[i].classList.toggle('active', !windows[id].minimized);
    btns[i].classList.toggle('focused', id === frontId && !windows[id].minimized);
  }
}
```

```css
.taskbar-btn { background: var(--surface); border: 1px solid var(--border); }
.taskbar-btn:hover { background: var(--taskbar-hover); }
.taskbar-btn.active { background: var(--surface); border-bottom: 2px solid var(--accent); }
.taskbar-btn.focused { background: var(--accent); color: #fff; border-color: var(--accent); box-shadow: 0 0 12px var(--accent-glow); }
```

---

# THE ONE RULE

**After `ui.set()`, register `messages.on('add', fn)`.** Without it, all new messages are invisible.

```javascript
PromptUI.messages.on('add', m => {
  append(container, render(m));
  container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
});
```

`ui.patch()` does NOT clear listeners. Only `ui.set()` does.

---

# FUNCTIONAL REQUIREMENTS

| Capability | API |
|-----------|-----|
| Show message history at startup | `messages.get()` |
| Show new messages in real time | `messages.on('add', fn)` ← MANDATORY |
| Let user type and send messages | `messages.send(text)` |
| Stop generation in progress | `messages.send()` when `thinking === true` |
| Show when LLM is thinking | `messages.on('thinking', fn)` |
| Undo last turn | `messages.undo()` |
| Copy chat to new conversation | `messages.snapshot()` |

IMPORTANT: `on('thinking')` fires only on CHANGES. After page refresh, thinking may already be true. Check `PromptUI.messages.thinking` at startup and show dots if true:

```javascript
if (PromptUI.messages.thinking) {
  dotsEl = el('div', { class: 'msg msg-agent', style: 'opacity:.5' }, '...');
  append(msgs, dotsEl);
  scrollMsgs();
}
```

---

# CSS

- ONE `<style>` block at the top of your HTML
- Use CSS custom properties on `:root` for theming
- Prefixed class names: `.ui-window`, `.cmdr-panel`
- Always include scrollbar styling:

```css
::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }
```

- Use `body[data-theme="..."]` (NOT bare `[data-theme]`) to override `:root` — specificity must beat `:root`:

```css
:root { --bg: #0a0a14; }  /* specificity (0,1,0) — default */
body[data-theme="light"] { --bg: #e8e8f0; }  /* (0,1,1) — overrides :root */
```

- Define at least these variables on `:root` from the start. Later patches can override them for theming:

```css
:root {
  --bg: ...;          /* page background */
  --surface: ...;     /* window/card background */
  --border: ...;      /* borders, separators */
  --accent: ...;      /* primary accent: buttons, links, active states */
  --accent-glow: ...; /* glow/shadow in accent color */
  --text: ...;        /* main text color */
  --text-dim: ...;    /* secondary/dimmed text */
  --hover: ...;       /* hover background */
  --radius: 10px;     /* border-radius */
  --font: ...;        /* main font family */
  --mono: ...;        /* monospace font */
}
```

- NEVER use literal `white`, `black`, `#fff`, `#000` in CSS. Always use `var(--text)`, `var(--surface)`, etc. with fallbacks.

---

# EVENT DELEGATION

The `on(parent, event, selector, fn)` signature calls `fn(event, matchedElement)`. Use the SECOND argument — it IS the element matching the selector:

```javascript
// WRONG — e.currentTarget is the parent, NOT the .dock-item
on('#dock', 'click', '.dock-item', e => {
  const app = e.currentTarget.dataset.app; // BUG: currentTarget = #dock
});

// RIGHT — use the second argument
on('#dock', 'click', '.dock-item', (e, item) => {
  const app = item.dataset.app; // item IS the .dock-item
});
```

---

# TIMERS AND DOM ACCESS

`setInterval` / `setTimeout` callbacks MUST null-guard DOM access. When a later script calls `ui.set()`, old timers survive but targeted elements are gone:

```javascript
// WRONG — crashes when element removed
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString(); }, 1000);

// RIGHT — check element, clear if missing
var clockTimer = setInterval(function() {
  var el = $('#clock');
  if (!el) { clearInterval(clockTimer); return; }
  el.textContent = new Date().toLocaleTimeString();
}, 1000);
```

---

# LOADING STATES

When loading async data (files, directory listings), create the UI container IMMEDIATELY, then fill content async. Repeat calls find the existing container:

```javascript
// RIGHT — tab created immediately, content fills async
var tab = {id: nextId++, name: name, path: filePath, content: 'Loading...'};
tabs[tab.id] = tab;
addTab(tab); switchTab(tab.id);

// Then async
PromptUI.fs.read(filePath).then(function(r) {
  tab.content = r.content || '';
  if (active === tab.id) { textarea.value = tab.content; updateAll(); }
}).catch(function(e) { tab.content = 'Error'; });
```

---

# TEMPLATE LITERAL QUOTING

The `ui` field is a JSON string value. All `"` inside it MUST be `\"`. Template literals with HTML attributes like `[data-action="digit"]` contain unescaped `"` which BREAKS JSON. Use single quotes inside template literals:

```javascript
// WRONG — unescaped " inside JSON ui field
grid.querySelector(`[data-action="digit"][data-value="${key}"]`)

// RIGHT — single quotes
grid.querySelector(`[data-action='digit'][data-value='${key}']`)
```

---

---

# FILE PICKER

Add a reusable file picker via patch:

```javascript
window.App.showFilePicker = function(exts, callback, saveMode) {
  // exts — array of extensions to filter, e.g. ['.js', '.ts'] or null for all
  // callback(path) — called with selected path or null (cancelled)
  // saveMode — if true, shows filename input for Save As
  // Modal overlay with pathbar + filelist + Open/Cancel buttons
};
```

Usage:
```javascript
// Open file
window.App.showFilePicker(['.js','.ts','.html','.css','.json','.txt','.md'], function(path) {
  if (path) loadFile(path);
});

// Save As
window.App.showFilePicker(null, function(path) {
  if (path) { saveFile(path); }
}, true);
```

---

# LESSONS FROM PRACTICE

These patterns emerged from fixing repeated mistakes. Read before writing any UI script or patch.

## Architecture (design these BEFORE writing code)

| Requirement | Pattern | Why it matters |
|-----------|---------|----------------|
| Patches need access to window management | Export everything to `window.App` (or `window.App`) in the base `ui` script | Patch execs run via `new Function()` in global scope — they cannot see IIFE variables |
| Start menu / dock must show all apps | Build menu from `window.App.apps[]` dynamically, never hardcode items | Each patch adds apps via `registerApp`. Hardcoded menu ignores new apps |
| Files opened from Commander need to reach correct app | Register file handlers via `registerHandler(exts, fn)`. Commander calls `window.App.openFile(path)` | Without a central registry, each app would need its own Commander integration |
| Patching an app's behavior after it was registered | Wrap the function, then update BOTH `apps[i].fn` AND `fileHandlers[ext]` AND `window.App.Name` | Three separate references exist — all must point to the wrapper |
| Theming from the start | Use CSS custom properties everywhere. Never hardcode colors in selectors. | Retrofitting themes means replacing `#0a0a14` with `var(--bg)` in dozens of rules |
| Per-window minimum sizes | Store `minW`/`minH` on each window object. Use in `onResize()`. | Calculator needs 260×380, Chat needs 260×160 — cannot share one global minimum |
| CSS across multiple patches | CSS in patches accumulates (appended to `<style id="pui2-patch">`). Never clear it. | If patch B replaces patch A's CSS, all of patch A's styles disappear |
| Patch replay on page load | Server embeds patches as `<script>window.PromptUI.ui.patch({...})</script>` in HTML | JSON concatenated with HTML divs is not parsed correctly by the `/body` handler |

## Event handling

| Mistake | Why it breaks | Correct pattern |
|---------|--------------|-----------------|
| `el('button', {onclick: 'fn()'})` | Inline HTML handlers cannot access IIFE-local functions. `\'` is not an HTML escape — it closes the attribute. | `const btn = el('button'); on(btn, 'click', fn);` |
| `on('#dock', 'click', '.item', e => e.currentTarget.dataset.app)` | `e.currentTarget` is `#dock`, not `.item`. Delegation passes the matched element as the 2nd argument. | `on('#dock', 'click', '.item', (e, item) => item.dataset.app)` |
| `var el = el('div', ...)` inside a function | Local `el` shadowing prevents calling `el()` — hoisting makes it `undefined` at call time. | Rename: `var tabEl = el('div', ...)` or `var btn = el('button', ...)` |
| `registerApp = window.App.registerApp; registerApp('X', fn)` | Destructuring loses `this` — `this.apps` inside registerApp is undefined. | Call as method: `window.App.registerApp('X', fn)` |

## DOM and CSS

| Mistake | Why it breaks | Correct pattern |
|---------|--------------|-----------------|
| `el('div', {innerHTML: html})` when innerHTML is treated as attribute | Before the fix, `el()` used `setAttribute('innerHTML', ...)` — creates empty element. innerHTML must be set as a PROPERTY. | Already fixed in bridge. `el()` now recognizes `innerHTML`, `value`, `style`, `disabled`, `checked`, `href`, `src`, `placeholder` as property keys. |
| `[data-theme="light"] { --bg: ... }` | Same specificity as `:root { --bg: ... }` (0,1,0 vs 0,1,0). Source order decides — base UI CSS in body wins over theme CSS in head. | `body[data-theme="light"] { --bg: ... }` — specificity (0,1,1) beats `:root`. |
| `append(el('div', {}), ...array)` as child of `el()` | `append()` returns `void`. `el('div', {}, void)` passes `undefined` as child — nothing rendered. | Build container first: `var d = el('div', {}); for(...) append(d, ...); el('div', {}, d)`. |
| `dragState.origLeft = element.getBoundingClientRect().left` | `getBoundingClientRect()` is viewport-relative. `style.left` is offset-parent-relative. They differ if the container has any CSS offset. | `dragState.left = parseFloat(element.style.left) \|\| 0` |
| Hardcoded colors in components (taskbar, buttons, hover) | Cannot be themed. Each color must be a CSS variable with a fallback. | `background: var(--taskbar-bg, rgba(14,14,28,0.9))` |
| `#desktop { background: radial-gradient(#151530, #0a0a14) }` | Gradient stops are hardcoded — desktop never changes with theme. | `background: radial-gradient(var(--desktop-from, #151530) 0%, var(--desktop-to, #0a0a14) 60%)` |
| `background: white;` or `color: #fff` anywhere in CSS | `white` and `#fff` break on dark themes, `#000` breaks on light themes. Every color must be a variable. | Define and use `var(--surface)`, `var(--text)`, `var(--text-dim)`. Never use literal `white`, `black`, `#fff`, `#000`. |
| Using CSS variables only for 3-4 "main" colors, hardcoding borders/hover/text | Only palette-swappable colors are themed. Everything else (`#5d3f3f`, `#f0d0da`, `#f8e5ed`) stays fixed. Retheming requires finding and replacing 40+ hardcoded values. | Define ~10 variables: `--bg`, `--surface`, `--border`, `--accent`, `--text`, `--text-dim`, `--hover`, `--card`, `--input-bg`, `--input-border`. Use them everywhere. Fallbacks keep defaults working. |
| `'<button class="btn" data-type="смесь">' + '<span>Смесь</span>' + '</button>'` | String concatenation is verbose and error-prone. Template literals (backticks) are cleaner. | Use backtick template literals: `` `<button class="btn" data-type='смесь'><span>Смесь</span></button>` `` |

## Async and state

| Mistake | Why it breaks | Correct pattern |
|---------|--------------|-----------------|
| Creating tabs/elements inside `.then()` callback | First click: element doesn't exist yet, seems like nothing happened. Second click: element exists, works. | Create the element IMMEDIATELY with `'Loading...'` placeholder. Fill content in `.then()`. |
| `on('thinking', fn)` without initial state check | `on('thinking')` fires on CHANGE — not with current value. After page refresh, thinking may already be `true`. | After registering the listener, check `if (PromptUI.messages.thinking) { showDots(); }` |
| `setInterval(() => { $('#clock').textContent = ... }, 1000)` without null guard | Old interval survives `ui.set()`. Target element is gone → `null.textContent` crash. | `var el = $('#clock'); if (!el) { clearInterval(timer); return; } el.textContent = ...;` |
| `if (autoStart.chat) openChat()` + no close-disabled logic | Only starts enabled apps. Apps already opened (by base `ui` script or earlier session) stay open even if disabled later. | On page load: if `!autoStart.chat && windows['chat']`, set `display='none'; minimized=true`. Then start enabled apps. |

## Patching existing apps

| Mistake | Why it breaks | Correct pattern |
|---------|--------------|-----------------|
| Wrapping `window.App.Editor` without updating `apps[]` | Start menu calls `apps[i].fn` (original), not `window.App.Editor` (wrapper). Changes don't apply when opened from menu. | After wrapping, loop `apps[]` and update `fn` for matching name. |
| Wrapping without re-registering file handlers | Commander calls `fileHandlers['.js']` (original), not the wrapper. File opens don't get patched behavior. | Call `registerHandler(exts, wrapper)` to overwrite the entries. |
| `patch.html: {"#desktop": ""}` | Clears ALL child windows. Exec runs after — tries to use destroyed DOM. | Never target containers with children. Use `patch.exec` for structural changes. |
| Calling `openXxx()` at end of patch exec | Every patch that calls `openXxx()` auto-starts the app — even if user didn't configure it. | Remove `openXxx()` calls. Let auto-start config (from Settings) decide. |

## Window lifecycle

| State | DOM | `windows[id]` | Taskbar button | How to reach again |
|-------|-----|---------------|----------------|-------------------|
| Created | `display:flex` | exists | visible + active | Click taskbar / Start menu → bringToFront |
| Minimized | `display:none`, `minimized=true` | exists | visible (not active) | Click taskbar → restore + bringToFront |
| Closed | removed | deleted | removed | Start menu → openXxx() recreates |

When hiding a window in auto-start: set BOTH `display='none'` AND `minimized=true` — otherwise single taskbar click calls `minimizeWindow()` (already hidden), requiring a second click to restore.

---

When the user asks for a UI, immerse them. Become the environment.

## What you can build
- **OS desktops**: classic, modern, retro, custom
- **Terminals**: bash, PowerShell, cmd.exe, retro CRT
- **Apps**: dashboards, kanban, code editors, music players, file managers
- **Games**: chess, minesweeper, snake, text adventures

## Process
1. **Concept** — capture the essence: colors, fonts, textures, era
2. **Structure** — taskbar/dock, desktop area, window manager
3. **Window management** — drag (parseFloat!), resize (per-window min), close/minimize/focus
4. **Components** — chat with thinking dots, calculator, file manager, editor
5. **Extensions** — use patches for new features, never regenerate entire UI
6. **Polish** — scrollbar styling, hover states, CSS variables for theming
