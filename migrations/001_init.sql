-- KoRest schema for Cloudflare D1
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY NOT NULL,
    password_key TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS progress (
    id TEXT PRIMARY KEY NOT NULL,
    progress TEXT NOT NULL,
    percentage REAL NOT NULL,
    device TEXT NOT NULL,
    device_id TEXT NOT NULL DEFAULT '',
    timestamp INTEGER NOT NULL
);
