/**
 * api.js -- HTTP wrappers for the agentchattr server API.
 *
 * Centralizes the X-Session-Token header and request construction so call
 * sites stop re-specifying headers and the JSON body boilerplate. Each
 * method returns the raw fetch Response, so every caller keeps its own
 * existing .json() / .ok / .catch handling unchanged.
 *
 * Loaded before the feature scripts; reads window.SESSION_TOKEN lazily (at
 * call time) so it picks up the token bridge defined in chat.js.
 */
const api = (() => {
    function _authHeaders(extra) {
        return Object.assign({ 'X-Session-Token': window.SESSION_TOKEN || '' }, extra || {});
    }

    function _jsonInit(method, body) {
        if (body === undefined) {
            return { method, headers: _authHeaders() };
        }
        return {
            method,
            headers: _authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body),
        };
    }

    function get(path) {
        return fetch(path, { headers: _authHeaders() });
    }

    function post(path, body) {
        return fetch(path, _jsonInit('POST', body));
    }

    function patch(path, body) {
        return fetch(path, _jsonInit('PATCH', body));
    }

    function del(path) {
        return fetch(path, { method: 'DELETE', headers: _authHeaders() });
    }

    // multipart/form-data upload: let the browser set the boundary header.
    function postForm(path, formData) {
        return fetch(path, { method: 'POST', headers: _authHeaders(), body: formData });
    }

    return { get, post, patch, del, postForm };
})();

window.api = api;
