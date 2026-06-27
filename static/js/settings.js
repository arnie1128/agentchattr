// settings.js -- settings panel + clear-chat confirm (Tier-B feature panel,
// extracted from chat.js). Loaded after channels.js (whose switchChannel/
// filterMessagesByChannel/renderChannelTabs it calls) and before chat.js.
// Reads chat.js locals (ws) and Store keys via the shared classic-script
// global scope; pendingChannelSwitch is owned here (channels.js writes it
// via window._setPendingChannelSwitch).

let pendingChannelSwitch = null;
window._setPendingChannelSwitch = function(v) { pendingChannelSwitch = v; };

function applySettings(data) {
    if (data.title) {
        document.getElementById('room-title').textContent = data.title;
        document.title = data.title;
    }
    if (data.username) {
        Store.set('username', data.username);
        document.getElementById('sender-label').textContent = Store.get('username');
        document.getElementById('setting-username').value = Store.get('username');
    }
    if (data.font) {
        document.body.classList.remove('font-mono', 'font-serif', 'font-sans');
        document.body.classList.add('font-' + data.font);
        document.getElementById('setting-font').value = data.font;
    }
    if (data.max_agent_hops !== undefined) {
        document.getElementById('setting-hops').value = data.max_agent_hops;
    }
    if (data.history_limit !== undefined) {
        document.getElementById('setting-history').value = String(data.history_limit);
    }
    if (data.contrast) {
        document.body.classList.toggle('high-contrast', data.contrast === 'high');
        document.getElementById('setting-contrast').value = data.contrast;
    }
    if (data.theme) {
        document.body.classList.toggle('theme-purple', data.theme === 'purple');
        const themeEl = document.getElementById('setting-theme');
        if (themeEl) themeEl.value = data.theme;
    }
    if (data.ui_scale !== undefined) {
        const v = String(data.ui_scale);
        document.documentElement.style.setProperty('--scale-ui', v);
        const el = document.getElementById('setting-ui-scale');
        if (el) el.value = v;
    }
    if (data.chat_scale !== undefined) {
        const v = String(data.chat_scale);
        document.documentElement.style.setProperty('--scale-chat', v);
        const el = document.getElementById('setting-chat-scale');
        if (el) el.value = v;
    }
    if (data.rules_refresh_interval !== undefined) {
        document.getElementById('setting-rules-refresh').value = String(data.rules_refresh_interval);
    }
    if (Array.isArray(data.custom_roles)) {
        window.customRoles = data.custom_roles;
    }
    if (data.channels && Array.isArray(data.channels)) {
        Store.set('channelList', data.channels);
        // If active channel was deleted, switch to general
        if (!Store.get('channelList').includes(activeChannel)) {
            Store.set('activeChannel', 'general');
            filterMessagesByChannel();
        }
        renderChannelTabs();

        if (pendingChannelSwitch && Store.get('channelList').includes(pendingChannelSwitch)) {
            const name = pendingChannelSwitch;
            pendingChannelSwitch = null;
            switchChannel(name);
        }
    }
}

function toggleSettings() {
    const bar = document.getElementById('settings-bar');
    bar.classList.toggle('hidden');
    document.getElementById('settings-toggle').classList.toggle('active', !bar.classList.contains('hidden'));
    if (!bar.classList.contains('hidden')) {
        document.getElementById('setting-username').focus();
    }
}

function _clearClearChatConfirm() {
    const btn = document.getElementById('clear-chat-btn');
    const confirmEl = document.getElementById('clear-chat-confirm');
    if (confirmEl) confirmEl.remove();
    if (btn) {
        btn.textContent = 'Clear Chat';
        btn.classList.remove('confirming');
    }
    document.removeEventListener('click', _clearChatOutsideClick, true);
}

function _clearChatOutsideClick(e) {
    const btn = document.getElementById('clear-chat-btn');
    const confirmEl = document.getElementById('clear-chat-confirm');
    if (!btn || !confirmEl) return;
    if (!btn.contains(e.target) && !confirmEl.contains(e.target)) {
        _clearClearChatConfirm();
    }
}

function clearChat() {
    const btn = document.getElementById('clear-chat-btn');
    if (!btn) return;

    // Second click -> execute. First click -> inline confirm, matching the
    // End Session pattern elsewhere.
    if (btn.classList.contains('confirming')) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            wsClient.send('message', { text: '/clear', sender: Store.get('username'), channel: activeChannel });
        }
        _clearClearChatConfirm();
        document.getElementById('settings-bar').classList.add('hidden');
        return;
    }

    btn.textContent = 'Clear Chat?';
    btn.classList.add('confirming');

    const confirmWrap = document.createElement('span');
    confirmWrap.id = 'clear-chat-confirm';
    confirmWrap.className = 'session-inline-confirm';
    confirmWrap.innerHTML = `
        <button class="session-inline-confirm-yes ch-confirm-yes" title="Confirm clear chat">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5 6.5-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="session-inline-confirm-no ch-confirm-no" title="Cancel">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
    `;
    btn.parentElement.insertBefore(confirmWrap, btn);

    confirmWrap.querySelector('.ch-confirm-yes').onclick = (e) => {
        e.stopPropagation();
        if (ws && ws.readyState === WebSocket.OPEN) {
            wsClient.send('message', { text: '/clear', sender: Store.get('username'), channel: activeChannel });
        }
        _clearClearChatConfirm();
        document.getElementById('settings-bar').classList.add('hidden');
    };
    confirmWrap.querySelector('.ch-confirm-no').onclick = (e) => {
        e.stopPropagation();
        _clearClearChatConfirm();
    };

    setTimeout(() => document.addEventListener('click', _clearChatOutsideClick, true), 0);
}

function saveSettings() {
    const newUsername = document.getElementById('setting-username').value.trim();
    const newFont = document.getElementById('setting-font').value;
    const newHops = document.getElementById('setting-hops').value;
    const histVal = document.getElementById('setting-history').value;
    const newHistory = histVal === 'all' ? 'all' : (parseInt(histVal) || 50);
    const newContrast = document.getElementById('setting-contrast').value;
    const newRulesRefresh = document.getElementById('setting-rules-refresh').value;
    const themeEl = document.getElementById('setting-theme');
    const uiScaleEl = document.getElementById('setting-ui-scale');
    const chatScaleEl = document.getElementById('setting-chat-scale');
    const newTheme = themeEl ? themeEl.value : 'neutral';
    const newUiScale = uiScaleEl ? parseFloat(uiScaleEl.value) : 1.25;
    const newChatScale = chatScaleEl ? parseFloat(chatScaleEl.value) : 1.5;

    if (ws && ws.readyState === WebSocket.OPEN) {
        wsClient.send('update_settings', {
            data: {
                username: newUsername || 'user',
                font: newFont,
                max_agent_hops: parseInt(newHops) || 4,
                history_limit: newHistory,
                contrast: newContrast,
                theme: newTheme,
                ui_scale: newUiScale,
                chat_scale: newChatScale,
                rules_refresh_interval: parseInt(newRulesRefresh) || 0,
            }
        });
    }
}

function setupSettingsKeys() {
    // Auto-save on blur/Enter for text/number fields
    for (const id of ['setting-username', 'setting-hops']) {
        const el = document.getElementById(id);
        el.addEventListener('blur', () => saveSettings());
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                el.blur();
            }
            if (e.key === 'Escape') {
                toggleSettings();
            }
        });
    }

    // Auto-save on change for selects, escape to close
    const selectIds = [
        'setting-font', 'setting-history', 'setting-contrast', 'setting-rules-refresh',
        'setting-theme', 'setting-ui-scale', 'setting-chat-scale',
    ];
    for (const id of selectIds) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.addEventListener('change', () => {
            // Apply visual settings immediately (don't wait for server round-trip)
            if (id === 'setting-contrast') {
                document.body.classList.toggle('high-contrast', el.value === 'high');
            } else if (id === 'setting-theme') {
                document.body.classList.toggle('theme-purple', el.value === 'purple');
            } else if (id === 'setting-ui-scale') {
                document.documentElement.style.setProperty('--scale-ui', el.value);
            } else if (id === 'setting-chat-scale') {
                document.documentElement.style.setProperty('--scale-chat', el.value);
            }
            saveSettings();
        });
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                toggleSettings();
            }
        });
    }
}

// --- Exports for chat.js (init/WS handlers) and index.html inline onclicks ---
window.applySettings = applySettings;
window.toggleSettings = toggleSettings;
window.clearChat = clearChat;
window.setupSettingsKeys = setupSettingsKeys;
