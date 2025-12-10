// Database adapter - replaces Firestore calls
const Database = require('better-sqlite3');
const path = require('path');
const { ensureDefaultUser } = require('./init');

class DatabaseAdapter {
    constructor(dbPath) {
        this.db = new Database(dbPath || path.join(__dirname, 'oye-proxy.db'));
        this.db.pragma('journal_mode = WAL');

        // Ensure default admin user exists if no users
        ensureDefaultUser(this.db);

        // Prepare statements for performance
        this.stmts = {
            // Config
            getConfig: this.db.prepare('SELECT value FROM config WHERE key = ?'),
            setConfig: this.db.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)'),
            getAllConfig: this.db.prepare('SELECT key, value FROM config'),

            // Logs
            insertLog: this.db.prepare(`
                INSERT INTO logs (charge_point_id, direction, payload, timestamp)
                VALUES (?, ?, ?, ?)
            `),
            getLogsByCharger: this.db.prepare(`
                SELECT id, charge_point_id, direction, payload, timestamp
                FROM logs
                WHERE charge_point_id = ?
                ORDER BY timestamp DESC
                LIMIT ?
            `),
            getAllLogs: this.db.prepare(`
                SELECT id, charge_point_id, direction, payload, timestamp
                FROM logs
                ORDER BY timestamp DESC
                LIMIT ?
            `),
            getLogsSince: this.db.prepare(`
                SELECT id, charge_point_id, direction, payload, timestamp
                FROM logs
                WHERE timestamp > ?
                ORDER BY timestamp DESC
                LIMIT ?
            `),
            deleteOldLogs: this.db.prepare(`
                DELETE FROM logs
                WHERE id NOT IN (
                    SELECT id FROM logs
                    WHERE charge_point_id = ?
                    ORDER BY timestamp DESC
                    LIMIT ?
                )
                AND charge_point_id = ?
            `),
            getOldestLogTimestamp: this.db.prepare(`
                SELECT MIN(timestamp) as oldest FROM logs
            `),

            // Chargers
            updateCharger: this.db.prepare(`
                INSERT OR REPLACE INTO chargers (charge_point_id, status, last_seen)
                VALUES (?, ?, ?)
            `),
            getCharger: this.db.prepare('SELECT * FROM chargers WHERE charge_point_id = ?'),
            getAllChargers: this.db.prepare('SELECT * FROM chargers'),

            // Auth
            getUser: this.db.prepare('SELECT * FROM auth_users WHERE username = ?'),
            updatePassword: this.db.prepare('UPDATE auth_users SET password_hash = ? WHERE username = ?')
        };
    }

    // Config methods (replaces Firestore config/proxy document)
    async getConfigValue(key) {
        const row = this.stmts.getConfig.get(key);
        return row ? row.value : null;
    }

    async setConfigValue(key, value) {
        const now = Math.floor(Date.now() / 1000);
        this.stmts.setConfig.run(key, value, now);
    }

    async getAllConfig() {
        const rows = this.stmts.getAllConfig.all();
        return rows.reduce((acc, row) => {
            acc[row.key] = row.value;
            return acc;
        }, {});
    }

    // Log methods (replaces Firestore logs collection)
    async logMessage(chargePointId, direction, payload) {
        const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const timestamp = Math.floor(Date.now() / 1000);
        this.stmts.insertLog.run(chargePointId, direction, payloadStr, timestamp);
    }

    async getLogs(options = {}) {
        const limit = options.limit || 100;

        if (options.chargePointId) {
            return this.stmts.getLogsByCharger.all(options.chargePointId, limit);
        } else if (options.since) {
            return this.stmts.getLogsSince.all(options.since, limit);
        } else {
            return this.stmts.getAllLogs.all(limit);
        }
    }

    // Charger methods (replaces Firestore chargers collection)
    async updateChargerStatus(chargePointId, status) {
        const lastSeen = Math.floor(Date.now() / 1000);
        this.stmts.updateCharger.run(chargePointId, status, lastSeen);
    }

    async getCharger(chargePointId) {
        return this.stmts.getCharger.get(chargePointId);
    }

    async getAllChargers() {
        return this.stmts.getAllChargers.all();
    }

    // Auth methods
    async getUser(username) {
        return this.stmts.getUser.get(username);
    }

    async updatePassword(username, passwordHash) {
        const result = this.stmts.updatePassword.run(passwordHash, username);
        return result.changes > 0;
    }

    // Cleanup method (replaces Firebase Function)
    async cleanupOldLogs(retentionCount = 1000) {
        const chargers = await this.getAllChargers();
        let totalDeleted = 0;

        for (const charger of chargers) {
            const result = this.stmts.deleteOldLogs.run(
                charger.charge_point_id,
                retentionCount,
                charger.charge_point_id
            );
            totalDeleted += result.changes;
        }

        return totalDeleted;
    }

    close() {
        this.db.close();
    }
}

module.exports = DatabaseAdapter;
