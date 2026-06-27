/**
 * wsClient.js -- thin outbound WebSocket helper for agentchattr.
 *
 * Centralizes the `ws.send(JSON.stringify({ type, ...payload }))` shape used
 * across modules. Reads the live socket from window.ws (the getter bridge in
 * chat.js) so it always targets the current connection.
 *
 * Faithful 1:1 replacement for the inline sends: it does NOT add a readiness
 * guard, so callers that wrapped their send in `if (ws.readyState === OPEN)`
 * keep that guard and unguarded callers keep their original throw-on-closed
 * behavior.
 */
const wsClient = (() => {
    // send a typed message: wsClient.send('foo', { a: 1 }) -> {type:'foo', a:1}
    function send(type, payload) {
        window.ws.send(JSON.stringify(Object.assign({ type }, payload || {})));
    }

    // send a pre-built object that already carries its own `type`.
    function sendObj(obj) {
        window.ws.send(JSON.stringify(obj));
    }

    return { send, sendObj };
})();

window.wsClient = wsClient;
