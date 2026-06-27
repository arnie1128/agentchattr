/* agentchattr — WebSocket client */

// Session token injected by the server into the HTML page.
// Sent with every API call and WebSocket connection to authenticate.
const SESSION_TOKEN = window.__SESSION_TOKEN__ || "";

let ws = null;
let pendingAttachments = [];
let autoScroll = true;
let reconnectTimer = null;
Store.set('username', 'user');  // single owner is Store (FE-3)
Store.set('agentConfig', {});  // { name: { color, label } } — registered instances (used for pills); single owner is Store (FE-3)
Store.set('baseColors', {});   // { name: { color, label } } — base agent colors (for message coloring); single owner is Store (FE-2)
let todos = {};  // { msg_id: "todo" | "done" }
Store.set('rules', []);  // array of rule objects from server — single owner is Store (FE-3)
let activeMentions = new Set();  // agent names with pre-@ toggled on
let replyingTo = null;  // { id, sender, text } or null
let unreadCount = 0;    // messages received while scrolled up
let lastMessageDate = null;  // track date for dividers (general channel)
let lastMessageDates = {};  // { channel: dateString } for per-channel dividers
Store.set('soundEnabled', false);  // suppress sounds during initial history load — single owner is Store (FE-3)
// activeChannel: single owner is Store (FE-3). Seed it from localStorage.
Store.set('activeChannel', localStorage.getItem('agentchattr-channel') || 'general');
Store.set('channelList', ['general']);  // single owner is Store (FE-3)
Store.set('channelUnread', {});  // { channelName: count } — single owner is Store (FE-3)
let agentHats = {};  // { agent_name: svg_string }
window.customRoles = [];  // saved custom roles from settings
Store.set('colorOverrides', JSON.parse(localStorage.getItem('agentchattr-color-overrides') || '{}'));  // single owner is Store (FE-2)
let schedulesList = [];  // array of schedule objects from server

// Expose the remaining non-state shims that extracted modules read via window.*
// (SESSION_TOKEN/ws/autoScroll are live chat.js locals). The 7 cross-module
// state keys are now owned by Store (FE-3) — siblings read them via Store.get
// and write via Store.set, so their window bridges are gone. activeChannel
// keeps a window getter as a convenience shim; Store is still its single owner.
Object.defineProperty(window, 'SESSION_TOKEN', { get() { return SESSION_TOKEN; } });
Object.defineProperty(window, 'activeChannel', { get() { return Store.get('activeChannel'); } });
window._setActiveChannel = function(v) { Store.set('activeChannel', v); };
// Persist activeChannel changes in one place — Store is the single owner.
Store.watch('activeChannel', function(v) { try { localStorage.setItem('agentchattr-channel', v); } catch (e) {} });
window._setPendingChannelSwitch = function(v) { pendingChannelSwitch = v; };
// scrollToBottom is set after function definition (see below)
Object.defineProperty(window, 'ws', { get() { return ws; } });
Object.defineProperty(window, 'autoScroll', { get() { return autoScroll; } });

// --- Drag-scroll for overflow containers ---
function enableDragScroll(el) {
    let isDown = false, startX, scrollLeft;
    el.addEventListener('mousedown', e => {
        if (e.button !== 0) return;  // left-click only
        isDown = true; startX = e.pageX - el.offsetLeft; scrollLeft = el.scrollLeft;
        el.style.cursor = 'grabbing';
    });
    el.addEventListener('mouseleave', () => { isDown = false; el.style.cursor = ''; });
    el.addEventListener('mouseup', () => { isDown = false; el.style.cursor = ''; });
    el.addEventListener('mousemove', e => {
        if (!isDown) return;
        e.preventDefault();
        el.scrollLeft = scrollLeft - (e.pageX - el.offsetLeft - startX);
    });
}

// --- Init ---

function init() {
    // Configure marked for chat-style rendering
    marked.setOptions({
        breaks: true,      // single newline → <br>
        gfm: true,         // GitHub-flavored markdown
    });

    detectPlatform();
    fetchRoles();
    connectWebSocket();
    setupInput();
    setupDragDrop();
    setupPaste();
    setupScroll();
    setupSettingsKeys();
    setupKeyboardShortcuts();
    RulesPanel.init();
    Jobs.init();
    Sessions.init();
    Channels.init();
    checkForUpdate();

    // Dismiss channel edit controls when clicking outside channel bar
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#channel-bar')) {
            document.querySelectorAll('.channel-tab.editing').forEach(t => t.classList.remove('editing'));
        }
    });
}

function renderMarkdown(text) {
    // Protect Windows paths from escape replacement (e.g. \tests → tab, \new → newline)
    const pathSlots = [];
    text = text.replace(/[A-Z]:[\\\/][\w\-.\\ \/]+/g, (m) => {
        pathSlots.push(m);
        return `\x00P${pathSlots.length - 1}\x00`;
    });
    // Unescape literal \n and \t that agents sometimes send as escaped text
    text = text.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    // Escape < and > outside of code blocks/inline code so raw HTML
    // can't break layout or cause XSS, while preserving angle brackets
    // inside backtick-delimited code where users expect them to render.
    // Protect fenced code blocks and inline code by replacing them with placeholders
    var codeSlots = [];
    text = text.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, function(match) {
        codeSlots.push(match);
        return '\x00C' + (codeSlots.length - 1) + '\x00';
    });
    // Escape angle brackets in non-code text only
    text = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Restore code blocks (angle brackets inside them stay unescaped)
    text = text.replace(/\x00C(\d+)\x00/g, function(_, i) { return codeSlots[parseInt(i)]; });
    // Restore paths
    text = text.replace(/\x00P(\d+)\x00/g, (_, i) => pathSlots[parseInt(i)]);
    // Parse markdown, then color @mentions, URLs, and file paths in the output
    let html = marked.parse(text);
    // Remove wrapping <p> tags for single-line messages to keep them inline
    const trimmed = html.trim();
    if (trimmed.startsWith('<p>') && trimmed.endsWith('</p>') && trimmed.indexOf('<p>', 1) === -1) {
        html = trimmed.slice(3, -4);
    }
    html = colorMentions(html);
    html = linkifyUrls(html);
    html = linkifyPaths(html);
    return html;
}

function linkifyUrls(html) {
    // Match http/https URLs not already inside an <a> tag.
    // We match tags first to skip them, then capture URLs in the same pass.
    return html.replace(/<a\b[^>]*>.*?<\/a>|(?<!["=])(https?:\/\/[^\s<>"')\]]+)/gs, (match, url) => {
        if (url) {
            return `<a href="${url}" target="_blank" rel="noopener">${url}</a>`;
        }
        return match;
    });
}

let serverPlatform = 'win32';  // default, updated on connect
async function detectPlatform() {
    try {
        const r = await api.get('/api/platform');
        const data = await r.json();
        serverPlatform = data.platform || 'win32';
    } catch (e) { /* fallback to win32 */ }
}

function linkifyPaths(html) {
    // Windows paths: E:\foo\bar or E:/foo/bar
    html = html.replace(/(?<!["=\/])([A-Z]):[\\\/][\w\-.\\ \/]+/g, (match) => {
        const escaped = match.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `<a class="file-link" href="#" onclick="openPath('${escaped}'); return false;" title="Open in file manager">${match}</a>`;
    });
    // Unix paths: /Users/..., /home/..., /tmp/..., /opt/..., /var/..., /etc/...
    if (serverPlatform !== 'win32') {
        html = html.replace(/(?<!["=\w])(\/(?:Users|home|tmp|opt|var|etc|usr)\/[\w\-.\/ ]+)/g, (match) => {
            const escaped = match.replace(/'/g, "\\'");
            return `<a class="file-link" href="#" onclick="openPath('${escaped}'); return false;" title="Open in file manager">${match}</a>`;
        });
    }
    return html;
}

async function openPath(path) {
    try {
        await api.post('/api/open-path', { path: path });
    } catch (err) {
        console.error('Failed to open path:', err);
    }
}

function addCodeCopyButtons(container) {
    const blocks = container.querySelectorAll('pre');
    for (const pre of blocks) {
        if (pre.querySelector('.code-copy-btn')) continue;
        const btn = document.createElement('button');
        btn.className = 'code-copy-btn';
        btn.textContent = 'copy';
        btn.onclick = async (e) => {
            e.stopPropagation();
            const code = pre.querySelector('code')?.textContent || pre.textContent;
            try {
                await navigator.clipboard.writeText(code);
                btn.textContent = 'copied!';
                setTimeout(() => { btn.textContent = 'copy'; }, 1500);
            } catch (err) {
                btn.textContent = 'failed';
                setTimeout(() => { btn.textContent = 'copy'; }, 1500);
            }
        };
        pre.style.position = 'relative';
        pre.appendChild(btn);
    }
}

// --- WebSocket ---

function connectWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(SESSION_TOKEN)}`);

    ws.onopen = () => {
        console.log('WebSocket connected');
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    };

    ws.onmessage = (e) => {
        const event = JSON.parse(e.data);
        // All inbound events go through the Hub; chat.js and the other modules
        // subscribe via Hub.on (see "Inbound WebSocket events" near the bottom).
        Hub.emit(event.type, event);
    };

    ws.onclose = (e) => {
        // Server sends 4003 when session token is invalid (server restarted).
        // Auto-reload to pick up the fresh token from the new HTML page.
        if (e.code === 4003) {
            console.warn('Session token rejected (server restarted?) — reloading page...');
            location.reload();
            return;
        }
        console.log('Disconnected, reconnecting in 2s...');
        Store.set('soundEnabled', false);  // suppress sounds during reconnect history replay
        const loader = document.getElementById('loading-indicator');
        if (loader) loader.classList.remove('hidden');
        reconnectTimer = setTimeout(connectWebSocket, 2000);
    };

    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        ws.close();
    };
}

// --- Date dividers ---

function getMessageDate(msg) {
    // msg.time is "HH:MM:SS" — we also need the date
    // Use msg.timestamp (epoch) if available, otherwise try to infer from today
    if (msg.timestamp) {
        return new Date(msg.timestamp * 1000).toDateString();
    }
    // Fallback: assume today (messages from history might not have timestamps)
    return new Date().toDateString();
}

function formatDateDivider(dateStr) {
    const date = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

    return date.toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
}

function maybeInsertDateDivider(container, msg) {
    const msgDate = getMessageDate(msg);
    const channel = msg.channel || 'general';
    const lastDate = lastMessageDates[channel];
    
    if (msgDate !== lastDate) {
        lastMessageDates[channel] = msgDate;
        const divider = document.createElement('div');
        divider.className = 'date-divider';
        divider.dataset.channel = channel;
        divider.innerHTML = `<span>${formatDateDivider(msgDate)}</span>`;
        if (channel !== activeChannel) {
            divider.style.display = 'none';
        }
        container.appendChild(divider);
    }
}

// --- Messages ---

function appendMessage(msg) {
    const container = document.getElementById('messages');

    // Insert date divider if needed
    maybeInsertDateDivider(container, msg);

    const el = document.createElement('div');
    el.className = 'message';
    el.dataset.id = msg.id;
    const msgChannel = msg.channel || 'general';
    el.dataset.channel = msgChannel;

    // Dispatch to a renderer registered under msg.type (the seam sessions.js
    // and jobs.js also use). A 'system'-sent message with no type-specific
    // renderer falls back to the system card; everything else is a chat bubble.
    let renderer = window._messageRenderers && window._messageRenderers[msg.type];
    if (!renderer && msg.sender === 'system') renderer = window._messageRenderers['system'];
    (renderer || _renderChat)(el, msg);

    // Hide messages from other channels
    if (msgChannel !== activeChannel) {
        el.style.display = 'none';
        // Track unread for background channels (skip joins/leaves and initial history load)
        if (Store.get('soundEnabled') && msg.type !== 'join' && msg.type !== 'leave') {
            const _cu = Store.get('channelUnread');
            _cu[msgChannel] = (_cu[msgChannel] || 0) + 1;
            renderChannelTabs();
            // Play soft pluck for cross-channel chat messages from others (only when focused)
            if (document.hasFocus() && msg.type === 'chat' && msg.sender && msg.sender.toLowerCase() !== Store.get('username').toLowerCase()) {
                playCrossChannelSound();
            }
        }
    }

    container.appendChild(el);

    // Collapse consecutive job_created messages into a group
    if (msg.type === 'job_created' && window._collapseJobBreadcrumbs) {
        window._collapseJobBreadcrumbs(container, el);
    }

    if (msgChannel !== activeChannel) return;  // don't scroll for hidden messages

    if (autoScroll) {
        scrollToBottom();
    } else {
        unreadCount++;
        updateScrollAnchor();
    }
}

// --- Core message renderers -------------------------------------------------
// appendMessage dispatches to window._messageRenderers[msg.type] -- the same
// seam sessions.js / jobs.js register into. These are the built-in kinds; each
// receives the pre-created <div.message> el and the msg and fills its markup.
if (!window._messageRenderers) window._messageRenderers = {};

window._messageRenderers['join'] = window._messageRenderers['leave'] = function (el, msg) {
    el.classList.add('join-msg');
    const color = getColor(msg.sender);
    el.innerHTML = `<span class="join-dot" style="background: ${color}"></span><span class="join-text"><strong style="color: ${color}">${escapeHtml(msg.sender)}</strong> ${msg.type === 'join' ? 'joined' : 'left'}</span>`;
};

window._messageRenderers['summary'] = function (el, msg) {
    el.classList.add('summary-msg');
    const color = getColor(msg.sender);
    el.innerHTML = `<div class="summary-card"><span class="summary-pill">Summary</span><span class="summary-author" style="color: ${color}">${escapeHtml(msg.sender)}</span><div class="summary-text">${escapeHtml(msg.text)}</div></div>`;
};

window._messageRenderers['job_proposal'] = function (el, msg) {
    el.classList.add('proposal-msg');
    const meta = msg.metadata || {};
    const title = escapeHtml(meta.title || '');
    const body = meta.body ? renderMarkdown(meta.body) : '';
    const color = getColor(msg.sender);
    const status = meta.status || 'pending';
    const isPending = status === 'pending';
    el.dataset.proposalTitle = meta.title || '';
    el.dataset.proposalBody = meta.body || '';
    el.dataset.proposalSender = msg.sender || '';
    el.innerHTML = `
        <div class="proposal-card ${isPending ? '' : 'proposal-resolved'}">
            <div class="proposal-header">
                <span class="proposal-pill">Job Proposal</span>
                <span class="proposal-author" style="color: ${color}">${escapeHtml(msg.sender)}</span>
            </div>
            <div class="proposal-title">${title}</div>
            ${body ? `<div class="proposal-body">${body}</div>` : ''}
            ${isPending ? `
                <div class="proposal-actions">
                    <button class="proposal-accept" onclick="acceptProposal(${msg.id})">Accept</button>
                    <button class="proposal-request-changes" onclick="requestChangesProposal(${msg.id})">Request Changes</button>
                    <button class="proposal-dismiss" onclick="dismissProposal(${msg.id})">Dismiss</button>
                </div>
            ` : `
                <div class="proposal-status-resolved">${status === 'accepted' ? 'Accepted' : 'Dismissed'}</div>
            `}
        </div>
        ${!isPending ? `<div class="msg-actions"><button class="reply-btn" onclick="startReply(${msg.id}, event)">reply</button><button class="delete-btn" onclick="deleteClick(${msg.id}, event)" title="Delete">del</button></div>` : ''}`;
};

window._messageRenderers['rule_proposal'] = function (el, msg) {
    el.classList.add('proposal-msg');
    const meta = msg.metadata || {};
    const ruleText = escapeHtml(meta.text || msg.text || '');
    const color = getColor(msg.sender);
    const status = meta.status || 'pending';
    const isPending = status === 'pending';
    el.innerHTML = `
        <div class="proposal-card rule-proposal-card ${isPending ? '' : 'proposal-resolved'}">
            <div class="proposal-header">
                <span class="proposal-pill rule-proposal-pill">Rule Proposal</span>
                <span class="proposal-author" style="color: ${color}">${escapeHtml(msg.sender)}</span>
            </div>
            <div class="rule-proposal-text">${ruleText}</div>
            ${isPending ? `
                <div class="proposal-actions">
                    <button class="proposal-accept" onclick="resolveRuleProposal(${msg.id}, 'activate')">Activate</button>
                    <button class="proposal-request-changes" onclick="resolveRuleProposal(${msg.id}, 'draft')">Add to drafts</button>
                    <button class="proposal-dismiss" onclick="dismissRuleProposal(${msg.id})">Dismiss</button>
                </div>
            ` : `
                <div class="proposal-status-resolved">${status === 'activated' ? 'Activated' : status === 'drafted' ? 'Added to drafts' : 'Dismissed'}</div>
            `}
        </div>
        ${!isPending ? `<div class="msg-actions"><button class="reply-btn" onclick="startReply(${msg.id}, event)">reply</button><button class="delete-btn" onclick="deleteClick(${msg.id}, event)" title="Delete">del</button></div>` : ''}`;
};

window._messageRenderers['system'] = function (el, msg) {
    el.classList.add('system-msg');
    el.innerHTML = `<span class="msg-text">${escapeHtml(msg.text)}</span>`;
};

function _renderChat(el, msg) {
    const isError = msg.text.startsWith('[') && msg.text.includes('error');
    if (isError) el.classList.add('error-msg');

    // Update last mentioned agent if message is from user (Ben)
    if (msg.sender.toLowerCase() === Store.get('username').toLowerCase()) {
        const mentions = msg.text.match(/@(\w[\w-]*)/g);
        if (mentions) {
            const lastMention = mentions[mentions.length - 1].slice(1).toLowerCase();
            // Check against registered agents (agentConfig keys are name labels)
            if (Store.get('agentConfig')[lastMention]) {
                Store.set('_lastMentionedAgent', lastMention);
            }
        }
    }

    let textHtml = styleHashtags(renderMarkdown(msg.text));

    const senderColor = getColor(msg.sender);
    const isSelf = msg.sender.toLowerCase() === Store.get('username').toLowerCase();
    el.classList.add(isSelf ? 'self' : 'other');

    let attachmentsHtml = '';
    if (msg.attachments && msg.attachments.length > 0) {
        attachmentsHtml = '<div class="msg-attachments">';
        for (const att of msg.attachments) {
            attachmentsHtml += `<img src="${escapeHtml(att.url)}" alt="${escapeHtml(att.name)}" onclick="openImageModal('${escapeHtml(att.url)}')">`;
        }
        attachmentsHtml += '</div>';
    }

    const todoStatus = todos[msg.id] || null;

    // Reply quote (if this message is a reply)
    let replyHtml = '';
    if (msg.reply_to !== undefined && msg.reply_to !== null) {
        const parentEl = document.querySelector(`.message[data-id="${msg.reply_to}"]`);
        if (parentEl) {
            const parentSender = parentEl.querySelector('.msg-sender')?.textContent || '?';
            const parentText = parentEl.dataset.rawText || parentEl.querySelector('.msg-text')?.textContent || '';
            const truncated = parentText.length > 80 ? parentText.slice(0, 80) + '...' : parentText;
            const parentColor = parentEl.querySelector('.msg-sender')?.style.color || 'var(--text-dim)';
            replyHtml = `<div class="reply-quote" onclick="scrollToMessage(${msg.reply_to})"><span class="reply-sender" style="color: ${parentColor}">${escapeHtml(parentSender)}</span> ${escapeHtml(truncated)}</div>`;
        }
    }

    const agentKey = (resolveAgent(msg.sender.toLowerCase()) || msg.sender).toLowerCase();
    const hatSvg = agentHats[agentKey] || '';
    const hatHtml = hatSvg ? `<div class="hat-overlay" data-agent="${escapeHtml(agentKey)}">${hatSvg}</div>` : '';
    const avatarHtml = `<div class="avatar-wrap" data-agent="${escapeHtml(agentKey)}"><div class="avatar" style="background-color: ${senderColor}">${getAvatarSvg(msg.sender)}</div>${hatHtml}</div>`;

    const statusLabel = todoStatusLabel(todoStatus);
    el.dataset.rawText = msg.text;
    const senderRole = _agentRoles[msg.sender] || '';
    const roleClass = senderRole ? 'bubble-role has-role' : 'bubble-role';
    const rolePillHtml = !isSelf ? `<button class="${roleClass}" onclick="showBubbleRolePicker(this, '${escapeHtml(msg.sender)}')" title="${senderRole ? escapeHtml(senderRole) : 'Set role'}">${senderRole || 'choose a role'}</button>` : '';
    // Inline decision choices (if present)
    let choicesHtml = '';
    const meta = msg.metadata || {};
    const choicesList = meta.choices || [];
    if (msg.type === 'decision' && choicesList.length > 0) {
        if (meta.resolved) {
            choicesHtml = `<div class="decision-choices"><div class="decision-resolved">You chose: <strong>${escapeHtml(meta.chosen || '')}</strong></div></div>`;
        } else {
            choicesHtml = '<div class="decision-choices">' + choicesList.map(c =>
                `<button class="decision-choice" onclick="resolveDecision(${msg.id}, '${escapeHtml(c).replace(/'/g, "\\'")}')">${escapeHtml(c)}</button>`
            ).join('') + '</div>';
        }
    }
    el.innerHTML = `<div class="todo-strip"></div>${isSelf ? '' : avatarHtml}<div class="chat-bubble" style="--bubble-color: ${senderColor}">${replyHtml}<div class="bubble-header"><span class="msg-sender" style="color: ${senderColor}">${escapeHtml(msg.sender)}</span>${rolePillHtml}<span class="msg-time">${msg.time || ''}</span></div><div class="msg-text">${textHtml}</div>${choicesHtml}${attachmentsHtml}<button class="convert-job-pill" onclick="startJobFromMessage(${msg.id}); event.stopPropagation();" title="Convert to job">convert to job</button><button class="bubble-copy" onclick="copyMessage(${msg.id}, event)" title="Copy message"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div><div class="msg-actions"><button class="reply-btn" onclick="startReply(${msg.id}, event)">reply</button><button class="todo-hint" onclick="todoCycle(${msg.id}); event.stopPropagation();">${statusLabel}</button><button class="delete-btn" onclick="deleteClick(${msg.id}, event)" title="Delete">del</button></div>`;
    if (todoStatus) el.classList.add('msg-todo', `msg-todo-${todoStatus}`);
    if (msg.metadata?.session_output) el.classList.add('session-output');

    // Add copy buttons to code blocks
    addCodeCopyButtons(el);
}

function getSenderClass(sender) {
    const s = sender.toLowerCase();
    if (s === 'system') return 'system';
    if (resolveAgent(s)) return 'agent';
    // Check base colors for offline agents
    const base = s.replace(/-\d+$/, '');
    if (base in Store.get('baseColors')) return 'agent';
    return 'user';
}

function colorMentions(textHtml) {
    // Match any @word — we'll resolve color per match
    return textHtml.replace(/@(\w[\w-]*)/gi, (match, name) => {
        const lower = name.toLowerCase();
        if (lower === 'both' || lower === 'all') {
            return `<span class="mention" style="color: var(--accent)">@${name}</span>`;
        }
        const resolved = resolveAgent(lower);
        if (resolved) {
            const color = getColor(resolved);
            return `<span class="mention" style="color: ${color}">@${name}</span>`;
        }
        // Non-agent mention (e.g. @ben, @user) — use user color
        return `<span class="mention" style="color: var(--user-color)">@${name}</span>`;
    });
}

function scrollToBottom() {
    const timeline = document.getElementById('timeline');
    timeline.scrollTop = timeline.scrollHeight;
    unreadCount = 0;
    updateScrollAnchor();
}
window.scrollToBottom = scrollToBottom;
window.appendMessage = appendMessage;
// getColor/resolveAgent/getAvatarSvg moved to agentview.js (FE-2 leaf).
// renderMarkdown stays here — it composes colorMentions (→getColor) and
// linkifyPaths (→serverPlatform), a state-coupled render cluster, not a pure
// leaf — but is bound to window for the sibling panels (jobs) that render
// message bodies.
window.renderMarkdown = renderMarkdown;

function updateScrollAnchor() {
    const anchor = document.getElementById('scroll-anchor');
    if (autoScroll) {
        anchor.classList.add('hidden');
    } else {
        anchor.classList.remove('hidden');
        const badge = anchor.querySelector('.unread-badge');
        if (badge) {
            badge.textContent = unreadCount;
            badge.style.display = unreadCount > 0 ? 'flex' : 'none';
        }
    }
    repositionScrollAnchor();
}

function repositionScrollAnchor() {
    const anchor = document.getElementById('scroll-anchor');
    if (!anchor) return;
    const footer = document.querySelector('footer');
    if (footer) {
        anchor.style.bottom = (footer.offsetHeight + 12) + 'px';
    }
    const timeline = document.getElementById('timeline');
    if (timeline) {
        const rect = timeline.getBoundingClientRect();
        anchor.style.left = (rect.left + rect.width / 2) + 'px';
    }
}

// --- Agents ---

function applyAgentConfig(data) {
    const next = {};
    for (const [name, cfg] of Object.entries(data)) {
        next[name.toLowerCase()] = cfg;
    }
    Store.set('agentConfig', next);
    buildStatusPills();
    buildMentionToggles();
    buildSoundSettings();
    // Re-color any messages already rendered (e.g. from a reconnect)
    recolorMessages();
    updateJobReplyTargetUI();
}

function recolorMessages() {
    const msgs = document.querySelectorAll('.message[data-id]');
    for (const el of msgs) {
        const sender = el.querySelector('.msg-sender');
        if (!sender) continue;
        const name = sender.textContent.trim();
        const color = getColor(name);
        sender.style.color = color;
        // Update bubble color
        const bubble = el.querySelector('.chat-bubble');
        if (bubble) bubble.style.setProperty('--bubble-color', color);
        // Update avatar color
        const avatar = el.querySelector('.avatar');
        if (avatar) avatar.style.backgroundColor = color;
        // Re-render markdown with updated mention colors and hashtags
        const textEl = el.querySelector('.msg-text');
        if (textEl && el.dataset.rawText) {
            textEl.innerHTML = styleHashtags(renderMarkdown(el.dataset.rawText));
            addCodeCopyButtons(el);
        }
    }
}

// --- Hats ---

function updateAllHats() {
    // Update hat overlays on all message avatars
    document.querySelectorAll('.avatar-wrap[data-agent]').forEach(wrap => {
        const agent = wrap.dataset.agent;
        const svg = agentHats[agent] || '';
        let overlay = wrap.querySelector('.hat-overlay');

        if (svg) {
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.className = 'hat-overlay';
                overlay.dataset.agent = agent;
                wrap.appendChild(overlay);
            }
            overlay.innerHTML = svg;
        } else {
            if (overlay) overlay.remove();
        }
    });
}

// --- Hat drag-to-trash ---

const TRASH_SVG = `<svg viewBox="0 0 20 20" fill="none" width="20" height="20"><rect x="4" y="6" width="12" height="12" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M3 6h14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M8 3h4v3H8z" stroke="currentColor" stroke-width="1.2"/><rect class="trash-lid" x="3" y="4.5" width="14" height="2" rx="0.5" fill="currentColor" style="transform-origin: 10px 5.5px"/></svg>`;

let hatDragState = null;  // { agent, ghostEl, originRect, trashEl, wrapEl }

document.addEventListener('mousedown', (e) => {
    const overlay = e.target.closest('.hat-overlay');
    if (!overlay || hatDragState) return;
    e.preventDefault();

    const agent = overlay.dataset.agent;
    const wrap = overlay.closest('.avatar-wrap');
    if (!wrap) return;

    const rect = overlay.getBoundingClientRect();

    // Create drag ghost (fixed position, follows cursor)
    const ghost = document.createElement('div');
    ghost.className = 'hat-drag-ghost';
    ghost.innerHTML = overlay.innerHTML;
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    document.body.appendChild(ghost);

    // Hide original overlay
    overlay.style.visibility = 'hidden';

    // Create trash can to the left of the avatar-wrap
    const trash = document.createElement('div');
    trash.className = 'hat-trash';
    trash.innerHTML = TRASH_SVG;
    wrap.appendChild(trash);
    // Force reflow then show
    trash.offsetHeight;
    trash.classList.add('visible');

    hatDragState = { agent, ghostEl: ghost, originRect: rect, trashEl: trash, wrapEl: wrap, overlayEl: overlay };
});

document.addEventListener('mousemove', (e) => {
    if (!hatDragState) return;
    const { ghostEl, trashEl } = hatDragState;

    // Move ghost to follow cursor (centered on cursor)
    ghostEl.style.left = (e.clientX - ghostEl.offsetWidth / 2) + 'px';
    ghostEl.style.top = (e.clientY - ghostEl.offsetHeight / 2) + 'px';

    // Check proximity to trash for highlight
    const trashRect = trashEl.getBoundingClientRect();
    const ghostCX = e.clientX;
    const ghostCY = e.clientY;
    const overTrash = ghostCX >= trashRect.left - 12 && ghostCX <= trashRect.right + 12 &&
                      ghostCY >= trashRect.top - 12 && ghostCY <= trashRect.bottom + 12;
    trashEl.classList.toggle('hover', overTrash);
});

document.addEventListener('mouseup', (e) => {
    if (!hatDragState) return;
    const { agent, ghostEl, originRect, trashEl, wrapEl, overlayEl } = hatDragState;

    // Check if dropped on trash
    const trashRect = trashEl.getBoundingClientRect();
    const overTrash = e.clientX >= trashRect.left - 12 && e.clientX <= trashRect.right + 12 &&
                      e.clientY >= trashRect.top - 12 && e.clientY <= trashRect.bottom + 12;

    if (overTrash) {
        // Snap ghost to trash center, shrink, fade out
        ghostEl.style.transition = 'all 0.25s ease-in';
        ghostEl.style.left = (trashRect.left + trashRect.width / 2 - ghostEl.offsetWidth / 2) + 'px';
        ghostEl.style.top = (trashRect.top + trashRect.height / 2 - ghostEl.offsetHeight / 2) + 'px';
        ghostEl.style.transform = 'scale(0.2)';
        ghostEl.style.opacity = '0';

        // Chomp animation on trash
        trashEl.classList.remove('hover');
        trashEl.classList.add('chomping');

        // Send DELETE to server
        api.del(`/api/hat/${agent}`).catch(err => console.error('Hat delete failed:', err));

        // Cleanup after animation
        setTimeout(() => {
            ghostEl.remove();
            trashEl.remove();
            if (overlayEl) overlayEl.remove();
        }, 600);
    } else {
        // Return ghost to original position
        ghostEl.style.transition = 'all 0.3s ease';
        ghostEl.style.left = originRect.left + 'px';
        ghostEl.style.top = originRect.top + 'px';

        // Fade out trash
        trashEl.classList.remove('hover', 'visible');

        setTimeout(() => {
            ghostEl.remove();
            trashEl.remove();
            overlayEl.style.visibility = '';
        }, 300);
    }

    hatDragState = null;
});

// Cancel hat drag on Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && hatDragState) {
        const { ghostEl, originRect, trashEl, overlayEl } = hatDragState;
        ghostEl.style.transition = 'all 0.3s ease';
        ghostEl.style.left = originRect.left + 'px';
        ghostEl.style.top = originRect.top + 'px';
        trashEl.classList.remove('hover', 'visible');
        setTimeout(() => {
            ghostEl.remove();
            trashEl.remove();
            overlayEl.style.visibility = '';
        }, 300);
        hatDragState = null;
    }
});

function buildStatusPills() {
    const container = document.getElementById('agent-status');
    container.innerHTML = '';
    for (const [name, cfg] of Object.entries(Store.get('agentConfig'))) {
        const pill = document.createElement('div');
        pill.className = 'status-pill';
        if (cfg.state === 'pending') pill.classList.add('pending');
        pill.id = `status-${name}`;
        pill.title = `@${name}`;  // Tooltip: canonical name for manual @-typing
        pill.style.setProperty('--agent-color', Store.get('colorOverrides')[name] || cfg.color || '#4ade80');
        pill.innerHTML = `<span class="status-dot"></span><span class="status-label">${escapeHtml(cfg.label || name)}</span>`;
        // Left-click to toggle pill popover (rename + role + color)
        pill.addEventListener('click', (e) => {
            e.stopPropagation();
            // Toggle: close if this pill's popover is already open
            const existing = document.querySelector(`.pill-popover[data-agent="${name}"]`);
            if (existing) { existing.remove(); return; }
            const mode = cfg.state === 'pending' ? 'pending' : 'rename';
            showPillPopover(pill, {
                name, label: cfg.label || name, color: cfg.color || '#888',
                base: cfg.base || '', mode,
            });
        });
        container.appendChild(pill);
    }
    enableDragScroll(container);
}

// --- Role presets (shared by pill popover + bubble picker) ---

const ROLE_PRESETS = [
    { label: 'Planner', emoji: '📋' },
    { label: 'Designer', emoji: '✨' },
    { label: 'Architect', emoji: '🏛️' },
    { label: 'Builder', emoji: '🔨' },
    { label: 'Reviewer', emoji: '🔍' },
    { label: 'Researcher', emoji: '🔬' },
    { label: 'Red Team', emoji: '🛡️' },
    { label: 'Wry', emoji: '🍸' },
    { label: 'Unhinged', emoji: '🤪' },
    { label: 'Hype', emoji: '🎉' },
];

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

    const currentRole = (_agentRoles[opts.name] || '').toLowerCase();
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

// --- Bubble role picker ---

function showBubbleRolePicker(btn, agentName) {
    // Close any existing picker and reset z-index on its parent message
    document.querySelectorAll('.bubble-role-picker').forEach(p => {
        const msg = p.closest('.message');
        if (msg) msg.style.zIndex = '';
        p.remove();
    });

    const currentRole = (_agentRoles[agentName] || '').toLowerCase();
    const picker = document.createElement('div');
    picker.className = 'bubble-role-picker';
    const closePicker = () => { if (msgEl) msgEl.style.zIndex = ''; picker.remove(); };

    // None chip
    const noneChip = document.createElement('button');
    noneChip.className = 'role-preset-chip' + (!currentRole ? ' active' : '');
    noneChip.textContent = 'None';
    noneChip.addEventListener('click', () => { _setRole(agentName, ''); closePicker(); });
    picker.appendChild(noneChip);

    for (const preset of ROLE_PRESETS) {
        const chip = document.createElement('button');
        chip.className = 'role-preset-chip' + (currentRole === preset.label.toLowerCase() ? ' active' : '');
        chip.textContent = `${preset.emoji} ${preset.label}`;
        chip.addEventListener('click', () => { _setRole(agentName, preset.label); closePicker(); });
        picker.appendChild(chip);
    }

    // Saved custom roles
    for (const r of (window.customRoles || [])) {
        if (!r || ROLE_PRESETS.some(p => p.label.toLowerCase() === r.toLowerCase())) continue;
        const chip = document.createElement('button');
        chip.className = 'role-preset-chip' + (currentRole === r.toLowerCase() ? ' active' : '');
        chip.textContent = r;
        chip.addEventListener('click', () => { _setRole(agentName, r); closePicker(); });
        picker.appendChild(chip);
    }

    // Custom text input
    const customRow = document.createElement('div');
    customRow.className = 'bubble-role-custom';
    const customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.className = 'bubble-role-input';
    customInput.placeholder = 'Custom...';
    customInput.maxLength = 20;
    customInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const val = customInput.value.trim();
            if (val) { _setRole(agentName, val); closePicker(); }
            e.preventDefault();
        }
        if (e.key === 'Escape') { closePicker(); }
    });
    customRow.appendChild(customInput);
    picker.appendChild(customRow);

    // Place inside the chat-bubble, positioned below the clicked button
    const bubble = btn.closest('.chat-bubble');
    const msgEl = btn.closest('.message');
    if (msgEl) msgEl.style.zIndex = '50';
    bubble.appendChild(picker);

    // Position picker below the button that was clicked
    requestAnimationFrame(() => {
        const btnRect = btn.getBoundingClientRect();
        const bubbleRect = bubble.getBoundingClientRect();
        picker.style.top = (btnRect.bottom - bubbleRect.top + 4) + 'px';
        picker.style.left = (btnRect.left - bubbleRect.left) + 'px';
        picker.style.right = 'auto';

        // Flip upward if picker would overflow below the footer/viewport
        const pickerRect = picker.getBoundingClientRect();
        const footerEl = document.querySelector('footer');
        const maxBottom = footerEl ? footerEl.getBoundingClientRect().top : window.innerHeight - 20;
        if (pickerRect.bottom > maxBottom) {
            picker.style.top = 'auto';
            picker.style.bottom = (bubbleRect.bottom - btnRect.top + 4) + 'px';
        }
        // Nudge left if overflowing right edge
        if (pickerRect.right > window.innerWidth - 10) {
            picker.style.left = 'auto';
            picker.style.right = '0';
        }
    });

    // Close on outside click (next tick to avoid catching the current click)
    setTimeout(() => {
        const closeHandler = (e) => {
            if (!picker.contains(e.target)) {
                closePicker();
                document.removeEventListener('click', closeHandler, true);
            }
        };
        document.addEventListener('click', closeHandler, true);
    }, 0);
}

function _syncBubbleRolePills(agentName) {
    const role = String(_agentRoles[agentName] || '').trim();
    const pillText = role || 'choose a role';
    document.querySelectorAll('.message').forEach(msg => {
        const senderEl = msg.querySelector('.msg-sender');
        const btn = msg.querySelector('.bubble-role');
        if (!btn || !senderEl || senderEl.textContent !== agentName) return;
        btn.textContent = pillText;
        btn.title = role || 'Set role';
        btn.classList.toggle('has-role', !!role);
    });
}

function _setRole(agentName, role) {
    api.post(`/api/roles/${agentName}`, { role });
    // Optimistic update
    _agentRoles[agentName] = role;
    _syncBubbleRolePills(agentName);
    // If custom role (not in presets), auto-save it
    if (role && !ROLE_PRESETS.some(p => p.label.toLowerCase() === role.toLowerCase())) {
        _addCustomRole(role);
    }
}

function _addCustomRole(role) {
    const list = window.customRoles || [];
    const lower = role.trim().toLowerCase();
    if (list.some(r => r.toLowerCase() === lower)) return;
    const updated = [...list, role.trim()].slice(-20);
    window.customRoles = updated;
    if (ws && ws.readyState === WebSocket.OPEN) {
        wsClient.send('update_settings', { data: { custom_roles: updated } });
    }
}

function _deleteCustomRole(role) {
    const lower = role.trim().toLowerCase();
    const updated = (window.customRoles || []).filter(r => r.toLowerCase() !== lower);
    window.customRoles = updated;
    if (ws && ws.readyState === WebSocket.OPEN) {
        wsClient.send('update_settings', { data: { custom_roles: updated } });
    }
    // Unassign from any agents currently using this role
    for (const [agentName, agentRole] of Object.entries(_agentRoles)) {
        if (agentRole && agentRole.toLowerCase() === lower) {
            _setRole(agentName, '');
        }
    }
}

// --- Status ---

const _agentRoles = {};  // name → role string

function fetchRoles() {
    api.get('/api/roles').then(r => r.json()).then(roles => {
        Object.assign(_agentRoles, roles);
        for (const name of Object.keys(roles || {})) {
            _syncBubbleRolePills(name);
        }
    }).catch(() => {});
}

const _ROLE_EMOJI = {
    'planner': '📋', 'builder': '🔨', 'reviewer': '🔍', 'researcher': '🔬',
    'chaos gremlin': '😈', 'red team': '🛡️', 'roast': '🔥', 'hype': '🎉',
};

function updateStatus(data) {
    for (const [name, info] of Object.entries(data)) {
        if (name === 'routing_paused') continue;
        const pill = document.getElementById(`status-${name}`);
        if (!pill) continue;

        pill.classList.remove('available', 'working', 'offline');
        // Pending pills keep their pending animation (set in buildStatusPills)
        if (!pill.classList.contains('pending')) {
            if (info.busy && info.available) {
                pill.classList.add('working');
            } else if (info.available) {
                pill.classList.add('available');
            } else {
                pill.classList.add('offline');
            }
        }

        // Keep agent color in sync
        if (info.color) pill.style.setProperty('--agent-color', info.color);

        // Track role (displayed on bubbles, not on pill)
        if (info.role !== undefined) {
            _agentRoles[name] = info.role;
            _syncBubbleRolePills(name);
        }
    }
}

function updateTyping(agent, active) {
    const indicator = document.getElementById('typing-indicator');
    if (active) {
        indicator.querySelector('.typing-name').textContent = agent;
        indicator.classList.remove('hidden');
        if (autoScroll) scrollToBottom();
    } else {
        indicator.classList.add('hidden');
    }
}

// --- Settings ---

let pendingChannelSwitch = null;

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

// --- Toast notifications ---

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast--visible'));
    setTimeout(() => {
        toast.classList.remove('toast--visible');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// --- Export / Import ---

async function exportHistory() {
    try {
        const resp = await api.get('/api/export');
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            showToast(err.error || 'Export failed', 'error');
            return;
        }
        const blob = await resp.blob();
        const disposition = resp.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="(.+?)"/);
        const filename = match ? match[1] : 'agentchattr-export.zip';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
        const counts = [];
        // Parse counts from manifest if possible, or just show success
        showToast('History exported', 'success');
    } catch (e) {
        showToast('Export failed: ' + e.message, 'error');
    }
}

async function importHistory(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = ''; // Reset so same file can be picked again
    const btn = document.getElementById('import-history-btn');
    const origText = btn.textContent;
    btn.textContent = 'Importing...';
    btn.disabled = true;
    try {
        const formData = new FormData();
        formData.append('file', file);
        const resp = await api.postForm('/api/import', formData);
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
            showToast(data.error || 'Import failed', 'error');
            return;
        }
        // Build result message
        const parts = [];
        const s = data.sections || {};
        if (s.messages) parts.push(`${s.messages.created} messages`);
        if (s.jobs) parts.push(`${s.jobs.created} jobs`);
        if (s.rules) parts.push(`${s.rules.created} rules`);
        if (s.summaries) parts.push(`${s.summaries.created + (s.summaries.updated || 0)} summaries`);
        const dupes = (s.messages?.duplicates || 0) + (s.jobs?.duplicates || 0) + (s.rules?.duplicates || 0);
        let msg = 'Imported ' + parts.join(', ');
        if (dupes > 0) msg += ` (${dupes} duplicates skipped)`;
        if (data.warnings && data.warnings.length > 0) {
            msg += `. ${data.warnings.length} warning(s)`;
        }
        showToast(msg, 'success');
    } catch (e) {
        showToast('Import failed: ' + e.message, 'error');
    } finally {
        btn.textContent = origText;
        btn.disabled = false;
    }
}

// --- Keyboard shortcuts ---

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        const modal = document.getElementById('image-modal');
        const modalOpen = modal && !modal.classList.contains('hidden');

        if (e.key === 'Escape') {
            const nameModal = document.getElementById('agent-name-modal');
            if (nameModal && !nameModal.classList.contains('hidden')) { _closeAgentNameModal(); return; }
            const convertModal = document.getElementById('convert-job-modal');
            if (convertModal && !convertModal.classList.contains('hidden')) { closeConvertJobModal(); return; }
            const deleteJobModal = document.getElementById('delete-job-modal');
            if (deleteJobModal && !deleteJobModal.classList.contains('hidden')) { closeDeleteJobModal(); return; }
            if (modalOpen) { closeImageModal(); return; }
            if (replyingTo) { cancelReply(); }
        }
        if (modalOpen && e.key === 'ArrowLeft') { e.preventDefault(); modalPrev(e); }
        if (modalOpen && e.key === 'ArrowRight') { e.preventDefault(); modalNext(e); }

    });
}

// --- Slash command menu ---

function showSlashHint(text) {
    const input = document.getElementById('input');
    if (!input) return;
    const original = input.placeholder;
    input.placeholder = text;
    input.classList.add('slash-hint-active');
    setTimeout(() => {
        input.placeholder = original;
        input.classList.remove('slash-hint-active');
    }, 3000);
}

const SLASH_COMMANDS = [
    { cmd: '/artchallenge', desc: 'SVG art challenge — all agents create artwork (optional theme)', broadcast: true },
    { cmd: '/hatmaking', desc: 'All agents design a hat to wear on their avatar', broadcast: true },
    { cmd: '/roastreview', desc: 'Get all agents to review and roast each other\'s work', broadcast: true },
    { cmd: '/poetry haiku', desc: 'Agents write a haiku about the codebase', broadcast: true },
    { cmd: '/poetry limerick', desc: 'Agents write a limerick about the codebase', broadcast: true },
    { cmd: '/poetry sonnet', desc: 'Agents write a sonnet about the codebase', broadcast: true },
    { cmd: '/summary', desc: 'Summarize recent messages — tag an agent (e.g. /summary @claude)', broadcast: false, needsMention: true },
    { cmd: '/summarise', desc: 'Summarize recent messages — tag an agent (e.g. /summarise @claude)', broadcast: false, needsMention: true, hidden: true },
    { cmd: '/continue', desc: 'Resume after loop guard pauses', broadcast: false },
    { cmd: '/clear', desc: 'Clear messages in current channel', broadcast: false },
];

let slashMenuIndex = 0;
let slashMenuVisible = false;
let mentionMenuIndex = 0;
let mentionMenuVisible = false;
let mentionMenuStart = -1;  // cursor position of the '@'

function updateSlashMenu(text) {
    const menu = document.getElementById('slash-menu');
    if (!text.startsWith('/') || text.includes(' ') && !text.startsWith('/poetry')) {
        menu.classList.add('hidden');
        slashMenuVisible = false;
        return;
    }

    const query = text.toLowerCase();
    const matches = SLASH_COMMANDS.filter(c => !c.hidden && c.cmd.startsWith(query));

    if (matches.length === 0 || (matches.length === 1 && matches[0].cmd === query)) {
        menu.classList.add('hidden');
        slashMenuVisible = false;
        return;
    }

    menu.innerHTML = '';
    slashMenuIndex = Math.min(slashMenuIndex, matches.length - 1);

    matches.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = 'slash-item' + (i === slashMenuIndex ? ' active' : '');
        row.innerHTML = `<span class="slash-cmd">${escapeHtml(item.cmd)}</span><span class="slash-desc">${escapeHtml(item.desc)}</span>`;
        row.addEventListener('mousedown', (e) => {
            e.preventDefault();
            selectSlashCommand(item.cmd);
        });
        row.addEventListener('mouseenter', () => {
            slashMenuIndex = i;
            menu.querySelectorAll('.slash-item').forEach((el, j) => el.classList.toggle('active', j === i));
        });
        menu.appendChild(row);
    });

    menu.classList.remove('hidden');
    slashMenuVisible = true;
}

function selectSlashCommand(cmd) {
    const input = document.getElementById('input');
    input.value = cmd;
    input.focus();
    document.getElementById('slash-menu').classList.add('hidden');
    slashMenuVisible = false;
}

// --- Mention autocomplete ---

function getMentionCandidates() {
    // Build list: registered agents + broadcast mention.
    const candidates = [];
    for (const [name, cfg] of Object.entries(Store.get('agentConfig'))) {
        if (cfg.state === 'pending') continue;
        candidates.push({ name, label: cfg.label || name, color: cfg.color });
    }
    // Broadcast mention. Label shown to the user matches the inserted text
    // (`@all`), so the picker can't suggest a multi-word form that the router
    // doesn't recognize. `aliases` keeps `all agents` searchable for muscle memory.
    candidates.push({ name: 'all', label: 'all', aliases: ['all agents'], color: 'var(--accent)' });
    return candidates;
}

function updateMentionMenu() {
    const menu = document.getElementById('mention-menu');
    const input = document.getElementById('input');
    const text = input.value;
    const cursor = input.selectionStart;

    // Don't show if slash menu is active
    if (slashMenuVisible) {
        menu.classList.add('hidden');
        mentionMenuVisible = false;
        return;
    }

    // Find the '@' before cursor that starts this mention
    let atPos = -1;
    for (let i = cursor - 1; i >= 0; i--) {
        if (text[i] === '@') { atPos = i; break; }
        // Allow spaces if we are still matching a multi-word label like "all agents"
        if (!/[\w\-\s]/.test(text[i])) break;
        // Optimization: don't look back more than 30 chars
        if (cursor - i > 30) break;
    }

    if (atPos < 0 || (atPos > 0 && /\w/.test(text[atPos - 1]))) {
        // No @ found, or @ is mid-word (e.g. email)
        menu.classList.add('hidden');
        mentionMenuVisible = false;
        return;
    }

    const query = text.slice(atPos + 1, cursor).toLowerCase();
    mentionMenuStart = atPos;

    const candidates = getMentionCandidates();
    const matches = candidates.filter(c => {
        if (c.name.toLowerCase().includes(query)) return true;
        if (c.label.toLowerCase().includes(query)) return true;
        if (Array.isArray(c.aliases)) {
            return c.aliases.some(a => a.toLowerCase().includes(query));
        }
        return false;
    });

    if (matches.length === 0) {
        menu.classList.add('hidden');
        mentionMenuVisible = false;
        return;
    }

    menu.innerHTML = '';
    mentionMenuIndex = Math.min(mentionMenuIndex, matches.length - 1);

    matches.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = 'mention-item' + (i === mentionMenuIndex ? ' active' : '');
        row.dataset.name = item.name;
        row.innerHTML = `<span class="mention-dot" style="background: ${item.color}"></span><span class="mention-name">${escapeHtml(item.label)}</span>`;
        row.addEventListener('mousedown', (e) => {
            e.preventDefault();
            selectMention(item.name);
        });
        row.addEventListener('mouseenter', () => {
            mentionMenuIndex = i;
            menu.querySelectorAll('.mention-item').forEach((el, j) => el.classList.toggle('active', j === i));
        });
        menu.appendChild(row);
    });

    menu.classList.remove('hidden');
    mentionMenuVisible = true;
}

Store.set('_lastMentionedAgent', ''); // track most recent mention for auto-assignment (single owner is Store, FE-3)

function selectMention(name) {
    const input = document.getElementById('input');
    Store.set('_lastMentionedAgent', name); // remember for auto-assigning jobs
    const text = input.value;
    const cursor = input.selectionStart;
    // Replace from @ to cursor with @name + space
    const before = text.slice(0, mentionMenuStart);
    const after = text.slice(cursor);
    const mention = `@${name} `;
    input.value = before + mention + after;
    const newPos = mentionMenuStart + mention.length;
    input.setSelectionRange(newPos, newPos);
    input.focus();
    document.getElementById('mention-menu').classList.add('hidden');
    mentionMenuVisible = false;
}

// --- Input ---

function setupInput() {
    const input = document.getElementById('input');

    input.addEventListener('keydown', (e) => {
        if (mentionMenuVisible) {
            const menu = document.getElementById('mention-menu');
            const items = menu.querySelectorAll('.mention-item');
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                mentionMenuIndex = (mentionMenuIndex - 1 + items.length) % items.length;
                items.forEach((el, i) => el.classList.toggle('active', i === mentionMenuIndex));
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                mentionMenuIndex = (mentionMenuIndex + 1) % items.length;
                items.forEach((el, i) => el.classList.toggle('active', i === mentionMenuIndex));
                return;
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) {
                e.preventDefault();
                const active = items[mentionMenuIndex];
                if (active) {
                    selectMention(active.dataset.name);
                }
                return;
            }
            if (e.isComposing) return;
            if (e.key === 'Escape') {
                menu.classList.add('hidden');
                mentionMenuVisible = false;
                return;
            }
        }
        if (slashMenuVisible) {
            const menu = document.getElementById('slash-menu');
            const items = menu.querySelectorAll('.slash-item');
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                slashMenuIndex = (slashMenuIndex - 1 + items.length) % items.length;
                items.forEach((el, i) => el.classList.toggle('active', i === slashMenuIndex));
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                slashMenuIndex = (slashMenuIndex + 1) % items.length;
                items.forEach((el, i) => el.classList.toggle('active', i === slashMenuIndex));
                return;
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) {
                e.preventDefault();
                const active = items[slashMenuIndex];
                if (active) selectSlashCommand(active.querySelector('.slash-cmd').textContent);
                if (e.key === 'Enter') sendMessage();
                return;
            }
            if (e.key === 'Escape') {
                menu.classList.add('hidden');
                slashMenuVisible = false;
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Auto-resize + slash menu + mention menu + send button state
    function onInputChange() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        updateSlashMenu(input.value);
        updateMentionMenu();
        updateSendButton();
    }
    input.addEventListener('input', onInputChange);
    // Voice typing doesn't always fire 'input' — catch with additional events
    input.addEventListener('compositionend', onInputChange);
    input.addEventListener('change', onInputChange);
    // Fallback poll for speech-to-text that bypasses all events
    let _lastInputVal = '';
    setInterval(() => {
        if (input.value !== _lastInputVal) {
            _lastInputVal = input.value;
            updateSendButton();
        }
    }, 300);
    updateSendButton();
}

function updateSendButton() {
    const input = document.getElementById('input');
    const group = document.querySelector('.send-group');
    if (!input || !group) return;
    const hasContent = input.value.trim().length > 0 || pendingAttachments.length > 0;
    group.classList.toggle('inactive', !hasContent);
}

function sendMessage() {
    const input = document.getElementById('input');
    let text = input.value.trim();

    if (!text && pendingAttachments.length === 0) return;

    // Prepend active mention toggles if the message doesn't already mention them
    // Skip for non-broadcast slash commands (e.g. /clear, /continue)
    let skipMentions = false;
    if (text.startsWith('/')) {
        const cmdWord = text.split(/\s/)[0].toLowerCase();
        const matchedCmd = SLASH_COMMANDS.find(c => c.cmd.startsWith(cmdWord) || cmdWord.startsWith(c.cmd.split(/\s/)[0]));
        if (matchedCmd && !matchedCmd.broadcast) {
            skipMentions = true;
        }
        // Commands that need an @mention — show hint and keep command in input
        if (matchedCmd && matchedCmd.needsMention && !/@\w[\w-]*/.test(text)) {
            const canonical = matchedCmd.cmd.split(/\s/)[0];  // e.g. '/summary'
            input.value = canonical + ' @';
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
            showSlashHint(`Tag an agent: ${canonical} @claude`);
            // Trigger mention autocomplete for the '@'
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }
    }
    if (activeMentions.size > 0 && text && !skipMentions) {
        const prefix = [...activeMentions].map(n => `@${n}`).join(' ');
        // Only prepend if user didn't already @mention these agents
        const lower = text.toLowerCase();
        const missing = [...activeMentions].filter(n => !lower.includes(`@${n}`));
        if (missing.length > 0) {
            text = missing.map(n => `@${n}`).join(' ') + ' ' + text;
        }
    }

    const payload = {
        type: 'message',
        text: text,
        sender: Store.get('username'),
        channel: activeChannel,
        attachments: pendingAttachments.map(a => ({
            path: a.path,
            name: a.name,
            url: a.url,
        })),
    };
    if (replyingTo) {
        payload.reply_to = replyingTo.id;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        wsClient.sendObj(payload);
    }

    input.value = '';
    input.style.height = 'auto';
    clearAttachments();
    cancelReply();
    updateSendButton();
    input.focus();
}

// --- Image paste/drop ---

function setupPaste() {
    document.addEventListener('paste', async (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;

        // Route to job upload if job input is focused
        const jobInput = document.getElementById('jobs-conv-input-text');
        const isJobFocused = jobInput && document.activeElement === jobInput;

        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (isJobFocused) {
                    await uploadJobImage(file);
                } else {
                    await uploadImage(file);
                }
            }
        }
    });
}

function setupDragDrop() {
    const dropzone = document.getElementById('dropzone');
    let dragCount = 0;

    document.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCount++;
        if (e.dataTransfer?.types?.includes('Files')) {
            dropzone.classList.remove('hidden');
        }
    });

    document.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCount--;
        if (dragCount <= 0) {
            dragCount = 0;
            dropzone.classList.add('hidden');
        }
    });

    document.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    document.addEventListener('drop', async (e) => {
        e.preventDefault();
        dragCount = 0;
        dropzone.classList.add('hidden');

        const files = e.dataTransfer?.files;
        if (!files) return;

        for (const file of files) {
            if (file.type.startsWith('image/')) {
                await uploadImage(file);
            }
        }
    });
}

async function uploadImage(file) {
    const form = new FormData();
    form.append('file', file);

    try {
        const resp = await api.postForm('/api/upload', form);
        const data = await resp.json();

        pendingAttachments.push({
            path: data.path,
            name: data.name,
            url: data.url,
        });

        renderAttachments();
    } catch (err) {
        console.error('Upload failed:', err);
    }
}

function renderAttachments() {
    const container = document.getElementById('attachments');
    container.innerHTML = '';

    pendingAttachments.forEach((att, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'attachment-preview';
        wrap.innerHTML = `
            <img src="${att.url}" alt="${escapeHtml(att.name)}" onclick="openImageModal('${escapeHtml(att.url)}')" title="Click to preview">
            <button class="remove-btn" onclick="removeAttachment(${i})">x</button>
        `;
        container.appendChild(wrap);
    });
    repositionScrollAnchor();
}

function removeAttachment(index) {
    pendingAttachments.splice(index, 1);
    renderAttachments();
}

function clearAttachments() {
    pendingAttachments = [];
    document.getElementById('attachments').innerHTML = '';
    repositionScrollAnchor();
}

// --- Scroll tracking ---

function setupScroll() {
    const timeline = document.getElementById('timeline');
    const messages = document.getElementById('messages');

    timeline.addEventListener('scroll', () => {
        const distFromBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
        autoScroll = distFromBottom < 60;

        if (autoScroll) {
            unreadCount = 0;
        }
        updateScrollAnchor();
    });

    // Keep pinned to bottom when content changes (e.g. images load)
    const resizeObserver = new ResizeObserver(() => {
        if (autoScroll) {
            scrollToBottom();
        }
    });
    resizeObserver.observe(messages);

    // Reposition scroll-anchor when window resizes or sidebars toggle
    window.addEventListener('resize', repositionScrollAnchor);
    const contentArea = document.querySelector('.content-area');
    if (contentArea) {
        new ResizeObserver(repositionScrollAnchor).observe(contentArea);
    }

    // Support button label collapses via CSS overflow (grid column shrinks naturally).
    // No JS measurement needed.
}

// --- Reply ---

function copyMessage(msgId, event) {
    if (event) event.stopPropagation();
    const el = document.querySelector(`.message[data-id="${msgId}"]`);
    if (!el) return;
    const msgText = el.querySelector('.msg-text');
    const html = msgText?.innerHTML || '';
    const markdown = el.dataset.rawText || msgText?.innerText || '';
    const done = () => {
        const btn = el.querySelector('.bubble-copy');
        if (btn) {
            btn.classList.add('copied');
            setTimeout(() => btn.classList.remove('copied'), 1500);
        }
    };
    // Rich HTML + raw markdown — rich editors get HTML, code/markdown editors get source
    if (navigator.clipboard.write) {
        navigator.clipboard.write([new ClipboardItem({
            'text/html': new Blob([html], {type: 'text/html'}),
            'text/plain': new Blob([markdown], {type: 'text/plain'}),
        })]).then(done);
    } else {
        navigator.clipboard.writeText(markdown).then(done);
    }
}

function startReply(msgId, event) {
    if (event) event.stopPropagation();
    const el = document.querySelector(`.message[data-id="${msgId}"]`);
    if (!el) return;
    const sender = el.querySelector('.msg-sender')?.textContent?.trim() || '?';
    const text = el.dataset.rawText || el.querySelector('.msg-text')?.textContent || '';
    replyingTo = { id: msgId, sender, text };
    renderReplyPreview();

    // Auto-activate mention chip for the replied-to sender, deactivate others
    const resolved = resolveAgent(sender.toLowerCase());
    if (resolved) {
        for (const btn of document.querySelectorAll('.mention-toggle')) {
            const agent = btn.dataset.agent;
            if (agent === resolved) {
                activeMentions.add(agent);
                btn.classList.add('active');
            } else {
                activeMentions.delete(agent);
                btn.classList.remove('active');
            }
        }
    }

    document.getElementById('input').focus();
}

function renderReplyPreview() {
    let container = document.getElementById('reply-preview');
    if (!replyingTo) {
        if (container) container.remove();
        return;
    }
    if (!container) {
        container = document.createElement('div');
        container.id = 'reply-preview';
        const inputRow = document.getElementById('input-row');
        inputRow.parentNode.insertBefore(container, inputRow);
    }
    const truncated = replyingTo.text.length > 100 ? replyingTo.text.slice(0, 100) + '...' : replyingTo.text;
    const color = getColor(replyingTo.sender);
    container.innerHTML = `<span class="reply-preview-label">replying to</span> <span style="color: ${color}; font-weight: 600">${escapeHtml(replyingTo.sender)}</span>: ${escapeHtml(truncated)} <button class="dismiss-btn reply-cancel" onclick="cancelReply()">&times;</button>`;
}

function cancelReply() {
    replyingTo = null;
    const el = document.getElementById('reply-preview');
    if (el) el.remove();
}

function scrollToMessage(msgId) {
    const el = document.querySelector(`.message[data-id="${msgId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('highlight');
    setTimeout(() => el.classList.remove('highlight'), 1500);
}

// --- Todos ---

function todoStatusLabel(status) {
    if (!status) return 'pin';
    if (status === 'todo') return 'done?';
    return 'unpin';
}

function todoCycle(msgId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const status = todos[msgId] || null;
    if (!status) {
        wsClient.send('todo_add', { id: msgId });
    } else if (status === 'todo') {
        wsClient.send('todo_toggle', { id: msgId });
    } else {
        // done → remove
        wsClient.send('todo_remove', { id: msgId });
    }
}

function todoAdd(msgId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    wsClient.send('todo_add', { id: msgId });
}

function todoToggle(msgId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    wsClient.send('todo_toggle', { id: msgId });
}

function todoRemove(msgId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    wsClient.send('todo_remove', { id: msgId });
}

function updateTodoState(msgId, status) {
    const el = document.querySelector(`.message[data-id="${msgId}"]`);
    if (!el) return;

    el.classList.remove('msg-todo', 'msg-todo-todo', 'msg-todo-done');

    if (status === 'todo') {
        el.classList.add('msg-todo', 'msg-todo-todo');
    } else if (status === 'done') {
        el.classList.add('msg-todo', 'msg-todo-done');
    }

    const hint = el.querySelector('.todo-hint');
    if (hint) hint.textContent = todoStatusLabel(status);

    // Update panel if open
    const panel = document.getElementById('pins-panel');
    if (!panel.classList.contains('hidden')) renderTodosPanel();
}

// --- Delete mode ---

let deleteMode = false;
let deleteSelected = new Set();
let deleteDragging = false;

function deleteClick(msgId, event) {
    event.stopPropagation();
    enterDeleteMode(msgId);
}

function enterDeleteMode(initialId) {
    if (deleteMode) return;
    deleteMode = true;
    deleteSelected.clear();
    if (initialId != null) deleteSelected.add(initialId);

    // Add delete-mode class — children transform right (no layout reflow)
    document.getElementById('messages').classList.add('delete-mode');

    // Add radio circles to all messages (not joins)
    document.querySelectorAll('.message[data-id]').forEach(el => {
        if (el.classList.contains('join-msg') || el.classList.contains('summary-msg')) return;
        // system-msg is excluded UNLESS it's a deletable subtype (banners, breadcrumbs, drafts)
        if (el.classList.contains('system-msg')
            && !el.classList.contains('session-banner')
            && !el.classList.contains('session-draft-card')
            && !el.classList.contains('job-breadcrumb')) return;
        const id = parseInt(el.dataset.id);
        const circle = document.createElement('div');
        circle.className = 'delete-radio' + (deleteSelected.has(id) ? ' selected' : '');
        circle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            toggleDeleteSelect(id);
            deleteDragging = true;
        });
        circle.addEventListener('mouseenter', () => {
            if (deleteDragging) toggleDeleteSelect(id, true);
        });
        el.prepend(circle);
    });

    // Add radio circles to collapsed job-groups (selects all children)
    document.querySelectorAll('.job-group').forEach(group => {
        const ids = [...group.querySelectorAll('.job-breadcrumb[data-id]')].map(el => parseInt(el.dataset.id));
        if (ids.length === 0) return;
        const circle = document.createElement('div');
        circle.className = 'delete-radio';
        circle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const allSelected = ids.every(id => deleteSelected.has(id));
            ids.forEach(id => {
                if (allSelected) deleteSelected.delete(id); else deleteSelected.add(id);
                const child = group.querySelector(`.job-breadcrumb[data-id="${id}"] .delete-radio`);
                if (child) child.classList.toggle('selected', !allSelected);
            });
            circle.classList.toggle('selected', !allSelected);
            updateDeleteBar();
            deleteDragging = true;
        });
        circle.addEventListener('mouseenter', () => {
            if (deleteDragging) {
                ids.forEach(id => deleteSelected.add(id));
                circle.classList.add('selected');
                updateDeleteBar();
            }
        });
        group.prepend(circle);
    });

    // Show floating delete bar
    showDeleteBar();
    updateDeleteBar();
    repositionScrollAnchor();
}

function toggleDeleteSelect(id, dragForceSelect) {
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if (!el) return;
    const circle = el.querySelector('.delete-radio');

    if (dragForceSelect) {
        deleteSelected.add(id);
        if (circle) circle.classList.add('selected');
    } else {
        if (deleteSelected.has(id)) {
            deleteSelected.delete(id);
            if (circle) circle.classList.remove('selected');
        } else {
            deleteSelected.add(id);
            if (circle) circle.classList.add('selected');
        }
    }
    updateDeleteBar();
}

function showDeleteBar() {
    let bar = document.getElementById('delete-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'delete-bar';
        bar.innerHTML = `<button class="delete-bar-cancel" onclick="exitDeleteMode()">Cancel</button><span class="delete-bar-count"></span><button class="delete-bar-confirm" onclick="confirmDelete()">Delete</button>`;
        const footer = document.querySelector('footer');
        footer.parentNode.insertBefore(bar, footer);
    }
    bar.classList.remove('hidden');
}

function updateDeleteBar() {
    const count = deleteSelected.size;
    const span = document.querySelector('.delete-bar-count');
    if (span) span.textContent = count > 0 ? `${count} selected` : 'Select messages';
    const btn = document.querySelector('.delete-bar-confirm');
    if (btn) {
        btn.textContent = count > 0 ? `Delete (${count})` : 'Delete';
        btn.disabled = count === 0;
    }
}

function confirmDelete() {
    if (!ws || deleteSelected.size === 0) return;
    wsClient.send('delete', { ids: [...deleteSelected] });
    exitDeleteMode();
}

function exitDeleteMode() {
    deleteMode = false;
    deleteSelected.clear();
    deleteDragging = false;

    // Remove delete-mode — children transform back (no layout reflow)
    document.getElementById('messages').classList.remove('delete-mode');

    // Collapse bar
    const bar = document.getElementById('delete-bar');
    if (bar) {
        bar.classList.add('hidden');
    }

    // Fade out radios then remove
    document.querySelectorAll('.delete-radio').forEach(el => {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.2s';
        setTimeout(() => el.remove(), 200);
    });

    repositionScrollAnchor();
}

// Auto-scroll while dragging near edges
let deleteScrollInterval = null;
document.addEventListener('mousemove', (e) => {
    if (!deleteDragging) return;
    const timeline = document.getElementById('timeline');
    const rect = timeline.getBoundingClientRect();
    const edgeZone = 60;

    if (e.clientY < rect.top + edgeZone) {
        // Near top — scroll up
        if (!deleteScrollInterval) {
            deleteScrollInterval = setInterval(() => timeline.scrollTop -= 8, 16);
        }
    } else if (e.clientY > rect.bottom - edgeZone) {
        // Near bottom — scroll down
        if (!deleteScrollInterval) {
            deleteScrollInterval = setInterval(() => timeline.scrollTop += 8, 16);
        }
    } else if (deleteScrollInterval) {
        clearInterval(deleteScrollInterval);
        deleteScrollInterval = null;
    }
});

// Stop drag on mouseup
document.addEventListener('mouseup', () => {
    deleteDragging = false;
    if (deleteScrollInterval) {
        clearInterval(deleteScrollInterval);
        deleteScrollInterval = null;
    }
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && deleteMode) exitDeleteMode();
});

function handleDeleteBroadcast(ids) {
    for (const id of ids) {
        const el = document.querySelector(`.message[data-id="${id}"]`);
        if (el) el.remove();
        // Clean from todos
        delete todos[id];
    }
    // Refresh todos panel if open
    const panel = document.getElementById('pins-panel');
    if (panel && !panel.classList.contains('hidden')) renderTodosPanel();
}

function togglePinsPanel() {
    _preserveScroll(() => {
        const panel = document.getElementById('pins-panel');
        panel.classList.toggle('hidden');
        document.getElementById('pins-toggle').classList.toggle('active', !panel.classList.contains('hidden'));
        if (!panel.classList.contains('hidden')) {
            renderTodosPanel();
        }
    });
}

function renderTodosPanel() {
    const list = document.getElementById('pins-list');
    list.innerHTML = '';

    const todoIds = Object.keys(todos);
    if (todoIds.length === 0) {
        list.innerHTML = '<div class="pins-empty">No pinned messages</div>';
        return;
    }

    // Chronological order (by message ID)
    const sorted = todoIds.map(Number).sort((a, b) => a - b);

    for (const id of sorted) {
        const el = document.querySelector(`.message[data-id="${id}"]`);
        if (!el) continue;

        const status = todos[id];
        const item = document.createElement('div');
        item.className = `todo-item ${status === 'done' ? 'todo-done' : ''}`;

        const time = el.querySelector('.msg-time')?.textContent || '';
        const sender = (el.querySelector('.msg-sender')?.textContent || '').trim();
        const text = el.querySelector('.msg-text')?.textContent || '';
        const senderColor = el.querySelector('.msg-sender')?.style.color || 'var(--text)';

        const check = status === 'done' ? '&#10003;' : '&#9675;';
        const checkClass = status === 'done' ? 'todo-check done' : 'todo-check';
        const msgChannel = el.dataset.channel || 'general';

        item.innerHTML = `<button class="${checkClass}" onclick="todoToggle(${id})">${check}</button><span class="msg-time" style="color:var(--accent);font-weight:600;margin-right:4px">#${msgChannel}</span> <span class="msg-time">${escapeHtml(time)}</span> <span class="msg-sender" style="color: ${senderColor}">${escapeHtml(sender)}</span> <span class="msg-text">${escapeHtml(text)}</span><button class="dismiss-btn danger" onclick="todoRemove(${id})" title="Remove from todos">&times;</button>`;
        item.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            // Cross-channel pin: switch channel if needed
            const msgChannel = el.dataset.channel || 'general';
            if (msgChannel !== activeChannel) {
                switchChannel(msgChannel);
            }
            scrollToMessage(id);
            togglePinsPanel();
        });
        list.appendChild(item);
    }
}

// --- Mention toggles ---

function buildMentionToggles() {
    const container = document.getElementById('mention-toggles');
    container.innerHTML = '';

    // Prune stale mentions for agents no longer in config
    for (const name of activeMentions) {
        if (!(name in Store.get('agentConfig'))) activeMentions.delete(name);
    }

    for (const [name, cfg] of Object.entries(Store.get('agentConfig'))) {
        if (cfg.state === 'pending') continue;  // skip pending instances
        const btn = document.createElement('button');
        btn.className = 'mention-toggle';
        btn.dataset.agent = name;
        btn.textContent = `@${cfg.label || name}`;
        btn.title = `@${name}`;  // Tooltip: canonical name
        btn.style.setProperty('--agent-color', Store.get('colorOverrides')[name] || cfg.color);
        // Restore active state for mentions that survived the rebuild
        if (activeMentions.has(name)) {
            btn.classList.add('active');
        }
        btn.onclick = () => {
            if (activeMentions.has(name)) {
                activeMentions.delete(name);
                btn.classList.remove('active');
            } else {
                activeMentions.add(name);
                btn.classList.add('active');
            }
            updateSchedulePopoverState();
        };
        container.appendChild(btn);
    }
    enableDragScroll(container);
}

// --- Voice typing ---

let recognition = null;
let isListening = false;

function focusComposerInput() {
    const input = document.getElementById('input');
    if (!input) return null;
    try {
        input.focus({ preventScroll: true });
    } catch (_) {
        input.focus();
    }
    return input;
}

function toggleVoice() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        alert('Speech recognition not supported — use Chrome or Edge.');
        return;
    }

    if (isListening) {
        stopVoice();
        return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.lang = 'en-GB';
    recognition.continuous = true;
    recognition.interimResults = true;

    const input = focusComposerInput();
    if (!input) return;
    const baseText = input.value;
    let finalTranscript = '';
    const micButton = document.getElementById('mic');

    recognition.onstart = () => {
        isListening = true;
        micButton.classList.add('recording');
        micButton.setAttribute('aria-pressed', 'true');
        focusComposerInput();
    };

    recognition.onresult = (e) => {
        let interim = '';
        finalTranscript = '';
        for (let i = 0; i < e.results.length; i++) {
            const t = e.results[i][0].transcript;
            if (e.results[i].isFinal) {
                finalTranscript += t;
            } else {
                interim += t;
            }
        }
        input.value = baseText + (baseText ? ' ' : '') + finalTranscript + interim;
        focusComposerInput();
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    };

    recognition.onerror = (e) => {
        console.error('Speech error:', e.error);
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            alert('Microphone access was blocked. Allow microphone access in Chrome and try again.');
            stopVoice();
        } else if (e.error === 'no-speech' || e.error === 'aborted') {
            // no-speech: Chrome fires after ~5s silence — keep listening
            // aborted: fires during restart cycle — safe to ignore
            console.log('Speech:', e.error, '— still listening...');
        } else {
            stopVoice();
        }
    };

    recognition.onend = () => {
        // If still supposed to be listening (e.g. after no-speech), restart
        if (isListening) {
            try { recognition.start(); } catch (_) { stopVoice(); }
        } else {
            stopVoice();
        }
    };

    try {
        recognition.start();
    } catch (e) {
        console.error('Speech start failed:', e);
        stopVoice();
    }
}

function stopVoice() {
    isListening = false;
    const micButton = document.getElementById('mic');
    if (micButton) {
        micButton.classList.remove('recording');
        micButton.setAttribute('aria-pressed', 'false');
    }
    if (recognition) {
        try { recognition.stop(); } catch (_) {}
        recognition = null;
    }
    focusComposerInput();
}

// --- Image modal ---

let modalImages = [];  // all image URLs in chat
let modalIndex = 0;    // current image index

function getAllChatImages() {
    const imgs = document.querySelectorAll('.msg-attachments img, .job-msg-attachments img');
    return [...imgs].map(img => img.src);
}

function openImageModal(url) {
    modalImages = getAllChatImages();
    // Match by endsWith since onclick passes relative URL but img.src is absolute
    modalIndex = modalImages.findIndex(src => src.endsWith(url) || src === url);
    if (modalIndex === -1) {
        // Image not in chat gallery (e.g. composer preview) — show it standalone
        modalImages = [url];
        modalIndex = 0;
    }

    let modal = document.getElementById('image-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'image-modal';
        modal.className = 'hidden';
        modal.innerHTML = `<button class="modal-nav modal-prev" onclick="modalPrev(event)">&lsaquo;</button><img onclick="event.stopPropagation()"><button class="modal-nav modal-next" onclick="modalNext(event)">&rsaquo;</button><span class="modal-counter"></span>`;
        modal.addEventListener('click', closeImageModal);
        document.body.appendChild(modal);
    }
    updateModalImage(modal);
    modal.classList.remove('hidden');
}

function updateModalImage(modal) {
    if (!modal) modal = document.getElementById('image-modal');
    if (!modal || modalImages.length === 0) return;
    modal.querySelector('img').src = modalImages[modalIndex];
    const counter = modal.querySelector('.modal-counter');
    if (counter) {
        counter.textContent = `${modalIndex + 1} / ${modalImages.length}`;
    }
    // Hide arrows at beginning/end, or if only one image
    const prev = modal.querySelector('.modal-prev');
    const next = modal.querySelector('.modal-next');
    if (prev) prev.style.display = modalIndex > 0 ? 'flex' : 'none';
    if (next) next.style.display = modalIndex < modalImages.length - 1 ? 'flex' : 'none';
}

function modalPrev(event) {
    event.stopPropagation();
    if (modalIndex <= 0) return;
    modalIndex--;
    updateModalImage();
}

function modalNext(event) {
    event.stopPropagation();
    if (modalIndex >= modalImages.length - 1) return;
    modalIndex++;
    updateModalImage();
}

function closeImageModal() {
    const modal = document.getElementById('image-modal');
    if (modal) modal.classList.add('hidden');
}

async function _preserveScroll(fn) {
    const timeline = document.getElementById('timeline');
    if (!timeline) { await fn(); return; }

    // Check if we are at the bottom (with a small buffer)
    const wasAtBottom = autoScroll || (timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 60);
    const topId = _getTopVisibleMsgId();

    // Save the exact pixel offset of the top visible message
    let savedOffset = 0;
    if (topId) {
        const el = document.querySelector(`.message[data-id="${topId}"]`);
        if (el) {
            savedOffset = el.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
        }
    }

    // Disable smooth scrolling for instant correction
    const oldSmooth = timeline.style.scrollBehavior;
    timeline.style.scrollBehavior = 'auto';

    await fn();

    // Continuously correct scroll during sidebar CSS transition
    function correctScroll() {
        if (wasAtBottom) {
            timeline.scrollTop = timeline.scrollHeight;
        } else if (topId) {
            const el = document.querySelector(`.message[data-id="${topId}"]`);
            if (el) {
                const newRect = el.getBoundingClientRect();
                const timelineRect = timeline.getBoundingClientRect();
                timeline.scrollTop += (newRect.top - timelineRect.top) - savedOffset;
            }
        }
    }

    // Correct immediately
    void timeline.scrollHeight;
    correctScroll();

    // Keep correcting each frame during the transition (~300ms)
    let frames = 0;
    function tick() {
        correctScroll();
        if (++frames < 20) requestAnimationFrame(tick); // ~333ms at 60fps
        else timeline.style.scrollBehavior = oldSmooth;
    }
    requestAnimationFrame(tick);
}
window._preserveScroll = _preserveScroll;

// Style #hashtags in rendered message text
function styleHashtags(html) {
    // "Match and skip" pattern: consume HTML tags first (to skip hex colors in
    // style attributes like color: #da7756), then match real hashtags in text.
    return html.replace(/<[^>]*>|((?:^|\s))(#([a-zA-Z][a-zA-Z0-9_-]{0,39}))\b/g,
        (match, prefix, fullHash, tag) => {
            if (tag === undefined) return match; // HTML tag — skip
            const lower = tag.toLowerCase();
            if (['clear', 'off', 'none', 'end'].includes(lower)) {
                return `${prefix}<span class="msg-hashtag" style="opacity:0.5">#${tag}</span>`;
            }
            return `${prefix}<span class="msg-hashtag">#${tag}</span>`;
        });
}

// --- Helpers ---


// escapeHtml moved to static/format.js (dependency-free leaf, loaded first).

// --- Schedules strip ---

function handleScheduleEvent(action, schedule) {
    if (action === 'create') {
        schedulesList = schedulesList.filter(s => s.id !== schedule.id);
        schedulesList.push(schedule);
    } else if (action === 'update') {
        schedulesList = schedulesList.map(s => s.id === schedule.id ? schedule : s);
    } else if (action === 'delete') {
        schedulesList = schedulesList.filter(s => s.id !== schedule.id);
    }
    renderSchedulesBar();
}

function renderSchedulesBar() {
    const bar = document.getElementById('schedules-bar');
    if (!bar) return;

    const active = schedulesList.filter(s => s.active !== false);
    if (schedulesList.length === 0) {
        bar.classList.add('hidden');
        bar.classList.remove('expanded');
        document.getElementById('schedules-list')?.classList.add('hidden');
        repositionScrollAnchor();
        return;
    }

    bar.classList.remove('hidden');

    // Summary line -- Slack-style: describe the next firing
    const countEl = document.getElementById('schedules-count');
    const nextEl = document.getElementById('schedules-next');

    // Clean up inline controls from previous render
    const summaryDiv = bar.querySelector('.schedules-bar-summary');
    summaryDiv.querySelector('.schedule-toggle-inline')?.remove();
    summaryDiv.querySelector('.schedule-delete-inline')?.remove();

    if (schedulesList.length === 1) {
        const s = schedulesList[0];
        const isPaused = s.active === false;
        const targetStr = (s.targets || []).map(t => '@' + t).join(', ');
        countEl.textContent = `${targetStr} "${s.prompt}"` + (isPaused ? ' (paused)' : '');
        const nextStr = (!isPaused && s.next_run) ? formatScheduleTime(s.next_run) : '';
        nextEl.textContent = nextStr
            ? formatScheduleInterval(s) + ' -- next in ' + nextStr
            : formatScheduleInterval(s);
    } else if (active.length > 0) {
        const paused = schedulesList.length - active.length;
        const parts = [`${active.length} active`];
        if (paused > 0) parts.push(`${paused} paused`);
        countEl.textContent = parts.join(', ');
        const futureRuns = active.filter(s => s.next_run && s.next_run * 1000 > Date.now()).map(s => s.next_run);
        const nextTimeStr = futureRuns.length > 0 ? formatScheduleTime(Math.min(...futureRuns)) : '';
        nextEl.textContent = nextTimeStr ? 'next in ' + nextTimeStr : '';
    } else {
        const paused = schedulesList.length;
        countEl.textContent = `${paused} paused schedule${paused !== 1 ? 's' : ''}`;
        nextEl.textContent = '';
    }

    // Inline pause + trash when only 1 schedule; hide "See all" link
    const seeAllLink = summaryDiv.querySelector('.schedules-see-all');
    if (schedulesList.length === 1) {
        const s = schedulesList[0];
        const isPaused = s.active === false;

        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'schedule-toggle-inline' + (isPaused ? ' paused' : '');
        pauseBtn.innerHTML = isPaused
            ? '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M5 3l8 5-8 5V3z" fill="currentColor"/></svg>'
            : '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="4" y="3" width="3" height="10" rx="0.5" fill="currentColor"/><rect x="9" y="3" width="3" height="10" rx="0.5" fill="currentColor"/></svg>';
        pauseBtn.title = isPaused ? 'Resume' : 'Pause';
        pauseBtn.onclick = () => toggleSchedule(s.id);

        const trashBtn = document.createElement('button');
        trashBtn.className = 'schedule-delete-inline';
        trashBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M5.5 4V3a1 1 0 011-1h3a1 1 0 011 1v1M6 7v5M10 7v5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M4 4l.5 9a1 1 0 001 1h5a1 1 0 001-1L12 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        trashBtn.title = 'Delete';
        trashBtn.onclick = () => deleteSchedule(s.id);

        summaryDiv.append(pauseBtn, trashBtn);
        if (seeAllLink) seeAllLink.style.display = 'none';
        // Collapse expanded list — summary has everything
        bar.classList.remove('expanded');
        document.getElementById('schedules-list')?.classList.add('hidden');
        if (seeAllLink) seeAllLink.textContent = 'See all';
    } else {
        if (seeAllLink) seeAllLink.style.display = '';
    }

    // Adjust scroll-anchor so it sits above the footer
    repositionScrollAnchor();

    // Expanded list
    const list = document.getElementById('schedules-list');
    list.innerHTML = '';
    for (const s of schedulesList) {
        const row = document.createElement('div');
        row.className = 'schedule-row' + (s.active === false ? ' paused' : '');

        const targets = document.createElement('span');
        targets.className = 'schedule-targets';
        targets.textContent = (s.targets || []).map(t => '@' + t).join(' ');

        const prompt = document.createElement('span');
        prompt.className = 'schedule-prompt';
        prompt.textContent = s.prompt || '';
        prompt.title = s.prompt || '';

        const interval = document.createElement('span');
        interval.className = 'schedule-interval';
        interval.textContent = formatScheduleInterval(s);

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'schedule-toggle';
        toggleBtn.textContent = s.active === false ? '▶' : '⏸';
        toggleBtn.title = s.active === false ? 'Resume' : 'Pause';
        toggleBtn.onclick = () => toggleSchedule(s.id);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'schedule-delete';
        deleteBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M5.5 4V3a1 1 0 011-1h3a1 1 0 011 1v1M6 7v5M10 7v5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M4 4l.5 9a1 1 0 001 1h5a1 1 0 001-1L12 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        deleteBtn.title = 'Delete';
        deleteBtn.onclick = () => deleteSchedule(s.id);

        row.append(targets, prompt, interval, toggleBtn, deleteBtn);
        list.appendChild(row);
    }
}

function formatScheduleTime(ts) {
    const d = new Date(ts * 1000);
    const now = new Date();
    const diffMs = d - now;
    if (diffMs < 0) return '';
    if (diffMs < 60000) return '<1m';
    if (diffMs < 3600000) return Math.ceil(diffMs / 60000) + 'm';
    if (diffMs < 86400000) {
        const h = Math.floor(diffMs / 3600000);
        const m = Math.ceil((diffMs % 3600000) / 60000);
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatScheduleInterval(s) {
    if (s.daily_at) return 'daily at ' + s.daily_at;
    const sec = s.interval_seconds || 0;
    if (sec < 3600) return 'every ' + Math.round(sec / 60) + 'm';
    if (sec < 86400) return 'every ' + Math.round(sec / 3600) + 'h';
    return 'every ' + Math.round(sec / 86400) + 'd';
}

function toggleSchedulesExpand() {
    const bar = document.getElementById('schedules-bar');
    const list = document.getElementById('schedules-list');
    if (!bar || !list) return;
    const expanded = bar.classList.toggle('expanded');
    list.classList.toggle('hidden', !expanded);
    const link = bar.querySelector('.schedules-see-all');
    if (link) link.textContent = expanded ? 'Hide' : 'See all';
}

async function toggleSchedule(id) {
    try {
        await api.patch(`/api/schedules/${id}/toggle`);
    } catch (e) {
        console.error('Failed to toggle schedule:', e);
    }
}

async function deleteSchedule(id) {
    try {
        await api.del(`/api/schedules/${id}`);
    } catch (e) {
        console.error('Failed to delete schedule:', e);
    }
}

function showScheduleConfirmation() {
    const bar = document.getElementById('schedules-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    // Flash the bar green for 2s then transition back
    bar.classList.add('sched-flash');
    setTimeout(() => bar.classList.remove('sched-flash'), 2000);
}

// --- Schedule popover ---

function toggleSchedulePopover(e) {
    if (e) e.stopPropagation();
    const pop = document.getElementById('schedule-popover');
    if (!pop) return;
    const opening = pop.classList.contains('hidden');
    pop.classList.toggle('hidden');
    if (opening) {
        populateScheduleDropdowns();
        updateSchedulePopoverState();
    }
}

function closeSchedulePopover() {
    const pop = document.getElementById('schedule-popover');
    if (pop) pop.classList.add('hidden');
}

function stepNumInput(id, delta) {
    const el = document.getElementById(id);
    if (!el) return;
    const min = parseInt(el.min) || 1;
    const max = parseInt(el.max) || 99;
    const val = Math.max(min, Math.min(max, (parseInt(el.value) || min) + delta));
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

function stepSchedNum(delta) {
    stepNumInput('sched-interval-val', delta);
}

function toggleRecurringFields() {
    const checked = document.getElementById('sched-recurring')?.checked;
    const fields = document.getElementById('sched-recurring-fields');
    if (fields) fields.classList.toggle('hidden', !checked);
    // Dim both "When" and "At" rows when recurring is active
    const whenRow = document.getElementById('sched-date')?.closest('.sched-pop-row');
    const atRow = document.getElementById('sched-hour')?.closest('.sched-pop-row');
    if (whenRow) whenRow.classList.toggle('sched-dimmed', !!checked);
    if (atRow) atRow.classList.toggle('sched-dimmed', !!checked);
}

function populateScheduleDropdowns() {
    const dateEl = document.getElementById('sched-date');
    const hourEl = document.getElementById('sched-hour');
    const minEl = document.getElementById('sched-minute');
    const ampmEl = document.getElementById('sched-ampm');
    if (!dateEl || !hourEl || !minEl || !ampmEl) return;

    // Date options: Today, Tomorrow, then next 5 weekdays
    dateEl.innerHTML = '';
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const now = new Date();
    for (let i = 0; i < 7; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        const opt = document.createElement('option');
        opt.value = d.toISOString().slice(0, 10);
        opt.textContent = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : days[d.getDay()];
        dateEl.appendChild(opt);
    }

    // Default to next rounded quarter hour
    const nextQuarter = new Date(now);
    nextQuarter.setMinutes(Math.ceil(nextQuarter.getMinutes() / 15) * 15 + 15, 0, 0);
    const defHr = nextQuarter.getHours();
    const defMin = nextQuarter.getMinutes();

    // Hour (1-12)
    hourEl.innerHTML = '';
    for (let h = 1; h <= 12; h++) {
        const opt = document.createElement('option');
        opt.value = h;
        opt.textContent = h;
        const match24 = defHr === 0 ? 12 : defHr > 12 ? defHr - 12 : defHr;
        if (h === match24) opt.selected = true;
        hourEl.appendChild(opt);
    }

    // Minute (00, 15, 30, 45)
    minEl.innerHTML = '';
    for (const m of [0, 15, 30, 45]) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = String(m).padStart(2, '0');
        if (m === defMin) opt.selected = true;
        minEl.appendChild(opt);
    }

    // AM/PM
    ampmEl.innerHTML = '';
    for (const p of ['AM', 'PM']) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        if ((defHr < 12 && p === 'AM') || (defHr >= 12 && p === 'PM')) opt.selected = true;
        ampmEl.appendChild(opt);
    }
}

function getScheduleTime24() {
    let h = parseInt(document.getElementById('sched-hour')?.value) || 12;
    const m = parseInt(document.getElementById('sched-minute')?.value) || 0;
    const ampm = document.getElementById('sched-ampm')?.value || 'AM';
    if (ampm === 'PM' && h < 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function updateSchedulePopoverState() {
    const pop = document.getElementById('schedule-popover');
    if (!pop || pop.classList.contains('hidden')) return;
    const errEl = document.getElementById('sched-pop-error');
    const submitBtn = pop.querySelector('.sched-pop-submit');
    const input = document.getElementById('input');
    const text = input ? input.value.trim() : '';
    const mentionMatches = text.match(/@(\w[\w-]*)/g) || [];
    const targets = new Set(mentionMatches.map(m => m.slice(1)));
    for (const name of activeMentions) targets.add(name);
    if (targets.size === 0) {
        if (errEl) { errEl.textContent = 'Toggle an agent to set a target'; errEl.classList.remove('hidden'); }
        if (submitBtn) { submitBtn.disabled = true; }
    } else {
        if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }
        if (submitBtn) { submitBtn.disabled = false; }
    }
}

async function submitSchedulePopover() {
    const input = document.getElementById('input');
    const text = input ? input.value.trim() : '';

    // Gather targets
    const mentionMatches = text.match(/@(\w[\w-]*)/g) || [];
    const targets = new Set(mentionMatches.map(m => m.slice(1)));
    for (const name of activeMentions) targets.add(name);
    let prompt = text.replace(/@\w[\w-]*/g, '').trim();

    const errEl = document.getElementById('sched-pop-error');

    if (targets.size === 0) return; // button should be disabled anyway
    if (!prompt) {
        if (errEl) { errEl.textContent = 'Type a message first'; errEl.classList.remove('hidden'); }
        return;
    }

    const recurring = document.getElementById('sched-recurring')?.checked;
    const dateVal = document.getElementById('sched-date')?.value;
    const timeVal = getScheduleTime24();
    const intervalVal = parseInt(document.getElementById('sched-interval-val')?.value) || 1;
    const intervalUnit = document.getElementById('sched-interval-unit')?.value || 'hours';

    // Build spec for the API
    let spec, confirmText;
    if (recurring) {
        const unitShort = intervalUnit === 'minutes' ? 'm' : intervalUnit === 'hours' ? 'h' : 'd';
        spec = `every ${intervalVal}${unitShort}`;
        confirmText = spec;
    } else {
        // One-shot: "daily at HH:MM" with one_shot flag
        spec = `daily at ${timeVal}`;
        confirmText = `${dateVal} at ${timeVal}`;
    }

    closeSchedulePopover();

    try {
        const body = {
            prompt: prompt,
            targets: [...targets],
            channel: activeChannel,
            spec: spec,
            created_by: Store.get('username'),
        };
        if (!recurring) body.one_shot = true;
        if (!recurring && dateVal) body.send_at_date = dateVal;

        const resp = await api.post('/api/schedules', body);
        if (resp.ok) {
            input.value = '';
            input.style.height = 'auto';
            updateSendButton();
            showScheduleConfirmation();
        } else {
            const err = await resp.json().catch(() => ({}));
            showSlashHint(err.error || 'Failed to schedule');
        }
    } catch (e) {
        console.error('Failed to create schedule:', e);
        showSlashHint('Failed to create schedule');
    }
}

// Close popover on outside click
document.addEventListener('click', (e) => {
    const pop = document.getElementById('schedule-popover');
    if (pop && !pop.classList.contains('hidden')) {
        if (!e.target.closest('.schedule-popover') && !e.target.closest('footer')) {
            pop.classList.add('hidden');
        }
    }
});

// Refresh "next: Xm" countdowns every 30s
setInterval(() => {
    if (schedulesList.length > 0) renderSchedulesBar();
}, 10000);

// --- Decision card resolve (with fade animation) ---
async function resolveDecision(msgId, choice) {
    // Fade out buttons immediately
    const msgEl = document.querySelector(`.message[data-id="${msgId}"]`);
    const buttons = msgEl ? msgEl.querySelectorAll('.decision-choice') : [];
    buttons.forEach(btn => { btn.style.opacity = '0.4'; btn.style.pointerEvents = 'none'; });
    try {
        const res = await api.post(`/api/messages/${msgId}/resolve_decision`, { choice });
        if (!res.ok) {
            const err = await res.json();
            console.error('Failed to resolve decision:', err);
            // Restore buttons on failure
            buttons.forEach(btn => { btn.style.opacity = ''; btn.style.pointerEvents = ''; });
        }
    } catch (e) {
        console.error('Decision resolve error:', e);
        buttons.forEach(btn => { btn.style.opacity = ''; btn.style.pointerEvents = ''; });
    }
}
window.resolveDecision = resolveDecision;

// ---------------------------------------------------------------------------
// Inbound WebSocket events -- subscribe via the Hub (replaces the old onmessage
// switch in connectWebSocket). Each handler receives the raw event object that
// was emitted there. Registered once, at load, so reconnects don't double-bind;
// sessions.js / jobs.js own the 'session'/'channel_renamed' and 'jobs'/'job'
// events and are loaded first, so their handlers still run before these.
// ---------------------------------------------------------------------------

Hub.on('message_update', function (event) {
    // Re-render an updated message in-place (e.g. decision card resolved)
    const updated = event.message;
    if (updated && updated.id) {
        const existing = document.querySelector(`.message[data-id="${updated.id}"]`);
        if (existing && updated.type === 'decision') {
            // Update just the choices area within the bubble
            const choicesEl = existing.querySelector('.decision-choices');
            const meta = updated.metadata || {};
            if (choicesEl && meta.resolved) {
                choicesEl.innerHTML = `<div class="decision-resolved">You chose: <strong>${escapeHtml(meta.chosen || '')}</strong></div>`;
            }
        }
    }
});

Hub.on('message', function (event) {
    // Play notification sound for new messages from others (not joins, not when focused)
    if (Store.get('soundEnabled') && !document.hasFocus() && event.data.type !== 'join' && event.data.type !== 'leave' && event.data.type !== 'summary' && event.data.sender && event.data.sender.toLowerCase() !== Store.get('username').toLowerCase()) {
        playNotificationSound(event.data.sender);
    }
    appendMessage(event.data);
});

Hub.on('agent_renamed', function (event) {
    // Migrate active mentions before the agents config rebuild
    if (activeMentions.has(event.old_name)) {
        activeMentions.delete(event.old_name);
        activeMentions.add(event.new_name);
    }
    // Update sender name, color, and avatar on all existing messages in the DOM
    const newColor = getColor(event.new_name);
    const newAvatar = getAvatarSvg(event.new_name);
    const newAgentKey = (resolveAgent(event.new_name.toLowerCase()) || event.new_name).toLowerCase();
    const newHat = agentHats[newAgentKey] || '';
    document.querySelectorAll('#messages .message').forEach(el => {
        // Regular chat messages
        const senderEl = el.querySelector('.msg-sender');
        if (senderEl && senderEl.textContent === event.old_name) {

            senderEl.textContent = event.new_name;
            senderEl.style.color = newColor;
            // Update bubble accent color
            const bubble = el.querySelector('.chat-bubble');
            if (bubble) bubble.style.setProperty('--bubble-color', newColor);
            // Update avatar
            const avatarWrap = el.querySelector('.avatar-wrap');
            if (avatarWrap) {
                avatarWrap.dataset.agent = newAgentKey;
                const avatar = avatarWrap.querySelector('.avatar');
                if (avatar) {
                    avatar.style.backgroundColor = newColor;
                    avatar.innerHTML = newAvatar;
                }
                // Update hat
                let hatEl = avatarWrap.querySelector('.hat-overlay');
                if (newHat) {
                    if (!hatEl) {
                        hatEl = document.createElement('div');
                        hatEl.className = 'hat-overlay';
                        avatarWrap.appendChild(hatEl);
                    }
                    hatEl.dataset.agent = newAgentKey;
                    hatEl.innerHTML = newHat;
                } else if (hatEl) {
                    hatEl.remove();
                }
            }
        }
        // Join/leave messages (separate structure, no .msg-sender)
        const joinText = el.querySelector('.join-text strong');
        if (joinText && joinText.textContent === event.old_name) {

            joinText.textContent = event.new_name;
            joinText.style.color = newColor;
            const joinDot = el.querySelector('.join-dot');
            if (joinDot) joinDot.style.background = newColor;
        }
    });
});

Hub.on('agents', function (event) {
    applyAgentConfig(event.data);
});

Hub.on('base_colors', function (event) {
    Store.set('baseColors', event.data || {});
});

Hub.on('todos', function (event) {
    todos = {};
    for (const [id, status] of Object.entries(event.data)) {
        todos[parseInt(id)] = status;
    }
});

Hub.on('todo_update', function (event) {
    const d = event.data;
    if (d.status === null) {
        delete todos[d.id];
    } else {
        todos[d.id] = d.status;
    }
    updateTodoState(d.id, d.status);
});

Hub.on('status', function (event) {
    updateStatus(event.data);
    // Status is the last event sent on connect — enable sounds after history
    if (!Store.get('soundEnabled')) {
        Store.set('soundEnabled', true);
        const loader = document.getElementById('loading-indicator');
        if (loader) loader.classList.add('hidden');
        filterMessagesByChannel();
        renderChannelTabs();
        // Ensure refresh/reconnect lands on the latest visible message.
        requestAnimationFrame(() => {
            autoScroll = true;
            scrollToBottom();
        });
    }
});

Hub.on('typing', function (event) {
    updateTyping(event.agent, event.active);
});

Hub.on('settings', function (event) {
    applySettings(event.data);
});

Hub.on('delete', function (event) {
    handleDeleteBroadcast(event.ids);
});

['rules', 'decisions'].forEach(function (t) {
    Hub.on(t, function (event) {
        Store.set('rules', event.data || []);
        renderRulesPanel();
        updateRulesBadge();
    });
});

['rule', 'decision'].forEach(function (t) {
    Hub.on(t, function (event) {
        handleRuleEvent(event.action, event.data);
    });
});

Hub.on('hats', function (event) {
    agentHats = event.data || {};
    updateAllHats();
});

Hub.on('schedules', function (event) {
    schedulesList = event.data || [];
    renderSchedulesBar();
});

Hub.on('schedule', function (event) {
    handleScheduleEvent(event.action, event.data);
});

Hub.on('pending_instance', function (event) {
    // A new 2nd+ instance registered — queue naming lightbox
    _pendingNameQueue.push({
        name: event.name,
        label: event.label || event.name,
        color: event.color || '#888',
        base: event.base || '',
    });
    _showNextPendingName();
});

Hub.on('channel_renamed', function (event) {
    // Migrate data-channel on existing DOM elements
    const container = document.getElementById('messages');
    for (const el of container.children) {
        if ((el.dataset.channel || 'general') === event.old_name) {
            el.dataset.channel = event.new_name;
        }
    }
    // Update per-channel date tracking
    if (lastMessageDates[event.old_name]) {
        lastMessageDates[event.new_name] = lastMessageDates[event.old_name];
        delete lastMessageDates[event.old_name];
    }
    // Update active channel if we were on the renamed one
    if (activeChannel === event.old_name) {
        Store.set('activeChannel', event.new_name);
    }
});

Hub.on('edit', function (event) {
    // A message was edited/demoted — re-render it in place
    const updatedMsg = event.message;
    if (updatedMsg && updatedMsg.id != null) {
        const el = document.querySelector(`.message[data-id="${updatedMsg.id}"]`);
        if (el) {
            // Insert a fresh message after the old one, then remove the old
            const placeholder = document.createElement('div');
            el.after(placeholder);
            el.remove();
            // Temporarily hijack container to insert at the right spot
            const container = document.getElementById('messages');
            appendMessage(updatedMsg);
            // Move the newly appended message to where the old one was
            const newEl = container.lastElementChild;
            if (newEl && newEl.dataset.id == updatedMsg.id) {
                placeholder.replaceWith(newEl);
            } else {
                placeholder.remove();
            }
        }
    }
});

Hub.on('clear', function (event) {
    const _clearDbgList = document.getElementById('jobs-list');
    const _clearDbgBefore = _clearDbgList ? _clearDbgList.children.length : -1;
    console.log('CLEAR_DEBUG clear event received, channel=' + (event.channel || 'ALL'), 'jobs-panel-children-before=' + _clearDbgBefore);
    const clearChannel = event.channel || null;
    if (clearChannel) {
        // Per-channel clear: remove only messages from that channel
        const container = document.getElementById('messages');
        const toRemove = [];
        for (const el of container.children) {
            if (el.dataset.id && (el.dataset.channel || 'general') === clearChannel) {
                toRemove.push(el);
            }
        }
        toRemove.forEach(el => el.remove());
        // Clean up orphaned date dividers and reset tracking
        delete lastMessageDates[clearChannel];
        filterMessagesByChannel();
    } else {
        // Full clear (all channels)
        document.getElementById('messages').innerHTML = '';
        lastMessageDate = null;
        lastMessageDates = {};
    }
    requestAnimationFrame(() => {
        const _clearDbgAfter = _clearDbgList ? _clearDbgList.children.length : -1;
        console.log('CLEAR_DEBUG after clear (next frame), jobs-panel-children=' + _clearDbgAfter);
    });
});

Hub.on('reload', function (event) {
    // Server requests full page reload (e.g. after import)
    location.reload();
});


// --- Start ---

document.addEventListener('DOMContentLoaded', function() { init(); initHelpTour(); });
