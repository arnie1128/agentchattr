// naming-lightbox.js -- agent naming modal + pill popover (rename / role /
// color). Tier-B feature panel extracted from chat.js. Loaded before chat.js.
// Calls back into chat.js for roles (_setRole/_deleteCustomRole, Store key
// 'agentRoles', ROLE_PRESETS) and recolor (recolorMessages/buildMentionToggles)
// via the shared classic-script global scope; chat.js drives it via the
// window.* exports at the bottom (buildStatusPills -> showPillPopover, the WS
// name-prompt handler -> _pendingNameQueue/_showNextPendingName, Escape ->
// _closeAgentNameModal). showAgentNameModal has no callers (superseded by the
// pill popover) -- kept as-is, not deleted.

// --- Agent naming lightbox ---

const _pendingNameQueue = [];
let _nameModalActive = false;

function _showNextPendingName() {
    if (_nameModalActive || _pendingNameQueue.length === 0) return;
    const next = _pendingNameQueue.shift();
    // Only show if still pending in agentConfig
    const cfg = Store.get('agentConfig')[next.name];
    if (cfg && cfg.state === 'pending') {
        const pillEl = document.getElementById(`status-${next.name}`);
        showPillPopover(pillEl || null, { ...next, mode: 'pending' });
    } else {
        _showNextPendingName(); // skip stale entries
    }
}

function showAgentNameModal(opts) {
    // opts: { name, label, color, base, mode: 'pending' | 'rename' }
    _nameModalActive = true;
    let modal = document.getElementById('agent-name-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'agent-name-modal';
        modal.className = 'agent-name-modal hidden';
        modal.innerHTML = `
            <div class="agent-name-dialog">
                <div class="agent-name-header">
                    <div class="agent-name-avatar"></div>
                    <h3 class="agent-name-title"></h3>
                </div>
                <p class="agent-name-subtitle"></p>
                <input type="text" class="agent-name-input" maxlength="24" spellcheck="false" autocomplete="off" />
                <div class="agent-name-actions">
                    <button class="agent-name-cancel">Cancel</button>
                    <button class="agent-name-confirm">Confirm</button>
                </div>
            </div>`;
        // Close on backdrop click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) _closeAgentNameModal();
        });
        document.body.appendChild(modal);
    }

    const avatarEl = modal.querySelector('.agent-name-avatar');
    const titleEl = modal.querySelector('.agent-name-title');
    const subtitleEl = modal.querySelector('.agent-name-subtitle');
    const inputEl = modal.querySelector('.agent-name-input');
    const cancelBtn = modal.querySelector('.agent-name-cancel');
    const confirmBtn = modal.querySelector('.agent-name-confirm');

    // Set agent color accent
    modal.style.setProperty('--agent-color', opts.color);

    // Avatar from brand
    const brandKey = opts.base || opts.name.replace(/-\d+$/, '');
    avatarEl.innerHTML = BRAND_AVATARS[brandKey] || USER_AVATAR;
    avatarEl.style.background = opts.color;

    if (opts.mode === 'pending') {
        const familyLabel = (Store.get('baseColors')[opts.base] || {}).label || opts.base || 'agent';
        titleEl.textContent = 'Name this agent';
        subtitleEl.textContent = `A new ${familyLabel} instance connected`;
    } else {
        titleEl.textContent = 'Rename agent';
        subtitleEl.textContent = `Current ID: @${opts.name}`;
    }

    inputEl.value = opts.label;
    inputEl.placeholder = opts.label;

    // Remove old listeners by cloning
    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    const newConfirm = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);

    newCancel.addEventListener('click', () => _closeAgentNameModal());
    newConfirm.addEventListener('click', () => {
        const label = inputEl.value.trim();
        if (!label) return;
        if (ws && ws.readyState === WebSocket.OPEN) {
            if (opts.mode === 'pending') {
                wsClient.send('name_pending', { name: opts.name, label });
            } else {
                wsClient.send('rename_agent', { name: opts.name, label });
            }
        }
        _closeAgentNameModal();
    });

    // Enter key confirms
    inputEl.onkeydown = (e) => {
        if (e.key === 'Enter') { newConfirm.click(); e.preventDefault(); }
        if (e.key === 'Escape') { _closeAgentNameModal(); e.preventDefault(); }
    };

    modal.classList.remove('hidden');
    // Focus and select input text after animation frame
    requestAnimationFrame(() => { inputEl.focus(); inputEl.select(); });
}

function _closeAgentNameModal() {
    const modal = document.getElementById('agent-name-modal');
    if (modal) modal.classList.add('hidden');
    _nameModalActive = false;
    // Show next pending if queued
    setTimeout(_showNextPendingName, 200);
}

// --- Pill popover (rename + role) ---

function showPillPopover(pillEl, opts) {
    if (opts.mode === 'pending') _nameModalActive = true;

    document.querySelectorAll('.pill-popover').forEach(p => p.remove());

    const popover = document.createElement('div');
    popover.className = 'pill-popover';
    popover.dataset.agent = opts.name;
    popover.style.setProperty('--agent-color', Store.get('colorOverrides')[opts.name] || opts.color);

    const currentRole = (Store.get('agentRoles')[opts.name] || '').toLowerCase();
    const roleChipsHtml = ROLE_PRESETS.map(p =>
        `<button class="role-preset-chip pill-role-chip ${currentRole === p.label.toLowerCase() ? 'active' : ''}" data-role="${escapeHtml(p.label)}">${p.emoji} ${escapeHtml(p.label)}</button>`
    ).join('');
    const customChipsHtml = (window.customRoles || [])
        .filter(r => r && !ROLE_PRESETS.some(p => p.label.toLowerCase() === r.toLowerCase()))
        .map(r =>
            `<button class="role-preset-chip pill-role-chip pill-custom-chip ${currentRole === r.toLowerCase() ? 'active' : ''}" data-role="${escapeHtml(r)}"><span class="pill-custom-label">${escapeHtml(r)}</span><span class="pill-custom-trash"><svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6 4V3h4v1M5 4v8.5h6V4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="pill-custom-confirm"><span class="pill-confirm-yes">&#10003;</span><span class="pill-confirm-no">&#10005;</span></span></button>`
        ).join('');

    popover.innerHTML = `
        <div class="pill-popover-section">
            <label class="pill-popover-label">${opts.mode === 'pending' ? 'Name this agent' : 'Rename'}</label>
            <div class="pill-popover-rename-row">
                <input type="text" class="pill-popover-input" value="${escapeHtml(opts.label)}" maxlength="24" spellcheck="false" />
                <button class="pill-popover-confirm">${opts.mode === 'pending' ? 'Confirm' : 'Rename'}</button>
            </div>
        </div>
        <div class="pill-popover-section">
            <label class="pill-popover-label">Role</label>
            <div class="pill-popover-roles">
                <button class="role-preset-chip pill-role-chip ${!currentRole ? 'active' : ''}" data-role="">None</button>
                ${roleChipsHtml}
                ${customChipsHtml}
            </div>
            <div class="pill-popover-custom-row">
                <input type="text" class="pill-popover-custom-input" placeholder="Custom role..." maxlength="20" />
            </div>
        </div>
        ${(() => {
            // Resolve the actual current color: override → pill CSS var → config → fallback
            let current = Store.get('colorOverrides')[opts.name] || '';
            if (!current && pillEl) {
                const computed = getComputedStyle(pillEl).getPropertyValue('--agent-color').trim();
                if (computed && !computed.startsWith('var(')) current = computed;
            }
            if (!current) current = opts.color || '';
            current = current.toLowerCase();
            const swatches = ['#ef4444','#da7756','#f97316','#f59e0b','#84cc16','#10a37f','#14b8a6','#06b6d4','#1783ff','#4285f4','#6366f1','#8b5cf6','#ec4899','#ff6b35'];
            const matchesSwatch = swatches.some(c => current === c.toLowerCase());
            const colorInputVal = (current && !current.startsWith('var(')) ? current : (opts.color || '#888888');
            return `<div class="pill-popover-section">
                <label class="pill-popover-label">Color</label>
                <div class="pill-popover-colors">
                    ${swatches.map(c =>
                        `<button class="color-swatch ${current === c.toLowerCase() ? 'active' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`
                    ).join('')}
                </div>
                <div class="pill-popover-color-custom">
                    <input type="color" class="pill-popover-color-input ${!matchesSwatch ? 'active' : ''}" value="${colorInputVal}" title="Pick custom color" />
                    <button class="pill-popover-color-reset" title="Reset to default">Reset</button>
                </div>
            </div>`;
        })()}
    `;

    const inputEl = popover.querySelector('.pill-popover-input');
    const confirmBtn = popover.querySelector('.pill-popover-confirm');
    const customInput = popover.querySelector('.pill-popover-custom-input');

    const closePopover = () => {
        popover.remove();
        document.removeEventListener('click', outsideClickHandler, true);
        if (opts.mode === 'pending') {
            _nameModalActive = false;
            setTimeout(_showNextPendingName, 200);
        }
    };

    const outsideClickHandler = (e) => {
        if (!popover.contains(e.target) && !(pillEl && pillEl.contains(e.target))) {
            closePopover();
        }
    };

    confirmBtn.addEventListener('click', () => {
        const label = inputEl.value.trim();
        if (!label) return;
        if (ws && ws.readyState === WebSocket.OPEN) {
            if (opts.mode === 'pending') {
                wsClient.send('name_pending', { name: opts.name, label });
            } else {
                wsClient.send('rename_agent', { name: opts.name, label });
            }
        }
        closePopover();
    });

    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { confirmBtn.click(); e.preventDefault(); }
        if (e.key === 'Escape') { closePopover(); e.preventDefault(); }
    });

    popover.querySelectorAll('.pill-role-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const role = chip.dataset.role || '';
            _setRole(opts.name, role);
            closePopover();
        });
    });

    // Custom chip: trash icon → confirm mode (red chip with tick/cross)
    popover.querySelectorAll('.pill-custom-chip').forEach(chip => {
        const trash = chip.querySelector('.pill-custom-trash');
        const confirmEl = chip.querySelector('.pill-custom-confirm');
        const yesBtn = chip.querySelector('.pill-confirm-yes');
        const noBtn = chip.querySelector('.pill-confirm-no');

        if (trash) trash.addEventListener('click', (e) => {
            e.stopPropagation();
            chip.classList.add('confirm-delete');
        });
        if (yesBtn) yesBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _deleteCustomRole(chip.dataset.role);
            chip.remove();
        });
        if (noBtn) noBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            chip.classList.remove('confirm-delete');
        });
    });

    customInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const val = customInput.value.trim();
            if (val) { _setRole(opts.name, val); closePopover(); }
            e.preventDefault();
        }
        if (e.key === 'Escape') { closePopover(); e.preventDefault(); }
    });

    // --- Color picker handlers ---
    const applyColorOverride = (color) => {
        Store.get('colorOverrides')[opts.name] = color;
        localStorage.setItem('agentchattr-color-overrides', JSON.stringify(Store.get('colorOverrides')));
        // Update pill color
        const pillToUpdate = document.getElementById(`status-${opts.name}`);
        if (pillToUpdate) pillToUpdate.style.setProperty('--agent-color', color);
        popover.style.setProperty('--agent-color', color);
        // Recolor all messages
        recolorMessages();
        // Rebuild mention toggles with new colors
        buildMentionToggles();
        // Update active swatch + color input highlight
        const swatchColors = [];
        popover.querySelectorAll('.color-swatch').forEach(s => {
            const match = s.dataset.color.toLowerCase() === color.toLowerCase();
            s.classList.toggle('active', match);
            swatchColors.push(s.dataset.color.toLowerCase());
        });
        const colorInput = popover.querySelector('.pill-popover-color-input');
        if (colorInput) {
            colorInput.value = color;
            // Highlight color input if color doesn't match any swatch
            colorInput.classList.toggle('active', !swatchColors.includes(color.toLowerCase()));
        }
    };

    popover.querySelectorAll('.color-swatch').forEach(swatch => {
        swatch.addEventListener('click', (e) => {
            e.stopPropagation();
            applyColorOverride(swatch.dataset.color);
        });
    });

    const colorInput = popover.querySelector('.pill-popover-color-input');
    if (colorInput) {
        colorInput.addEventListener('input', (e) => {
            applyColorOverride(e.target.value);
        });
    }

    const resetBtn = popover.querySelector('.pill-popover-color-reset');
    if (resetBtn) {
        resetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            delete Store.get('colorOverrides')[opts.name];
            localStorage.setItem('agentchattr-color-overrides', JSON.stringify(Store.get('colorOverrides')));
            const defaultColor = opts.color || '#888';
            const pillToUpdate = document.getElementById(`status-${opts.name}`);
            if (pillToUpdate) pillToUpdate.style.setProperty('--agent-color', defaultColor);
            popover.style.setProperty('--agent-color', defaultColor);
            recolorMessages();
            buildMentionToggles();
            popover.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
            if (colorInput) colorInput.value = defaultColor;
        });
    }

    document.body.appendChild(popover);

    if (pillEl) {
        const rect = pillEl.getBoundingClientRect();
        const popoverWidth = 280;
        let left;
        // If pill is in the right half of the screen, align popover's right edge to pill's right edge
        if (rect.right + popoverWidth - rect.width > window.innerWidth - 12) {
            left = rect.right - popoverWidth;
        } else {
            left = rect.left;
        }
        // Final clamp to keep on screen
        left = Math.max(12, Math.min(left, window.innerWidth - popoverWidth - 12));
        popover.style.top = `${rect.bottom + 8}px`;
        popover.style.left = `${left}px`;
    } else {
        popover.style.top = '50%';
        popover.style.left = '50%';
        popover.style.transform = 'translate(-50%, -50%)';
    }

    setTimeout(() => document.addEventListener('click', outsideClickHandler, true), 0);
    inputEl.focus();
}

// --- Exports for chat.js (buildStatusPills / WS name-prompt / Escape key) ---
window.showPillPopover = showPillPopover;
window._showNextPendingName = _showNextPendingName;
window._closeAgentNameModal = _closeAgentNameModal;
window._pendingNameQueue = _pendingNameQueue;
