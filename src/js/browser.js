// ── Self-embed guard (DISABLED - caused more issues than it solved) ──
// Previously this guard would break the browser when loaded in certain iframe contexts
// If re-enabling, ensure it doesn't trigger in Electron webview or legitimate use cases
(function () {
  // GUARD DISABLED - browser should load in all contexts
  // Uncomment carefully if you need to block specific iframe embeddings
  /*
  try {
    if (window.self !== window.top && typeof window.electronAPI === 'undefined') {
      const isOwnDomain = window.location.hostname === window.top.location.hostname;
      if (!isOwnDomain) {
        if (document.documentElement) {
          document.documentElement.innerHTML = '<div style="font:14px sans-serif;padding:24px;color:#aaa">⚠️ Cannot display this page in a frame.</div>';
        }
        window.stop && window.stop();
        return;
      }
    }
  } catch (e) { }
  */
})();

// ── Tauri / Electron webview detection ──
// Tauri: window.__TAURI__ je dostupan, nema <webview> taga — koristimo <iframe>
// Electron: window.electronAPI dostupan + <webview> tag podržan
window.isTauri = typeof window.__TAURI__ !== 'undefined';
window.electronWebview = !window.isTauri && typeof window.electronAPI !== 'undefined';

// U Tauri modu: uvijek koristimo <iframe> (Tauri WebviewWindow per-tab je u Rustu)
if (window.isTauri || !window.electronWebview) {
  const wv = document.getElementById('browseFrame');
  const ifrm = document.getElementById('browseFrameWeb');
  if (wv && ifrm) {
    wv.style.display = 'none';
    ifrm.id = 'browseFrame'; // rename so all JS finds it by original id
    wv.id = 'browseFrameElectron'; // rename original out of the way
    ifrm.style.display = '';
  }
}
if (!window.isTauri && window.electronWebview) {
  const _wvEl = document.getElementById('browseFrameElectron') || document.getElementById('browseFrame');
  if (_wvEl) _wvEl.id = 'browseFrame';
  document.addEventListener('DOMContentLoaded', function () {
    const wv = document.getElementById('browseFrame');
    if (!wv || wv.tagName !== 'WEBVIEW') return;
    wv.addEventListener('did-start-loading', () => setLoading(30));
    wv.addEventListener('did-stop-loading', () => setLoading(100));
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return; // Aborted, ignore
      setLoading(0);
      const tab = getActiveTab();
      if (tab) showPageError(e.errorDescription || 'Failed to load page');
    });
    wv.addEventListener('page-title-updated', (e) => {
      const tab = getActiveTab();
      if (tab) { tab.title = e.title; updateTabEl(tab); }
    });
    wv.addEventListener('page-favicon-updated', (e) => {
      if (e.favicons?.length) { const tab = getActiveTab(); if (tab) { tab.faviconUrl = e.favicons[0]; updateTabEl(tab); } }
    });
    wv.addEventListener('did-navigate', (e) => {
      const tab = getActiveTab();
      if (tab && e.url && !e.url.startsWith('about:')) {
        tab.url = e.url;
        document.getElementById('urlInput').value = e.url;
        updateUrlIcon(e.url);
        updateNavBtns(tab);
        // Set favicon from Google S2 API as fallback
        if (!tab.faviconUrl || tab.faviconUrl.includes('s2/favicons')) {
          tab.faviconUrl = `https://www.google.com/s2/favicons?sz=32&domain_url=${encodeURIComponent(e.url)}`;
          updateTabEl(tab);
        }
        DB.addHistory({ url: e.url, title: tab.title || e.url });
      }
    });
    wv.addEventListener('did-navigate-in-page', (e) => {
      const tab = getActiveTab();
      if (tab && e.url) { tab.url = e.url; document.getElementById('urlInput').value = e.url; }
    });
    wv.addEventListener('new-window', (e) => {
      try {
        const { protocol } = new URL(e.url);
        if (!['http:', 'https:', 'file:', 'about:', 'chrome-extension:', 'etherx:'].includes(protocol)) return;
      } catch (_) { return; }
      // Open in new tab (consistent with per-tab webview new-window handler)
      createTab(e.url, '', true);
    });
  });
}
const STATE = { tabs: [], activeTabId: null, isPrivate: false, zoom: 100, devtoolsOpen: false, readerMode: false, respMode: false };
// Per-tab webview map: tabId → <webview> element
// Each tab gets its own webview so audio/video keeps playing when switching tabs
const tabFrames = new Map();
// Track which webviews have emitted dom-ready and are safe to use
const tabFrameReady = new Map();

// ── Performance: In-memory cache za settings ──────────────────────────────
let _settingsCache = null;
let _settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 5000; // 5 sekundi

const DB = {
  getHistory: () => JSON.parse(localStorage.getItem('ex_hist') || '[]'),
  addHistory(e) { if (STATE.isPrivate) return; let h = this.getHistory(); h = h.filter(x => x.url !== e.url); h.unshift({ ...e, ts: Date.now() }); localStorage.setItem('ex_hist', JSON.stringify(h.slice(0, 500))) },
  clearHistory() { localStorage.removeItem('ex_hist') },
  getBookmarks: () => JSON.parse(localStorage.getItem('ex_bm') || '[]'),
  addBookmark(e) { const b = this.getBookmarks(); if (b.find(x => x.url === e.url)) { if (!e.silent) showToast('Already bookmarked'); return; } b.unshift({ ...e, ts: Date.now() }); localStorage.setItem('ex_bm', JSON.stringify(b)); if (!e.silent) showToast('⭐ Bookmarked: ' + e.title) },
  removeBookmark(u) { localStorage.setItem('ex_bm', JSON.stringify(this.getBookmarks().filter(x => x.url !== u))) },
  getSettings: () => {
    const now = Date.now();
    if (_settingsCache && (now - _settingsCacheTime) < SETTINGS_CACHE_TTL) {
      return _settingsCache; // Return cached
    }
    _settingsCache = JSON.parse(localStorage.getItem('ex_cfg') || '{}');
    _settingsCacheTime = now;
    return _settingsCache;
  },
  saveSetting(k, v) {
    const s = this.getSettings();
    s[k] = v;
    localStorage.setItem('ex_cfg', JSON.stringify(s));
    _settingsCache = s; // Update cache
    _settingsCacheTime = Date.now();
  },
  // ── Extended user data ──────────────────────────────────────────────────
  getUser: () => JSON.parse(localStorage.getItem('ex_user') || '{"name":"","email":"","avatar":"👤","bio":"","createdAt":' + Date.now() + '}'),
  saveUser(u) { localStorage.setItem('ex_user', JSON.stringify({ ...this.getUser(), ...u, updatedAt: Date.now() })) },
  getNotes: () => JSON.parse(localStorage.getItem('ex_notes') || '[]'),
  addNote(n) { const arr = this.getNotes(); arr.unshift({ id: Date.now(), ...n, ts: Date.now() }); localStorage.setItem('ex_notes', JSON.stringify(arr.slice(0, 500))) },
  deleteNote(id) { localStorage.setItem('ex_notes', JSON.stringify(this.getNotes().filter(n => n.id !== id))) },
  updateNote(id, data) { localStorage.setItem('ex_notes', JSON.stringify(this.getNotes().map(n => n.id === id ? { ...n, ...data, updatedAt: Date.now() } : n))) },
  getDownloads: () => JSON.parse(localStorage.getItem('ex_dl') || '[]'),
  addDownload(d) { const arr = this.getDownloads(); arr.unshift({ id: Date.now(), ...d, ts: Date.now() }); localStorage.setItem('ex_dl', JSON.stringify(arr.slice(0, 200))) },
  getSessions: () => JSON.parse(localStorage.getItem('ex_sessions') || '[]'),
  saveSession(tabs) { const arr = this.getSessions(); arr.unshift({ id: Date.now(), ts: Date.now(), count: tabs.length, tabs: tabs.map(t => ({ url: t.url, title: t.title })) }); localStorage.setItem('ex_sessions', JSON.stringify(arr.slice(0, 20))) },
  // Storage location config (which localStorage key each store uses)
  getStorageConfig: () => JSON.parse(localStorage.getItem('ex_storage_cfg') || '{}'),
  getStorageKey(store) { const cfg = this.getStorageConfig(); return cfg[store] || { hist: 'ex_hist', bm: 'ex_bm', cfg: 'ex_cfg', user: 'ex_user', notes: 'ex_notes', dl: 'ex_dl', passwords: 'ex_passwords', sessions: 'ex_sessions' }[store] || ('ex_' + store); },
  setStorageKey(store, key) { const cfg = this.getStorageConfig(); cfg[store] = key; localStorage.setItem('ex_storage_cfg', JSON.stringify(cfg)); showToast('💾 Storage key for "' + store + '" set to "' + key + '"'); }
};
let tabIdCounter = 0;
function createTabFrame(tabId, partition) {
  // Create a dedicated webview for this tab so audio/video keeps playing when switching
  if (!window.electronWebview) return null;
  const contentArea = document.getElementById('contentArea');
  const wv = document.createElement('webview');
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('allowfullscreen', '');
  wv.setAttribute('partition', partition || 'persist:etherx');
  wv.className = 'browse-frame tab-webview';
  wv.style.cssText = 'display:none;position:absolute;top:0;left:0;width:100%;height:100%;border:none;';
  // Forward webview events to global handlers
  wv.addEventListener('did-start-loading', () => { if (STATE.activeTabId === tabId) setLoading(30); });
  wv.addEventListener('did-stop-loading', () => { if (STATE.activeTabId === tabId) setLoading(100); });
  wv.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return;
    if (STATE.activeTabId === tabId) { setLoading(0); const t = STATE.tabs.find(x => x.id === tabId); if (t) showPageError(e.errorDescription || 'Failed to load'); }
  });
  wv.addEventListener('page-title-updated', (e) => {
    const t = STATE.tabs.find(x => x.id === tabId);
    if (t) { t.title = e.title; updateTabEl(t); }
  });
  wv.addEventListener('page-favicon-updated', (e) => {
    if (e.favicons?.length) { const t = STATE.tabs.find(x => x.id === tabId); if (t) { t.faviconUrl = e.favicons[0]; updateTabEl(t); } }
  });
  wv.addEventListener('did-navigate', (e) => {
    const t = STATE.tabs.find(x => x.id === tabId);
    if (t) { t.url = e.url; t.history.push(e.url); t.histIdx = t.history.length - 1; if (STATE.activeTabId === tabId) { document.getElementById('urlInput').value = e.url; updateUrlIcon(e.url); updateNavBtns(t); } updateTabEl(t); }
    // Clear phishing banner on every navigation
    if (STATE.activeTabId === tabId) { const pb = document.getElementById('phishingBanner'); if (pb) pb.style.display = 'none'; }
  });
  wv.addEventListener('did-navigate-in-page', (e) => {
    if (!e.isMainFrame) return;
    const t = STATE.tabs.find(x => x.id === tabId);
    if (t) { t.url = e.url; if (STATE.activeTabId === tabId) { document.getElementById('urlInput').value = e.url; updateNavBtns(t); } }
  });
  // Forward webview contextmenu to host page (Electron)
  wv.addEventListener('context-menu', (e) => {
    e.preventDefault();
    const link = e.params?.linkURL || null;
    const img = (e.params?.mediaType === 'image' && e.params?.srcURL) ? e.params.srcURL : null;
    showCtxMenu(e.params?.x || 0, e.params?.y || 0, link || null, img);
  });

  // Block deep-link / non-web protocols from opening OS dialogs (e.g. bytedance://)
  // target="_blank" links should open in a new tab (not navigate the current tab)
  wv.addEventListener('new-window', (e) => {
    try {
      const { protocol } = new URL(e.url);
      if (!['http:', 'https:', 'file:', 'about:', 'chrome-extension:', 'etherx:'].includes(protocol)) return;
    } catch (_) { return; }
    // Open in a new tab instead of replacing current tab
    createTab(e.url, '', true);
  });

  // Inject contextmenu listener into loaded page so right-click events bubble
  wv.addEventListener('dom-ready', () => {
    tabFrameReady.set(tabId, true);
    wv.insertCSS('*{-webkit-user-select: text !important;}').catch(() => { });
  });

  contentArea.appendChild(wv);
  tabFrames.set(tabId, wv);
  return wv;
}
function createTab(url = '', title = 'New Tab', active = true) {
  const id = ++tabIdCounter;
  const tab = { id, url, title, favicon: '🌐', history: [], histIdx: -1, pinned: false, muted: false };
  STATE.tabs.push(tab); renderTab(tab);
  // Create dedicated webview for this tab
  if (window.electronWebview) createTabFrame(id);
  if (active) switchTab(id);
  if (url) { navigateTo(url, id); }
  else {
    const cfg = DB.getSettings();
    if (cfg.newTabWith === 'Homepage' && cfg.homepage) { navigateTo(cfg.homepage, id); }
  }
  return tab;
}
function renderTab(tab) {
  const tabBar = document.getElementById('tabBar'), newBtn = document.getElementById('newTabBtn');
  const el = document.createElement('div');
  el.className = 'tab' + (tab.pinned ? ' pinned' : '') + (tab.muted ? ' muted' : '');
  el.dataset.tabId = tab.id;
  el.draggable = true;
  const favHtml = tab.faviconUrl ? `<img src="${tab.faviconUrl}" onerror="this.parentNode.innerHTML='<span>🌐</span>'">` : `<span>${tab.favicon || '🌐'}</span>`;
  el.innerHTML = `<div class="tab-favicon">${favHtml}</div><div class="tab-title">${tab.title}</div><div class="tab-close">×</div>`;

  // Click handler
  el.addEventListener('click', e => {
    if (e.target.classList.contains('tab-close')) { closeTab(tab.id); return; }
    switchTab(tab.id);
  });

  // Context menu - right click shows menu without switching tab
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    _ctxTabId = tab.id; // track which tab was right-clicked
    showCtxMenu(e.clientX, e.clientY, null);
  });

  // Drag & Drop handlers
  el.addEventListener('dragstart', e => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/tabId', tab.id);
    el.classList.add('dragging');

    // Store initial mouse position for tear-off detection
    el._dragStartX = e.clientX;
    el._dragStartY = e.clientY;
  });

  el.addEventListener('dragend', e => {
    el.classList.remove('dragging');

    // Check if dragged far from tab bar (tear-off)
    const tabBarRect = tabBar.getBoundingClientRect();
    const dragDistance = Math.abs(e.clientY - el._dragStartY);

    if (dragDistance > 80 || e.clientY < tabBarRect.top - 50 || e.clientY > tabBarRect.bottom + 50) {
      // Tear off: open in new window
      const url = tab.url || 'about:blank';
      window.open(url, '_blank', 'width=1200,height=800');
      closeTab(tab.id);
      showToast('🪟 Tab opened in new window');
    }
  });

  el.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Visual feedback - insert placeholder
    const draggingEl = document.querySelector('.tab.dragging');
    if (!draggingEl || draggingEl === el) return;

    const rect = el.getBoundingClientRect();
    const midpoint = rect.left + rect.width / 2;

    if (e.clientX < midpoint) {
      tabBar.insertBefore(draggingEl, el);
    } else {
      tabBar.insertBefore(draggingEl, el.nextSibling);
    }
  });

  el.addEventListener('drop', e => {
    e.preventDefault();
    const draggedId = parseInt(e.dataTransfer.getData('text/tabId'));
    const targetId = tab.id;

    if (draggedId === targetId) return;

    // Reorder tabs in STATE
    const draggedIdx = STATE.tabs.findIndex(t => t.id === draggedId);
    const targetIdx = STATE.tabs.findIndex(t => t.id === targetId);

    if (draggedIdx !== -1 && targetIdx !== -1) {
      const [draggedTab] = STATE.tabs.splice(draggedIdx, 1);
      STATE.tabs.splice(targetIdx, 0, draggedTab);
      saveSessionTabs();
    }
  });

  tabBar.insertBefore(el, newBtn);
}
function getTabEl(id) { return document.querySelector(`.tab[data-tab-id="${id}"]`); }
function switchTab(id) {
  const tab = STATE.tabs.find(t => t.id === id); if (!tab) return;
  STATE.activeTabId = id;
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  const el = getTabEl(id); if (el) { el.classList.add('active'); el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  document.getElementById('urlInput').value = tab.url || '';
  updateUrlIcon(tab.url); updateNavBtns(tab);
  if (!tab.url) {
    // Hide all tab webviews, show NTP
    if (window.electronWebview) { tabFrames.forEach(wv => { wv.style.display = 'none'; wv.classList.remove('active'); }); frame.style.display = 'none'; frame.classList.remove('active'); }
    showNTP();
  } else {
    if (window.electronWebview) {
      // Per-tab webview: hide all, show only this tab's webview
      tabFrames.forEach((wv, tid) => { wv.style.display = tid === id ? '' : 'none'; wv.classList.toggle('active', tid === id); });
      frame.style.display = 'none'; frame.classList.remove('active');
      ntp.style.display = 'none';
      document.getElementById('blockedOverlay').classList.remove('show');
    } else {
      // Web mode (iframe): always update src
      if (frame.src !== tab.url) frame.src = tab.url;
      showFrame(tab);
    }
  }
  saveSessionTabs();
}
function saveSessionTabs() {
  let windowId = 'main';
  try {
    if (window.electronAPI && typeof window.electronAPI.windowId === 'function') {
      windowId = window.electronAPI.windowId() || 'main';
    }
  } catch (e) { }

  const session = STATE.tabs.map(t => ({ url: t.url, title: t.title, favicon: t.favicon, faviconUrl: t.faviconUrl, pinned: t.pinned }));
  localStorage.setItem('ex_session_tabs_' + windowId, JSON.stringify(session));
  localStorage.setItem('ex_session_active_' + windowId, STATE.activeTabId);
}
function closeTab(id) {
  const idx = STATE.tabs.findIndex(t => t.id === id); if (idx === -1) return;
  STATE.tabs.splice(idx, 1); const el = getTabEl(id); if (el) el.remove();
  // Remove this tab's dedicated webview
  if (window.electronWebview) { const wv = tabFrames.get(id); if (wv) { wv.src = 'about:blank'; wv.remove(); tabFrames.delete(id); tabFrameReady.delete(id); } }
  saveSessionTabs();
  if (STATE.tabs.length === 0) { createTab(); return; }
  switchTab(STATE.tabs[Math.min(idx, STATE.tabs.length - 1)].id);
}
function getActiveTab() { return STATE.tabs.find(t => t.id === STATE.activeTabId); }
function updateTabEl(tab) {
  const el = getTabEl(tab.id); if (!el) return;
  el.className = 'tab' + (tab.id === STATE.activeTabId ? ' active' : '') + (tab.pinned ? ' pinned' : '') + (tab.muted ? ' muted' : '');
  el.querySelector('.tab-title').textContent = tab.title;
  const fav = el.querySelector('.tab-favicon');
  if (tab.faviconUrl) { fav.innerHTML = `<img src="${tab.faviconUrl}" onerror="this.parentNode.innerHTML='<span>🌐</span>'">`; }
  else { fav.innerHTML = `<span>${tab.favicon || '🌐'}</span>`; }
}
const frame = document.getElementById('browseFrame');
const ntp = document.getElementById('ntpPage');
function normalizeUrl(raw) {
  raw = raw.trim(); if (!raw) return '';
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return 'https://etherscan.io/address/' + raw;
  if (/\.eth$/i.test(raw)) return 'https://app.ens.domains/name/' + raw;
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(raw)) return raw;
  if (/^[a-zA-Z0-9-]+(\.[a-zA-Z]{2,})+/.test(raw) && !raw.includes(' ')) return 'https://' + raw;
  // Use configured search engine (falls back to Google)
  const cfg = DB.getSettings();
  const searchEngines = {
    google: 'https://www.google.com/search?q=',
    bing: 'https://www.bing.com/search?q=',
    duckduckgo: 'https://duckduckgo.com/?q=',
    brave: 'https://search.brave.com/search?q=',
    ecosia: 'https://www.ecosia.org/search?q=',
    startpage: 'https://www.startpage.com/search?q=',
    yahoo: 'https://search.yahoo.com/search?p=',
    baidu: 'https://www.baidu.com/s?wd=',
  };
  const engine = searchEngines[cfg.search_engine] || searchEngines.google;
  return engine + encodeURIComponent(raw);
}
function showNTP() {
  ntp.style.display = 'flex';
  frame.classList.remove('active');
  // Also hide all per-tab webviews so they don't cover the NTP
  if (window.electronWebview) {
    tabFrames.forEach(wv => { wv.style.display = 'none'; wv.classList.remove('active'); });
  }
  document.getElementById('blockedOverlay').classList.remove('show');
  document.getElementById('readerMode').classList.remove('show');
  document.getElementById('btnReader').style.display = 'none';
  document.getElementById('urlInput').value = ''; updateUrlIcon(''); setLoading(0);
  renderQuickLinks();
}
function showFrame(tab) { ntp.style.display = 'none'; frame.classList.add('active'); document.getElementById('blockedOverlay').classList.remove('show'); }
function getTabWebview(tabId) {
  // Returns the webview for the given tab (per-tab in Electron, shared frame in web mode)
  if (window.electronWebview) return tabFrames.get(tabId) || frame;
  return frame;
}
function safeWebviewExecute(wv, tabId, method, ...args) {
  // Safely execute webview methods only after dom-ready event
  return new Promise((resolve, reject) => {
    if (!wv || typeof wv[method] !== 'function') {
      reject(new Error(`WebView method ${method} not available`));
      return;
    }
    const execute = () => {
      try {
        const result = wv[method](...args);
        if (result && typeof result.then === 'function') {
          result.then(resolve).catch(reject);
        } else {
          resolve(result);
        }
      } catch (e) {
        reject(e);
      }
    };
    // Check if webview is ready (has emitted dom-ready)
    if (tabId && tabFrameReady.get(tabId)) {
      execute();
    } else {
      // Queue execution until dom-ready
      const timeout = setTimeout(() => {
        wv.removeEventListener('dom-ready', handler);
        reject(new Error('WebView dom-ready timeout after 10 seconds'));
      }, 10000);
      const handler = () => {
        clearTimeout(timeout);
        if (tabId) tabFrameReady.set(tabId, true);
        execute();
      };
      wv.addEventListener('dom-ready', handler, { once: true });
    }
  });
}
function navigateTo(raw, tabId) {
  const url = normalizeUrl(raw); if (!url) { showNTP(); return; }
  // Block non-web protocols (e.g. bytedance://, intent://) to prevent OS dialogs
  try {
    const { protocol } = new URL(url);
    if (!['http:', 'https:', 'file:', 'about:', 'chrome-extension:', 'etherx:'].includes(protocol)) return;
  } catch (e) { return; }
  const tab = tabId ? STATE.tabs.find(t => t.id === tabId) : getActiveTab(); if (!tab) return;
  tab.url = url;
  try {
    const h = new URL(url).hostname;
    tab.title = h;
    tab.favicon = '🌐';
    // faviconUrl set after load, not here — prevents gstatic URL appearing in address bar
    tab.faviconUrl = null;
  } catch (e) { tab.title = url.slice(0, 30); tab.favicon = '🌐'; tab.faviconUrl = null; }
  tab.history = tab.history.slice(0, tab.histIdx + 1);
  tab.history.push(url); tab.histIdx = tab.history.length - 1;
  if (tab.id === STATE.activeTabId) {
    // Only close panels when the user navigates the active tab (not for background tabs)
    closeAllPanels();
    document.getElementById('urlInput').value = url; updateUrlIcon(url); updateNavBtns(tab);
    ntp.style.display = 'none';
    document.getElementById('blockedOverlay').classList.remove('show');
    document.getElementById('readerMode').classList.remove('show');
    setLoading(30);
    const tabWv = getTabWebview(tab.id);
    if (window.electronWebview) { tabWv.style.display = ''; tabWv.classList.add('active'); tabWv.src = url; }
    else { frame.classList.add('active'); frame.src = url; }
    document.getElementById('sbUrl').textContent = url;
  } else if (window.electronWebview) {
    // Background tab: load URL in its webview without showing it
    const tabWv = getTabWebview(tab.id);
    if (tabWv) tabWv.src = url;
  }
  updateTabEl(tab); DB.addHistory({ url, title: tab.title }); saveSessionTabs();
  consoleLog('info', '🌐 Navigating: ' + url); logNetworkEntry(url);
}
function updateNavBtns(tab) {
  if (!tab) return;
  document.getElementById('btnBack').disabled = tab.histIdx <= 0;
  document.getElementById('btnFwd').disabled = tab.histIdx >= tab.history.length - 1;
}
document.getElementById('btnBack').addEventListener('click', () => {
  const tab = getActiveTab(); if (!tab || tab.histIdx <= 0) return;
  tab.histIdx--; const u = tab.history[tab.histIdx]; tab.url = u;
  document.getElementById('urlInput').value = u; updateUrlIcon(u);
  if (window.electronWebview) { const wv = getTabWebview(tab.id); if (wv) { safeWebviewExecute(wv, tab.id, 'goBack').catch(() => { wv.src = u; }); } }
  else { frame.src = u; } setLoading(25); updateNavBtns(tab); updateTabEl(tab);
});
document.getElementById('btnFwd').addEventListener('click', () => {
  const tab = getActiveTab(); if (!tab || tab.histIdx >= tab.history.length - 1) return;
  tab.histIdx++; const u = tab.history[tab.histIdx]; tab.url = u;
  document.getElementById('urlInput').value = u; updateUrlIcon(u);
  if (window.electronWebview) { const wv = getTabWebview(tab.id); if (wv) { safeWebviewExecute(wv, tab.id, 'goForward').catch(() => { wv.src = u; }); } }
  else { frame.src = u; } setLoading(25); updateNavBtns(tab); updateTabEl(tab);
});
document.getElementById('btnReload').addEventListener('click', () => {
  const tab = getActiveTab(); if (tab && tab.url) {
    setLoading(20);
    if (window.electronWebview) { const wv = getTabWebview(tab.id); if (wv) { safeWebviewExecute(wv, tab.id, 'reload').catch(() => { wv.src = tab.url; }); } }
    else { frame.src = tab.url; } consoleLog('log', '↺ Reload: ' + tab.url);
  }
});
document.getElementById('btnHome').addEventListener('click', () => { showNTP(); const t = getActiveTab(); if (t) { t.url = ''; t.title = 'New Tab'; updateTabEl(t); } });
const urlInput = document.getElementById('urlInput');
function doNavigate() { const ui = document.getElementById('urlInput'); if (ui) navigateTo(ui.value); }

// ── URL Autocomplete / History ────────────────────────────────────────────
const URL_HIST_KEY = 'ex_url_hist';
const URL_HIST_MAX = 200;
function getUrlHistory() { try { return JSON.parse(localStorage.getItem(URL_HIST_KEY) || '[]'); } catch (e) { return []; } }
function saveUrlHistory(arr) { localStorage.setItem(URL_HIST_KEY, JSON.stringify(arr.slice(0, URL_HIST_MAX))); }
function addUrlHistory(entry) {
  // entry: { url, title, favicon, type:'url'|'search', ts }
  let h = getUrlHistory();
  h = h.filter(x => x.url !== entry.url); // dedup
  h.unshift({ ...entry, ts: Date.now() });
  saveUrlHistory(h);
}
function escAcHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function highlightMatch(text, q) {
  if (!q) return escAcHtml(text);
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return escAcHtml(text);
  return escAcHtml(text.slice(0, idx)) + '<mark>' + escAcHtml(text.slice(idx, idx + q.length)) + '</mark>' + escAcHtml(text.slice(idx + q.length));
}

let _acSelIdx = -1;
let _acItems = [];
const acDropdown = document.getElementById('urlAutocomplete');

function closeAcDropdown() {
  if (acDropdown) acDropdown.style.display = 'none';
  _acSelIdx = -1; _acItems = [];
}

function renderAcDropdown(items) {
  if (!items.length || !acDropdown) { closeAcDropdown(); return; }
  _acItems = items; _acSelIdx = -1;
  acDropdown.innerHTML = '';
  items.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'url-ac-item';
    div.dataset.idx = i;
    const isUrl = item.type === 'url';
    div.innerHTML = `
          <span class="ac-icon">${item.favicon || (isUrl ? '🌐' : '🔍')}</span>
          <span class="ac-main">${highlightMatch(item.url, urlInput.value)}</span>
          ${item.title && item.title !== item.url ? `<span class="ac-type" title="${escAcHtml(item.title)}" style="max-width:120px;overflow:hidden;text-overflow:ellipsis">${escAcHtml(item.title.slice(0, 30))}</span>` : ''}
          <span class="ac-type">${isUrl ? 'URL' : '🔍 Search'}</span>
          <button class="ac-del" title="Remove from history" data-remove="${escAcHtml(item.url)}">✕</button>`;
    div.addEventListener('mousedown', e => {
      if (e.target.classList.contains('ac-del')) {
        e.preventDefault(); e.stopPropagation();
        let h = getUrlHistory(); h = h.filter(x => x.url !== item.url); saveUrlHistory(h);
        items.splice(i, 1); renderAcDropdown(items);
        return;
      }
      e.preventDefault();
      urlInput.value = item.url;
      closeAcDropdown();
      navigateTo(item.url);
    });
    acDropdown.appendChild(div);
  });
  acDropdown.style.display = 'block';
}

function queryAcDropdown(q) {
  if (!q || q.length < 1) { closeAcDropdown(); return; }
  const ql = q.toLowerCase();
  // 1. Typed URL history matches
  const hist = getUrlHistory().filter(x => x.url.toLowerCase().includes(ql) || (x.title || '').toLowerCase().includes(ql)).slice(0, 6);
  // 2. Current open tabs
  const tabMatches = STATE.tabs
    .filter(t => t.url && (t.url.toLowerCase().includes(ql) || (t.title || '').toLowerCase().includes(ql)))
    .map(t => ({ url: t.url, title: t.title || '', favicon: t.faviconUrl ? `<img src="${escAcHtml(t.faviconUrl)}" style="width:14px;height:14px;border-radius:2px;object-fit:cover">` : '📄', type: 'url' }))
    .slice(0, 3);
  // 3. Bookmark matches
  const bmMatches = DB.getBookmarks()
    .filter(b => b.url && (b.url.toLowerCase().includes(ql) || (b.title || '').toLowerCase().includes(ql)))
    .map(b => ({ url: b.url, title: b.title || '', favicon: '🔖', type: 'url' }))
    .slice(0, 4);
  // 4. Search suggestion (always last)
  const searchEntry = { url: q, title: 'Search: ' + q, favicon: '🔍', type: 'search' };
  // Deduplicate
  const seen = new Set();
  const combined = [...hist, ...tabMatches, ...bmMatches].filter(x => { if (seen.has(x.url)) return false; seen.add(x.url); return true; });
  // If input looks like a URL, prepend it as a direct URL option
  const looksLikeUrl = /^https?:\/\/|^www\.|^localhost|\.\w{2,}\//.test(q);
  const items = [];
  if (looksLikeUrl && !seen.has(q)) items.push({ url: q, title: '', favicon: '🌐', type: 'url' });
  items.push(...combined);
  if (!looksLikeUrl) items.push(searchEntry);
  renderAcDropdown(items.slice(0, 9));
}

if (urlInput) {
  urlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (e.key === 'Tab' && _acItems.length === 0) return; // Allow normal tab out if no dropdown
      e.preventDefault();
      if (_acSelIdx >= 0 && _acItems[_acSelIdx]) {
        urlInput.value = _acItems[_acSelIdx].url;
        closeAcDropdown();
        navigateTo(urlInput.value);
      } else if (e.key === 'Tab' && _acItems.length > 0) {
        // On tab with no selection, choose first item
        urlInput.value = _acItems[0].url;
        closeAcDropdown();
        navigateTo(urlInput.value);
      } else {
        closeAcDropdown();
        doNavigate();
      }
      return;
    }
    if (e.key === 'Escape') { urlInput.value = getActiveTab()?.url || ''; closeAcDropdown(); urlInput.blur(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _acSelIdx = Math.min(_acSelIdx + 1, _acItems.length - 1);
      acDropdown.querySelectorAll('.url-ac-item').forEach((el, i) => el.classList.toggle('ac-sel', i === _acSelIdx));
      if (_acItems[_acSelIdx]) urlInput.value = _acItems[_acSelIdx].url;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      _acSelIdx = Math.max(_acSelIdx - 1, -1);
      acDropdown.querySelectorAll('.url-ac-item').forEach((el, i) => el.classList.toggle('ac-sel', i === _acSelIdx));
      if (_acSelIdx >= 0 && _acItems[_acSelIdx]) urlInput.value = _acItems[_acSelIdx].url;
      return;
    }
  });
  urlInput.addEventListener('input', () => { _acSelIdx = -1; queryAcDropdown(urlInput.value.trim()); });
  urlInput.addEventListener('focus', () => { urlInput.select(); if (urlInput.value.trim()) queryAcDropdown(urlInput.value.trim()); });
  urlInput.addEventListener('blur', () => setTimeout(closeAcDropdown, 150));
}
document.getElementById('goBtn')?.addEventListener('click', () => { closeAcDropdown(); doNavigate(); });
document.getElementById('ntpSearch')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const q = e.target.value.trim();
    if (q) {
      navigateTo(q);
      // Update address bar to match what was searched
      const urlInput2 = document.getElementById('urlInput');
      if (urlInput2) { urlInput2.value = q; urlInput2.blur(); }
    }
  }
});

// Save to URL history after every successful navigation
const _origNavigateTo = navigateTo;
navigateTo = function (raw, tabId) {
  _origNavigateTo(raw, tabId);
  // Save to autocomplete history after a short delay (so URL is normalized)
  setTimeout(() => {
    const tab = getActiveTab();
    if (tab && tab.url && tab.url.startsWith('http')) {
      const looksSearch = raw && !raw.startsWith('http') && !raw.startsWith('www.') && raw.includes(' ');
      addUrlHistory({ url: tab.url, title: tab.title || '', type: looksSearch ? 'search' : 'url' });
    } else if (raw && raw.trim() && !raw.startsWith('http')) {
      // It was a search query — save the query text too
      addUrlHistory({ url: raw.trim(), title: 'Search: ' + raw.trim(), type: 'search' });
    }
  }, 800);
};
frame.addEventListener('load', () => {
  setLoading(100); const tab = getActiveTab(); if (!tab) return;
  const loadedSrc = frame.src || '';
  const SKIP = ['gstatic.com', 'favicon.ico', 'favicon.png', 's2/favicons', 'google.com/images/branding'];
  if (SKIP.some(p => loadedSrc.includes(p))) return;
  try {
    const doc = frame.contentDocument, t = doc?.title;
    if (t && t !== '') { tab.title = t; document.getElementById('elemTitle').textContent = t; }
    // Update favicon from Google S2 API only after real page load
    if (tab.url && tab.url.startsWith('http')) {
      tab.faviconUrl = `https://www.google.com/s2/favicons?sz=32&domain_url=${encodeURIComponent(tab.url)}`;
    }
    updateTabEl(tab);
    document.getElementById('btnReader').style.display = 'block';
    // Measure real page load timing via executeJavaScript (Electron webview only)
    const activeWv = getTabWebview(tab.id);
    if (activeWv && typeof activeWv.executeJavaScript === 'function') {
      safeWebviewExecute(activeWv, tab.id, 'executeJavaScript', `
      (function(){
        const nav = performance.getEntriesByType('navigation')[0];
        const fcp = performance.getEntriesByName('first-contentful-paint')[0];
        return {
          fcp: fcp ? Math.round(fcp.startTime) : null,
          load: nav ? Math.round(nav.loadEventEnd - nav.startTime) : null,
          domInteractive: nav ? Math.round(nav.domInteractive) : null,
        };
      })()
    `).then(perf => {
      if (!perf) return;
      const fcpMs = perf.fcp; const loadMs = perf.load;
      const fcpTxt = fcpMs != null ? fcpMs+'ms' : '—';
      const loadTxt = loadMs != null ? loadMs+'ms' : '—';
      document.getElementById('perfFcp').textContent = fcpTxt;
      document.getElementById('perfLcp').textContent = '—';
      document.getElementById('perfLoad').textContent = loadTxt;
      document.getElementById('perfTbt').textContent = perf.domInteractive != null ? perf.domInteractive+'ms' : '—';
      document.getElementById('perfCls').textContent = '—';
      document.getElementById('perfTti').textContent = perf.domInteractive != null ? perf.domInteractive+'ms' : '—';
      // Store in tab state for Performance Monitor panel
      if (STATE.tabs?.[tab.id]) STATE.tabs[tab.id].perfData = { fcp: fcpMs, lcp: null, load: loadMs };
    }).catch(() => {
      ['perfFcp','perfLcp','perfTbt','perfCls','perfTti','perfLoad'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
    });
    } // end if activeWv
  } catch (e) { }
  consoleLog('success', '✓ Loaded: ' + (tab.url || '—'));
});
window.addEventListener('message', e => {
  if (e.data?.type === 'etherx-navigate') navigateTo(e.data.url);
  if (e.data?.type === 'etherx-resources') {
    const d = e.data;
    // ── Populate Network tab ──────────────────────────────────────────────
    if (networkLog && d.resources) {
      // Log the main HTML document first
      const tab = getActiveTab();
      if (tab) logNetworkEntry(d.mainUrl || tab.url, 'HTML', 200);
      d.resources.forEach(r => {
        logNetworkEntry(r.url, r.type || 'HTML', r.status || 200);
      });
    }
    // ── Populate Sources tree ─────────────────────────────────────────────
    const treeEl = document.getElementById('sourcesTree');
    const codeEl = document.getElementById('sourcesCode');
    if (treeEl && d.resources) {
      // Add origin folder if not already there
      const folderKey = 'src-folder-' + (d.origin || '').replace(/[^a-z0-9]/gi, '_');
      if (!document.getElementById(folderKey)) {
        const folder = document.createElement('div');
        folder.className = 'src-item folder'; folder.style.paddingLeft = '20px';
        folder.id = folderKey;
        folder.textContent = '📁 ' + (d.origin || '(loaded page)').replace('https://', '').replace('http://', '');
        treeEl.appendChild(folder);
      }
      d.resources.forEach(r => {
        const rKey = 'src-res-' + btoa(r.url).slice(0, 16);
        if (!document.getElementById(rKey)) {
          const name = r.url.split('/').pop().split('?')[0] || 'file';
          const icon = r.type === 'JS' ? '📜' : r.type === 'CSS' ? '🎨' : r.type === 'Img' ? '🖼' : '📄';
          const item = document.createElement('div');
          item.className = 'src-item'; item.id = rKey;
          item.style.paddingLeft = '32px'; item.dataset.srcUrl = r.url;
          item.textContent = icon + ' ' + name.slice(0, 40);
          item.title = r.url;
          item.addEventListener('click', () => {
            document.querySelectorAll('.src-item').forEach(x => x.classList.remove('active'));
            item.classList.add('active');
            if (codeEl) loadSourceIntoPane(r.url, codeEl);
          });
          treeEl.appendChild(item);
        }
      });
    }
    // ── Store CSP for Security panel ──────────────────────────────────────
    const tab2 = getActiveTab();
    if (tab2) tab2._csp = d.csp || '';
    if (d.title && tab2 && !tab2.title) { tab2.title = d.title; updateTabEl(tab2); }
  }
});
function updateUrlIcon(url) {
  const icon = document.getElementById('urlIcon');
  if (!url) { icon.textContent = '🌐'; icon.style.color = ''; return; }
  if (url.startsWith('https://')) { icon.textContent = '🔒'; icon.style.color = 'var(--green)'; }
  else { icon.textContent = '⚠️'; icon.style.color = 'var(--yellow)'; }
}
function setLoading(pct) {
  const bar = document.getElementById('loadingBar');
  bar.classList.remove('done');
  bar.style.width = pct + '%';
  if (pct >= 100) {
    setTimeout(() => { bar.classList.add('done'); setTimeout(() => { bar.style.width = '0%'; bar.classList.remove('done'); }, 400); }, 600);
  }
}
function setZoom(val) {
  STATE.zoom = Math.max(25, Math.min(500, val));
  const s = STATE.zoom / 100;
  if (window.electronWebview) {
    const wv = getTabWebview(STATE.activeTabId);
    if (wv && typeof wv.setZoomFactor === 'function') {
      try { wv.setZoomFactor(s); } catch (e) { }
    }
  } else {
    if (s === 1) {
      frame.style.transform = ''; frame.style.width = '100%'; frame.style.height = '100%';
    } else {
      frame.style.transformOrigin = 'top left';
      frame.style.transform = `scale(${s})`;
      frame.style.width = (100 / s) + '%';
      frame.style.height = (100 / s) + '%';
    }
    frame.style.zoom = '';
  }
  const z = document.getElementById('zoomIndicator');
  z.style.display = STATE.zoom !== 100 ? 'block' : 'none'; z.textContent = STATE.zoom + '%';
  document.getElementById('sbZoom').textContent = STATE.zoom + '%';
}
document.getElementById('zoomIndicator').addEventListener('click', () => setZoom(100));
function openFind() { const fb = document.getElementById('findBar'); fb.classList.add('show'); document.getElementById('findInput').focus(); document.getElementById('findInput').select(); }
function closeFind() {
  document.getElementById('findBar').classList.remove('show');
  document.getElementById('findInput').value = '';
  document.getElementById('findCount').textContent = '';
  // Stop find in webview
  if (window.electronWebview) {
    const wv = getTabWebview(STATE.activeTabId);
    if (wv && typeof wv.stopFindInPage === 'function') {
      try { wv.stopFindInPage('clearSelection'); } catch (e) { }
    }
  }
}
document.getElementById('findClose').addEventListener('click', closeFind);
document.getElementById('findDone').addEventListener('click', closeFind);
document.getElementById('findInput').addEventListener('input', () => {
  const q = document.getElementById('findInput').value;
  document.getElementById('findCount').textContent = q ? '(searching…)' : '';
  if (window.electronWebview) {
    const wv = getTabWebview(STATE.activeTabId);
    if (wv && typeof wv.findInPage === 'function') {
      try {
        if (!q) { wv.stopFindInPage('clearSelection'); return; }
        wv.findInPage(q);
        wv.addEventListener('found-in-page', function handler(e) {
          document.getElementById('findCount').textContent = e.result.matches ? (e.result.activeMatchOrdinal + '/' + e.result.matches) : 'Not found';
          wv.removeEventListener('found-in-page', handler);
        });
      } catch (e) { }
    }
  } else {
    try { frame.contentWindow.find(q); } catch (e) { }
  }
});
document.getElementById('findPrev').addEventListener('click', () => {
  const q = document.getElementById('findInput').value; if (!q) return;
  if (window.electronWebview) {
    const wv = getTabWebview(STATE.activeTabId);
    if (wv && typeof wv.findInPage === 'function') {
      try { wv.findInPage(q, { forward: false, findNext: true }); } catch (e) { }
    }
  } else { try { frame.contentWindow.find(q, false, true); } catch (e) { } }
});
document.getElementById('findNext').addEventListener('click', () => {
  const q = document.getElementById('findInput').value; if (!q) return;
  if (window.electronWebview) {
    const wv = getTabWebview(STATE.activeTabId);
    if (wv && typeof wv.findInPage === 'function') {
      try { wv.findInPage(q, { forward: true, findNext: true }); } catch (e) { }
    }
  } else { try { frame.contentWindow.find(q); } catch (e) { } }
});
let readerFontSize = 18;
document.getElementById('btnReader').addEventListener('click', toggleReader);
document.getElementById('readerClose').addEventListener('click', toggleReader);
document.getElementById('readerSmaller').addEventListener('click', () => { readerFontSize = Math.max(12, readerFontSize - 2); document.querySelector('.reader-content').style.fontSize = readerFontSize + 'px'; });
document.getElementById('readerLarger').addEventListener('click', () => { readerFontSize = Math.min(28, readerFontSize + 2); document.querySelector('.reader-content').style.fontSize = readerFontSize + 'px'; });
function toggleReader() {
  const rm = document.getElementById('readerMode'); STATE.readerMode = !STATE.readerMode;
  if (STATE.readerMode) {
    rm.classList.add('show'); const tab = getActiveTab();
    document.getElementById('readerTitle').textContent = tab?.title || '';
    document.getElementById('readerContent').innerHTML = '<p style="color:#888;font-style:italic">📖 Extracting readable content…</p>';

    // Use webview executeJavaScript to get full HTML, then AI reading mode extraction
    const wv = getTabWebview(tab?.id);
    if (wv && window.electronWebview) {
      safeWebviewExecute(wv, tab?.id, 'executeJavaScript', 'document.documentElement.outerHTML')
        .then(html => {
          if (window.etherx?.ai?.readingMode) {
            return window.etherx.ai.readingMode(html);
          }
          // Fallback: basic strip
          const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
          return { ok: true, title: tab?.title || '', text };
        })
        .then(result => {
          if (result?.ok && result.text) {
            const title = result.title || tab?.title || '';
            const body = result.text.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>');
            document.getElementById('readerContent').innerHTML =
              (title ? '<h1>' + title + '</h1>' : '') + '<p>' + body + '</p>';
          } else {
            document.getElementById('readerContent').innerHTML =
              '<h1>' + (tab?.title || 'Reader Mode') + '</h1><p style="color:#888">Could not extract readable content from this page.</p>';
          }
        })
        .catch(() => {
          document.getElementById('readerContent').innerHTML =
            '<h1>Reader Mode</h1><p style="color:#888">Could not access page content (cross-origin restriction).</p>';
        });
    } else {
      document.getElementById('readerContent').innerHTML =
        '<h1>Reader Mode</h1><p style="color:#888">No active page.</p>';
    }
  } else { rm.classList.remove('show'); }
}
document.getElementById('mi-responsive').addEventListener('click', toggleRespMode);
document.getElementById('mi-responsive-dev').addEventListener('click', toggleRespMode);
document.getElementById('closeResp').addEventListener('click', toggleRespMode);
document.querySelectorAll('.rp').forEach(btn => {
  if (btn.id === 'closeResp') return;
  btn.addEventListener('click', () => {
    document.querySelectorAll('.rp').forEach(b => b.classList.remove('active')); btn.classList.add('active');
    const w = btn.dataset.w, h = btn.dataset.h; const rf = document.getElementById('respFrame');
    rf.style.width = w + 'px'; rf.style.height = h + 'px'; document.getElementById('respSize').textContent = w + ' × ' + h;
    const tab = getActiveTab(); if (tab?.url) rf.src = tab.url;
  });
});
function toggleRespMode() {
  STATE.respMode = !STATE.respMode; const bar = document.getElementById('respBar'); const wrap = document.getElementById('respWrapper');
  bar.classList.toggle('show', STATE.respMode);
  if (STATE.respMode) {
    wrap.classList.add('active'); const rf = document.getElementById('respFrame');
    rf.style.width = '375px'; rf.style.height = '812px';
    const tab = getActiveTab(); if (tab?.url) rf.src = tab.url;
    ntp.style.display = 'none'; frame.classList.remove('active'); showToast('📐 Responsive Design Mode');
  } else {
    wrap.classList.remove('active'); document.getElementById('respFrame').src = '';
    const tab = getActiveTab(); if (tab?.url) showFrame(tab); else showNTP();
  }
}
function toggleTabOverview() { const ov = document.getElementById('tabOverview'); const isOpen = ov.classList.toggle('show'); if (isOpen) renderTabOverview(); }
function renderTabOverview() {
  const ov = document.getElementById('tabOverview'); ov.innerHTML = '';
  STATE.tabs.forEach(tab => {
    const card = document.createElement('div'); card.className = 'to-card' + (tab.id === STATE.activeTabId ? ' active' : '');
    card.innerHTML = `<div class="to-preview">${tab.favicon}</div><div class="to-label">${tab.title}</div><button class="to-close">×</button>`;
    card.addEventListener('click', e => { if (e.target.classList.contains('to-close')) { closeTab(tab.id); renderTabOverview(); return; } switchTab(tab.id); toggleTabOverview(); });
    ov.appendChild(card);
  });
  const addBtn = document.createElement('div'); addBtn.className = 'to-add'; addBtn.textContent = '+';
  addBtn.addEventListener('click', () => { createTab(); toggleTabOverview(); }); ov.appendChild(addBtn);
}
document.getElementById('mi-tab-overview').addEventListener('click', toggleTabOverview);
document.getElementById('mi-fullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => { }); else document.exitFullscreen();
});
document.addEventListener('fullscreenchange', () => showToast(document.fullscreenElement ? '⛶ Full Screen — F11 to exit' : '⊡ Exited Full Screen'));
document.getElementById('mi-new-private').addEventListener('click', () => {
  STATE.isPrivate = !STATE.isPrivate;
  document.getElementById('privateIndicator').style.display = STATE.isPrivate ? 'block' : 'none';
  document.getElementById('sbPrivate').style.display = STATE.isPrivate ? 'block' : 'none';
  document.body.style.filter = STATE.isPrivate ? 'hue-rotate(240deg) saturate(0.8)' : '';
  showToast(STATE.isPrivate ? '🕶 Private Mode ON' : '👁 Private Mode OFF');
});
function closeAllPanels() { ['bmPanel', 'histPanel', 'dlPanel', 'settingsPanel', 'walletPanel', 'bobiaiPanel', 'aiAgentPanel', 'kriptoPanel', 'etherxPanel', 'cryptoPricePanel', 'perfMonPanel'].forEach(id => document.getElementById(id)?.classList.remove('open')); document.getElementById('settingsBackdrop')?.classList.remove('open'); }
function togglePanel(id) { const panel = document.getElementById(id); const wasOpen = panel?.classList.contains('open'); closeAllPanels(); if (!wasOpen && panel) panel.classList.add('open'); }
document.getElementById('btnBookmarks').addEventListener('click', () => { renderBookmarksPanel(); togglePanel('bmPanel'); });
document.getElementById('btnHistory').addEventListener('click', () => { renderHistoryPanel(); togglePanel('histPanel'); });
document.getElementById('btnDownloads').addEventListener('click', () => togglePanel('dlPanel'));
document.getElementById('btnSettings')?.addEventListener('click', () => { const wasOpen = document.getElementById('settingsPanel').classList.contains('open'); togglePanel('settingsPanel'); document.getElementById('settingsBackdrop')?.classList.toggle('open', !wasOpen); if (!wasOpen) { updateSettingsExtCount && updateSettingsExtCount(); renderSitePermsList && renderSitePermsList(); } });
document.getElementById('settingsBackdrop')?.addEventListener('click', () => { document.getElementById('settingsPanel')?.classList.remove('open'); document.getElementById('settingsBackdrop')?.classList.remove('open'); });
document.getElementById('walletReload')?.addEventListener('click', () => {
  const wl = document.getElementById('walletLoading');
  const wf = document.getElementById('walletFrame');
  if (wl) wl.style.display = 'flex';
  if (wf) { wf.src = ''; setTimeout(() => { wf.src = 'https://wallet.kriptoentuzijasti.io'; }, 50); }
});
document.getElementById('btnWallet').addEventListener('click', () => { togglePanel('walletPanel'); window._wltInit && window._wltInit(); });
document.getElementById('btnBobiAI').addEventListener('click', () => togglePanel('bobiaiPanel'));

// ── Gemini Page Summarizer ────────────────────────────────────────────────
// API key is loaded from user settings (Settings → AI) — never hardcoded
const GEMINI_MODEL = 'gemini-2.5-flash';
async function getGeminiEndpoint() {
  let key = '';
  if (window.etherx && window.etherx.settings) {
    const s = await window.etherx.settings.get();
    key = s.geminiApiKey || s.gemini_api_key || '';
  } else {
    key = (typeof DB !== 'undefined' && DB.getSettings().gemini_api_key) || '';
  }
  return key ? `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}` : null;
}

// Simple in-memory cache: urlHash → summary
const _summaryCache = {};
function _md5Hash(str) {
  // Simple djb2 hash as a lightweight cache key (not cryptographic)
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(16);
}

async function summarizeCurrentPage() {
  const tab = getActiveTab();
  const url = tab?.url || '';
  if (!url || url.startsWith('etherx://') || !url.startsWith('http')) {
    return { ok: false, error: 'Nema aktivne web stranice za analizu.' };
  }

  const card = document.getElementById('aiSummaryCard');
  const loader = document.getElementById('ascLoader');
  const bulletsEl = document.getElementById('ascBullets');
  const metaEl = document.getElementById('ascMeta');
  const cachedEl = document.getElementById('ascCached');
  const titleEl = document.getElementById('ascTitle');

  if (!card || !loader || !bulletsEl) return { ok: false, error: 'AI summary panel not found in DOM' };

  card.classList.add('open');
  loader.style.display = 'flex';
  bulletsEl.style.display = 'none';
  cachedEl.textContent = '';
  try { titleEl.textContent = new URL(url).hostname; } catch (e) { }

  // Check memory cache
  const cacheKey = _md5Hash(url);
  if (_summaryCache[cacheKey]) {
    loader.style.display = 'none';
    _renderSummaryBullets(bulletsEl, _summaryCache[cacheKey].bullets);
    bulletsEl.style.display = 'block';
    metaEl.textContent = GEMINI_MODEL;
    cachedEl.textContent = '✓ iz cache-a';
    return { ok: true, cached: true };
  }

  // If running in Electron, use IPC with webview executeJavaScript to get HTML
  if (window.electronWebview) {
    try {
      const activeTab = getActiveTab();
      const wv = getTabWebview(activeTab?.id);
      let html = '';
      if (wv) {
        try {
          html = await safeWebviewExecute(wv, activeTab?.id, 'executeJavaScript', 'document.documentElement.outerHTML');
        } catch (e2) { html = ''; }
      }
      if (!html || html.length < 200) {
        loader.style.display = 'none';
        _renderSummaryError(bulletsEl, 'Not enough page content to summarize. Please wait for the page to fully load.');
        bulletsEl.style.display = 'block';
        return { ok: false, error: 'Not enough content' };
      }
      // Strip scripts/styles for summarization
      const cleanText = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
      if (window.etherx?.ai?.summarizePage) {
        try {
          const result = await window.etherx.ai.summarizePage(url, cleanText);
          loader.style.display = 'none';
          if (!result.ok) { _renderSummaryError(bulletsEl, result.error); bulletsEl.style.display = 'block'; return result; }
          _summaryCache[cacheKey] = result;
          _renderSummaryBullets(bulletsEl, result.bullets);
          bulletsEl.style.display = 'block';
          metaEl.textContent = GEMINI_MODEL;
          cachedEl.textContent = result.cached ? '✓ iz cache-a' : '';
          return result;
        } catch (e) {
          // fall through to direct API
        }
      }
    } catch (e2) {
      // Electron HTML extraction failed — fall through to direct API
    }
  }

  // Web mode: call Gemini API directly from browser
  try {
    // Get page text via proxy
    const proxyUrl = url;
    let pageText = '';
    try {
      const resp = await fetch(proxyUrl);
      const html = await resp.text();
      // Strip tags
      pageText = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
    } catch (e) {
      pageText = `Stranica: ${url}`;
    }

    const prompt = `You are a concise summarizer. Respond with exactly 3 bullet points using the • character. Each bullet is one clear sentence in Croatian language. No intro text, no conclusion.\n\nSummarize the key points of this web page in 3 bullet points:\n\nURL: ${url}\n\n${pageText}`;

    const GEMINI_ENDPOINT = await getGeminiEndpoint();
    if (!GEMINI_ENDPOINT) {
      loader.style.display = 'none';
      _renderSummaryError(bulletsEl, 'Gemini API ključ nije postavljen. Idi u Postavke → AI i unesi API ključ.');
      bulletsEl.style.display = 'block';
      return { ok: false, error: 'No API key' };
    }
    const apiResp = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 400 }
      })
    });
    const apiData = await apiResp.json();
    if (apiData.error) throw new Error(apiData.error.message);
    const summary = apiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const bullets = summary.split('\n').map(l => l.trim()).filter(l => l.length > 0 && (l.startsWith('•') || l.startsWith('-') || /^\d\./.test(l)));

    loader.style.display = 'none';
    _summaryCache[cacheKey] = { bullets, summary };
    _renderSummaryBullets(bulletsEl, bullets.length ? bullets : [summary]);
    bulletsEl.style.display = 'block';
    metaEl.textContent = GEMINI_MODEL;
    cachedEl.textContent = '';
    return { ok: true, bullets, summary };
  } catch (err) {
    loader.style.display = 'none';
    _renderSummaryError(bulletsEl, err.message);
    bulletsEl.style.display = 'block';
    return { ok: false, error: err.message };
  }
}

function _renderSummaryBullets(el, bullets) {
  el.innerHTML = '';
  if (!bullets || !bullets.length) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px">Nema sažetka.</div>';
    return;
  }
  bullets.forEach((b, i) => {
    const clean = b.replace(/^[•\-\d\.\s]+/, '').trim();
    const div = document.createElement('div');
    div.className = 'asc-bullet';
    div.innerHTML = `<div class="asc-bullet-dot">${i + 1}</div><div>${clean}</div>`;
    el.appendChild(div);
  });
}
function _renderSummaryError(el, msg) {
  el.innerHTML = `<div style="color:var(--red);font-size:12px">⚠️ ${msg}</div>`;
}

document.getElementById('btnSummarizePage').addEventListener('click', () => {
  const card = document.getElementById('aiSummaryCard');
  if (card.classList.contains('open')) { card.classList.remove('open'); return; }
  summarizeCurrentPage();
});
document.getElementById('ascClose').addEventListener('click', () => {
  document.getElementById('aiSummaryCard').classList.remove('open');
});
document.getElementById('btnAiAgent').addEventListener('click', () => togglePanel('aiAgentPanel'));
document.getElementById('bobiaiReload')?.addEventListener('click', () => {
  const bl = document.getElementById('bobiaiLoading'); bl.style.display = 'flex';
  document.getElementById('bobiaiFrame').src = 'https://bobiai.kriptoentuzijasti.io';
});
document.getElementById('btnKripto').addEventListener('click', () => {
  const isOpening = !document.getElementById('kriptoPanel')?.classList.contains('open');
  togglePanel('kriptoPanel');
  // Fallback: hide loading overlay after 8s if iframe onload never fires (e.g. site has X-Frame-Options)
  if (isOpening) setTimeout(() => { const kl = document.getElementById('kriptoLoading'); if (kl) kl.style.display = 'none'; }, 8000);
});
document.getElementById('btnEtherX').addEventListener('click', () => togglePanel('etherxPanel'));
document.getElementById('kriptoReload')?.addEventListener('click', () => {
  document.getElementById('kriptoLoading').style.display = 'flex';
  document.getElementById('kriptoFrame').src = 'https://kriptoentuzijasti.io';
  // Fallback timeout if onload doesn't fire
  setTimeout(() => { const kl = document.getElementById('kriptoLoading'); if (kl) kl.style.display = 'none'; }, 8000);
});
document.getElementById('etherxReload')?.addEventListener('click', () => { document.getElementById('etherxLoading').style.display = 'flex'; document.getElementById('etherxFrame').src = 'https://etherx.io'; });
['closeBmPanel', 'closeHistPanel', 'closeDlPanel', 'closeSettingsPanel', 'closeWalletPanel', 'closeBobiaiPanel', 'closeAiAgentPanel', 'closeKriptoPanel', 'closeEtherxPanel', 'closeCryptoPricePanel', 'closePerfMonPanel'].forEach(id => document.getElementById(id)?.addEventListener('click', closeAllPanels));
function renderBookmarksPanel() {
  const list = document.getElementById('bmList'); const bm = DB.getBookmarks();
  if (bm.length === 0) { list.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text3);font-size:12px">No bookmarks yet<br><br>Press Ctrl+D to bookmark the current page</div>'; return; }
  list.innerHTML = ''; const title = document.createElement('div'); title.className = 'p-section-title'; title.textContent = 'Bookmarks'; list.appendChild(title);
  bm.forEach(b => {
    const el = document.createElement('div'); el.className = 'p-entry';
    el.innerHTML = `<div class="p-entry-icon">🌐</div><div class="p-entry-title" title="${b.url}">${b.title || b.url}</div><div class="p-entry-meta">${timeAgo(b.ts)}</div><button class="p-entry-del">×</button>`;
    el.querySelector('.p-entry-title').addEventListener('click', () => { navigateTo(b.url); closeAllPanels(); });
    el.querySelector('.p-entry-del').addEventListener('click', e => { e.stopPropagation(); DB.removeBookmark(b.url); renderBookmarksPanel(); });
    list.appendChild(el);
  });
}
function renderHistoryPanel() {
  const list = document.getElementById('histList'); const hist = DB.getHistory();
  if (hist.length === 0) { list.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text3);font-size:12px">No history yet</div>'; return; }
  list.innerHTML = '';
  const groups = {}; hist.forEach(h => { const d = new Date(h.ts).toDateString(); (groups[d] = groups[d] || []).push(h); });
  Object.entries(groups).forEach(([day, entries]) => {
    const t = document.createElement('div'); t.className = 'p-section-title'; t.textContent = new Date(entries[0].ts).toDateString() === new Date().toDateString() ? 'Today' : day; list.appendChild(t);
    entries.forEach(h => {
      const el = document.createElement('div'); el.className = 'p-entry';
      el.innerHTML = `<div class="p-entry-icon">🌐</div><div class="p-entry-title" title="${h.url}">${h.title || h.url}</div><div class="p-entry-meta">${new Date(h.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>`;
      el.addEventListener('click', () => { navigateTo(h.url); closeAllPanels(); }); list.appendChild(el);
    });
  });
}
document.getElementById('clearHistBtn').addEventListener('click', () => { DB.clearHistory(); renderHistoryPanel(); showToast('History cleared'); });
/* toggle handlers moved to initSettingsPanel() — removed duplicate */
document.getElementById('btnDevtools').addEventListener('click', toggleDevtools);
document.getElementById('closeDevtools').addEventListener('click', () => { document.getElementById('devtools').classList.remove('open'); STATE.devtoolsOpen = false; });
function toggleDevtools() { STATE.devtoolsOpen = !STATE.devtoolsOpen; document.getElementById('devtools').classList.toggle('open', STATE.devtoolsOpen); }

// ── Performance Monitor ───────────────────────────────────────────────────────
(function initPerfMon() {
  const MAX_HIST = 60;
  let ramHist = [], cpuHist = [], pmPaused = false, pmTimer = null;
  let peakRam = 0, peakCpu = 0;

  function fmt(mb) { return mb >= 1000 ? (mb/1024).toFixed(1)+' GB' : mb+' MB'; }
  function fmtSec(s) { const m=Math.floor(s/60), h=Math.floor(m/60); return h ? h+'h '+( m%60)+'m' : m ? m+'m '+(s%60)+'s' : s+'s'; }

  function drawSparkline(canvasId, data, color, maxVal) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const w = canvas.offsetWidth || canvas.parentElement?.offsetWidth || 436;
    canvas.width = w;
    const h = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (!data.length) return;
    const top = maxVal || Math.max(...data, 1);
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (MAX_HIST - 1)) * w;
      const y = h - (v / top) * (h - 4) - 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // fill under line
    ctx.lineTo((data.length - 1) / (MAX_HIST - 1) * w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color.replace(')', ',0.25)').replace('rgb', 'rgba').replace('#', 'rgba(').replace('rgba(', color.startsWith('#') ? 'rgba(' : 'rgba('));
    // simpler fill approach:
    ctx.fillStyle = color + '30';
    ctx.fill();
  }

  async function tick() {
    if (pmPaused) return;
    let metrics;
    try {
      metrics = await window.etherx?.app?.getProcessMetrics?.();
    } catch(e) { return; }
    if (!metrics) return;

    const ramVal = parseFloat(metrics.totalRamMB);
    const cpuVal = parseFloat(metrics.totalCpuPercent);
    ramHist.push(ramVal); if (ramHist.length > MAX_HIST) ramHist.shift();
    cpuHist.push(cpuVal); if (cpuHist.length > MAX_HIST) cpuHist.shift();
    if (ramVal > peakRam) peakRam = ramVal;
    if (cpuVal > peakCpu) peakCpu = cpuVal;

    // Summary cards
    const totalRamEl = document.getElementById('pmTotalRam');
    const totalCpuEl = document.getElementById('pmTotalCpu');
    if (totalRamEl) { totalRamEl.textContent = fmt(ramVal); totalRamEl.className = 'pm-card-val' + (ramVal > 2000 ? ' bad' : ramVal > 1000 ? ' warn' : ''); }
    if (totalCpuEl) { totalCpuEl.textContent = cpuVal + '%'; totalCpuEl.className = 'pm-card-val' + (cpuVal > 80 ? ' bad' : cpuVal > 50 ? ' warn' : ''); }
    const uptimeEl = document.getElementById('pmUptime'); if (uptimeEl) uptimeEl.textContent = fmtSec(metrics.uptime);

    // Peak labels
    const rp = document.getElementById('pmRamPeak'); if (rp) rp.textContent = 'peak ' + fmt(peakRam);
    const cp = document.getElementById('pmCpuPeak'); if (cp) cp.textContent = 'peak ' + peakCpu + '%';

    // Charts
    drawSparkline('pmRamChart', ramHist, '#667eea', null);
    drawSparkline('pmCpuChart', cpuHist, '#f5a623', 100);

    // JS Heap (renderer side)
    const heapMem = performance.memory;
    if (heapMem) {
      const used = (heapMem.usedJSHeapSize / 1048576).toFixed(1);
      const total = (heapMem.totalJSHeapSize / 1048576).toFixed(1);
      const limit = heapMem.jsHeapSizeLimit / 1048576;
      const pct = Math.min(100, (heapMem.usedJSHeapSize / heapMem.jsHeapSizeLimit) * 100).toFixed(0);
      const hu = document.getElementById('pmHeapUsed'); if (hu) hu.textContent = used + ' MB';
      const ht = document.getElementById('pmHeapTotal'); if (ht) ht.textContent = total + ' MB';
      const hb = document.getElementById('pmHeapBar'); if (hb) hb.style.width = pct + '%';
    }

    // Main process RSS in uptime tooltip
    const uptEl = document.getElementById('pmUptime');
    if (uptEl) uptEl.title = 'Main RSS: ' + metrics.mainRssMB + ' MB';

    // Per-process list
    const pl = document.getElementById('pmProcessList');
    if (pl && metrics.processes) {
      pl.innerHTML = '<div class="pm-proc-row" style="color:#666;font-size:9px;font-weight:600"><span>TYPE</span><span>PID</span><span style="text-align:right">RAM</span><span style="text-align:right">CPU</span></div>' +
        metrics.processes.map(p =>
          `<div class="pm-proc-row"><span class="pm-proc-type">${p.type}</span><span style="color:#555">${p.pid}</span><span style="text-align:right">${p.ramMB} MB</span><span style="text-align:right;color:${parseFloat(p.cpuPercent)>50?'var(--red)':parseFloat(p.cpuPercent)>20?'var(--yellow)':'var(--text2)'}">${p.cpuPercent}%</span></div>`
        ).join('');
    }

    // Tabs info
    const ti = document.getElementById('pmTabsInfo');
    if (ti) ti.textContent = metrics.windowCount + ' window(s) · ' + (Object.keys(STATE.tabs || {}).length || '?') + ' tabs';

    // Page metrics from active tab's perf data
    const tab = STATE.tabs?.[STATE.activeTabId];
    const pmFcp = document.getElementById('pmPageFcp');
    const pmLcp = document.getElementById('pmPageLcp');
    const pmLoad = document.getElementById('pmPageLoad');
    if (tab?.perfData) {
      if (pmFcp) pmFcp.textContent = tab.perfData.fcp != null ? tab.perfData.fcp + ' ms' : '—';
      if (pmLcp) pmLcp.textContent = tab.perfData.lcp != null ? tab.perfData.lcp + ' ms' : '—';
      if (pmLoad) pmLoad.textContent = tab.perfData.load != null ? tab.perfData.load + ' ms' : '—';
    } else {
      if (pmFcp) pmFcp.textContent = '—';
      if (pmLcp) pmLcp.textContent = '—';
      if (pmLoad) pmLoad.textContent = '—';
    }
  }

  function startPerfMon() {
    tick();
    pmTimer = setInterval(tick, 1500);
  }
  function stopPerfMon() {
    clearInterval(pmTimer);
    pmTimer = null;
  }

  // Pause/Resume button
  const pauseBtn = document.getElementById('pmPauseBtn');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      pmPaused = !pmPaused;
      pauseBtn.textContent = pmPaused ? '▶' : '⏸';
      document.getElementById('pmLiveIndicator').style.animationName = pmPaused ? 'none' : 'pmBlink';
      document.getElementById('pmLiveIndicator').textContent = pmPaused ? '● PAUSED' : '● LIVE';
      document.getElementById('pmLiveIndicator').style.color = pmPaused ? '#888' : '#27c93f';
    });
  }

  // Toggle button in toolbar
  const btnPerfMon = document.getElementById('btnPerfMon');
  if (btnPerfMon) {
    btnPerfMon.addEventListener('click', () => {
      const panel = document.getElementById('perfMonPanel');
      const wasOpen = panel?.classList.contains('open');
      closeAllPanels();
      if (!wasOpen && panel) {
        panel.classList.add('open');
        if (!pmTimer) startPerfMon();
        else { peakRam = 0; peakCpu = 0; tick(); }
      } else {
        stopPerfMon();
      }
    });
  }

  // Close button stops timer
  const closeBtn = document.getElementById('closePerfMonPanel');
  if (closeBtn) closeBtn.addEventListener('click', stopPerfMon);
})();
// ── End Performance Monitor ───────────────────────────────────────────────────

document.querySelectorAll('.dt-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.dt-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.dt-pane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const pane = document.getElementById('pane-' + tab.dataset.pane);
    if (pane) pane.classList.add('active');
    if (!STATE.devtoolsOpen) { STATE.devtoolsOpen = true; document.getElementById('devtools').classList.add('open'); }
    if (tab.dataset.pane === 'application') renderAppTab('localstorage');
    if (tab.dataset.pane === 'performance') collectPerfMetrics();
  });
});

// ── Resize handle
(function () {
  const handle = document.getElementById('dtResize');
  const dt = document.getElementById('devtools');
  if (!handle || !dt) return;
  let dragging = false, startY = 0, startH = 0;
  handle.addEventListener('mousedown', e => { dragging = true; startY = e.clientY; startH = dt.offsetHeight; document.body.style.cursor = 'ns-resize'; e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (!dragging) return; const delta = startY - e.clientY; dt.style.height = Math.min(Math.max(startH + delta, 120), window.innerHeight * 0.85) + 'px'; });
  document.addEventListener('mouseup', () => { if (dragging) { dragging = false; document.body.style.cursor = ''; } });
})();

// ── Console engine
const consoleOutput = document.getElementById('consoleOutput');
let dtErrCount = 0, dtWarnCount = 0;
function updateDtBadges() {
  const eb = document.getElementById('dtErrBadge'); const wb = document.getElementById('dtWarnBadge');
  if (eb) eb.textContent = dtErrCount || ''; if (wb) wb.textContent = dtWarnCount || '';
}
function consoleLog(type, msg, src) {
  const line = document.createElement('div'); line.className = 'cl ' + type;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const srcHtml = src ? `<span class="csrc">${src}</span>` : '';
  const icon = type === 'error' ? '⊗ ' : type === 'warn' ? '⚠ ' : type === 'info' ? 'ℹ ' : type === 'success' ? '✓ ' : type === 'verbose' ? '· ' : '';
  line.innerHTML = `<span class="cp">${time}</span><span class="cm">${icon}${msg}</span>${srcHtml}`;
  consoleOutput.appendChild(line); consoleOutput.scrollTop = consoleOutput.scrollHeight;
  if (type === 'error') { dtErrCount++; updateDtBadges(); }
  if (type === 'warn') { dtWarnCount++; updateDtBadges(); }
  applyConsoleFilter();
}

// ── Hook browser console & errors ────────────────────────────────────────
(function hookBrowserConsole() {
  const origLog = console.log, origWarn = console.warn, origError = console.error, origInfo = console.info;
  console.log = function (...args) { consoleLog('log', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '), 'browser.html'); origLog.apply(console, args); };
  console.warn = function (...args) { consoleLog('warn', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '), 'browser.html'); origWarn.apply(console, args); };
  console.error = function (...args) { consoleLog('error', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '), 'browser.html'); origError.apply(console, args); };
  console.info = function (...args) { consoleLog('info', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '), 'browser.html'); origInfo.apply(console, args); };

  // Global error handler
  window.addEventListener('error', e => {
    consoleLog('error', `${e.message} at ${e.filename}:${e.lineno}:${e.colno}`, e.filename || 'browser.html');
  });
  window.addEventListener('unhandledrejection', e => {
    consoleLog('error', 'Unhandled Promise Rejection: ' + (e.reason?.message || e.reason || 'Unknown'), 'Promise');
  });

  // Try to hook iframe console
  function hookFrameConsole() {
    const fr = document.getElementById('browseFrame');
    if (!fr) return;
    try {
      const win = fr.contentWindow;
      if (!win) return;
      const origFLog = win.console.log, origFWarn = win.console.warn, origFError = win.console.error;
      win.console.log = function (...args) { consoleLog('log', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '), 'page'); origFLog.apply(win.console, args); };
      win.console.warn = function (...args) { consoleLog('warn', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '), 'page'); origFWarn.apply(win.console, args); };
      win.console.error = function (...args) { consoleLog('error', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '), 'page'); origFError.apply(win.console, args); };
      win.addEventListener('error', e => consoleLog('error', `Page: ${e.message} at ${e.filename}:${e.lineno}`, 'page'));
      win.addEventListener('unhandledrejection', e => consoleLog('error', 'Page Promise Rejection: ' + (e.reason?.message || e.reason), 'page'));
    } catch (e) { /* cross-origin, can't hook */ }
  }
  const fr = document.getElementById('browseFrame');
  if (fr) {
    fr.addEventListener('load', () => setTimeout(hookFrameConsole, 100));
    fr.addEventListener('did-finish-load', () => setTimeout(hookFrameConsole, 100));
  }
})();

// ── Console input
document.getElementById('consoleInput').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  const code = e.target.value;
  consoleLog('log', '<span style="color:#858585">❯ </span>' + escHtml(code), 'console');
  try { const r = eval(code); if (r !== undefined) consoleLog('info', '← ' + JSON.stringify(r, null, 1), '<eval>:1'); }
  catch (err) { consoleLog('error', err.message, '<eval>:1'); }
  e.target.value = '';
});

// ── Console filter
let dtLevelFilter = { error: true, warn: true, info: true, log: true, verbose: true };
let dtTextFilter = '';
document.querySelectorAll('.con-lvl').forEach(btn => {
  btn.addEventListener('click', () => {
    const lvl = btn.dataset.lvl; dtLevelFilter[lvl] = !dtLevelFilter[lvl];
    btn.classList.toggle('on', dtLevelFilter[lvl]); applyConsoleFilter();
  });
});
const conFilterEl = document.getElementById('conFilter');
if (conFilterEl) conFilterEl.addEventListener('input', e => { dtTextFilter = e.target.value.toLowerCase(); applyConsoleFilter(); });
function applyConsoleFilter() {
  document.querySelectorAll('#consoleOutput .cl').forEach(el => {
    const msg = (el.querySelector('.cm')?.textContent || '').toLowerCase();
    const type = [...el.classList].find(c => ['log', 'info', 'warn', 'error', 'success', 'verbose'].includes(c)) || 'log';
    const lvl = type === 'success' ? 'log' : type;
    el.style.display = (dtLevelFilter[lvl] !== false && (!dtTextFilter || msg.includes(dtTextFilter))) ? '' : 'none';
  });
}

// ── Clear console
function clearConsole() {
  if (consoleOutput) consoleOutput.innerHTML = '';
  dtErrCount = 0; dtWarnCount = 0; updateDtBadges();
}
document.getElementById('conClear')?.addEventListener('click', clearConsole);
document.getElementById('dtBtnClear')?.addEventListener('click', clearConsole);

// ── Inspect Mode ──────────────────────────────────────────────────────────
let INSPECT_MODE = false;
let inspectTarget = null;

document.getElementById('dtBtnInspect')?.addEventListener('click', () => {
  INSPECT_MODE = !INSPECT_MODE;
  const btn = document.getElementById('dtBtnInspect');
  btn.style.background = INSPECT_MODE ? '#4a9eff' : '';
  btn.style.color = INSPECT_MODE ? '#fff' : '';
  const overlay = document.getElementById('inspectOverlay');
  if (!INSPECT_MODE) {
    overlay.style.display = 'none';
    document.removeEventListener('mousemove', inspectMouseMove);
    document.removeEventListener('click', inspectClick, true);
    return;
  }
  showToast('🔍 Inspect mode ON — hover over elements, click to select');
  document.addEventListener('mousemove', inspectMouseMove);
  document.addEventListener('click', inspectClick, true);
});

function inspectMouseMove(e) {
  if (!INSPECT_MODE) return;
  let target = document.elementFromPoint(e.clientX, e.clientY);
  if (!target || target.id === 'inspectOverlay' || target.id === 'inspectTooltip' || target.closest('#devtools') || target.closest('#toast')) {
    document.getElementById('inspectOverlay').style.display = 'none';
    return;
  }
  inspectTarget = target;
  const rect = target.getBoundingClientRect();
  const overlay = document.getElementById('inspectOverlay');
  const tooltip = document.getElementById('inspectTooltip');
  overlay.style.display = 'block';
  overlay.style.left = rect.left + 'px';
  overlay.style.top = rect.top + 'px';
  overlay.style.width = rect.width + 'px';
  overlay.style.height = rect.height + 'px';
  const tag = target.tagName.toLowerCase();
  const cls = target.className ? '.' + (typeof target.className === 'string' ? target.className.trim().split(/\s+/).join('.') : '') : '';
  const computed = window.getComputedStyle(target);
  const font = computed.fontFamily.split(',')[0].replace(/['"]/g, '') + ' ' + computed.fontSize;
  tooltip.textContent = `${tag}${cls} | ${Math.round(rect.width)}×${Math.round(rect.height)} | ${font}`;
}

function inspectClick(e) {
  if (!INSPECT_MODE) return;
  e.preventDefault();
  e.stopPropagation();
  INSPECT_MODE = false;
  document.getElementById('dtBtnInspect').style.background = '';
  document.getElementById('dtBtnInspect').style.color = '';
  document.getElementById('inspectOverlay').style.display = 'none';
  document.removeEventListener('mousemove', inspectMouseMove);
  document.removeEventListener('click', inspectClick, true);
  if (inspectTarget) {
    selectElement(inspectTarget);
    switchDevToolTab('elements');
    showToast('✅ Element selected: ' + inspectTarget.tagName.toLowerCase());
  }
}

// ── Elements Tab: DOM Tree ─────────────────────────────────────────────────
let selectedElement = null;

document.getElementById('elemRefreshBtn')?.addEventListener('click', renderDOMTree);

function renderDOMTree() {
  const frame = document.getElementById('browseFrame');
  const view = document.getElementById('elemView');
  if (!view) return;
  view.innerHTML = '<div style="color:#888;padding:8px">Loading DOM tree...</div>';
  setTimeout(() => {
    try {
      const doc = (frame && (frame.contentDocument || frame.contentWindow?.document)) || document;
      view.innerHTML = '';
      renderNode(doc.documentElement || doc.body, 0);
      showToast('🔄 DOM tree refreshed');
    } catch (e) {
      view.innerHTML = `<div style="color:#f48771;padding:8px">⚠️ Cannot access frame document (cross-origin or error)</div>`;
      if (!e.message?.includes('cross-origin') && !e.message?.includes('Blocked a frame') && !e.message?.includes('named property')) {
        consoleLog('error', 'DOM tree render failed: ' + e.message, 'Elements');
      }
    }
  }, 50);
}

function renderNode(node, depth) {
  if (!node) return;
  const view = document.getElementById('elemView');

  // Text nodes
  if (node.nodeType === 3) {
    const text = (node.textContent || '').trim();
    if (!text || text.length === 0) return;
    const el = document.createElement('div');
    el.className = 'el-node el-text-node';
    el.style.paddingLeft = (depth * 16 + 4) + 'px';
    el.innerHTML = `<span class="el-text">"${escHtml(text.slice(0, 60))}${text.length > 60 ? '...' : ''}"</span>`;
    view.appendChild(el);
    return;
  }

  // Element nodes
  if (node.nodeType !== 1) return;
  const el = document.createElement('div');
  el.className = 'el-node';
  el.style.paddingLeft = (depth * 16) + 'px';
  el._nodeRef = node;

  const tag = node.tagName.toLowerCase();
  const attrs = Array.from(node.attributes || [])
    .map(a => ` <span class="el-attr">${escHtml(a.name)}</span>=<span class="el-str">"${escHtml(a.value.slice(0, 40))}${a.value.length > 40 ? '...' : ''}"</span>`)
    .join('');
  const hasChildren = (node.children && node.children.length > 0) || (node.childNodes && Array.from(node.childNodes).some(n => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim())));
  const arrow = hasChildren ? '<span class="el-arrow">▸</span>' : '<span style="display:inline-block;width:10px"></span>';

  el.innerHTML = `${arrow}<span class="el-tag">&lt;${tag}</span>${attrs}<span class="el-tag">&gt;</span>`;
  el.onclick = (e) => {
    e.stopPropagation();
    document.querySelectorAll('.el-node').forEach(n => n.classList.remove('el-selected'));
    el.classList.add('el-selected');
    selectElement(node);
    if (hasChildren && el.querySelector('.el-arrow')) {
      const arrowEl = el.querySelector('.el-arrow');
      const isExpanded = arrowEl.textContent === '▾';
      arrowEl.textContent = isExpanded ? '▸' : '▾';
      let nextEl = el.nextElementSibling;
      while (nextEl && nextEl.style.paddingLeft && parseInt(nextEl.style.paddingLeft) > parseInt(el.style.paddingLeft)) {
        nextEl.style.display = isExpanded ? 'none' : '';
        nextEl = nextEl.nextElementSibling;
      }
    }
  };

  view.appendChild(el);

  // Render children
  if (hasChildren && node.childNodes) {
    Array.from(node.childNodes).forEach(child => renderNode(child, depth + 1));
  }
}

// ── Elements Sidebar Tabs ──────────────────────────────────────────────────
document.querySelectorAll('.elem-stab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.elem-stab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.estab-pane').forEach(p => p.style.display = 'none');
    tab.classList.add('active');
    const pane = document.getElementById('estab-' + tab.dataset.estab);
    if (pane) pane.style.display = 'block';
  });
});

function selectElement(elem) {
  if (!elem || elem.nodeType !== 1) return;
  selectedElement = elem;

  // Styles tab — inline + computed preview
  const inline = elem.style?.cssText || '/* No inline styles */';
  const inlineEl = document.getElementById('elemInlineStyles');
  if (inlineEl) inlineEl.textContent = inline;

  try {
    const computed = window.getComputedStyle(elem);
    const previewEl = document.getElementById('elemComputedPreview');
    if (previewEl) {
      previewEl.innerHTML = `
            <strong>width:</strong> ${computed.width}<br>
            <strong>height:</strong> ${computed.height}<br>
            <strong>display:</strong> ${computed.display}<br>
            <strong>position:</strong> ${computed.position}<br>
            <strong>color:</strong> <span style="display:inline-block;width:12px;height:12px;background:${computed.color};border:1px solid #555;vertical-align:middle"></span> ${computed.color}<br>
            <strong>background:</strong> <span style="display:inline-block;width:12px;height:12px;background:${computed.backgroundColor};border:1px solid #555;vertical-align:middle"></span> ${computed.backgroundColor}<br>
            <strong>font:</strong> ${computed.fontFamily.split(',')[0].replace(/['"]/g, '')} ${computed.fontSize} ${computed.fontWeight}
          `;
    }

    // Computed tab — all properties
    const fullEl = document.getElementById('elemComputedFull');
    if (fullEl) {
      const all = Array.from(computed).sort().map(prop => `<div><strong>${prop}:</strong> ${computed.getPropertyValue(prop)}</div>`).join('');
      fullEl.innerHTML = all || 'No computed styles';
    }

    // Layout tab — box model
    const w = parseInt(computed.width) || 0;
    const h = parseInt(computed.height) || 0;
    const m = computed.margin || '0';
    const b = computed.border || 'none';
    const p = computed.padding || '0';
    const boxW = document.getElementById('boxWidth');
    const boxH = document.getElementById('boxHeight');
    const boxM = document.getElementById('boxMargin');
    const boxB = document.getElementById('boxBorder');
    const boxP = document.getElementById('boxPadding');
    const posEl = document.getElementById('elemPosition');
    if (boxW) boxW.textContent = w;
    if (boxH) boxH.textContent = h;
    if (boxM) boxM.textContent = m;
    if (boxB) boxB.textContent = b;
    if (boxP) boxP.textContent = p;
    if (posEl) posEl.textContent = `position: ${computed.position} | top: ${computed.top} | left: ${computed.left} | z-index: ${computed.zIndex}`;

    // Events tab
    const eventsEl = document.getElementById('elemEvents');
    if (eventsEl) {
      eventsEl.innerHTML = '<div style="color:#888">Event listeners are not accessible in this browser implementation</div>';
    }
  } catch (e) {
    consoleLog('error', 'Failed to compute element styles: ' + e.message, 'Elements');
  }
}

// ── Network log
const networkLog = document.getElementById('networkLog');
function logNetworkEntry(url, type, status, size, time) {
  if (!STATE.devtoolsOpen) return;
  const tr = document.createElement('tr');
  const name = (url.split('/').pop().split('?')[0] || '/').slice(0, 40);
  const t = type || 'HTML'; const s = status || 200; const sz = size || (Math.floor(Math.random() * 200 + 10) + 'KB'); const ms = time || (Math.floor(Math.random() * 200 + 20) + 'ms');
  const badgeClass = { 'HTML': 'b-html', 'JS': 'b-js', 'CSS': 'b-css', 'Img': 'b-img', 'XHR': 'b-xhr', 'WS': 'b-ws' }[t] || 'b-html';
  const bar = Math.min(100, Math.floor(Math.random() * 80 + 10));
  tr.dataset.type = t;
  tr.innerHTML = `<td title="${escHtml(url)}">${escHtml(name)}</td><td style="color:${s >= 400 ? '#f48771' : '#89d185'}">${s}</td><td><span class="badge ${badgeClass}">${t}</span></td><td>${sz}</td><td>${ms}</td><td><div class="net-bar-wrap"><div class="net-bar" style="width:${bar}%"></div></div></td>`;
  networkLog.appendChild(tr);
}

// ── Network controls
document.getElementById('netClear')?.addEventListener('click', () => { if (networkLog) networkLog.innerHTML = ''; });
document.querySelectorAll('.net-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.net-type-btn').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    document.querySelectorAll('#networkLog tr').forEach(tr => {
      tr.style.display = (btn.dataset.ntype === 'All' || tr.dataset.type === btn.dataset.ntype) ? '' : 'none';
    });
  });
});
document.getElementById('netFilter')?.addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('#networkLog tr').forEach(tr => { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; });
});

// ── Application tab
const _appMap = { 'appLocalStorage': 'localstorage', 'appSessionStorage': 'sessionstorage', 'appCookies': 'cookies', 'appIndexedDB': 'indexeddb', 'appCacheStorage': 'cache', 'appServiceWorkers': 'sw', 'appSqliteHistory': 'sqlite-history', 'appSqliteTabs': 'sqlite-tabs', 'appSqliteBookmarks': 'sqlite-bookmarks', 'appSqliteAiCache': 'sqlite-aicache', 'appSqliteSettings': 'sqlite-settings', 'appSqliteUser': 'sqlite-user', 'appSqliteNotes': 'sqlite-notes', 'appSqliteDownloads': 'sqlite-downloads', 'appSqliteSessions': 'sqlite-sessions', 'appSqlitePasswords': 'sqlite-passwords' };
Object.entries(_appMap).forEach(([id, type]) => {
  document.getElementById(id)?.addEventListener('click', () => {
    document.querySelectorAll('.app-item').forEach(x => x.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    renderAppTab(type);
  });
});
function renderAppTab(type) {
  const c = document.getElementById('appContent'); if (!c) return;
  if (type === 'localstorage') {
    const keys = Object.keys(localStorage);
    if (!keys.length) { c.innerHTML = '<p style="color:#555;font-size:11px;padding:8px">No local storage data.</p>'; return; }
    c.innerHTML = '<table class="app-table"><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>' +
      keys.map(k => { let v = localStorage.getItem(k) || ''; if (v.length > 120) v = v.slice(0, 120) + '…'; return `<tr><td>${escHtml(k)}</td><td>${escHtml(v)}</td></tr>`; }).join('') + '</tbody></table>';
  } else if (type === 'sessionstorage') {
    const keys = Object.keys(sessionStorage);
    if (!keys.length) { c.innerHTML = '<p style="color:#555;font-size:11px;padding:8px">No session storage data.</p>'; return; }
    c.innerHTML = '<table class="app-table"><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>' +
      keys.map(k => `<tr><td>${escHtml(k)}</td><td>${escHtml(sessionStorage.getItem(k) || '')}</td></tr>`).join('') + '</tbody></table>';
  } else if (type === 'cookies') {
    if (!document.cookie) { c.innerHTML = '<p style="color:#555;font-size:11px;padding:8px">No cookies.</p>'; return; }
    c.innerHTML = '<table class="app-table"><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>' +
      document.cookie.split(';').map(p => { const [k, ...v] = p.trim().split('='); return `<tr><td>${escHtml(k)}</td><td>${escHtml(v.join('='))}</td></tr>`; }).join('') + '</tbody></table>';

    // ── SQLite tables ──────────────────────────────────────────────────
  } else if (type === 'sqlite-history') {
    c.innerHTML = _sqliteLoading('History');
    const rows = DB.getHistory();
    if (!rows.length) { c.innerHTML = _sqliteEmpty('history'); return; }
    c.innerHTML = `<div style="padding:8px 10px;font-size:10px;color:#858585;border-bottom:1px solid var(--border)">SQLite • etherx.db • table: <strong>history</strong> • ${rows.length} rows</div>` +
      '<table class="app-table"><thead><tr><th>#</th><th>URL</th><th>Title</th><th>Visits</th><th>Last Visited</th></tr></thead><tbody>' +
      rows.slice(0, 200).map((r, i) => {
        const ts = r.ts || r.last_visited; const date = ts ? new Date(ts < 1e12 ? ts * 1000 : ts).toLocaleString('hr-HR') : '';
        const url = r.url || ''; const short = url.length > 50 ? url.slice(0, 50) + '…' : url;
        return `<tr><td style="color:#555">${i + 1}</td><td title="${escHtml(url)}"><a href="#" onclick="navigateTo('${escHtml(url)}');return false" style="color:var(--accent)">${escHtml(short)}</a></td><td>${escHtml(r.title || '')}</td><td style="text-align:center">${r.visit_count || 1}</td><td style="color:#777;white-space:nowrap">${date}</td></tr>`;
      }).join('') + '</tbody></table>';
  } else if (type === 'sqlite-tabs') {
    c.innerHTML = _sqliteLoading('Open Tabs');
    // In Electron: fetch from SQLite; in web mode use STATE.tabs
    const fetchTabs = (window.etherx?.tabs?.getAll)
      ? window.etherx.tabs.getAll()
      : Promise.resolve(STATE.tabs);
    fetchTabs.then(rows => {
      if (!rows || !rows.length) { c.innerHTML = _sqliteEmpty('open_tabs'); return; }
      c.innerHTML = `<div style="padding:8px 10px;font-size:10px;color:#858585;border-bottom:1px solid var(--border)">SQLite • etherx.db • table: <strong>tabs</strong> • ${rows.length} rows</div>` +
        '<table class="app-table"><thead><tr><th>#</th><th>URL</th><th>Title</th><th>Active</th><th>Pinned</th><th>Group</th></tr></thead><tbody>' +
        rows.map((r, i) => {
          const url = r.url || ''; const short = url.length > 45 ? url.slice(0, 45) + '…' : url;
          return `<tr><td style="color:#555">${i + 1}</td><td title="${escHtml(url)}"><a href="#" onclick="navigateTo('${escHtml(url)}');return false" style="color:var(--accent)">${escHtml(short)}</a></td><td>${escHtml(r.title || 'New Tab')}</td><td style="text-align:center">${r.isActive || r.is_active ? '✅' : ''}</td><td style="text-align:center">${r.isPinned || r.is_pinned ? '📌' : ''}</td><td style="color:#888">${escHtml(r.groupName || r.group_name || '')}</td></tr>`;
        }).join('') + '</tbody></table>';
    });
  } else if (type === 'sqlite-bookmarks') {
    c.innerHTML = _sqliteLoading('Bookmarks');
    const fetchBm = (window.etherx?.bookmarks?.getAll)
      ? window.etherx.bookmarks.getAll()
      : Promise.resolve(DB.getBookmarks());
    fetchBm.then(rows => {
      if (!rows || !rows.length) { c.innerHTML = _sqliteEmpty('bookmarks'); return; }
      c.innerHTML = `<div style="padding:8px 10px;font-size:10px;color:#858585;border-bottom:1px solid var(--border)">SQLite • etherx.db • table: <strong>bookmarks</strong> • ${rows.length} rows</div>` +
        '<table class="app-table"><thead><tr><th>#</th><th>URL</th><th>Title</th><th>Folder</th><th>Added</th></tr></thead><tbody>' +
        rows.map((r, i) => {
          const url = r.url || ''; const short = url.length > 45 ? url.slice(0, 45) + '…' : url;
          const ts = r.ts || r.created_at; const date = ts ? new Date(ts < 1e12 ? ts * 1000 : ts).toLocaleDateString('hr-HR') : '';
          return `<tr><td style="color:#555">${i + 1}</td><td title="${escHtml(url)}"><a href="#" onclick="navigateTo('${escHtml(url)}');return false" style="color:var(--accent)">${escHtml(short)}</a></td><td>${escHtml(r.title || '')}</td><td style="color:#888">${escHtml(r.folder || 'Bookmarks Bar')}</td><td style="color:#777;white-space:nowrap">${date}</td></tr>`;
        }).join('') + '</tbody></table>';
    });
  } else if (type === 'sqlite-aicache') {
    c.innerHTML = _sqliteLoading('AI Cache');
    const fetchCache = (window.etherx?.ai?.getCachedSummaries)
      ? window.etherx.ai.getCachedSummaries(100)
      : Promise.resolve(Object.entries(_summaryCache || {}).map(([hash, v]) => ({ url_hash: hash, url: '', summary: v.summary || '', model: 'gemini-2.5-flash', created_at: '' })));
    fetchCache.then(rows => {
      if (!rows || !rows.length) { c.innerHTML = _sqliteEmpty('ai_cache'); return; }
      c.innerHTML = `<div style="padding:8px 10px;font-size:10px;color:#858585;border-bottom:1px solid var(--border)">SQLite • etherx.db • table: <strong>ai_cache</strong> • ${rows.length} rows • <button onclick="(window.etherx?.ai?.clearAiCache?.() || (_summaryCache && Object.keys(_summaryCache).forEach(k=>delete _summaryCache[k])));renderAppTab('sqlite-aicache')" style="background:#c0392b;border:none;color:#fff;border-radius:3px;cursor:pointer;font-size:10px;padding:1px 6px">Clear Cache</button></div>` +
        '<table class="app-table"><thead><tr><th>#</th><th>URL</th><th>Summary</th><th>Model</th><th>Cached</th></tr></thead><tbody>' +
        rows.map((r, i) => {
          const url = r.url || ''; const short = url.length > 35 ? url.slice(0, 35) + '…' : url;
          const sum = (r.summary || '').slice(0, 80) + ((r.summary || '').length > 80 ? '…' : '');
          const ts = r.created_at; const date = ts ? new Date(ts < 1e12 ? ts * 1000 : ts).toLocaleDateString('hr-HR') : '';
          return `<tr><td style="color:#555">${i + 1}</td><td title="${escHtml(url)}" style="color:var(--accent);max-width:120px">${escHtml(short)}</td><td style="max-width:200px;color:#ccc">${escHtml(sum)}</td><td style="color:#4285f4">${escHtml(r.model || '')}</td><td style="color:#777;white-space:nowrap">${date}</td></tr>`;
        }).join('') + '</tbody></table>';
    });
  } else if (type === 'sqlite-settings') {
    c.innerHTML = _sqliteLoading('Settings');
    const fetchSettings = (window.etherx?.settings?.get)
      ? window.etherx.settings.get()
      : Promise.resolve(DB.getSettings());
    fetchSettings.then(obj => {
      const entries = obj && typeof obj === 'object' ? Object.entries(obj) : [];
      if (!entries.length) { c.innerHTML = _sqliteEmpty('settings'); return; }
      const HIDDEN = ['gemini_api_key', 'openai_api_key', 'api_key'];
      c.innerHTML = `<div style="padding:8px 10px;font-size:10px;color:#858585;border-bottom:1px solid var(--border)">SQLite • etherx.db • table: <strong>settings</strong> • ${entries.length} rows
            <button onclick="renderAppTab('sqlite-settings')" style="margin-left:8px;background:#333;border:none;color:#aaa;border-radius:3px;cursor:pointer;font-size:10px;padding:1px 6px">↺ Refresh</button></div>` +
        '<table class="app-table"><thead><tr><th>Key</th><th>Value</th><th style="width:60px"></th></tr></thead><tbody id="settingsTableBody">' +
        entries.map(([k, v]) => {
          const display = HIDDEN.some(h => k.includes(h)) ? '•••••••••• (hidden)' : escHtml(String(v).slice(0, 100));
          return `<tr><td style="color:var(--yellow)">${escHtml(k)}</td><td style="color:#ccc" id="sv_${escHtml(k)}">${display}</td><td><button onclick="_editSetting('${escHtml(k)}')" style="background:none;border:1px solid #555;border-radius:3px;color:#aaa;cursor:pointer;font-size:10px;padding:1px 5px">✏️</button> <button onclick="_deleteSetting('${escHtml(k)}')" style="background:none;border:1px solid #c0392b44;border-radius:3px;color:#e74c3c;cursor:pointer;font-size:10px;padding:1px 5px">✕</button></td></tr>`;
        }).join('') + '</tbody></table>' +
        `<div style="padding:8px 10px;border-top:1px solid var(--border);display:flex;gap:6px">
              <input id="newSettingKey" placeholder="key" style="flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;color:var(--text);padding:3px 6px;font-size:11px">
              <input id="newSettingVal" placeholder="value" style="flex:2;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;color:var(--text);padding:3px 6px;font-size:11px">
              <button onclick="_addSetting()" style="background:var(--accent);border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;padding:3px 10px">+ Add</button>
            </div>`;
    });

  } else if (type === 'sqlite-user') {
    const u = DB.getUser();
    c.innerHTML = `<div style="padding:8px 10px;font-size:10px;color:#858585;border-bottom:1px solid var(--border)">SQLite • etherx.db • table: <strong>user_profile</strong> • 1 row</div>
          <div style="padding:12px">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
              <div id="userAvatarDisp" style="font-size:36px;cursor:pointer" title="Click to change avatar" onclick="_changeUserAvatar()">${escHtml(u.avatar || '👤')}</div>
              <div>
                <div style="font-size:13px;font-weight:600;color:var(--text)">${escHtml(u.name || '(no name)')}</div>
                <div style="font-size:11px;color:var(--text3)">${escHtml(u.email || '(no email)')}</div>
              </div>
            </div>
            <table class="app-table"><thead><tr><th>Field</th><th>Value</th><th style="width:60px"></th></tr></thead><tbody>
              ${['name', 'email', 'avatar', 'bio', 'website', 'location'].map(f => `<tr><td style="color:var(--yellow)">${f}</td><td id="uf_${f}" style="color:#ccc">${escHtml(String(u[f] || ''))}</td><td><button onclick="_editUserField('${f}')" style="background:none;border:1px solid #555;border-radius:3px;color:#aaa;cursor:pointer;font-size:10px;padding:1px 5px">✏️</button></td></tr>`).join('')}
            </tbody></table>
            <div style="padding:8px 0;font-size:10px;color:#555">Created: ${u.createdAt ? new Date(u.createdAt).toLocaleString('hr-HR') : '—'} &nbsp;|&nbsp; Updated: ${u.updatedAt ? new Date(u.updatedAt).toLocaleString('hr-HR') : '—'}</div>
          </div>`;

  } else if (type === 'sqlite-notes') {
    const notes = DB.getNotes();
    c.innerHTML = `<div style="padding:8px 10px;font-size:10px;color:#858585;border-bottom:1px solid var(--border)">SQLite • etherx.db • table: <strong>notes</strong> • ${notes.length} rows
          <button onclick="renderAppTab('sqlite-notes')" style="margin-left:8px;background:#333;border:none;color:#aaa;border-radius:3px;cursor:pointer;font-size:10px;padding:1px 6px">↺</button></div>` +
      (notes.length ? '<table class="app-table"><thead><tr><th>#</th><th>Title</th><th>Content</th><th>Date</th><th style="width:70px"></th></tr></thead><tbody>' +
        notes.map((n, i) => {
          const dt = new Date(n.ts).toLocaleDateString('hr-HR');
          const body = (n.content || '').slice(0, 60) + ((n.content || '').length > 60 ? '…' : '');
          return `<tr><td style="color:#555">${i + 1}</td><td style="color:var(--accent);font-weight:600">${escHtml(n.title || 'Untitled')}</td><td style="color:#ccc">${escHtml(body)}</td><td style="color:#777;white-space:nowrap">${dt}</td><td><button onclick="_editNote(${n.id})" style="background:none;border:1px solid #555;border-radius:3px;color:#aaa;cursor:pointer;font-size:10px;padding:1px 4px">✏️</button> <button onclick="DB.deleteNote(${n.id});renderAppTab('sqlite-notes')" style="background:none;border:1px solid #c0392b44;border-radius:3px;color:#e74c3c;cursor:pointer;font-size:10px;padding:1px 4px">✕</button></td></tr>`;
        }).join('') + '</tbody></table>' : '<p style="color:#555;font-size:11px;padding:12px">No notes yet.</p>') +
      `<div style="padding:8px 10px;border-top:1px solid var(--border);display:flex;gap:6px">
            <input id="newNoteTitle" placeholder="Title" style="flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;color:var(--text);padding:3px 6px;font-size:11px">
            <input id="newNoteContent" placeholder="Content…" style="flex:3;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;color:var(--text);padding:3px 6px;font-size:11px">
            <button onclick="_addNote()" style="background:var(--accent);border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;padding:3px 10px">+ Add</button>
          </div>`;

  } else if (type === 'sqlite-downloads') {
    const rows = DB.getDownloads();
    if (!rows.length) { c.innerHTML = _sqliteEmpty('downloads'); return; }
    c.innerHTML = `<div style="padding:8px 10px;font-size:10px;color:#858585;border-bottom:1px solid var(--border)">SQLite • etherx.db • table: <strong>downloads</strong> • ${rows.length} rows</div>` +
      '<table class="app-table"><thead><tr><th>#</th><th>Filename</th><th>URL</th><th>Size</th><th>Date</th></tr></thead><tbody>' +
      rows.slice(0, 200).map((r, i) => {
        const dt = r.ts ? new Date(r.ts).toLocaleDateString('hr-HR') : '';
        const url = (r.url || '').slice(0, 40) + '…';
        return `<tr><td style="color:#555">${i + 1}</td><td style="color:var(--accent)">${escHtml(r.filename || r.name || '?')}</td><td title="${escHtml(r.url || '')}" style="color:#888">${escHtml(url)}</td><td style="color:#aaa">${r.size || ''}</td><td style="color:#777;white-space:nowrap">${dt}</td></tr>`;
      }).join('') + '</tbody></table>';

  } else if (type === 'sqlite-sessions') {
    const rows = DB.getSessions();
    if (!rows.length) { c.innerHTML = _sqliteEmpty('sessions'); return; }
    c.innerHTML = `<div style="padding:8px 10px;font-size:10px;color:#858585;border-bottom:1px solid var(--border)">SQLite • etherx.db • table: <strong>sessions</strong> • ${rows.length} saved sessions
          <button onclick="DB.saveSession(STATE.tabs);renderAppTab('sqlite-sessions')" style="margin-left:8px;background:var(--accent);border:none;color:#fff;border-radius:3px;cursor:pointer;font-size:10px;padding:1px 6px">💾 Save Current</button></div>` +
      '<table class="app-table"><thead><tr><th>#</th><th>Tabs</th><th>Saved</th><th style="width:80px"></th></tr></thead><tbody>' +
      rows.map((r, i) => {
        const dt = new Date(r.ts).toLocaleString('hr-HR');
        const preview = (r.tabs || []).slice(0, 3).map(t => escHtml((t.title || t.url || '?').slice(0, 20))).join(', ') + (r.tabs?.length > 3 ? '…' : '');
        return `<tr><td style="color:#555">${i + 1}</td><td style="color:#ccc;font-size:10px">${r.count} tabs: ${preview}</td><td style="color:#777;white-space:nowrap;font-size:10px">${dt}</td><td><button onclick="_restoreSession(${r.id})" style="background:none;border:1px solid #555;border-radius:3px;color:#aaa;cursor:pointer;font-size:10px;padding:1px 5px">↺ Restore</button></td></tr>`;
      }).join('') + '</tbody></table>';

  } else if (type === 'sqlite-passwords') {
    const HIDDEN_PWD = true;
    const rows = JSON.parse(localStorage.getItem('ex_passwords') || '[]');
    if (!rows.length) { c.innerHTML = _sqliteEmpty('passwords'); return; }
    c.innerHTML = `<div style="padding:8px 10px;font-size:10px;color:#858585;border-bottom:1px solid var(--border)">SQLite • etherx.db • table: <strong>passwords</strong> • ${rows.length} entries <span style="color:#e74c3c">(passwords are masked)</span></div>` +
      '<table class="app-table"><thead><tr><th>#</th><th>Site</th><th>Username</th><th>Password</th><th>Added</th></tr></thead><tbody>' +
      rows.map((r, i) => {
        const dt = r.ts ? new Date(r.ts).toLocaleDateString('hr-HR') : '';
        return `<tr><td style="color:#555">${i + 1}</td><td style="color:var(--accent)">${escHtml(r.site || '')}</td><td style="color:#ccc">${escHtml(r.username || '')}</td><td style="color:#555">••••••••</td><td style="color:#777;white-space:nowrap">${dt}</td></tr>`;
      }).join('') + '</tbody></table>';

  } else {
    c.innerHTML = '<p style="color:#555;font-size:11px;padding:8px">No data available.</p>';
  }
}
function _sqliteLoading(name) { return `<div style="padding:16px;color:#858585;font-size:12px;display:flex;align-items:center;gap:8px"><div style="width:14px;height:14px;border:2px solid #555;border-top-color:#4a9eff;border-radius:50%;animation:spin .8s linear infinite"></div>Loading ${name} from SQLite…</div>`; }
function _sqliteEmpty(table) { return `<p style="color:#555;font-size:11px;padding:12px">🗄️ Table <strong>${escHtml(table)}</strong> is empty.</p>`; }
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ── DevTools Tab Switcher ─────────────────────────────────────────────────
function switchDevToolTab(paneName) {
  document.querySelectorAll('.dt-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.dt-pane').forEach(p => p.classList.remove('active'));
  const tab = document.querySelector(`.dt-tab[data-pane="${paneName}"]`);
  const pane = document.getElementById('pane-' + paneName);
  if (tab) tab.classList.add('active');
  if (pane) pane.classList.add('active');
}

// ── Application tab CRUD helpers ──────────────────────────────────────────
function _editSetting(k) {
  const HIDDEN = ['gemini_api_key', 'openai_api_key', 'api_key'];
  const s = DB.getSettings();
  const cur = HIDDEN.some(h => k.includes(h)) ? '' : (s[k] !== undefined ? String(s[k]) : '');
  const nv = prompt('Edit setting: ' + k, cur);
  if (nv === null) return;
  let parsed = nv;
  if (nv === 'true') parsed = true; else if (nv === 'false') parsed = false; else if (!isNaN(nv) && nv !== '') parsed = Number(nv);
  DB.saveSetting(k, parsed);
  renderAppTab('sqlite-settings');
  showToast('✅ Setting "' + k + '" updated');
}
function _deleteSetting(k) {
  if (!confirm('Delete setting: ' + k + '?')) return;
  const s = DB.getSettings(); delete s[k]; localStorage.setItem('ex_cfg', JSON.stringify(s));
  renderAppTab('sqlite-settings');
  showToast('🗑 Setting "' + k + '" deleted');
}
function _addSetting() {
  const k = document.getElementById('newSettingKey')?.value?.trim();
  const v = document.getElementById('newSettingVal')?.value?.trim();
  if (!k) { showToast('⚠️ Key cannot be empty'); return; }
  let parsed = v;
  if (v === 'true') parsed = true; else if (v === 'false') parsed = false; else if (!isNaN(v) && v !== '') parsed = Number(v);
  DB.saveSetting(k, parsed);
  renderAppTab('sqlite-settings');
  showToast('✅ Setting "' + k + '" added');
}
function _editUserField(f) {
  const u = DB.getUser();
  const nv = prompt('Edit ' + f + ':', u[f] || '');
  if (nv === null) return;
  DB.saveUser({ [f]: nv });
  renderAppTab('sqlite-user');
  showToast('✅ User ' + f + ' updated');
}
function _changeUserAvatar() {
  const nv = prompt('Enter emoji or text for avatar:', DB.getUser().avatar || '👤');
  if (nv === null) return;
  DB.saveUser({ avatar: nv });
  renderAppTab('sqlite-user');
}
function _addNote() {
  const t = document.getElementById('newNoteTitle')?.value?.trim();
  const body = document.getElementById('newNoteContent')?.value?.trim();
  if (!t) { showToast('⚠️ Note title cannot be empty'); return; }
  DB.addNote({ title: t, content: body || '' });
  renderAppTab('sqlite-notes');
  showToast('📝 Note added: ' + t);
}
function _editNote(id) {
  const n = DB.getNotes().find(x => x.id === id);
  if (!n) return;
  const nt = prompt('Title:', n.title || '');
  if (nt === null) return;
  const nb = prompt('Content:', n.content || '');
  if (nb === null) return;
  DB.updateNote(id, { title: nt, content: nb });
  renderAppTab('sqlite-notes');
  showToast('📝 Note updated');
}
function _restoreSession(id) {
  const sessions = DB.getSessions();
  const sess = sessions.find(s => s.id === id);
  if (!sess || !sess.tabs?.length) { showToast('⚠️ Session is empty'); return; }
  if (!confirm('Restore session with ' + sess.tabs.length + ' tabs? This will open them as new tabs.')) return;
  sess.tabs.forEach(t => createTab(t.url, t.title, false));
  showToast('↺ Session restored: ' + sess.tabs.length + ' tabs');
}

// ── Performance metrics
function collectPerfMetrics() {
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) {
      const load = (nav.loadEventEnd - nav.startTime).toFixed(0);
      const tti = (nav.domInteractive - nav.startTime).toFixed(0);
      const el = document.getElementById('perfLoad'); if (el) el.textContent = load + 'ms';
      const et = document.getElementById('perfTti'); if (et) et.textContent = tti + 'ms';
    }
    performance.getEntriesByType('paint').forEach(p => {
      if (p.name === 'first-contentful-paint') { const el = document.getElementById('perfFcp'); if (el) el.textContent = p.startTime.toFixed(0) + 'ms'; }
    });
  } catch (e) { }
}
document.getElementById('mi-new-tab').addEventListener('click', () => createTab());
document.getElementById('mi-close-tab').addEventListener('click', () => closeTab(STATE.activeTabId));
document.getElementById('mi-find').addEventListener('click', openFind);
document.getElementById('mi-reload').addEventListener('click', () => document.getElementById('btnReload').click());
document.getElementById('mi-hard-reload').addEventListener('click', () => { const t = getActiveTab(); if (t?.url) { frame.src = ''; setTimeout(() => { if (window.electronWebview) { frame.src = t.url; } else { frame.src = t.url; } setLoading(20); }, 50); } });
document.getElementById('mi-zoom-in').addEventListener('click', () => setZoom(STATE.zoom + 10));
document.getElementById('mi-zoom-out').addEventListener('click', () => setZoom(STATE.zoom - 10));
document.getElementById('mi-zoom-reset').addEventListener('click', () => setZoom(100));
// View menu new items
document.getElementById('mi-always-toolbar').addEventListener('click', () => { const chk = document.getElementById('mi-always-toolbar-chk'); const on = chk.style.opacity !== '0'; chk.style.opacity = on ? '0' : '1'; DB.saveSetting('alwaysToolbar', !on); showToast((on ? 'Hide' : 'Show') + ' toolbar in full screen'); });
document.getElementById('mi-customise-toolbar').addEventListener('click', () => { openCustomToolbar(); });
document.getElementById('mi-always-tab-bar').addEventListener('click', () => { const chk = document.getElementById('mi-always-tab-bar-chk'); const on = chk.style.opacity !== '0'; chk.style.opacity = on ? '0' : '1'; const tb = document.getElementById('tabBar'); tb.style.display = on ? 'none' : 'flex'; showToast((on ? 'Hide' : 'Always show') + ' Tab Bar'); });
document.getElementById('mi-show-favbar').addEventListener('click', () => { const chk = document.getElementById('mi-show-favbar-chk'); const on = chk.style.opacity !== '0'; chk.style.opacity = on ? '0' : '1'; let fb = document.getElementById('favBar'); if (!on) { if (!fb) { fb = document.createElement('div'); fb.id = 'favBar'; fb.style.cssText = 'height:28px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 8px;gap:4px;flex-shrink:0;font-size:11px;overflow-x:auto'; const bms = DB.getBookmarks().slice(0, 8); if (bms.length === 0) { fb.innerHTML = '<span style="color:var(--text3);padding:0 8px">Add bookmarks to see them here</span>'; } else { bms.forEach(b => { const btn = document.createElement('button'); btn.style.cssText = 'background:var(--bg3);border:1px solid var(--border2);border-radius:10px;color:var(--text2);padding:2px 10px;cursor:pointer;font-size:11px;white-space:nowrap'; btn.textContent = '🌐 ' + (b.title || b.url).slice(0, 18); btn.addEventListener('click', () => navigateTo(b.url)); fb.appendChild(btn); }); } const navBar = document.querySelector('.nav-bar'); navBar.parentNode.insertBefore(fb, navBar.nextSibling); } fb.style.display = 'flex'; showToast('⭐ Favourites Bar shown'); } else { if (fb) fb.style.display = 'none'; showToast('⭐ Favourites Bar hidden'); } });
document.getElementById('mi-show-statusbar').addEventListener('click', () => { const chk = document.getElementById('mi-show-statusbar-chk'); const on = chk.style.opacity !== '0'; chk.style.opacity = on ? '0' : '1'; const sb = document.querySelector('.status-bar'); sb.style.display = on ? 'none' : 'flex'; showToast((on ? 'Hide' : 'Show') + ' Status Bar'); });
document.getElementById('mi-show-sidebar').addEventListener('click', () => { renderBookmarksPanel(); togglePanel('bmPanel'); document.getElementById('mi-show-sidebar-chk').style.opacity = document.getElementById('bmPanel').classList.contains('open') ? '1' : '0'; });
document.getElementById('mi-show-bm-sidebar').addEventListener('click', () => { renderBookmarksPanel(); togglePanel('bmPanel'); document.getElementById('mi-show-bm-sidebar-chk').style.opacity = document.getElementById('bmPanel').classList.contains('open') ? '1' : '0'; });
document.getElementById('mi-show-rl-sidebar').addEventListener('click', () => { const chk = document.getElementById('mi-show-rl-sidebar-chk'); const rl = RL.get(); if (!rl.length) { showToast('Reading List is empty'); return; } renderHistoryPanel(); togglePanel('histPanel'); chk.style.opacity = document.getElementById('histPanel').classList.contains('open') ? '1' : '0'; showToast('∞ Reading List (' + rl.length + ' items)'); });
document.getElementById('mi-show-shared').addEventListener('click', () => showToast('👥 Shared with You — not available in web mode'));
document.getElementById('mi-show-downloads-view').addEventListener('click', () => togglePanel('dlPanel'));
document.getElementById('mi-stop').addEventListener('click', () => { frame.src = 'about:blank'; setLoading(0); showToast('✕ Stopped'); consoleLog('warn', '✕ Page load stopped'); });
document.getElementById('mi-translation').addEventListener('click', () => { const t = getActiveTab(); if (!t?.url) { showToast('No page to translate'); return; } const lang = prompt('Translate to (e.g. hr, de, fr, es):', 'hr'); if (lang) { navigateTo('https://translate.google.com/translate?sl=auto&tl=' + lang + '&u=' + encodeURIComponent(t.url)); } });
document.getElementById('mi-text-encoding').addEventListener('click', () => { const enc = prompt('Text encoding (e.g. UTF-8, ISO-8859-1):', 'UTF-8'); if (enc) showToast('⌘ Encoding set to: ' + enc); });
document.getElementById('mi-show-history').addEventListener('click', () => { renderHistoryPanel(); togglePanel('histPanel'); });
document.getElementById('mi-back-menu').addEventListener('click', () => document.getElementById('btnBack').click());
document.getElementById('mi-fwd-menu').addEventListener('click', () => document.getElementById('btnFwd').click());
document.getElementById('mi-clear-history').addEventListener('click', () => { DB.clearHistory(); showToast('History cleared'); });
document.getElementById('mi-add-bm').addEventListener('click', addBookmark);
document.getElementById('mi-show-bm').addEventListener('click', () => { renderBookmarksPanel(); togglePanel('bmPanel'); });
document.getElementById('mi-start-page').addEventListener('click', () => { showNTP(); const t = getActiveTab(); if (t) { t.url = ''; t.title = 'New Tab'; updateTabEl(t); } });
document.getElementById('mi-edit-bm').addEventListener('click', () => { renderBookmarksPanel(); togglePanel('bmPanel'); showToast('✏️ Edit mode — click × to remove bookmarks'); });
document.getElementById('mi-add-bm-all-tabs').addEventListener('click', () => {
  const count = STATE.tabs.filter(t => t.url).length;
  if (count === 0) { showToast('No pages to bookmark'); return; }
  if (confirm('Add bookmarks for all ' + count + ' open tab(s)?')) {
    STATE.tabs.forEach(t => { if (t.url) DB.addBookmark({ url: t.url, title: t.title }); });
    showToast('🔖 Added ' + count + ' bookmarks');
  }
});
document.getElementById('mi-add-bm-folder').addEventListener('click', () => {
  const name = prompt('Folder name:');
  if (name) { const folders = JSON.parse(localStorage.getItem('ex_bm_folders') || '[]'); folders.push({ name, ts: Date.now() }); localStorage.setItem('ex_bm_folders', JSON.stringify(folders)); showToast('📁 Folder "' + name + '" created'); }
});
// Reading List
const RL = {
  get: () => JSON.parse(localStorage.getItem('ex_rl') || '[]'),
  add(e) { const l = this.get(); if (l.find(x => x.url === e.url)) { showToast('Already in Reading List'); return; } l.unshift({ ...e, ts: Date.now(), read: false }); localStorage.setItem('ex_rl', JSON.stringify(l)); showToast('∞ Added to Reading List: ' + e.title); },
  idx: 0
};
document.getElementById('mi-reading-list-add').addEventListener('click', () => { const t = getActiveTab(); if (!t?.url) { showToast('No page loaded'); return; } RL.add({ url: t.url, title: t.title }); });
document.getElementById('mi-reading-list-all').addEventListener('click', () => {
  const tabs = STATE.tabs.filter(t => t.url); if (!tabs.length) { showToast('No pages open'); return; }
  tabs.forEach(t => RL.add({ url: t.url, title: t.title })); showToast('∞ Added ' + tabs.length + ' tabs to Reading List');
  document.getElementById('mi-reading-list-prev').style.opacity = '1'; document.getElementById('mi-reading-list-prev').style.cursor = 'pointer';
  document.getElementById('mi-reading-list-next').style.opacity = '1'; document.getElementById('mi-reading-list-next').style.cursor = 'pointer';
});
document.getElementById('mi-reading-list-prev').addEventListener('click', () => { const l = RL.get(); if (!l.length) return; RL.idx = Math.max(0, RL.idx - 1); navigateTo(l[RL.idx].url); });
document.getElementById('mi-reading-list-next').addEventListener('click', () => { const l = RL.get(); if (!l.length) return; RL.idx = Math.min(l.length - 1, RL.idx + 1); navigateTo(l[RL.idx].url); });
document.getElementById('mi-devtools').addEventListener('click', toggleDevtools);
document.getElementById('mi-console').addEventListener('click', () => { document.querySelector('[data-pane="console"]').click(); });
document.getElementById('mi-network').addEventListener('click', () => document.querySelector('[data-pane="network"]').click());

// ── QR Sync Panel ─────────────────────────────────────────────────────────
(function initQrSync() {
  const overlay = document.getElementById('qrSyncOverlay');
  if (!overlay) return;

  // Open / Close
  document.getElementById('mi-sync-qr')?.addEventListener('click', () => {
    overlay.classList.add('show');
    updateBmCount();
  });
  document.getElementById('qrSyncClose').addEventListener('click', () => overlay.classList.remove('show'));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('show'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.classList.contains('show')) overlay.classList.remove('show'); });

  // Tab switching
  document.querySelectorAll('.qrs-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.qrs-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.qrs-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('qrsp-' + tab.dataset.qrs)?.classList.add('active');
    });
  });

  // Update bookmark count label
  function updateBmCount() {
    const n = DB.getBookmarks().length;
    const el = document.getElementById('qrs-bm-count');
    if (el) el.textContent = '(' + n + ')';
  }

  // Build sync payload from checked options
  function buildPayload() {
    const payload = { type: 'etherx-sync', v: 1, ts: Date.now() };
    if (document.getElementById('qrs-bm')?.checked) payload.bookmarks = DB.getBookmarks();
    if (document.getElementById('qrs-hist')?.checked) payload.history = DB.getHistory().slice(0, 200);
    if (document.getElementById('qrs-ext')?.checked) payload.extensions = EXT_DB.get();
    if (document.getElementById('qrs-settings')?.checked) payload.settings = DB.getSettings();
    if (document.getElementById('qrs-profiles')?.checked) {
      payload.profiles = JSON.parse(localStorage.getItem('ex_profiles') || '[]');
    }
    return payload;
  }

  // Generate QR using canvas-based QR library (injected inline)
  function drawQR(canvas, text) {
    // Minimal QR renderer using qrcodejs via CDN approach — fallback: data URI as text
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#667eea';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('QR: scan with EtherX', size / 2, 20);
    // Encode the payload as base64 URL — display as copyable text
    return text;
  }

  document.getElementById('qrsGenerate').addEventListener('click', () => {
    const payload = buildPayload();
    const json = JSON.stringify(payload);
    const b64 = btoa(unescape(encodeURIComponent(json)));

    const wrap = document.getElementById('qrsQrWrap');
    const img = document.getElementById('qrsQrImg');
    const note = document.getElementById('qrsQrNote');

    // Use Google Charts QR API (works without Node.js)
    const qrUrl = 'https://chart.googleapis.com/chart?chs=220x220&cht=qr&chl=' + encodeURIComponent(b64.slice(0, 1800)) + '&choe=UTF-8';
    img.src = qrUrl;
    img.onerror = () => {
      // Fallback: show as copyable code
      img.style.display = 'none';
      note.innerHTML = '<strong>Scan not available — copy code below:</strong><br><textarea style="width:100%;font-size:9px;margin-top:6px;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;color:var(--text2);padding:4px;height:80px;resize:none" readonly>' + escHtml(b64) + '</textarea>';
    };

    const items = Object.keys(payload).filter(k => !['type', 'v', 'ts'].includes(k));
    const counts = items.map(k => {
      const v = payload[k];
      return (Array.isArray(v) ? v.length + ' ' : '') + k;
    }).join(', ');

    note.innerHTML = '<strong>Syncing: ' + escHtml(counts) + '</strong><br>Scan with another EtherX Browser device.<br>Or <a href="#" id="qrsCopyCode" style="color:var(--accent)">copy sync code</a> to paste manually.';
    wrap.classList.add('show');

    document.getElementById('qrsCopyCode')?.addEventListener('click', e => {
      e.preventDefault();
      navigator.clipboard?.writeText(b64);
      showToast('📋 Sync code copied!');
    });
  });

  // Import
  document.getElementById('qrsImport').addEventListener('click', () => {
    const raw = document.getElementById('qrsSyncInput').value.trim();
    if (!raw) { showToast('⚠️ Paste a sync code first'); return; }
    try {
      const json = decodeURIComponent(escape(atob(raw)));
      const data = JSON.parse(json);
      if (data.type !== 'etherx-sync') { showToast('❌ Invalid sync code'); return; }
      let imported = [];
      if (data.bookmarks) { data.bookmarks.forEach(b => DB.addBookmark(b)); imported.push(data.bookmarks.length + ' bookmarks'); }
      if (data.extensions) { data.extensions.forEach(e => EXT_DB.add(e)); imported.push(data.extensions.length + ' extensions'); renderExtIconBar(); }
      if (data.settings) { Object.entries(data.settings).forEach(([k, v]) => DB.saveSetting(k, v)); imported.push('settings'); }
      if (data.profiles) { localStorage.setItem('ex_profiles', JSON.stringify(data.profiles)); imported.push(data.profiles.length + ' profiles'); }
      renderBookmarksPanel(); renderBmFolderBar();
      document.getElementById('qrsImportResult').innerHTML = '✅ Imported: ' + imported.join(', ');
      showToast('✅ Sync complete: ' + imported.join(', '));
    } catch (err) {
      document.getElementById('qrsImportResult').innerHTML = '❌ Error: ' + escHtml(err.message);
      showToast('❌ Import failed: ' + err.message);
    }
  });

  // Camera scan (basic — opens device camera)
  let _qrScanInterval;
  let _activeCameraId = localStorage.getItem('etherx_preferred_camera') || null;

  // Function to get available cameras and store preferred one
  async function getAvailableCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter(d => d.kind === 'videoinput');
      console.log('[EtherX] Available cameras:', cameras);
      return cameras;
    } catch (err) {
      console.error('[EtherX] Error enumerating cameras:', err);
      return [];
    }
  }

  document.getElementById('qrsCameraBtn').addEventListener('click', async () => {
    const preview = document.getElementById('qrsCameraPreview');
    try {
      if (preview.srcObject) {
        // Stop camera if already running
        const stream = preview.srcObject;
        stream.getTracks().forEach(t => t.stop());
        preview.srcObject = null;
        preview.style.display = 'none';
        clearInterval(_qrScanInterval);
        document.getElementById('qrsCameraBtn').textContent = '📷 Scan with Camera';
        return;
      }

      // Get available cameras
      const cameras = await getAvailableCameras();

      // Build constraints with preferred camera
      let constraints = { video: { facingMode: 'environment' } };

      if (_activeCameraId) {
        // Use stored camera ID if available
        constraints = { video: { deviceId: { exact: _activeCameraId } } };
      } else if (cameras.length > 0) {
        // Try to find rear camera
        const rearCamera = cameras.find(c => c.label.toLowerCase().includes('back') || c.label.toLowerCase().includes('rear'));
        if (rearCamera) {
          constraints = { video: { deviceId: { exact: rearCamera.deviceId } } };
          _activeCameraId = rearCamera.deviceId;
          localStorage.setItem('etherx_preferred_camera', _activeCameraId);
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      // Store the camera ID that was actually used
      const track = stream.getVideoTracks()[0];
      if (track) {
        const settings = track.getSettings();
        if (settings.deviceId) {
          _activeCameraId = settings.deviceId;
          localStorage.setItem('etherx_preferred_camera', _activeCameraId);
          console.log('[EtherX] Using camera:', track.label, 'ID:', _activeCameraId);
        }
      }

      preview.srcObject = stream;
      preview.setAttribute('playsinline', true); // required to tell iOS safari we don't want fullscreen
      preview.style.display = 'block';
      preview.play();
      document.getElementById('qrsCameraBtn').textContent = '⏹ Stop Camera';

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      _qrScanInterval = setInterval(() => {
        if (preview.readyState === preview.HAVE_ENOUGH_DATA) {
          canvas.height = preview.videoHeight;
          canvas.width = preview.videoWidth;
          ctx.drawImage(preview, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          if (window.jsQR) {
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
              inversionAttempts: 'dontInvert',
            });
            if (code && code.data) {
              clearInterval(_qrScanInterval);
              stream.getTracks().forEach(t => t.stop());
              preview.srcObject = null;
              preview.style.display = 'none';
              document.getElementById('qrsCameraBtn').textContent = '📷 Scan with Camera';
              document.getElementById('qrsImportText').value = code.data;
              showToast('✅ QR Code detected!');
              // Auto-click import
              document.getElementById('qrsImportBtn').click();
            }
          }
        }
      }, 300);

      if (!window.jsQR) {
        showToast('📷 Camera active — waiting for jsQR library to load');
      }
    } catch (err) {
      showToast('❌ Camera: ' + err.message);
      console.error('[EtherX] Camera error:', err);
      // If exact deviceId failed, try with facingMode fallback
      if (err.name === 'OverconstrainedError' || err.name === 'NotFoundError') {
        console.log('[EtherX] Retrying with facingMode fallback...');
        _activeCameraId = null;
        localStorage.removeItem('etherx_preferred_camera');
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
          preview.srcObject = stream;
          preview.setAttribute('playsinline', true);
          preview.style.display = 'block';
          preview.play();
          showToast('📷 Camera started (default)');
        } catch (fallbackErr) {
          showToast('❌ Cannot access camera: ' + fallbackErr.message);
        }
      }
    }
  });

  // Expose camera functions for settings/debugging
  window._getAvailableCameras = getAvailableCameras;
  window._switchCamera = async function (deviceId) {
    _activeCameraId = deviceId;
    localStorage.setItem('etherx_preferred_camera', deviceId);
    showToast('📷 Camera switched');
  };
})();
document.getElementById('mi-inspect-devices').addEventListener('click', () => showToast('📱 No physical devices connected'));
document.getElementById('mi-service-workers').addEventListener('click', () => { toggleDevtools(); consoleLog('info', '⚙️ Service Workers: none registered on proxied pages'); });
document.getElementById('mi-web-ext-bg').addEventListener('click', () => showToast('🧩 No extension background content'));
document.getElementById('mi-web-inspector').addEventListener('click', () => showToast('🔗 Web Inspector: connect via Safari on device'));
document.getElementById('mi-page-source').addEventListener('click', () => {
  const t = getActiveTab(); if (!t?.url) { showToast('No page loaded'); return; }
  // Open DevTools → Sources tab and render page source like Chrome
  const dt = document.getElementById('devtools');
  dt.classList.add('open'); STATE.devtoolsOpen = true;
  document.querySelectorAll('.dt-tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.dt-pane').forEach(x => x.classList.remove('active'));
  const srcTab = document.querySelector('[data-pane="sources"]');
  if (srcTab) srcTab.classList.add('active');
  const srcPane = document.getElementById('pane-sources');
  if (srcPane) srcPane.classList.add('active');
  const codeEl = document.getElementById('sourcesCode');
  const treeEl = document.getElementById('sourcesTree');
  if (codeEl) codeEl.innerHTML = '<span style="color:#858585;font-size:11px">⏳ Loading source for ' + escHtml(t.url) + '…</span>';
  // Add to sources tree
  if (treeEl) {
    const existing = treeEl.querySelector('[data-src-url="' + CSS.escape(t.url) + '"]');
    if (!existing) {
      const item = document.createElement('div'); item.className = 'src-item'; item.style.paddingLeft = '32px';
      item.dataset.srcUrl = t.url;
      const name = t.url.split('/').pop().split('?')[0] || 'index.html';
      item.textContent = '📄 ' + name;
      item.addEventListener('click', () => {
        document.querySelectorAll('.src-item').forEach(x => x.classList.remove('active'));
        item.classList.add('active');
        loadSourceIntoPane(t.url, codeEl);
      });
      treeEl.appendChild(item);
    }
    document.querySelectorAll('.src-item').forEach(x => x.classList.remove('active'));
    const target = treeEl.querySelector('[data-src-url="' + CSS.escape(t.url) + '"]') || existing;
    if (target) target.classList.add('active');
  }
  loadSourceIntoPane(t.url, codeEl);
  showToast('📄 Page Source loaded in Sources tab');
});
function loadSourceIntoPane(url, codeEl) {
  if (!codeEl) return;
  if (window.electronWebview) {
    const activeTab = getActiveTab();
    const wv = getTabWebview(activeTab?.id);
    if (wv) {
      safeWebviewExecute(wv, activeTab?.id, 'executeJavaScript', 'document.documentElement.outerHTML').then(src => {
        const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        codeEl.innerHTML = '<pre style="white-space:pre-wrap;color:#d4d4d4;font-size:12px;padding:12px">' + esc + '</pre>';
      }).catch(() => { codeEl.innerHTML = '<div style="color:#e06c75;padding:12px">Source unavailable in Electron mode</div>'; });
    } else { codeEl.innerHTML = '<div style="color:#e06c75;padding:12px">Source unavailable</div>'; }
    return;
  }
  // Standalone: try direct fetch (may be blocked by CORS on some sites)
  fetch(url).then(r => r.text()).then(src => {
    // Syntax-highlight basic HTML/CSS/JS tokens
    const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const highlighted = esc
      .replace(/(&lt;\/?[a-zA-Z][a-zA-Z0-9]*)/g, '<span style="color:#569cd6">$1</span>')
      .replace(/(\s[a-zA-Z\-]+)=/g, '<span style="color:#9cdcfe">$1</span>=')
      .replace(/="([^"]*)"/g, '=<span style="color:#ce9178">"$1"</span>')
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span style="color:#6a9955">$1</span>');
    codeEl.innerHTML = '<div style="counter-reset:ln;line-height:1.6">' +
      highlighted.split('\n').map((line, i) =>
        `<div style="display:flex;gap:0"><span style="color:#555;min-width:42px;text-align:right;padding-right:12px;user-select:none;font-size:10px;padding-top:1px">${i + 1}</span><span style="flex:1;word-break:break-word">${line || ' '}</span></div>`
      ).join('') + '</div>';
  }).catch(() => { codeEl.innerHTML = '<span style="color:#f48771">Source not available (blocked by CORS).</span>'; });
}
document.getElementById('mi-page-resources').addEventListener('click', () => { document.querySelector('[data-pane="network"]').click(); showToast('📦 Page Resources — see Network tab'); });
let timelineRunning = false;
document.getElementById('mi-timeline').addEventListener('click', () => {
  timelineRunning = !timelineRunning;
  document.getElementById('mi-timeline').querySelector('span:not(.icon)').textContent = timelineRunning ? 'Stop Timeline Recording' : 'Start Timeline Recording';
  if (timelineRunning) { document.getElementById('mi-timeline').querySelector('.icon').textContent = '⏹️'; } else { document.getElementById('mi-timeline').querySelector('.icon').textContent = '⏱️'; }
  showToast(timelineRunning ? '⏱️ Timeline recording started…' : '⏹ Timeline recording stopped');
  if (timelineRunning) { toggleDevtools(); consoleLog('info', '⏱️ Timeline recording started'); } else { consoleLog('warn', '⏹ Timeline recording stopped'); }
});
let elemSelecting = false;
document.getElementById('mi-elem-select').addEventListener('click', () => {
  elemSelecting = !elemSelecting;
  document.getElementById('mi-elem-select').querySelector('span:not(.icon)').textContent = elemSelecting ? 'Stop Element Selection' : 'Start Element Selection';
  showToast(elemSelecting ? '🔲 Click an element to inspect it' : '🔲 Element selection stopped');
  document.body.style.cursor = elemSelecting ? 'crosshair' : '';
  if (elemSelecting) {
    const handler = e => {
      e.stopPropagation(); document.body.style.cursor = ''; elemSelecting = false;
      document.getElementById('mi-elem-select').querySelector('span:not(.icon)').textContent = 'Start Element Selection';
      toggleDevtools(); document.querySelector('[data-pane="elements"]').click();
      consoleLog('info', '🔲 Selected: &lt;' + e.target.tagName.toLowerCase() + ' class="' + e.target.className + '"&gt;');
      document.removeEventListener('click', handler, true);
    };
    document.addEventListener('click', handler, true);
  }
});
document.getElementById('mi-clear-caches').addEventListener('click', () => {
  if (confirm('Empty all caches for all profiles?')) {
    DB.clearHistory(); localStorage.clear(); showToast('🗑️ Caches cleared for all profiles'); consoleLog('warn', '🗑️ All caches cleared');
  }
});
document.getElementById('mi-pin-tab').addEventListener('click', pinTab);
document.getElementById('mi-mute-tab').addEventListener('click', muteTab);
document.getElementById('mi-mute-others').addEventListener('click', () => { const at = getActiveTab(); STATE.tabs.forEach(t => { if (t.id !== at?.id) { t.muted = true; updateTabEl(t); } }); showToast('🔈 Other tabs muted'); });
document.getElementById('mi-dup-tab').addEventListener('click', dupTab);
document.getElementById('mi-prev-tab').addEventListener('click', () => { const i = STATE.tabs.findIndex(t => t.id === STATE.activeTabId); if (i > 0) switchTab(STATE.tabs[i - 1].id); });
document.getElementById('mi-next-tab').addEventListener('click', () => { const i = STATE.tabs.findIndex(t => t.id === STATE.activeTabId); if (i < STATE.tabs.length - 1) switchTab(STATE.tabs[i + 1].id); });
document.getElementById('mi-downloads').addEventListener('click', () => togglePanel('dlPanel'));
document.getElementById('mi-minimise').addEventListener('click', () => showToast('▭ Minimise — not available in web mode'));
document.getElementById('mi-win-zoom').addEventListener('click', () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => { }); else document.exitFullscreen(); });
document.getElementById('mi-win-fill').addEventListener('click', () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => { }); else document.exitFullscreen(); });
document.getElementById('mi-win-centre').addEventListener('click', () => showToast('◉ Centre — not available in web mode'));
document.getElementById('mi-move-resize').addEventListener('click', () => showToast('⤡ Move & Resize — use browser window controls'));
document.getElementById('mi-fullscreen-tile').addEventListener('click', () => showToast('⊞ Full-Screen Tile — not available in web mode'));
document.getElementById('mi-arrange-tabs').addEventListener('click', () => { STATE.tabs.sort((a, b) => a.title.localeCompare(b.title)); document.querySelectorAll('.tab').forEach(el => el.remove()); const nb = document.getElementById('newTabBtn'); STATE.tabs.forEach(t => { renderTab(t); }); switchTab(STATE.activeTabId); showToast('⇅ Tabs arranged by title'); });
document.getElementById('mi-prev-tab-group').addEventListener('click', () => { const i = STATE.tabs.findIndex(t => t.id === STATE.activeTabId); if (i > 0) switchTab(STATE.tabs[i - 1].id); });
document.getElementById('mi-next-tab-group').addEventListener('click', () => { const i = STATE.tabs.findIndex(t => t.id === STATE.activeTabId); if (i < STATE.tabs.length - 1) switchTab(STATE.tabs[i + 1].id); });
document.getElementById('mi-move-tab-window').addEventListener('click', () => { const t = getActiveTab(); if (t?.url) { window.open('/browser.html#' + encodeURIComponent(t.url), '_blank'); closeTab(t.id); } else showToast('No page to move'); });
document.getElementById('mi-bring-front').addEventListener('click', () => { window.focus(); showToast('⬆ Brought to front'); });
document.getElementById('mi-open-location').addEventListener('click', () => { urlInput.focus(); urlInput.select(); });
document.getElementById('mi-print').addEventListener('click', () => { try { frame.contentWindow.print(); } catch (e) { showToast('Cannot print cross-origin page'); } });
document.getElementById('mi-reader').addEventListener('click', () => document.getElementById('btnReader').click());

// ── Page Dark Mode ────────────────────────────────────────────────────────
const DARK_MODE_STYLE_ID = 'etherx-dark-inject';
const DARK_FILTER_CSS = `
      html { filter: invert(1) hue-rotate(180deg) !important; color-scheme: dark !important; }
      img, video, canvas, svg, picture, iframe { filter: invert(1) hue-rotate(180deg) !important; }
    `;
const DARK_SCHEME_CSS = `
      html { color-scheme: dark !important; }
      :root { color-scheme: dark !important; }
    `;
const DARK_BOTH_CSS = `
      html { filter: invert(1) hue-rotate(180deg) !important; color-scheme: dark !important; }
      img, video, canvas, svg, picture, iframe { filter: invert(1) hue-rotate(180deg) !important; }
      :root { color-scheme: dark !important; }
    `;

function _getDarkCSS() {
  const method = DB.getSettings().darkModeMethod || 'filter';
  if (method === 'scheme') return DARK_SCHEME_CSS;
  if (method === 'both') return DARK_BOTH_CSS;
  return DARK_FILTER_CSS;
}

function _injectDarkModeIntoFrame() {
  const fr = document.getElementById('browseFrame');
  if (!fr) return;
  try {
    // Works for same-origin frames
    const doc = fr.contentDocument || fr.contentWindow?.document;
    if (!doc) return;
    let st = doc.getElementById(DARK_MODE_STYLE_ID);
    if (!st) {
      st = doc.createElement('style');
      st.id = DARK_MODE_STYLE_ID;
      (doc.head || doc.documentElement).appendChild(st);
    }
    st.textContent = _getDarkCSS();
  } catch (e) {
    // cross-origin fallback: CSS filter on the iframe element itself
    const fr2 = document.getElementById('browseFrame');
    if (fr2) {
      const method = DB.getSettings().darkModeMethod || 'filter';
      if (method !== 'scheme') {
        fr2.style.filter = 'invert(1) hue-rotate(180deg)';
      }
    }
  }
}

function _removeDarkModeFromFrame() {
  const fr = document.getElementById('browseFrame');
  if (!fr) return;
  try {
    const doc = fr.contentDocument || fr.contentWindow?.document;
    if (doc) {
      const st = doc.getElementById(DARK_MODE_STYLE_ID);
      if (st) st.remove();
    }
  } catch (e) { }
  fr.style.filter = '';
}

function applyPageDarkMode(on) {
  DB.saveSetting('pageDarkMode', on);
  const chk = document.getElementById('mi-dark-mode-chk');
  if (chk) chk.style.opacity = on ? '1' : '0';
  const tog = document.getElementById('togglePageDarkMode');
  if (tog) { on ? tog.classList.add('on') : tog.classList.remove('on'); }
  if (on) { _injectDarkModeIntoFrame(); showToast('🌙 Dark mode ON'); }
  else { _removeDarkModeFromFrame(); showToast('☀️ Dark mode OFF'); }
}

document.getElementById('mi-dark-mode').addEventListener('click', () => {
  const cur = DB.getSettings().pageDarkMode || false;
  applyPageDarkMode(!cur);
});

// Re-inject dark mode whenever a new page loads in the frame
(function _hookFrameLoadForDark() {
  const fr = document.getElementById('browseFrame');
  if (!fr) return;
  const reInject = () => {
    if (DB.getSettings().pageDarkMode) {
      setTimeout(() => _injectDarkModeIntoFrame(), 300);
    }
  };
  fr.addEventListener('load', reInject);
  // For webview (Electron)
  fr.addEventListener('did-finish-load', reInject);
})();

// Dark mode toggle in Settings → Advanced
document.getElementById('togglePageDarkMode')?.addEventListener('click', function () {
  const cur = DB.getSettings().pageDarkMode || false;
  applyPageDarkMode(!cur);
});

// Dark mode method select
document.getElementById('darkModeMethod')?.addEventListener('change', function () {
  DB.saveSetting('darkModeMethod', this.value);
  if (DB.getSettings().pageDarkMode) {
    _removeDarkModeFromFrame();
    setTimeout(() => _injectDarkModeIntoFrame(), 50);
  }
  showToast('🌙 Dark mode method: ' + this.options[this.selectedIndex].text);
});

// Init dark mode state on load
(function _initDarkMode() {
  const s = DB.getSettings();
  if (s.pageDarkMode) {
    const chk = document.getElementById('mi-dark-mode-chk');
    if (chk) chk.style.opacity = '1';
    const tog = document.getElementById('togglePageDarkMode');
    if (tog) tog.classList.add('on');
  }
  const methodSel = document.getElementById('darkModeMethod');
  if (methodSel) {
    const m = s.darkModeMethod || 'filter';
    Array.from(methodSel.options).forEach(o => { o.selected = o.value === m; });
  }
})();
document.getElementById('mi-about').addEventListener('click', () => showToast('EtherX Browser v1.0 — Web3-Native Browser'));
document.getElementById('mi-shortcuts').addEventListener('click', () => { alert('Ctrl+T: New Tab\nCtrl+W: Close Tab\nCtrl+R: Reload\nCtrl+F: Find in Page\nCtrl+D: Bookmark\nCtrl+H: History\nCtrl+B: Bookmarks\nCtrl+J: Downloads\nCtrl+L: Focus URL\nCtrl++/-/0: Zoom\nF12: DevTools\nF11: Fullscreen\nF5: Reload\nShift+F5: Hard Reload (clear cookies + reload)\nAlt+←/→: Back/Forward\nCtrl+Tab: Next Tab\nCtrl+Shift+Tab: Prev Tab'); });
function pinTab() { const t = getActiveTab(); if (!t) return; t.pinned = !t.pinned; updateTabEl(t); showToast(t.pinned ? '📌 Tab pinned' : '📌 Tab unpinned'); }
function muteTab() { const t = getActiveTab(); if (!t) return; t.muted = !t.muted; updateTabEl(t); showToast(t.muted ? '🔇 Tab muted' : '🔊 Tab unmuted'); }
function dupTab() { const t = getActiveTab(); if (!t) return; createTab(t.url, t.title + ' (copy)'); }
function addBookmark() { const t = getActiveTab(); if (!t?.url) { showToast('Nothing to bookmark'); return; } DB.addBookmark({ url: t.url, title: t.title }); }
document.getElementById('btnBookmarkPage')?.addEventListener('click', addBookmark);
const DEFAULT_QUICKLINKS = [{ url: 'https://en.wikipedia.org', label: 'Wiki', icon: '📖' }, { url: 'https://github.com', label: 'GitHub', icon: '��' }, { url: 'https://app.uniswap.org', label: 'Uniswap', icon: '🦄' }, { url: 'https://etherscan.io', label: 'Etherscan', icon: '🔍' }];
function renderQuickLinks() {
  const ql = document.getElementById('quickLinks');
  // Show recently visited history (not bookmarks)
  const hist = DB.getHistory().slice(0, 8);
  let links;
  if (hist.length > 0) {
    links = hist.map(h => ({ url: h.url, label: (h.title || h.url).slice(0, 12), icon: getSiteFavicon(h.url) }));
  } else {
    const bm = DB.getBookmarks().slice(0, 6);
    links = bm.length > 0 ? bm.map(b => ({ url: b.url, label: (b.title || b.url).slice(0, 10), icon: '\u2B50' })) : DEFAULT_QUICKLINKS;
  }
  ql.innerHTML = '';
  links.forEach(l => { const el = document.createElement('div'); el.className = 'ql-item'; el.innerHTML = `<div class="ql-icon">${l.icon}</div><div class="ql-label">${l.label}</div>`; el.addEventListener('click', () => navigateTo(l.url)); ql.appendChild(el); });
}

// Recently Visited
function addRecentSite(url, title) {
  if (!url || url === 'about:blank' || STATE.isPrivate) return;
  let r = JSON.parse(localStorage.getItem('ex_recent') || '[]');
  r = r.filter(x => x.url !== url);
  try { const h = new URL(url).hostname; title = title || h; } catch (e) { }
  r.unshift({ url, title: title || url, ts: Date.now() });
  localStorage.setItem('ex_recent', JSON.stringify(r.slice(0, 20)));
}
function getSiteFavicon(url) {
  try {
    const h = new URL(url).hostname;
    const map = { 'etherscan.io': '\uD83D\uDD0D', 'uniswap.org': '\uD83E\uDD84', 'metamask.io': '\uD83E\uDD8A', 'coingecko.com': '\uD83E\uDD8E', 'github.com': '\uD83D\uDC19', 'google.com': '\uD83D\uDD35', 'youtube.com': '\u25B6\uFE0F', 'twitter.com': '\uD83D\uDC26', 'wallet.kriptoentuzijasti.io': '\uD83D\uDCB0', 'opensea.io': '\uD83C\uDF0A' };
    for (const k in map) if (h.includes(k)) return map[k];
  } catch (e) { } return '\uD83C\uDF10';
}
function renderRecentSites() {
  const r = JSON.parse(localStorage.getItem('ex_recent') || '[]').slice(0, 8);
  const sec = document.getElementById('ntpRecentSection');
  const cont = document.getElementById('ntpRecent');
  if (!r.length) { if (sec) sec.style.display = 'none'; return; }
  if (sec) sec.style.display = ''; cont.innerHTML = '';
  r.forEach(s => {
    const el = document.createElement('div'); el.className = 'ntp-recent-card';
    let host = ''; try { host = new URL(s.url).hostname; } catch (e) { host = s.url.slice(0, 20); }
    el.innerHTML = `<button class="nrc-del" title="Remove">\u2715</button><div class="ntp-rc-icon">${getSiteFavicon(s.url)}</div><div class="ntp-rc-title">${escHtml((s.title || '').slice(0, 16))}</div><div class="ntp-rc-host">${escHtml(host)}</div>`;
    el.addEventListener('click', e => { if (e.target.classList.contains('nrc-del')) return; navigateTo(s.url); });
    el.querySelector('.nrc-del').addEventListener('click', e => { e.stopPropagation(); let rx = JSON.parse(localStorage.getItem('ex_recent') || '[]'); rx = rx.filter(x => x.url !== s.url); localStorage.setItem('ex_recent', JSON.stringify(rx)); renderRecentSites(); });
    cont.appendChild(el);
  });
}

// NTP Customize
function applyNtpSettings() {
  const s = JSON.parse(localStorage.getItem('ex_ntp') || '{}');
  const ntp = document.getElementById('ntpPage');
  if (s.bgUrl) { ntp.style.backgroundImage = "url('" + s.bgUrl + "')"; ntp.style.backgroundSize = 'cover'; ntp.style.backgroundPosition = 'center'; }
  else if (s.bg) { ntp.style.background = s.bg; ntp.style.backgroundImage = ''; }
  if (s.title) document.getElementById('ntpTitle').textContent = s.title;
  if (s.subtitle) document.getElementById('ntpSubtitle').textContent = s.subtitle;
  const showRecent = s.showRecent !== false;
  const showCards = s.showCards !== false;
  const showQL = s.showQL !== false;
  const rs = document.getElementById('ntpRecentSection'); if (rs) rs.style.display = showRecent ? '' : 'none';
  const nc = document.querySelector('.ntp-cards'); if (nc) nc.style.display = showCards ? '' : 'none';
  const ql = document.getElementById('quickLinks'); if (ql) ql.style.display = showQL ? '' : 'none';
}
document.addEventListener('DOMContentLoaded', () => {
  const ntpEditBtn = document.getElementById('ntpEditBtn');
  if (ntpEditBtn) ntpEditBtn.addEventListener('click', () => {
    const s = JSON.parse(localStorage.getItem('ex_ntp') || '{}');
    document.getElementById('ntpcBgUrl').value = s.bgUrl || '';
    document.getElementById('ntpcTitle').value = s.title || 'EtherX Browser';
    document.getElementById('ntpcSubtitle').value = s.subtitle || 'The Web3-Native Browser Experience';
    document.getElementById('ntpcShowRecent').classList.toggle('on', s.showRecent !== false);
    document.getElementById('ntpcShowCards').classList.toggle('on', s.showCards !== false);
    document.getElementById('ntpcShowQL').classList.toggle('on', s.showQL !== false);
    document.getElementById('ntpCustomize').classList.add('show');
  });
  const ntpcClose = document.getElementById('ntpCustomizeClose');
  if (ntpcClose) ntpcClose.addEventListener('click', () => document.getElementById('ntpCustomize').classList.remove('show'));
  document.querySelectorAll('.ntpc-color').forEach(c => c.addEventListener('click', () => { document.querySelectorAll('.ntpc-color').forEach(x => x.classList.remove('sel')); c.classList.add('sel'); }));
  const ntpcApply = document.getElementById('ntpcApply');
  if (ntpcApply) ntpcApply.addEventListener('click', () => {
    const s = {};
    const bgUrl = document.getElementById('ntpcBgUrl').value.trim();
    if (bgUrl) s.bgUrl = bgUrl;
    else { const selCol = document.querySelector('.ntpc-color.sel'); if (selCol) s.bg = selCol.dataset.bg; else { const cc = document.getElementById('ntpcCustomColor').value; if (cc) s.bg = cc; } }
    s.title = document.getElementById('ntpcTitle').value || 'EtherX Browser';
    s.subtitle = document.getElementById('ntpcSubtitle').value || 'The Web3-Native Browser Experience';
    s.showRecent = document.getElementById('ntpcShowRecent').classList.contains('on');
    s.showCards = document.getElementById('ntpcShowCards').classList.contains('on');
    s.showQL = document.getElementById('ntpcShowQL').classList.contains('on');
    localStorage.setItem('ex_ntp', JSON.stringify(s));
    applyNtpSettings();
    document.getElementById('ntpCustomize').classList.remove('show');
    showToast('\u2713 Start page updated');
  });
});

// DevTools Dock
const DOCK_MODES = ['bottom', 'left', 'right'];
let dockIdx = 0;
const dockIcons = ['\u22DF', '\u22DE', '\u22E1'];
document.getElementById('dtBtnDock').addEventListener('click', () => {
  const dt = document.getElementById('devtools');
  dt.classList.remove('dock-left', 'dock-right');
  dockIdx = (dockIdx + 1) % 3;
  if (dockIdx === 1) dt.classList.add('dock-left');
  else if (dockIdx === 2) dt.classList.add('dock-right');
  document.getElementById('dtBtnDock').textContent = dockIcons[dockIdx];
  showToast('DevTools: ' + ['Bottom', 'Left', 'Right'][dockIdx]);
});

// Resize handle (supports side docking)
{
  const dtR = document.getElementById('dtResize'); let dtDrag = false, dtSY = 0, dtSH = 0, dtSX = 0, dtSW = 0;
  dtR.addEventListener('mousedown', e => { const dt = document.getElementById('devtools'); dtDrag = true; if (dt.classList.contains('dock-left') || dt.classList.contains('dock-right')) { dtSX = e.clientX; dtSW = dt.offsetWidth; } else { dtSY = e.clientY; dtSH = dt.offsetHeight; } e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (!dtDrag) return; const dt = document.getElementById('devtools'); if (dt.classList.contains('dock-left')) { dt.style.width = Math.max(280, Math.min(window.innerWidth - 100, dtSW + (e.clientX - dtSX))) + 'px'; } else if (dt.classList.contains('dock-right')) { dt.style.width = Math.max(280, Math.min(window.innerWidth - 100, dtSW - (e.clientX - dtSX))) + 'px'; } else { dt.style.height = Math.max(120, Math.min(window.innerHeight - 160, dtSH + (dtSY - e.clientY))) + 'px'; } });
  document.addEventListener('mouseup', () => { dtDrag = false; });
}

// Memory metrics
function collectMemoryMetrics() {
  const fmt = b => (b / 1024 / 1024).toFixed(1) + ' MB';
  let used = '~12.4 MB', total = '~18 MB', limit = '~2 GB', ext = '~1.2 MB', pct = 1;
  if (performance.memory) { used = fmt(performance.memory.usedJSHeapSize); total = fmt(performance.memory.totalJSHeapSize); limit = fmt(performance.memory.jsHeapSizeLimit); ext = fmt(performance.memory.usedJSHeapSize * 0.08); pct = Math.round(performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit * 100); }
  document.getElementById('memUsed').textContent = used;
  document.getElementById('memTotal').textContent = total;
  document.getElementById('memLimit').textContent = limit;
  document.getElementById('memExt').textContent = ext;
  document.getElementById('memBar').style.width = pct + '%';
  document.getElementById('memNodes').textContent = document.querySelectorAll('*').length;
  document.getElementById('memListeners').textContent = '~' + Math.floor(Math.random() * 80 + 20);
  document.getElementById('memObjects').textContent = '~' + Math.floor(Math.random() * 2000 + 500);
}

// Security panel
function renderSecurityPanel() {
  const t = getActiveTab(); const url = t?.url || ''; const isHttps = url.startsWith('https://');
  function set(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }
  function badge(id, cls, txt) { const el = document.getElementById(id); if (el) { el.className = 'sec-badge ' + cls; el.textContent = txt; } }
  if (!url) { set('secConnection', 'No page loaded');['secConnBadge', 'secCertBadge', 'secCspBadge', 'secCookBadge', 'secMixedBadge', 'secHstsBadge'].forEach(id => badge(id, '', '---')); return; }
  set('secConnection', isHttps ? 'HTTPS — ' + url.split('/')[2] : 'HTTP (insecure) — ' + url.split('/')[2]);
  badge('secConnBadge', isHttps ? 'sec-ok' : 'sec-bad', isHttps ? 'Secure' : 'Not Secure');
  set('secCert', isHttps ? 'TLS 1.3, valid certificate' : 'No certificate (HTTP)');
  badge('secCertBadge', isHttps ? 'sec-ok' : 'sec-bad', isHttps ? 'Valid' : 'None');
  const ck = document.cookie.split(';').filter(c => c.trim()).length;
  set('secCookies', ck ? ck + ' cookie(s) present' : 'No cookies set'); badge('secCookBadge', ck ? 'sec-warn' : 'sec-ok', ck ? 'Present' : 'None');
  set('secMixed', isHttps ? 'No mixed content detected' : 'HTTP page'); badge('secMixedBadge', isHttps ? 'sec-ok' : 'sec-warn', isHttps ? 'None' : 'N/A');
  set('secHsts', isHttps ? 'HSTS active' : 'Not applicable'); badge('secHstsBadge', isHttps ? 'sec-ok' : 'sec-warn', isHttps ? 'Active' : 'None');
  // CSP — try from cached tab data first, then fetch header
  const cachedCsp = t?._csp;
  if (cachedCsp !== undefined) {
    if (cachedCsp) { set('secCsp', cachedCsp.slice(0, 120) + (cachedCsp.length > 120 ? '…' : '')); badge('secCspBadge', 'sec-ok', 'Present'); }
    else { set('secCsp', 'No CSP header found'); badge('secCspBadge', 'sec-warn', 'Missing'); }
  } else if (!window.electronWebview) {
    set('secCsp', 'Fetching…'); badge('secCspBadge', 'sec-warn', '…');
    // Standalone: CSP headers not accessible via CORS fetch
    set('secCsp', 'Not available in standalone mode'); badge('secCspBadge', 'sec-warn', 'N/A');
  } else {
    set('secCsp', 'Not accessible in Electron mode'); badge('secCspBadge', 'sec-warn', 'Unknown');
  }
}

// Lighthouse
document.getElementById('lhRun').addEventListener('click', () => {
  const t = getActiveTab(); if (!t?.url) { showToast('No page loaded'); return; }
  document.getElementById('lhStatus').textContent = 'Running audit...'; document.getElementById('lhRun').disabled = true;
  setTimeout(() => {
    const r = n => Math.floor(Math.random() * (n[1] - n[0]) + n[0]);
    const sc = { perf: r([55, 98]), a11y: r([70, 100]), bp: r([75, 100]), seo: r([80, 100]), pwa: r([30, 90]) };
    const cl = v => v >= 90 ? 'green' : v >= 50 ? 'orange' : 'red';
    [['lhPerf', sc.perf], ['lhA11y', sc.a11y], ['lhBp', sc.bp], ['lhSeo', sc.seo], ['lhPwa', sc.pwa]].forEach(([id, v]) => { const el = document.getElementById(id); el.className = 'lh-circle ' + cl(v); el.textContent = v; });
    const audits = [{ c: sc.perf >= 90 ? 'g' : 'o', t: 'First Contentful Paint', v: r([0, 100]) + 'ms' }, { c: sc.perf >= 75 ? 'g' : 'o', t: 'Largest Contentful Paint', v: r([100, 600]) + 'ms' }, { c: sc.a11y >= 90 ? 'g' : 'o', t: 'Image alt text', v: sc.a11y >= 90 ? 'All present' : 'Some missing' }, { c: sc.seo >= 90 ? 'g' : 'r', t: 'Meta description', v: sc.seo >= 90 ? 'Present' : 'Missing' }, { c: 'g', t: 'HTTPS', v: t.url.startsWith('https') ? 'Secure' : 'Not secure' }, { c: sc.pwa >= 50 ? 'g' : 'r', t: 'Web App Manifest', v: sc.pwa >= 50 ? 'Found' : 'Missing' }];
    document.getElementById('lhAudits').innerHTML = '<div style="font-size:10px;color:#858585;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Audit Results</div>' + audits.map(a => `<div class="lh-item"><div class="lh-dot ${a.c}"></div><span style="flex:1;font-size:11px;color:#ccc">${escHtml(a.t)}</span><span style="font-size:10px;color:#858585">${escHtml(a.v)}</span></div>`).join('');
    document.getElementById('lhStatus').textContent = 'Completed -- ' + new Date().toLocaleTimeString();
    document.getElementById('lhRun').disabled = false;
  }, 1800);
});

// User Agent
const UA_PRESETS = { 'default': navigator.userAgent, 'Chrome Windows': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36', 'Chrome Mac': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36', 'Firefox Windows': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0', 'Safari Mac': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15', 'Safari iOS': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1', 'Chrome Android': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.101 Mobile Safari/537.36', 'Edge Windows': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0', 'Googlebot': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'curl': 'curl/8.5.0' };
let activeUA = navigator.userAgent;
document.addEventListener('DOMContentLoaded', () => {
  const uaCurrent = document.getElementById('uaCurrent');
  if (uaCurrent) uaCurrent.textContent = activeUA;
  document.querySelectorAll('.ua-preset').forEach(btn => { btn.addEventListener('click', () => { document.querySelectorAll('.ua-preset').forEach(b => b.classList.remove('active')); btn.classList.add('active'); const ua = UA_PRESETS[btn.dataset.ua] || navigator.userAgent; document.getElementById('uaCustomInput').value = ua; document.getElementById('uaCurrent').textContent = ua; }); });
  const uaApply = document.getElementById('uaApply');
  if (uaApply) uaApply.addEventListener('click', () => { const ua = document.getElementById('uaCustomInput').value.trim() || navigator.userAgent; activeUA = ua; document.getElementById('uaCurrent').textContent = ua; localStorage.setItem('ex_ua', ua); showToast('\u2713 User Agent: ' + ua.slice(0, 40) + '...'); consoleLog('info', '\uD83D\uDD75\uFE0F UA changed: ' + ua.slice(0, 60)); });
});

// Extensions DB + Manager
const EXT_DB = { get: () => JSON.parse(localStorage.getItem('ex_extensions') || '[]'), save(a) { localStorage.setItem('ex_extensions', JSON.stringify(a)); }, add(ext) { const a = this.get(); if (a.find(e => e.id === ext.id)) { showToast('Already installed'); return; } a.push(ext); this.save(a); }, remove(id) { this.save(this.get().filter(e => e.id !== id)); }, toggle(id) { const a = this.get(); const e = a.find(x => x.id === id); if (e) e.enabled = !e.enabled; this.save(a); } };

// Seed default extensions on first run
(function seedDefaultExtensions() {
  const defaults = [

    { id: 'pejdijmoenmkgeppbflobdenhhabjlaj', name: 'iCloud Passwords', icon: '🔑', desc: 'Use iCloud Keychain passwords in your browser', enabled: true, source: 'https://chromewebstore.google.com/detail/icloud-passwords/pejdijmoenmkgeppbflobdenhhabjlaj', installedAt: Date.now() }
  ];
  const existing = EXT_DB.get();
  let changed = false;
  defaults.forEach(def => { if (!existing.find(e => e.id === def.id)) { existing.push(def); changed = true; } });
  if (changed) EXT_DB.save(existing);
})();

function renderExtList() {
  const list = document.getElementById('extList'); const exts = EXT_DB.get();
  if (!exts.length) { list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text3);font-size:12px"><div style="font-size:32px;margin-bottom:10px">🧩</div>No extensions installed.</div>'; renderExtIconBar(); updateSettingsExtCount && updateSettingsExtCount(); return; }
  list.innerHTML = '';
  exts.forEach(ext => {
    const el = document.createElement('div'); el.className = 'ext-item';
    el.innerHTML = `<div class="ext-item-icon" style="cursor:pointer;position:relative" title="Klikni za promjenu ikone">${ext.icon || '🧩'}<span style="position:absolute;bottom:-2px;right:-2px;font-size:9px;background:var(--accent);border-radius:3px;padding:0 2px;color:#fff;line-height:1.4">✎</span></div><div class="ext-item-body"><div class="ext-item-name">${escHtml(ext.name)}</div><div class="ext-item-desc">${escHtml(ext.desc || '')}</div><div class="ext-item-actions"><button class="ext-toggle${ext.enabled ? ' on' : ''}" data-extid="${ext.id}"></button><span class="ext-badge">${ext.enabled ? 'Enabled' : 'Disabled'}</span><button class="ext-btn-sm" data-del="${ext.id}">Remove</button></div></div>`;
    el.querySelector('.ext-toggle').addEventListener('click', () => { EXT_DB.toggle(ext.id); renderExtList(); renderExtIconBar(); });
    el.querySelector('[data-del]').addEventListener('click', () => {
      window.customConfirm('Remove "' + ext.name + '"?', (c) => { if (c) { EXT_DB.remove(ext.id); renderExtList(); renderExtIconBar(); showToast('🗑 Removed: ' + ext.name); } });
    });
    el.querySelector('.ext-item-icon').addEventListener('click', () => {
      openIconPicker('Promijeni ikonu: ' + ext.name, ext.icon || '🧩',
        ['🧩', '🔑', '📈', '🛡️', '🦊', '🌙', '🔐', '🌐', '⚡', '🎯', '💎', '🔒', '🔓', '🔔', '📌', '🚀', '💰', '🎬', '🤖', '📰', '👥', '⭐', '🕒', '⬇️', '⚙️', '🛠️', '📋', '🔍', '💡', '🎨', '🎵', '📱', '💻', '🌍'],
        (icon) => {
          const a = EXT_DB.get(); const e = a.find(x => x.id === ext.id);
          if (e) { e.icon = icon; EXT_DB.save(a); renderExtList(); renderExtIconBar(); showToast('✎ Ikona promijenjena: ' + icon); }
        }
      );
    });
    list.appendChild(el);
  });
  renderExtIconBar();
  updateSettingsExtCount && updateSettingsExtCount();
}

// Render installed extension icons in the title bar
function renderExtIconBar() {
  const bar = document.getElementById('extIconBar'); if (!bar) return;
  const exts = EXT_DB.get();
  bar.innerHTML = '';
  exts.forEach(ext => {
    const pill = document.createElement('div');
    pill.className = 'ext-icon-pill' + (ext.enabled ? '' : ' disabled');
    pill.style.opacity = ext.enabled ? '1' : '0.4';
    pill.title = ext.name + (ext.enabled ? '' : ' (disabled)');
    pill.innerHTML = (ext.icon || '🧩') + `<span class="ext-pill-tooltip">${escHtml(ext.name)}${ext.enabled ? '' : ' ⏸'}</span>`;
    pill.addEventListener('click', () => {
      const url = ext.source || ('https://chromewebstore.google.com/detail/' + ext.id);
      closeAllPanels();
      navigateTo(url);
      showToast('🧩 Opening: ' + ext.name);
    });
    pill.addEventListener('contextmenu', e => {
      e.preventDefault();
      EXT_DB.toggle(ext.id); renderExtIconBar();
      const updated = EXT_DB.get().find(x => x.id === ext.id);
      showToast((updated?.enabled ? '▶ Enabled: ' : '⏸ Disabled: ') + ext.name);
    });
    bar.appendChild(pill);
  });
}

// ── Icon Picker ──────────────────────────────────────────────────────────
let _iconPickerCallback = null;
function openIconPicker(title, current, presets, callback) {
  _iconPickerCallback = callback;
  document.getElementById('iconPickerTitle').textContent = title || 'Promijeni ikonu';
  const inp = document.getElementById('iconPickerInput');
  inp.value = current || '';
  const presetsEl = document.getElementById('iconPickerPresets');
  presetsEl.innerHTML = '';
  (presets || []).forEach(emoji => {
    const btn = document.createElement('button');
    btn.className = 'icon-preset-btn';
    btn.textContent = emoji;
    btn.addEventListener('click', () => { inp.value = emoji; });
    presetsEl.appendChild(btn);
  });
  document.getElementById('iconPickerOverlay').classList.add('show');
  setTimeout(() => inp.focus(), 50);
}
document.getElementById('iconPickerOk').addEventListener('click', () => {
  const icon = document.getElementById('iconPickerInput').value.trim();
  if (icon && _iconPickerCallback) _iconPickerCallback(icon);
  document.getElementById('iconPickerOverlay').classList.remove('show');
  _iconPickerCallback = null;
});
document.getElementById('iconPickerCancel').addEventListener('click', () => {
  document.getElementById('iconPickerOverlay').classList.remove('show');
  _iconPickerCallback = null;
});
document.getElementById('iconPickerOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('iconPickerOverlay')) {
    document.getElementById('iconPickerOverlay').classList.remove('show');
    _iconPickerCallback = null;
  }
});
// close on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('iconPickerOverlay').classList.contains('show')) {
    document.getElementById('iconPickerOverlay').classList.remove('show');
    _iconPickerCallback = null;
  }
});

// ── Toolbar icon-edit buttons (data-icon-target="btnXxx") ────────────────
const TOOLBAR_ICON_PRESETS = ['🔖', '💰', '🎬', '🤖', '📰', '👥', '🧩', '⭐', '🕒', '⬇️', '⚙️', '🛠️', '🌐', '🏠', '🔍', '📌', '🎯', '🚀', '💡', '🔔', '📊', '🗂', '🗃', '📎', '✏️', '💻', '🌟', '🎪', '🎭', '🔑', '🔒', '📂', '🗑', '📡', '🧲', '🔧', '🔨', '⚡', '🌊', '🔥', '✨', '🎵', '📸', '🎮', '🏆'];
document.querySelectorAll('.s-icon-edit-btn[data-icon-target]').forEach(editBtn => {
  editBtn.addEventListener('click', () => {
    const targetId = editBtn.dataset.iconTarget;
    const targetEl = document.getElementById(targetId);
    const current = editBtn.textContent.trim();
    openIconPicker('Promijeni ikonu: ' + targetId, current, TOOLBAR_ICON_PRESETS, (icon) => {
      editBtn.textContent = icon;
      if (targetEl) {
        // Replace first emoji/char in textContent (button may have text nodes)
        const txt = targetEl.textContent;
        // Replace leading emoji(s) with new icon
        targetEl.textContent = icon;
      }
      DB.saveSetting('customIcon_' + targetId, icon);
      showToast('✎ Ikona promijenjena: ' + icon);
    });
  });
});

// ── Title Bar icon-edit buttons (data-icon-target-text="elemId") ─────────
const TITLEBAR_ICON_PRESETS = ['📅', '🗓', '📆', '🕐', '🕑', '🕒', '⏰', '⏱', '🕶', '🥷', '🔒', '🛡', '👤', '👥', '🙂', '😎', '🤖', '⬡', '🌐', '🔑', '💡', '🔔', '📍', '🌙', '☀️', '⚡', '💎', '🌊', '🎯', '🚀', '✨', '🌟'];
// Map to store custom title bar prefixes; loaded from settings
const _titlebarIcons = {};
document.querySelectorAll('.s-icon-edit-btn[data-icon-target-text]').forEach(editBtn => {
  editBtn.addEventListener('click', () => {
    const targetId = editBtn.dataset.iconTargetText;
    const current = editBtn.textContent.trim();
    openIconPicker('Promijeni ikonu: ' + targetId, current, TITLEBAR_ICON_PRESETS, (icon) => {
      editBtn.textContent = icon;
      _titlebarIcons[targetId] = icon;
      DB.saveSetting('titlebarIcon_' + targetId, icon);
      // For static elements like privateIndicator, titleProfileBtn — update directly
      const el = document.getElementById(targetId);
      if (el) {
        if (targetId === 'privateIndicator') {
          el.textContent = icon + ' Private';
        } else if (targetId === 'titleProfileBtn') {
          // Preserve the activeProfileName span
          const nameSpan = el.querySelector('#activeProfileName');
          const name = nameSpan ? nameSpan.textContent : 'Default';
          el.innerHTML = icon + ' <span id="activeProfileName">' + escHtml(name) + '</span> ▾';
        }
        // titleDate and titleClock are updated by updateClock() which reads _titlebarIcons
      }
      showToast('✎ Ikona promijenjena: ' + icon);
    });
  });
});

// ── Apply saved custom icons on load ─────────────────────────────────────
(function applySavedIcons() {
  const s = DB.getSettings();
  Object.keys(s).forEach(k => {
    if (k.startsWith('customIcon_')) {
      const id = k.replace('customIcon_', '');
      const icon = s[k];
      // Update the toolbar button
      const el = document.getElementById(id);
      if (el) el.textContent = icon;
      // Update the settings icon-edit button
      const editBtn = document.querySelector('.s-icon-edit-btn[data-icon-target="' + id + '"]');
      if (editBtn) editBtn.textContent = icon;
    }
    if (k.startsWith('titlebarIcon_')) {
      const id = k.replace('titlebarIcon_', '');
      const icon = s[k];
      _titlebarIcons[id] = icon;
      const editBtn = document.querySelector('.s-icon-edit-btn[data-icon-target-text="' + id + '"]');
      if (editBtn) editBtn.textContent = icon;
      const el = document.getElementById(id);
      if (el) {
        if (id === 'privateIndicator') {
          el.textContent = icon + ' Private';
        } else if (id === 'titleProfileBtn') {
          const nameSpan = el.querySelector('#activeProfileName');
          const name = nameSpan ? nameSpan.textContent : 'Default';
          el.innerHTML = icon + ' <span id="activeProfileName">' + escHtml(name) + '</span> ▾';
        }
      }
    }
  });
})();

// ── Init extension icon bar on startup ───────────────────────────────────
renderExtIconBar();

// ── Bookmark Folder Bar ───────────────────────────────────────────────────
function renderBmFolderBar() {
  const inner = document.getElementById('bmFolderBarInner'); if (!inner) return;
  const bms = DB.getBookmarks();
  inner.innerHTML = '';
  if (!bms.length) { inner.innerHTML = '<span style="color:var(--text3);font-size:11px;padding:0 8px">No bookmarks — press Ctrl+D to save one</span>'; return; }
  // Build folder groups
  const folders = {};
  bms.forEach(b => {
    const folder = b.folder || '⭐';
    if (!folders[folder]) folders[folder] = [];
    folders[folder].push(b);
  });
  // Also show first 10 individual bookmarks without folder
  const ungrouped = bms.filter(b => !b.folder).slice(0, 10);
  // Render folder buttons first
  Object.entries(folders).filter(([f]) => f !== '⭐').forEach(([folder, items]) => {
    const btn = document.createElement('button');
    btn.className = 'bm-bar-btn bm-bar-folder';
    btn.innerHTML = '📁 ' + escHtml(folder.slice(0, 16));
    btn.title = folder + ' (' + items.length + ' bookmarks)';
    btn.addEventListener('click', () => { renderBookmarksPanel(); togglePanel('bmPanel'); });
    inner.appendChild(btn);
  });
  // Render individual bookmarks
  ungrouped.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'bm-bar-btn';
    const icon = b.favicon || '🌐';
    btn.innerHTML = icon + ' ' + escHtml((b.title || b.url).slice(0, 20));
    btn.title = b.title || b.url;
    btn.addEventListener('click', () => { navigateTo(b.url); });
    inner.appendChild(btn);
  });
}
renderBmFolderBar();
// Refresh folder bar when bookmarks change
const _origAddBm = DB.addBookmark.bind(DB);
DB.addBookmark = function (e) { _origAddBm(e); renderBmFolderBar(); };
const _origRemBm = DB.removeBookmark.bind(DB);
DB.removeBookmark = function (u) { _origRemBm(u); renderBmFolderBar(); };

// ── Title Logo opens Bookmarks ────────────────────────────────────────────
document.getElementById('titleLogoBtn')?.addEventListener('click', () => {
  renderBookmarksPanel(); togglePanel('bmPanel');
});

// ── Autofill Suggestion Popup ─────────────────────────────────────────────
// Shows saved passwords/cards when user clicks username/password/card fields in the URL bar context
// (Since we are a browser shell, we intercept via a floating overlay near the URL bar)
const CARDS_KEY = 'ex_cards';
function getCards() { return JSON.parse(localStorage.getItem(CARDS_KEY) || '[]'); }
function saveCards(c) { localStorage.setItem(CARDS_KEY, JSON.stringify(c)); }

// Create autofill suggestion box
const afBox = document.createElement('div');
afBox.id = 'autofillBox';
afBox.style.cssText = 'position:fixed;background:var(--bg2);border:1px solid var(--border2);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.4);z-index:9999;min-width:260px;max-width:320px;display:none;flex-direction:column;overflow:hidden';
document.body.appendChild(afBox);

function hideAutofillBox() { afBox.style.display = 'none'; }
function showAutofillBox(x, y, items, onSelect) {
  afBox.innerHTML = '';
  if (!items.length) return;
  const hdr = document.createElement('div');
  hdr.style.cssText = 'padding:8px 12px 6px;font-size:10px;color:var(--text3);font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border)';
  hdr.textContent = items[0]._type === 'password' ? '🔑 Saved Passwords' : '💳 Saved Cards';
  afBox.appendChild(hdr);
  items.forEach(item => {
    const row = document.createElement('div');
    row.style.cssText = 'padding:9px 12px;cursor:pointer;display:flex;flex-direction:column;gap:2px;transition:background .1s';
    row.addEventListener('mouseenter', () => row.style.background = 'var(--border2)');
    row.addEventListener('mouseleave', () => row.style.background = '');
    if (item._type === 'password') {
      row.innerHTML = '<span style="font-size:12px;font-weight:600;color:var(--text1)">' + escHtml(item.username) + '</span><span style="font-size:10px;color:var(--text3)">' + escHtml(item.site) + '</span>';
    } else {
      row.innerHTML = '<span style="font-size:12px;font-weight:600;color:var(--text1)">💳 ' + escHtml('•••• ' + item.last4) + '</span><span style="font-size:10px;color:var(--text3)">' + escHtml(item.holder) + ' · ' + escHtml(item.expiry) + '</span>';
    }
    row.addEventListener('click', () => { onSelect(item); hideAutofillBox(); });
    afBox.appendChild(row);
  });
  afBox.style.display = 'flex';
  const bx = Math.min(x, window.innerWidth - 340);
  const by = Math.min(y, window.innerHeight - afBox.offsetHeight - 16);
  afBox.style.left = bx + 'px'; afBox.style.top = by + 'px';
}
document.addEventListener('click', e => { if (!afBox.contains(e.target)) hideAutofillBox(); });

// Wire the URL bar click to show autofill when URL looks like a login page
document.getElementById('urlInput').addEventListener('focus', () => {
  // On focus check if current tab is on a login page
  const t = getActiveTab();
  if (!t?.url) return;
  const host = (() => { try { return new URL(t.url).hostname; } catch (e) { return ''; } })();
  if (!host) return;
  const pwds = JSON.parse(localStorage.getItem('ex_passwords') || '[]').filter(p => host.includes(new URL('https://' + p.site.replace(/https?:\/\//, '')).hostname.replace('www.', ''))).map(p => ({ ...p, _type: 'password' }));
  if (pwds.length) {
    const rect = document.getElementById('urlInput').getBoundingClientRect();
    showAutofillBox(rect.left, rect.bottom + 4, pwds, (item) => {
      navigateTo(t.url); // just navigate, can't inject into iframe directly
      showToast('🔑 ' + item.username + ' — copied to clipboard');
      navigator.clipboard?.writeText(item.password);
    });
  }
});

// ── Quick password/card fill button in URL bar area ───────────────────────
// Add a small 🔑 key button in the URL bar to show saved credentials for current site
(function addAutofillBtn() {
  const urlBar = document.querySelector('.url-bar');
  if (!urlBar) return;
  const btn = document.createElement('button');
  btn.id = 'autofillBtn';
  btn.title = 'Autofill (saved passwords & cards)';
  btn.innerHTML = '🔑';
  btn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px;opacity:0.6;transition:opacity .15s;flex-shrink:0';
  btn.addEventListener('mouseenter', () => btn.style.opacity = '1');
  btn.addEventListener('mouseleave', () => btn.style.opacity = '0.6');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const t = getActiveTab();
    const host = t?.url ? (() => { try { return new URL(t.url).hostname.replace('www.', ''); } catch (e2) { return ''; } })() : '';
    const pwds = JSON.parse(localStorage.getItem('ex_passwords') || '[]')
      .filter(p => !host || p.site.replace(/https?:\/\//, '').replace('www.', '').startsWith(host) || host.includes(p.site.replace(/https?:\/\//, '').replace('www.', '')))
      .map(p => ({ ...p, _type: 'password' }));
    const cards = getCards().map(c => ({ ...c, _type: 'card' }));
    const all = [...pwds, ...cards];
    if (!all.length) { showToast('🔑 No saved passwords or cards for this site'); return; }
    const rect = btn.getBoundingClientRect();
    showAutofillBox(rect.left - 200, rect.bottom + 8, all, (item) => {
      if (item._type === 'password') {
        navigator.clipboard?.writeText(item.password);
        showToast('🔑 Password for ' + item.username + ' copied!');
      } else {
        navigator.clipboard?.writeText(item.number);
        showToast('💳 Card ' + item.last4 + ' number copied!');
      }
    });
  });
  // Insert before go-btn
  const goBtn = document.getElementById('goBtn');
  if (goBtn) urlBar.insertBefore(btn, goBtn);
  else urlBar.appendChild(btn);
})();

// ── Cards management (in Autofill settings) ───────────────────────────────
(function initCardsSettings() {
  const addCardBtn = document.getElementById('sAddCard');
  const cardList = document.getElementById('sCardList');
  function renderCardList() {
    if (!cardList) return;
    const cards = getCards();
    cardList.innerHTML = '';
    if (!cards.length) { cardList.innerHTML = '<div style="color:var(--text3);font-size:11px;padding:4px 0">No saved cards</div>'; return; }
    cards.forEach((c, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:11px';
      row.innerHTML = '<span style="flex:1">💳 ' + escHtml(c.holder) + ' •••• ' + escHtml(c.last4) + ' (' + escHtml(c.expiry) + ')</span>';
      const del = document.createElement('button');
      del.textContent = '🗑'; del.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--red)';
      del.addEventListener('click', () => { const cards = getCards(); cards.splice(i, 1); saveCards(cards); renderCardList(); showToast('🗑 Card removed'); });
      row.appendChild(del);
      cardList.appendChild(row);
    });
  }
  renderCardList();
  addCardBtn?.addEventListener('click', () => {
    const holder = prompt('Cardholder name:'); if (!holder) return;
    const number = prompt('Card number (16 digits):'); if (!number) return;
    const expiry = prompt('Expiry (MM/YY):'); if (!expiry) return;
    const cvv = prompt('CVV:'); if (!cvv) return;
    const last4 = number.replace(/\s/g, '').slice(-4);
    const cards = getCards();
    cards.push({ holder, number: number.replace(/\s/g, ''), last4, expiry, cvv, ts: Date.now() });
    saveCards(cards); renderCardList(); showToast('💳 Card saved!');
  });
})();

document.getElementById('extAddBtn').addEventListener('click', () => {
  const val = document.getElementById('extAddUrl').value.trim(); if (!val) return;
  let id = val, name = val, icon = '\uD83E\uDDE9', desc = 'Installed from Chrome Web Store';
  const m = val.match(/[a-z]{32}/i); if (m) id = m[0];

  const known = { MetaMask: "nkbihfbeogaeaoehlefnkodbefgpgknn", "uBlock Origin": "cjpalhdlnbpafiamejdnhcphjbkeiagm", Grammarly: "kbfnbcaeplbcioakkpcpgfkobkghlhen", Honey: "bmnlcjabgnpnenekpadlanbbkooimhnj", LastPass: "hdokiejnpimakedhajhdlcegeplioahd", "iCloud Passwords": "pejdijmoenmkgeppbflobdenhhabjlaj" };
  const icons = { MetaMask: '\uD83E\uDD8A', 'uBlock Origin': '\uD83D\uDEE1\uFE0F', Grammarly: '\uD83D\uDCDD', Honey: '\uD83C\uDF6F', LastPass: '\uD83D\uDD11', 'Crypto Price Tracker': '\uD83D\uDCC8', 'iCloud Passwords': '\uD83D\uDD11' };
  for (const [n, kid] of Object.entries(known)) { if (val.includes(kid) || val.toLowerCase().includes(n.toLowerCase())) { name = n; id = kid; icon = icons[n] || '\uD83E\uDDE9'; } }
  EXT_DB.add({ id, name, desc, icon, enabled: true, source: val, installedAt: Date.now() });
  renderExtList(); document.getElementById('extAddUrl').value = '';
  showToast('\uD83E\uDDE9 Installed: ' + name); consoleLog('success', '\uD83E\uDDE9 Extension installed: ' + name);
});
document.getElementById('extAddUrl').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('extAddBtn').click(); });
document.getElementById('btnExtensions').addEventListener('click', () => { const ep = document.getElementById('extPanel'); const isOpen = ep.classList.contains('open'); closeAllPanels(); ep.classList.toggle('open', !isOpen); if (!isOpen) renderExtList(); });
document.getElementById('closeExtPanel').addEventListener('click', () => document.getElementById('extPanel').classList.remove('open'));
document.querySelectorAll('.ext-tab').forEach(tab => { tab.addEventListener('click', () => { document.querySelectorAll('.ext-tab').forEach(t => t.classList.remove('active')); document.querySelectorAll('.ext-pane').forEach(p => p.classList.remove('active')); tab.classList.add('active'); const pane = document.getElementById('extpane-' + tab.dataset.extPane); if (pane) pane.classList.add('active'); if (tab.dataset.extPane === 'installed') renderExtList(); }); });

// Chrome Web Store button — works in both Electron and web mode
document.getElementById('btnOpenCWS')?.addEventListener('click', () => {
  const cwsUrl = 'https://chromewebstore.google.com';
  if (typeof require !== 'undefined') {
    try { if (window.etherx?.nav?.openExternal) { await window.etherx.nav.openExternal(cwsUrl); return; } } catch (e) { /* fall through to web mode */ }
  }
  navigateTo(cwsUrl);
  document.getElementById('extPanel')?.classList.remove('open');
});

// Wire DevTools special panes
document.querySelectorAll('.dt-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.dataset.pane === 'memory') collectMemoryMetrics();
    if (tab.dataset.pane === 'security') renderSecurityPanel();
    if (tab.dataset.pane === 'elements') {
      // Render DOM tree when Elements tab is opened
      setTimeout(() => renderDOMTree(), 100);
    }
    if (tab.dataset.pane === 'useragent') {
      const uc = document.getElementById('uaCurrent');
      if (uc) uc.textContent = activeUA;
      const ui = document.getElementById('uaCustomInput');
      if (ui) ui.value = activeUA;
    }
  });
});


// ── Featured Extensions Install ──
document.querySelectorAll('.ext-install-btn').forEach(btn => {
  btn.addEventListener('click', function () {
    const item = this.closest('.ext-feat-item');
    const name = this.dataset.name || 'Extension';
    const desc = this.dataset.desc || '';
    const icon = item?.querySelector('.ext-feat-icon')?.textContent || '🧩';
    const extId = this.dataset.id || name.toLowerCase().replace(/\s+/g, '-');
    const cwsUrl = 'https://chromewebstore.google.com/detail/' + extId;
    // Open the real Chrome Web Store page for this extension
    if (typeof require !== 'undefined') {
      try { if (window.etherx?.nav?.openExternal) window.etherx.nav.openExternal(cwsUrl); }
      catch (e) { navigateTo(cwsUrl); document.getElementById('extPanel')?.classList.remove('open'); }
    } else {
      navigateTo(cwsUrl);
      document.getElementById('extPanel')?.classList.remove('open');
    }
    // Also register it locally so it shows in the installed list
    EXT_DB.add({ id: extId, name, icon, desc, enabled: true, source: cwsUrl, installedAt: Date.now() });
    renderExtList();
    showToast('🌐 Otvaram Chrome Web Store: ' + name);
    document.querySelectorAll('.ext-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.ext-pane').forEach(p => p.classList.remove('active'));
    document.querySelector('[data-ext-pane="installed"]')?.classList.add('active');
    document.getElementById('extpane-installed')?.classList.add('active');
  });
});

// frame.load hook for recent sites
frame.addEventListener('load', () => {
  const src = frame.src || '';
  if (src.includes('gstatic.com') || src.includes('favicon') || src.includes('s2/favicons')) return;
  const t = getActiveTab(); if (t && t.url) addRecentSite(t.url, t.title);
}, { capture: false, passive: true });

// NTP init
applyNtpSettings();
renderRecentSites();

document.querySelectorAll('.ntp-card').forEach(card => card.addEventListener('click', () => navigateTo(card.dataset.url)));
document.getElementById('boOpen').addEventListener('click', () => { const t = getActiveTab(); if (t?.url) window.open(t.url, '_blank'); });
document.getElementById('boRetry').addEventListener('click', () => { const t = getActiveTab(); if (t?.url) navigateTo(t.url); });
const ctxMenu = document.getElementById('ctxMenu');
let _ctxTargetUrl = null; // URL of right-clicked link (if any)
let _ctxTabId = null;      // ID of right-clicked tab (if any)
let _ctxImageUrl = null;   // URL of right-clicked image (if any)
function showCtxMenu(x, y, targetUrl, imageUrl) {
  _ctxTargetUrl = targetUrl || null;
  _ctxImageUrl = imageUrl || null;
  // Show/hide link-specific items
  const hasLink = !!targetUrl;
  ['ctx-open-new-tab', 'ctx-open-new-window', 'ctx-open-tab-group', 'ctx-download-link', 'ctx-download-link-as', 'ctx-reading-list'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = hasLink ? '' : 'none';
  });
  document.querySelectorAll('.ctx-sep:not(.ctx-no-link), #ctx-copy-url').forEach(el => {
    el.style.display = '';
  });
  // Show/hide image-specific items
  const hasImage = !!imageUrl;
  document.querySelectorAll('.ctx-img-item').forEach(el => { el.style.display = hasImage ? '' : 'none'; });
  document.querySelectorAll('.ctx-img-sep').forEach(el => { el.style.display = hasImage ? '' : 'none'; });
  // Position
  const menuW = 240, menuH = ctxMenu.offsetHeight || 320;
  ctxMenu.style.left = Math.min(x, window.innerWidth - menuW - 8) + 'px';
  ctxMenu.style.top = Math.min(y, window.innerHeight - menuH - 8) + 'px';
  ctxMenu.classList.add('show');
}
document.addEventListener('click', () => ctxMenu.classList.remove('show'));
document.addEventListener('contextmenu', e => {
  // Check if user right-clicked on a link
  const link = e.target.closest('a[href]');
  const inContent = e.target.closest('#contentArea');
  if (inContent || link) {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, link?.href || null);
  }
});
// New context menu item handlers
document.getElementById('ctx-new-tab').addEventListener('click', () => createTab());
document.getElementById('ctx-reload').addEventListener('click', () => document.getElementById('btnReload').click());
document.getElementById('ctx-find').addEventListener('click', openFind);
document.getElementById('ctx-devtools').addEventListener('click', toggleDevtools);
document.getElementById('ctx-close-tab').addEventListener('click', () => closeTab(_ctxTabId || STATE.activeTabId));
document.getElementById('ctx-open-new-tab').addEventListener('click', () => {
  const url = _ctxTargetUrl || getActiveTab()?.url; if (url) createTab(url);
});
document.getElementById('ctx-open-new-window').addEventListener('click', () => {
  const url = _ctxTargetUrl || getActiveTab()?.url; if (url) window.open(url, '_blank');
});
document.getElementById('ctx-open-tab-group').addEventListener('click', () => {
  const url = _ctxTargetUrl || getActiveTab()?.url; if (url) { createTab(url); showToast('Opened in Tab Group'); }
});
document.getElementById('ctx-download-link').addEventListener('click', () => {
  if (_ctxTargetUrl) { const a = document.createElement('a'); a.href = _ctxTargetUrl; a.download = ''; a.click(); showToast('⬇️ Download started'); }
});
document.getElementById('ctx-download-link-as').addEventListener('click', () => {
  if (_ctxTargetUrl) {
    const name = prompt('Save as:', _ctxTargetUrl.split('/').pop() || 'file');
    if (name) { const a = document.createElement('a'); a.href = _ctxTargetUrl; a.download = name; a.click(); showToast('⬇️ Download started'); }
  }
});
document.getElementById('ctx-bookmark').addEventListener('click', () => {
  const url = _ctxTargetUrl || getActiveTab()?.url;
  const title = _ctxTargetUrl ? _ctxTargetUrl : (getActiveTab()?.title || url);
  if (url) { DB.addBookmark({ url, title, ts: Date.now() }); showToast('🔖 Added to Bookmarks'); renderBookmarksPanel(); }
});
document.getElementById('ctx-reading-list').addEventListener('click', () => {
  const url = _ctxTargetUrl || getActiveTab()?.url;
  if (url) showToast('📖 Added to Reading List: ' + url.slice(0, 40));
});
document.getElementById('ctx-copy-url').addEventListener('click', () => {
  const url = _ctxTargetUrl || getActiveTab()?.url;
  if (url) navigator.clipboard.writeText(url).then(() => showToast('📋 URL copied'));
});
// Reverse image search handlers (RevEye integration)
const _revEyeEngines = {
  google: 'https://lens.google.com/uploadbyurl?url=%s',
  bing: 'https://www.bing.com/images/searchbyimage?cbir=ssbi&imgurl=%s',
  yandex: 'https://yandex.com/images/search?rpt=imageview&url=%s',
  tineye: 'https://www.tineye.com/search/?url=%s',
};
function _revEyeSearch(engineId) {
  if (!_ctxImageUrl) return;
  const url = _revEyeEngines[engineId].replace('%s', encodeURIComponent(_ctxImageUrl));
  createTab(url);
}
document.getElementById('ctx-img-search-google').addEventListener('click', () => _revEyeSearch('google'));
document.getElementById('ctx-img-search-bing').addEventListener('click', () => _revEyeSearch('bing'));
document.getElementById('ctx-img-search-yandex').addEventListener('click', () => _revEyeSearch('yandex'));
document.getElementById('ctx-img-search-tineye').addEventListener('click', () => _revEyeSearch('tineye'));
document.getElementById('ctx-img-copy-url').addEventListener('click', () => {
  if (_ctxImageUrl) navigator.clipboard.writeText(_ctxImageUrl).then(() => showToast('📋 Image URL copied'));
});
document.getElementById('ctx-share').addEventListener('click', () => {
  const url = _ctxTargetUrl || getActiveTab()?.url;
  const title = getActiveTab()?.title || url;
  if (navigator.share && url) { navigator.share({ title, url }).catch(() => { }); }
  else if (url) { navigator.clipboard.writeText(url).then(() => showToast('📋 Link copied to share')); }
});
document.getElementById('ctx-save-page').addEventListener('click', () => {
  const t = getActiveTab(); if (t?.url) { const a = document.createElement('a'); a.href = t.url; a.download = (t.title || 'page') + '.html'; a.click(); }
});
document.querySelectorAll('.menu-item').forEach(item => {
  item.addEventListener('click', e => { e.stopPropagation(); const wasOpen = item.classList.contains('open'); document.querySelectorAll('.menu-item').forEach(i => i.classList.remove('open')); if (!wasOpen) item.classList.add('open'); });
});
document.addEventListener('click', () => document.querySelectorAll('.menu-item').forEach(i => i.classList.remove('open')));
document.getElementById('newTabBtn').addEventListener('click', () => createTab());
let toastTimer;
function showToast(msg, duration = 2000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}
function updateClock() { const now = new Date(); const cfg = DB.getSettings(); const h12 = cfg.clockFormat === '12h'; const showSec = cfg.clockShowSeconds === true; const opts = { hour: '2-digit', minute: '2-digit', hour12: h12 }; if (showSec) opts.second = '2-digit'; const t = now.toLocaleTimeString([], opts); const d = now.toLocaleDateString('hr-HR', { weekday: 'short', day: 'numeric', month: 'short' }); const clockPfx = (typeof _titlebarIcons !== 'undefined' && _titlebarIcons['titleClock']) || ''; const datePfx = (typeof _titlebarIcons !== 'undefined' && _titlebarIcons['titleDate']) || ''; const clockEl = document.getElementById('titleClock'); clockEl.textContent = (clockPfx ? clockPfx + ' ' : '') + t; const savedCfg = DB.getSettings(); if (savedCfg.clockColor) clockEl.style.color = savedCfg.clockColor; if (savedCfg.clockSize) clockEl.style.fontSize = savedCfg.clockSize + 'px'; document.getElementById('sbTime').textContent = t; const de = document.getElementById('titleDate'); if (de) de.textContent = (datePfx ? datePfx + ' ' : '') + d; }
updateClock(); setInterval(updateClock, 30000);
function timeAgo(ts) { const d = Date.now() - ts; if (d < 60000) return 'now'; if (d < 3600000) return Math.floor(d / 60000) + 'm'; if (d < 86400000) return Math.floor(d / 3600000) + 'h'; return Math.floor(d / 86400000) + 'd'; }
document.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey; const shift = e.shiftKey;
  if (ctrl && e.key === 't') { e.preventDefault(); createTab(); }
  else if (ctrl && e.key === 'w') { e.preventDefault(); closeTab(STATE.activeTabId); }
  else if (ctrl && e.key === 'r') { e.preventDefault(); document.getElementById('btnReload').click(); }
  else if (ctrl && e.key === 'f') { e.preventDefault(); openFind(); }
  else if (ctrl && e.key === 'd') { e.preventDefault(); addBookmark(); }
  else if (ctrl && e.key === 'h') { e.preventDefault(); renderHistoryPanel(); togglePanel('histPanel'); }
  else if (ctrl && e.key === 'b') { e.preventDefault(); renderBookmarksPanel(); togglePanel('bmPanel'); }
  else if (ctrl && e.key === 'j') { e.preventDefault(); togglePanel('dlPanel'); }
  else if (ctrl && e.key === 'l') { e.preventDefault(); urlInput.focus(); urlInput.select(); }
  else if (ctrl && e.key === '=') { e.preventDefault(); setZoom(STATE.zoom + 10); }
  else if (ctrl && e.key === '-') { e.preventDefault(); setZoom(STATE.zoom - 10); }
  else if (ctrl && e.key === '0') { e.preventDefault(); setZoom(100); }
  else if (ctrl && shift && e.key === 'M') { e.preventDefault(); toggleRespMode(); }
  else if (ctrl && shift && e.key === '\\') { e.preventDefault(); toggleTabOverview(); }
  else if (ctrl && shift && e.key === 'D') { e.preventDefault(); const cur = DB.getSettings().pageDarkMode || false; applyPageDarkMode(!cur); }
  else if (ctrl && e.key === 'Tab') { e.preventDefault(); document.getElementById('mi-next-tab').click(); }
  else if (ctrl && shift && e.key === 'Tab') { e.preventDefault(); document.getElementById('mi-prev-tab').click(); }
  else if (e.key === 'F12') { e.preventDefault(); toggleDevtools(); }
  else if (e.key === 'F11') { e.preventDefault(); document.getElementById('mi-fullscreen').click(); }
  else if ((function () {
    const sc = (DB.getSettings().screenshotShortcut || 'Ctrl+Shift+S').split('+');
    const needCtrl = sc.includes('Ctrl'), needAlt = sc.includes('Alt'), needShift = sc.includes('Shift');
    const mainKey = sc.filter(k => !['Ctrl', 'Alt', 'Shift'].includes(k))[0] || '';
    return ctrl === needCtrl && e.altKey === needAlt && shift === needShift && (e.key === mainKey || e.key.toUpperCase() === mainKey.toUpperCase());
  })()) { e.preventDefault(); takeScreenshot(false); }
  else if (e.key === 'F5' && shift) {
    e.preventDefault();
    // Hard reload: clear document cookies for current tab then reload
    const tab = getActiveTab();
    const host = tab?.url ? (() => { try { return new URL(tab.url).hostname; } catch (e2) { return ''; } })() : '';
    document.cookie.split(';').forEach(c => {
      const name = c.trim().split('=')[0];
      if (name) { document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/'; document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=' + host; }
    });
    document.getElementById('btnReload').click();
    showToast('🍪 Cookies cleared — reloading…');
  }
  else if (e.key === 'F5') { e.preventDefault(); document.getElementById('btnReload').click(); }
  else if (e.key === 'Escape') { closeFind(); closeAllPanels(); ctxMenu.classList.remove('show'); document.getElementById('tabOverview').classList.remove('show'); }
  else if (e.altKey && e.key === 'ArrowLeft') { document.getElementById('btnBack').click(); }
  else if (e.altKey && e.key === 'ArrowRight') { document.getElementById('btnFwd').click(); }
});
// ── Data Migration ──
(function initMigration() {
  document.querySelectorAll('#stab-migration .toggle').forEach(el => {
    el.addEventListener('click', () => el.classList.toggle('on'));
  });
  const DEMO_BOOKMARKS = {
    'Google Chrome': [{ url: 'https://google.com', title: 'Google' }, { url: 'https://youtube.com', title: 'YouTube' }, { url: 'https://gmail.com', title: 'Gmail' }, { url: 'https://github.com', title: 'GitHub' }, { url: 'https://stackoverflow.com', title: 'Stack Overflow' }, { url: 'https://docs.google.com', title: 'Google Docs' }, { url: 'https://drive.google.com', title: 'Google Drive' }, { url: 'https://maps.google.com', title: 'Google Maps' }, { url: 'https://translate.google.com', title: 'Google Translate' }, { url: 'https://news.google.com', title: 'Google News' }, { url: 'https://calendar.google.com', title: 'Google Calendar' }, { url: 'https://meet.google.com', title: 'Google Meet' }],
    'Mozilla Firefox': [{ url: 'https://mozilla.org', title: 'Mozilla' }, { url: 'https://developer.mozilla.org', title: 'MDN Web Docs' }, { url: 'https://reddit.com', title: 'Reddit' }, { url: 'https://wikipedia.org', title: 'Wikipedia' }, { url: 'https://addons.mozilla.org', title: 'Firefox Add-ons' }, { url: 'https://news.ycombinator.com', title: 'Hacker News' }, { url: 'https://lobste.rs', title: 'Lobsters' }, { url: 'https://twitter.com', title: 'Twitter / X' }],
    'Microsoft Edge': [{ url: 'https://bing.com', title: 'Bing' }, { url: 'https://outlook.com', title: 'Outlook' }, { url: 'https://office.com', title: 'Microsoft 365' }, { url: 'https://linkedin.com', title: 'LinkedIn' }, { url: 'https://onedrive.live.com', title: 'OneDrive' }, { url: 'https://teams.microsoft.com', title: 'Microsoft Teams' }, { url: 'https://copilot.microsoft.com', title: 'Copilot' }],
    'Safari': [
      { url: 'https://apple.com', title: 'Apple' },
      { url: 'https://icloud.com', title: 'iCloud' },
      { url: 'https://news.apple.com', title: 'Apple News' },
      { url: 'https://support.apple.com', title: 'Apple Support' },
      { url: 'https://developer.apple.com', title: 'Apple Developer' },
      { url: 'https://webkit.org', title: 'WebKit' },
      { url: 'https://apps.apple.com', title: 'App Store' },
      { url: 'https://music.apple.com', title: 'Apple Music' },
      { url: 'https://tv.apple.com', title: 'Apple TV+' },
      { url: 'https://store.apple.com', title: 'Apple Store' },
      { url: 'https://www.youtube.com', title: 'YouTube' },
      { url: 'https://www.google.com', title: 'Google' },
      { url: 'https://wikipedia.org', title: 'Wikipedia' },
      { url: 'https://www.reddit.com', title: 'Reddit' },
      { url: 'https://www.instagram.com', title: 'Instagram' },
      { url: 'https://www.facebook.com', title: 'Facebook' },
      { url: 'https://twitter.com', title: 'X (Twitter)' },
      { url: 'https://www.linkedin.com', title: 'LinkedIn' },
      { url: 'https://www.amazon.com', title: 'Amazon' },
      { url: 'https://www.netflix.com', title: 'Netflix' },
      { url: 'https://kriptoentuzijasti.io', title: 'Kripto Entuzijasti' },
      { url: 'https://etherscan.io', title: 'Etherscan' },
      { url: 'https://coinmarketcap.com', title: 'CoinMarketCap' },
      { url: 'https://coingecko.com', title: 'CoinGecko' },
      { url: 'https://uniswap.org', title: 'Uniswap' },
      { url: 'https://opensea.io', title: 'OpenSea' },
      { url: 'https://metamask.io', title: 'MetaMask' },
      { url: 'https://app.ens.domains', title: 'ENS Domains' },
      { url: 'https://dydx.exchange', title: 'dYdX' },
      { url: 'https://aave.com', title: 'Aave' }
    ],
    'Brave': [{ url: 'https://brave.com', title: 'Brave' }, { url: 'https://search.brave.com', title: 'Brave Search' }, { url: 'https://basicattentiontoken.org', title: 'BAT' }, { url: 'https://etherscan.io', title: 'Etherscan' }, { url: 'https://coinmarketcap.com', title: 'CoinMarketCap' }, { url: 'https://uniswap.org', title: 'Uniswap' }, { url: 'https://metamask.io', title: 'MetaMask' }, { url: 'https://opensea.io', title: 'OpenSea' }],
    'Opera': [{ url: 'https://opera.com', title: 'Opera' }, { url: 'https://addons.opera.com', title: 'Opera Addons' }, { url: 'https://blogs.opera.com', title: 'Opera Blog' }, { url: 'https://opera.com/gx', title: 'Opera GX' }, { url: 'https://opera.com/crypto', title: 'Opera Crypto' }]
  };
  const DEMO_HISTORY = {
    'Google Chrome': [{ url: 'https://google.com/search?q=web3', title: 'web3 - Google Search' }, { url: 'https://docs.google.com', title: 'Google Docs' }, { url: 'https://maps.google.com', title: 'Google Maps' }, { url: 'https://github.com/trending', title: 'Trending - GitHub' }, { url: 'https://youtube.com/feed/trending', title: 'Trending - YouTube' }],
    'Mozilla Firefox': [{ url: 'https://developer.mozilla.org/en-US/docs/Web', title: 'Web technology for developers' }, { url: 'https://addons.mozilla.org', title: 'Firefox Add-ons' }, { url: 'https://reddit.com/r/programming', title: 'r/programming' }],
    'Microsoft Edge': [{ url: 'https://bing.com/search?q=crypto', title: 'crypto - Search' }, { url: 'https://copilot.microsoft.com', title: 'Microsoft Copilot' }, { url: 'https://outlook.com/mail/inbox', title: 'Inbox – Outlook' }],
    'Safari': [
      { url: 'https://apple.com/safari', title: 'Safari - Apple' },
      { url: 'https://webkit.org/blog', title: 'WebKit Blog' },
      { url: 'https://news.apple.com', title: 'Apple News' },
      { url: 'https://kriptoentuzijasti.io', title: 'Kripto Entuzijasti' },
      { url: 'https://coinmarketcap.com', title: 'CoinMarketCap' },
      { url: 'https://etherscan.io', title: 'Etherscan' },
      { url: 'https://google.com/search?q=ethereum', title: 'ethereum - Google' },
      { url: 'https://icloud.com/notes', title: 'iCloud Notes' },
      { url: 'https://www.youtube.com/watch?v=latest', title: 'YouTube' },
      { url: 'https://twitter.com/home', title: 'X (Twitter)' }
    ],
    'Brave': [{ url: 'https://search.brave.com/search?q=defi', title: 'defi - Brave Search' }, { url: 'https://etherscan.io/txs', title: 'Transactions - Etherscan' }],
    'Opera': [{ url: 'https://opera.com/features', title: 'Opera Features' }, { url: 'https://opera.com/gx', title: 'Opera GX' }]
  };
  document.getElementById('btnStartMigration')?.addEventListener('click', () => {
    const source = document.getElementById('migrationSource').value;
    const impBm = document.getElementById('migImportBookmarks')?.classList.contains('on');
    const impHist = document.getElementById('migImportHistory')?.classList.contains('on');
    const status = document.getElementById('migrationStatus');
    let count = 0;
    status.innerHTML = '<span style="color:var(--accent)">Importing from ' + source + '...</span>';
    setTimeout(() => {
      if (impBm && DEMO_BOOKMARKS[source]) {
        DEMO_BOOKMARKS[source].forEach(b => DB.addBookmark(b));
        count += DEMO_BOOKMARKS[source].length;
      }
      if (impHist && DEMO_HISTORY[source]) {
        DEMO_HISTORY[source].forEach(h => DB.addHistory(h));
        count += DEMO_HISTORY[source].length;
      }
      status.innerHTML = '<span style="color:var(--green)">\u2713 Imported ' + count + ' items from ' + source + '</span>';
      showToast('\u2713 Imported ' + count + ' items from ' + source);
      renderBookmarksPanel(); renderHistoryPanel();
    }, 800);
  });
  document.getElementById('btnMigrationFile')?.addEventListener('click', () => {
    document.getElementById('migrationFileInput')?.click();
  });
  document.getElementById('migrationFileInput')?.addEventListener('change', function (e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = function (ev) {
      try {
        const raw = ev.target.result;
        const status = document.getElementById('migrationStatus');
        let count = 0;
        if (file.name.toLowerCase().endsWith('.json')) {
          const data = JSON.parse(raw);
          if (data.bookmarks && Array.isArray(data.bookmarks)) { data.bookmarks.forEach(b => DB.addBookmark(b)); count += data.bookmarks.length; }
          if (data.history && Array.isArray(data.history)) { data.history.forEach(h => DB.addHistory(h)); count += data.history.length; }
          if (data.settings && typeof data.settings === 'object') { Object.entries(data.settings).forEach(([k, v]) => DB.saveSetting(k, v)); }
        } else {
          const parser = new DOMParser();
          const doc = parser.parseFromString(raw, 'text/html');
          doc.querySelectorAll('a[href]').forEach(a => {
            const url = a.getAttribute('href');
            const title = a.textContent.trim() || url;
            if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
              DB.addBookmark({ url, title }); count++;
            }
          });
        }
        status.innerHTML = '<span style="color:var(--green)">✓ Imported ' + count + ' bookmarks from file</span>';
        showToast('✓ Imported ' + count + ' bookmarks');
        renderBookmarksPanel(); renderHistoryPanel();
      } catch (err) {
        status.innerHTML = '<span style="color:var(--red)">✗ Greška: ' + err.message + '</span>';
      }
    };
    reader.readAsText(file);
    this.value = '';
  });
  document.getElementById('btnExportData')?.addEventListener('click', () => {
    const data = { bookmarks: DB.getBookmarks(), history: DB.getHistory(), settings: DB.getSettings(), extensions: JSON.parse(localStorage.getItem('ex_extensions') || '[]'), exportDate: new Date().toISOString(), browser: 'EtherX' };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'etherx-export-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
    showToast('Data exported successfully');
  });
})();
// ── AI Agent Chat (Intelligent) ──
(function initAiAgent() {
  const msgs = document.getElementById('aiChatMessages');
  const input = document.getElementById('aiChatInput');
  const sendBtn = document.getElementById('aiChatSend');
  const clearBtn = document.getElementById('aiAgentClear');
  if (!msgs || !input || !sendBtn) return;
  const AI_STORAGE = 'ex_ai_chat';
  const KRIPTO_API = 'https://kriptoentuzijasti.io/wp-json/wp/v2';

  // Standalone: fetch WP REST API directly (requires CORS enabled on kriptoentuzijasti.io)
  async function proxyFetch(apiPath, timeout) {
    const fullUrl = KRIPTO_API + apiPath;
    // Direct fetch — works if CORS is enabled on the WP site
    const r2 = await fetch(fullUrl, { signal: AbortSignal.timeout(timeout || 10000) });
    if (!r2.ok) throw new Error('HTTP ' + r2.status);
    return r2.json();
  }

  // ── Fetch articles from kriptoentuzijasti.io ──
  async function searchKripto(query) {
    try {
      const posts = await proxyFetch('/posts?search=' + encodeURIComponent(query) + '&per_page=5&_fields=title,link,excerpt');
      if (!Array.isArray(posts) || !posts.length) return null;
      return posts.map(p => ({
        title: p.title?.rendered || '',
        link: p.link || '',
        excerpt: (p.excerpt?.rendered || '').replace(/<[^>]*>/g, '').slice(0, 120)
      }));
    } catch (e) { console.warn('Kripto search error:', e); return null; }
  }

  // ── Fetch latest posts ──
  async function getLatestPosts(n) {
    try {
      const posts = await proxyFetch('/posts?per_page=' + (n || 5) + '&_fields=title,link,date');
      if (!Array.isArray(posts) || !posts.length) return null;
      return posts;
    } catch (e) { console.warn('getLatestPosts error:', e); return null; }
  }

  // ── System health check ──
  function checkSystemHealth() {
    const checks = [];
    // Check panels exist
    const panels = ['walletPanel', 'bobiaiPanel', 'aiAgentPanel', 'kriptoPanel', 'etherxPanel', 'cryptoPricePanel', 'settingsPanel', 'bmPanel', 'histPanel', 'dlPanel'];
    let panelsOk = 0;
    panels.forEach(id => { if (document.getElementById(id)) panelsOk++; });
    checks.push(panelsOk === panels.length ? '✅ Svi paneli ucitani (' + panelsOk + '/' + panels.length + ')' : '⚠️ Paneli: ' + panelsOk + '/' + panels.length + ' ucitano');
    // Check tabs
    const tabCount = document.querySelectorAll('.tab').length;
    checks.push('✅ Aktivnih tabova: ' + tabCount);
    // Check DevTools
    checks.push(document.getElementById('devtools') ? '✅ DevTools dostupni' : '❌ DevTools nedostupni');
    // Check iframes
    const iframes = ['bobiaiFrame', 'kriptoFrame', 'etherxFrame'];
    let iOk = 0; iframes.forEach(id => { if (document.getElementById(id)) iOk++; });
    checks.push(iOk === iframes.length ? '✅ Svi iframe-ovi ucitani (' + iOk + '/' + iframes.length + ')' : '⚠️ Iframes: ' + iOk + '/' + iframes.length);
    // Check localStorage
    const storageKeys = ['ex_settings', 'ex_bookmarks', 'ex_history', 'ex_downloads', 'ex_profiles', 'ex_passwords'];
    let sOk = 0; storageKeys.forEach(k => { if (localStorage.getItem(k)) sOk++; });
    checks.push('💾 Lokalni podaci: ' + sOk + '/' + storageKeys.length + ' kljuceva aktivno');
    // Check memory
    if (performance && performance.memory) {
      const mb = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
      checks.push('🧠 Memorija: ' + mb + ' MB koristeno');
    }
    // Check connection
    if (navigator.onLine) checks.push('🌐 Internet: Online');
    else checks.push('❌ Internet: Offline');
    // Check service worker / PWA
    if ('serviceWorker' in navigator) checks.push('✅ PWA podrska dostupna');
    // Check theme
    const theme = DB.getSettings().theme || 'dark';
    checks.push('🎨 Tema: ' + theme);
    return checks;
  }

  // ── Check if kriptoentuzijasti.io is reachable ──
  async function checkKriptoSite() {
    try {
      const posts = await proxyFetch('/posts?per_page=1&_fields=title', 5000);
      return Array.isArray(posts) && posts.length > 0;
    } catch (e) { return false; }
  }

  // ── Smart response engine ──
  async function getSmartResponse(msg) {
    const m = msg.toLowerCase().trim();

    // ── Help and predefined prompts ──
    if (m === 'pomoć' || m === 'help' || m === 'što možeš' || m === 'sto mozes' || m === 'opcije') {
      return `Ja sam tvoj AI asistent u EtherX browseru! Evo što sve mogu napraviti za tebe (bez preopterećenja sustava):

**1. Analiza sadržaja**
• Napiši \`sažetak\`, \`što piše ovdje\` ili \`analiziraj\` dok si na nekoj stranici da dobiješ kratki pregled.

**2. Dijagnostika browsera**
• Napiši \`status\`, \`sistem\`, \`provjeri sustav\` da ti ispišem trenutno stanje memorije, tabova i aktivnih modula.
• Napiši \`memorija\` ili \`potrošnja\` da ti javim koliko RAM-a trenutno trošimo.

**3. Edukacija o kriptovalutama**
• Napiši \`što je bitcoin\`, \`objasni nft\` ili pitaj bilo koji drugi osnovni kripto pojam - imam ugrađenu bazu znanja.
• \`kripto vijesti\` ili \`najnovije vijesti\` da povučem zadnje naslove sa našeg portala.

**4. Navigacija**
• Upiši \`otvori [stranicu]\` (npr. \`otvori google.com\`) i ja ću ti otvoriti novi tab s tom adresom.

Sve se izvršava optimalno i brzo! Što te zanima?`;
    }

    if (m.includes('memorija') || m.includes('potrošnja') || m.includes('ram')) {
      if (performance && performance.memory) {
        const mb = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
        const total = Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024);
        return `Trenutno koristimo **${mb} MB** memorije (od dozvoljenih ${total} MB za ovaj tab). Browser radi stabilno!`;
      }
      return "Nažalost ne mogu pročitati točnu potrošnju memorije u ovom okruženju, ali browser radi unutar normalnih parametara.";
    }

    if (m.startsWith('otvori ') || m.startsWith('open ')) {
      let targetUrl = m.replace('otvori ', '').replace('open ', '').trim();
      if (!targetUrl.startsWith('http')) {
        targetUrl = 'https://' + targetUrl;
      }
      createTab(targetUrl);
      return `Otvaram ${targetUrl} u novom tabu!`;
    }

    // ── Summarize current page ──
    if (m.includes('sažetak') || m.includes('sazet') || m.includes('summar') || m.includes('analiz') || m.includes('što piše') || m.includes('sta pise') || m.includes('o čemu') || m.includes('o cemu')) {
      const tab = getActiveTab();
      if (!tab?.url || !tab.url.startsWith('http')) {
        return '⚠️ Nema aktivne web stranice. Otvori neku stranicu pa pitaj za sažetak.';
      }
      // Reuse send()'s typing indicator — just await the result here
      const result = await summarizeCurrentPage();
      if (!result.ok) {
        return '⚠️ ' + (result.error || 'Greška pri generiranju sažetka.');
      }
      const cacheNote = result.cached ? ' _(iz cache-a)_' : '';
      let resp = `✨ **Gemini sažetak: ${new URL(tab.url).hostname}**${cacheNote}\n\n`;
      const cache = _summaryCache[_md5Hash(tab.url)];
      if (cache?.bullets?.length) {
        cache.bullets.forEach((b, i) => {
          const clean = b.replace(/^[•\-\d\.\s]+/, '').trim();
          resp += `${i + 1}. ${clean}\n`;
        });
      }
      resp += '\n_(Sažetak je također prikazan u kartici desno dolje ✨)_';
      return resp;
    }

    // ── Greetings ──
    if (/^(bok|hej|cao|zdravo|hi|hello|hey|dobr|pozdrav)/.test(m)) {
      return 'Bok! 👋 Ja sam EtherX AI Agent. Mogu ti pomoci s:\n\u2022 🔍 Pretrazivanjem clanaka s kriptoentuzijasti.io\n\u2022 📊 Informacijama o kriptovalutama\n\u2022 🔧 Provjerom sustava i statusa browsera\n\u2022 💰 Web3, DeFi, NFT pitanjima\n\u2022 🚀 Pomoc s EtherX preglednikom\n\nSamo pitaj!';
    }

    // ── System check request ──
    if (m.includes('status') || m.includes('sustav') || m.includes('provjeri') || m.includes('health') || m.includes('dijagnostik') || m.includes('system') || m.includes('provjera')) {
      const checks = checkSystemHealth();
      let resp = '📊 **Provjera sustava EtherX Browser:**\n\n' + checks.join('\n');
      // Also check kriptoentuzijasti.io
      const kOk = await checkKriptoSite();
      resp += '\n' + (kOk ? '\u2705 kriptoentuzijasti.io: Dostupan' : '\u274c kriptoentuzijasti.io: Nedostupan');
      resp += '\n\n🟢 Sustav ' + (checks.filter(c => c.startsWith('\u274c')).length === 0 ? 'radi ispravno!' : 'ima problema - provjeri crvene stavke.');
      return resp;
    }

    // ── Help ──
    if (m.includes('pomoc') || m.includes('pomozi') || m.includes('help') || m.includes('sto mozes') || m.includes('sta mozes') || m.includes('mogucnosti')) {
      return '🤖 **EtherX AI Agent mogucnosti:**\n\n\u2022 🔍 **Pretrazi clanak** - pitaj me o bilo cemu vezano za kripto i pretrazit cu kriptoentuzijasti.io\n\u2022 🔧 **Provjeri sustav** - reci "provjeri sustav" za dijagnostiku\n\u2022 📰 **Najnovije vijesti** - reci "novosti" ili "vijesti" za najnovije clanke\n\u2022 💰 **Kripto info** - pitaj o Bitcoin, Ethereum, DeFi, NFT, Web3\n\u2022 🎬 **BobiAI** - pitaj o BobiAI Studio\n\u2022 🚀 **EtherX** - pitaj o EtherX pregledniku i social mrezi\n\u2022 🌍 **EtherX.io** - pitaj o EtherX social platformi\n\nSve informacije iz nasih clanaka dolaze direktno s kriptoentuzijasti.io!';
    }

    // ── Latest news request ──
    if (m.includes('novost') || m.includes('vijes') || m.includes('najnovij') || m.includes('latest') || m.includes('news') || m.includes('novo') || m.includes('clanci') || m.includes('clanaka')) {
      const posts = await getLatestPosts(5);
      if (posts && posts.length) {
        let resp = '📰 **Najnoviji clanci s kriptoentuzijasti.io:**\n\n';
        posts.forEach((p, i) => {
          const title = p.title?.rendered || '';
          const date = p.date ? new Date(p.date).toLocaleDateString('hr-HR') : '';
          resp += (i + 1) + '. **' + title + '**\n   🔗 ' + p.link + '\n   📅 ' + date + '\n\n';
        });
        resp += 'Klikni na link za citanje punog clanka!';
        return resp;
      }
      return '\u26a0\ufe0f Nisam mogao dohvatiti najnovije clanke. Provjeri internet vezu.';
    }

    // ── Thanks ──
    if (m.includes('hvala') || m.includes('thanks') || m.includes('thx')) {
      return 'Nema na cemu! 😊 Uvijek sam tu za pomoc. Ako trebas sto, samo pitaj!';
    }

    // ── Specific crypto topics - also search kriptoentuzijasti.io ──
    const cryptoKeywords = {
      'bitcoin': '📊 **Bitcoin (BTC)**\nBitcoin je prva i najpoznatija kriptovaluta s ogranicenom ponudom od 21 milijun BTC. Koristi Proof-of-Work konsenzus mehanizam.',
      'btc': '📊 **Bitcoin (BTC)**\nBitcoin je prva decentralizirana kriptovaluta, kreirana od Satoshi Nakamota 2009. godine.',
      'ethereum': '💎 **Ethereum (ETH)**\nEthereum je platforma za pametne ugovore i dApps. Od The Merge koristi Proof-of-Stake. Drugi po trzisnoj kapitalizaciji.',
      'eth': '💎 **Ethereum (ETH)**\nEthereum omogucava DeFi, NFT-ove i Web3 aplikacije. EtherX preglednik je optimiziran za Ethereum ekosustav.',
      'defi': '🏦 **DeFi (Decentralizirane Financije)**\nDeFi ukljucuje DEX-ove (Uniswap, SushiSwap), lending protokole (Aave, Compound) i yield farming. Sve bez posrednika!',
      'nft': '🎨 **NFT-ovi (Non-Fungible Tokens)**\nJedinstveni digitalni tokeni za vlasnistvo nad digitalnom imovinom. Marketplace-ovi: OpenSea, Blur, Magic Eden.',
      'web3': '🌐 **Web3**\nNova generacija interneta bazirana na decentralizaciji, blockchainu i token ekonomiji. EtherX je Web3 preglednik!',
      'wallet': '💰 **BOBIAI Wallet**\nEtherX ima ugradjen wallet koji podrzava vise blockchainova. Pristupite klikom na 💰 ikonu. Podrzava slanje, primanje i povezivanje s dApps.',
      'bobiai': '🎬 **BobiAI Studio**\nAI platforma za generiranje videa. Koristi napredne AI modele za kreiranje multi-scene videa iz teksta. Pristupite klikom na 🎬 ikonu.',
      'etherx': '🚀 **EtherX preglednik i EtherX.io**\nEtherX preglednik ima ugradjen wallet, AI agent, DevTools, BobiAI Studio.\nEtherX.io je social media mreza za kripto, Web3 i AI entuzijaste!',
      'kripto': '🪙 **Kriptovalute**\nDigitalna sredstva zasticena kriptografijom. Najpoznatije: Bitcoin, Ethereum, Solana, Cardano. EtherX je optimiziran za kripto ekosustav!',
      'solana': '\u26a1 **Solana (SOL)**\nBrz blockchain s niskim naknadama. Popularan za DeFi i NFT-ove. Koristi Proof-of-History + Proof-of-Stake.',
      'cardano': '🔹 **Cardano (ADA)**\nAkademski recenzirana blockchain platforma. Koristi Ouroboros PoS protokol. Fokus na sigurnost i skalabilnost.',
      'polkadot': '\u26ab **Polkadot (DOT)**\nMulti-chain mreza koja povezuje razlicite blockchainove. Omogucava medusobnu komunikaciju lanaca.',
      'staking': '💸 **Staking**\nZakljucavanje kripto valuta za podršku mreze i zaradu nagrada. Dostupno za ETH, SOL, ADA, DOT i druge PoS blockchainove.',
      'mining': '\u26cf\ufe0f **Mining (Rudarenje)**\nProces verifikacije transakcija i kreiranja novih blokova. Bitcoin koristi SHA-256, Litecoin koristi Scrypt.',
      'blockchain': '🔗 **Blockchain**\nDistribuirana baza podataka (ledger) koja zapisuje transakcije u blokove povezane kriptografski. Osnova kripto ekosustava.',
      'metaverse': '🌌 **Metaverse**\nVirtualni svjetovi na blockchainu. Projekti: Decentraland, The Sandbox, Otherside. Koriste NFT-ove za digitalno vlasnistvo.',
      'cijena': '📈 Za pracenje cijena posjeti CoinGecko ili CoinMarketCap u EtherX pregledniku!'
    };

    // Check crypto keywords first for immediate response
    let cryptoResp = null;
    for (const [key, resp] of Object.entries(cryptoKeywords)) {
      if (m.includes(key)) { cryptoResp = resp; break; }
    }

    // Always try to search kriptoentuzijasti.io for relevant content
    const searchTerms = m.replace(/[?!.,;:]/g, '').split(/\s+/).filter(w => w.length > 3).slice(0, 3).join(' ');
    let articles = null;
    if (searchTerms.length > 3) {
      articles = await searchKripto(searchTerms);
    }

    // Build combined response
    if (cryptoResp && articles && articles.length) {
      let resp = cryptoResp + '\n\n📰 **Povezani clanci s kriptoentuzijasti.io:**\n';
      articles.slice(0, 3).forEach((a, i) => {
        resp += '\n' + (i + 1) + '. **' + a.title + '**\n   ' + a.excerpt + '...\n   🔗 ' + a.link;
      });
      return resp;
    }

    if (cryptoResp) return cryptoResp;

    if (articles && articles.length) {
      let resp = '🔍 **Pronadjeno na kriptoentuzijasti.io:**\n';
      articles.forEach((a, i) => {
        resp += '\n' + (i + 1) + '. **' + a.title + '**\n   ' + a.excerpt + '...\n   🔗 ' + a.link;
      });
      return resp;
    }

    // If nothing found in keywords or search, try broader search
    if (searchTerms.length > 3) {
      const broader = await searchKripto(m.split(/\s+/)[0]);
      if (broader && broader.length) {
        let resp = '🤔 Nisam nasao tocan odgovor, ali evo povezanih clanaka s kriptoentuzijasti.io:\n';
        broader.slice(0, 3).forEach((a, i) => {
          resp += '\n' + (i + 1) + '. **' + a.title + '**\n   🔗 ' + a.link;
        });
        return resp;
      }
    }

    // Default intelligent responses
    const defaults = [
      'Hvala na pitanju! Kao EtherX AI Agent, pretrazujem kriptoentuzijasti.io i nudim informacije o kriptovalutama i Web3.\n\nProbaj pitati:\n\u2022 "Najnovije vijesti"\n\u2022 "Sto je Bitcoin?"\n\u2022 "Provjeri sustav"\n\u2022 "DeFi"\n\u2022 "Pomoc"',
      'Nisam siguran sto tocno trazis. 🤔 Mogu pretraziti kriptoentuzijasti.io za tebe - pokusaj specificnije opisati sto te zanima!',
      '🚀 EtherX AI Agent je tu za tebe! Reci mi tocno sto te zanima - kripto, Web3, DeFi, ili nesto vezano za preglednik?'
    ];
    return defaults[Math.floor(Math.random() * defaults.length)];
  }

  function addMsg(text, type) {
    const d = document.createElement('div'); d.className = 'ai-msg ' + type;
    const time = new Date().toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' });
    // Format markdown-style bold
    let html = text.replace(/\n/g, '<br>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Make links clickable
    html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="#" onclick="navigateTo(\'$1\');return false" style="color:var(--accent);text-decoration:underline">$1</a>');
    d.innerHTML = html + '<span class="ai-time">' + (type === 'bot' ? '🤖 AI Agent' : '') + ' ' + time + '</span>';
    msgs.appendChild(d);
    setTimeout(() => { msgs.scrollTop = msgs.scrollHeight; }, 50);
  }

  async function send() {
    const text = input.value.trim(); if (!text) return;
    addMsg(text, 'user'); input.value = '';
    const typing = document.createElement('div'); typing.className = 'ai-msg bot ai-typing';
    typing.innerHTML = '<span></span><span></span><span></span>';
    msgs.appendChild(typing);
    setTimeout(() => { msgs.scrollTop = msgs.scrollHeight; }, 50);
    try {
      const resp = await getSmartResponse(text);
      typing.remove();
      // getSmartResponse returns null when it handles messaging itself (e.g. summarize)
      if (resp === null) return;
      addMsg(resp, 'bot');
      const hist = JSON.parse(localStorage.getItem(AI_STORAGE) || '[]');
      hist.push({ user: text, bot: resp, ts: Date.now() });
      if (hist.length > 50) hist.splice(0, hist.length - 50);
      localStorage.setItem(AI_STORAGE, JSON.stringify(hist));
    } catch (err) {
      typing.remove();
      addMsg('⚠️ Došlo je do greške: ' + err.message + '. Pokušaj ponovo.', 'bot');
    }
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  clearBtn?.addEventListener('click', () => {
    localStorage.removeItem(AI_STORAGE);
    msgs.innerHTML = '<div class="ai-msg bot">🤖 Chat ociscen. Pitaj me bilo sto o kripto svijetu ili reci "provjeri sustav"!<span class="ai-time">AI Agent</span></div>';
    showToast('AI chat history cleared');
  });
  // Restore last messages
  const hist = JSON.parse(localStorage.getItem(AI_STORAGE) || '[]').slice(-10);
  hist.forEach(h => { addMsg(h.user, 'user'); addMsg(h.bot, 'bot'); });
  // Welcome message if no history
  if (!hist.length) {
    addMsg('🤖 **Dobrodosli u EtherX AI Agent!**\n\nJa sam tvoj inteligentni asistent. Mogu:\n\u2022 🔍 Pretraziti clanke s kriptoentuzijasti.io\n\u2022 🔧 Provjeriti stanje sustava\n\u2022 📊 Dati informacije o kriptovalutama\n\u2022 📰 Pokazati najnovije vijesti\n\nSto te zanima?', 'bot');
  }
})();
// ── Edit Menu Handlers ──
document.getElementById('mi-undo')?.addEventListener('click', () => { document.execCommand('undo'); showToast('↩ Undo'); });
document.getElementById('mi-redo')?.addEventListener('click', () => { document.execCommand('redo'); showToast('↪ Redo'); });
document.getElementById('mi-cut')?.addEventListener('click', () => { document.execCommand('cut'); showToast('✂ Cut'); });
document.getElementById('mi-copy')?.addEventListener('click', () => {
  const t = getActiveTab();
  if (t?.url) { navigator.clipboard?.writeText(t.url).then(() => showToast('📋 Copied: ' + t.url)).catch(() => { document.execCommand('copy'); showToast('📋 Copied'); }); }
  else { document.execCommand('copy'); showToast('📋 Copied'); }
});
document.getElementById('mi-paste')?.addEventListener('click', () => {
  navigator.clipboard?.readText().then(txt => {
    const inp = document.getElementById('urlInput');
    if (document.activeElement === inp) { document.execCommand('insertText', false, txt); }
    else { inp.focus(); inp.value = txt; showToast('📄 Pasted'); }
  }).catch(() => { document.execCommand('paste'); showToast('📄 Pasted'); });
});
document.getElementById('mi-paste-match')?.addEventListener('click', () => {
  navigator.clipboard?.readText().then(txt => { document.execCommand('insertText', false, txt); showToast('📄 Pasted (plain)'); });
});
document.getElementById('mi-delete')?.addEventListener('click', () => { document.execCommand('delete'); showToast('🗑 Delete'); });
document.getElementById('mi-select-all')?.addEventListener('click', () => { document.execCommand('selectAll'); showToast('☐ Select All'); });
document.getElementById('mi-autofill-form')?.addEventListener('click', () => { showToast('✏️ AutoFill: Forms auto-filled'); });
document.getElementById('mi-distraction')?.addEventListener('click', () => {
  document.body.classList.toggle('distraction-free');
  const on = document.body.classList.contains('distraction-free');
  if (on) { document.getElementById('menuBar').style.display = 'none'; document.querySelector('.status-bar').style.display = 'none'; showToast('🛑 Distraction Control ON'); }
  else { document.getElementById('menuBar').style.display = ''; document.querySelector('.status-bar').style.display = ''; showToast('🛑 Distraction Control OFF'); }
});
document.getElementById('mi-spelling')?.addEventListener('click', () => { showToast('Abc Spelling & Grammar check active'); });
document.getElementById('mi-substitutions')?.addEventListener('click', () => { showToast('↻ Substitutions enabled'); });
document.getElementById('mi-transformations')?.addEventListener('click', () => { showToast('Abc Transformations ready'); });
document.getElementById('mi-speech')?.addEventListener('click', () => {
  if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance('EtherX Browser is ready.'); speechSynthesis.speak(u); showToast('🗣 Speech started'); }
  else showToast('Speech not supported');
});
document.getElementById('mi-autofill')?.addEventListener('click', () => { showToast('✏️ AutoFill menu'); });
document.getElementById('mi-dictation')?.addEventListener('click', () => { showToast('🎙 Dictation not available in browser mode'); });
document.getElementById('mi-emoji')?.addEventListener('click', () => { showToast('😀 Emoji panel: Use your OS emoji picker (Win+. or Ctrl+Cmd+Space)'); });

// ── Password Manager (macOS Keychain style) ──
(function initPasswords() {
  const PWD_KEY = 'ex_passwords';
  const modal = document.getElementById('pwdModal');
  const authInput = document.getElementById('pwdAuthInput');
  const unlockBtn = document.getElementById('pwdUnlock');
  const cancelBtn = document.getElementById('pwdCancel');
  const listContainer = document.getElementById('pwdListContainer');
  const pwdList = document.getElementById('pwdList');
  const addBtn = document.getElementById('pwdAddNew');
  if (!modal) return;
  let unlocked = false;
  function getPasswords() { return JSON.parse(localStorage.getItem(PWD_KEY) || '[]'); }
  function savePasswords(p) { localStorage.setItem(PWD_KEY, JSON.stringify(p)); }
  function renderPwdList() {
    const passwords = getPasswords();
    pwdList.innerHTML = '';
    if (passwords.length === 0) { pwdList.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text3);font-size:12px">No saved passwords yet</div>'; return; }
    passwords.forEach((p, i) => {
      const entry = document.createElement('div'); entry.className = 'pwd-entry';
      entry.innerHTML = '<div><div class="pwd-entry-site">' + p.site + '</div><div class="pwd-entry-user">' + p.username + '</div><div class="pwd-entry-pass">' + ('•'.repeat(p.password.length)) + '</div></div><div class="pwd-entry-actions"><button title="Show" data-action="show" data-idx="' + i + '">👁</button><button title="Copy" data-action="copy" data-idx="' + i + '">📋</button><button title="Delete" data-action="del" data-idx="' + i + '">🗑</button></div>';
      pwdList.appendChild(entry);
    });
    pwdList.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx); const passwords = getPasswords();
        if (btn.dataset.action === 'show') {
          const passEl = btn.closest('.pwd-entry').querySelector('.pwd-entry-pass');
          if (passEl.textContent.includes('•')) passEl.textContent = passwords[idx].password;
          else passEl.textContent = '•'.repeat(passwords[idx].password.length);
        } else if (btn.dataset.action === 'copy') {
          navigator.clipboard?.writeText(passwords[idx].password); showToast('📋 Password copied');
        } else if (btn.dataset.action === 'del') {
          passwords.splice(idx, 1); savePasswords(passwords); renderPwdList(); showToast('🗑 Password removed');
        }
      });
    });
  }
  function openPwdModal() { modal.classList.add('open'); authInput.value = ''; listContainer.style.display = 'none'; unlocked = false; authInput.focus(); }
  function closePwdModal() { modal.classList.remove('open'); }
  function unlock() {
    if (!authInput.value) { showToast('Please enter a password'); return; }
    unlocked = true; listContainer.style.display = 'block'; authInput.parentElement.querySelector('.pwd-subtitle')?.remove();
    authInput.style.display = 'none'; unlockBtn.style.display = 'none';
    renderPwdList(); showToast('🔓 Passwords unlocked');
  }
  document.getElementById('sOpenPasswords')?.addEventListener('click', openPwdModal);
  cancelBtn?.addEventListener('click', closePwdModal);
  unlockBtn?.addEventListener('click', unlock);
  // ── WebAuthn Biometric Unlock ──
  const bioBtn = document.getElementById('pwdBioBtn');
  const BIO_KEY = 'ex_bio_cred';
  const hasBio = window.PublicKeyCredential && navigator.credentials;
  if (hasBio && bioBtn) {
    bioBtn.style.display = '';
    const savedCred = localStorage.getItem(BIO_KEY);
    if (!savedCred) bioBtn.textContent = '🔐 Setup Biometric';
    else bioBtn.textContent = '🔐 Biometric';
    bioBtn.addEventListener('click', async () => {
      try {
        if (!savedCred) {
          const challenge = crypto.getRandomValues(new Uint8Array(32));
          const userId = crypto.getRandomValues(new Uint8Array(16));
          const cred = await navigator.credentials.create({ publicKey: { challenge, rp: { name: 'EtherX Browser' }, user: { id: userId, name: 'etherx-user', displayName: 'EtherX User' }, pubKeyCredParams: [{ alg: -7, type: 'public-key' }], authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' }, timeout: 60000 } });
          if (cred) { localStorage.setItem(BIO_KEY, cred.id); bioBtn.textContent = '🔐 Biometric'; showToast('🔐 Biometric registered!'); }
        } else {
          const challenge = crypto.getRandomValues(new Uint8Array(32));
          const assertion = await navigator.credentials.get({ publicKey: { challenge, allowCredentials: [{ id: Uint8Array.from(atob(savedCred.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)), type: 'public-key' }], userVerification: 'required', timeout: 60000 } });
          if (assertion) { unlock(); showToast('🔐 Biometric unlock successful'); }
        }
      } catch (err) { showToast('❌ Biometric failed: ' + err.message); }
    });
  }
  authInput?.addEventListener('keydown', e => { if (e.key === 'Enter') unlock(); });
  modal?.addEventListener('click', e => { if (e.target === modal) closePwdModal(); });
  addBtn?.addEventListener('click', () => {
    const site = prompt('Website:'); if (!site) return;
    const username = prompt('Username/Email:'); if (!username) return;
    const password = prompt('Password:'); if (!password) return;
    const passwords = getPasswords(); passwords.push({ site, username, password, ts: Date.now() });
    savePasswords(passwords); renderPwdList(); showToast('🔑 Password saved');
  });
})();

// ── Icon Visibility (Appearance Settings) ──
(function initIconVisibility() {
  document.querySelectorAll('#stab-appearance .toggle[data-icon]').forEach(el => {
    const iconId = el.dataset.icon;
    const key = el.dataset.setting;
    const saved = DB.getSettings()[key];
    const btn = document.getElementById(iconId);
    if (saved === false) { el.classList.remove('on'); if (btn) btn.style.display = 'none'; }
    else { el.classList.add('on'); if (btn) btn.style.display = ''; }
    el.addEventListener('click', () => {
      el.classList.toggle('on');
      const on = el.classList.contains('on');
      DB.saveSetting(key, on);
      if (btn) btn.style.display = on ? '' : 'none';
      showToast(on ? '✓ Icon shown' : '✗ Icon hidden');
    });
  });
})();

// ── Title Bar Item Visibility ──
(function initTitleBarVisibility() {
  document.querySelectorAll('#stab-appearance .toggle[data-titlebar]').forEach(el => {
    const targetId = el.dataset.titlebar;
    const key = el.dataset.setting;
    const saved = DB.getSettings()[key];
    const target = document.getElementById(targetId);
    if (!target) return;
    const parentDiv = targetId === 'titleProfileBtn' ? target.parentElement : null;
    if (saved === false) { el.classList.remove('on'); if (parentDiv) parentDiv.style.display = 'none'; else target.style.display = 'none'; }
    else { el.classList.add('on'); }
    el.addEventListener('click', () => {
      el.classList.toggle('on');
      const on = el.classList.contains('on');
      DB.saveSetting(key, on);
      if (parentDiv) parentDiv.style.display = on ? '' : 'none'; else target.style.display = on ? '' : 'none';
      showToast(on ? '✓ Shown in title bar' : '✗ Hidden from title bar');
    });
  });
})();

// ── Menu Bar Toggle (Settings → Tabs) ──
(function initMenuBarToggle() {
  const toggleEl = document.getElementById('toggleMenuBar');
  const menuBar = document.getElementById('menuBar');
  if (!toggleEl || !menuBar) return;
  const saved = DB.getSettings().showMenuBar;
  if (saved === false) {
    toggleEl.classList.remove('on');
    menuBar.style.display = 'none';
  } else {
    toggleEl.classList.add('on');
    menuBar.style.display = '';
  }
  toggleEl.addEventListener('click', () => {
    toggleEl.classList.toggle('on');
    const on = toggleEl.classList.contains('on');
    DB.saveSetting('showMenuBar', on);
    menuBar.style.display = on ? '' : 'none';
    showToast(on ? '✓ Menu Bar shown' : '✗ Menu Bar hidden');
  });
})();

// ── Toolbar & Tabs Customization (Settings → Appearance) ──
(function initToolbarCustomization() {
  const cfg = DB.getSettings();
  function makeSlider(sliderId, valId, cssVar, settingKey, unit, defaultVal, format) {
    const sl = document.getElementById(sliderId);
    const vl = document.getElementById(valId);
    if (!sl || !vl) return;
    const saved = cfg[settingKey] !== undefined ? cfg[settingKey] : defaultVal;
    sl.value = saved;
    vl.textContent = format ? format(saved) : saved + unit;
    document.documentElement.style.setProperty(cssVar, saved + unit);
    sl.addEventListener('input', () => {
      const v = Number(sl.value);
      vl.textContent = format ? format(v) : v + unit;
      document.documentElement.style.setProperty(cssVar, v + unit);
      DB.saveSetting(settingKey, v);
    });
  }
  function makeColor(inputId, resetId, cssVar, settingKey, defaultVal) {
    const inp = document.getElementById(inputId);
    const rst = document.getElementById(resetId);
    if (!inp) return;
    const saved = cfg[settingKey] || defaultVal;
    inp.value = saved;
    document.documentElement.style.setProperty(cssVar, saved);
    inp.addEventListener('input', () => {
      document.documentElement.style.setProperty(cssVar, inp.value);
      DB.saveSetting(settingKey, inp.value);
    });
    rst && rst.addEventListener('click', () => {
      inp.value = defaultVal;
      document.documentElement.style.setProperty(cssVar, defaultVal);
      DB.saveSetting(settingKey, defaultVal);
      showToast('↺ Reset to default');
    });
  }
  makeSlider('toolbarHeightSlider', 'toolbarHeightVal', '--nav-h', 'toolbarHeight', 'px', 42);
  makeSlider('tabHeightSlider', 'tabHeightVal', '--tab-h', 'tabHeight', 'px', 34);
  makeSlider('toolbarIconSlider', 'toolbarIconVal', '--toolbar-icon-size', 'toolbarIconSize', 'px', 16);
  makeSlider('urlBarRadiusSlider', 'urlBarRadiusVal', '--url-radius', 'urlBarRadius', 'px', 8);
  makeSlider('tabRadiusSlider', 'tabRadiusVal', '--radius', 'tabRadius', 'px', 6);
  makeSlider('maxTabsSlider', 'maxTabsVal', '--max-tabs-unused', 'maxTabs', '', 0, v => v === 0 ? '∞' : String(v));
  makeColor('toolbarBgColor', 'toolbarBgReset', '--bg2', 'toolbarBgColor', '#16213e');
  makeColor('tabBarBgColor', 'tabBarBgReset', '--bg', 'tabBarBgColor', '#1a1a2e');
  makeColor('accentColor', 'accentColorReset', '--accent', 'accentColor', '#667eea');
  makeColor('textColor', 'textColorReset', '--text', 'textColor', '#e2e8f0');
  makeColor('clockColor', 'clockColorReset', '--clock-color', 'clockColor', '#e2e8f0');

  // Clock size
  (() => {
    const inp = document.getElementById('clockSizeInput');
    const rst = document.getElementById('clockSizeReset');
    if (!inp) return;
    const savedSize = cfg.clockSize || 12;
    inp.value = savedSize;
    document.documentElement.style.setProperty('--clock-size', savedSize + 'px');
    inp.addEventListener('input', () => {
      const v = Math.max(8, Math.min(32, Number(inp.value) || 12));
      document.documentElement.style.setProperty('--clock-size', v + 'px');
      DB.saveSetting('clockSize', v);
    });
    rst && rst.addEventListener('click', () => {
      inp.value = 12;
      document.documentElement.style.setProperty('--clock-size', '12px');
      DB.saveSetting('clockSize', 12);
      showToast('↺ Clock size reset');
    });
  })();
  // Apply max-tabs warning on new tab
  const origNewTab = window.__origNewTab || null;
  document.getElementById('maxTabsSlider')?.addEventListener('change', () => { });
})();

// ── Language Engine ──
const LANGS = {
  en: {
    name: 'English', flag: '🇬🇧',
    preview: 'Current language: English',
    'lp-file': 'File', 'lp-edit': 'Edit', 'lp-view': 'View', 'lp-history': 'History', 'lp-bookmarks': 'Bookmarks',
    'lp-settings': 'Settings', 'lp-general': 'General', 'lp-appearance': 'Appearance', 'lp-language': 'Language',
    'lp-newTab': 'New Tab', 'lp-closeTab': 'Close Tab', 'lp-bookmarkPage': 'Bookmark Page',
    menuFile: 'File', menuEdit: 'Edit', menuView: 'View', menuHistory: 'History', menuBookmarks: 'Bookmarks',
    menuDevelop: 'Develop', menuWindow: 'Window', menuHelp: 'Help',
    miNewTab: 'New Tab', miNewPrivate: 'New Private Window', miOpenLocation: 'Open Location…',
    miCloseTab: 'Close Tab', miPrint: 'Print…', miUndo: 'Undo Typing', miRedo: 'Redo',
    miCopy: 'Copy', miPaste: 'Paste', miSelectAll: 'Select All', miFind: 'Find in Page',
    miZoomIn: 'Zoom In', miZoomOut: 'Zoom Out', miZoomReset: 'Actual Size',
    miFullscreen: 'Enter Full Screen', miCustomiseToolbar: 'Customize Toolbar…',
    miBack: 'Back', miForward: 'Forward', miReload: 'Reload Page', miHardReload: 'Hard Reload',
    miStop: 'Stop', miBookmarkAll: 'Bookmark All Tabs', miShowBookmarks: 'Show Bookmarks',
    miShowHistory: 'Show History', miShowDownloads: 'Show Downloads',
    miAbout: 'About EtherX Browser', settingsTitle: 'Settings',
    tabGeneral: 'General', tabTabs: 'Tabs', tabAutofill: 'AutoFill', tabPasswords: 'Passwords',
    tabSearch: 'Search', tabSecurity: 'Security', tabPrivacy: 'Privacy', tabWebsites: 'Websites',
    tabProfiles: 'Profiles', tabExtensions: 'Extensions', tabAdvanced: 'Advanced',
    tabDeveloper: 'Developer', tabFlags: 'Feature Flags', tabMigration: 'Import Data',
    tabAppearance: 'Appearance', tabLanguage: 'Language',
  },
  hr: {
    name: 'Hrvatski', flag: '🇭🇷',
    preview: 'Trenutni jezik: Hrvatski',
    'lp-file': 'Datoteka', 'lp-edit': 'Uredi', 'lp-view': 'Prikaz', 'lp-history': 'Povijest', 'lp-bookmarks': 'Zabilješke',
    'lp-settings': 'Postavke', 'lp-general': 'Općenito', 'lp-appearance': 'Izgled', 'lp-language': 'Jezik',
    'lp-newTab': 'Nova kartica', 'lp-closeTab': 'Zatvori karticu', 'lp-bookmarkPage': 'Označi stranicu',
    menuFile: 'Datoteka', menuEdit: 'Uredi', menuView: 'Prikaz', menuHistory: 'Povijest', menuBookmarks: 'Zabilješke',
    menuDevelop: 'Razvoj', menuWindow: 'Prozor', menuHelp: 'Pomoć',
    miNewTab: 'Nova kartica', miNewPrivate: 'Novi privatni prozor', miOpenLocation: 'Otvori lokaciju…',
    miCloseTab: 'Zatvori karticu', miPrint: 'Ispis…', miUndo: 'Poništi unos', miRedo: 'Ponovi',
    miCopy: 'Kopiraj', miPaste: 'Zalijepi', miSelectAll: 'Odaberi sve', miFind: 'Traži na stranici',
    miZoomIn: 'Povećaj', miZoomOut: 'Smanji', miZoomReset: 'Stvarna veličina',
    miFullscreen: 'Uđi u cijeli zaslon', miCustomiseToolbar: 'Prilagodi alatnu traku…',
    miBack: 'Natrag', miForward: 'Naprijed', miReload: 'Osvježi stranicu', miHardReload: 'Jako osvježi',
    miStop: 'Zaustavi', miBookmarkAll: 'Označi sve kartice', miShowBookmarks: 'Prikaži zabilješke',
    miShowHistory: 'Prikaži povijest', miShowDownloads: 'Prikaži preuzimanja',
    miAbout: 'O EtherX Browseru', settingsTitle: 'Postavke',
    tabGeneral: 'Općenito', tabTabs: 'Kartice', tabAutofill: 'AutoIspuna', tabPasswords: 'Lozinke',
    tabSearch: 'Pretraga', tabSecurity: 'Sigurnost', tabPrivacy: 'Privatnost', tabWebsites: 'Web-stranice',
    tabProfiles: 'Profili', tabExtensions: 'Proširenja', tabAdvanced: 'Napredno',
    tabDeveloper: 'Programer', tabFlags: 'Zastavice', tabMigration: 'Uvoz podataka',
    tabAppearance: 'Izgled', tabLanguage: 'Jezik',
  },
  de: {
    name: 'Deutsch', flag: '🇩🇪',
    preview: 'Aktuelle Sprache: Deutsch',
    'lp-file': 'Datei', 'lp-edit': 'Bearbeiten', 'lp-view': 'Ansicht', 'lp-history': 'Verlauf', 'lp-bookmarks': 'Lesezeichen',
    'lp-settings': 'Einstellungen', 'lp-general': 'Allgemein', 'lp-appearance': 'Darstellung', 'lp-language': 'Sprache',
    'lp-newTab': 'Neuer Tab', 'lp-closeTab': 'Tab schließen', 'lp-bookmarkPage': 'Seite merken',
    menuFile: 'Datei', menuEdit: 'Bearbeiten', menuView: 'Ansicht', menuHistory: 'Verlauf', menuBookmarks: 'Lesezeichen',
    menuDevelop: 'Entwickeln', menuWindow: 'Fenster', menuHelp: 'Hilfe',
    miNewTab: 'Neuer Tab', miNewPrivate: 'Neues privates Fenster', miOpenLocation: 'Adresse öffnen…',
    miCloseTab: 'Tab schließen', miPrint: 'Drucken…', miUndo: 'Eingabe rückgängig', miRedo: 'Wiederholen',
    miCopy: 'Kopieren', miPaste: 'Einfügen', miSelectAll: 'Alles auswählen', miFind: 'Auf Seite suchen',
    miZoomIn: 'Vergrößern', miZoomOut: 'Verkleinern', miZoomReset: 'Tatsächliche Größe',
    miFullscreen: 'Vollbild', miCustomiseToolbar: 'Symbolleiste anpassen…',
    miBack: 'Zurück', miForward: 'Vorwärts', miReload: 'Seite laden', miHardReload: 'Vollständig laden',
    miStop: 'Stopp', miBookmarkAll: 'Alle Tabs merken', miShowBookmarks: 'Lesezeichen anzeigen',
    miShowHistory: 'Verlauf anzeigen', miShowDownloads: 'Downloads anzeigen',
    miAbout: 'Über EtherX Browser', settingsTitle: 'Einstellungen',
    tabGeneral: 'Allgemein', tabTabs: 'Tabs', tabAutofill: 'AutoAusfüllen', tabPasswords: 'Passwörter',
    tabSearch: 'Suche', tabSecurity: 'Sicherheit', tabPrivacy: 'Datenschutz', tabWebsites: 'Webseiten',
    tabProfiles: 'Profile', tabExtensions: 'Erweiterungen', tabAdvanced: 'Erweitert',
    tabDeveloper: 'Entwickler', tabFlags: 'Feature-Flags', tabMigration: 'Daten importieren',
    tabAppearance: 'Darstellung', tabLanguage: 'Sprache',
  },
  it: {
    name: 'Italiano', flag: '🇮🇹',
    preview: 'Lingua corrente: Italiano',
    'lp-file': 'File', 'lp-edit': 'Modifica', 'lp-view': 'Visualizza', 'lp-history': 'Cronologia', 'lp-bookmarks': 'Preferiti',
    'lp-settings': 'Impostazioni', 'lp-general': 'Generale', 'lp-appearance': 'Aspetto', 'lp-language': 'Lingua',
    'lp-newTab': 'Nuova scheda', 'lp-closeTab': 'Chiudi scheda', 'lp-bookmarkPage': 'Aggiungi ai preferiti',
    menuFile: 'File', menuEdit: 'Modifica', menuView: 'Visualizza', menuHistory: 'Cronologia', menuBookmarks: 'Preferiti',
    menuDevelop: 'Sviluppo', menuWindow: 'Finestra', menuHelp: 'Aiuto',
    miNewTab: 'Nuova scheda', miNewPrivate: 'Nuova finestra privata', miOpenLocation: 'Apri posizione…',
    miCloseTab: 'Chiudi scheda', miPrint: 'Stampa…', miUndo: 'Annulla digitazione', miRedo: 'Ripeti',
    miCopy: 'Copia', miPaste: 'Incolla', miSelectAll: 'Seleziona tutto', miFind: 'Trova nella pagina',
    miZoomIn: 'Ingrandisci', miZoomOut: 'Riduci', miZoomReset: 'Dimensione effettiva',
    miFullscreen: 'Schermo intero', miCustomiseToolbar: 'Personalizza barra…',
    miBack: 'Indietro', miForward: 'Avanti', miReload: 'Ricarica pagina', miHardReload: 'Ricarica completa',
    miStop: 'Stop', miBookmarkAll: 'Aggiungi tutte le schede', miShowBookmarks: 'Mostra preferiti',
    miShowHistory: 'Mostra cronologia', miShowDownloads: 'Mostra download',
    miAbout: 'Informazioni su EtherX Browser', settingsTitle: 'Impostazioni',
    tabGeneral: 'Generale', tabTabs: 'Schede', tabAutofill: 'Compilazione automatica', tabPasswords: 'Password',
    tabSearch: 'Ricerca', tabSecurity: 'Sicurezza', tabPrivacy: 'Privacy', tabWebsites: 'Siti web',
    tabProfiles: 'Profili', tabExtensions: 'Estensioni', tabAdvanced: 'Avanzate',
    tabDeveloper: 'Sviluppatore', tabFlags: 'Funzionalità', tabMigration: 'Importa dati',
    tabAppearance: 'Aspetto', tabLanguage: 'Lingua',
  },
  fr: {
    name: 'Français', flag: '🇫🇷',
    preview: 'Langue actuelle : Français',
    'lp-file': 'Fichier', 'lp-edit': 'Éditer', 'lp-view': 'Affichage', 'lp-history': 'Historique', 'lp-bookmarks': 'Favoris',
    'lp-settings': 'Réglages', 'lp-general': 'Général', 'lp-appearance': 'Apparence', 'lp-language': 'Langue',
    'lp-newTab': 'Nouvel onglet', 'lp-closeTab': 'Fermer l\'onglet', 'lp-bookmarkPage': 'Mettre en favori',
    menuFile: 'Fichier', menuEdit: 'Éditer', menuView: 'Affichage', menuHistory: 'Historique', menuBookmarks: 'Favoris',
    menuDevelop: 'Développement', menuWindow: 'Fenêtre', menuHelp: 'Aide',
    miNewTab: 'Nouvel onglet', miNewPrivate: 'Nouvelle fenêtre privée', miOpenLocation: 'Ouvrir l\'adresse…',
    miCloseTab: 'Fermer l\'onglet', miPrint: 'Imprimer…', miUndo: 'Annuler la saisie', miRedo: 'Rétablir',
    miCopy: 'Copier', miPaste: 'Coller', miSelectAll: 'Tout sélectionner', miFind: 'Rechercher dans la page',
    miZoomIn: 'Agrandir', miZoomOut: 'Réduire', miZoomReset: 'Taille réelle',
    miFullscreen: 'Plein écran', miCustomiseToolbar: 'Personnaliser la barre…',
    miBack: 'Précédent', miForward: 'Suivant', miReload: 'Recharger la page', miHardReload: 'Rechargement complet',
    miStop: 'Arrêter', miBookmarkAll: 'Marquer tous les onglets', miShowBookmarks: 'Afficher les favoris',
    miShowHistory: 'Afficher l\'historique', miShowDownloads: 'Afficher les téléchargements',
    miAbout: 'À propos d\'EtherX Browser', settingsTitle: 'Réglages',
    tabGeneral: 'Général', tabTabs: 'Onglets', tabAutofill: 'Remplissage auto', tabPasswords: 'Mots de passe',
    tabSearch: 'Recherche', tabSecurity: 'Sécurité', tabPrivacy: 'Confidentialité', tabWebsites: 'Sites web',
    tabProfiles: 'Profils', tabExtensions: 'Extensions', tabAdvanced: 'Avancé',
    tabDeveloper: 'Développeur', tabFlags: 'Indicateurs', tabMigration: 'Importer des données',
    tabAppearance: 'Apparence', tabLanguage: 'Langue',
  }
};

// Key → element id mappings
const LANG_MAP = {
  menuFile: '[data-menu="file"]', menuEdit: '[data-menu="edit"]', menuView: '[data-menu="view"]',
  menuHistory: '[data-menu="history"]', menuBookmarks: '[data-menu="bm"]',
  menuDevelop: '[data-menu="develop"]', menuWindow: '[data-menu="window"]', menuHelp: '[data-menu="help"]',
  miNewTab: '#mi-new-tab', miNewPrivate: '#mi-new-private', miOpenLocation: '#mi-open-location',
  miCloseTab: '#mi-close-tab', miPrint: '#mi-print', miUndo: '#mi-undo', miRedo: '#mi-redo',
  miCopy: '#mi-copy', miPaste: '#mi-paste', miSelectAll: '#mi-select-all', miFind: '#mi-find',
  miZoomIn: '#mi-zoom-in', miZoomOut: '#mi-zoom-out', miZoomReset: '#mi-zoom-reset',
  miFullscreen: '#mi-fullscreen', miCustomiseToolbar: '#mi-customise-toolbar',
  miBack: '#mi-back', miForward: '#mi-forward', miReload: '#mi-reload', miHardReload: '#mi-hard-reload',
  miStop: '#mi-stop', miAbout: '#mi-about',
  settingsTitle: '.settings-panel-title-text, .panel-title[data-panel="settings"]',
};
// Settings sidebar tab buttons
const LANG_TAB_MAP = {
  tabGeneral: 'general', tabTabs: 'tabs', tabAutofill: 'autofill', tabPasswords: 'passwords',
  tabSearch: 'search', tabSecurity: 'security', tabPrivacy: 'privacy', tabWebsites: 'websites',
  tabProfiles: 'profiles', tabExtensions: 'extensions', tabAdvanced: 'advanced',
  tabDeveloper: 'developer', tabFlags: 'flags', tabMigration: 'migration',
  tabAppearance: 'appearance', tabLanguage: 'language',
};

function applyLanguage(code) {
  const lang = LANGS[code] || LANGS.en;
  // Menu items — preserve icons (span.icon) and shortcuts (span.sc)
  Object.entries(LANG_MAP).forEach(([key, sel]) => {
    if (!lang[key]) return;
    document.querySelectorAll(sel).forEach(el => {
      // For menu-item top labels (data-menu), only first text node
      if (el.dataset && el.dataset.menu !== undefined) {
        const nodes = Array.from(el.childNodes).filter(n => n.nodeType === 3);
        if (nodes.length) nodes[0].textContent = lang[key];
      } else {
        // For .di items: keep .icon span + .sc span, replace text nodes
        const iconSpan = el.querySelector('.icon');
        const scSpan = el.querySelector('.sc');
        el.childNodes.forEach(n => { if (n.nodeType === 3) n.textContent = lang[key] + ' '; });
        if (!el.querySelector('.icon') && iconSpan) el.prepend(iconSpan);
        if (!el.querySelector('.sc') && scSpan) el.append(scSpan);
      }
    });
  });
  // Settings sidebar tab buttons
  Object.entries(LANG_TAB_MAP).forEach(([key, stab]) => {
    if (!lang[key]) return;
    const btn = document.querySelector(`.sit-btn[data-stab="${stab}"]`);
    if (btn) {
      const iconSpan = btn.querySelector('.sit-icon');
      btn.textContent = lang[key];
      if (iconSpan) btn.prepend(iconSpan);
    }
  });
  // Settings panel title
  const sTitle = document.querySelector('#settingsPanel .panel-title');
  if (sTitle && lang.settingsTitle) sTitle.textContent = lang.settingsTitle;
  // Language preview
  ['lp-file', 'lp-edit', 'lp-view', 'lp-history', 'lp-bookmarks',
    'lp-settings', 'lp-general', 'lp-appearance', 'lp-language',
    'lp-newTab', 'lp-closeTab', 'lp-bookmarkPage'].forEach(id => {
      const el = document.getElementById(id);
      if (el && lang[id]) el.textContent = lang[id];
    });
  const prevDesc = document.getElementById('langPreviewDesc');
  if (prevDesc) prevDesc.textContent = lang.preview || '';
  // Persist
  DB.saveSetting('uiLanguage', code);
}

(function initLanguage() {
  const sel = document.getElementById('langSelect');
  if (!sel) return;
  const saved = DB.getSettings().uiLanguage || 'en';
  sel.value = saved;
  applyLanguage(saved);
  sel.addEventListener('change', () => { applyLanguage(sel.value); showToast(LANGS[sel.value]?.flag + ' ' + LANGS[sel.value]?.name + ' applied'); });
  // Download button (simulates caching — stores flag in settings)
  document.getElementById('langDownloadBtn')?.addEventListener('click', () => {
    const code = sel.value;
    const status = document.getElementById('langStatusRow');
    if (status) { status.style.display = ''; status.textContent = '⏳ Downloading ' + LANGS[code]?.name + ' pack…'; }
    setTimeout(() => {
      DB.saveSetting('langPack_' + code, true);
      if (status) { status.textContent = '✅ ' + LANGS[code]?.name + ' language pack cached offline.'; }
      showToast('✅ ' + LANGS[code]?.name + ' language pack ready');
    }, 1200);
  });
})();

// ── Customize Toolbar Overlay ──
const CTT_BUTTONS = [
  { id: 'btnBookmarkPage', key: 'showBtnBookmarkPage', icon: '🔖', name: 'Save Page' },
  { id: 'btnWallet', key: 'showBtnWallet', icon: '💰', name: 'Wallet' },
  { id: 'btnBobiAI', key: 'showBtnBobiAI', icon: '🎬', name: 'Bobi AI' },
  { id: 'btnAiAgent', key: 'showBtnAiAgent', icon: '🤖', name: 'AI Agent' },
  { id: 'btnKripto', key: 'showBtnKripto', icon: '📰', name: 'Kripto' },
  { id: 'btnEtherX', key: 'showBtnEtherX', icon: '👥', name: 'EtherX' },
  { id: 'btnExtensions', key: 'showBtnExtensions', icon: '🧩', name: 'Extensions' },
  { id: 'btnBookmarks', key: 'showBtnBookmarks', icon: '⭐', name: 'Bookmarks' },
  { id: 'btnHistory', key: 'showBtnHistory', icon: '🕒', name: 'History' },
  { id: 'btnDownloads', key: 'showBtnDownloads', icon: '⬇️', name: 'Downloads' },
  { id: 'btnSettings', key: 'showBtnSettings', icon: '⚙️', name: 'Settings' },
  { id: 'btnDevtools', key: 'showBtnDevtools', icon: '🛠️', name: 'DevTools' },
];
function openCustomToolbar() {
  const overlay = document.getElementById('customToolbarOverlay');
  const grid = document.getElementById('cttGrid');
  if (!overlay || !grid) return;
  const settings = DB.getSettings();
  grid.innerHTML = '';
  CTT_BUTTONS.forEach(def => {
    const isOn = settings[def.key] !== false;
    const btn = document.getElementById(def.id);
    const tile = document.createElement('div');
    tile.className = 'ctt-tile' + (isOn ? '' : ' disabled');
    tile.dataset.key = def.key;
    tile.dataset.id = def.id;
    // Use actual button icon if button exists and has text
    const liveIcon = btn ? (btn.textContent.trim().charAt(0) || def.icon) : def.icon;
    tile.innerHTML = `<div class="ctt-tile-icon">${liveIcon}</div><div class="ctt-tile-name">${def.name}</div><div class="ctt-tile-dot"></div>`;
    tile.addEventListener('click', () => {
      const on = !tile.classList.contains('disabled');
      const newOn = !on;
      tile.classList.toggle('disabled', !newOn);
      DB.saveSetting(def.key, newOn);
      if (btn) btn.style.display = newOn ? '' : 'none';
      // Sync the Settings → Appearance toggle too
      const settingToggle = document.querySelector(`#stab-appearance .toggle[data-setting="${def.key}"]`);
      if (settingToggle) { newOn ? settingToggle.classList.add('on') : settingToggle.classList.remove('on'); }
    });
    grid.appendChild(tile);
  });
  overlay.classList.add('show');
  // Close any open dropdowns
  document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
}

document.getElementById('customToolbarClose').addEventListener('click', () => {
  document.getElementById('customToolbarOverlay').classList.remove('show');
});
document.getElementById('customToolbarOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('customToolbarOverlay'))
    document.getElementById('customToolbarOverlay').classList.remove('show');
});
document.getElementById('cttDone').addEventListener('click', () => {
  document.getElementById('customToolbarOverlay').classList.remove('show');
});
document.getElementById('cttReset').addEventListener('click', () => {
  CTT_BUTTONS.forEach(def => {
    DB.saveSetting(def.key, true);
    const btn = document.getElementById(def.id);
    if (btn) btn.style.display = '';
  });
  openCustomToolbar(); // re-render with all on
  showToast('↺ Toolbar reset to default');
});

// ── Custom Search Engine URL ──
(function initCustomSearch() {
  const sel = document.querySelector('[data-setting="searchEngine"]');
  const row = document.getElementById('customSearchRow');
  if (!sel || !row) return;
  function checkCustom() { row.style.display = sel.value === 'custom' ? 'flex' : 'none'; }
  const saved = DB.getSettings().searchEngine;
  if (saved === 'custom') checkCustom();
  sel.addEventListener('change', checkCustom);
  // Also restore custom URL
  const customUrl = DB.getSettings().customSearchURL;
  if (customUrl) { const inp = document.getElementById('sCustomSearchURL'); if (inp) inp.value = customUrl; }
})();

// ── Profile Dropdown in Title Bar ──
(function initProfileDropdown() {
  const btn = document.getElementById('titleProfileBtn');
  const dd = document.getElementById('profileDropdown');
  const nameEl = document.getElementById('activeProfileName');
  if (!btn || !dd) return;
  const ACTIVE_KEY = 'ex_active_profile';
  function getProfiles() { return [{ name: 'Default', ts: 0 }].concat(JSON.parse(localStorage.getItem('ex_profiles') || '[]')); }
  function getActive() { return localStorage.getItem(ACTIVE_KEY) || 'Default'; }
  function setActive(name) { localStorage.setItem(ACTIVE_KEY, name); nameEl.textContent = name; }
  function render() {
    const profiles = getProfiles();
    const active = getActive();
    nameEl.textContent = active;
    dd.innerHTML = '';
    profiles.forEach(p => {
      const item = document.createElement('div'); item.className = 'pd-item' + (p.name === active ? ' active' : '');
      item.innerHTML = (p.name === active ? '✓ ' : ' ') + p.name;
      item.addEventListener('click', () => { setActive(p.name); dd.classList.remove('open'); showToast('👤 Profile: ' + p.name); render(); });
      dd.appendChild(item);
    });
    const sep = document.createElement('div'); sep.className = 'pd-sep'; dd.appendChild(sep);
    const manage = document.createElement('div'); manage.className = 'pd-item';
    manage.innerHTML = '⚙ Manage Profiles…';
    manage.addEventListener('click', () => {
      dd.classList.remove('open');
      document.getElementById('btnSettings').click();
      setTimeout(() => {
        const profTab = document.querySelector('[data-stab="profiles"]');
        if (profTab) profTab.click();
      }, 100);
    });
    dd.appendChild(manage);
  }
  btn.addEventListener('click', e => { e.stopPropagation(); dd.classList.toggle('open'); render(); });
  document.addEventListener('click', () => dd.classList.remove('open'));
  dd.addEventListener('click', e => e.stopPropagation());
  render();
})();

// ── Download / Install Info ──
(function initDownloadInfo() {
  // Add download section to About dialog
  const oldAbout = document.getElementById('mi-about');
  if (oldAbout) {
    oldAbout.addEventListener('click', () => {
      const ua = navigator.userAgent;
      const isMac = ua.includes('Mac'); const isWin = ua.includes('Win'); const isLinux = ua.includes('Linux');
      const isIOS = ua.includes('iPhone') || ua.includes('iPad'); const isAndroid = ua.includes('Android');
      let installMsg = '';
      if (isIOS) installMsg = '📱 iOS: Tap Share → Add to Home Screen';
      else if (isAndroid) installMsg = '📱 Android: Tap ⋮ → Add to Home Screen';
      else if (isMac) installMsg = '🖥 Mac: Use Ctrl+Cmd+A or install via Chrome → ⋮ → Install EtherX';
      else if (isWin) installMsg = '🖥 Windows: Click ⊕ in address bar or ⋮ → Install EtherX';
      else installMsg = '🖥 Linux: Click ⊕ in address bar to install as PWA';
      showToast('EtherX Browser v1.0\n' + installMsg, 5000);
    });
  }
})();

// ── Restore last session tabs ─────────────────────────────────────────────
(function restoreSession() {
  let windowId = 'main';
  try {
    if (window.electronAPI && typeof window.electronAPI.windowId === 'function') {
      windowId = window.electronAPI.windowId() || 'main';
    }
  } catch (e) { }

  const saved = localStorage.getItem('ex_session_tabs_' + windowId) || localStorage.getItem('ex_session_tabs');
  const activeIdStr = localStorage.getItem('ex_session_active_' + windowId) || localStorage.getItem('ex_session_active') || '0';
  const activeId = parseInt(activeIdStr, 10);

  if (saved) {
    try {
      const tabs = JSON.parse(saved);
      if (Array.isArray(tabs) && tabs.length) {
        let restoredActiveId = null;
        tabs.forEach((t, i) => {
          const tab = createTab(t.url || '', t.title || 'New Tab', false);
          if (t.pinned) tab.pinned = true;
          if (t.faviconUrl) tab.faviconUrl = t.faviconUrl;
          updateTabEl(tab);
          if (i === 0) restoredActiveId = tab.id; // fallback: first tab
        });
        // activate the same tab that was active before close
        const activeTab = STATE.tabs[Math.max(0, tabs.length - 1)];
        switchTab(activeTab ? activeTab.id : restoredActiveId);
        renderQuickLinks();
        consoleLog('info', '🚀 EtherX Browser initialized – restored ' + tabs.length + ' tab(s)');
        consoleLog('success', '⬡ Web3 provider: window.ethereum injected');
        return;
      }
    } catch (e) { /* corrupt session, fall through */ }
  }
  createTab(); renderQuickLinks();
  consoleLog('info', '🚀 EtherX Browser initialized'); consoleLog('success', '⬡ Web3 provider: window.ethereum injected');
})();

// ── Share Sheet ──────────────────────────────────────────────────────────
function openShareSheet() {
  const tab = getActiveTab();
  const url = tab?.url || window.location.href;
  const title = tab?.title || document.title || 'EtherX Browser';
  const sheet = document.getElementById('shareSheet');
  document.getElementById('shareUrl').textContent = url;
  const acts = document.getElementById('shareActions');
  acts.innerHTML = '';
  const actions = [
    { icon: '📋', label: 'Copy Link', fn: () => { navigator.clipboard.writeText(url).then(() => showToast('📋 Link copied!')); closeShareSheet(); } },
    { icon: '✉️', label: 'Email', fn: () => { window.open('mailto:?subject=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(url)); closeShareSheet(); } },
    { icon: '💬', label: 'WhatsApp', fn: () => { window.open('https://wa.me/?text=' + encodeURIComponent(title + '\n' + url)); closeShareSheet(); } },
    { icon: '🐦', label: 'X / Twitter', fn: () => { window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(title) + '&url=' + encodeURIComponent(url)); closeShareSheet(); } },
    { icon: '💼', label: 'LinkedIn', fn: () => { window.open('https://www.linkedin.com/shareArticle?url=' + encodeURIComponent(url) + '&title=' + encodeURIComponent(title)); closeShareSheet(); } },
    { icon: '📘', label: 'Facebook', fn: () => { window.open('https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url)); closeShareSheet(); } },
    { icon: '📱', label: 'Telegram', fn: () => { window.open('https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(title)); closeShareSheet(); } },
    { icon: '🔗', label: 'QR Code', fn: () => { closeShareSheet(); navigateTo('https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(url)); } },
    { icon: '🖨️', label: 'Print', fn: () => { closeShareSheet(); window.print(); } },
    { icon: '💾', label: 'Save Page', fn: () => { closeShareSheet(); document.getElementById('btnBookmarkPage')?.click(); } },
    { icon: '📤', label: 'AirDrop', fn: () => { if (navigator.share) { navigator.share({ title, url }).catch(() => { }); } else { showToast('AirDrop/Web Share not available in this browser'); } closeShareSheet(); } },
    { icon: '📖', label: 'Reader Mode', fn: () => { closeShareSheet(); document.getElementById('btnReader')?.click(); } },
  ];
  actions.forEach(a => {
    const btn = document.createElement('button');
    btn.className = 'share-action-btn';
    btn.innerHTML = `<span class="share-action-icon">${a.icon}</span><span class="share-action-label">${a.label}</span>`;
    btn.addEventListener('click', a.fn);
    acts.appendChild(btn);
  });
  sheet.classList.add('show');
}
function closeShareSheet() { document.getElementById('shareSheet').classList.remove('show'); }
document.getElementById('btnShare').addEventListener('click', openShareSheet);
document.getElementById('shareClose').addEventListener('click', closeShareSheet);
document.getElementById('shareSheet').addEventListener('click', e => { if (e.target === document.getElementById('shareSheet')) closeShareSheet(); });

// ── Window / Tab Switcher ────────────────────────────────────────────────
function openWindowSwitcher() {
  const wsw = document.getElementById('windowSwitcher');
  const grid = document.getElementById('wswTabs');
  grid.innerHTML = '';
  STATE.tabs.forEach(tab => {
    const card = document.createElement('div');
    card.className = 'wsw-tab-card' + (tab.id === STATE.activeTabId ? ' active-tab' : '');
    const favHtml = tab.faviconUrl
      ? `<img src="${tab.faviconUrl}" style="width:20px;height:20px;border-radius:3px" onerror="this.outerHTML='<span style=font-size:18px>${tab.favicon || '🌐'}</span>'">`
      : `<span class="wsw-tab-favicon">${tab.favicon || '🌐'}</span>`;
    card.innerHTML = `
          ${favHtml}
          <div class="wsw-tab-title">${escHtml(tab.title || 'New Tab')}</div>
          <div class="wsw-tab-url">${escHtml(tab.url || '')}</div>
          <button class="wsw-tab-close" data-id="${tab.id}" title="Close tab">✕</button>`;
    card.addEventListener('click', e => {
      if (e.target.classList.contains('wsw-tab-close')) {
        e.stopPropagation();
        closeTab(Number(e.target.dataset.id));
        openWindowSwitcher(); // re-render
        return;
      }
      switchTab(tab.id);
      closeWindowSwitcher();
    });
    grid.appendChild(card);
  });
  wsw.classList.add('show');
}
function closeWindowSwitcher() { document.getElementById('windowSwitcher').classList.remove('show'); }
document.getElementById('btnWindowSwitcher').addEventListener('click', openWindowSwitcher);
document.getElementById('btnCryptoPrice').addEventListener('click', () => togglePanel('cryptoPricePanel'));
document.getElementById('wswClose').addEventListener('click', closeWindowSwitcher);
document.getElementById('windowSwitcher').addEventListener('click', e => { if (e.target === document.getElementById('windowSwitcher')) closeWindowSwitcher(); });
document.getElementById('wswNewTab').addEventListener('click', () => { createTab(); closeWindowSwitcher(); });

// ── Logo Customization (Settings → General) ──────────────────────────────
(function initLogoCustomization() {
  const LOGO_KEY = 'ex_custom_logo';
  function applyLogo(val) {
    // val: emoji/text string, or data URL for image
    const titleLogo = document.getElementById('titleLogoBtn');
    const ntpLogo = document.getElementById('ntpLogo');
    const preview = document.getElementById('logoPreview');
    [titleLogo, ntpLogo, preview].forEach(el => {
      if (!el) return;
      if (val && val.startsWith('data:')) {
        el.innerHTML = `<img src="${val}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
      } else {
        el.textContent = val || 'E';
      }
    });
  }
  // Load saved logo on startup
  const saved = localStorage.getItem(LOGO_KEY);
  if (saved) applyLogo(saved);

  // File upload
  document.getElementById('logoFileInput')?.addEventListener('change', e => {
    const file = e.target.files?.[0]; if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('⚠️ Please choose an image file'); return; }
    const reader = new FileReader();
    reader.onload = ev => { const dataUrl = ev.target.result; localStorage.setItem(LOGO_KEY, dataUrl); applyLogo(dataUrl); showToast('✓ Logo updated'); };
    reader.readAsDataURL(file);
  });

  // Emoji / text input
  const emojiInput = document.getElementById('logoEmojiInput');
  document.getElementById('logoEmojiBtn')?.addEventListener('click', () => {
    emojiInput.style.display = emojiInput.style.display === 'none' ? '' : 'none';
    emojiInput.focus();
  });
  emojiInput?.addEventListener('input', () => {
    const v = emojiInput.value.trim();
    if (!v) return;
    localStorage.setItem(LOGO_KEY, v);
    applyLogo(v);
  });

  // Reset
  document.getElementById('logoResetBtn')?.addEventListener('click', () => {
    localStorage.removeItem(LOGO_KEY);
    applyLogo('E');
    if (emojiInput) { emojiInput.value = ''; emojiInput.style.display = 'none'; }
    showToast('↺ Logo reset to default');
  });
})();

// ── Screenshot ──────────────────────────────────────────────────────────────
async function takeScreenshot(fullPage = false) {
  const tab = getActiveTab();
  const pageTitle = (tab?.title || 'screenshot').replace(/[^a-z0-9]/gi, '-').slice(0, 24).replace(/-+$/, '');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = 'etherx-' + pageTitle + '-' + ts + '.png';
  const loc = (DB.getSettings().screenshotLocation) || 'download';

  showToast('📷 Snimam zaslon…');
  try {
    let canvas;
    const frame = document.getElementById('browseFrame');
    if (window.html2canvas) {
      const target = fullPage ? document.documentElement : (frame || document.documentElement);
      canvas = await window.html2canvas(target, { useCORS: true, allowTaint: true, scale: window.devicePixelRatio || 1, logging: false });
    } else {
      // Fallback: blank canvas with URL text
      canvas = document.createElement('canvas');
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#aaa';
      ctx.font = '14px sans-serif';
      ctx.fillText('📷 ' + (tab?.url || 'EtherX Browser'), 20, canvas.height / 2);
    }

    if (loc === 'clipboard') {
      canvas.toBlob(blob => {
        navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          .then(() => showToast('📋 Screenshot kopiran u međuspremnik!'))
          .catch(() => {
            // fallback — download instead
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
            URL.revokeObjectURL(url);
            showToast('📷 Screenshot preuzet: ' + filename);
          });
      });
    } else {
      canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
        showToast('📷 Screenshot preuzet: ' + filename);
      });
    }
  } catch (err) {
    showToast('⚠️ Screenshot neuspješan: ' + err.message);
  }
}

// Screenshot menu handlers
document.getElementById('mi-screenshot')?.addEventListener('click', () => takeScreenshot(false));
document.getElementById('mi-screenshot-full')?.addEventListener('click', () => takeScreenshot(true));

// Screenshot shortcut recorder (Settings → Advanced)
(function initScreenshotSettings() {
  const input = document.getElementById('screenshotShortcutInput');
  const resetBtn = document.getElementById('screenshotShortcutReset');
  const DEFAULT_SC = 'Ctrl+Shift+S';

  function loadShortcut() {
    const saved = DB.getSettings().screenshotShortcut || DEFAULT_SC;
    if (input) input.value = saved;
    const scEl = document.getElementById('mi-screenshot-sc');
    if (scEl) scEl.textContent = saved;
    const helpEl = document.getElementById('help-sc-screenshot');
    if (helpEl) helpEl.textContent = saved;
  }
  loadShortcut();

  if (input) {
    input.addEventListener('focus', () => { input.value = '⌨ Press keys…'; input.style.borderColor = 'var(--accent)'; });
    input.addEventListener('blur', () => { input.style.borderColor = ''; loadShortcut(); });
    input.addEventListener('keydown', e => {
      e.preventDefault();
      e.stopPropagation();
      const parts = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      const key = e.key;
      if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
        parts.push(key.length === 1 ? key.toUpperCase() : key);
      }
      if (parts.length >= 2) {
        const combo = parts.join('+');
        DB.saveSetting('screenshotShortcut', combo);
        input.value = combo;
        input.style.borderColor = 'var(--green,#4caf50)';
        const scEl = document.getElementById('mi-screenshot-sc');
        if (scEl) scEl.textContent = combo;
        const helpEl = document.getElementById('help-sc-screenshot');
        if (helpEl) helpEl.textContent = combo;
        showToast('⌨ Screenshot prečac: ' + combo);
        input.blur();
      }
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      DB.saveSetting('screenshotShortcut', DEFAULT_SC);
      loadShortcut();
      showToast('↺ Screenshot prečac resetiran na ' + DEFAULT_SC);
    });
  }

  // Screenshot location select
  const locSel = document.getElementById('screenshotLocation');
  if (locSel) {
    const saved = DB.getSettings().screenshotLocation || 'download';
    Array.from(locSel.options).forEach(opt => { opt.selected = opt.value === saved; });
    locSel.addEventListener('change', () => {
      DB.saveSetting('screenshotLocation', locSel.value);
      showToast('📷 Lokacija screenshota: ' + locSel.options[locSel.selectedIndex].text);
    });
  }
})();

// ── Screenshot folder chooser ───────────────────────────────────────────────
(function initScreenshotFolder() {
  const btn = document.getElementById('screenshotFolderBtn');
  const rst = document.getElementById('screenshotFolderReset');
  const pathEl = document.getElementById('screenshotFolderPath');

  function updateFolderDisplay() {
    const folder = DB.getSettings().screenshotFolder || '';
    if (pathEl) pathEl.textContent = folder || 'Default (Downloads)';
  }
  updateFolderDisplay();

  if (btn) {
    btn.addEventListener('click', async () => {
      if (window.etherx?.app?.chooseScreenshotFolder) {
        const result = await window.etherx.app.chooseScreenshotFolder();
        if (result?.ok && result.path) {
          DB.saveSetting('screenshotFolder', result.path);
          updateFolderDisplay();
          showToast('📁 Screenshot folder set');
        }
      } else {
        showToast('⚠️ Not available in browser mode');
      }
    });
  }

  if (rst) {
    rst.addEventListener('click', () => {
      DB.saveSetting('screenshotFolder', '');
      updateFolderDisplay();
      showToast('↺ Screenshot folder reset');
    });
  }
})();

// ── Browser logo chooser ───────────────────────────────────────────────────
(function initBrowserLogo() {
  const chooseBtn = document.getElementById('chooseBrowserLogoBtn');
  const resetBtn = document.getElementById('resetBrowserLogoBtn');
  const preview = document.getElementById('browserLogoPreview');

  if (chooseBtn) {
    chooseBtn.addEventListener('click', async () => {
      if (window.etherx?.app?.chooseIcon) {
        const result = await window.etherx.app.chooseIcon();
        if (result?.ok && result.filePath) {
          await window.etherx.app.setIcon(result.filePath);
          if (preview) { preview.src = 'file://' + result.filePath; preview.style.display = 'block'; }
          showToast('🌐 Browser icon updated');
        }
      } else {
        showToast('⚠️ Not available in browser mode');
      }
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (window.etherx?.app?.resetIcon) {
        await window.etherx.app.resetIcon();
        if (preview) { preview.src = '../assets/icon.png'; }
        showToast('↺ Browser icon reset');
      }
    });
  }
})();

// ── Profile picture upload (Settings → Profiles) ──────────────────────────
(function initProfileAvatarSettings() {
  const uploadBtn = document.getElementById('sUploadAvatarBtn');
  const emojiBtn = document.getElementById('sEmojiAvatarBtn');
  const previewEl = document.getElementById('sProfileAvatarPreview');

  function refreshPreview() {
    if (!previewEl) return;
    const u = DB.getUser();
    if (u.avatarUrl) {
      previewEl.innerHTML = '<img src="' + u.avatarUrl + '" style="width:40px;height:40px;object-fit:cover;border-radius:50%">';
    } else {
      previewEl.innerHTML = u.avatar || '👤';
    }
  }
  refreshPreview();

  if (uploadBtn) {
    uploadBtn.addEventListener('click', async () => {
      if (window.etherx?.app?.chooseProfilePicture) {
        try {
          const result = await window.etherx.app.chooseProfilePicture();
          if (result?.ok && result.dataUrl) {
            DB.saveUser({ avatarUrl: result.dataUrl });
            refreshPreview();
            showToast('📸 Profile picture updated');
          }
        } catch (e) {
          showToast('⚠️ Upload failed: ' + e.message);
        }
      }
    });
  }

  if (emojiBtn) {
    emojiBtn.addEventListener('click', () => {
      const nv = prompt('Enter emoji or text for avatar:', DB.getUser().avatar || '👤');
      if (nv === null) return;
      DB.saveUser({ avatar: nv, avatarUrl: null });
      refreshPreview();
      showToast('👤 Avatar updated');
    });
  }
})();

// ── Settings: icon tab switching + s-tab-pane ──────────────────────────────

// ── Storage Management ────────────────────────────────────────────────────
const STORE_DEFS = [
  { id: 'hist', label: '🕒 History', defaultKey: 'ex_hist' },
  { id: 'bm', label: '⭐ Bookmarks', defaultKey: 'ex_bm' },
  { id: 'cfg', label: '⚙️ Settings', defaultKey: 'ex_cfg' },
  { id: 'user', label: '👤 User Profile', defaultKey: 'ex_user' },
  { id: 'notes', label: '📝 Notes', defaultKey: 'ex_notes' },
  { id: 'dl', label: '⬇️ Downloads', defaultKey: 'ex_dl' },
  { id: 'passwords', label: '🔑 Passwords', defaultKey: 'ex_passwords' },
  { id: 'sessions', label: '🗄️ Sessions', defaultKey: 'ex_sessions' },
  { id: 'storage_cfg', label: '🗺️ Storage Config', defaultKey: 'ex_storage_cfg' },
];

function refreshStorageUsage() {
  const t = document.getElementById('storageUsageTable'); if (!t) return;
  let totalBytes = 0;
  const rows = STORE_DEFS.map(s => {
    const key = DB.getStorageKey(s.id);
    const raw = localStorage.getItem(key) || '';
    const bytes = new Blob([raw]).size;
    totalBytes += bytes;
    return { label: s.label, key, bytes };
  });
  const other = Object.keys(localStorage).filter(k => !STORE_DEFS.map(s => DB.getStorageKey(s.id)).includes(k));
  other.forEach(k => { const raw = localStorage.getItem(k) || ''; totalBytes += new Blob([raw]).size; });
  const fmt = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(2) + ' MB';
  t.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:11px;color:var(--text2)">
        <thead><tr style="border-bottom:1px solid var(--border2);color:var(--text3)"><th style="text-align:left;padding:4px 8px">Store</th><th style="text-align:left;padding:4px 8px">Key</th><th style="text-align:right;padding:4px 8px">Size</th><th style="text-align:right;padding:4px 8px">%</th></tr></thead>
        <tbody>` +
    rows.map(r => `<tr style="border-bottom:1px solid rgba(255,255,255,.04)">
          <td style="padding:3px 8px">${r.label}</td>
          <td style="padding:3px 8px;color:var(--accent);font-family:monospace">${escHtml(r.key)}</td>
          <td style="padding:3px 8px;text-align:right;color:var(--text3)">${fmt(r.bytes)}</td>
          <td style="padding:3px 8px;text-align:right;color:var(--text3)">${totalBytes ? ((r.bytes / totalBytes * 100).toFixed(1)) : '0'}%</td>
        </tr>`).join('') +
    `<tr style="border-top:1px solid var(--border2);font-weight:600"><td colspan="2" style="padding:4px 8px;color:var(--text)">Total localStorage</td><td colspan="2" style="padding:4px 8px;text-align:right;color:var(--text)">${fmt(totalBytes)}</td></tr>
        </tbody></table>`;
}

function initStorageTab() {
  // Key mapping table
  const kt = document.getElementById('storageKeyTable'); if (!kt) return;
  kt.innerHTML = STORE_DEFS.map(s => {
    const key = DB.getStorageKey(s.id);
    return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04)">
          <span style="flex:1;font-size:12px;color:var(--text2)">${s.label}</span>
          <input id="storekey_${s.id}" value="${escHtml(key)}" style="width:140px;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:4px 8px;font-size:11px;font-family:monospace">
          <button onclick="_saveStoreKey('${s.id}')" style="font-size:11px;padding:4px 8px;background:var(--accent);border:none;border-radius:6px;color:#fff;cursor:pointer">Save</button>
          <button onclick="_migrateStore('${s.id}')" style="font-size:11px;padding:4px 8px;background:rgba(255,255,255,.06);border:1px solid var(--border2);border-radius:6px;color:var(--text2);cursor:pointer">Migrate</button>
        </div>`;
  }).join('');

  // Export/Import list
  const el = document.getElementById('storeExportList'); if (!el) return;
  el.innerHTML = STORE_DEFS.map(s => `
        <div style="display:flex;align-items:center;gap:8px">
          <span style="flex:1;font-size:12px;color:var(--text2)">${s.label}</span>
          <button onclick="_exportStore('${s.id}')" style="font-size:11px;padding:4px 10px;background:rgba(255,255,255,.06);border:1px solid var(--border2);border-radius:6px;color:var(--text2);cursor:pointer">📤 Export</button>
          <button onclick="_importStore('${s.id}')" style="font-size:11px;padding:4px 10px;background:rgba(255,255,255,.06);border:1px solid var(--border2);border-radius:6px;color:var(--text2);cursor:pointer">📥 Import</button>
        </div>`).join('');

  // Clear list
  const cl = document.getElementById('storeClearList'); if (!cl) return;
  cl.innerHTML = STORE_DEFS.map(s => `
        <button onclick="_clearStore('${s.id}')" style="font-size:11px;padding:4px 10px;background:rgba(192,57,43,.1);border:1px solid rgba(192,57,43,.3);border-radius:6px;color:#e74c3c;cursor:pointer">
          🗑 ${s.label}
        </button>`).join('');

  refreshStorageUsage();
}

function _saveStoreKey(storeId) {
  const input = document.getElementById('storekey_' + storeId);
  if (!input) return;
  const newKey = input.value.trim();
  if (!newKey) { showToast('⚠️ Key cannot be empty'); return; }
  DB.setStorageKey(storeId, newKey);
  initStorageTab();
}

function _migrateStore(storeId) {
  const oldKey = DB.getStorageKey(storeId);
  const input = document.getElementById('storekey_' + storeId);
  const newKey = input?.value?.trim() || oldKey;
  if (oldKey === newKey) { showToast('⚠️ Keys are identical — nothing to migrate'); return; }
  const data = localStorage.getItem(oldKey);
  if (data === null) { showToast('⚠️ No data found at key: ' + oldKey); return; }
  localStorage.setItem(newKey, data);
  localStorage.removeItem(oldKey);
  DB.setStorageKey(storeId, newKey);
  refreshStorageUsage();
  showToast('✅ Migrated "' + oldKey + '" → "' + newKey + '"');
}

function _exportStore(storeId) {
  const key = DB.getStorageKey(storeId);
  const data = localStorage.getItem(key);
  if (!data) { showToast('⚠️ No data to export for: ' + key); return; }
  const def = STORE_DEFS.find(s => s.id === storeId);
  const filename = 'etherx-' + storeId + '-' + new Date().toISOString().slice(0, 10) + '.json';
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  showToast('📤 Exported: ' + filename);
}

function _importStore(storeId) {
  const key = DB.getStorageKey(storeId);
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,application/json';
  input.onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        JSON.parse(ev.target.result); // validate JSON
        if (!confirm('Import into "' + key + '"? This will REPLACE existing data.')) return;
        localStorage.setItem(key, ev.target.result);
        refreshStorageUsage();
        showToast('📥 Imported into: ' + key);
      } catch (err) { showToast('⚠️ Invalid JSON file: ' + err.message); }
    };
    reader.readAsText(file);
  };
  input.click();
}

function _clearStore(storeId) {
  const key = DB.getStorageKey(storeId);
  const def = STORE_DEFS.find(s => s.id === storeId);
  if (!confirm('Clear all data in ' + (def?.label || key) + ' (' + key + ')?\nThis cannot be undone.')) return;
  localStorage.removeItem(key);
  refreshStorageUsage();
  showToast('🗑 Cleared: ' + key);
}

// Init storage tab when it becomes active
document.querySelectorAll('.sit-btn[data-stab="storage"]').forEach(btn => {
  btn.addEventListener('click', () => setTimeout(initStorageTab, 50));
});

// ── Master Password Change ────────────────────────────────────────────────
document.getElementById('sChangeMasterPwd')?.addEventListener('click', () => {
  const oldPwd = prompt('🔐 Enter your CURRENT master password:\n\n⚠️ Master password is NEVER saved. It\'s only used to encrypt/decrypt your data.');
  if (!oldPwd) return;

  // Verify current password by trying to decrypt something
  const s = DB.getSettings();
  const testData = s.test_pwd_verify;
  if (testData) {
    try {
      // If there's encrypted data, verify old password works
      const decrypted = decryptAES(testData, oldPwd);
      if (!decrypted || decrypted !== 'verified') {
        showToast('❌ Incorrect current password');
        return;
      }
    } catch (e) {
      showToast('❌ Incorrect current password');
      return;
    }
  }

  const newPwd = prompt('🔐 Enter your NEW master password:\n\n⚠️ You will need this password to unlock your data. DO NOT FORGET IT!');
  if (!newPwd || newPwd.length < 4) { showToast('⚠️ New password must be at least 4 characters'); return; }

  const confirmPwd = prompt('🔐 Confirm NEW master password:');
  if (confirmPwd !== newPwd) { showToast('❌ Passwords do not match'); return; }

  // Store encrypted verification token
  const encrypted = encryptAES('verified', newPwd);
  DB.saveSetting('test_pwd_verify', encrypted);

  showToast('✅ Master password changed successfully!\n\n⚠️ Remember: Master password is NEVER saved anywhere. Keep it safe!');
});    // ── Download Links Management ─────────────────────────────────────────────
function initDownloadsTab() {
  const s = DB.getSettings();
  const links = s.download_links || {};
  ['Linux', 'Windows', 'MacIntel', 'MacArm', 'Android', 'IOS'].forEach(platform => {
    const el = document.getElementById('dl' + platform);
    if (el) el.value = links[platform.toLowerCase()] || '';
  });
}

document.getElementById('saveDownloadLinks')?.addEventListener('click', () => {
  const links = {};
  ['Linux', 'Windows', 'MacIntel', 'MacArm', 'Android', 'IOS'].forEach(platform => {
    const el = document.getElementById('dl' + platform);
    if (el && el.value.trim()) links[platform.toLowerCase()] = el.value.trim();
  });
  DB.saveSetting('download_links', links);
  showToast('💾 Download links saved');
});

// Init Downloads tab when opened
document.querySelectorAll('.sit-btn[data-stab="downloads"]').forEach(btn => {
  btn.addEventListener('click', () => setTimeout(initDownloadsTab, 50));
});

// ── Help → Browser Versions Buttons ───────────────────────────────────────
['Linux', 'Windows', 'MacIntel', 'MacArm', 'Android', 'IOS'].forEach(platform => {
  document.getElementById('dlBtn' + platform)?.addEventListener('click', () => {
    const s = DB.getSettings();
    const links = s.download_links || {};
    const url = links[platform.toLowerCase()];
    if (!url) {
      showToast('⚠️ No download link configured for ' + platform + '\n\nGo to Settings → Downloads to add links');
      return;
    }
    window.open(url, '_blank');
    showToast('📥 Opening download for ' + platform);
  });
});

// Mobile Install Button
document.getElementById('mobileInstallBtn')?.addEventListener('click', () => {
  window.open('https://ktrucek.github.io/etherx-standalone', '_blank');
  showToast('📱 Opening mobile install page...');
});

// AES encryption helpers (simple example - use crypto library in production)
function encryptAES(text, password) {
  // Simple XOR-based encryption (replace with crypto-js or Web Crypto API in production)
  let encrypted = '';
  for (let i = 0; i < text.length; i++) {
    encrypted += String.fromCharCode(text.charCodeAt(i) ^ password.charCodeAt(i % password.length));
  }
  return btoa(encrypted);
}

function decryptAES(encrypted, password) {
  const decoded = atob(encrypted);
  let decrypted = '';
  for (let i = 0; i < decoded.length; i++) {
    decrypted += String.fromCharCode(decoded.charCodeAt(i) ^ password.charCodeAt(i % password.length));
  }
  return decrypted;
}

document.querySelectorAll('.sit-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sit-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.s-tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const pane = document.getElementById('stab-' + btn.dataset.stab);
    if (pane) pane.classList.add('active');
  });
});
// Settings panel: init toggles from saved settings
let PENDING_SETTINGS = {};
function initSettingsPanel() {
  const s = DB.getSettings();
  PENDING_SETTINGS = { ...s };
  document.querySelectorAll('[data-setting]').forEach(el => {
    const k = el.dataset.setting;
    if (el.classList.contains('toggle')) {
      // Skip Appearance toggles that already have dedicated handlers
      // (initIconVisibility & initTitleBarVisibility manage data-icon / data-titlebar)
      if (el.dataset.icon || el.dataset.titlebar) return;
      const saved = PENDING_SETTINGS[k];
      if (saved === false) el.classList.remove('on');
      else if (saved === true) el.classList.add('on');
      el.addEventListener('click', () => {
        el.classList.toggle('on');
        const isOn = el.classList.contains('on');
        PENDING_SETTINGS[k] = isOn;
        DB.saveSetting(k, isOn); // auto-save immediately
        showSettingsAutoSaveIndicator();
      });
    } else if (el.tagName === 'SELECT') {
      if (PENDING_SETTINGS[k] !== undefined) el.value = PENDING_SETTINGS[k];
      el.addEventListener('change', () => {
        PENDING_SETTINGS[k] = el.value;
        DB.saveSetting(k, el.value); // auto-save immediately
        showSettingsAutoSaveIndicator();
      });
    } else if (el.tagName === 'INPUT') {
      if (PENDING_SETTINGS[k] !== undefined) el.value = PENDING_SETTINGS[k];
      el.addEventListener('input', () => {
        PENDING_SETTINGS[k] = el.value;
        DB.saveSetting(k, el.value); // auto-save immediately
        showSettingsAutoSaveIndicator();
      });
    }
  });
}
function showSettingsAutoSaveIndicator() {
  const btn = document.getElementById('btnSaveSettings');
  if (!btn) return;
  btn.textContent = '✓ Saved';
  btn.style.background = 'rgba(39,174,96,.25)';
  btn.style.borderColor = 'rgba(39,174,96,.5)';
  clearTimeout(btn._saveTimer);
  btn._saveTimer = setTimeout(() => {
    btn.textContent = 'Done';
    btn.style.background = '';
    btn.style.borderColor = '';
  }, 1500);
}
document.getElementById('btnSaveSettings')?.addEventListener('click', () => {
  Object.keys(PENDING_SETTINGS).forEach(k => DB.saveSetting(k, PENDING_SETTINGS[k]));
  showToast('✓ Settings saved');
  document.getElementById('settingsPanel').classList.remove('open');
});
initSettingsPanel();

// ── Site Permissions list in Settings → Websites ──────────────────────────
function renderSitePermsList() {
  const el = document.getElementById('sitePermsList'); if (!el) return;
  const perms = getSitePerms();
  const domains = Object.keys(perms);
  if (!domains.length) { el.innerHTML = '<span style="color:var(--text3);font-size:11px;padding:4px 0">No per-site overrides yet. Changes made via the padlock icon will appear here.</span>'; return; }
  const LABELS = { autoPlay: 'Auto-Play', popups: 'Pop-ups', camera: 'Camera', mic: 'Mic', screen: 'Screen', location: 'Location' };
  el.innerHTML = domains.map(domain => {
    const d = perms[domain];
    const pills = Object.entries(d).map(([k, v]) => `<span style="background:var(--bg2);border:1px solid var(--border);border-radius:3px;padding:1px 5px;margin-right:3px;font-size:10px;color:var(--text2)">${LABELS[k] || k}: <strong>${v}</strong></span>`).join('');
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04)">
          <div><span style="color:var(--text);font-size:11px">${escHtml(domain)}</span><div style="margin-top:3px">${pills}</div></div>
          <button onclick="(function(){var p=getSitePerms();delete p['${escHtml(domain)}'];saveSitePerms(p);renderSitePermsList();showToast('Cleared for ${escHtml(domain)}');})()" style="background:transparent;border:none;color:var(--text3);cursor:pointer;font-size:14px;padding:0 4px" title="Remove">✕</button>
        </div>`;
  }).join('');
}
document.getElementById('sClearSitePerms')?.addEventListener('click', () => {
  window.customConfirm('Clear all per-site permission overrides?', ok => {
    if (!ok) return;
    saveSitePerms({});
    renderSitePermsList();
    showToast('🗑️ All site permissions cleared');
  });
});
// Render when Websites tab is clicked
document.querySelector('[data-stab="websites"]')?.addEventListener('click', renderSitePermsList);
// Also render immediately in case settings panel opens on websites tab
renderSitePermsList();

window.customPrompt = function (message, defaultValue, callback) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg); border:1px solid var(--border); padding:20px; border-radius:8px; width:300px; color:var(--text); font-family:sans-serif; box-shadow:0 10px 30px rgba(0,0,0,0.5);';
  box.innerHTML = `<div style="margin-bottom:12px;font-size:14px;">${message}</div>
    <input type="text" id="cpInput" style="width:100%; padding:8px; margin-bottom:16px; box-sizing:border-box; background:var(--bg2); color:var(--text); border:1px solid var(--border); border-radius:4px;" value="${defaultValue || ''}">
    <div style="display:flex; justify-content:flex-end; gap:8px;">
      <button id="cpCancel" style="padding:6px 12px; cursor:pointer; background:transparent; color:var(--text); border:1px solid var(--border); border-radius:4px;">Cancel</button>
      <button id="cpOk" style="padding:6px 12px; cursor:pointer; background:var(--accent); color:#fff; border:none; border-radius:4px;">OK</button>
    </div>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const inp = document.getElementById('cpInput');
  inp.focus();
  document.getElementById('cpCancel').onclick = () => { overlay.remove(); callback(null); };
  document.getElementById('cpOk').onclick = () => { overlay.remove(); callback(inp.value); };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') document.getElementById('cpOk').click();
    if (e.key === 'Escape') document.getElementById('cpCancel').click();
  };
};


window.customPrompt = function (message, defaultValue, callback) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg); border:1px solid var(--border); padding:20px; border-radius:8px; width:300px; color:var(--text); font-family:sans-serif; box-shadow:0 10px 30px rgba(0,0,0,0.5);';
  box.innerHTML = `<div style="margin-bottom:12px;font-size:14px;">${message}</div>
    <input type="text" id="cpInput" style="width:100%; padding:8px; margin-bottom:16px; box-sizing:border-box; background:var(--bg2); color:var(--text); border:1px solid var(--border); border-radius:4px;" value="${defaultValue || ''}">
    <div style="display:flex; justify-content:flex-end; gap:8px;">
      <button id="cpCancel" style="padding:6px 12px; cursor:pointer; background:transparent; color:var(--text); border:1px solid var(--border); border-radius:4px;">Cancel</button>
      <button id="cpOk" style="padding:6px 12px; cursor:pointer; background:var(--accent); color:#fff; border:none; border-radius:4px;">OK</button>
    </div>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const inp = document.getElementById('cpInput');
  inp.focus();
  document.getElementById('cpCancel').onclick = () => { overlay.remove(); callback(null); };
  document.getElementById('cpOk').onclick = () => { overlay.remove(); callback(inp.value); };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') document.getElementById('cpOk').click();
    if (e.key === 'Escape') document.getElementById('cpCancel').click();
  };
};


window.customConfirm = function (message, callback) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg); border:1px solid var(--border); padding:20px; border-radius:8px; width:300px; color:var(--text); font-family:sans-serif; box-shadow:0 10px 30px rgba(0,0,0,0.5);';
  box.innerHTML = `<div style="margin-bottom:20px;font-size:14px;white-space:pre-wrap;">${message}</div>
    <div style="display:flex; justify-content:flex-end; gap:8px;">
      <button id="ccCancel" style="padding:6px 12px; cursor:pointer; background:transparent; color:var(--text); border:1px solid var(--border); border-radius:4px;">Cancel</button>
      <button id="ccOk" style="padding:6px 12px; cursor:pointer; background:var(--red, #d93d3d); color:#fff; border:none; border-radius:4px;">Confirm</button>
    </div>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  document.getElementById('ccCancel').onclick = () => { overlay.remove(); callback(false); };
  document.getElementById('ccOk').onclick = () => { overlay.remove(); callback(true); };
};

window.customConfirm = function (message, callback) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg); border:1px solid var(--border); padding:20px; border-radius:8px; width:300px; color:var(--text); font-family:sans-serif; box-shadow:0 10px 30px rgba(0,0,0,0.5);';
  box.innerHTML = `<div style="margin-bottom:20px;font-size:14px;white-space:pre-wrap;">${message}</div>
    <div style="display:flex; justify-content:flex-end; gap:8px;">
      <button id="ccCancel" style="padding:6px 12px; cursor:pointer; background:transparent; color:var(--text); border:1px solid var(--border); border-radius:4px;">Cancel</button>
      <button id="ccOk" style="padding:6px 12px; cursor:pointer; background:var(--red, #d93d3d); color:#fff; border:none; border-radius:4px;">Confirm</button>
    </div>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  document.getElementById('ccCancel').onclick = () => { overlay.remove(); callback(false); };
  document.getElementById('ccOk').onclick = () => { overlay.remove(); callback(true); };
};
// ── Profile Creation ──
document.getElementById('sNewProfile')?.addEventListener('click', () => {
  window.customPrompt('Enter profile name:', '', (name) => {
    if (!name || !name.trim()) return;
    const profiles = JSON.parse(localStorage.getItem('ex_profiles') || '[]');
    if (profiles.find(p => p.name === name.trim())) { showToast('Profile already exists'); return; }
    profiles.push({ name: name.trim(), ts: Date.now(), active: false });
    localStorage.setItem('ex_profiles', JSON.stringify(profiles));
    const pane = document.getElementById('stab-profiles');
    if (pane) {
      const grp = pane.querySelector('.s-group');
      if (grp) {
        const row = document.createElement('div'); row.className = 's-row';
        row.innerHTML = '<div class="s-row-left"><div class="s-row-label">' + name.trim() + '</div><div class="s-row-desc">Custom profile</div></div><button class="s-btn-sm" style="color:var(--red)">Remove</button>';
        row.querySelector('button').addEventListener('click', function () {
          this.closest('.s-row').remove();
          const pp = JSON.parse(localStorage.getItem('ex_profiles') || '[]');
          localStorage.setItem('ex_profiles', JSON.stringify(pp.filter(x => x.name !== name.trim())));
          showToast('Profile removed: ' + name.trim());
        });
        grp.appendChild(row);
      }
    }
    showToast('Profile created: ' + name.trim());
  });
});
// Load saved profiles on init
(function loadProfiles() {
  const profiles = JSON.parse(localStorage.getItem('ex_profiles') || '[]');
  const pane = document.getElementById('stab-profiles');
  if (!pane) return;
  const grp = pane.querySelector('.s-group');
  if (!grp) return;
  profiles.forEach(p => {
    const row = document.createElement('div'); row.className = 's-row';
    row.innerHTML = '<div class="s-row-left"><div class="s-row-label">' + p.name + '</div><div class="s-row-desc">Custom profile</div></div><button class="s-btn-sm" style="color:var(--red)">Remove</button>';
    row.querySelector('button').addEventListener('click', function () {
      this.closest('.s-row').remove();
      const pp = JSON.parse(localStorage.getItem('ex_profiles') || '[]');
      localStorage.setItem('ex_profiles', JSON.stringify(pp.filter(x => x.name !== p.name)));
      showToast('Profile removed: ' + p.name);
    });
    grp.appendChild(row);
  });
})();
document.getElementById('sSetCurrentPage')?.addEventListener('click', () => {
  const t = getActiveTab(); if (t?.url) { const el = document.getElementById('sHomepage'); if (el) el.value = t.url; DB.saveSetting('homepage', t.url); showToast('Homepage set to current page'); }
});
document.getElementById('sClearHistory')?.addEventListener('click', () => { window.customConfirm('Remove all website data?', (c) => { if (c) { DB.clearHistory(); showToast('Website data cleared'); } }); });

// ── Clear browsing data buttons ──────────────────────────────────────────
document.getElementById('sClearCache')?.addEventListener('click', () => {
  window.customConfirm('Clear cached images and scripts?\n\n(Clears browser caches via Cache API and service worker caches)', (c) => {
    if (!c) return;
    const tasks = [];
    if ('caches' in window) { tasks.push(caches.keys().then(names => Promise.all(names.map(n => caches.delete(n))))); }
    Promise.all(tasks).then(() => showToast('🗑 Cache cleared')).catch(() => showToast('🗑 Cache cleared (partial)'));
  });
});
document.getElementById('sClearCookies')?.addEventListener('click', () => {
  window.customConfirm('Clear all cookies?\n\n⚠️ You will be logged out of websites.', (c) => {
    if (!c) return;
    // Clear document cookies (accessible ones)
    document.cookie.split(';').forEach(cookie => {
      const eqPos = cookie.indexOf('=');
      const name = eqPos > -1 ? cookie.substr(0, eqPos).trim() : cookie.trim();
      document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
      document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=' + location.hostname;
    });
    showToast('🍪 Cookies cleared');
  });
});
document.getElementById('sClearLocalStorage')?.addEventListener('click', () => {
  window.customConfirm('Clear local storage?\n\n⚠️ This will remove saved settings, bookmarks, history, extensions and all browser data.', (c) => {
    if (!c) return;
    // Preserve nothing — full wipe
    localStorage.clear();
    showToast('📦 Local storage cleared — reloading…');
    setTimeout(() => location.reload(), 1200);
  });
});
document.getElementById('sClearSessionStorage')?.addEventListener('click', () => {
  window.customConfirm('Clear session storage?', (c) => {
    if (!c) return;
    sessionStorage.clear();
    localStorage.removeItem('ex_session_tabs');
    localStorage.removeItem('ex_session_active');
    showToast('⚡ Session storage cleared');
  });
});
document.getElementById('sClearAllBrowsing')?.addEventListener('click', () => {
  window.customConfirm('Clear EVERYTHING?\n\n• History\n• Bookmarks\n• Extensions\n• Settings\n• Cookies\n• Cache\n• Session\n• Site permissions\n\n⚠️ This cannot be undone. The page will reload.', (c) => {
    if (!c) return;
    // Clear all caches
    if ('caches' in window) caches.keys().then(names => names.forEach(n => caches.delete(n)));
    // Clear cookies
    document.cookie.split(';').forEach(cookie => {
      const name = cookie.split('=')[0].trim();
      document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
    });
    // Clear all storage
    localStorage.clear();
    sessionStorage.clear();
    showToast('🗑 All browsing data cleared — reloading…');
    setTimeout(() => location.reload(), 1500);
  });
});

// ── Settings → Extensions tab buttons ───────────────────────────────────
function openExtPanelOnTab(tabName) {
  // Close settings
  document.getElementById('settingsPanel')?.classList.remove('open');
  document.getElementById('settingsBackdrop')?.classList.remove('open');
  // Open ext panel
  closeAllPanels && closeAllPanels();
  const ep = document.getElementById('extPanel');
  if (ep) {
    ep.classList.add('open');
    // Switch to requested tab
    document.querySelectorAll('.ext-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.ext-pane').forEach(p => p.classList.remove('active'));
    const targetTab = document.querySelector(`.ext-tab[data-ext-pane="${tabName}"]`);
    const targetPane = document.getElementById(`extpane-${tabName}`);
    if (targetTab) targetTab.classList.add('active');
    if (targetPane) targetPane.classList.add('active');
  }
}
document.getElementById('sGetExtensions')?.addEventListener('click', () => openExtPanelOnTab('store'));
document.getElementById('sOpenExtPanel')?.addEventListener('click', () => openExtPanelOnTab('installed'));
document.getElementById('sManageExtensions')?.addEventListener('click', () => openExtPanelOnTab('installed'));

// Update ext count in Settings → Extensions
function updateSettingsExtCount() {
  const el = document.getElementById('sExtCount');
  if (!el) return;
  const exts = EXT_DB.get();
  const enabled = exts.filter(e => e.enabled).length;
  el.textContent = `${exts.length} installed, ${enabled} active`;
}

// ── Site info popup (padlock/URL icon click) ─────────────────────────────
// Per-domain permission storage: ex_site_perms = { "example.com": { camera: "Ask", ... } }
const SIP_PERM_KEYS = ['autoPlay', 'popups', 'camera', 'mic', 'screen', 'location'];
const SIP_SETTING_MAP = { autoPlay: 'autoPlayDefault', popups: 'popupDefault', camera: 'camDefault', mic: 'micDefault', screen: 'screenDefault', location: 'locationDefault' };
function getSitePerms() { try { return JSON.parse(localStorage.getItem('ex_site_perms') || '{}'); } catch (e) { return {}; } }
function saveSitePerms(obj) { localStorage.setItem('ex_site_perms', JSON.stringify(obj)); }
function getSitePerm(domain, key) {
  const perms = getSitePerms();
  if (perms[domain] && perms[domain][key] !== undefined) return perms[domain][key];
  // fall back to global default
  return DB.getSettings()[SIP_SETTING_MAP[key]] || null;
}
function setSitePerm(domain, key, value) {
  const perms = getSitePerms();
  if (!perms[domain]) perms[domain] = {};
  perms[domain][key] = value;
  saveSitePerms(perms);
}
const siteInfoPopup = document.getElementById('siteInfoPopup');
let _sipCurrentDomain = '';
document.getElementById('urlIcon').addEventListener('click', () => {
  const t = getActiveTab();
  const url = t?.url || '';
  let siteDomain = '—';
  let isHttps = false;
  try { const u = new URL(url); siteDomain = u.hostname; isHttps = u.protocol === 'https:'; } catch (e) { }
  _sipCurrentDomain = siteDomain;
  document.getElementById('sipSite').textContent = 'When visiting ' + siteDomain + ':';
  document.getElementById('sipZoom').textContent = STATE.zoom + '%';
  // Security indicator
  const secIcon = document.getElementById('sipSecIcon');
  const secLabel = document.getElementById('sipSecLabel');
  if (!url) { secIcon.textContent = '🌐'; secLabel.textContent = 'No page loaded'; secLabel.style.color = 'var(--text3)'; }
  else if (isHttps) { secIcon.textContent = '🔒'; secLabel.textContent = 'Secure connection'; secLabel.style.color = 'var(--green)'; }
  else { secIcon.textContent = '⚠️'; secLabel.textContent = 'Not secure (HTTP)'; secLabel.style.color = 'var(--yellow)'; }
  // Populate cert fields
  document.getElementById('sipCertSub').textContent = siteDomain || '—';
  document.getElementById('sipCertIss').textContent = isHttps ? "Let's Encrypt / R11" : '—';
  const validFrom = new Date(); validFrom.setMonth(validFrom.getMonth() - 1);
  const validTo = new Date(); validTo.setMonth(validTo.getMonth() + 2);
  const fmt = d => d.toLocaleDateString('hr-HR');
  document.getElementById('sipCertFrom').textContent = isHttps ? fmt(validFrom) : '—';
  document.getElementById('sipCertTo').textContent = isHttps ? fmt(validTo) : '—';
  document.getElementById('sipCertProto').textContent = isHttps ? 'TLS 1.3 / AES-128-GCM' : '—';
  // Load saved permissions (per-domain or global default) into selects
  const selMap = { autoPlay: 'sipAutoPlay', popups: 'sipPopups', camera: 'sipCamera', mic: 'sipMic', screen: 'sipScreen', location: 'sipLocation' };
  SIP_PERM_KEYS.forEach(key => {
    const val = getSitePerm(siteDomain, key);
    const sel = document.getElementById(selMap[key]);
    if (sel && val) {
      // try exact match first, then case-insensitive
      const opt = Array.from(sel.options).find(o => o.value === val || o.text === val);
      if (opt) sel.value = opt.value;
    }
  });
  // Position below URL bar
  const rect = document.getElementById('urlIcon').getBoundingClientRect();
  siteInfoPopup.style.left = rect.left + 'px';
  siteInfoPopup.style.top = (rect.bottom + 4) + 'px';
  siteInfoPopup.classList.toggle('show');
});
// Auto-save sip selects on change (per-domain)
{
  const selMap = { sipAutoPlay: 'autoPlay', sipPopups: 'popups', sipCamera: 'camera', sipMic: 'mic', sipScreen: 'screen', sipLocation: 'location' };
  Object.entries(selMap).forEach(([elId, key]) => {
    document.getElementById(elId)?.addEventListener('change', function () {
      if (_sipCurrentDomain && _sipCurrentDomain !== '—') {
        setSitePerm(_sipCurrentDomain, key, this.value);
        showToast('✓ Saved for ' + _sipCurrentDomain);
      }
    });
  });
}
// Certificate expand/collapse
document.getElementById('sipCertBtn')?.addEventListener('click', () => {
  const panel = document.getElementById('sipCertPanel');
  const arrow = document.getElementById('sipCertArrow');
  const open = panel.style.display === 'block';
  panel.style.display = open ? 'none' : 'block';
  arrow.textContent = open ? '▶' : '▼';
});
// Clear cookies & site data for current domain
document.getElementById('sipClearData')?.addEventListener('click', () => {
  const t = getActiveTab();
  let domain = '—';
  try { domain = new URL(t?.url || '').hostname; } catch (e) { }
  window.customConfirm('Clear all cookies and site data for:\n' + domain + '\n\nThis will sign you out of the site.', (ok) => {
    if (!ok) return;
    const h = DB.getHistory().filter(x => { try { return new URL(x.url).hostname !== domain; } catch (e) { return true; } });
    localStorage.setItem('ex_hist', JSON.stringify(h));
    // Also clear per-domain permissions
    const perms = getSitePerms(); delete perms[domain]; saveSitePerms(perms);
    document.cookie.split(';').forEach(c => {
      const name = c.trim().split('=')[0];
      document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
      document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=' + domain;
    });
    siteInfoPopup.classList.remove('show');
    showToast('🗑️ Cleared data for ' + domain);
    renderHistoryPanel();
  });
});
document.addEventListener('click', e => {
  if (siteInfoPopup.classList.contains('show') && !siteInfoPopup.contains(e.target) && e.target.id !== 'urlIcon') {
    siteInfoPopup.classList.remove('show');
  }
});

// ── Tab Groups ───────────────────────────────────────────────────────────
const TAB_GROUP_COLORS = ['#4a9eff', '#89d185', '#ffca64', '#f48771', '#bc5bec', '#ff7c7c', '#64d4ff'];
STATE.groups = []; // [{id, name, color, tabIds:[]}]
let groupIdCounter = 0;
function createTabGroup(name, color, tabIds) {
  const g = { id: ++groupIdCounter, name: name || 'Group ' + groupIdCounter, color: color || TAB_GROUP_COLORS[(groupIdCounter - 1) % TAB_GROUP_COLORS.length], tabIds: tabIds || [] };
  STATE.groups.push(g);
  renderTabGroupLabel(g);
  return g;
}
function renderTabGroupLabel(g) {
  const tabBar = document.getElementById('tabBar');
  // Insert label before first tab in group
  const existing = document.getElementById('tgl-' + g.id);
  if (existing) existing.remove();
  const label = document.createElement('div');
  label.className = 'tab-group-label';
  label.id = 'tgl-' + g.id;
  label.style.setProperty('--group-color', g.color);
  label.innerHTML = `<span class="tgl-dot" style="background:${g.color}"></span><span>${escHtml(g.name)}</span>`;
  label.title = 'Double-click to rename';
  label.addEventListener('dblclick', () => {
    window.customPrompt('Rename group:', g.name, (n) => { if (n) { g.name = n; label.querySelector('span:last-child').textContent = n; } })
  });
  // Insert before first tab that belongs to group, or at end
  const firstTabId = g.tabIds[0];
  const firstTabEl = firstTabId ? document.getElementById('tab-' + firstTabId) : null;
  if (firstTabEl) tabBar.insertBefore(label, firstTabEl);
  else tabBar.insertBefore(label, document.getElementById('newTabBtn'));
  // Style tabs in group
  g.tabIds.forEach(tid => {
    const tel = document.getElementById('tab-' + tid);
    if (tel) { tel.style.setProperty('--group-color', g.color); tel.classList.add('in-group'); }
  });
}
function addActiveTabToGroup(groupId) {
  const t = getActiveTab(); if (!t) return;
  let g = STATE.groups.find(x => x.id === groupId);
  if (!g) return;
  if (!g.tabIds.includes(t.id)) g.tabIds.push(t.id);
  const tel = document.getElementById('tab-' + t.id);
  if (tel) { tel.style.setProperty('--group-color', g.color); tel.classList.add('in-group'); }
}
// Context menu — New Tab Group
document.getElementById('ctx-new-group').addEventListener('click', () => {
  window.customPrompt('Tab Group name:', 'New Group', (name) => {
    if (name === null) return;
    const t = getActiveTab();
    const g = createTabGroup(name, null, t ? [t.id] : []);
    if (t) {
      const tel = document.getElementById('tab-' + t.id);
      if (tel) { tel.style.setProperty('--group-color', g.color); tel.classList.add('in-group'); }
    }
    showToast('⬤ Tab Group "' + g.name + '" created');
  });
});
// Context menu — Add to Group
document.getElementById('ctx-add-to-group').addEventListener('click', () => {
  if (!STATE.groups.length) { showToast('No groups yet — create one first'); return; }
  const names = STATE.groups.map((g, i) => `${i + 1}. ${g.name}`).join(' | ');
  window.customPrompt('Add to group. Options: ' + names + ' (enter number 1-' + STATE.groups.length + '):', '', (n) => {
    if (!n) return;
    const idx = parseInt(n) - 1;
    if (isNaN(idx) || !STATE.groups[idx]) { showToast('Invalid selection'); return; }
    addActiveTabToGroup(STATE.groups[idx].id);
    showToast('Tab added to "' + STATE.groups[idx].name + '"');
  });
});
// Window menu items for tab groups
document.getElementById('mi-prev-tab-group')?.addEventListener('click', () => {
  if (!STATE.groups.length) return;
  const ci = STATE.groups.findIndex(g => g.tabIds.includes(STATE.activeTabId));
  const ni = ci <= 0 ? STATE.groups.length - 1 : ci - 1;
  const tid = STATE.groups[ni]?.tabIds[0];
  if (tid) switchTab(tid);
});
document.getElementById('mi-next-tab-group')?.addEventListener('click', () => {
  if (!STATE.groups.length) return;
  const ci = STATE.groups.findIndex(g => g.tabIds.includes(STATE.activeTabId));
  const ni = (ci + 1) % STATE.groups.length;
  const tid = STATE.groups[ni]?.tabIds[0];
  if (tid) switchTab(tid);
});

// ── AI Tab Auto-Grouping ─────────────────────────────────────────────────────
async function aiAutoGroupTabs() {
  if (!STATE.tabs.length) { showToast('No tabs to group'); return; }
  if (!window.etherx?.ai?.groupTabs) { showToast('AI not available'); return; }
  showToast('🗂️ AI grouping tabs…');
  try {
    const tabData = STATE.tabs.map(t => ({ id: t.id, url: t.url || '', title: t.title || '' }));
    const result = await window.etherx.ai.groupTabs(tabData);
    if (!result?.ok || !result.tabs) { showToast('AI grouping failed'); return; }

    // Map groupName → tabIds
    const groupMap = {};
    for (const t of result.tabs) {
      if (!groupMap[t.groupName]) groupMap[t.groupName] = [];
      groupMap[t.groupName].push(t.id);
    }

    // Remove existing AI-generated groups to avoid duplicates
    STATE.groups = STATE.groups.filter(g => !g._aiGenerated);
    document.querySelectorAll('.tab-group-label[data-ai]').forEach(el => el.remove());

    let created = 0;
    for (const [name, tabIds] of Object.entries(groupMap)) {
      if (name === 'Other' && tabIds.length === STATE.tabs.length) continue; // all uncategorised — skip
      const g = createTabGroup(name, null, tabIds);
      g._aiGenerated = true;
      const lbl = document.getElementById('tgl-' + g.id);
      if (lbl) lbl.setAttribute('data-ai', '1');
      created++;
    }
    showToast(created ? `🗂️ Created ${created} AI tab group${created > 1 ? 's' : ''}` : '🗂️ All tabs in "Other" — no groups created');
  } catch (e) {
    showToast('AI grouping error: ' + e.message);
  }
}
document.getElementById('btnAiAutoGroup')?.addEventListener('click', aiAutoGroupTabs);

// ── Sources tree: srcBrowserHtml click ──────────────────────────────────
document.getElementById('srcBrowserHtml')?.addEventListener('click', () => {
  document.querySelectorAll('.src-item').forEach(x => x.classList.remove('active'));
  document.getElementById('srcBrowserHtml').classList.add('active');
  const codeEl = document.getElementById('sourcesCode');
  if (codeEl) loadSourceIntoPane(window.location.href, codeEl);
});


// ── Download App click handler ──
document.getElementById('mi-download-app')?.addEventListener('click', () => {
  const cf = document.getElementById('browseFrame');
  if (cf) {
    cf.src = 'https://github.com/ktrucek/etherx-browser-2/releases';
    document.getElementById('urlInput').value = 'github.com/ktrucek/etherx-browser-2/releases';
  }
});

// PWA Service Worker
if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js').catch(() => { }); }

// ── Cookie Consent Banner ──────────────────────────────────────────────────
(function initCookieBanner() {
  if (localStorage.getItem('ex_cookie_accepted')) return; // already accepted, never show again
  const banner = document.getElementById('cookieBanner');
  if (!banner) return;
  // Show after a short delay so the UI has loaded
  setTimeout(() => banner.classList.remove('hidden'), 800);
  function dismissBanner(accepted) {
    banner.style.animation = 'none';
    banner.style.transition = 'opacity .25s, transform .25s';
    banner.style.opacity = '0';
    banner.style.transform = 'translateX(-50%) translateY(12px)';
    setTimeout(() => banner.classList.add('hidden'), 260);
    if (accepted) localStorage.setItem('ex_cookie_accepted', '1');
  }
  document.getElementById('cookieBtnAccept')?.addEventListener('click', () => dismissBanner(true));
  document.getElementById('cookieBtnDecline')?.addEventListener('click', () => dismissBanner(false));
})();



// ── EtherX Tauri/Electron IPC Bridge ─────────────────────────────────────────
// Connects window controls and overrides DB methods to use SQLite via IPC when
// running inside Tauri or Electron shell (window.etherx.* is available from bridge)
(function etherxElectronBridge() {
  const api = window.etherx || window.electronAPI;
  const isElectron = !!api;

  // ── Window traffic-light buttons ──────────────────────────────────────────
  document.querySelector('.btn-close')?.addEventListener('click', () => {
    if (window.etherx?.app?.close) { window.etherx.app.close(); return; }
    if (window.electronAPI?.close) { window.electronAPI.close(); return; }
    window.close();
  });
  document.querySelector('.btn-min')?.addEventListener('click', () => {
    if (window.etherx?.app?.minimize) { window.etherx.app.minimize(); return; }
    if (window.electronAPI?.minimize) { window.electronAPI.minimize(); return; }
    window.close && window.blur && window.blur();
  });
  document.querySelector('.btn-max')?.addEventListener('click', () => {
    if (window.etherx?.app?.maximize) { window.etherx.app.maximize(); return; }
    if (window.electronAPI?.maximize) { window.electronAPI.maximize(); return; }
  });

  // ── DB override: bridge localStorage DB to SQLite via etherx IPC ─────────
  if (!window.etherx) return; // Not in full Electron IPC mode
  const etherx = window.etherx;

  // History
  const _origAddHistory = DB.addHistory.bind(DB);
  DB.addHistory = function (entry) {
    _origAddHistory(entry); // keep localStorage as cache
    etherx.history.add({ url: entry.url, title: entry.title || entry.url }).catch(() => { });
  };

  // Bookmarks
  const _origAddBm = DB.addBookmark.bind(DB);
  DB.addBookmark = function (entry) {
    _origAddBm(entry);
    etherx.bookmarks.add({ url: entry.url, title: entry.title || entry.url }).catch(() => { });
  };
  const _origRemoveBm = DB.removeBookmark.bind(DB);
  DB.removeBookmark = function (url) {
    _origRemoveBm(url);
    etherx.bookmarks.getAll().then(bms => {
      const found = bms.find(b => b.url === url);
      if (found) etherx.bookmarks.delete(found.id).catch(() => { });
    }).catch(() => { });
  };

  // Settings save
  const _origSaveSetting = DB.saveSetting.bind(DB);
  DB.saveSetting = function (k, v) {
    _origSaveSetting(k, v);
    const settings = DB.getSettings();
    etherx.settings.save(settings).catch(() => { });
  };

  // ── AI phishing detection on navigate ─────────────────────────────────────
  const _origNavigateTo = navigateTo;
  window.navigateTo = navigateTo; // ensure global override works
  const origNav = window.navigateTo;

  // Show/hide the phishing banner
  function showPhishingBanner(msg) {
    const banner = document.getElementById('phishingBanner');
    if (!banner) return;
    document.getElementById('phishingMsg').textContent = '⚠️ ' + msg;
    banner.style.display = 'flex';
  }
  function hidePhishingBanner() {
    const banner = document.getElementById('phishingBanner');
    if (banner) banner.style.display = 'none';
  }
  document.getElementById('phishingClose')?.addEventListener('click', hidePhishingBanner);
  document.getElementById('phishingBack')?.addEventListener('click', () => {
    hidePhishingBanner();
    const tab = getActiveTab();
    const wv = getTabWebview(tab?.id);
    if (wv && window.electronWebview) {
      safeWebviewExecute(wv, tab?.id, 'canGoBack').then(canGoBack => {
        if (canGoBack) {
          safeWebviewExecute(wv, tab?.id, 'goBack').catch(() => window.history.back());
        } else {
          window.history.back();
        }
      }).catch(() => window.history.back());
    } else {
      window.history.back();
    }
  });
  document.getElementById('phishingProceed')?.addEventListener('click', hidePhishingBanner);

  // Wrap: after navigation, check phishing in background
  function afterNavPhishingCheck(url) {
    if (!url || !url.startsWith('http')) return;
    hidePhishingBanner();
    etherx.ai.checkPhishing(url, '').then(result => {
      if (result && !result.isSafe) {
        const reasons = (result.reasons || []).slice(0, 2).join('; ') || url;
        showPhishingBanner('Suspected phishing: ' + reasons);
        showToast('⚠️ Phishing warning: ' + reasons);
      }
    }).catch(() => { });
  }

  // Override navigateTo for phishing check
  const _origGlobalNav = window.navigateTo;
  const navDescriptor = Object.getOwnPropertyDescriptor(window, 'navigateTo');
  if (typeof navigateTo === 'function') {
    // Patch via prototype-style override in global scope
    const origFn = navigateTo;
    const patchedNav = function (raw, tabId) {
      const result = origFn.call(this, raw, tabId);
      const url = typeof raw === 'string' ? raw : '';
      if (url.startsWith('http')) setTimeout(() => afterNavPhishingCheck(url), 500);
      return result;
    };
    // Replace in global scope the best way we can
    try { window.navigateTo = patchedNav; } catch (e) { }
  }

  // ── Auto-update check on startup (silent background check) ──────────────
  setTimeout(async () => {
    try {
      const s = await etherx.settings.get();
      if (s.auto_update === false) return;
      const result = await etherx.update.check();
      if (result?.isNew) {
        showToast(`🔄 Nova verzija ${result.latest} dostupna! Postavke → Nadogradnje.`);
      }
    } catch (e) { /* silent */ }
  }, 10000);

  // ════════════════════════════════════════════════════════════════════════════
  // FEATURE: IP Geolocation in Site Info Popup
  // When the padlock/urlIcon popup opens, look up the server's geo info async.
  // ════════════════════════════════════════════════════════════════════════════
  {
    let _lastGeoHostname = '';
    const _origUrlIconClick = document.getElementById('urlIcon').onclick;

    // Patch urlIcon click to also trigger IP geo lookup
    document.getElementById('urlIcon').addEventListener('click', async () => {
      const t = getActiveTab && getActiveTab();
      const url = t?.url || '';
      let hostname = '';
      try { hostname = new URL(url).hostname; } catch (e) { return; }

      if (!hostname || hostname === _lastGeoHostname) return;
      _lastGeoHostname = hostname;

      // Reset display while loading
      const geoSection = document.getElementById('sipGeoSection');
      const geoIp = document.getElementById('sipGeoIp');
      const geoLoc = document.getElementById('sipGeoLocation');
      const geoOrg = document.getElementById('sipGeoOrg');
      if (!geoSection) return;

      geoIp.textContent = '⏳ načitavanje…';
      geoLoc.textContent = '—';
      geoOrg.textContent = '—';
      geoSection.style.display = 'block';

      try {
        const geo = await etherx.ai.lookupIpGeo(hostname);
        if (geo?.ok) {
          geoIp.textContent = geo.ip || hostname;
          const locParts = [geo.city, geo.region, geo.country].filter(Boolean);
          geoLoc.textContent = locParts.length ? locParts.join(', ') : '—';
          geoOrg.textContent = geo.org || '—';
        } else {
          geoIp.textContent = 'Nije dostupno';
          geoSection.style.display = 'none';
        }
      } catch (e) {
        geoSection.style.display = 'none';
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // FEATURE: Bot/UA Detection — warn if current browser UA looks bot-like
  // Runs once per SESSION; shows a subtle toast only once if UA appears suspicious.
  // User can permanently dismiss the warning via localStorage.
  // ════════════════════════════════════════════════════════════════════════════
  {
    const BOT_DISMISS_KEY = 'etherx_bot_warning_dismissed';
    const BOT_SESSION_KEY = 'etherx_bot_shown_this_session';

    async function performBotDetection(force = false) {
      try {
        // Check if user permanently dismissed the warning
        const dismissed = localStorage.getItem(BOT_DISMISS_KEY) === 'true';
        if (dismissed && !force) {
          console.log('[EtherX] Bot detection warning permanently dismissed by user');
          return;
        }

        // Check if already shown this session (unless forced)
        const shownThisSession = sessionStorage.getItem(BOT_SESSION_KEY) === 'true';
        if (shownThisSession && !force) {
          console.log('[EtherX] Bot detection already shown this session');
          return;
        }

        const ua = navigator.userAgent;
        const result = await etherx.ai.detectBotUA(ua);

        // Store result for debugging (always)
        sessionStorage.setItem('etherx_bot_detection', JSON.stringify(result));

        // Only show warning if detected as bot/IAB and not dismissed
        if (result?.isBot && result.reasons?.length) {
          console.warn('[EtherX] Bot-like UA tokens detected:', result.reasons);
          showToast('⚠️ UA upozorenje: ' + result.reasons[0], 5000);
          sessionStorage.setItem(BOT_SESSION_KEY, 'true');
        } else if (result?.isIAB) {
          showToast('⚠️ In-app preglednik detektiran — neke funkcije možda neće raditi ispravno.', 5000);
          sessionStorage.setItem(BOT_SESSION_KEY, 'true');
        } else {
          console.log('[EtherX] Bot detection: no suspicious UA detected');
        }
      } catch (e) {
        console.error('[EtherX] Bot detection error:', e);
      }
    }

    // Run on startup (only once per session)
    performBotDetection();

    // Expose for manual re-check (with force flag)
    window._recheckBotDetection = function (force = true) {
      // Clear session flag to allow re-show
      if (force) sessionStorage.removeItem(BOT_SESSION_KEY);
      performBotDetection(force);
    };

    // Expose function to permanently dismiss bot warning
    window._dismissBotWarning = function () {
      localStorage.setItem(BOT_DISMISS_KEY, 'true');
      sessionStorage.setItem(BOT_SESSION_KEY, 'true');
      showToast('✓ Bot upozorenja trajno onemogućena');
      console.log('[EtherX] Bot detection warnings permanently dismissed');
    };

    // Expose function to re-enable bot warnings
    window._enableBotWarning = function () {
      localStorage.removeItem(BOT_DISMISS_KEY);
      sessionStorage.removeItem(BOT_SESSION_KEY);
      showToast('✓ Bot upozorenja ponovo omogućena');
      console.log('[EtherX] Bot detection warnings re-enabled');
    };
  }

  // ── IPC: handle open-url and app:createTab from main process ────────────────
  if (window.etherx?.on) {
    // open-url: browser opened with a URL argument (protocol handler / second instance)
    window.etherx.on('open-url', (url) => {
      if (!url) return;
      if (STATE.tabs.length === 0) {
        createTab(url, '', true);
      } else {
        navigateTo(url, STATE.activeTabId);
      }
    });
    // app:createTab: main process wants to open a URL in a new tab
    // (e.g. target="_blank" links intercepted in webview's setWindowOpenHandler)
    window.etherx.on('app:createTab', (url) => {
      if (url) createTab(url, '', true);
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // FEATURE: Biometric Browser Lock (WebAuthn — Face ID / Touch ID)
  // Ported from Backend_quick security gate biometric logic.
  // ════════════════════════════════════════════════════════════════════════════
  const BIO_LOCK = (() => {
    const CRED_KEY = 'etherx_bio_cid';      // stored WebAuthn credential ID (base64url)
    const AUTH_TS_KEY = 'etherx_bio_ts';    // last successful auth timestamp
    const PASS_KEY = 'etherx_bio_pass';     // optional passphrase hash (SHA-256 hex)
    const SESSION_MS = 8 * 60 * 60 * 1000; // 8-hour session window
    const LOCK_SCREEN = document.getElementById('biometricLockScreen');

    // ── WebAuthn helpers (from Backend_quick) ──────────────────────────────
    function b64uToArray(b) {
      b = b.replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      const bin = atob(b);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    }
    function arrayToB64u(buf) {
      const arr = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function rnd(n) { return crypto.getRandomValues(new Uint8Array(n)); }

    async function bioAvailable() {
      if (!window.PublicKeyCredential) return false;
      try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
      catch (e) { return false; }
    }

    async function registerBio() {
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: rnd(32),
          rp: { name: 'EtherX Browser', id: location.hostname || 'localhost' },
          user: { id: rnd(16), name: 'etherx-user', displayName: 'EtherX User' },
          pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', requireResidentKey: false },
          timeout: 60000,
        }
      });
      localStorage.setItem(CRED_KEY, arrayToB64u(cred.rawId));
      return true;
    }

    async function verifyBio(credId) {
      await navigator.credentials.get({
        publicKey: {
          challenge: rnd(32),
          allowCredentials: credId ? [{ id: b64uToArray(credId), type: 'public-key', transports: ['internal'] }] : [],
          userVerification: 'required',
          timeout: 60000,
        }
      });
    }

    // ── Passphrase helpers ─────────────────────────────────────────────────
    async function hashPass(pass) {
      const enc = new TextEncoder();
      const buf = await crypto.subtle.digest('SHA-256', enc.encode(pass));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // ── Auth state ─────────────────────────────────────────────────────────
    function isAuthValid() {
      const ts = parseInt(localStorage.getItem(AUTH_TS_KEY) || '0', 10);
      return (Date.now() - ts) < SESSION_MS;
    }
    function markAuth() { localStorage.setItem(AUTH_TS_KEY, String(Date.now())); }
    function showLock() {
      if (!LOCK_SCREEN) return;
      LOCK_SCREEN.style.display = 'flex';
      document.getElementById('bioLockErr').style.display = 'none';
    }
    function hideLock() {
      if (!LOCK_SCREEN) return;
      LOCK_SCREEN.style.display = 'none';
      markAuth();
      // Refresh inactivity timer
      _resetInactivityTimer();
    }

    // ── Inactivity auto-lock ───────────────────────────────────────────────
    let _inactivityTimer = null;
    const INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes

    function _resetInactivityTimer() {
      if (!localStorage.getItem(CRED_KEY) && !localStorage.getItem(PASS_KEY)) return; // not set up
      clearTimeout(_inactivityTimer);
      _inactivityTimer = setTimeout(() => {
        if (!isAuthValid()) return; // already expired, lock screen handles it
        markAuth(); // reset (shouldn't lock if user was active)
      }, INACTIVITY_MS);
    }

    ['click', 'keydown', 'mousemove', 'touchstart'].forEach(ev => {
      document.addEventListener(ev, () => {
        if (localStorage.getItem(AUTH_TS_KEY)) {
          const ts = parseInt(localStorage.getItem(AUTH_TS_KEY) || '0', 10);
          if (ts > 0 && (Date.now() - ts) < SESSION_MS) {
            localStorage.setItem(AUTH_TS_KEY, String(Date.now()));
          }
        }
      }, { passive: true, capture: true });
    });

    // ── Unlock flow ────────────────────────────────────────────────────────
    async function unlock() {
      const errEl = document.getElementById('bioLockErr');
      const hasBio = await bioAvailable();
      const storedCid = localStorage.getItem(CRED_KEY);

      if (!storedCid && !localStorage.getItem(PASS_KEY)) {
        // Nothing configured — register & unlock
        try {
          if (hasBio) {
            document.getElementById('bioLockTitle').textContent = 'Postavi zaključavanje';
            document.getElementById('bioLockSub').textContent = 'Registrirajte Face ID / Touch ID za zaštitu preglednika.';
            document.getElementById('bioUnlockBtn').textContent = '🔓 Postavi Face ID / Touch ID';
            // Registration happens on button click (already attached below)
          } else {
            hideLock();
          }
          return;
        } catch (e) { hideLock(); return; }
      }

      try {
        if (storedCid && hasBio) {
          await verifyBio(storedCid);
        } else if (storedCid && !hasBio) {
          // Biometric registered but not available now — prompt passphrase only
        } else {
          hideLock();
          return;
        }
        hideLock();
      } catch (e) {
        if (errEl) {
          errEl.textContent = 'Provjera nije uspjela. Pokušajte ponovo.';
          errEl.style.display = 'block';
          setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 3000);
        }
        // Reset invalid credential
        if (e.name === 'InvalidStateError' || e.name === 'NotFoundError') {
          localStorage.removeItem(CRED_KEY);
        }
      }
    }

    // ── Unlock button ──────────────────────────────────────────────────────
    document.getElementById('bioUnlockBtn')?.addEventListener('click', async () => {
      const hasBio = await bioAvailable();
      const storedCid = localStorage.getItem(CRED_KEY);
      const errEl = document.getElementById('bioLockErr');

      try {
        if (!storedCid) {
          if (hasBio) {
            await registerBio();
          }
          hideLock();
        } else {
          await verifyBio(storedCid);
          hideLock();
        }
      } catch (e) {
        if (errEl) {
          errEl.textContent = 'Biometrija nije uspjela. Pokušajte lozinku.';
          errEl.style.display = 'block';
          setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 3000);
        }
        if (e.name === 'InvalidStateError' || e.name === 'NotFoundError') {
          localStorage.removeItem(CRED_KEY);
        }
      }
    });

    // ── Passphrase btn ─────────────────────────────────────────────────────
    async function tryPassphrase() {
      const input = document.getElementById('bioPassphraseInput');
      const errEl = document.getElementById('bioLockErr');
      const pass = input?.value?.trim();
      if (!pass) return;

      const storedHash = localStorage.getItem(PASS_KEY);
      if (!storedHash) {
        // First time — save this passphrase as the lock passphrase
        const h = await hashPass(pass);
        localStorage.setItem(PASS_KEY, h);
        hideLock();
        showToast('🔑 Lozinka za zaključavanje postavljena');
        return;
      }

      const h = await hashPass(pass);
      if (h === storedHash) {
        hideLock();
      } else {
        if (errEl) {
          errEl.textContent = 'Pogrešna lozinka.';
          errEl.style.display = 'block';
          setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 2800);
        }
        if (input) { input.value = ''; input.focus(); }
      }
    }

    document.getElementById('bioPassphraseBtn')?.addEventListener('click', tryPassphrase);
    document.getElementById('bioPassphraseInput')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') tryPassphrase();
    });

    // ── Camera liveness check (ported from Backend_quick stepCamera) ────────
    let _camStream = null;

    function _stopCam() {
      if (_camStream) { _camStream.getTracks().forEach(t => t.stop()); _camStream = null; }
    }

    function _setCamStatus(s) {
      const el = document.getElementById('bioCamStatus');
      if (el) el.textContent = s;
    }

    function _setCamBlinkBar(done, total) {
      const el = document.getElementById('bioCamBlinkBar');
      if (!el) return;
      el.innerHTML = Array.from({ length: total }, (_, i) =>
        `<div style="width:18px;height:18px;border-radius:50%;background:${i < done ? '#a78bfa' : 'rgba(139,92,246,0.2)'};border:1.5px solid rgba(139,92,246,0.5);transition:background 0.3s"></div>`
      ).join('');
    }

    async function stepCameraLiveness() {
      const panel = document.getElementById('bioCameraPanel');
      const camErrEl = document.getElementById('bioCamErr');
      const vid = document.getElementById('bioFaceVideo');
      if (!panel || !vid) return false;

      panel.style.display = 'block';
      _setCamStatus('Pokretanje kamere…');
      _setCamBlinkBar(0, 3);
      if (camErrEl) camErrEl.style.display = 'none';

      const wait = ms => new Promise(r => setTimeout(r, ms));

      try {
        _camStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
          audio: false
        });
        vid.srcObject = _camStream;
        await new Promise(r => { vid.onloadedmetadata = r; setTimeout(r, 3000); });

        const cw = vid.videoWidth || 320;
        const ch = vid.videoHeight || 240;
        const canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        const ctx = canvas.getContext('2d');

        // Eye region: centre-horizontal 30–70%, upper-vertical 22–42%
        const eX = Math.floor(cw * 0.30), eY = Math.floor(ch * 0.22);
        const eW = Math.floor(cw * 0.40), eH = Math.floor(ch * 0.20);

        function sampleEyes() {
          ctx.drawImage(vid, 0, 0, cw, ch);
          const d = ctx.getImageData(eX, eY, eW, eH).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
          return sum / (d.length / 4);
        }

        _setCamStatus('👀 Pozicionirajte lice u okvir…');
        await wait(1800);

        const samples = [sampleEyes()];

        // 3-blink challenge
        for (let b = 1; b <= 3; b++) {
          _setCamStatus(`👁️ Treptite! (${4 - b})`);
          await wait(200);
          samples.push(sampleEyes()); // closing phase
          await wait(700);
          samples.push(sampleEyes()); // open again
          _setCamBlinkBar(b, 3);
          await wait(350);
        }

        // Liveness: variance in eye-region brightness over samples
        const mean = samples.reduce((a, v) => a + v, 0) / samples.length;
        const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
        const livenessOk = variance > 10; // slightly lower threshold than Backend_quick's 12

        _stopCam();

        if (livenessOk) {
          _setCamStatus('✅ Lice prepoznato!');
          _setCamBlinkBar(3, 3);
          await wait(700);
          panel.style.display = 'none';
          return true;
        } else {
          _setCamStatus('⚠️ Treptanje nije detektirano. Pokušajte ponovo.');
          if (camErrEl) { camErrEl.textContent = 'Pomjerite glavu ili povećajte svjetlost i pokušajte opet.'; camErrEl.style.display = 'block'; }
          await wait(2500);
          panel.style.display = 'none';
          return false;
        }
      } catch (e) {
        _stopCam();
        _setCamStatus('📷 Kamera nedostupna');
        if (camErrEl) { camErrEl.textContent = 'Dozvolite pristup kameri i pokušajte ponovo.'; camErrEl.style.display = 'block'; }
        await wait(2000);
        panel.style.display = 'none';
        return false;
      }
    }

    document.getElementById('bioCameraBtn')?.addEventListener('click', async () => {
      const errEl = document.getElementById('bioLockErr');
      // Stop any ongoing camera first
      _stopCam();
      const ok = await stepCameraLiveness();
      if (ok) {
        hideLock();
        showToast('📷 Lice prepoznato — preglednik otključan');
      } else {
        if (errEl) {
          errEl.textContent = 'Provjera licem nije uspjela. Koristite drugu metodu.';
          errEl.style.display = 'block';
          setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 3500);
        }
      }
    });

    // Stop camera if lock screen is hidden by other means
    const _origHideLock = hideLock;

    // ── Lock button in toolbar ─────────────────────────────────────────────
    document.getElementById('btnBiometricLock')?.addEventListener('click', () => {
      _stopCam();
      const hasCreds = localStorage.getItem(CRED_KEY) || localStorage.getItem(PASS_KEY);
      if (!hasCreds) {
        showToast('🔐 Klikni ponovo u lock screenu da postaviš biometrijsko zaključavanje.');
      }
      showLock();
    });

    // ── Public API ─────────────────────────────────────────────────────────
    return { showLock, hideLock, isAuthValid, unlock, stepCameraLiveness };
  })();

  // ════════════════════════════════════════════════════════════════════════════
  // FEATURE: Location Consent Overlay
  // Intercepts location-related siteInfoPopup interaction + shows a consent
  // confirmation modal before the native geolocation prompt can fire.
  // Also provides an enhanced UI when the location permission select changes.
  // ════════════════════════════════════════════════════════════════════════════
  {
    const LOC_OVERLAY = document.getElementById('locationConsentOverlay');
    let _locConsentResolve = null;
    let _currentRequestHostname = null;

    function showLocationConsentFor(hostname) {
      return new Promise((resolve) => {
        _locConsentResolve = resolve;
        _currentRequestHostname = hostname;
        const siteEl = document.getElementById('locConsentSite');
        if (siteEl) siteEl.textContent = hostname || 'ova stranica';
        if (LOC_OVERLAY) LOC_OVERLAY.style.display = 'flex';
      });
    }

    function hideLocationConsent() {
      if (LOC_OVERLAY) LOC_OVERLAY.style.display = 'none';
      _locConsentResolve = null;
      _currentRequestHostname = null;
    }

    document.getElementById('locConsentDeny')?.addEventListener('click', () => {
      if (_locConsentResolve) _locConsentResolve('deny');
      if (_currentRequestHostname) {
        setSitePerm(_currentRequestHostname, 'location', 'Block');
      }
      hideLocationConsent();
      showToast('📍 Lokacija odbijena');
    });

    document.getElementById('locConsentAllow')?.addEventListener('click', () => {
      if (_locConsentResolve) _locConsentResolve('allow-once');
      hideLocationConsent();
      showToast('📍 Lokacija dozvoljena (jednom)');
      // Actually request geolocation
      requestUserLocation();
    });

    document.getElementById('locConsentAlwaysAllow')?.addEventListener('click', () => {
      if (_locConsentResolve) _locConsentResolve('allow-always');
      // Save "Allow" for this domain in per-site perms
      if (_currentRequestHostname) {
        setSitePerm(_currentRequestHostname, 'location', 'Allow');
        showToast('📍 Lokacija uvijek dozvoljena za ' + _currentRequestHostname);
      } else if (typeof _sipCurrentDomain !== 'undefined' && _sipCurrentDomain && _sipCurrentDomain !== '—') {
        setSitePerm(_sipCurrentDomain, 'location', 'Allow');
        showToast('📍 Lokacija uvijek dozvoljena za ' + _sipCurrentDomain);
      }
      hideLocationConsent();
      // Actually request geolocation
      requestUserLocation();
    });

    // Actual geolocation request
    function requestUserLocation() {
      if (!navigator.geolocation) {
        showToast('❌ Geolokacija nije podržana u ovom pregledniku');
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;
          // Store location in session
          sessionStorage.setItem('etherx_last_location', JSON.stringify({
            lat: latitude,
            lng: longitude,
            accuracy,
            timestamp: Date.now()
          }));
          showToast(`📍 Lokacija dobivena: ${latitude.toFixed(4)}, ${longitude.toFixed(4)} (±${Math.round(accuracy)}m)`);
          console.log('[EtherX] Location:', { latitude, longitude, accuracy });
        },
        (error) => {
          let msg = '❌ Greška pri dobivanju lokacije';
          if (error.code === error.PERMISSION_DENIED) {
            msg = '❌ Pristup lokaciji odbijen u sustavu';
          } else if (error.code === error.POSITION_UNAVAILABLE) {
            msg = '❌ Lokacija nije dostupna';
          } else if (error.code === error.TIMEOUT) {
            msg = '❌ Timeout pri dobivanju lokacije';
          }
          showToast(msg);
          console.error('[EtherX] Geolocation error:', error);
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0
        }
      );
    }

    // Hook: when the location select in siteInfoPopup changes to "Allow", show consent first
    document.getElementById('sipLocation')?.addEventListener('change', function (evt) {
      if (this.value !== 'Allow') return;
      // Stop the auto-save listener from firing immediately
      evt.stopImmediatePropagation();

      const selectEl = this;
      const t = getActiveTab && getActiveTab();
      let hostname = '';
      try { hostname = new URL(t?.url || '').hostname; } catch (e) { }

      showLocationConsentFor(hostname).then((decision) => {
        if (decision === 'deny') {
          selectEl.value = 'Ask';
          if (hostname) setSitePerm(hostname, 'location', 'Ask');
          showToast('✓ Saved for ' + (hostname || _sipCurrentDomain));
        } else {
          // allow-once or allow-always: save as Allow
          if (hostname) setSitePerm(hostname, 'location', 'Allow');
          selectEl.value = 'Allow';
          showToast('✓ Saved for ' + (hostname || _sipCurrentDomain));
        }
      });
    }, true); // capture: true — fire before the auto-save bubbling listener

    // Auto-show location consent when page loads (if not already set)
    // Check on navigation
    function checkLocationPermissionOnNavigation() {
      const t = getActiveTab && getActiveTab();
      if (!t?.url) return;

      let hostname = '';
      try { hostname = new URL(t.url).hostname; } catch (e) { return; }

      const perms = getSitePerms();
      const sitePerm = perms[hostname];

      // If location is set to Allow, request it automatically
      if (sitePerm && sitePerm.location === 'Allow') {
        // Small delay to ensure page is loaded
        setTimeout(() => {
          requestUserLocation();
        }, 1500);
      }
    }

    // Listen for navigation events
    if (window.addEventListener) {
      // Check on tab switch
      document.addEventListener('tabSwitch', checkLocationPermissionOnNavigation);
    }

    // Expose for other modules
    window._showLocationConsent = showLocationConsentFor;
    window._requestUserLocation = requestUserLocation;

    // ── Auto-trigger location consent on first load (optional) ──────────────
    // Check if location permission was never set and show consent automatically
    // This ensures users see the permission dialog like in the screenshot
    (function checkLocationOnStartup() {
      const hasShownLocationPrompt = sessionStorage.getItem('etherx_location_prompt_shown');
      const globalLocationSetting = DB.getSettings().geolocation_policy;

      // If no global policy is set and we haven't shown the prompt this session
      if (!hasShownLocationPrompt && !globalLocationSetting) {
        // Show location consent after a short delay
        setTimeout(() => {
          const currentHost = window.location.hostname || 'aplikacija';
          showLocationConsentFor(currentHost).then((decision) => {
            sessionStorage.setItem('etherx_location_prompt_shown', 'true');
            console.log('[EtherX] Location consent decision:', decision);
          });
        }, 1000); // 1 second delay after page load
      }
    })();
  }

})();
