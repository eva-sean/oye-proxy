// Simple file-based logger (replaces Google Cloud Logging)
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'oye-proxy.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 5;

// Create log directory if it doesn't exist
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function rotateLogFile() {
    if (!fs.existsSync(LOG_FILE)) return;

    const stats = fs.statSync(LOG_FILE);
    if (stats.size < MAX_LOG_SIZE) return;

    // Rotate existing backup files
    for (let i = MAX_LOG_FILES - 1; i > 0; i--) {
        const oldFile = `${LOG_FILE}.${i}`;
        const newFile = `${LOG_FILE}.${i + 1}`;

        if (fs.existsSync(oldFile)) {
            if (i === MAX_LOG_FILES - 1) {
                fs.unlinkSync(oldFile); // Delete oldest
            } else {
                fs.renameSync(oldFile, newFile);
            }
        }
    }

    // Move current log to .1
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
}

function logger(severity, message, metadata = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : '';

    // Console output (always enabled)
    console.log(`[${timestamp}] [${severity}] ${message}${metaStr ? ' ' + metaStr : ''}`);

    // File output
    try {
        rotateLogFile();

        const logLine = JSON.stringify({
            timestamp,
            severity,
            message,
            ...metadata
        }) + '\n';

        fs.appendFileSync(LOG_FILE, logLine);
    } catch (err) {
        console.error('Failed to write to log file:', err);
    }
}

module.exports = logger;
