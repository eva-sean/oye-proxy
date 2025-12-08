require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const path = require('path');
const DatabaseAdapter = require('./db/adapter');
const logger = require('./logger');
const { createAuthMiddleware } = require('./auth');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db/oye-proxy.db');
const PORT = process.env.PORT || 8080;
const DEBUG = process.env.DEBUG === 'true';

// Initialize database
const db = new DatabaseAdapter(DB_PATH);

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
    if (DEBUG) { logger('DEBUG', 'Health check', {url: req.url} )};
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

// Command injection
app.post('/api/inject/:cpId', requireAuth, async (req, res) => {
    if (DEBUG) { logger('DEBUG', 'POST request', {url: req.url} )};
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

// -----------------------------------------------------------------------------
// WebSocket Handling
// -----------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    if (DEBUG) { logger('DEBUG', 'Upgrade request', {url: request.url} )};
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

// Helper function to setup CSMS socket event handlers
function setupCsmsHandlers(csmsSocket, chargerSocket, chargePointId) {
    csmsSocket.on('open', () => {
        logger('INFO', 'CSMS connected successfully', { chargePointId });

        const connection = clients.get(chargePointId);
        if (connection && connection.messageBuffer.length > 0) {
            logger('INFO', 'Flushing message buffer to CSMS', {
                chargePointId,
                bufferedMessages: connection.messageBuffer.length
            });

            // Send all buffered messages
            connection.messageBuffer.forEach(msg => {
                if (csmsSocket.readyState === WebSocket.OPEN) {
                    csmsSocket.send(msg);
                    if (DEBUG) logger('DEBUG', 'PROXY → CSMS (buffered)', { chargePointId, message: msg });
                }
            });

            // Clear buffer
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
    });

    csmsSocket.on('message', async (message) => {
        const msgStr = message.toString();
        if (DEBUG) logger('DEBUG', 'CSMS → PROXY', { chargePointId, message: msgStr });

        try {
            const parsed = JSON.parse(msgStr);
            if (Array.isArray(parsed) && parsed[0] === 4) {
                logger('ERROR', 'CSMS error response', { chargePointId, response: parsed });
            }
        } catch (e) {
            // Not JSON, just forward
        }

        logMessage(chargePointId, 'DOWNSTREAM', msgStr);
        if (chargerSocket.readyState === WebSocket.OPEN) {
            if (DEBUG) logger('DEBUG', 'PROXY → CHARGER', { chargePointId, message: msgStr });
            chargerSocket.send(msgStr);
        } else {
            logger('WARNING', 'Charger disconnected, cannot forward CSMS message', { chargePointId });
        }
    });

    csmsSocket.on('close', (code, reason) => {
        // Code 1000 = normal closure, don't log as INFO unless debug mode
        const logLevel = (code === 1000 && !DEBUG) ? 'DEBUG' : 'INFO';
        logger(logLevel, 'CSMS disconnected', { chargePointId, code, reason: reason || 'None' });

        const connection = clients.get(chargePointId);
        if (connection && connection.csmsSocket === csmsSocket) {
            connection.csmsSocket = null;
        }
    });

    csmsSocket.on('error', (err) => {
        logger('ERROR', 'CSMS socket error', {
            chargePointId,
            error: err.message,
            code: err.code,
            errno: err.errno,
            syscall: err.syscall,
            stack: DEBUG ? err.stack : undefined
        });
    });
}

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
        messageBuffer: [] // Buffer messages while CSMS is connecting
    });

    let csmsSocket = null;

    // Function to connect to CSMS
    const connectToCsms = () => {
        if (!CSMS_FORWARDING_ENABLED) return;

        const csmsTarget = TARGET_CSMS_URL.endsWith('/')
            ? `${TARGET_CSMS_URL}${chargePointId}`
            : `${TARGET_CSMS_URL}/${chargePointId}`;

        if (DEBUG) {
            logger('DEBUG', 'CSMS connection attempt', {
                chargePointId,
                target: csmsTarget,
                protocol: req.headers['sec-websocket-protocol'] || 'none',
                hasAuth: !!req.headers['authorization']
            });
        }

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

            const connection = clients.get(chargePointId);
            if (connection) {
                connection.csmsSocket = csmsSocket;
            }

            // Set up CSMS event handlers
            setupCsmsHandlers(csmsSocket, chargerSocket, chargePointId);

        } catch (err) {
            logger('ERROR', 'Failed to create CSMS connection', {
                chargePointId,
                error: err.message,
                stack: DEBUG ? err.stack : undefined
            });
        }
    };

    // Call connect function
    if (CSMS_FORWARDING_ENABLED) {
        connectToCsms();
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

                const csmsUnavailable = !csmsSocket ||
                    csmsSocket.readyState === WebSocket.CLOSING ||
                    csmsSocket.readyState === WebSocket.CLOSED;

                if (csmsUnavailable) {
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

        // Close CSMS connection and mark for cleanup
        const connection = clients.get(chargePointId);
        if (connection && connection.csmsSocket) {
            connection.csmsSocket.close();
            connection.csmsSocket = null;
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

// Initialize and start server
(async () => {
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
