#!/usr/bin/env node
// Log cleanup script - runs daily via cron and on startup
const path = require('path');
const DatabaseAdapter = require('../db/adapter');
const logger = require('../logger');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../db/oye-proxy.db');
const RETENTION_COUNT = parseInt(process.env.LOG_RETENTION_COUNT || '1000', 10);

async function cleanup() {
    logger('INFO', 'Starting log cleanup...', { retentionCount: RETENTION_COUNT });

    const db = new DatabaseAdapter(DB_PATH);

    try {
        const deletedCount = await db.cleanupOldLogs(RETENTION_COUNT);
        logger('INFO', 'Log cleanup completed', { deletedLogs: deletedCount });
    } catch (err) {
        logger('ERROR', 'Log cleanup failed', { error: err.message });
        process.exit(1);
    } finally {
        db.close();
    }
}

// Run cleanup
cleanup().catch(err => {
    console.error('Cleanup script failed:', err);
    process.exit(1);
});
