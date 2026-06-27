// help.js — first-run help tour / guided overlay (FE-4 Tier-A leaf extraction).
//
// Fully self-contained: DOM + localStorage + its own _help* state, no app-state
// or Store dependency. index.html's help button calls toggleHelp(); chat.js's
// DOMContentLoaded calls initHelpTour() to auto-show on first visit.

// --- Help Guide (row-based layout with stacked modal fallback) ---
var _helpOpen = false;
var _helpResizeTimer = null;

function toggleHelp() {
    _helpOpen ? closeHelp() : openHelp();
}

// --- Card content definitions (shared between both modes) ---
function _helpCardDefs() {
    return [
        {
            id: 'hg-agents',
            anchor: '#agent-status',
            row: 'top',
            html:
            '<div class="hg-module-title">Agents <span class="hg-loc">header pills</span></div>' +
            '<p class="hg-module-desc">The status pills in the header show who is here and what they\'re doing.</p>' +
            '<div class="hg-mock-row">' +
                '<div class="hg-mock-pill hg-pill-available">' +
                    '<span class="hg-mock-dot" style="background:#f97316"></span>' +
                    '<span style="color:#f97316">claude</span>' +
                '</div>' +
                '<span class="hg-mock-label">Online</span>' +
            '</div>' +
            '<div class="hg-mock-row">' +
                '<div class="hg-mock-pill hg-pill-working">' +
                    '<span class="hg-mock-dot" style="background:#4ade80"></span>' +
                    '<span style="color:#34d399">codex</span>' +
                '</div>' +
                '<span class="hg-mock-label">Working &mdash; spinning border</span>' +
            '</div>' +
            '<div class="hg-mock-row">' +
                '<div class="hg-mock-pill hg-pill-offline">' +
                    '<span class="hg-mock-dot" style="background:#555"></span>' +
                    '<span style="color:#555">gemini</span>' +
                '</div>' +
                '<span class="hg-mock-label">Offline</span>' +
            '</div>' +
            '<p class="hg-module-tip">Click any pill to rename it, assign a role, or change its colour.</p>'
        },
        {
            id: 'hg-jobs',
            anchor: '#jobs-toggle',
            row: 'top',
            html:
            '<div class="hg-module-title">Jobs <span class="hg-loc">hover any message + sidebar</span></div>' +
            '<p class="hg-module-desc">Jobs turn conversation into tracked work. Any message can become a job.</p>' +
            '<div class="hg-mock-message">' +
                '<div class="hg-mock-avatar" style="background:#f97316"></div>' +
                '<div class="hg-mock-msg-body">' +
                    '<span class="hg-mock-sender" style="color:#f97316">claude</span>' +
                    '<span class="hg-mock-text">The auth module needs refactoring before we can add SSO support.</span>' +
                '</div>' +
                '<span class="hg-mock-convert-pill">convert to job</span>' +
            '</div>' +
            '<p class="hg-module-tip">Hover any message to see <strong>convert to job</strong>. This opens the Jobs sidebar.</p>' +
            '<div class="hg-mock-panel">' +
                '<div class="hg-mock-panel-header">' +
                    '<span>Jobs sidebar</span>' +
                    '<span class="hg-mock-panel-add">+</span>' +
                '</div>' +
                '<div class="hg-mock-job-card">' +
                    '<span class="hg-mock-job-dot" style="background:#6a6a80"></span>' +
                    '<span class="hg-mock-job-title">Auth refactor</span>' +
                    '<div class="hg-mock-job-toggles">' +
                        '<span class="hg-mock-toggle hg-toggle-open active">TO DO</span>' +
                        '<span class="hg-mock-toggle hg-toggle-done">ACTIVE</span>' +
                        '<span class="hg-mock-toggle hg-toggle-archived">CLOSED</span>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<p class="hg-module-tip">Jobs live in the sidebar. Each one opens its own thread, and you can track it from TO DO to ACTIVE to CLOSED.</p>'
        },
        {
            id: 'hg-rules',
            anchor: '#rules-toggle',
            row: 'top',
            html:
            '<div class="hg-module-title">Rules <span class="hg-loc">top-right panel</span></div>' +
            '<p class="hg-module-desc">Rules tell agents how to work in this room. Active rules are followed automatically.</p>' +
            '<div class="hg-mock-panel">' +
                '<div class="hg-mock-panel-header">' +
                    '<span>Rules</span>' +
                    '<span class="hg-mock-panel-counter">2</span>' +
                    '<span class="hg-mock-panel-add">+</span>' +
                '</div>' +
                '<div class="hg-mock-rule-card">' +
                    '<span class="hg-mock-rule-dot draft"></span>' +
                    '<span class="hg-mock-rule-text">Run tests before committing</span>' +
                    '<span class="hg-mock-rule-badge">draft</span>' +
                '</div>' +
                '<div class="hg-mock-rule-card">' +
                    '<span class="hg-mock-rule-dot active"></span>' +
                    '<span class="hg-mock-rule-text">Always explain your reasoning before making changes</span>' +
                '</div>' +
            '</div>' +
            '<p class="hg-module-tip"><span class="hg-mock-rule-dot active" style="display:inline-block;vertical-align:middle;margin-top:0;margin-right:4px"></span> <strong>Active</strong> = agents follow this. ' +
            '<span class="hg-mock-rule-dot draft" style="display:inline-block;vertical-align:middle;margin-top:0;margin-left:4px;margin-right:4px"></span> <strong>Draft</strong> = not active yet. ' +
            'You or agents can add rules.</p>'
        },
        {
            id: 'hg-channels',
            anchor: '#channel-tabs',
            row: 'middle',
            light: true,
            wide: true,
            html:
            '<div class="hg-module-title">Channels <span class="hg-loc">top bar</span></div>' +
            '<p class="hg-module-desc">Split conversations by topic. Each channel has its own message history.</p>' +
            '<div class="hg-mock-channels">' +
                '<span class="hg-mock-ch active"># general</span>' +
                '<span class="hg-mock-ch"># design</span>' +
                '<span class="hg-mock-ch"># backend</span>' +
                '<span class="hg-mock-ch-add">+</span>' +
            '</div>' +
            '<p class="hg-module-tip">Click <strong>+</strong> to create a new channel. Agents can be mentioned in any channel.</p>'
        },
        {
            id: 'hg-mentions',
            anchor: '.mention-toggle',
            row: 'bottom',
            light: true,
            html:
            '<div class="hg-module-title">Mentions <span class="hg-loc">pills above composer</span></div>' +
            '<p class="hg-module-desc">Type <strong>@</strong> in the composer to mention an agent. The pills above the input let you pre-select who to address. Selected agents are mentioned automatically when you send.</p>' +
            '<p class="hg-module-tip">Mentioned agents receive a trigger and will respond in the channel.</p>'
        },
        {
            id: 'hg-sessions',
            anchor: '#session-launch-btn',
            row: 'bottom',
            html:
            '<div class="hg-module-title">Sessions <span class="hg-loc">play button</span></div>' +
            '<p class="hg-module-desc">Sessions are structured multi-agent workflows with phases and roles. Launch one to coordinate agents on a shared goal.</p>' +
            '<div class="hg-mock-sessions">' +
                '<div class="hg-mock-session-card">' +
                    '<span class="hg-mock-session-icon">&#9654;</span>' +
                    '<div class="hg-mock-session-info">' +
                        '<span class="hg-mock-session-name">Brainstorm</span>' +
                        '<span class="hg-mock-session-desc">Free-form idea generation with all agents</span>' +
                    '</div>' +
                '</div>' +
                '<div class="hg-mock-session-card">' +
                    '<span class="hg-mock-session-icon">&#9654;</span>' +
                    '<div class="hg-mock-session-info">' +
                        '<span class="hg-mock-session-name">Code Review</span>' +
                        '<span class="hg-mock-session-desc">Structured review with phases and roles</span>' +
                    '</div>' +
                '</div>' +
                '<div class="hg-mock-session-card">' +
                    '<span class="hg-mock-session-icon">&#9654;</span>' +
                    '<div class="hg-mock-session-info">' +
                        '<span class="hg-mock-session-name">Design Review</span>' +
                        '<span class="hg-mock-session-desc">Critique and iterate on design decisions</span>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="hg-custom-session">' +
                '<strong>Custom sessions</strong> &mdash; describe a goal and agents will organise themselves into a structured workflow.' +
            '</div>' +
            '<p class="hg-module-tip">Click the <strong>&#9654; play button</strong> next to the composer to start.</p>'
        },
        {
            id: 'hg-scheduling',
            anchor: '#schedule-btn',
            row: 'bottom',
            html:
            '<div class="hg-module-title">Scheduling <span class="hg-loc">clock button</span></div>' +
            '<p class="hg-module-desc">Schedule any message for later delivery, or set up recurring prompts on a timer.</p>' +
            '<div class="hg-mock-sched-entry">' +
                '<span class="hg-sched-time">3:00 PM</span>' +
                '<span style="flex:1;color:var(--text)">@codex check deployment status</span>' +
                '<span class="hg-sched-recur">every 1h</span>' +
            '</div>' +
            '<div class="hg-mock-sched-entry">' +
                '<span class="hg-sched-time">Tomorrow 9 AM</span>' +
                '<span style="flex:1;color:var(--text)">@claude summarise overnight changes</span>' +
            '</div>' +
            '<p class="hg-module-tip">Click the <strong>&#9201; clock button</strong> next to Send to schedule a one-time or recurring message.</p>'
        }
    ];
}

// --- Anchored (desktop) mode ---
function _openHelpAnchored(cardDefs) {
    var svgNS = 'http://www.w3.org/2000/svg';

    // Main overlay container (contains everything)
    var overlay = document.createElement('div');
    overlay.className = 'help-guide';
    overlay.id = 'help-guide';

    // Backdrop (inside overlay)
    var backdrop = document.createElement('div');
    backdrop.className = 'hg-backdrop';
    backdrop.addEventListener('click', closeHelp);
    overlay.appendChild(backdrop);

    // SVG arrow layer (inside overlay)
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'hg-svg-layer');
    svg.id = 'hg-svg-layer';
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    overlay.appendChild(svg);

    // Group cards by row
    var topCards = [], middleCards = [], bottomCards = [];
    var cardMap = {};
    cardDefs.forEach(function(def) {
        cardMap[def.id] = def;
        if (def.row === 'top') topCards.push(def);
        else if (def.row === 'middle') middleCards.push(def);
        else if (def.row === 'bottom') bottomCards.push(def);
    });

    // Create the three rows
    var topRow = document.createElement('div');
    topRow.className = 'hg-row hg-row--top';
    topRow.id = 'hg-row-top';

    var middleRow = document.createElement('div');
    middleRow.className = 'hg-row hg-row--middle';
    middleRow.id = 'hg-row-middle';

    var bottomRow = document.createElement('div');
    bottomRow.className = 'hg-row hg-row--bottom';
    bottomRow.id = 'hg-row-bottom';

    // Track card elements + their defs for arrow drawing
    var cardEls = [];

    // Populate top row (Agents, Jobs, Rules)
    topCards.forEach(function(def) {
        var card = document.createElement('div');
        card.className = 'hg-card' + (def.light ? ' hg-card--light' : '') + (def.wide ? ' hg-card--wide' : '');
        card.id = def.id;
        card.innerHTML = def.html;
        card.addEventListener('click', function(e) { e.stopPropagation(); });
        topRow.appendChild(card);
        cardEls.push({ el: card, def: def });
    });

    // Populate middle row (Channels)
    middleCards.forEach(function(def) {
        var card = document.createElement('div');
        card.className = 'hg-card' + (def.light ? ' hg-card--light' : '') + (def.wide ? ' hg-card--wide' : '');
        card.id = def.id;
        card.innerHTML = def.html;
        card.addEventListener('click', function(e) { e.stopPropagation(); });
        middleRow.appendChild(card);
        cardEls.push({ el: card, def: def });
    });

    // Populate bottom row (Sessions, Mentions, Scheduling)
    bottomCards.forEach(function(def) {
        var card = document.createElement('div');
        card.className = 'hg-card' + (def.light ? ' hg-card--light' : '') + (def.wide ? ' hg-card--wide' : '');
        card.id = def.id;
        card.innerHTML = def.html;
        card.addEventListener('click', function(e) { e.stopPropagation(); });
        bottomRow.appendChild(card);
        cardEls.push({ el: card, def: def });
    });

    overlay.appendChild(topRow);
    overlay.appendChild(middleRow);
    overlay.appendChild(bottomRow);

    // Create spotlight rings on anchor elements
    cardDefs.forEach(function(def) {
        var anchorEl = document.querySelector(def.anchor);
        if (!anchorEl) return;
        var rect = anchorEl.getBoundingClientRect();
        var spot = document.createElement('div');
        spot.className = 'hg-spotlight';
        spot.dataset.anchor = def.anchor;
        var pad = 4;
        spot.style.left = (rect.left - pad) + 'px';
        spot.style.top = (rect.top - pad) + 'px';
        spot.style.width = (rect.width + pad * 2) + 'px';
        spot.style.height = (rect.height + pad * 2) + 'px';
        overlay.appendChild(spot);
    });

    // Dismiss hint
    var hint = document.createElement('div');
    hint.className = 'hg-dismiss-hint';
    hint.textContent = 'Press Esc or click outside to close';
    overlay.appendChild(hint);

    document.body.appendChild(overlay);

    // Store refs for resize handler
    _helpCardEls = cardEls;
    _helpMode = 'anchored';

    // Position rows and draw arrows after layout
    requestAnimationFrame(function() {
        _positionHelpRows();
        _drawHelpArrows();
    });
}

// --- Position rows based on real UI element positions ---
function _positionHelpRows() {
    var header = document.querySelector('header');
    var channelBar = document.getElementById('channel-bar');
    var footer = document.querySelector('footer');

    var headerBottom = header ? header.getBoundingClientRect().bottom : 48;
    var channelBarBottom = channelBar ? channelBar.getBoundingClientRect().bottom : headerBottom + 30;
    var footerTop = footer ? footer.getBoundingClientRect().top : window.innerHeight - 60;

    var topRow = document.getElementById('hg-row-top');
    var middleRow = document.getElementById('hg-row-middle');
    var bottomRow = document.getElementById('hg-row-bottom');

    // Channels first (right below channel bar)
    if (middleRow) middleRow.style.top = (channelBarBottom + 6) + 'px';

    // Agents/Jobs/Rules below channels card
    if (topRow) {
        if (middleRow) {
            var middleBottom = middleRow.getBoundingClientRect().bottom;
            topRow.style.top = (middleBottom + 10) + 'px';
        } else {
            topRow.style.top = (channelBarBottom + 6) + 'px';
        }
    }

    if (bottomRow) bottomRow.style.bottom = (window.innerHeight - footerTop + 6) + 'px';
}

// --- Draw SVG connector lines from cards to their anchors ---
function _drawHelpArrows() {
    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.getElementById('hg-svg-layer');
    if (!svg) return;

    // Clear existing lines
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    _helpCardEls.forEach(function(item) {
        var cardEl = item.el;
        var def = item.def;
        var anchorEl = document.querySelector(def.anchor);
        if (!anchorEl) return;

        var cardRect = cardEl.getBoundingClientRect();
        var anchorRect = anchorEl.getBoundingClientRect();

        var cardCx = cardRect.left + cardRect.width / 2;
        var anchorCx = anchorRect.left + anchorRect.width / 2;

        var lineX1, lineY1, lineX2, lineY2;

        if (def.row === 'top' || def.row === 'middle') {
            // Line from card top-center UP to anchor bottom-center
            lineX1 = cardCx;
            lineY1 = cardRect.top;
            lineX2 = anchorCx;
            lineY2 = anchorRect.bottom;
        } else {
            // Line from card bottom-center DOWN to anchor top-center
            lineX1 = cardCx;
            lineY1 = cardRect.bottom;
            lineX2 = anchorCx;
            lineY2 = anchorRect.top;
        }

        var line = document.createElementNS(svgNS, 'line');
        line.setAttribute('x1', lineX1);
        line.setAttribute('y1', lineY1);
        line.setAttribute('x2', lineX2);
        line.setAttribute('y2', lineY2);
        svg.appendChild(line);

        // Dot at anchor end
        var dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('cx', lineX2);
        dot.setAttribute('cy', lineY2);
        dot.setAttribute('r', '2.5');
        dot.setAttribute('class', 'hg-arrow-dot');
        svg.appendChild(dot);
    });
}

// --- Stacked modal (narrow viewport) mode ---
function _openHelpStacked(cardDefs) {
    // Main overlay container
    var overlay = document.createElement('div');
    overlay.className = 'help-guide';
    overlay.id = 'help-guide';

    // Backdrop (inside overlay)
    var backdrop = document.createElement('div');
    backdrop.className = 'hg-backdrop';
    backdrop.addEventListener('click', closeHelp);
    overlay.appendChild(backdrop);

    var modal = document.createElement('div');
    modal.className = 'hg-modal';

    var content = document.createElement('div');
    content.className = 'hg-content';

    // Sticky header
    var header = document.createElement('div');
    header.className = 'hg-modal-header';
    header.innerHTML = '<span class="hg-modal-title">Guide</span>';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'hg-modal-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', closeHelp);
    header.appendChild(closeBtn);
    content.appendChild(header);

    // Card order for stacked: Agents, Jobs, Rules, Channels, Sessions, Scheduling, Mentions
    var stackedOrder = ['hg-agents', 'hg-jobs', 'hg-rules', 'hg-channels', 'hg-sessions', 'hg-scheduling', 'hg-mentions'];
    var cardMap = {};
    cardDefs.forEach(function(def) { cardMap[def.id] = def; });

    stackedOrder.forEach(function(id) {
        var def = cardMap[id];
        if (!def) return;
        var mod = document.createElement('div');
        mod.className = 'hg-module';
        mod.innerHTML = def.html;
        mod.addEventListener('click', function(e) { e.stopPropagation(); });
        content.appendChild(mod);
    });

    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    _helpCardEls = [];
    _helpMode = 'stacked';
}

// --- Reposition rows, spotlights, and redraw arrows on resize ---
function _helpResizeHandler() {
    clearTimeout(_helpResizeTimer);
    _helpResizeTimer = setTimeout(function() {
        if (!_helpOpen) return;

        // If viewport crossed the threshold, teardown and rebuild in the other mode
        var shouldBeAnchored = window.innerWidth >= 900;
        if ((_helpMode === 'anchored') !== shouldBeAnchored) {
            closeHelp();
            openHelp();
            return;
        }

        if (_helpMode !== 'anchored') return;

        // Re-measure and update row positions
        _positionHelpRows();

        // Reposition spotlight rings
        var spots = document.querySelectorAll('.hg-spotlight');
        spots.forEach(function(spot) {
            var anchorEl = document.querySelector(spot.dataset.anchor);
            if (!anchorEl) return;
            var r = anchorEl.getBoundingClientRect();
            var pad = 4;
            spot.style.left = (r.left - pad) + 'px';
            spot.style.top = (r.top - pad) + 'px';
            spot.style.width = (r.width + pad * 2) + 'px';
            spot.style.height = (r.height + pad * 2) + 'px';
        });

        // Redraw arrows
        _drawHelpArrows();
    }, 60);
}

var _helpCardEls = [];
var _helpMode = null; // 'anchored' or 'stacked'

function openHelp() {
    closeHelp();
    _helpOpen = true;

    var cardDefs = _helpCardDefs();

    if (window.innerWidth >= 900) {
        _openHelpAnchored(cardDefs);
    } else {
        _openHelpStacked(cardDefs);
    }

    document.addEventListener('keydown', _helpKeyHandler);
    window.addEventListener('resize', _helpResizeHandler);
}

function closeHelp() {
    _helpOpen = false;
    _helpCardEls = [];
    _helpMode = null;
    clearTimeout(_helpResizeTimer);
    window.removeEventListener('resize', _helpResizeHandler);
    var el = document.getElementById('help-guide');
    if (el) el.remove();
    // Spotlights and SVG layer are inside help-guide, so they get removed too
    document.removeEventListener('keydown', _helpKeyHandler);
    localStorage.setItem('help_seen', '1');
}

function _helpKeyHandler(e) {
    if (e.key === 'Escape') closeHelp();
}

window.toggleHelp = toggleHelp;
window.closeHelp = closeHelp;

// Auto-show on first visit
function initHelpTour() {
    if (!localStorage.getItem('help_seen')) {
        setTimeout(openHelp, 2500);
    }
}

window.initHelpTour = initHelpTour;
