-- SQLite Schema for OCPP Proxy
-- Run this on first initialization

-- Config table (replaces Firestore config/proxy document)
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Initialize default config
INSERT OR IGNORE INTO config (key, value) VALUES
    ('targetCsmsUrl', 'ws://localhost/ocpp'),
    ('csmsForwardingEnabled', 'false'),
    ('port', '8080'),
    ('autoChargeEnabled', 'false'),
    ('defaultIdTag', 'ADMIN_TAG');

-- Logs table (replaces Firestore logs collection)
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    charge_point_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('UPSTREAM', 'DOWNSTREAM', 'INJECTION_REQUEST', 'INJECTION_RESPONSE', 'PROXY_RESPONSE')),
    payload TEXT NOT NULL,
    timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Index for efficient queries by charger and time
CREATE INDEX IF NOT EXISTS idx_logs_charger_time ON logs(charge_point_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);

-- Chargers table (replaces Firestore chargers collection)
CREATE TABLE IF NOT EXISTS chargers (
    charge_point_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK(status IN ('ONLINE', 'OFFLINE')),
    last_seen INTEGER NOT NULL
);

-- Auth table (stores basic auth credentials)
CREATE TABLE IF NOT EXISTS auth_users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
