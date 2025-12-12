// Database initialization and migration
const DatabaseAdapter = require('./adapter');
const crypto = require('crypto');

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function generateRandomPassword(length = 16) {
    return crypto.randomBytes(length).toString('base64').slice(0, length);
}

async function init() {
    console.log('Initializing database...');
    const db = new DatabaseAdapter();

    try {
        // Run migrations
        await db.runMigrations();

        // Check for existing users
        const count = await db.countUsers();

        if (count === 0) {
            console.log('No users found. Creating default admin user.');

            let password;
            let source;

            if (process.env.INITIAL_ADMIN_PASSWORD) {
                password = process.env.INITIAL_ADMIN_PASSWORD;
                source = 'ENVIRONMENT VARIABLE';
                console.log('Using password from INITIAL_ADMIN_PASSWORD environment variable.');
            } else {
                password = generateRandomPassword();
                source = 'GENERATED';
            }

            const passwordHash = hashPassword(password);
            await db.addUser('admin', passwordHash);

            console.log('='.repeat(60));
            console.log('DEFAULT ADMIN USER CREATED');
            console.log('='.repeat(60));
            console.log(`Username: admin`);
            if (source === 'GENERATED') {
                console.log(`Password: ${password}`);
            } else {
                console.log(`Password: (hidden - set via INITIAL_ADMIN_PASSWORD)`);
            }
            console.log('='.repeat(60));

            if (source === 'GENERATED') {
                console.log('IMPORTANT: Change this password immediately via the web UI or API!');
                console.log('='.repeat(60));
            }
        } else {
            console.log(`Database already initialized with ${count} users.`);
        }

    } catch (err) {
        console.error('Initialization failed:', err);
        process.exit(1);
    } finally {
        await db.close();
    }
}

// CLI usage: node init.js [username] [password]
if (require.main === module) {
    const args = process.argv.slice(2);

    if (args.length >= 2) {
        // Manual add user mode
        const [username, password] = args;
        const db = new DatabaseAdapter();
        (async () => {
            try {
                // Ensure migrations are run first just in case
                await db.runMigrations();

                await db.addUser(username, hashPassword(password));
                console.log(`User '${username}' added/updated`);
            } catch (err) {
                console.error('Failed to add user:', err);
                process.exit(1);
            } finally {
                await db.close();
            }
        })();
    } else {
        // Default init mode
        init();
    }
}

module.exports = { hashPassword }; // Export helper if needed elsewhere
