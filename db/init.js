// Database initialization and migration
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'oye-proxy.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function initDatabase() {
    console.log(`Initializing database at: ${DB_PATH}`);

    // Create db directory if it doesn't exist
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    const db = new Database(DB_PATH);

    // Enable WAL mode for better concurrency
    db.pragma('journal_mode = WAL');

    // Read and execute schema
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(schema);

    console.log('Database initialized successfully');

    return db;
}

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function addUser(db, username, password) {
    const stmt = db.prepare('INSERT OR REPLACE INTO auth_users (username, password_hash) VALUES (?, ?)');
    stmt.run(username, hashPassword(password));
    console.log(`User '${username}' added/updated`);
}

// CLI usage: node init.js [username] [password]
if (require.main === module) {
    const db = initDatabase();

    // Add user from command line args if provided
    const [username, password] = process.argv.slice(2);
    if (username && password) {
        addUser(db, username, password);
    }

    db.close();
}

module.exports = { initDatabase, hashPassword, addUser };
