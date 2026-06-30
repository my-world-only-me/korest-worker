/**
 * KoRest — Cloudflare Workers edition
 *
 * Self-hosted KOReader sync server for Readest App.
 * Ported from the Node.js/Fastify/better-sqlite3 version to Workers + D1.
 *
 * Endpoints (identical to original):
 *   GET  /healthstatus
 *   POST /users/create
 *   GET  /users/auth
 *   PUT  /syncs/progress
 *   GET  /syncs/progress/:document
 */

import { initSchema, insertUser, getUserCount, getProgressCount, upsertProgress, deleteProgress, getProgressForUser } from './db.js';
import { authOk, unauthorizedResponse, getStoredPassword } from './auth.js';
import {
    normUsername,
    normPasswordKey,
    validPasswordKey,
    progressKey,
    legacyProgressKey,
    validDocument,
    parsePercentage,
    constantTimeEqual,
    redactHeaders,
    safeBodyForLog,
} from './utils.js';

// ─── App metadata ───────────────────────────────────────────────────────────

const APP_NAME = 'KoRest';
const APP_TAGLINE =
    'Self-hosted KOReader sync server for Readest (Cloudflare Workers)';

// ─── Route matching helper ──────────────────────────────────────────────────

/**
 * Extremely lightweight URL router for Workers.
 * Returns the matched handler or null.
 *
 * @param {string} method
 * @param {URL} url
 * @returns {{ handler: Function, params: Record<string,string> }|null}
 */
function matchRoute(method, url) {
    const path = url.pathname;
    const routes = [
        // Static routes (exact match)
        { method: 'GET', pattern: '/healthstatus', handler: handleHealth },
        { method: 'POST', pattern: '/users/create', handler: handleCreateUser },
        { method: 'GET', pattern: '/users/auth', handler: handleAuth },

        // Parametric routes
        { method: 'PUT', pattern: '/syncs/progress', handler: handlePutProgress },
        {
            method: 'GET',
            pattern: '/syncs/progress/:document',
            handler: handleGetProgress,
            paramName: 'document',
        },
    ];

    for (const r of routes) {
        if (r.method !== method) continue;

        if (r.paramName) {
            // Parametric matching: `/syncs/progress/<document>`
            const prefix = r.pattern.replace(`:${r.paramName}`, '');
            if (path.startsWith(prefix)) {
                const paramValue = path.slice(prefix.length).replace(/\/+$/, '') || '';
                return { handler: r.handler, params: { [r.paramName]: paramValue } };
            }
        } else {
            // Exact match
            if (path === r.pattern) {
                return { handler: r.handler, params: {} };
            }
        }
    }

    return null;
}

// ─── JSON helpers ───────────────────────────────────────────────────────────

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function jsonError(message, status = 500) {
    return json({ message }, status);
}

// ─── Route handlers ─────────────────────────────────────────────────────────

/**
 * GET /healthstatus
 */
async function handleHealth(request, env, ctx, params) {
    const userCount = await getUserCount(env.DB);
    const progressCount = await getProgressCount(env.DB);

    return json({
        message: 'healthy',
        app: APP_NAME,
        tagline: APP_TAGLINE,
        storage: 'd1',
        users: userCount,
        progress: progressCount,
        database: 'Cloudflare D1',
    });
}

/**
 * POST /users/create
 * Body: { username, password }
 */
async function handleCreateUser(request, env, ctx, params) {
    const body = await request.json().catch(() => ({}));
    const username = normUsername(body.username);
    const password = body.password != null ? String(body.password) : '';

    if (!username || !validPasswordKey(password)) {
        return jsonError('Invalid request', 400);
    }

    const existing = await getStoredPassword(env.DB, username);
    if (existing != null) {
        if (constantTimeEqual(existing, password)) {
            return json({ username }, 201);
        }
        return jsonError('Username already registered', 409);
    }

    try {
        await insertUser(env.DB, username, normPasswordKey(password));
    } catch (err) {
        console.error('user insert failed:', err);
        return jsonError('Unknown server error', 500);
    }

    return json({ username }, 201);
}

/**
 * GET /users/auth
 * Headers: x-auth-user, x-auth-key
 */
async function handleAuth(request, env, ctx, params) {
    const user = request.headers.get('x-auth-user');
    const key = request.headers.get('x-auth-key');
    if (!(await authOk(env.DB, user, key))) {
        return unauthorizedResponse();
    }
    return json({ authorized: 'OK' });
}

/**
 * PUT /syncs/progress
 * Headers: x-auth-user, x-auth-key
 * Body: { document, progress, percentage, device, device_id }
 */
async function handlePutProgress(request, env, ctx, params) {
    const user = request.headers.get('x-auth-user');
    const key = request.headers.get('x-auth-key');
    if (!(await authOk(env.DB, user, key))) {
        return unauthorizedResponse();
    }

    const body = await request.json().catch(() => ({}));
    const { document, progress: prog, percentage, device, device_id } = body;

    if (!document || prog === undefined || percentage === undefined || !device) {
        return jsonError('Unknown server error', 500);
    }

    if (!validDocument(String(document))) {
        return jsonError('Invalid document id', 400);
    }

    const pct = parsePercentage(percentage);
    if (pct === null) return jsonError('Invalid percentage', 400);

    const u = normUsername(user);
    const k = normPasswordKey(key);
    const doc = String(document).trim();

    const pk = progressKey(u, k, doc);
    const lk = legacyProgressKey(u, doc);

    // Clean up legacy key if it exists (migration to new format)
    if (lk !== pk) {
        const legacyRow = await env.DB
            .prepare('SELECT id FROM progress WHERE id = ?')
            .bind(lk)
            .first();
        if (legacyRow) {
            await deleteProgress(env.DB, lk);
        }
    }

    const ts = Math.floor(Date.now() / 1000);

    try {
        await upsertProgress(env.DB, {
            id: pk,
            progress: prog === null || prog === undefined ? '' : String(prog),
            percentage: pct,
            device: String(device),
            device_id: device_id != null ? String(device_id) : '',
            timestamp: ts,
        });
    } catch (err) {
        console.error('progress upsert failed:', err);
        return jsonError('Unknown server error', 500);
    }

    return json({ document: doc, timestamp: ts });
}

/**
 * GET /syncs/progress/:document
 * Headers: x-auth-user, x-auth-key
 */
async function handleGetProgress(request, env, ctx, params) {
    const user = request.headers.get('x-auth-user');
    const key = request.headers.get('x-auth-key');
    if (!(await authOk(env.DB, user, key))) {
        return unauthorizedResponse();
    }

    const document = params.document;
    if (!document || !validDocument(String(document))) {
        return jsonError('Unknown server error', 500);
    }

    const u = normUsername(user);
    const k = normPasswordKey(key);
    const doc = String(document).trim();

    const row = await getProgressForUser(env.DB, u, k, doc);

    if (!row) return json({});

    return json({
        username: u,
        document: doc,
        progress: row.progress,
        percentage: row.percentage,
        device: row.device,
        device_id: row.device_id,
        timestamp: row.timestamp,
    });
}

// ─── 404 handler ────────────────────────────────────────────────────────────

function handleNotFound(request, env) {
    const logIncoming =
        (env?.LOG_INCOMING_REQUESTS ?? 'true').toLowerCase() !== 'false';
    if (logIncoming) {
        console.warn(
            `[404] ${request.method} ${request.url} — no handler for this path`,
        );
    }
    return jsonError('Not found', 404);
}

// ─── Request logging ────────────────────────────────────────────────────────

function logRequest(request, env) {
    const logIncoming =
        (env.LOG_INCOMING_REQUESTS ?? 'true').toLowerCase() !== 'false';
    if (!logIncoming) return;

    const url = new URL(request.url);
    const logEntry = {
        msg: 'incoming_request',
        method: request.method,
        url: request.url,
        pathname: url.pathname,
        userAgent: request.headers.get('user-agent'),
        headers: redactHeaders(Object.fromEntries(request.headers)),
    };
    console.log(JSON.stringify(logEntry));
}

// ─── Main fetch handler (Worker entry point) ────────────────────────────────

export default {
    /**
     * @param {Request} request
     * @param {{ DB: D1Database, LOG_INCOMING_REQUESTS?: string }} env
     * @param {ExecutionContext} ctx
     */
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const method = request.method;

        // Request logging
        logRequest(request, env);

        // Ensure schema exists (idempotent)
        ctx.waitUntil(initSchema(env.DB));

        // Route matching
        const match = matchRoute(method, url);

        if (!match) {
            return handleNotFound(request, env);
        }

        try {
            const response = await match.handler(request, env, ctx, match.params);
            // Ensure JSON content type
            if (!response.headers.has('Content-Type')) {
                const clone = new Response(response.body, response);
                clone.headers.set('Content-Type', 'application/json');
                return clone;
            }
            return response;
        } catch (err) {
            console.error('Unhandled error:', err);
            return jsonError('Internal server error', 500);
        }
    },
};
