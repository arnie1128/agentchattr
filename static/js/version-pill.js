// version-pill.js — update/version pill (FE-4 Tier-A leaf extraction).
//
// Self-contained: hits /api/version_check (api.js), toggles the #update-pill
// node, remembers a dismissed version in localStorage. chat.js init() calls
// checkForUpdate(); the pill's inline onclick calls dismissUpdate().

// --- Update check ---

async function checkForUpdate() {
    try {
        const resp = await api.get('/api/version_check');
        if (!resp.ok) return;
        const data = await resp.json();
        const pill = document.getElementById('update-pill');
        if (!pill) return;

        const dismissed = localStorage.getItem('agentchattr-dismissed-version');
        if (data.state === 'current' || data.state === 'unknown' || dismissed === data.latest) {
            pill.classList.add('hidden');
            return;
        }

        const label = data.state === 'upstream_update' ? 'Upstream update available' : 'Update available';
        pill.href = data.url || 'https://github.com/bcurts/agentchattr/releases';
        pill.innerHTML = `<span>${label}</span><button class="update-dismiss" onclick="dismissUpdate(event, '${data.latest}')" title="Dismiss">&times;</button>`;
        pill.classList.remove('hidden');
    } catch {
        // Silent fail -- version check should never block the UI
    }
}

function dismissUpdate(e, version) {
    e.preventDefault();
    e.stopPropagation();
    localStorage.setItem('agentchattr-dismissed-version', version);
    const pill = document.getElementById('update-pill');
    if (pill) pill.classList.add('hidden');
}

window.checkForUpdate = checkForUpdate;
window.dismissUpdate = dismissUpdate;
