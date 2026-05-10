/**
 * EtherX Browser — Tauri API Bridge
 * Zamjenjuje Electron preload.js / window.electronAPI / window.etherx
 * Sve funkcije preslikane 1:1 s originalnog Electron preloada
 * 
 * U Tauri-u nema preload skripte — ova datoteka se učitava kao normalni JS.
 * Koristi @tauri-apps/api/core za invoke() pozive prema Rust backendu.
 */

(function () {
    'use strict';

    // Tauri v2 API — dostupno globalno u WebViewWindow
    const { invoke, event } = window.__TAURI__ || {};

    if (!invoke) {
        console.warn('[EtherX] Tauri API nije dostupno — možda web preview mode?');
        // Postavi mock za web development mode
        window.electronAPI = _createMockAPI();
        window.etherx = _createMockAPI();
        return;
    }

    // ── Tauri-specifične window kontrole ──────────────────────────────────────
    async function minimize() {
        const { getCurrentWindow } = window.__TAURI__.window;
        await getCurrentWindow().minimize();
    }
    async function maximize() {
        const { getCurrentWindow } = window.__TAURI__.window;
        const win = getCurrentWindow();
        if (await win.isMaximized()) {
            await win.unmaximize();
        } else {
            await win.maximize();
        }
    }
    async function closeWindow() {
        const { getCurrentWindow } = window.__TAURI__.window;
        await getCurrentWindow().close();
    }

    // ── Tab WebviewWindow management ──────────────────────────────────────────
    // Svaki browser tab = zasebni Tauri WebviewWindow
    const { WebviewWindow } = window.__TAURI__?.webviewWindow || {};

    async function createTabWindow(tabId, url) {
        if (!WebviewWindow) return null;
        const win = new WebviewWindow(`tab-${tabId}`, {
            url: url,
            visible: false,
            decorations: false,
            width: 0,
            height: 0,
        });
        return win;
    }

    // ── SQL Plugin (direktni pristup) ─────────────────────────────────────────
    let _db = null;
    async function getDb() {
        if (_db) return _db;
        const { Database } = window.__TAURI__?.sql || {};
        if (Database) {
            _db = await Database.load('sqlite:etherx.db');
        }
        return _db;
    }

    let _pwDb = null;
    async function getPwDb() {
        if (_pwDb) return _pwDb;
        const { Database } = window.__TAURI__?.sql || {};
        if (Database) {
            _pwDb = await Database.load('sqlite:etherx_passwords.db');
        }
        return _pwDb;
    }

    // ── electronAPI (backward compat) ─────────────────────────────────────────
    window.electronAPI = {
        minimize,
        maximize,
        close: closeWindow,
        platform: 'tauri',
        windowId: () => 'main',
        invoke: (channel, ...args) => _legacyInvoke(channel, args),
    };

    // ── Mapiranje starih IPC kanala → Tauri commands ──────────────────────────
    async function _legacyInvoke(channel, args) {
        const map = {
            'window-minimize':        () => minimize(),
            'window-maximize':        () => maximize(),
            'window-close':           () => closeWindow(),
            'nav:openExternal':       () => invoke('open_external', { url: args[0] }),
            'adblock:isEnabled':      () => invoke('ab_is_enabled'),
            'adblock:toggle':         () => invoke('ab_toggle', { enabled: args[0] }),
            'adblock:stats':          () => invoke('ab_get_stats'),
            'security:getCertInfo':   () => invoke('sec_get_cert_info', { url: args[0] }),
            'passwords:setupVault':   () => invoke('pm_setup', { masterPassword: args[0] }),
            'passwords:unlockVault':  () => invoke('pm_unlock', { masterPassword: args[0], saltHex: args[1] || '' }),
            'passwords:lockVault':    () => invoke('pm_lock'),
            'passwords:list':         () => invoke('pm_get_entries'),
            'passwords:delete':       () => invoke('pm_delete_entry', { id: args[0] }),
            'passwords:exportBitwarden': () => invoke('pm_export_bitwarden'),
            'qrsync:generate':        () => invoke('qr_generate', { data: args[0] }),
        };
        const fn = map[channel];
        return fn ? fn() : Promise.resolve(null);
    }

    // ── Glavni etherx API objekt ──────────────────────────────────────────────
    window.etherx = {

        // ── Window ─────────────────────────────────────────────────────────────
        window: { minimize, maximize, close: closeWindow },

        // ── Navigation ──────────────────────────────────────────────────────────
        nav: {
            openExternal: (url) => invoke('open_external', { url }),
        },

        // ── Tabs ────────────────────────────────────────────────────────────────
        tabs: {
            save: async (tab) => {
                const db = await getDb();
                if (!db) return;
                await db.execute(
                    `INSERT OR REPLACE INTO tabs (id, url, title, favicon, tab_order, is_active, scroll_x, scroll_y, is_pinned, group_name, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, strftime('%s','now'))`,
                    [tab.id, tab.url, tab.title || '', tab.favicon || '', tab.order || 0,
                     tab.isActive ? 1 : 0, tab.scrollX || 0, tab.scrollY || 0,
                     tab.isPinned ? 1 : 0, tab.groupName || null]
                );
            },
            getAll: async () => {
                const db = await getDb();
                if (!db) return [];
                return await db.select('SELECT * FROM tabs ORDER BY tab_order ASC');
            },
            delete: async (tabId) => {
                const db = await getDb();
                if (!db) return;
                await db.execute('DELETE FROM tabs WHERE id = $1', [tabId]);
            },
            clearIncognito: async () => { /* RAM only — ništa za brisati iz DB */ },
            updateOrder: async (tabs) => {
                const db = await getDb();
                if (!db) return;
                for (const tab of tabs) {
                    await db.execute('UPDATE tabs SET tab_order = $1 WHERE id = $2', [tab.order, tab.id]);
                }
            },
        },

        // ── Sessions ────────────────────────────────────────────────────────────
        sessions: {
            save: async (data) => {
                const db = await getDb();
                if (!db) return;
                await db.execute(
                    'INSERT INTO sessions (name, tabs_json, active_tab) VALUES ($1, $2, $3)',
                    [data.name || 'Auto-save', JSON.stringify(data.tabs), data.activeTab || null]
                );
            },
            get: async (limit = 10) => {
                const db = await getDb();
                if (!db) return [];
                return await db.select('SELECT * FROM sessions ORDER BY created_at DESC LIMIT $1', [limit]);
            },
            delete: async (id) => {
                const db = await getDb();
                if (!db) return;
                await db.execute('DELETE FROM sessions WHERE id = $1', [id]);
            },
        },

        // ── Downloads ────────────────────────────────────────────────────────────
        downloads: {
            add: async (data) => {
                const db = await getDb();
                if (!db) return;
                await db.execute(
                    'INSERT INTO downloads (url, filename, save_path, file_size, mime_type, status) VALUES ($1,$2,$3,$4,$5,$6)',
                    [data.url, data.filename || '', data.savePath || '', data.fileSize || 0, data.mimeType || '', data.status || 'completed']
                );
            },
            get: async (limit = 50) => {
                const db = await getDb();
                if (!db) return [];
                return await db.select('SELECT * FROM downloads ORDER BY created_at DESC LIMIT $1', [limit]);
            },
            clear: async () => {
                const db = await getDb();
                if (!db) return;
                await db.execute('DELETE FROM downloads');
            },
        },

        // ── History ──────────────────────────────────────────────────────────────
        history: {
            add: async (entry) => {
                const db = await getDb();
                if (!db) return;
                const existing = await db.select('SELECT id, visit_count FROM history WHERE url = $1', [entry.url]);
                if (existing.length > 0) {
                    await db.execute(
                        'UPDATE history SET visit_count = visit_count + 1, title = $1, last_visited = strftime(\'%s\',\'now\') WHERE url = $2',
                        [entry.title || '', entry.url]
                    );
                } else {
                    await db.execute(
                        'INSERT INTO history (url, title, favicon) VALUES ($1, $2, $3)',
                        [entry.url, entry.title || '', entry.favicon || '']
                    );
                }
            },
            get: async (opts = {}) => {
                const db = await getDb();
                if (!db) return [];
                const limit = opts.limit || 200;
                if (opts.query) {
                    return await db.select(
                        'SELECT * FROM history WHERE url LIKE $1 OR title LIKE $1 ORDER BY last_visited DESC LIMIT $2',
                        [`%${opts.query}%`, limit]
                    );
                }
                return await db.select('SELECT * FROM history ORDER BY last_visited DESC LIMIT $1', [limit]);
            },
            getAll: async () => {
                const db = await getDb();
                if (!db) return [];
                return await db.select('SELECT * FROM history ORDER BY last_visited DESC LIMIT 500');
            },
            clear: async () => {
                const db = await getDb();
                if (!db) return;
                await db.execute('DELETE FROM history');
            },
        },

        // ── Bookmarks ────────────────────────────────────────────────────────────
        bookmarks: {
            add: async (bm) => {
                const db = await getDb();
                if (!db) return;
                const id = crypto.randomUUID();
                await db.execute(
                    'INSERT OR REPLACE INTO bookmarks (id, url, title, favicon, folder, description) VALUES ($1,$2,$3,$4,$5,$6)',
                    [id, bm.url, bm.title || '', bm.favicon || '', bm.folder || 'Bookmarks Bar', bm.description || '']
                );
                return { id };
            },
            getAll: async () => {
                const db = await getDb();
                if (!db) return [];
                return await db.select('SELECT * FROM bookmarks ORDER BY folder, created_at ASC');
            },
            delete: async (id) => {
                const db = await getDb();
                if (!db) return;
                await db.execute('DELETE FROM bookmarks WHERE id = $1', [id]);
            },
            update: async (bm) => {
                const db = await getDb();
                if (!db) return;
                await db.execute(
                    'UPDATE bookmarks SET title = $1, url = $2, folder = $3 WHERE id = $4',
                    [bm.title, bm.url, bm.folder || 'Bookmarks Bar', bm.id]
                );
            },
        },

        // ── Settings ─────────────────────────────────────────────────────────────
        settings: {
            get: async () => {
                const db = await getDb();
                if (!db) return {};
                const rows = await db.select('SELECT key, value FROM settings');
                const result = {};
                for (const row of rows) result[row.key] = row.value;
                return result;
            },
            save: async (settings) => {
                const db = await getDb();
                if (!db) return;
                for (const [key, value] of Object.entries(settings)) {
                    await invoke('db_set_setting', { key, value: String(value) });
                    await db.execute(
                        'INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)',
                        [key, String(value)]
                    );
                }
            },
            applyDoH: async (enabled) => { /* Tauri WebKit koristi sistemski DNS */ },
        },

        // ── User Profile ─────────────────────────────────────────────────────────
        userProfile: {
            get: async () => {
                const db = await getDb();
                if (!db) return {};
                const rows = await db.select('SELECT key, value FROM user_profile');
                const result = {};
                for (const row of rows) result[row.key] = row.value;
                return result;
            },
            save: async (data) => {
                const db = await getDb();
                if (!db) return;
                for (const [key, value] of Object.entries(data)) {
                    await db.execute(
                        'INSERT OR REPLACE INTO user_profile (key, value) VALUES ($1, $2)',
                        [key, String(value)]
                    );
                }
            },
        },

        // ── Passwords ────────────────────────────────────────────────────────────
        passwords: {
            setupVault: (masterPassword) => invoke('pm_setup', { masterPassword }),
            unlockVault: (masterPassword, saltHex) => invoke('pm_unlock', { masterPassword, saltHex: saltHex || '' }),
            lockVault: () => invoke('pm_lock'),
            isUnlocked: () => invoke('pm_is_unlocked'),
            addEntry: (entry) => invoke('pm_add_entry', { entry }),
            updateEntry: (id, entry) => invoke('pm_update_entry', { id, entry }),
            deleteEntry: (id) => invoke('pm_delete_entry', { id }),
            decryptEntry: (encryptedHex, ivHex) => invoke('pm_decrypt_entry', { encryptedHex, ivHex }),
            generatePassword: (opts) => invoke('pm_generate_password', opts || {}),
            exportBitwarden: () => invoke('pm_export_bitwarden'),
            importBitwarden: (json) => invoke('pm_import_bitwarden', { json }),
            changeMasterPassword: (oldPassword, newPassword, saltHex) =>
                invoke('pm_change_master_password', { oldPassword, newPassword, saltHex }),
            // DB access za vault entries (šifrirani blobs)
            saveEncrypted: async (id, site, username, encryptedHex, ivHex) => {
                const db = await getPwDb();
                if (!db) return;
                await db.execute(
                    `CREATE TABLE IF NOT EXISTS vault_entries (
                        id TEXT PRIMARY KEY, site TEXT NOT NULL, username TEXT NOT NULL,
                        encrypted TEXT NOT NULL, iv TEXT NOT NULL,
                        created_at INTEGER DEFAULT (strftime('%s','now')),
                        updated_at INTEGER DEFAULT (strftime('%s','now'))
                    )`,
                    []
                );
                await db.execute(
                    'INSERT OR REPLACE INTO vault_entries (id, site, username, encrypted, iv) VALUES ($1,$2,$3,$4,$5)',
                    [id, site, username, encryptedHex, ivHex]
                );
            },
            getVaultMeta: async () => {
                const db = await getPwDb();
                if (!db) return null;
                const rows = await db.select('SELECT * FROM vault_meta WHERE id = ?', ['default']).catch(() => []);
                return rows[0] || null;
            },
            saveVaultMeta: async (saltHex) => {
                const db = await getPwDb();
                if (!db) return;
                await db.execute(
                    `CREATE TABLE IF NOT EXISTS vault_meta (
                        id TEXT PRIMARY KEY DEFAULT 'default',
                        salt TEXT NOT NULL,
                        iterations INTEGER NOT NULL DEFAULT 600000,
                        created_at INTEGER DEFAULT (strftime('%s','now'))
                    )`,
                    []
                );
                await db.execute(
                    'INSERT OR REPLACE INTO vault_meta (id, salt, iterations) VALUES (\'default\', $1, 600000)',
                    [saltHex]
                );
            },
            listEntries: async () => {
                const db = await getPwDb();
                if (!db) return [];
                return await db.select(
                    'SELECT id, site, username, encrypted, iv, created_at FROM vault_entries ORDER BY site'
                ).catch(() => []);
            },
            deleteEntryDb: async (id) => {
                const db = await getPwDb();
                if (!db) return;
                await db.execute('DELETE FROM vault_entries WHERE id = $1', [id]);
            },
        },

        // ── Ad Blocker ────────────────────────────────────────────────────────────
        adblock: {
            isEnabled: () => invoke('ab_is_enabled'),
            toggle: (enabled) => invoke('ab_toggle', { enabled }),
            stats: () => invoke('ab_get_stats'),
            checkUrl: (url, sourceUrl, requestType) =>
                invoke('ab_check_url', { url, sourceUrl: sourceUrl || '', requestType: requestType || 'other' }),
        },

        // ── Security ──────────────────────────────────────────────────────────────
        security: {
            checkUrl: (url) => invoke('sec_check_url', { url }),
            getCertInfo: (url) => invoke('sec_get_cert_info', { url }),
            upgradeHttp: (url) => invoke('sec_upgrade_http', { url }),
        },

        // ── AI ───────────────────────────────────────────────────────────────────
        // AI pozivi ostaju kao fetch() pozivi prema vanjskim API-jima
        ai: {
            smartSearch: async (query) => {
                // Osnovna heuristika — ista logika kao ai.js na frontendu
                const isUrl = /^https?:\/\//.test(query) || /^[a-z0-9-]+\.[a-z]{2,}/.test(query);
                return { isUrl, query };
            },
            checkPhishing: (url) => invoke('sec_check_url', { url }),
            summarizePage: async (url, html) => {
                // Gemini API poziv — isti kao u browser.js
                const settings = await window.etherx.settings.get();
                const apiKey = settings.gemini_api_key;
                if (!apiKey) return { ok: false, error: 'No API key' };
                // Frontend fetch prema Gemini API
                return { ok: true, apiKey, url };
            },
        },

        // ── User Agent ────────────────────────────────────────────────────────────
        userAgent: {
            get: () => invoke('get_user_agent'),
            set: (ua, label = 'main') => invoke('set_user_agent', { label, ua }),
        },

        // ── QR Sync ───────────────────────────────────────────────────────────────
        qrSync: {
            generate: (data) => invoke('qr_generate', { data }),
            decode: (encoded) => invoke('qr_decode', { encoded }),
            exportProfile: async () => {
                const [settings, bookmarks, profile] = await Promise.all([
                    window.etherx.settings.get(),
                    window.etherx.bookmarks.getAll(),
                    window.etherx.userProfile.get(),
                ]);
                return { settings, bookmarks, profile, version: '2.4.131' };
            },
            importProfile: async (data) => {
                if (data.settings) await window.etherx.settings.save(data.settings);
                if (data.bookmarks) {
                    for (const bm of data.bookmarks) await window.etherx.bookmarks.add(bm);
                }
                return { ok: true };
            },
        },

        // ── Clipboard ─────────────────────────────────────────────────────────────
        clipboard: {
            write: async (text) => {
                const { writeText } = window.__TAURI__?.clipboardManager || {};
                if (writeText) await writeText(text);
                else await navigator.clipboard.writeText(text).catch(() => {});
            },
            read: async () => {
                const { readText } = window.__TAURI__?.clipboardManager || {};
                if (readText) return await readText();
                return await navigator.clipboard.readText().catch(() => '');
            },
        },

        // ── Default Browser ───────────────────────────────────────────────────────
        defaultBrowser: {
            check: async () => ({ isDefault: false }),
            set: async () => ({ ok: false, note: 'Use system settings to set default browser' }),
        },

        // ── i18n ──────────────────────────────────────────────────────────────────
        i18n: {
            getStrings: async (lang) => {
                // Čita lokalne JSON datoteke direktno
                try {
                    const res = await fetch(`/locales/${lang}.json`);
                    return await res.json();
                } catch { return {}; }
            },
            setLanguage: async (lang) => {
                await window.etherx.settings.save({ language: lang });
            },
            getAvailableLanguages: async () => {
                return ['hr', 'en', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'zh', 'ja', 'ar'];
            },
        },

        // ── Downloads (file system) ───────────────────────────────────────────────
        fs: {
            openFile: (path) => invoke('dl_open_file', { path }),
            openFolder: (path) => invoke('dl_open_folder', { path }),
        },

        // ── Network monitoring (Tauri nema web request interceptor kao Electron) ──
        network: {
            getLog: async () => [],
            clearLog: async () => {},
            onUpdate: (callback) => {},
        },

        // ── Notes ─────────────────────────────────────────────────────────────────
        notes: {
            add: async (data) => {
                const db = await getDb();
                if (!db) return;
                await db.execute(
                    'INSERT INTO notes (title, content, url) VALUES ($1, $2, $3)',
                    [data.title || '', data.content || '', data.url || '']
                );
            },
            get: async () => {
                const db = await getDb();
                if (!db) return [];
                return await db.select('SELECT * FROM notes ORDER BY updated_at DESC').catch(() => []);
            },
            update: async (id, data) => {
                const db = await getDb();
                if (!db) return;
                await db.execute(
                    'UPDATE notes SET title = $1, content = $2, updated_at = strftime(\'%s\',\'now\') WHERE id = $3',
                    [data.title, data.content, id]
                );
            },
            delete: async (id) => {
                const db = await getDb();
                if (!db) return;
                await db.execute('DELETE FROM notes WHERE id = $1', [id]);
            },
        },

        // ── Update ────────────────────────────────────────────────────────────────
        update: {
            check: async () => ({ available: false }),
            download: async () => ({ ok: false }),
            install: async () => ({ ok: false }),
        },

        // ── Cast / Share ──────────────────────────────────────────────────────────
        cast: { getDevices: async () => [] },
        share: {
            shareUrl: async (url, title) => {
                await window.etherx.clipboard.write(url);
                return { ok: true, note: 'URL copied to clipboard' };
            },
            savePageAs: async (url, title) => ({ ok: false, note: 'Use browser save dialog' }),
        },

        // ── Cookies ───────────────────────────────────────────────────────────────
        cookies: {
            getAll: async (url) => [],
            remove: async (url, name) => ({ ok: false }),
            clearAll: async () => ({ ok: false, note: 'WebKit manages cookies internally' }),
        },
    };

    // ── Event listeners (Tauri events) ───────────────────────────────────────
    if (event) {
        // Prosljeđuje Tauri evente na window
        event.listen('download-update', (e) => {
            window.dispatchEvent(new CustomEvent('etherx:download-update', { detail: e.payload }));
        });
        event.listen('open-url', (e) => {
            window.dispatchEvent(new CustomEvent('etherx:open-url', { detail: e.payload }));
        });
    }

    // ── Mock API za web development mode ─────────────────────────────────────
    function _createMockAPI() {
        const noop = async () => {};
        return new Proxy({}, {
            get: (_, prop) => {
                return new Proxy(() => Promise.resolve(null), {
                    apply: () => Promise.resolve(null),
                    get: (_, p2) => () => Promise.resolve(null),
                });
            }
        });
    }

    console.log('[EtherX] Tauri Bridge v2.4.131 — ready');
})();
