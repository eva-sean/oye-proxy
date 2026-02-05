require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const path = require('path');
const DatabaseAdapter = require('./db/adapter');
const logger = require('./logger');
const { createAuthMiddleware, hashPassword } = require('./auth');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db/oye-proxy.db');
const PORT = process.env.PORT || 8080;
const DEBUG = process.env.DEBUG === 'true';

// CSMS reconnection configuration
const CSMS_RECONNECT_MAX_ATTEMPTS = parseInt(process.env.CSMS_RECONNECT_MAX_ATTEMPTS) || 3;
const CSMS_RECONNECT_BASE_DELAY = parseInt(process.env.CSMS_RECONNECT_BASE_DELAY) || 1000; // ms

// Initialize database
const db = new DatabaseAdapter();

const app = express();
app.use(express.json());

// Runtime config (loaded from database)
let TARGET_CSMS_URL = 'ws://localhost/ocpp';
let CSMS_FORWARDING_ENABLED = false;
let AUTO_CHARGE_ENABLED = false;
let DEFAULT_ID_TAG = 'ADMIN_TAG';

// Load configuration from database
async function loadConfig() {
    try {
        logger('INFO', 'Loading config from database...');
        const config = await db.getAllConfig();

        TARGET_CSMS_URL = config.targetCsmsUrl || 'ws://localhost/ocpp';
        CSMS_FORWARDING_ENABLED = config.csmsForwardingEnabled === 'true';
        AUTO_CHARGE_ENABLED = config.autoChargeEnabled === 'true';
        DEFAULT_ID_TAG = config.defaultIdTag || 'ADMIN_TAG';

        logger('INFO', 'Config loaded from database', {
            targetCsmsUrl: TARGET_CSMS_URL,
            csmsForwardingEnabled: CSMS_FORWARDING_ENABLED,
            autoChargeEnabled: AUTO_CHARGE_ENABLED,
            defaultIdTag: DEFAULT_ID_TAG
        });
    } catch (err) {
        logger('ERROR', 'Failed to load config from database, using defaults', {
            error: err.message
        });
    }
}

// STATE: Store active connections AND tracked IDs
const clients = new Map();

// Transaction ID counter for offline transactions
let transactionIdCounter = 100000;

// -----------------------------------------------------------------------------
// REST API
// -----------------------------------------------------------------------------

// Serve static files (dashboard) - must be first to serve index.html at /
app.use(express.static('public'));

// Health check (no auth required)
app.get('/health', (req, res) => {
    if (DEBUG) { logger('DEBUG', 'Health check', { url: req.url }) };
    res.send(`OCPP Proxy Active. Connected Chargers: ${clients.size}`);
});

// Auth middleware for protected routes
const requireAuth = createAuthMiddleware(db);

// Get logs (for dashboard polling)
app.get('/api/logs', requireAuth, async (req, res) => {
    try {
        const { chargePointId, limit, since } = req.query;
        const logs = await db.getLogs({
            chargePointId,
            limit: parseInt(limit) || 100,
            since: parseInt(since)
        });

        // Parse payload JSON strings back to objects
        const parsedLogs = logs.map(log => ({
            ...log,
            payload: typeof log.payload === 'string' ? JSON.parse(log.payload) : log.payload
        }));

        res.json(parsedLogs);
    } catch (err) {
        logger('ERROR', 'Failed to fetch logs', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// Get chargers status
app.get('/api/chargers', requireAuth, async (req, res) => {
    try {
        const chargers = await db.getAllChargers();

        // Update status based on live connection state
        const enrichedChargers = chargers.map(charger => {
            const connection = clients.get(charger.charge_point_id);
            const isOnline = connection &&
                connection.chargerSocket &&
                connection.chargerSocket.readyState === WebSocket.OPEN;

            return {
                ...charger,
                status: isOnline ? 'ONLINE' : 'OFFLINE'
            };
        });

        res.json(enrichedChargers);
    } catch (err) {
        logger('ERROR', 'Failed to fetch chargers', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// Get config
app.get('/api/config', requireAuth, async (req, res) => {
    try {
        const config = await db.getAllConfig();
        res.json(config);
    } catch (err) {
        logger('ERROR', 'Failed to fetch config', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// Update config
app.post('/api/config', requireAuth, async (req, res) => {
    try {
        const { targetCsmsUrl, csmsForwardingEnabled, autoChargeEnabled, defaultIdTag } = req.body;

        if (targetCsmsUrl !== undefined) {
            await db.setConfigValue('targetCsmsUrl', targetCsmsUrl);
            TARGET_CSMS_URL = targetCsmsUrl;
        }

        if (csmsForwardingEnabled !== undefined) {
            await db.setConfigValue('csmsForwardingEnabled', csmsForwardingEnabled.toString());
            CSMS_FORWARDING_ENABLED = csmsForwardingEnabled;
        }

        if (autoChargeEnabled !== undefined) {
            await db.setConfigValue('autoChargeEnabled', autoChargeEnabled.toString());
            AUTO_CHARGE_ENABLED = autoChargeEnabled;
        }

        if (defaultIdTag !== undefined) {
            await db.setConfigValue('defaultIdTag', defaultIdTag);
            DEFAULT_ID_TAG = defaultIdTag;
        }

        logger('INFO', 'Config updated', { targetCsmsUrl, csmsForwardingEnabled, autoChargeEnabled, defaultIdTag });
        res.json({ success: true });
    } catch (err) {
        logger('ERROR', 'Failed to update config', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// Smart Charging Endpoint
app.post('/api/chargers/:cpId/smart-charging', requireAuth, async (req, res) => {
    if (DEBUG) { logger('DEBUG', 'POST /smart-charging', { url: req.url, body: req.body }) };
    const { cpId } = req.params;
    const { maxPower, sessionLimit, action, transactionId } = req.body; // action can be 'clear'

    const connection = clients.get(cpId);
    if (!connection || !connection.chargerSocket || connection.chargerSocket.readyState !== WebSocket.OPEN) {
        return res.status(503).json({ error: 'Charger not connected' });
    }

    try {
        let messageId;
        let ocppMessage;

        if (action === 'clear') {
            // Clear persistent limit in DB
            await db.updateChargerLimit(cpId, null);

            // Inject ClearChargingProfile
            messageId = crypto.randomUUID().substring(0, 36);
            ocppMessage = [2, messageId, 'ClearChargingProfile', {}]; // Clears all
            logger('INFO', 'Clearing charging profiles', { chargePointId: cpId });

        } else if (maxPower !== undefined) {
            // Update persistent limit in DB
            const limit = parseFloat(maxPower);
            await db.updateChargerLimit(cpId, limit);

            // Inject SetChargingProfile (ChargePointMaxProfile)
            messageId = crypto.randomUUID().substring(0, 36);
            const profile = {
                connectorId: 0,
                csChargingProfiles: {
                    chargingProfileId: 1,
                    stackLevel: 1,
                    chargingProfilePurpose: 'ChargePointMaxProfile',
                    chargingProfileKind: 'Absolute',
                    chargingSchedule: {
                        chargingRateUnit: 'A',
                        chargingSchedulePeriod: [{ startPeriod: 0, limit: limit }]
                    }
                }
            };
            ocppMessage = [2, messageId, 'SetChargingProfile', profile];
            logger('INFO', 'Setting permanent power limit', { chargePointId: cpId, limit });

        } else if (sessionLimit !== undefined) {
            // Do NOT update DB (session only)
            const limit = parseFloat(sessionLimit);
            const { transactionId } = req.body; // Optional transactionId

            messageId = crypto.randomUUID().substring(0, 36);

            let profile;

            if (transactionId) {
                // TxProfile for a specific transaction
                profile = {
                    connectorId: 0,
                    csChargingProfiles: {
                        chargingProfileId: 2,
                        stackLevel: 1,
                        chargingProfilePurpose: 'TxProfile',
                        chargingProfileKind: 'Absolute',
                        transactionId: transactionId,
                        chargingSchedule: {
                            chargingRateUnit: 'A',
                            chargingSchedulePeriod: [{ startPeriod: 0, limit: limit }]
                        }
                    }
                };
                logger('INFO', 'Setting session limit for transaction', { chargePointId: cpId, limit, transactionId });
            } else {
                // TxDefaultProfile for future transactions
                profile = {
                    connectorId: 0,
                    csChargingProfiles: {
                        chargingProfileId: 2,
                        stackLevel: 1,
                        chargingProfilePurpose: 'TxDefaultProfile',
                        chargingProfileKind: 'Absolute',
                        chargingSchedule: {
                            chargingRateUnit: 'A',
                            chargingSchedulePeriod: [{ startPeriod: 0, limit: limit }]
                        }
                    }
                };
                logger('INFO', 'Setting default Tx limit', { chargePointId: cpId, limit });
            }

            ocppMessage = [2, messageId, 'SetChargingProfile', profile];

        } else {
            return res.status(400).json({ error: 'Invalid parameters. Provide maxPower, sessionLimit, or action=clear' });
        }

        // Send the message
        const payloadStr = JSON.stringify(ocppMessage);

        // Track injection for response handling
        connection.pendingIds.add(messageId);
        setTimeout(() => {
            if (connection.pendingIds.has(messageId)) connection.pendingIds.delete(messageId);
        }, 60000);

        connection.chargerSocket.send(payloadStr);
        await logMessage(cpId, 'INJECTION_REQUEST', ocppMessage);

        return res.json({ status: 'sent', messageId: messageId });

    } catch (e) {
        logger('ERROR', 'Smart Charging update failed', { chargePointId: cpId, error: e.message });
        return res.status(500).json({ error: e.message });
    }
});

// Command injection
app.post('/api/inject/:cpId', requireAuth, async (req, res) => {
    if (DEBUG) { logger('DEBUG', 'POST request', { url: req.url }) };
    const { cpId } = req.params;
    const { action, payload } = req.body;

    const connection = clients.get(cpId);

    if (!connection || !connection.chargerSocket || connection.chargerSocket.readyState !== WebSocket.OPEN) {
        return res.status(503).json({ error: 'Charger not connected' });
    }

    try {
        const messageId = crypto.randomUUID().substring(0, 36);
        const ocppMessage = [2, messageId, action, payload];
        const payloadStr = JSON.stringify(ocppMessage);

        connection.pendingIds.add(messageId);

        // Track idTag for RemoteStartTransaction to auto-approve subsequent Authorize
        if (action === 'RemoteStartTransaction' && payload.idTag) {
            connection.pendingIdTags.add(payload.idTag);
            logger('INFO', 'Tracking idTag for auto-authorization', { chargePointId: cpId, idTag: payload.idTag });

            // Clean up pending idTag after 60 seconds
            setTimeout(() => {
                if (connection.pendingIdTags.has(payload.idTag)) {
                    connection.pendingIdTags.delete(payload.idTag);
                    if (DEBUG) logger('DEBUG', `Cleaned up stale pending idTag`, { chargePointId: cpId, idTag: payload.idTag });
                }
            }, 60000);
        }

        setTimeout(() => {
            if (connection.pendingIds.has(messageId)) {
                connection.pendingIds.delete(messageId);
                if (DEBUG) logger('DEBUG', `Cleaned up stale injection ID`, { chargePointId: cpId, messageId });
            }
        }, 60000);

        connection.chargerSocket.send(payloadStr);

        await logMessage(cpId, 'INJECTION_REQUEST', ocppMessage);
        logger('INFO', 'Command injected', { chargePointId: cpId, action, messageId });

        return res.json({ status: 'sent', messageId: messageId });
    } catch (e) {
        logger('ERROR', 'Injection failed', { chargePointId: cpId, error: e.message });
        return res.status(500).json({ error: e.message });
    }
});

// Change password endpoint
app.post('/api/change-password', requireAuth, async (req, res) => {
    if (DEBUG) { logger('DEBUG', 'POST request', { url: req.url }) };
    const { currentPassword, newPassword } = req.body;
    const username = req.user.username;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Current password and new password are required' });
    }

    if (newPassword.length < 8) {
        return res.status(400).json({ error: 'New password must be at least 8 characters long' });
    }

    try {
        // Verify current password
        const user = await db.getUser(username);
        if (!user || user.password_hash !== hashPassword(currentPassword)) {
            return res.status(400).json({ error: 'Current password is incorrect' });
        }

        // Update password
        const newPasswordHash = hashPassword(newPassword);
        const success = await db.updatePassword(username, newPasswordHash);

        if (success) {
            logger('INFO', 'Password changed successfully', { username });
            return res.json({ status: 'success', message: 'Password changed successfully' });
        } else {
            return res.status(500).json({ error: 'Failed to update password' });
        }
    } catch (e) {
        logger('ERROR', 'Password change failed', { username, error: e.message });
        return res.status(500).json({ error: e.message });
    }
});

// -----------------------------------------------------------------------------
// WebSocket Handling
// -----------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    if (DEBUG) { logger('DEBUG', 'Upgrade request', { url: request.url }) };
    const urlParts = request.url.split('/');
    if (urlParts.length < 3 || urlParts[1] !== 'ocpp') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
    }
    const chargePointId = urlParts[2];
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, chargePointId);
    });
});


wss.on('connection', async (chargerSocket, req, chargePointId) => {
    logger('INFO', 'Charger connected', { chargePointId });

    // Register charger in database
    try {
        await db.updateChargerStatus(chargePointId, 'ONLINE');
    } catch (err) {
        logger('ERROR', 'Failed to register charger', { chargePointId, error: err.message });
    }

    const headers = {};
    if (req.headers['authorization']) headers['authorization'] = req.headers['authorization'];

    clients.set(chargePointId, {
        chargerSocket,
        csmsSocket: null,
        pendingIds: new Set(),
        pendingIdTags: new Set(), // Track idTags from injected RemoteStartTransaction
        messageBuffer: [], // Buffer messages while CSMS is connecting
        reconnectAttempt: 0,
        reconnecting: false,
        reconnectTimer: null
    });

    // --- Smart Charging Persistent Logic ---
    // Enforce max_power limit if set in DB.
    // This runs immediately on charger connection, regardless of CSMS status.
    (async () => {
        try {
            const chargerData = await db.getCharger(chargePointId);
            if (chargerData && chargerData.max_power !== null && chargerData.max_power !== undefined) {
                const limit = parseFloat(chargerData.max_power);
                if (!isNaN(limit)) {
                    logger('INFO', `Enforcing persistent power limit`, { chargePointId, limit });
                    const messageId = crypto.randomUUID().substring(0, 36);
                    const profile = {
                        connectorId: 0,
                        csChargingProfiles: {
                            chargingProfileId: 1,
                            stackLevel: 1,
                            chargingProfilePurpose: 'ChargePointMaxProfile',
                            chargingProfileKind: 'Absolute',
                            chargingSchedule: {
                                chargingRateUnit: 'A',
                                chargingSchedulePeriod: [{ startPeriod: 0, limit: limit }]
                            }
                        }
                    };
                    const payload = [2, messageId, 'SetChargingProfile', profile];

                    // Small delay to ensure connection is fully ready and to separate from potential BootNotification response
                    setTimeout(async () => {
                        if (chargerSocket.readyState === WebSocket.OPEN) {
                            chargerSocket.send(JSON.stringify(payload));
                            await logMessage(chargePointId, 'INJECTION_REQUEST', payload);
                        }
                    }, 500);
                }
            }
        } catch (err) {
            logger('WARNING', 'Failed to enforce smart charging limit on connect', { chargePointId, error: err.message });
        }
    })();

    let csmsSocket = null;

    // Function to connect to CSMS with retry logic
    const connectToCsms = (isReconnect = false) => {
        if (!CSMS_FORWARDING_ENABLED) return Promise.resolve(null);

        const connection = clients.get(chargePointId);
        if (!connection) return Promise.resolve(null);

        const attempt = isReconnect ? connection.reconnectAttempt + 1 : 1;
        connection.reconnectAttempt = attempt;
        connection.reconnecting = true;

        const csmsTarget = TARGET_CSMS_URL.endsWith('/')
            ? `${TARGET_CSMS_URL}${chargePointId}`
            : `${TARGET_CSMS_URL}/${chargePointId}`;

        logger(isReconnect ? 'INFO' : 'INFO', `CSMS connection attempt ${attempt}/${CSMS_RECONNECT_MAX_ATTEMPTS}`, {
            chargePointId,
            target: csmsTarget,
            protocol: req.headers['sec-websocket-protocol'] || 'none',
            hasAuth: !!req.headers['authorization']
        });

        return new Promise((resolve, reject) => {
            try {
                // Extract protocol - ws library expects string or array
                const protocol = req.headers['sec-websocket-protocol'];
                const wsOptions = {
                    headers: headers,
                    rejectUnauthorized: false
                };

                csmsSocket = protocol
                    ? new WebSocket(csmsTarget, protocol, wsOptions)
                    : new WebSocket(csmsTarget, wsOptions);

                if (connection) {
                    connection.csmsSocket = csmsSocket;
                }

                // Override the standard handlers to add reconnection logic
                csmsSocket.on('open', () => {
                    connection.reconnectAttempt = 0;
                    connection.reconnecting = false;
                    logger('INFO', 'CSMS connected successfully', { chargePointId, attempt });

                    if (connection.messageBuffer.length > 0) {
                        logger('INFO', 'Flushing message buffer to CSMS', {
                            chargePointId,
                            bufferedMessages: connection.messageBuffer.length
                        });

                        connection.messageBuffer.forEach(msg => {
                            if (csmsSocket.readyState === WebSocket.OPEN) {
                                csmsSocket.send(msg);
                                if (DEBUG) logger('DEBUG', 'PROXY → CSMS (buffered)', { chargePointId, message: msg });
                            }
                        });

                        connection.messageBuffer = [];
                    }

                    if (DEBUG) {
                        logger('DEBUG', 'CSMS connection established', {
                            chargePointId,
                            chargerState: chargerSocket.readyState,
                            chargerStateLabel: ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][chargerSocket.readyState],
                            negotiatedProtocol: csmsSocket.protocol,
                            csmsUrl: csmsSocket.url
                        });
                    }

                    resolve(csmsSocket);
                });

                csmsSocket.on('error', (err) => {
                    logger('ERROR', 'CSMS socket error', {
                        chargePointId,
                        error: err.message,
                        code: err.code,
                        errno: err.errno,
                        syscall: err.syscall,
                        stack: DEBUG ? err.stack : undefined,
                        attempt
                    });

                    // Only reject if this is during initial connection attempt
                    if (csmsSocket.readyState === WebSocket.CONNECTING) {
                        reject(err);
                    }
                });

                csmsSocket.on('close', (code, reason) => {
                    const logLevel = (code === 1000 && !DEBUG) ? 'DEBUG' : 'INFO';
                    logger(logLevel, 'CSMS disconnected', { chargePointId, code, reason: reason || 'None' });

                    const conn = clients.get(chargePointId);
                    if (conn && conn.csmsSocket === csmsSocket) {
                        conn.csmsSocket = null;

                        // Attempt to reconnect if charger is still connected
                        if (chargerSocket.readyState === WebSocket.OPEN && CSMS_FORWARDING_ENABLED) {
                            scheduleReconnect();
                        }
                    }
                });

                csmsSocket.on('message', async (message) => {
                    const msgStr = message.toString();
                    if (DEBUG) logger('DEBUG', 'CSMS → PROXY', { chargePointId, message: msgStr });

                    let parsed = null;
                    try {
                        parsed = JSON.parse(msgStr);
                        if (Array.isArray(parsed) && parsed[0] === 4) {
                            logger('ERROR', 'CSMS error response', { chargePointId, response: parsed });
                        }
                    } catch (e) {
                        // Not JSON, just forward
                    }

                    // Log downstream message to database
                    await logMessage(chargePointId, 'DOWNSTREAM', parsed || msgStr);

                    if (chargerSocket.readyState === WebSocket.OPEN) {
                        if (DEBUG) logger('DEBUG', 'PROXY → CHARGER', { chargePointId, message: msgStr });
                        chargerSocket.send(msgStr);
                    } else {
                        logger('WARNING', 'Charger disconnected, cannot forward CSMS message', { chargePointId });
                    }
                });

                // --- NEW: Smart Charging Logic on Connection ---
                // (Moved to main connection handler to support standalone mode)

            } catch (err) {
                logger('ERROR', 'Failed to create CSMS connection', {
                    chargePointId,
                    error: err.message,
                    stack: DEBUG ? err.stack : undefined,
                    attempt
                });
                reject(err);
            }
        });
    };

    // Schedule reconnection with exponential backoff
    const scheduleReconnect = () => {
        const connection = clients.get(chargePointId);
        if (!connection) return;

        if (connection.reconnectAttempt >= CSMS_RECONNECT_MAX_ATTEMPTS) {
            logger('WARNING', `CSMS reconnection failed after ${CSMS_RECONNECT_MAX_ATTEMPTS} attempts, giving up`, {
                chargePointId
            });
            connection.reconnecting = false;
            return;
        }

        const delay = CSMS_RECONNECT_BASE_DELAY * Math.pow(2, connection.reconnectAttempt);
        logger('INFO', `Scheduling CSMS reconnection`, {
            chargePointId,
            nextAttempt: connection.reconnectAttempt + 1,
            delayMs: delay
        });

        connection.reconnectTimer = setTimeout(() => {
            const conn = clients.get(chargePointId);
            if (conn && chargerSocket.readyState === WebSocket.OPEN) {
                connectToCsms(true).catch(err => {
                    logger('ERROR', 'CSMS reconnection failed', {
                        chargePointId,
                        error: err.message,
                        attempt: conn.reconnectAttempt
                    });
                    // scheduleReconnect will be called again on close event
                });
            }
        }, delay);
    };

    // Call connect function
    if (CSMS_FORWARDING_ENABLED) {
        connectToCsms(false).catch(err => {
            logger('ERROR', 'Initial CSMS connection failed', {
                chargePointId,
                error: err.message
            });
            // Reconnection will be handled by close event
        });
    } else {
        logger('INFO', 'CSMS forwarding disabled, running in standalone mode', { chargePointId });
    }

    // Track if this is the first message from charger
    let firstMessageReceived = false;

    // --- FROM CHARGER (Upstream) ---
    chargerSocket.on('message', async (message) => {
        const msgStr = message.toString();

        if (!firstMessageReceived) {
            firstMessageReceived = true;
            try {
                const parsed = JSON.parse(msgStr);
                const action = Array.isArray(parsed) && parsed[0] === 2 ? parsed[2] : 'unknown';
                logger('INFO', 'First message from charger', {
                    chargePointId,
                    action,
                    csmsState: csmsSocket ? csmsSocket.readyState : 'null',
                    csmsStateLabel: csmsSocket ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][csmsSocket.readyState] : 'null'
                });
            } catch (e) {
                logger('WARNING', 'First message not valid JSON', { chargePointId, message: msgStr });
            }
        }

        if (DEBUG) logger('DEBUG', 'CHARGER → PROXY', { chargePointId, message: msgStr });

        let shouldForward = true;
        let parsedMsg = null;

        try {
            parsedMsg = JSON.parse(msgStr);

            if (Array.isArray(parsedMsg) && (parsedMsg[0] === 3 || parsedMsg[0] === 4)) {
                const msgId = parsedMsg[1];
                const clientData = clients.get(chargePointId);

                if (clientData && clientData.pendingIds.has(msgId)) {
                    logger('INFO', 'Intercepted injection response', { chargePointId, messageId: msgId });

                    logMessage(chargePointId, 'INJECTION_RESPONSE', parsedMsg);

                    clientData.pendingIds.delete(msgId);

                    shouldForward = false;
                }
            }

            if (Array.isArray(parsedMsg) && parsedMsg[0] === 2) {
                const messageId = parsedMsg[1];
                const action = parsedMsg[2];

                const connection = clients.get(chargePointId);
                const csmsUnavailable = !csmsSocket ||
                    csmsSocket.readyState === WebSocket.CLOSING ||
                    csmsSocket.readyState === WebSocket.CLOSED;

                // If CSMS is unavailable and we're still within retry attempts, buffer the message
                if (csmsUnavailable && connection && connection.reconnecting &&
                    connection.reconnectAttempt < CSMS_RECONNECT_MAX_ATTEMPTS) {
                    logger('INFO', 'Buffering message while attempting CSMS reconnection', {
                        chargePointId,
                        action,
                        reconnectAttempt: connection.reconnectAttempt,
                        bufferSize: connection.messageBuffer.length + 1
                    });
                    connection.messageBuffer.push(msgStr);
                    shouldForward = false;
                } else if (csmsUnavailable) {
                    // CSMS is unavailable and we've exhausted retries, respond with proxy
                    let proxyResponse = null;

                    switch (action) {
                        case 'BootNotification':
                            logger('INFO', 'Responding to BootNotification (CSMS unavailable)', {
                                chargePointId,
                                csmsState: csmsSocket?.readyState
                            });
                            proxyResponse = [3, messageId, {
                                status: 'Accepted',
                                currentTime: new Date().toISOString(),
                                interval: 300
                            }];
                            break;

                        case 'Heartbeat':
                            if (DEBUG) logger('DEBUG', 'Responding to Heartbeat (CSMS unavailable)', { chargePointId });
                            proxyResponse = [3, messageId, {
                                currentTime: new Date().toISOString()
                            }];
                            break;

                        case 'Authorize':
                            const requestedIdTag = parsedMsg[3]?.idTag;
                            const clientData = clients.get(chargePointId);
                            const isPendingIdTag = clientData && clientData.pendingIdTags.has(requestedIdTag);

                            if (AUTO_CHARGE_ENABLED || isPendingIdTag) {
                                const reason = isPendingIdTag ? 'pending injected RemoteStartTransaction' : 'auto charge enabled';
                                logger('INFO', `Auto-accepting Authorize (${reason}, CSMS unavailable)`, { chargePointId, idTag: requestedIdTag });
                                proxyResponse = [3, messageId, {
                                    idTagInfo: {
                                        status: 'Accepted'
                                    }
                                }];

                                // Remove idTag from pending set since it's now been authorized
                                if (isPendingIdTag) {
                                    clientData.pendingIdTags.delete(requestedIdTag);
                                    logger('INFO', 'Removed idTag from pending set after authorization', { chargePointId, idTag: requestedIdTag });
                                }
                            } else {
                                logger('INFO', 'Rejecting Authorize (auto charge disabled, CSMS unavailable)', { chargePointId, idTag: requestedIdTag });
                                proxyResponse = [3, messageId, {
                                    idTagInfo: {
                                        status: 'Invalid'
                                    }
                                }];
                            }
                            break;

                        case 'StatusNotification':
                            if (DEBUG) logger('DEBUG', 'Acknowledging StatusNotification (CSMS unavailable)', { chargePointId });
                            proxyResponse = [3, messageId, {}];

                            // Auto-start charging if status is "Preparing" and auto charge is enabled
                            if (AUTO_CHARGE_ENABLED && parsedMsg[3]?.status === 'Preparing') {
                                const connectorId = parsedMsg[3]?.connectorId || 1;
                                logger('INFO', 'Auto-starting charge session (status: Preparing, auto charge enabled)', {
                                    chargePointId,
                                    connectorId
                                });

                                // Send RemoteStartTransaction after a brief delay to let StatusNotification complete
                                setTimeout(() => {
                                    const startMessageId = crypto.randomUUID().substring(0, 36);
                                    const startPayload = {
                                        connectorId: connectorId,
                                        idTag: DEFAULT_ID_TAG
                                    };
                                    const startMessage = [2, startMessageId, 'RemoteStartTransaction', startPayload];

                                    const connection = clients.get(chargePointId);
                                    if (connection && connection.chargerSocket && connection.chargerSocket.readyState === WebSocket.OPEN) {
                                        connection.pendingIds.add(startMessageId);

                                        setTimeout(() => {
                                            if (connection.pendingIds.has(startMessageId)) {
                                                connection.pendingIds.delete(startMessageId);
                                                if (DEBUG) logger('DEBUG', `Cleaned up stale auto-start ID`, { chargePointId, messageId: startMessageId });
                                            }
                                        }, 60000);

                                        connection.chargerSocket.send(JSON.stringify(startMessage));
                                        logMessage(chargePointId, 'INJECTION_REQUEST', startMessage);
                                        logger('INFO', 'Auto-start command sent', { chargePointId, connectorId, idTag: DEFAULT_ID_TAG });
                                    }
                                }, 100);
                            }
                            break;

                        case 'MeterValues':
                            if (DEBUG) logger('DEBUG', 'Acknowledging MeterValues (CSMS unavailable)', { chargePointId });
                            proxyResponse = [3, messageId, {}];
                            break;

                        case 'StartTransaction':
                            logger('INFO', 'Responding to StartTransaction with generated ID (CSMS unavailable)', { chargePointId });
                            proxyResponse = [3, messageId, {
                                transactionId: transactionIdCounter++,
                                idTagInfo: {
                                    status: 'Accepted'
                                }
                            }];
                            break;

                        case 'StopTransaction':
                            logger('INFO', 'Acknowledging StopTransaction (CSMS unavailable)', { chargePointId });
                            proxyResponse = [3, messageId, {
                                idTagInfo: {
                                    status: 'Accepted'
                                }
                            }];
                            break;

                        default:
                            if (DEBUG) logger('DEBUG', 'Unhandled upstream action (CSMS unavailable)', { chargePointId, action });
                            break;
                    }

                    if (proxyResponse) {
                        logMessage(chargePointId, 'UPSTREAM', parsedMsg);
                        chargerSocket.send(JSON.stringify(proxyResponse));
                        logMessage(chargePointId, 'PROXY_RESPONSE', proxyResponse);
                        shouldForward = false;
                    }
                }
            }
        } catch (e) {
            logger('ERROR', 'JSON parse error on upstream message', { chargePointId, error: e.message });
        }

        if (shouldForward) {
            logMessage(chargePointId, 'UPSTREAM', parsedMsg || msgStr);

            if (csmsSocket && csmsSocket.readyState === WebSocket.OPEN) {
                if (DEBUG) logger('DEBUG', 'PROXY → CSMS', { chargePointId, message: msgStr });
                csmsSocket.send(msgStr);
            } else if (csmsSocket && csmsSocket.readyState === WebSocket.CONNECTING) {
                // Buffer messages while CSMS is connecting
                const connection = clients.get(chargePointId);
                if (connection) {
                    connection.messageBuffer.push(msgStr);
                    logger('INFO', 'Buffering message while CSMS connects', {
                        chargePointId,
                        bufferSize: connection.messageBuffer.length
                    });
                }
            } else {
                logger('WARNING', 'CSMS unavailable, message not forwarded', { chargePointId });
            }
        }
    });

    chargerSocket.on('close', async () => {
        logger('INFO', 'Charger disconnected', { chargePointId });

        // Update charger status to OFFLINE
        try {
            await db.updateChargerStatus(chargePointId, 'OFFLINE');
        } catch (err) {
            logger('ERROR', 'Failed to update charger status on disconnect', { chargePointId, error: err.message });
        }

        // Close CSMS connection and cleanup
        const connection = clients.get(chargePointId);
        if (connection) {
            // Clear reconnection timer if active
            if (connection.reconnectTimer) {
                clearTimeout(connection.reconnectTimer);
                connection.reconnectTimer = null;
            }

            // Close CSMS socket
            if (connection.csmsSocket) {
                connection.csmsSocket.close();
                connection.csmsSocket = null;
            }
        }
        clients.delete(chargePointId);
    });

});

// Helper: Database message logging
async function logMessage(cpId, direction, payload) {
    try {
        await db.logMessage(cpId, direction, payload);

        // Update charger status to ONLINE when we see activity
        if (direction === 'UPSTREAM' || direction === 'INJECTION_RESPONSE' || direction === 'PROXY_RESPONSE') {
            await db.updateChargerStatus(cpId, 'ONLINE');
        }
    } catch (err) {
        logger('ERROR', 'Database logging error', { chargePointId: cpId, error: err.message });
    }
}

// Helper function to detect Docker environment
function isRunningInDocker() {
    const fs = require('fs');
    try {
        // Check for .dockerenv file
        if (fs.existsSync('/.dockerenv')) return true;

        // Check cgroup for docker
        const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
        return cgroup.includes('docker') || cgroup.includes('kubepods');
    } catch (err) {
        return false;
    }
}

// Initialize and start server
(async () => {
    // Log startup environment configuration
    logger('INFO', 'Starting OCPP Proxy with environment configuration', {
        nodeEnv: process.env.NODE_ENV || 'development',
        runningInDocker: isRunningInDocker(),
        port: PORT,
        debugMode: DEBUG,
        dbPath: DB_PATH,
        logDir: process.env.LOG_DIR || path.join(__dirname, 'logs'),
        logRetentionCount: process.env.LOG_RETENTION_COUNT || '1000',
        csmsReconnectMaxAttempts: CSMS_RECONNECT_MAX_ATTEMPTS,
        csmsReconnectBaseDelay: CSMS_RECONNECT_BASE_DELAY,
        // PostgreSQL settings (production mode)
        dbHost: process.env.DB_HOST || 'not set',
        dbPort: process.env.DB_PORT || '5432',
        dbUser: process.env.DB_USER || 'not set',
        dbPassword: process.env.DB_PASSWORD ? '***masked***' : 'not set',
        dbName: process.env.DB_NAME || 'not set',
        dbSsl: process.env.DB_SSL || 'false',
        initialAdminPassword: process.env.INITIAL_ADMIN_PASSWORD ? '***masked***' : 'not set'
    });

    await loadConfig();

    // Run cleanup on startup
    try {
        logger('INFO', 'Running log cleanup on startup...');
        const { spawn } = require('child_process');
        spawn('node', [path.join(__dirname, 'scripts/cleanup.js')], {
            detached: true,
            stdio: 'ignore'
        }).unref();
    } catch (err) {
        logger('WARNING', 'Failed to run startup cleanup', { error: err.message });
    }

    server.listen(PORT, () => {
        logger('INFO', `OCPP Proxy started`, {
            port: PORT,
            debugMode: DEBUG,
            targetCsmsUrl: TARGET_CSMS_URL,
            csmsForwardingEnabled: CSMS_FORWARDING_ENABLED
        });
    });
})();

// Graceful shutdown
process.on('SIGTERM', () => {
    logger('INFO', 'SIGTERM received, closing database...');
    db.close();
    process.exit(0);
});

process.on('SIGINT', () => {
    logger('INFO', 'SIGINT received, closing database...');
    db.close();
    process.exit(0);
});
