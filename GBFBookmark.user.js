// ==UserScript==
// @name         GBF Panel Pro
// @namespace    gbf.panel.pro
// @version      7.1.10
// @match        *://steam.granbluefantasy.com/*
// @match        *://gbf.game.mbga.jp/*
// @match        *://game.granbluefantasy.jp/*
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  if (document.getElementById('gbf-panel')) return;

  const KEY = 'gbf-panel-v15';
  const DATA_KEY = 'gbf-panel-v16-data';
  const STATE_KEY = 'gbf-panel-v16-state';
  const PANEL_W = 150;
  const IDLE_THIN = 13;
  const DOCK_SNAP = 6;
  const EDGES = ['left', 'right', 'top', 'bottom'];
  const state = { x: 50, y: 120, activeList: 'raid', dockEdge: null,
    opacity: 100, idleSec: 5, idleMode: false, keymapEnabled: false, collapsed: false, pinned: false };
  let data = {
    main: [{ name: '首页', url: '#mypage', keymap: '' }],
    raid: [{ name: 'EX+', url: '#quest/ex', keymap: '' }, { name: 'HELL', url: '#quest/hell', keymap: '' }]
  };
  let panel, settingsOpen = false, idleActive = false, hovering = false, drag = null;
  let idleTimer = null, idleDeadline = null, idleGeneration = 0, layoutFrame = 0, suppressClickUntil = 0;
  let windowFocused = document.hasFocus();
  let storageBlocked = false, dataSnapshot = null, dialogSnapshot = null;
  let dialogReturnFocus = null;
  let lastWidth = PANEL_W, lastHeight = 0;

  function notify(message) {
    let notice = document.getElementById('gbf-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'gbf-notice';
      notice.setAttribute('role', 'alert');
      notice.style.cssText = 'position:fixed;top:8px;left:8px;max-width:420px;padding:10px;background:#522;color:white;z-index:10000001;font:13px sans-serif;';
      document.documentElement.appendChild(notice);
    }
    notice.textContent = message;
    return false;
  }

  function normalizeData(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('书签数据格式错误');
    const result = { main: [], raid: [] };
    for (const list of ['main', 'raid']) {
      if (!Array.isArray(value[list])) continue;
      result[list] = value[list].filter(item => item && typeof item === 'object' &&
        typeof item.name === 'string' && typeof item.url === 'string').map(item => ({
          name: item.name, url: item.url, keymap: typeof item.keymap === 'string' ? item.keymap : ''
        }));
    }
    return result;
  }

  function clampValue(value, min, max) { return Math.min(Math.max(value, min), max); }
  function sanitizeState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of ['x', 'y']) if (Number.isFinite(value[key])) state[key] = value[key];
    if (value.activeList === 'main' || value.activeList === 'raid') state.activeList = value.activeList;
    state.dockEdge = value.docked === false ? null : EDGES.includes(value.dockEdge) ? value.dockEdge : null;
    for (const key of ['idleMode', 'keymapEnabled', 'pinned']) if (typeof value[key] === 'boolean') state[key] = value[key];
    if (Number.isFinite(value.opacity)) state.opacity = clampValue(value.opacity, 10, 100);
    if (Number.isFinite(value.idleSec)) state.idleSec = clampValue(value.idleSec, 1, 15);
    state.collapsed = value.collapsed === true && state.idleMode && !!state.dockEdge;
  }

  function load() {
    try {
      const savedData = localStorage.getItem(DATA_KEY), savedState = localStorage.getItem(STATE_KEY);
      if (savedData !== null) data = normalizeData(JSON.parse(savedData));
      if (savedState !== null) sanitizeState(JSON.parse(savedState));
      if (savedData === null || savedState === null) {
        const legacyRaw = localStorage.getItem(KEY);
        const legacy = legacyRaw === null ? {} : JSON.parse(legacyRaw);
        if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error('旧书签数据格式错误');
        if (savedData === null && legacy.data !== undefined) data = normalizeData(legacy.data);
        if (savedState === null) sanitizeState(legacy.state);
        // Keep the legacy value untouched; partial migration can be retried safely.
        if (savedData === null) localStorage.setItem(DATA_KEY, JSON.stringify(data));
        if (savedState === null) localStorage.setItem(STATE_KEY, JSON.stringify(state));
      }
      dataSnapshot = localStorage.getItem(DATA_KEY);
    } catch (error) {
      storageBlocked = true;
      notify('读取或迁移失败，原始数据已保留，暂停保存：' + error.message);
    }
  }

  function saveState() {
    if (storageBlocked) return notify('数据读取失败，暂时无法保存。原始数据未被覆盖。');
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); return true; }
    catch (error) { return notify('设置保存失败：' + error.message); }
  }

  function saveData(next, expected) {
    if (storageBlocked) return notify('数据读取失败，暂时无法保存。原始数据未被覆盖。');
    try {
      if (localStorage.getItem(DATA_KEY) !== expected) return notify('其他分页已修改书签。输入已保留，请关闭后重新打开编辑。');
      const raw = JSON.stringify(next);
      // ponytail: simultaneous edits are last-write-wins; transactional storage if collaborative editing is needed.
      localStorage.setItem(DATA_KEY, raw);
      data = next;
      dataSnapshot = raw;
      render(panel);
      return true;
    } catch (error) { return notify('书签保存失败，输入已保留：' + error.message); }
  }

  function bindStorage() {
    window.addEventListener('storage', event => {
      if (event.storageArea !== localStorage || (event.key !== DATA_KEY && event.key !== null)) return;
      try {
        const raw = localStorage.getItem(DATA_KEY);
        if (raw === null) throw new Error('书签数据已被移除，请重新载入');
        data = normalizeData(JSON.parse(raw));
        dataSnapshot = raw;
        removeCtxMenu();
        render(panel);
        if (dialogSnapshot !== null) notify('其他分页已修改书签。当前输入已保留，请关闭后重新打开编辑。');
      } catch (error) { storageBlocked = true; notify('同步失败，暂停保存：' + error.message); }
    });
  }

  function safeURL(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.trim(), location.href);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }

  function navigate(item) {
    const url = safeURL(item.url);
    if (!url) return notify('该书签不是有效的 HTTP(S) 或游戏路径，请编辑网址。');
    location.href = url;
    return true;
  }

  // state.x/y are viewport coordinates for the EXPANDED panel, never the idle strip.
  function layout() {
    if (!panel) return;
    const shell = panel.querySelector('.panel-shell');
    const rect = shell.getBoundingClientRect();
    const scale = rect.width / PANEL_W || 1;
    const cw = document.documentElement.clientWidth, ch = document.documentElement.clientHeight;
    shell.style.maxHeight = Math.max(1, ch / scale) + 'px';
    const height = shell.getBoundingClientRect().height;
    const width = PANEL_W * scale;
    lastWidth = width; lastHeight = height;
    if (!drag?.moved) {
      state.x = clampValue(state.x, 0, Math.max(0, cw - width));
      state.y = clampValue(state.y, 0, Math.max(0, ch - height));
      if (state.dockEdge === 'left') state.x = 0;
      if (state.dockEdge === 'right') state.x = Math.max(0, cw - width);
      if (state.dockEdge === 'top') state.y = 0;
      if (state.dockEdge === 'bottom') state.y = Math.max(0, ch - height);
    }
    const collapsed = idleActive && !panelEngaged() && !interactionOpen();
    const vertical = state.dockEdge === 'left' || state.dockEdge === 'right';
    let x = state.x, y = state.y;
    if (collapsed && state.dockEdge === 'right') x = Math.max(0, cw - IDLE_THIN * scale);
    if (collapsed && state.dockEdge === 'bottom') y = Math.max(0, ch - IDLE_THIN * scale);
    panel.style.width = (collapsed && vertical ? IDLE_THIN : PANEL_W) + 'px';
    panel.style.height = (collapsed && !vertical ? IDLE_THIN : height / scale) + 'px';
    panel.style.transform = 'none';
    panel.style.left = '0px'; panel.style.top = '0px';
    const origin = panel.getBoundingClientRect();
    panel.style.left = (x - origin.left) / scale + 'px';
    panel.style.top = (y - origin.top) / scale + 'px';
    panel.style.opacity = state.opacity / 100;
    panel.style.visibility = 'visible';
    panel.className = collapsed && state.dockEdge ? 'idle-' + state.dockEdge : '';
    panel.dataset.dockEdge = state.dockEdge || '';
    panel.querySelector('.title').classList.toggle('idle-mode-on', state.idleMode);
    panel.querySelector('.title').setAttribute('aria-pressed', String(state.idleMode));
    panel.dataset.pinned = String(state.pinned);
    const pin = panel.querySelector('.pin');
    pin.setAttribute('aria-pressed', String(state.pinned));
    pin.title = state.pinned ? '解除固定' : '固定位置';
    pin.setAttribute('aria-label', pin.title);
    shell.inert = collapsed;
    shell.setAttribute('aria-hidden', String(collapsed));
    // Persist what is visible, including temporary hover/focus expansion.
    if (state.collapsed !== collapsed) { state.collapsed = collapsed; saveState(); }
  }

  function scheduleLayout() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; layout(); });
  }

  function dockAfterDrag() {
    const cw = document.documentElement.clientWidth, ch = document.documentElement.clientHeight;
    state.dockEdge = state.x <= DOCK_SNAP ? 'left' :
      state.x + lastWidth >= cw - DOCK_SNAP ? 'right' :
      state.y <= DOCK_SNAP ? 'top' : state.y + lastHeight >= ch - DOCK_SNAP ? 'bottom' : null;
  }

  function interactionOpen() {
    return !!(drag || settingsOpen || document.getElementById('gbf-dialog-overlay') || document.getElementById('gbf-ctx'));
  }
  function pageActive() { return windowFocused && !document.hidden; }
  function panelEngaged() { return pageActive() && (hovering || panel?.contains(document.activeElement)); }
  function clearIdleTimer() {
    clearTimeout(idleTimer); idleTimer = null; idleDeadline = null; idleGeneration++;
  }
  function startIdleTimer(restart = false) {
    if (restart) clearIdleTimer();
    if (!state.idleMode || !state.dockEdge || idleActive || panelEngaged() || interactionOpen()) {
      clearIdleTimer(); return;
    }
    // Keep the same deadline across window focus and visibility changes.
    if (idleDeadline === null) idleDeadline = Date.now() + state.idleSec * 1000;
    const remaining = idleDeadline - Date.now();
    if (remaining <= 0) {
      clearIdleTimer(); idleActive = true; layout(); return;
    }
    if (idleTimer !== null) return;
    const generation = idleGeneration;
    idleTimer = setTimeout(() => {
      if (generation !== idleGeneration) return;
      idleTimer = null; startIdleTimer();
    }, remaining);
  }
  function wake() { clearIdleTimer(); idleActive = false; layout(); }
  function toggleIdleMode() {
    state.idleMode = !state.idleMode;
    wake(); saveState(); startIdleTimer();
  }

  /* ─── render ────────────────────────────────────── */
  function makeAction(el) {
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.addEventListener('keydown', event => {
      if (event.target === el && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); event.stopPropagation(); el.click();
      }
    });
  }

  function render(el) {
    const list = data[state.activeList];
    const box = el.querySelector('.menu');
    box.replaceChildren();
    list.forEach((item, i) => {
      const dom = document.createElement('div');
      dom.className = 'item'; dom.dataset.i = i;
      dom.appendChild(document.createTextNode(item.name));
      if (item.keymap) {
        const tag = document.createElement('span'); tag.className = 'km-tag'; tag.textContent = item.keymap;
        dom.append(' ', tag);
      }
      makeAction(dom);
      dom.addEventListener('click', () => { if (Date.now() >= suppressClickUntil) navigate(item); });
      dom.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); showCtxMenu(event, i, el); });
      box.appendChild(dom);
    });
    const add = document.createElement('div');
    add.className = 'item add-btn'; add.textContent = '＋ 添加书签'; makeAction(add);
    add.onclick = () => { if (Date.now() >= suppressClickUntil) showAddDialog(el); };
    box.appendChild(add);
    el.querySelectorAll('.tabs span').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === state.activeList);
      tab.setAttribute('aria-pressed', String(tab.dataset.tab === state.activeList));
      tab.onclick = () => {
        if (Date.now() < suppressClickUntil) return;
        state.activeList = tab.dataset.tab; saveState(); render(el);
      };
    });
    layout();
  }

  /* ─── context menu ──────────────────────────────── */
  function showCtxMenu(e, idx, panelEl) {
    removeCtxMenu();
    wake();
    const listName = state.activeList, expected = dataSnapshot;
    const menu = document.createElement('div');
    menu.id = 'gbf-ctx';
    menu.innerHTML = `<div class="ctx-item" id="ctx-edit">✏️ 编辑</div>
                      <div class="ctx-item ctx-del" id="ctx-del">🗑️ 删除</div>`;
    menu.style.cssText = 'position:fixed;z-index:9999999;background:#2a2a2a;border:1px solid #555;' +
      'border-radius:5px;padding:3px 0;min-width:100px;font-size:12px;color:#fff;' +
      'box-shadow:0 4px 12px rgba(0,0,0,.4);';
    document.documentElement.appendChild(menu);
    menu.style.left = '0px'; menu.style.top = '0px';
    let mx = e.clientX, my = e.clientY;
    const mr = menu.getBoundingClientRect();
    if (mx + mr.width  > innerWidth)  mx = innerWidth  - mr.width  - 4;
    if (my + mr.height > innerHeight) my = innerHeight - mr.height - 4;
    const scale = mr.width / menu.offsetWidth || 1;
    menu.style.left = (Math.max(0, mx) - mr.left) / scale + 'px';
    menu.style.top = (Math.max(0, my) - mr.top) / scale + 'px';
    menu.querySelector('#ctx-edit').onclick = () => { removeCtxMenu(); showEditDialog(idx, panelEl); };
    menu.querySelector('#ctx-del').onclick  = () => {
      removeCtxMenu();
      const next = structuredClone(data);
      next[listName].splice(idx, 1);
      saveData(next, expected);
    };
    menu.querySelectorAll('.ctx-item').forEach(makeAction);
    menu.querySelector('.ctx-item').focus();
    menu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); removeCtxMenu(); panel.querySelector('.title').focus(); } });
    setTimeout(() => document.addEventListener('click', removeCtxMenu, { once: true }), 0);
  }
  function removeCtxMenu() { document.getElementById('gbf-ctx')?.remove(); if (panel) startIdleTimer(); }

  /* ─── dialogs ───────────────────────────────────── */
  function showEditDialog(idx, panelEl) {
    const listName = state.activeList, item = data[listName][idx], expected = dataSnapshot;
    if (!item) return;
    showDialog({ title: '编辑书签', name: item.name, url: item.url, keymap: item.keymap,
      onConfirm(name, url, keymap) {
        const next = structuredClone(data); next[listName][idx] = { name, url, keymap };
        return saveData(next, expected);
      } });
  }
  function showAddDialog(panelEl) {
    const listName = state.activeList, expected = dataSnapshot;
    showDialog({ title: '添加书签', name: document.title || '', url: location.hash || location.href,
      onConfirm(name, url, keymap) {
        const next = structuredClone(data); next[listName].push({ name, url, keymap });
        return saveData(next, expected);
      } });
  }

  function showDialog({ title, name, url, keymap = '', onConfirm }) {
    removeDialog();
    dialogReturnFocus = document.activeElement;
    dialogSnapshot = dataSnapshot;
    wake();
    const overlay = document.createElement('div');
    overlay.id = 'gbf-dialog-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000000;background:rgba(0,0,0,.5);' +
      'display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:#2a2a2a;border:1px solid #555;border-radius:8px;padding:16px;
        min-width:260px;color:#fff;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.5);">
        <div style="font-weight:bold;margin-bottom:12px;font-size:14px;">${title}</div>
        <div style="margin-bottom:8px;">
          <div style="margin-bottom:4px;color:#aaa;font-size:11px;">名称</div>
          <input id="gbf-d-name" type="text" value="${esc(name)}"
            style="width:100%;box-sizing:border-box;padding:5px 7px;border:1px solid #555;
            border-radius:4px;background:#1a1a1a;color:#fff;font-size:12px;">
        </div>
        <div style="margin-bottom:12px;">
          <div style="margin-bottom:4px;color:#aaa;font-size:11px;">网址</div>
          <input id="gbf-d-url" type="text" value="${esc(url)}"
            style="width:100%;box-sizing:border-box;padding:5px 7px;border:1px solid #555;
            border-radius:4px;background:#1a1a1a;color:#fff;font-size:12px;">
          <div id="gbf-d-fill" style="margin-top:4px;font-size:11px;color:#00bfff;cursor:pointer;">
            📋 读取当前页面
          </div>
        </div>
        <div style="margin-bottom:12px;">
          <div style="margin-bottom:4px;color:#aaa;font-size:11px;">按键映射</div>
          <input id="gbf-d-key" type="text" value="${esc(keymap)}" readonly
            placeholder="点击后按键"
            style="width:74px;height:30px;box-sizing:border-box;padding:5px 7px;border:1px solid #555;
            border-radius:4px;background:#1a1a1a;color:#fff;font-size:12px;cursor:pointer;text-align:center;">
          <div id="gbf-d-key-clear" style="margin-top:4px;font-size:11px;color:#aaa;cursor:pointer;">
            清空映射
          </div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="gbf-d-cancel" style="padding:5px 12px;border:1px solid #555;border-radius:4px;
            background:#333;color:#fff;cursor:pointer;font-size:12px;">取消</button>
          <button id="gbf-d-ok" style="padding:5px 12px;border:none;border-radius:4px;
            background:#00bfff;color:#000;cursor:pointer;font-weight:bold;font-size:12px;">确定</button>
        </div>
      </div>`;
    document.documentElement.appendChild(overlay);
    const ni = overlay.querySelector('#gbf-d-name');
    const ui = overlay.querySelector('#gbf-d-url');
    const ki = overlay.querySelector('#gbf-d-key');
    const kc = overlay.querySelector('#gbf-d-key-clear');
    let awaitingKey = false, capturedMouse = false;
    let keyValue = keymap || '';
    overlay.querySelector('#gbf-d-fill').onclick   = () => { ni.value = document.title||''; ui.value = location.hash||location.href; };
    ki.onclick = () => {
      awaitingKey = true;
      ki.value = '等待输入...';
      ki.style.color = '#00bfff';
      ki.focus();
    };
    kc.onclick = () => {
      keyValue = '';
      ki.value = '';
      ki.style.color = '#fff';
      awaitingKey = false;
    };
    const capture = e => {
      if (!awaitingKey) return;
      e.preventDefault();
      e.stopPropagation();
      const text = describeBinding(e);
      if (!text) { ki.value = '请按单键'; return; }
      capturedMouse = e.type === 'mousedown' && e.button === 0;
      keyValue = text;
      ki.value = text;
      ki.style.color = '#fff';
      awaitingKey = false;
    };
    overlay.addEventListener('keydown', capture, true);
    overlay.addEventListener('mousedown', capture, true);
    overlay.addEventListener('click', event => {
      if (capturedMouse) { capturedMouse = false; event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    overlay.addEventListener('contextmenu', event => event.preventDefault());
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !awaitingKey) { event.preventDefault(); event.stopPropagation(); removeDialog(); }
      if (event.key !== 'Tab') return;
      const items = [...overlay.querySelectorAll('input,button,[tabindex="0"]')];
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    [ni, ui, ki].forEach((input, index) => input.setAttribute('aria-label', ['名称', '网址', '按键映射'][index]));
    makeAction(overlay.querySelector('#gbf-d-fill'));
    makeAction(kc);
    overlay.querySelector('#gbf-d-cancel').onclick = removeDialog;
    overlay.querySelector('#gbf-d-ok').onclick     = () => {
      const n=ni.value.trim(), u=ui.value.trim();
      if (!n || !u) return notify('请填写名称和网址。');
      if (!safeURL(u)) return notify('仅支持 HTTP(S)、相对网址或 # 游戏路径。');
      if (onConfirm(n, u, keyValue.trim())) removeDialog();
    };
    overlay.addEventListener('click', e => { if (e.target===overlay) removeDialog(); });
    ni.focus(); ni.select();
  }
  function removeDialog() {
    const overlay = document.getElementById('gbf-dialog-overlay');
    if (!overlay) return;
    overlay.remove(); dialogSnapshot = null;
    const target = dialogReturnFocus?.isConnected ? dialogReturnFocus : panel.querySelector('.title');
    target.focus({ preventScroll: true });
    dialogReturnFocus = null; startIdleTimer();
  }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

  function describeBinding(e) {
    if (e.altKey || e.ctrlKey || e.metaKey ||
        ['Control', 'Alt', 'Meta', 'Shift', 'AltGraph'].includes(e.key)) return '';
    if (e.type === 'mousedown' || e.type === 'mouseup' || e.type === 'auxclick') return describeMouseButton(e.button);
    const key = e.key;
    const code = e.code || '';
    const map = {
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
      Escape: 'Esc', ' ': 'Space'
    };
    if (!e.isComposing && e.keyCode !== 229 && map[key]) return map[key];
    if (/^Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)$/.test(code)) return describeNumpad(code);
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    if (map[code]) return map[code];
    if (['Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown'].includes(code)) return code;
    if (e.isComposing || e.keyCode === 229 || ['Dead', 'Process'].includes(key)) return '';
    if (map[key]) return map[key];
    if (/^F\d{1,2}$/.test(key)) return key;
    if (key && key.length === 1) return key.toUpperCase();
    return key || code || '';
  }

  function describeMouseButton(button) {
    if (button === 0) return '鼠标左键';
    if (button === 1) return '鼠标中键';
    if (button === 2) return '鼠标右键';
    if (button === 3) return '鼠标侧键1';
    if (button === 4) return '鼠标侧键2';
    if (button === 5) return '鼠标侧键3';
    if (button === 6) return '鼠标侧键4';
    if (button === 7) return '鼠标侧键5';
    if (button === 8) return '鼠标侧键6';
    if (button === 9) return '鼠标侧键7';
    return button >= 0 ? '鼠标键' + button : '';
  }

  function describeNumpad(code) {
    const map = {
      NumpadAdd: 'Num+',
      NumpadSubtract: 'Num-',
      NumpadMultiply: 'Num*',
      NumpadDivide: 'Num/',
      NumpadDecimal: 'Num.',
      NumpadEnter: 'NumEnter'
    };
    return map[code] || ('Num' + code.replace('Numpad', ''));
  }

  function bindingTargetBlocked(target, keyboard) {
    return !!(document.getElementById('gbf-dialog-overlay') || document.getElementById('gbf-ctx') ||
      target?.isContentEditable || target?.closest?.('input,button,select,textarea,.settings,#gbf-dialog-overlay,#gbf-ctx') ||
      (!keyboard && target?.closest?.('#gbf-panel')));
  }

  function findBinding(text) {
    if (!text) return null;
    for (const listName of Object.keys(data)) {
      const list = data[listName];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (item && item.keymap === text && item.url) return item;
      }
    }
    return null;
  }

  function bindShortcuts() {
    function trigger(event) {
      const keyboard = event.type === 'keydown';
      if (!state.keymapEnabled || event.repeat || drag || Date.now() < suppressClickUntil || bindingTargetBlocked(event.target, keyboard)) return;
      // Capture runs before makeAction: reserve its activation keys explicitly.
      if (keyboard && (event.key === 'Enter' || event.key === ' ' || event.code === 'Enter' || event.code === 'NumpadEnter' || event.code === 'Space') &&
          event.target?.closest?.('#gbf-panel [role=button]')) return;
      const item = findBinding(describeBinding(event));
      if (!item) return;
      if (!safeURL(item.url)) { navigate(item); return; }
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      navigate(item);
    }
    window.addEventListener('keydown', trigger, true);
    document.addEventListener('mouseup', trigger);
  }

  /* ─── settings ──────────────────────────────────── */
  function toggleSettings(el) {
    wake();
    const box = el.querySelector('.settings');
    settingsOpen = !settingsOpen;
    if (!settingsOpen) { box.replaceChildren(); layout(); startIdleTimer(); return; }
    box.innerHTML = `
      <div class="row">透明度 <span id="opv">${state.opacity}</span>
        <input id="op" type="range" min="10" max="100" value="${state.opacity}"></div>
      <div class="row">待机 <span id="iv">${state.idleSec}</span>s
        <input id="idle" type="range" min="1" max="15" value="${state.idleSec}"></div>
      <label class="row keymap-toggle">
        <input id="keymap-enabled" type="checkbox" ${state.keymapEnabled ? 'checked' : ''}>
        <span>开启按键映射</span>
      </label>`;
    box.querySelector('#op').oninput   = () => { state.opacity = +box.querySelector('#op').value;   box.querySelector('#opv').textContent=state.opacity;   layout(); saveState(); };
    box.querySelector('#idle').oninput = () => { state.idleSec = +box.querySelector('#idle').value; box.querySelector('#iv').textContent=state.idleSec; saveState(); startIdleTimer(true); };
    box.querySelector('#op').setAttribute('aria-label', '透明度');
    box.querySelector('#idle').setAttribute('aria-label', '待机秒数');
    layout();
    box.querySelector('#keymap-enabled').onchange = () => { state.keymapEnabled = box.querySelector('#keymap-enabled').checked; saveState(); };
  }

  /* ─── create ────────────────────────────────────── */
  function create() {
    // Restore only the intent; layout measures content before the first visible frame.
    idleActive = state.collapsed;
    panel = document.createElement('div'); panel.id = 'gbf-panel';
    panel.innerHTML = '<div class="panel-shell"><div class="panel-header"><div class="title">GBF Tools</div>' +
      '<button type="button" class="pin"><svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l-1 7 4 4v2H6v-2l4-4-1-7zM12 16v5"/></svg></button></div>' +
      '<div class="panel-content"><div class="tabs"><span data-tab="main">主</span>' +
      '<span data-tab="raid">副本</span></div><div class="menu"></div><div class="settings"></div></div></div>';
    // Outside the game body: body transforms/zoom must not become the fixed containing block.
    document.documentElement.appendChild(panel);
    makeAction(panel.querySelector('.title'));
    panel.querySelectorAll('.tabs span').forEach(makeAction);
    bind(panel); render(panel);
    let observer;
    try {
      observer = new ResizeObserver(scheduleLayout);
      observer.observe(panel.querySelector('.panel-shell'));
      observer.observe(document.documentElement);
    } catch (error) {
      observer?.disconnect();
      notify('面板尺寸监听不可用，窗口缩放及收纳功能仍可使用：' + error.message);
    }
    startIdleTimer();
  }

  function bind(el) {
    const title = el.querySelector('.title');
    const pin = el.querySelector('.pin');
    pin.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return;
      if (el.contains(document.activeElement)) document.activeElement.blur();
      event.preventDefault();
    });
    pin.addEventListener('click', () => {
      if (Date.now() < suppressClickUntil) return;
      endDrag();
      state.pinned = !state.pinned;
      layout(); saveState(); startIdleTimer();
    });
    function endDrag() {
      if (!drag) return;
      const completed = drag; drag = null;
      if (completed.moved) {
        suppressClickUntil = Date.now() + 250;
        dockAfterDrag();
      }
      if (el.hasPointerCapture(completed.id)) el.releasePointerCapture(completed.id);
      document.body.style.userSelect = completed.userSelect;
      hovering = el.matches(':hover');
      layout();
      if (completed.moved) saveState();
      startIdleTimer();
    }
    el.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary || event.target.closest('input,button,select,textarea,.settings')) return;
      wake();
      // Focus remains available for keyboard users; mouse clicks must not pin the panel open.
      if (el.contains(document.activeElement)) document.activeElement.blur();
      event.preventDefault();
      if (state.pinned) return;
      drag = { id: event.pointerId, px: event.clientX, py: event.clientY, x: state.x, y: state.y,
        moved: false, userSelect: document.body.style.userSelect };
    });
    window.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!(event.buttons & 1)) { endDrag(); return; }
      const dx = event.clientX - drag.px, dy = event.clientY - drag.py;
      if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      if (!drag.moved) { drag.moved = true; el.setPointerCapture(event.pointerId); document.body.style.userSelect = 'none'; }
      state.x = drag.x + dx; state.y = drag.y + dy;
      layout();
    });
    window.addEventListener('pointerup', event => { if (event.pointerId === drag?.id) endDrag(); });
    window.addEventListener('pointercancel', event => { if (event.pointerId === drag?.id) endDrag(); });
    el.addEventListener('lostpointercapture', endDrag);
    function updateActivity() {
      if (!pageActive()) {
        hovering = false;
        if (!state.collapsed) idleActive = false;
        endDrag();
      } else hovering = el.matches(':hover');
      startIdleTimer(); layout();
    }
    window.addEventListener('blur', () => { windowFocused = false; updateActivity(); });
    window.addEventListener('focus', () => { windowFocused = true; updateActivity(); });
    document.addEventListener('visibilitychange', () => { windowFocused = document.hasFocus(); updateActivity(); });
    el.addEventListener('mouseenter', () => { hovering = true; if (pageActive()) clearIdleTimer(); layout(); });
    el.addEventListener('mouseleave', () => { hovering = false; layout(); startIdleTimer(); });
    el.addEventListener('focusin', () => { if (pageActive()) clearIdleTimer(); layout(); });
    el.addEventListener('focusout', () => { requestAnimationFrame(() => { layout(); startIdleTimer(); }); });
    title.addEventListener('click', () => { if (Date.now() >= suppressClickUntil) toggleIdleMode(); });
    title.addEventListener('contextmenu', event => { event.preventDefault(); wake(); toggleSettings(el); });
    function onPageNavigation() {
      if (state.collapsed) return;
      wake(); startIdleTimer();
    }
    window.addEventListener('hashchange', onPageNavigation);
    window.addEventListener('popstate', onPageNavigation);
    window.addEventListener('resize', scheduleLayout);
  }

  /* ─── style ─────────────────────────────────────── */
  function style() {
    const s = document.createElement('style');
    s.textContent = `
#gbf-panel{position:fixed;left:0;top:0;width:${PANEL_W}px;visibility:hidden;background:#1e1e1e;color:#fff;font:12px Arial,sans-serif;z-index:999999;border-radius:6px;box-shadow:0 6px 18px #0005;overflow:hidden;touch-action:none;box-sizing:border-box;}
#gbf-panel .panel-shell{width:${PANEL_W}px;display:flex;flex-direction:column;box-sizing:border-box;}
#gbf-panel .panel-header{display:flex;flex:none;background:#333;border-radius:0 0 4px 4px;overflow:hidden;}
#gbf-panel .title{flex:1;min-width:0;background:#333;padding:6px;text-align:center;cursor:grab;border-radius:0 0 4px 4px;font-weight:bold;user-select:none;}
#gbf-panel .title.idle-mode-on{color:#00bfff;background:linear-gradient(135deg,#333,#004466);}
#gbf-panel .pin{display:flex;align-items:center;justify-content:center;flex:none;width:26px;margin:0;padding:0;border:0;background:transparent;color:#aaa;cursor:pointer;}
#gbf-panel .pin[aria-pressed=true]{color:#00bfff;}
#gbf-panel[data-pinned=true] .title{cursor:pointer;}
#gbf-panel .pin:focus-visible{outline:2px solid #00bfff;outline-offset:-2px;}
#gbf-panel .panel-content{min-height:0;overflow:auto;padding-top:3px;}
#gbf-panel [role=button]:focus-visible{outline:2px solid #00bfff;outline-offset:-2px;}
#gbf-panel .item{overflow-wrap:anywhere;}
#gbf-panel .tabs{display:flex;gap:4px;background:#1e1e1e;padding:0 3px 3px;}
#gbf-panel .tabs span{flex:1;text-align:center;padding:5px;background:#444;cursor:pointer;border-radius:4px;}
#gbf-panel .tabs span.active{background:#fff;color:#000;}
#gbf-panel .menu{padding:0;}
#gbf-panel .item{display:block;width:100%;box-sizing:border-box;background:#555;margin:0;padding:6px;text-align:center;cursor:pointer;border-radius:0;border-bottom:2px solid #1e1e1e;transition:background .2s;}
#gbf-panel .item:last-child{border-bottom:none;}
#gbf-panel .item:hover{background:#666;}
#gbf-panel .add-btn{background:#2a4a2a;color:#8f8;}
#gbf-panel .add-btn:hover{background:#3a5a3a;}
#gbf-panel .settings{background:#222;padding:6px;}
#gbf-panel .settings:empty{display:none;}
#gbf-panel .row{margin:6px 0;font-size:11px;}
#gbf-panel .row input[type=range]{width:100%;margin-top:3px;}
#gbf-panel .keymap-toggle{display:flex;align-items:center;gap:6px;}
#gbf-panel .keymap-toggle input{margin:0;}
#gbf-panel .km-tag{font-size:10px;color:#9ad;opacity:.9;float:right;}
#gbf-ctx .ctx-item{padding:6px 14px;cursor:pointer;}
#gbf-ctx .ctx-item:hover{background:#444;}
#gbf-ctx .ctx-del{color:#f88;}


#gbf-panel[class^=idle-] .panel-shell{visibility:hidden;pointer-events:none;}
#gbf-panel[class^=idle-]{animation:gbf-idle-pulse 2s ease-in-out infinite;}
@keyframes gbf-idle-pulse{0%,100%{filter:brightness(1)}50%{filter:brightness(1.3)}}
@media (prefers-reduced-motion:reduce){#gbf-panel[class^=idle-]{animation:none;}}
#gbf-panel.idle-left{border-radius:0 5px 5px 0;background:linear-gradient(90deg,#00bfffe6,#00bfff80);box-shadow:3px 0 10px #00bfff66;}
#gbf-panel.idle-right{border-radius:5px 0 0 5px;background:linear-gradient(270deg,#00bfffe6,#00bfff80);box-shadow:-3px 0 10px #00bfff66;}
#gbf-panel.idle-top{border-radius:0 0 5px 5px;background:linear-gradient(180deg,#00bfffe6,#00bfff80);box-shadow:0 3px 10px #00bfff66;}
#gbf-panel.idle-bottom{border-radius:5px 5px 0 0;background:linear-gradient(0deg,#00bfffe6,#00bfff80);box-shadow:0 -3px 10px #00bfff66;}
#gbf-dialog-overlay>div{max-height:90vh;overflow:auto;box-sizing:border-box;max-width:95vw;}
`;
    document.head.appendChild(s);
  }

  function init() { load(); bindShortcuts(); style(); create(); bindStorage(); }
  init();
})();
