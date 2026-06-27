// sounds.js — notification sound engine (FE-4 Tier-A leaf extraction).
//
// Self-contained: sound prefs live in localStorage, the only app-state read
// is Store.get('agentConfig') (for the per-agent settings rows). Loaded after
// store.js; chat.js and jobs.js call the players via window globals.

// --- Notification sounds ---
const SOUND_OPTIONS = [
    { value: 'soft-chime', label: 'Soft Chime' },
    { value: 'bright-ping', label: 'Bright Ping' },
    { value: 'gentle-pop', label: 'Gentle Pop' },
    { value: 'alert-tone', label: 'Alert Tone' },
    { value: 'pluck', label: 'Pluck' },
    { value: 'click', label: 'Click' },
    { value: 'warm-bell', label: 'Warm Bell' },
    { value: 'none', label: 'None' },
];
const DEFAULT_SOUND = 'soft-chime';
const CROSS_CHANNEL_SOUND = 'pluck';
let soundPrefs = JSON.parse(localStorage.getItem('agentchattr-sounds') || '{}');
const soundCache = {};

function playNotificationSound(sender) {
    const key = sender.toLowerCase();
    const soundName = soundPrefs[key] || soundPrefs['default'] || DEFAULT_SOUND;
    if (soundName === 'none') return;
    if (!soundCache[soundName]) {
        soundCache[soundName] = new Audio(`/static/assets/sounds/${soundName}.mp3`);
    }
    const audio = soundCache[soundName];
    audio.currentTime = 0;
    audio.play().catch(() => {});  // ignore autoplay policy errors
}

function playCrossChannelSound() {
    const soundName = soundPrefs['cross-channel'] || CROSS_CHANNEL_SOUND;
    if (soundName === 'none') return;
    if (!soundCache[soundName]) {
        soundCache[soundName] = new Audio(`/static/assets/sounds/${soundName}.mp3`);
    }
    const audio = soundCache[soundName];
    audio.currentTime = 0;
    audio.play().catch(() => {});
}
window.playCrossChannelSound = playCrossChannelSound;

function buildSoundSettings() {
    const container = document.getElementById('sound-settings');
    if (!container) return;
    container.innerHTML = '';

    // Default sound + cross-channel sound + per-agent rows
    const agents = ['default', 'cross-channel', ...Object.keys(Store.get('agentConfig'))];
    for (const name of agents) {
        const row = document.createElement('div');
        row.className = 'sound-row';
        const label = document.createElement('span');
        label.className = 'sound-label';
        label.textContent = name === 'default' ? 'Default sound'
            : name === 'cross-channel' ? 'Background alerts'
            : (Store.get('agentConfig')[name]?.label || name);
        const select = document.createElement('select');
        select.className = 'sound-select';
        select.dataset.agent = name;
        const currentVal = soundPrefs[name]
            || (name === 'default' ? DEFAULT_SOUND : name === 'cross-channel' ? CROSS_CHANNEL_SOUND : '');
        for (const opt of SOUND_OPTIONS) {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            if (currentVal === opt.value) o.selected = true;
            select.appendChild(o);
        }
        // Add "Use default" option for per-agent rows (not default or cross-channel)
        if (name !== 'default' && name !== 'cross-channel') {
            const o = document.createElement('option');
            o.value = '';
            o.textContent = 'Use default';
            if (!soundPrefs[name]) o.selected = true;
            select.insertBefore(o, select.firstChild);
        }
        // Preview on change
        select.addEventListener('change', () => {
            const val = select.value;
            soundPrefs[name] = val;
            localStorage.setItem('agentchattr-sounds', JSON.stringify(soundPrefs));
            if (val && val !== 'none') {
                if (!soundCache[val]) soundCache[val] = new Audio(`/static/assets/sounds/${val}.mp3`);
                soundCache[val].currentTime = 0;
                soundCache[val].play().catch(() => {});
            }
        });
        row.appendChild(label);
        row.appendChild(select);
        container.appendChild(row);
    }
}

window.playNotificationSound = playNotificationSound;
window.buildSoundSettings = buildSoundSettings;
