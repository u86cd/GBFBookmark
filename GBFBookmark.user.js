// ==UserScript==
// @name         GBFBookmark
// @namespace    GBFBookmark
// @version      7.1.12
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
  const DEFAULT_PANEL_TITLE = 'Bookmark';
  const DEFAULT_TAB_NAMES = { main: '主', raid: '副本' };
  const INTERFACE_OPTIONS = { hideLeftToolbar: '隱藏左工具欄', hideRightToolbar: '隱藏右工具欄' };
  const DIALOG_CONTROLS = 'input:not([disabled]),button:not([disabled]),[tabindex="0"]';
  const state = { x: 50, y: 120, activeList: 'raid', dockEdge: null,
    opacity: 100, idleSec: 5, idleMode: false, keymapEnabled: false, collapsed: false, pinned: false,
    hideLeftToolbar: false, hideRightToolbar: false };
  let data = {
    panelTitle: DEFAULT_PANEL_TITLE,
    tabNames: { ...DEFAULT_TAB_NAMES },
    main: [{ name: '首頁', url: '#mypage', keymap: '' }],
    raid: [{ name: 'EX+', url: '#quest/ex', keymap: '' }, { name: 'HELL', url: '#quest/hell', keymap: '' }]
  };
  let panel, settingsOpen = false, idleActive = false, hovering = false, drag = null;
  let idleTimer = null, idleDeadline = null, idleGeneration = 0, layoutFrame = 0, suppressClickUntil = 0;
  let windowFocused = document.hasFocus();
  let storageBlocked = false, dataSnapshot = null, dialogSnapshot = null;
  let dialogReturnFocus = null;
  let toolbarObserver = null;
  let lastWidth = PANEL_W, lastHeight = 0;

  function clearNotice(scope) {
    const notice = document.getElementById('gbf-notice');
    if (notice?.dataset.scope === scope) notice.remove();
  }

  function notify(message, scope = 'system') {
    let notice = document.getElementById('gbf-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'gbf-notice';
      notice.setAttribute('role', 'alert');
      notice.style.cssText = 'position:fixed;top:8px;left:8px;max-width:420px;padding:10px;background:#522;color:white;z-index:10000001;font:13px sans-serif;';
      document.documentElement.appendChild(notice);
    }
    notice.dataset.scope = scope;
    const text = document.createElement('span'); text.textContent = message;
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '關閉提示');
    close.style.cssText = 'margin-left:8px;cursor:pointer;';
    close.onclick = () => {
      const focused = document.activeElement === close;
      notice.remove();
      if (focused) (document.getElementById('gbf-dialog-overlay')?.querySelector(DIALOG_CONTROLS) || panel?.querySelector('.title'))?.focus();
    };
    close.onkeydown = event => {
      const overlay = document.getElementById('gbf-dialog-overlay');
      if (overlay && event.key === 'Tab') {
        event.preventDefault();
        const items = overlay.querySelectorAll(DIALOG_CONTROLS);
        (event.shiftKey ? items[items.length - 1] : items[0])?.focus();
      }
      if (overlay && event.key === 'Escape') { event.preventDefault(); removeDialog(); }
    };
    notice.replaceChildren(text, close);
    return false;
  }

  function normalizeData(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('書籤資料格式錯誤');
    const result = { main: [], raid: [], tabNames: { ...DEFAULT_TAB_NAMES },
      panelTitle: typeof value.panelTitle === 'string' && value.panelTitle.trim() ? value.panelTitle.trim() : DEFAULT_PANEL_TITLE };
    for (const list of ['main', 'raid']) {
      if (typeof value.tabNames?.[list] === 'string' && value.tabNames[list].trim()) result.tabNames[list] = value.tabNames[list].trim();
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
    for (const key of ['idleMode', 'keymapEnabled', 'pinned', ...Object.keys(INTERFACE_OPTIONS)]) if (typeof value[key] === 'boolean') state[key] = value[key];
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
        if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error('舊書籤資料格式錯誤');
        if (savedData === null && legacy.data !== undefined) data = normalizeData(legacy.data);
        if (savedState === null) sanitizeState(legacy.state);
        // Keep the legacy value untouched; partial migration can be retried safely.
        if (savedData === null) localStorage.setItem(DATA_KEY, JSON.stringify(data));
        if (savedState === null) localStorage.setItem(STATE_KEY, JSON.stringify(state));
      }
      dataSnapshot = localStorage.getItem(DATA_KEY);
    } catch (error) {
      storageBlocked = true;
      notify('讀取或遷移失敗，原始資料已保留，暫停保存：' + error.message);
    }
  }

  function readStoredState() {
    const value = JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('設定資料格式錯誤');
    return value;
  }

  function interfaceValues(value) {
    return { hideLeftToolbar: value.hideLeftToolbar === true, hideRightToolbar: value.hideRightToolbar === true };
  }

  function syncInterfaceSettings(value) {
    const options = interfaceValues(value);
    const changed = Object.keys(options).some(key => state[key] !== options[key]);
    Object.assign(state, options);
    for (const key of Object.keys(options)) {
      const input = document.getElementById('gbf-' + key);
      if (input) input.checked = state[key];
    }
    if (changed) applyToolbarVisibility();
  }

  function saveState(interfaceChange = null) {
    if (storageBlocked) return notify('資料讀取失敗，暫時無法保存。原始資料未被覆蓋。');
    const scope = interfaceChange ? 'interface' : 'state';
    let next;
    try {
      const latest = readStoredState();
      // Only these shared switches are merged; other panel settings retain their existing behavior.
      next = interfaceChange ? { ...state, ...latest, ...interfaceValues(latest), ...interfaceChange } :
        { ...state, ...interfaceValues(latest) };
      localStorage.setItem(STATE_KEY, JSON.stringify(next));
    } catch (error) { return notify('設定保存失敗：' + error.message, scope); }
    clearNotice(scope);
    syncInterfaceSettings(next);
    return true;
  }

  function saveData(next, expected) {
    if (storageBlocked) return notify('資料讀取失敗，暫時無法保存。原始資料未被覆蓋。');
    try {
      if (localStorage.getItem(DATA_KEY) !== expected) return notify('其他分頁已修改書籤。輸入已保留，請關閉後重新開啟編輯。', 'data');
      const raw = JSON.stringify(next);
      // ponytail: simultaneous edits are last-write-wins; transactional storage if collaborative editing is needed.
      localStorage.setItem(DATA_KEY, raw);
      data = next;
      dataSnapshot = raw;
      clearNotice('data');
      render(panel);
      return true;
    } catch (error) { return notify('書籤保存失敗，輸入已保留：' + error.message, 'data'); }
  }

  function bindStorage() {
    window.addEventListener('storage', event => {
      if (event.storageArea !== localStorage || ![DATA_KEY, STATE_KEY, null].includes(event.key)) return;
      try {
        if (event.key === STATE_KEY || event.key === null) syncInterfaceSettings(readStoredState());
        if (event.key === STATE_KEY) return;
        const raw = localStorage.getItem(DATA_KEY);
        if (raw === null) throw new Error('書籤資料已被移除，請重新載入');
        data = normalizeData(JSON.parse(raw));
        dataSnapshot = raw;
        removeCtxMenu();
        render(panel);
        if (dialogSnapshot !== null) notify('其他分頁已修改書籤。目前輸入已保留，請關閉後重新開啟編輯。', 'data');
      } catch (error) { storageBlocked = true; notify('同步失敗，暫停保存：' + error.message); }
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
    if (!url) return notify('此書籤不是有效的 HTTP(S) 或遊戲路徑，請編輯網址。');
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
  function panelEngaged() { return !document.hidden && (hovering || (windowFocused && panel?.contains(document.activeElement))); }
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
    const title = el.querySelector('.title');
    title.textContent = data.panelTitle;
    title.title = data.panelTitle;
    const list = data[state.activeList];
    const box = el.querySelector('.menu');
    box.replaceChildren();
    list.forEach((item, i) => {
      const dom = document.createElement('div');
      dom.className = 'item'; dom.dataset.i = i;
      dom.appendChild(document.createTextNode(item.name));
      if (item.keymap) {
        const tag = document.createElement('span'); tag.className = 'km-tag'; tag.textContent = bindingLabel(item.keymap);
        dom.append(' ', tag);
      }
      makeAction(dom);
      dom.addEventListener('click', () => { if (Date.now() >= suppressClickUntil) navigate(item); });
      dom.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); showCtxMenu(event, i, el); });
      box.appendChild(dom);
    });
    const add = document.createElement('div');
    add.className = 'item add-btn'; add.textContent = '＋ 新增書籤'; makeAction(add);
    add.onclick = () => { if (Date.now() >= suppressClickUntil) showAddDialog(el); };
    box.appendChild(add);
    el.querySelectorAll('.tabs span').forEach(tab => {
      tab.textContent = data.tabNames[tab.dataset.tab];
      tab.title = tab.textContent;
      tab.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); showCtxMenu(event, null, el, tab.dataset.tab); };
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
  function showCtxMenu(e, idx, panelEl, tabName = null) {
    removeCtxMenu();
    wake();
    const listName = state.activeList, expected = dataSnapshot;
    const menu = document.createElement('div');
    menu.id = 'gbf-ctx';
    menu.innerHTML = tabName ? '<div class="ctx-item" id="ctx-rename">自定義標籤名</div>' : `<div class="ctx-item" id="ctx-edit">✏️ 編輯</div>
                      <div class="ctx-item ctx-del" id="ctx-del">🗑️ 刪除</div>`;
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
    const returnTarget = tabName ? panelEl.querySelector('[data-tab="' + tabName + '"]') : panel.querySelector('.title');
    if (tabName) menu.querySelector('#ctx-rename').onclick = () => { removeCtxMenu(); showRenameDialog(tabName, returnTarget); };
    else {
      menu.querySelector('#ctx-edit').onclick = () => { removeCtxMenu(); showEditDialog(idx, panelEl); };
      menu.querySelector('#ctx-del').onclick  = () => {
        removeCtxMenu();
        const next = structuredClone(data);
        next[listName].splice(idx, 1);
        saveData(next, expected);
      };
    }
    menu.querySelectorAll('.ctx-item').forEach(makeAction);
    menu.querySelector('.ctx-item').focus();
    menu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); removeCtxMenu(); returnTarget.focus(); } });
    setTimeout(() => document.addEventListener('click', removeCtxMenu, { once: true }), 0);
  }
  function removeCtxMenu() { document.getElementById('gbf-ctx')?.remove(); if (panel) startIdleTimer(); }

  /* ─── dialogs ───────────────────────────────────── */
  function validateKeymap(keymap, listName, index = -1) {
    if (!keymap) return true;
    for (const list of ['main', 'raid']) {
      const conflict = data[list].find((item, i) => !(list === listName && i === index) && item.keymap === keymap);
      if (conflict) return notify('此按鍵已用於「' + data.tabNames[list] + '／' + conflict.name + '」，請更換或清空映射。', 'input');
    }
    return true;
  }

  function showRenameDialog(tabName, returnFocus) {
    const expected = dataSnapshot;
    showDialog({ title: '自定義標籤名', name: data.tabNames[tabName], nameOnly: true, returnFocus,
      onConfirm(name) {
        const next = structuredClone(data);
        next.tabNames[tabName] = name || DEFAULT_TAB_NAMES[tabName];
        return saveData(next, expected);
      } });
  }

  function showTitleDialog(returnFocus) {
    const expected = dataSnapshot;
    showDialog({ title: '自定義標題', name: data.panelTitle, nameOnly: true, nameLabel: '標題',
      emptyHint: '留空恢復預設標題 ' + DEFAULT_PANEL_TITLE, returnFocus,
      onConfirm(name) {
        const next = structuredClone(data);
        next.panelTitle = name || DEFAULT_PANEL_TITLE;
        return saveData(next, expected);
      } });
  }

  function showEditDialog(idx, panelEl) {
    const listName = state.activeList, item = data[listName][idx], expected = dataSnapshot;
    if (!item) return;
    showDialog({ title: '編輯書籤', name: item.name, url: item.url, keymap: item.keymap,
      onConfirm(name, url, keymap) {
        if (!validateKeymap(keymap, listName, idx)) return false;
        const next = structuredClone(data); next[listName][idx] = { name, url, keymap };
        return saveData(next, expected);
      } });
  }
  function showAddDialog(panelEl) {
    const listName = state.activeList, expected = dataSnapshot;
    showDialog({ title: '新增書籤', name: document.title || '', url: location.hash || location.href,
      onConfirm(name, url, keymap) {
        if (!validateKeymap(keymap, listName)) return false;
        const next = structuredClone(data); next[listName].push({ name, url, keymap });
        return saveData(next, expected);
      } });
  }

  function createDialog(title, returnFocus, canClose = () => true) {
    removeDialog();
    dialogReturnFocus = returnFocus || document.activeElement;
    clearNotice('input');
    wake();
    const overlay = document.createElement('div');
    overlay.id = 'gbf-dialog-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000000;background:rgba(0,0,0,.5);' +
      'display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `<div><div style="font-weight:bold;margin-bottom:12px;font-size:14px;">${esc(title)}</div></div>`;
    document.documentElement.appendChild(overlay);
    overlay.addEventListener('click', event => { if (event.target === overlay) removeDialog(); });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape' && canClose()) { event.preventDefault(); event.stopPropagation(); removeDialog(); }
      if (event.key !== 'Tab') return;
      const items = overlay.querySelectorAll(DIALOG_CONTROLS);
      const first = items[0], last = items[items.length - 1];
      const noticeClose = document.querySelector('#gbf-notice button');
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); (noticeClose || last).focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); (noticeClose || first).focus(); }
    });
    return overlay;
  }

  function showDialog({ title, name, url = '', keymap = '', onConfirm, nameOnly = false, returnFocus,
    nameLabel = nameOnly ? '標籤名' : '名稱', emptyHint = '留空恢復預設名稱' }) {
    let awaitingKey = false, capturedMouse = false;
    const overlay = createDialog(title, returnFocus, () => !awaitingKey);
    dialogSnapshot = dataSnapshot;
    overlay.firstElementChild.insertAdjacentHTML('beforeend', `
        <div style="margin-bottom:8px;">
          <div style="margin-bottom:4px;color:#aaa;font-size:11px;">${esc(nameLabel)}</div>
          <input id="gbf-d-name" type="text" value="${esc(name)}"
            style="width:100%;box-sizing:border-box;padding:5px 7px;border:1px solid #555;
            border-radius:4px;background:#1a1a1a;color:#fff;font-size:12px;">
        </div>
        <div style="margin-bottom:12px;">
          <div style="margin-bottom:4px;color:#aaa;font-size:11px;">網址</div>
          <input id="gbf-d-url" type="text" value="${esc(url)}"
            style="width:100%;box-sizing:border-box;padding:5px 7px;border:1px solid #555;
            border-radius:4px;background:#1a1a1a;color:#fff;font-size:12px;">
          <div id="gbf-d-fill" style="margin-top:4px;font-size:11px;color:#00bfff;cursor:pointer;">
            📋 讀取目前頁面
          </div>
        </div>
        <div style="margin-bottom:12px;">
          <div style="margin-bottom:4px;color:#aaa;font-size:11px;">按鍵映射</div>
          <div id="gbf-keymap-status" style="max-width:300px;margin-bottom:6px;font-size:11px;color:#aaa;">${state.keymapEnabled ? '按鍵映射已啟用' : '按鍵映射尚未啟用；可在右鍵標題的設定中開啟。'}</div>
          <input id="gbf-d-key" type="text" value="${esc(bindingLabel(keymap))}" readonly
            placeholder="點擊後按鍵"
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
            background:#00bfff;color:#000;cursor:pointer;font-weight:bold;font-size:12px;">確定</button>
        </div>`);
    const ni = overlay.querySelector('#gbf-d-name');
    const ui = overlay.querySelector('#gbf-d-url');
    const ki = overlay.querySelector('#gbf-d-key');
    const kc = overlay.querySelector('#gbf-d-key-clear');
    let keyValue = keymap || '';
    overlay.querySelector('#gbf-d-fill').onclick   = () => { ni.value = document.title||''; ui.value = location.hash||location.href; };
    ki.onclick = () => {
      awaitingKey = true;
      ki.value = '等待輸入...';
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
      if (!text) { ki.value = '請按單鍵'; return; }
      capturedMouse = e.type === 'mousedown' && e.button === 0;
      keyValue = text;
      ki.value = bindingLabel(text);
      ki.style.color = '#fff';
      awaitingKey = false;
    };
    overlay.addEventListener('keydown', capture, true);
    overlay.addEventListener('mousedown', capture, true);
    overlay.addEventListener('click', event => {
      if (capturedMouse) { capturedMouse = false; event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    overlay.addEventListener('contextmenu', event => event.preventDefault());
    [ni, ui, ki].forEach((input, index) => input.setAttribute('aria-label', [nameLabel, '網址', '按鍵映射'][index]));
    makeAction(overlay.querySelector('#gbf-d-fill'));
    makeAction(kc);
    overlay.querySelector('#gbf-d-cancel').onclick = removeDialog;
    overlay.querySelector('#gbf-d-ok').onclick     = () => {
      const n=ni.value.trim(), u=ui.value.trim();
      if (nameOnly) { if (onConfirm(n)) removeDialog(); return; }
      if (!n || !u) return notify('請填寫名稱和網址。', 'input');
      if (!safeURL(u)) return notify('僅支援 HTTP(S)、相對網址或 # 遊戲路徑。', 'input');
      if (onConfirm(n, u, keyValue.trim())) removeDialog();
    };
    if (nameOnly) {
      ui.parentElement.remove(); ki.parentElement.remove();
      const hint = document.createElement('div'); hint.textContent = emptyHint;
      hint.style.cssText = 'margin-top:6px;color:#aaa;font-size:11px;'; ni.after(hint);
      overlay.querySelector('#gbf-d-cancel').textContent = '取消';
      overlay.querySelector('#gbf-d-ok').textContent = '確定';
    }
    ni.focus(); ni.select();
  }
  function removeDialog() {
    const overlay = document.getElementById('gbf-dialog-overlay');
    if (!overlay) return;
    overlay.remove(); dialogSnapshot = null; clearNotice('input');
    const target = dialogReturnFocus?.isConnected ? dialogReturnFocus : panel.querySelector('.title');
    target.focus({ preventScroll: true });
    dialogReturnFocus = null; startIdleTimer();
  }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

  function bindingLabel(value) {
    // Keep legacy binding identifiers in storage; localize only their displayed labels.
    return value.startsWith('鼠标') ? value.replace(/^鼠标/, '滑鼠').replace(/侧/g, '側').replace(/键/g, '鍵') : value;
  }

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

  function bindingTargetBlocked(target) {
    return !!(document.getElementById('gbf-dialog-overlay') || document.getElementById('gbf-ctx') ||
      target?.isContentEditable || target?.closest?.('input,select,textarea,#gbf-panel,#gbf-dialog-overlay,#gbf-ctx,#gbf-notice'));
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
    const keys = new Map(), buttons = new Map();
    let snapshot = dataSnapshot, enabled = state.keymapEnabled;
    function reset() { keys.clear(); buttons.clear(); }
    function mapped(event, text) {
      if (!state.keymapEnabled || event.ctrlKey || event.altKey || event.metaKey || drag || Date.now() < suppressClickUntil || bindingTargetBlocked(event.target)) return null;
      const item = findBinding(text);
      return item && safeURL(item.url) ? item : null;
    }
    function intercept(event) {
      if (snapshot !== dataSnapshot || enabled !== state.keymapEnabled) {
        reset(); snapshot = dataSnapshot; enabled = state.keymapEnabled;
      }
      const type = event.type, pointer = type.startsWith('pointer');
      if ((pointer && event.pointerType !== 'mouse') || event.sourceCapabilities?.firesTouchEvents) return;
      if (type === 'pointercancel') { buttons.clear(); return; }
      const keyboard = type === 'keydown' || type === 'keyup';
      const text = keyboard ? describeBinding(event) : describeMouseButton(event.button);
      const held = keyboard ? keys.get(event.code || text) : null;
      const item = mapped(event, type === 'keyup' && held && !event.ctrlKey && !event.altKey && !event.metaKey ? held.keymap : text);
      let trigger = false;
      if (keyboard) {
        const id = event.code || text;
        if (type === 'keydown' && !event.repeat) { keys.set(id, item); trigger = !!item; }
        const pressed = keys.get(id);
        if (type === 'keyup') keys.delete(id);
        if (!item || pressed !== item) return;
      } else {
        if (type === 'pointerdown' || type === 'mousedown') buttons.set(event.button, { item, released: false });
        const pressed = buttons.get(event.button);
        if (!item || pressed?.item !== item) {
          if (type === 'mouseup') buttons.delete(event.button);
          return;
        }
        if (type === 'mouseup' && !pressed.released) { pressed.released = true; trigger = true; }
      }
      // Cancel compatibility mouse defaults on mousedown; cancelling pointerdown would suppress mouseup.
      if (!pointer && event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      if (trigger) navigate(item);
    }
    for (const type of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) {
      window.addEventListener(type, intercept, true);
    }
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  }

  /* ─── settings ──────────────────────────────────── */
  function applyToolbarVisibility() {
    const game = document.getElementById('mobage-game-container');
    const content = game?.parentElement;
    const left = document.querySelector('._2BWqQOPyLjOBWS8uhzI9ht');
    const right = game?.querySelector('#submenu');
    // These relationships were verified on GBF's Mobage layout; leave unfamiliar layouts untouched.
    const targets = {
      hideLeftToolbar: left && content?.classList.contains('SdEyhW_kE0xoDznTZ5Wr-') &&
        left.nextElementSibling === content && getComputedStyle(content.parentElement).display === 'flex' ? left : null,
      hideRightToolbar: right?.parentElement === game && right?.querySelector(':scope > #cnt-submenu-navi-vertical') ? right : null
    };
    const hidden = Object.keys(targets).filter(key => state[key] && targets[key]).map(key => targets[key]);
    for (const element of document.querySelectorAll('[data-gbf-toolbar-hidden]')) {
      if (!hidden.includes(element)) element.removeAttribute('data-gbf-toolbar-hidden');
    }
    hidden.forEach(element => element.setAttribute('data-gbf-toolbar-hidden', ''));
    const missing = Object.keys(targets).filter(key => state[key] && !targets[key]);
    const notice = document.getElementById('gbf-notice');
    if (!missing.length) clearNotice('toolbar');
    else if (!notice || notice.dataset.scope === 'toolbar') {
      const message = '尚未支援目前的' + missing.map(key => INTERFACE_OPTIONS[key].replace('隱藏', '')).join('、') + '結構，未識別的工具欄已保留顯示。';
      if (notice?.querySelector('span')?.textContent !== message) notify(message, 'toolbar');
    }
    toolbarObserver?.disconnect();
    if (state.hideLeftToolbar || state.hideRightToolbar) {
      toolbarObserver ??= new MutationObserver(applyToolbarVisibility);
      // Watch container replacements, not the game's frequently changing content subtree.
      for (const element of new Set([document.body, game, content, content?.parentElement, left, right])) {
        if (element) toolbarObserver.observe(element, { childList: true, attributes: true, attributeFilter: ['id', 'class', 'style'] });
      }
    }
  }

  function showInterfaceSettings(returnFocus) {
    const overlay = createDialog('界面設置', returnFocus);
    const box = overlay.firstElementChild;
    for (const [key, label] of Object.entries(INTERFACE_OPTIONS)) {
      const row = document.createElement('label');
      row.className = 'gbf-switch-row';
      row.innerHTML = `<span>${label}</span><span class="gbf-switch"><input type="checkbox" role="switch" id="gbf-${key}"><span class="gbf-switch-track" aria-hidden="true"></span></span>`;
      const input = row.querySelector('input');
      input.checked = state[key];
      input.onchange = () => { if (!saveState({ [key]: input.checked })) input.checked = state[key]; };
      box.appendChild(row);
    }
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'gbf-dialog-close'; close.textContent = '關閉'; close.onclick = removeDialog;
    box.appendChild(close);
    applyToolbarVisibility();
    box.querySelector('input').focus();
  }

  function toggleSettings(el) {
    wake();
    const box = el.querySelector('.settings');
    settingsOpen = !settingsOpen;
    if (!settingsOpen) { box.replaceChildren(); layout(); startIdleTimer(); return; }
    box.innerHTML = `
      <div class="row">透明度 <span id="opv">${state.opacity}</span>
        <input id="op" type="range" min="10" max="100" value="${state.opacity}"></div>
      <div class="row">待機 <span id="iv">${state.idleSec}</span>s
        <input id="idle" type="range" min="1" max="15" value="${state.idleSec}"></div>
      <label class="row keymap-toggle">
        <input id="keymap-enabled" type="checkbox" ${state.keymapEnabled ? 'checked' : ''}>
        <span>啟用按鍵映射</span>
      </label>
      <button type="button" class="settings-button" id="gbf-interface-settings">界面設置</button>
      <button type="button" class="settings-button" id="gbf-custom-title">自定義標題</button>`;
    box.querySelector('#op').oninput   = () => { state.opacity = +box.querySelector('#op').value;   box.querySelector('#opv').textContent=state.opacity;   layout(); saveState(); };
    box.querySelector('#idle').oninput = () => { state.idleSec = +box.querySelector('#idle').value; box.querySelector('#iv').textContent=state.idleSec; saveState(); startIdleTimer(true); };
    box.querySelector('#op').setAttribute('aria-label', '透明度');
    box.querySelector('#idle').setAttribute('aria-label', '待機秒數');
    layout();
    box.querySelector('#keymap-enabled').onchange = () => { state.keymapEnabled = box.querySelector('#keymap-enabled').checked; saveState(); };
    const interfaceButton = box.querySelector('#gbf-interface-settings');
    interfaceButton.onclick = () => showInterfaceSettings(interfaceButton);
    const titleButton = box.querySelector('#gbf-custom-title');
    titleButton.onclick = () => showTitleDialog(titleButton);
  }

  /* ─── create ────────────────────────────────────── */
  function create() {
    // Restore only the intent; layout measures content before the first visible frame.
    idleActive = state.collapsed;
    panel = document.createElement('div'); panel.id = 'gbf-panel';
    panel.innerHTML = '<div class="panel-shell"><div class="panel-header"><div class="title"></div>' +
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
      notify('面板尺寸監聽不可用，視窗縮放及收納功能仍可使用：' + error.message);
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
      hovering = pageActive() && el.matches(':hover');
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
    el.addEventListener('mouseenter', () => { hovering = true; if (!document.hidden) clearIdleTimer(); layout(); });
    el.addEventListener('mouseleave', () => { hovering = false; layout(); startIdleTimer(); });
    el.addEventListener('focusin', () => { if (pageActive()) clearIdleTimer(); layout(); });
    el.addEventListener('focusout', () => { requestAnimationFrame(() => { layout(); startIdleTimer(); }); });
    title.addEventListener('click', () => { if (Date.now() >= suppressClickUntil) toggleIdleMode(); });
    title.addEventListener('contextmenu', event => { event.preventDefault(); wake(); toggleSettings(el); });
    window.addEventListener('resize', scheduleLayout);
  }

  /* ─── style ─────────────────────────────────────── */
  function style() {
    const s = document.createElement('style');
    s.textContent = `
#gbf-panel{position:fixed;left:0;top:0;width:${PANEL_W}px;visibility:hidden;background:#1e1e1e;color:#fff;font:12px Arial,sans-serif;z-index:999999;border-radius:6px;box-shadow:0 6px 18px #0005;overflow:hidden;touch-action:none;box-sizing:border-box;}
#gbf-panel .panel-shell{width:${PANEL_W}px;display:flex;flex-direction:column;box-sizing:border-box;}
#gbf-panel .panel-header{display:flex;flex:none;background:#333;border-radius:0 0 4px 4px;overflow:hidden;}
#gbf-panel .title{flex:1;min-width:0;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#333;padding:6px;text-align:center;cursor:grab;border-radius:0 0 4px 4px;font-weight:bold;user-select:none;}
#gbf-panel .title.idle-mode-on{color:#00bfff;background:linear-gradient(135deg,#333,#004466);}
#gbf-panel .pin{display:flex;align-items:center;justify-content:center;flex:none;width:26px;margin:0;padding:0;border:0;background:transparent;color:#aaa;cursor:pointer;}
#gbf-panel .pin[aria-pressed=true]{color:#00bfff;}
#gbf-panel[data-pinned=true] .title{cursor:pointer;}
#gbf-panel .pin:focus-visible{outline:2px solid #00bfff;outline-offset:-2px;}
#gbf-panel .panel-content{min-height:0;overflow:auto;padding-top:3px;}
#gbf-panel [role=button]:focus-visible{outline:2px solid #00bfff;outline-offset:-2px;}
#gbf-panel .item{overflow-wrap:anywhere;}
#gbf-panel .tabs{display:flex;gap:4px;background:#1e1e1e;padding:0 3px 3px;}
#gbf-panel .tabs span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;padding:5px;background:#444;cursor:pointer;border-radius:4px;}
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
#gbf-panel .settings-button{width:100%;margin-top:4px;padding:5px;border:1px solid #555;border-radius:4px;background:#333;color:#fff;cursor:pointer;font:inherit;}
#gbf-panel .settings-button:focus-visible{outline:2px solid #00bfff;outline-offset:2px;}
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
#gbf-dialog-overlay>div{background:#2a2a2a;border:1px solid #555;border-radius:8px;padding:16px;min-width:min(260px,95vw);color:#fff;font:13px Arial,sans-serif;box-shadow:0 8px 24px #0008;max-height:90vh;overflow:auto;box-sizing:border-box;max-width:95vw;}
#gbf-dialog-overlay .gbf-switch-row{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:36px;cursor:pointer;}
#gbf-dialog-overlay .gbf-switch{position:relative;display:inline-block;flex:none;width:38px;height:22px;}
#gbf-dialog-overlay .gbf-switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;}
#gbf-dialog-overlay .gbf-switch-track{position:absolute;inset:0;pointer-events:none;border-radius:11px;background:#666;}
#gbf-dialog-overlay .gbf-switch-track::before{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;}
#gbf-dialog-overlay .gbf-switch input:checked+.gbf-switch-track{background:#00a8df;}
#gbf-dialog-overlay .gbf-switch input:checked+.gbf-switch-track::before{transform:translateX(16px);}
#gbf-dialog-overlay .gbf-switch input:focus-visible+.gbf-switch-track{outline:2px solid #00bfff;outline-offset:3px;}
#gbf-dialog-overlay .gbf-dialog-close{display:block;margin:14px 0 0 auto;padding:5px 12px;border:1px solid #555;border-radius:4px;background:#333;color:#fff;cursor:pointer;font:inherit;}
#gbf-dialog-overlay .gbf-dialog-close:focus-visible{outline:2px solid #00bfff;outline-offset:2px;}
[data-gbf-toolbar-hidden]{display:none!important;}
`;
    document.head.appendChild(s);
  }

  function init() { load(); bindShortcuts(); style(); applyToolbarVisibility(); create(); bindStorage(); }
  init();
})();
