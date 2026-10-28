'use strict';
// Preloaded with `node -r` in CLI tests: the token endpoint answers 100016 (bad credentials). No network.
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 100016, message: 'invalid appid or secret' }) });
