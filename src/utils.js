/**
 * KoRest — Cloudflare Workers utils
 * Port of Node.js helper functions to Workers runtime.
 */

const MD5_HEX_RE = /^[a-f0-9]{32}$/;

/**
 * Normalize username: trim whitespace.
 */
export function normUsername(u) {
    return String(u ?? '').trim();
}

/**
 * Normalize password key: trim whitespace.
 */
export function normPasswordKey(p) {
    return String(p ?? '').trim();
}

/**
 * Validate a password key string.
 */
export function validPasswordKey(p) {
    const s = normPasswordKey(p);
    return s.length > 0 && s.length <= 256 && !s.includes('\n');
}

/**
 * Build the deterministic progress record key.
 * Format: `${username}\n${passwordKey}\n${documentNorm}`
 */
export function progressKey(username, passwordKey, document) {
    const u = normUsername(username);
    const p = normPasswordKey(passwordKey);
    const d = String(document ?? '').trim();
    const hex = d.toLowerCase();
    const docNorm = MD5_HEX_RE.test(hex) ? hex : d;
    return `${u}\n${p}\n${docNorm}`;
}

/**
 * Legacy progress key (old format without password key in the hash).
 */
export function legacyProgressKey(username, document) {
    const u = normUsername(username);
    const d = String(document ?? '').trim();
    const hex = d.toLowerCase();
    const docNorm = MD5_HEX_RE.test(hex) ? hex : d;
    return `${u}\n${docNorm}`;
}

/**
 * Validate a document identifier.
 */
export function validDocument(document) {
    const d = String(document ?? '').trim();
    if (!d || d.includes(':') || d.length > 512) return false;
    return true;
}

/**
 * Parse a percentage value into a finite number or null.
 */
export function parsePercentage(raw) {
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : null;
}

/**
 * Redact sensitive headers for logging.
 */
export function redactHeaders(raw) {
    if (!raw || typeof raw !== 'object') return raw;
    const h = { ...raw };
    for (const k of Object.keys(h)) {
        const lk = k.toLowerCase();
        if (lk === 'x-auth-key' || lk === 'authorization' || lk === 'cookie') {
            h[k] = '[redacted]';
        }
    }
    return h;
}

/**
 * Redact sensitive body fields for logging.
 */
export function safeBodyForLog(body) {
    if (body == null || typeof body !== 'object' || Array.isArray(body)) return body;
    const b = { ...body };
    if (typeof b.password === 'string') b.password = '[redacted]';
    if (typeof b.progress === 'string' && b.progress.length > 500) {
        b.progress = `${b.progress.slice(0, 500)}… (${b.progress.length} chars total)`;
    }
    return b;
}

/**
 * Constant-time string comparison.
 * Replaces Node.js crypto.timingSafeEqual for Workers runtime.
 */
export function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const encoder = new TextEncoder();
    const aBytes = encoder.encode(a);
    const bBytes = encoder.encode(b);
    if (aBytes.length !== bBytes.length) return false;
    let result = 0;
    for (let i = 0; i < aBytes.length; i++) {
        result |= aBytes[i] ^ bBytes[i];
    }
    return result === 0;
}
