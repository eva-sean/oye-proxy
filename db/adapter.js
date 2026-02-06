// Database adapter - replaces Firestore and raw SQLite calls
const knex = require('knex');
const path = require('path');
const config = require('../knexfile');
const logger = require('../logger');

// Singleton instance for in-memory database
let sharedDbInstance = null;

class DatabaseAdapter {
    constructor() {
        const environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';
        const dbConfig = config[environment];
        const useMemoryDb = process.env.USE_MEMORY_DB === 'true';

        // Use singleton for in-memory database to share the same connection
        if (useMemoryDb && sharedDbInstance) {
            logger('INFO', 'Reusing existing in-memory database connection');
            this.db = sharedDbInstance;
            return;
        }

        logger('INFO', `Initializing database adapter for environment: ${environment}`, {
            client: dbConfig.client,
            connection: environment === 'production' ? 'postgres (masked)' : dbConfig.connection.filename
        });

        this.db = knex(dbConfig);

        // Store singleton for in-memory database
        if (useMemoryDb) {
            sharedDbInstance = this.db;
        }
    }

    // Config methods
    async getConfigValue(key) {
        const row = await this.db('config').where('key', key).first();
        return row ? row.value : null;
    }

    async setConfigValue(key, value) {
        const now = Math.floor(Date.now() / 1000);
        // SQLite supports INSERT OR REPLACE, Postgres uses ON CONFLICT
        // Knex .insert().onConflict().merge() works for both
        await this.db('config')
            .insert({ key, value, updated_at: now })
            .onConflict('key')
            .merge();
    }

    async getAllConfig() {
        const rows = await this.db('config').select('key', 'value');
        return rows.reduce((acc, row) => {
            acc[row.key] = row.value;
            return acc;
        }, {});
    }

    // Log methods
    async logMessage(chargePointId, direction, payload) {
        const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const timestamp = Math.floor(Date.now() / 1000);

        await this.db('logs').insert({
            charge_point_id: chargePointId,
            direction,
            payload: payloadStr,
            timestamp
        });
    }

    async getLogs(options = {}) {
        const limit = options.limit || 100;
        let query = this.db('logs').select('id', 'charge_point_id', 'direction', 'payload', 'timestamp');

        if (options.chargePointId) {
            query = query.where('charge_point_id', options.chargePointId);
        } else if (options.since) {
            query = query.where('timestamp', '>', options.since);
        }

        query = query.orderBy('timestamp', 'desc').limit(limit);

        return await query;
    }

    // Charger methods
    async updateChargerStatus(chargePointId, status) {
        const lastSeen = Math.floor(Date.now() / 1000);
        // Use raw query for upsert to preserve other columns like max_power
        // Knex .merge() might overwrite with default/null if not careful depending on dialect interaction
        // But here we want to update ONLY status and last_seen if exists, or insert if not.
        // For simplicity with Knex upsert:
        const existing = await this.db('chargers').where('charge_point_id', chargePointId).first();
        if (existing) {
            await this.db('chargers')
                .where('charge_point_id', chargePointId)
                .update({ status, last_seen: lastSeen });
        } else {
            await this.db('chargers').insert({
                charge_point_id: chargePointId,
                status,
                last_seen: lastSeen
            });
        }
    }

    async updateChargerConnection(chargePointId, status, connectionInfo = {}) {
        const lastSeen = Math.floor(Date.now() / 1000);
        const updateData = { status, last_seen: lastSeen };

        // Include connection metadata if provided
        if (connectionInfo.remoteAddress) {
            updateData.remote_ip = connectionInfo.remoteAddress;
            updateData.remote_port = connectionInfo.remotePort;
            updateData.connected_at = connectionInfo.connectedAt;
        }

        const existing = await this.db('chargers').where('charge_point_id', chargePointId).first();
        if (existing) {
            await this.db('chargers')
                .where('charge_point_id', chargePointId)
                .update(updateData);
        } else {
            await this.db('chargers').insert({
                charge_point_id: chargePointId,
                ...updateData
            });
        }
    }

    async updateChargerLimit(chargePointId, maxPower) {
        // maxPower can be null
        const existing = await this.db('chargers').where('charge_point_id', chargePointId).first();
        if (existing) {
            await this.db('chargers')
                .where('charge_point_id', chargePointId)
                .update({ max_power: maxPower });
        } else {
            // Should not happen for unknown charger, but handle it
            await this.db('chargers').insert({
                charge_point_id: chargePointId,
                status: 'OFFLINE',
                last_seen: Math.floor(Date.now() / 1000),
                max_power: maxPower
            });
        }
    }

    async getCharger(chargePointId) {
        return await this.db('chargers').where('charge_point_id', chargePointId).first();
    }

    async getAllChargers() {
        return await this.db('chargers').select('*');
    }

    // Auth methods
    async getUser(username) {
        return await this.db('auth_users').where('username', username).first();
    }

    async updatePassword(username, passwordHash) {
        const count = await this.db('auth_users')
            .where('username', username)
            .update({ password_hash: passwordHash });
        return count > 0;
    }

    // Explicitly add a user (helper for init/scripts)
    async addUser(username, passwordHash) {
        const now = Math.floor(Date.now() / 1000);
        await this.db('auth_users')
            .insert({ username, password_hash: passwordHash, created_at: now })
            .onConflict('username')
            .merge();
    }

    async countUsers() {
        const result = await this.db('auth_users').count('username as count').first();
        // Knex response for count varies by dialect. 
        // Postgres returns string for count, SQLite returns number.
        // Safer to cast or parse.
        return parseInt(result.count || 0);
    }

    // Cleanup method
    async cleanupOldLogs(retentionCount = 1000) {
        const chargers = await this.getAllChargers();
        let totalDeleted = 0;

        for (const charger of chargers) {
            // Find the Nth newest log timestamp to use as cutoff
            // This is slightly complex in pure SQL across dialects without window functions in older versions
            // but subqueries are standard.

            // Delete logs where id NOT IN (top N ids by timestamp) for this charger
            // This matches the original logic
            const subquery = this.db('logs')
                .select('id')
                .where('charge_point_id', charger.charge_point_id)
                .orderBy('timestamp', 'desc')
                .limit(retentionCount);

            const count = await this.db('logs')
                .where('charge_point_id', charger.charge_point_id)
                .whereNotIn('id', subquery)
                .del();

            totalDeleted += count;
        }

        return totalDeleted;
    }

    // Migration helper
    async runMigrations() {
        const useMemoryDb = process.env.USE_MEMORY_DB === 'true';

        if (useMemoryDb) {
            // For in-memory database, run schema directly instead of using migration files
            // This avoids file system writes for lock files in Cloud Run
            logger('INFO', 'Initializing in-memory database schema...');
            const pathModule = require('path');
            const fs = require('fs');

            // Get all migration files in order
            const migrationsDir = pathModule.join(__dirname, 'migrations');
            const migrationFiles = fs.readdirSync(migrationsDir)
                .filter(f => f.endsWith('.js'))
                .sort();

            // Run each migration in order
            for (const file of migrationFiles) {
                logger('INFO', `Running migration: ${file}`);
                const migration = require(pathModule.join(migrationsDir, file));
                await migration.up(this.db);
            }

            logger('INFO', 'In-memory database schema initialized');
        } else {
            // For file-based databases, use normal knex migrations
            logger('INFO', 'Running database migrations...');
            await this.db.migrate.latest();
            logger('INFO', 'Database migrations completed');
        }
    }

    async close() {
        await this.db.destroy();
    }
}

module.exports = DatabaseAdapter;
