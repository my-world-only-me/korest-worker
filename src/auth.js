/**
 * KoRest — Cloudflare Workers auth
 * Authentication logic using D1 and constant-time comparison.
 */

import { normUsername, normPasswordKey, constantTimeEqual } from './utils.js';

/**
 * Retrieve stored password_key for a given username from D1.
 * @param {import('..').D1Database} db
 * @param {string} username
 * @returns {Promise<string|null>}
 */
export async function getStoredPassword(db, username) {
    const row = await db
        .prepare('SELECT password_key AS p FROM users WHERE username = ?')
        .bind(normUsername(username))
        .first();
    return row?.p != null ? String(row.p) : null;
}

/**
 * Authenticate a user using the KOReader header-based auth (x-auth-user, x-auth-key).
 * @param {import('..').D1Database} db
 * @param {string|null} user
 * @param {string|null} key
 * @returns {Promise<boolean>}
 */
export async function authOk(db, user, key) {
    if (!normUsername(user) || !normPasswordKey(key)) return false;
    const stored = await getStoredPassword(db, user);
    if (stored == null) return false;
    return constantTimeEqual(stored, key);
}

/**
 * Create a JSON 401 Unauthorized response.
 */
export function unauthorizedResponse() {
    return new Response(JSON.stringify({ message: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
    });
}
