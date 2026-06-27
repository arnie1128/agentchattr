// Dependency-free formatting leaf.
//
// Loaded before chat.js and its sibling panels (sessions/jobs/channels/
// rules-panel) so these helpers are available as globals to all of them.
// Keep this file free of any dependency on live app state (agentConfig,
// Store, the WebSocket) — only pure, self-contained utilities belong here.
// State-aware helpers (getColor, renderMarkdown, resolveAgent, getAvatarSvg)
// stay in chat.js until FE-3 moves the agent/color state into Store.

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
window.escapeHtml = escapeHtml;
