/**
 * KoRest — Cloudflare Workers DB layer
 * Encapsulates all D1 operations.
 */

import { progressKey, legacyProgressKey } from './utils.js';

/**
 * Ensure schema exists. Called on every warm start (idempotent via IF NOT EXISTS).
 * @param {import('..').D1Database} db
 */
export async function initSchema(db) {
    await db
        .prepare(
            `CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY NOT NULL,
                password_key TEXT NOT NULL
            )`,
        )
        .run();

    await db
        .prepare(
            `CREATE TABLE IF NOT EXISTS progress (
                id TEXT PRIMARY KEY NOT NULL,
                progress TEXT NOT NULL,
                percentage REAL NOT NULL,
                device TEXT NOT NULL,
                device_id TEXT NOT NULL DEFAULT '',
                timestamp INTEGER NOT NULL
            )`,
        )
        .run();
}

/**
 * Insert or create a new user.
 * @param {import('..').D1Database} db
 * @param {string} username
 * @param {string} passwordKey
 */
export async function insertUser(db, username, passwordKey) {
    await db
        .prepare('INSERT INTO users (username, password_key) VALUES (?, ?)')
        .bind(username, passwordKey)
        .run();
}

/**
 * Get user count for health status.
 * @param {import('..').D1Database} db
 */
export async function getUserCount(db) {
    const row = await db.prepare('SELECT COUNT(*) AS c FROM users').first();
    return Number(row?.c ?? 0);
}

/**
 * Get progress record count.
 * @param {import('..').D1Database} db
 */
export async function getProgressCount(db) {
    const row = await db.prepare('SELECT COUNT(*) AS c FROM progress').first();
    return Number(row?.c ?? 0);
}

/**
 * Fetch a progress row by its primary key.
 * @param {import('..').D1Database} db
 * @param {string} id
 */
export async function getProgressRow(db, id) {
    return await db
        .prepare(
            `SELECT progress, percentage, device, device_id, timestamp
             FROM progress WHERE id = ?`,
        )
        .bind(id)
        .first();
}

/**
 * Delete a progress record (used for legacy key cleanup).
 * @param {import('..').D1Database} db
 * @param {string} id
 */
export async function deleteProgress(db, id) {
    await db.prepare('DELETE FROM progress WHERE id = ?').bind(id).run();
}

/**
 * Upsert (insert or update) a progress record.
 * @param {import('..').D1Database} db
 * @param {object} params
 */
export async function upsertProgress(db, { id, progress, percentage, device, device_id, timestamp }) {
    await db
        .prepare(
            `INSERT INTO progress (id, progress, percentage, device, device_id, timestamp)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               progress = excluded.progress,
               percentage = excluded.percentage,
               device = excluded.device,
               device_id = excluded.device_id,
               timestamp = excluded.timestamp`,
        )
        .bind(id, progress, percentage, device, device_id ?? '', timestamp)
        .run();
}

/**
 * High-level: retrieve progress for a given user+document combination.
 * Tries the new key format first, then falls back to legacy format.
 *
 * @param {import('..').D1Database} db
 * @param {string} username
 * @param {string} passwordKey
 * @param {string} document
 * @returns {Promise<object|null>}
 */
export async function getProgressForUser(db, username, passwordKey, document) {
    const pk = progressKey(username, passwordKey, document);
    let row = await getProgressRow(db, pk);
    if (row) return row;

    // Fallback: try legacy key format (without password key in hash)
    const lk = legacyProgressKey(username, document);
    row = await getProgressRow(db, lk);
    return row ?? null;
}
