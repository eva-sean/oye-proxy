// Basic authentication middleware
const crypto = require('crypto');

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function createAuthMiddleware(db) {
    return async (req, res, next) => {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Basic ')) {
            res.setHeader('WWW-Authenticate', 'Basic realm="OCPP Proxy"');
            return res.status(401).json({ error: 'Authentication required' });
        }

        try {
            const base64Credentials = authHeader.split(' ')[1];
            const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
            const [username, password] = credentials.split(':');

            const user = await db.getUser(username);

            if (!user || user.password_hash !== hashPassword(password)) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            // Authentication successful
            req.user = { username };
            next();
        } catch (err) {
            return res.status(401).json({ error: 'Authentication failed' });
        }
    };
}

module.exports = { createAuthMiddleware, hashPassword };
