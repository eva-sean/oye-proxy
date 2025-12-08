# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an OCPP (Open Charge Point Protocol) transparent proxy that sits between EV chargers and a Central System Management Service (CSMS). It provides full traffic visibility, logging, and command injection capabilities without confusing the upstream CSMS. The project is designed to run on a local Ubuntu server using Docker, with SQLite for data storage and a real-time web dashboard for monitoring and control.

## Development Commands

```bash
# Quick setup (first time)
./setup.sh

# Start with Docker
docker-compose up -d

# View logs
docker-compose logs -f

# Stop proxy
docker-compose down

# Rebuild after code changes
docker-compose build && docker-compose up -d

# Add new user
docker exec -it oye-proxy node db/init.js username password

# Manual log cleanup
docker exec -it oye-proxy node scripts/cleanup.js
```

## Environment Configuration

Copy `.env.example` to `.env` and customize:

```env
PORT=8080
DEBUG=false
DB_PATH=/app/db/oye-proxy.db
LOG_DIR=/app/logs
LOG_RETENTION_COUNT=1000
```

## Architecture

### Critical Design Constraint: Single-Instance Only

This proxy uses **in-memory state** to map charger WebSocket connections to CSMS connections. The `clients` Map in `index.js` stores active connections and cannot be shared across instances. **Always deploy with a single instance** (enforced by Docker Compose).

### Dual WebSocket Architecture

For each connected charger, the proxy maintains TWO WebSocket connections:
1. **Charger Socket**: From the physical charger to the proxy
2. **CSMS Socket**: From the proxy to the upstream CSMS

Connection lifecycle:
- Charger connects via `/ocpp/{chargePointId}`
- Proxy extracts auth headers and WebSocket protocol
- Proxy opens connection to `${TARGET_CSMS_URL}${chargePointId}` (if forwarding enabled)
- Connections are bidirectional and synchronized

### Message Flow

**Normal Pass-Through:**
- Messages flow: Charger → Proxy → CSMS (logged as UPSTREAM)
- Messages flow: CSMS → Proxy → Charger (logged as DOWNSTREAM)
- All messages are logged to SQLite `logs` table

**Command Injection & Response Interception:**

This is the core innovation. When you inject a command via REST API:

1. Generate unique message ID using `crypto.randomUUID()`
2. Store ID in `clients.get(cpId).pendingIds` Set
3. Send OCPP Call message `[2, messageId, action, payload]` to charger
4. Log as `INJECTION_REQUEST`

When charger responds:
1. Check if message is Type 3 (CallResult) or Type 4 (CallError)
2. Extract message ID from `parsedMsg[1]`
3. If ID exists in `pendingIds` Set:
   - Log as `INJECTION_RESPONSE`
   - Remove from `pendingIds`
   - **DO NOT forward to CSMS** (prevents unknown message ID errors)

TTL cleanup: Stale IDs are removed after 60 seconds to prevent memory leaks.

### State Management

The `clients` Map structure:
```javascript
{
  chargePointId: {
    chargerSocket: WebSocket,
    csmsSocket: WebSocket,
    pendingIds: Set<String>  // Message IDs of injected commands
  }
}
```

## OCPP Protocol Details

This proxy supports OCPP 1.6J and 2.0.1 over WebSocket.

OCPP message format (array-based):
- `[2, messageId, action, payload]` - Call (Request)
- `[3, messageId, payload]` - CallResult (Success Response)
- `[4, messageId, errorCode, errorDescription, errorDetails]` - CallError (Error Response)

When working with OCPP messages:
- Always parse as JSON arrays
- Message type is `parsedMsg[0]`
- Message ID is `parsedMsg[1]`
- Responses (type 3/4) must match a previous Call (type 2)

## Database Schema (SQLite)

### Table: `config`
- `key`: TEXT PRIMARY KEY
- `value`: TEXT
- `updated_at`: INTEGER (Unix timestamp)

Default keys:
- `targetCsmsUrl`: WebSocket URL of upstream CSMS
- `csmsForwardingEnabled`: 'true' or 'false'
- `port`: Server port number

### Table: `logs`
- `id`: INTEGER PRIMARY KEY AUTOINCREMENT
- `charge_point_id`: TEXT
- `direction`: TEXT ('UPSTREAM', 'DOWNSTREAM', 'INJECTION_REQUEST', 'INJECTION_RESPONSE', 'PROXY_RESPONSE')
- `payload`: TEXT (JSON string)
- `timestamp`: INTEGER (Unix timestamp)

### Table: `chargers`
- `charge_point_id`: TEXT PRIMARY KEY
- `status`: TEXT ('ONLINE', 'OFFLINE')
- `last_seen`: INTEGER (Unix timestamp)

### Table: `auth_users`
- `username`: TEXT PRIMARY KEY
- `password_hash`: TEXT (SHA-256)
- `created_at`: INTEGER (Unix timestamp)

The proxy loads configuration from the database on startup. Priority order:
1. SQLite `config` table (highest)
2. Environment variables
3. Hardcoded defaults

When `csmsForwardingEnabled: false`, the proxy runs in standalone mode (no CSMS connection).

## REST API

All endpoints except health check require Basic Authentication.

**Health Check:**
```
GET /
```

**Get Logs:**
```
GET /api/logs?chargePointId={cpId}&limit={n}&since={timestamp}
Authorization: Basic {base64(username:password)}
```

**Get Chargers:**
```
GET /api/chargers
Authorization: Basic {base64(username:password)}
```

**Get Config:**
```
GET /api/config
Authorization: Basic {base64(username:password)}
```

**Update Config:**
```
POST /api/config
Authorization: Basic {base64(username:password)}
Content-Type: application/json

{
  "targetCsmsUrl": "wss://example.com/ocpp/",
  "csmsForwardingEnabled": true
}
```

**Command Injection:**
```
POST /api/inject/{chargePointId}
Authorization: Basic {base64(username:password)}
Content-Type: application/json

{
  "action": "RemoteStartTransaction",
  "payload": {
    "connectorId": 1,
    "idTag": "ADMIN_OVERRIDE_TAG"
  }
}
```

## Web Dashboard

The `public/` directory contains a web dashboard built with vanilla JavaScript.

### Key Files
- `public/index.html`: Main dashboard UI with tabs for logs, status, and command injection
- `public/app.js`: REST API polling, authentication, and command injection logic
- `public/styles.css`: Responsive UI styling
- `public/ocpp-templates.js`: Pre-defined OCPP command templates

### Dashboard Features
- Polling-based message monitoring (5-second refresh)
- Basic HTTP authentication with localStorage persistence
- Charger status tracking (online/offline)
- Command injection via web UI (alternative to REST API)
- Message filtering by charger and limit
- Proxy configuration management (CSMS URL and forwarding toggle)

### Integration Points
- Polls `/api/logs`, `/api/chargers`, `/api/config` every 5 seconds
- Writes to `/api/config` for proxy settings
- Calls `/api/inject/{chargePointId}` endpoint for command injection
- Uses Basic Auth (credentials stored in localStorage)

When working on the dashboard:
- It's a zero-build-step application (no webpack/vite)
- All JavaScript is vanilla ES6+
- State management is done with vanilla JS (no React/Vue)
- Authentication prompt appears on first visit

## Log Cleanup

A cron job automatically cleans up old logs to prevent unbounded growth:

- **Location**: `scripts/cleanup.js`
- **Schedule**: Daily at 2 AM UTC (defined in `scripts/crontab`)
- **Retention**: 1000 most recent logs per charger (configurable via `LOG_RETENTION_COUNT` env var)
- **Startup**: Also runs once on container startup

The cleanup script:
1. Queries all unique charger IDs from the database
2. For each charger, keeps the N most recent logs (ordered by timestamp)
3. Deletes older logs in batches

## File Structure

```
.
├── index.js              # Main proxy server
├── logger.js             # File-based logging with rotation
├── auth.js               # Basic authentication middleware
├── db/
│   ├── schema.sql        # SQLite database schema
│   ├── init.js           # Database initialization and user management
│   └── adapter.js        # Database access layer
├── scripts/
│   ├── cleanup.js        # Log cleanup script
│   └── crontab           # Cron schedule for cleanup
├── public/
│   ├── index.html        # Dashboard UI
│   ├── app.js            # Dashboard logic (polling)
│   ├── styles.css        # Dashboard styles
│   └── ocpp-templates.js # OCPP command templates
├── Dockerfile            # Container definition
├── docker-compose.yml    # Docker Compose config
├── setup.sh              # First-time setup script
├── DEPLOYMENT.md         # Deployment guide
└── .env.example          # Environment variables template
```

## Logging

The proxy uses a custom file-based logger (`logger.js`) that:
- Writes to `logs/oye-proxy.log`
- Automatically rotates when file exceeds 10MB
- Keeps 5 most recent log files
- Outputs JSON-formatted structured logs
- Also logs to console for Docker logs

Log levels: DEBUG, INFO, WARNING, ERROR

## Known Limitations

1. **Single Instance Only**: Cannot scale horizontally without Redis/external state store
2. **No Connection Pooling**: Each charger requires dedicated socket pair
3. **In-Memory ID Tracking**: Restarting the server loses pending injection IDs
4. **SQLite Concurrency**: Limited write concurrency (uses WAL mode for better performance)
5. **Basic Auth Only**: No OAuth/JWT support (add nginx with auth module for more security)

## Security Notes

- Authentication uses SHA-256 password hashing (consider bcrypt for production)
- Dashboard stores auth token in localStorage (consider sessionStorage)
- WebSocket connections from chargers are unauthenticated
- Add nginx reverse proxy with SSL/TLS for production deployments
- Limit API access to trusted networks via firewall rules

# important-instruction-reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
