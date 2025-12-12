# OYE OCPP Proxy - Deployment Guide

This guide explains how to deploy the OYE OCPP Proxy on a local Ubuntu server. You can deploy with Docker (recommended) or run directly with Node.js.

## Prerequisites

### For Docker Deployment (Recommended)
- Ubuntu 20.04+ server
- Docker and Docker Compose installed
- Network access for chargers to reach the server

### For Node.js Deployment
- Ubuntu 20.04+ server
- Node.js v16+ installed
- Network access for chargers to reach the server

## Installation

Choose either Docker or Node.js deployment method below.

---

## Option 1: Docker Deployment (Recommended)

### 1. Install Docker (if not already installed)

```bash
# Update package list
sudo apt update

# Install Docker
sudo apt install -y docker.io docker-compose

# Add your user to docker group (to run without sudo)
sudo usermod -aG docker $USER

# Log out and back in for group changes to take effect
```

### 2. Clone or Copy the Project

```bash
cd /opt
sudo mkdir oye-proxy
sudo chown $USER:$USER oye-proxy
cd oye-proxy

# Copy all project files here
```

### 3. Configure Environment

```bash
# Copy example env file
cp .env.example .env

# Edit if needed (optional)
nano .env
```

### 4. Create Data Directories

```bash
mkdir -p data/db data/logs
```

### 5. Build and Start

```bash
# Build the Docker image
docker-compose build

# Start the container
docker-compose up -d

# Check logs
docker-compose logs -f
```

## Initial Setup

### 1. Default Admin Account

**On first run, the proxy automatically creates a default admin account with a random password.**

To find the auto-generated password:

```bash
# Check the container logs
docker-compose logs | grep "DEFAULT ADMIN USER"
```

You'll see output like:
```
============================================================
DEFAULT ADMIN USER CREATED
============================================================
Username: admin
Password: Xy9k2Lm4Np8qRtVw
============================================================
IMPORTANT: Change this password immediately via the web UI or API!
============================================================
```

**Important:** Change the default password immediately after first login using the web dashboard (click on username → Change Password).

### 2. Create Additional Users (Optional)

To manually create additional users:

```bash
# Enter the container
docker exec -it oye-proxy sh

# Add a user (replace username and password)
node db/init.js newuser yourpassword

# Exit container
exit
```

### 3. Access the Dashboard

Open your browser and navigate to:
```
http://your-server-ip:8080
```

Login with the default admin credentials shown in the logs (or your custom credentials if you created a user manually).

### 4. Configure Proxy Settings

In the dashboard:
1. Click the config icon (gear)
2. Set the **Target CSMS URL** (e.g., `wss://your-csms.com/ocpp/`)
3. Enable **CSMS Forwarding** if you want to forward messages
4. Enable **Automatic Charging** for offline/fallback charging capabilities
5. Set **Default ID Tag** for auto-started charging sessions (e.g., `ADMIN_TAG`)
6. Click **Save**

For standalone mode (no upstream CSMS), leave forwarding disabled. You can optionally enable automatic charging to allow chargers to start sessions without authorization checks.

---

## Option 2: Node.js Deployment (No Docker)

### 1. Install Node.js (if not already installed)

```bash
# Update package list
sudo apt update

# Install Node.js and npm
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version
npm --version
```

### 2. Clone or Copy the Project

```bash
cd /opt
sudo mkdir oye-proxy
sudo chown $USER:$USER oye-proxy
cd oye-proxy

# Copy all project files here
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Configure Environment

```bash
# Copy example env file
cp .env.example .env

# Edit for local paths (not Docker paths)
nano .env
```

Update `.env` with local paths:
```env
PORT=8080
DEBUG=false
DB_PATH=./data/db/oye-proxy.db
LOG_DIR=./logs
LOG_RETENTION_COUNT=1000
```

### 5. Create Data Directories

```bash
mkdir -p data/db data/logs
```

### 6. Start the Proxy

```bash
# Run directly
node index.js

# Or run in background with nohup
nohup node index.js > logs/proxy.log 2>&1 &

# Or use PM2 for production (recommended)
sudo npm install -g pm2
pm2 start index.js --name oye-proxy
pm2 save
pm2 startup  # Follow instructions to enable auto-start on boot
```

### 7. Default Admin Account

**On first run, the proxy automatically creates a default admin account with a random password.**

To find the auto-generated password:

```bash
# Check the logs
tail -n 100 logs/oye-proxy.log | grep "DEFAULT ADMIN USER" -A 8

# Or if using PM2
pm2 logs oye-proxy | grep "DEFAULT ADMIN USER"
```

You'll see output like:
```
============================================================
DEFAULT ADMIN USER CREATED
============================================================
Username: admin
Password: Xy9k2Lm4Np8qRtVw
============================================================
IMPORTANT: Change this password immediately via the web UI or API!
============================================================
```

**Important:** Change the default password immediately after first login using the web dashboard (click on username → Change Password).

### 8. Create Additional Users (Optional)

To manually create additional users:

```bash
node db/init.js newuser yourpassword
```

### 9. Access the Dashboard

Open your browser and navigate to:
```
http://your-server-ip:8080
```

Login with the default admin credentials shown in the logs (or your custom credentials if you created a user manually).

### 10. Configure Proxy Settings

Same as Docker deployment - use the web dashboard to configure CSMS URL, forwarding, and auto-charging options.

---

## Charger Configuration

Point your EV chargers to:
```
ws://your-server-ip:8080/ocpp/{chargePointId}
```

Or for WebSocket Secure (requires nginx):
```
wss://your-server-ip/ocpp/{chargePointId}
```

## Management Commands

### Docker Deployment

#### View Logs
```bash
docker-compose logs -f
```

#### Restart Proxy
```bash
docker-compose restart
```

#### Stop Proxy
```bash
docker-compose down
```

### Node.js Deployment

#### View Logs
```bash
# If using nohup
tail -f logs/proxy.log

# If using PM2
pm2 logs oye-proxy
```

#### Restart Proxy
```bash
# If using PM2
pm2 restart oye-proxy

# If running directly, stop and restart
killall node
node index.js &
```

#### Stop Proxy
```bash
# If using PM2
pm2 stop oye-proxy

# If using nohup, find and kill the process
ps aux | grep "node index.js"
kill <PID>
```

### Backup Database

```bash
# Create backup of database file (works for both Docker and Node.js)
cp data/db/oye-proxy.db data/db/oye-proxy.db.backup-$(date +%Y%m%d)

# Or create compressed backup
tar czf oye-proxy-backup-$(date +%Y%m%d).tar.gz data/
```

### View Database

```bash
# Install sqlite3
sudo apt install sqlite3

# Query database (works for both Docker and Node.js)
sqlite3 data/db/oye-proxy.db "SELECT * FROM chargers;"
sqlite3 data/db/oye-proxy.db "SELECT COUNT(*) FROM logs;"
sqlite3 data/db/oye-proxy.db "SELECT * FROM config;"
```

### Add New Users

**Docker:**
```bash
docker exec -it oye-proxy node db/init.js newuser newpassword
```

**Node.js:**
```bash
node db/init.js newuser newpassword
```

### Manual Log Cleanup

**Docker:**
```bash
docker exec -it oye-proxy node scripts/cleanup.js
```

**Node.js:**
```bash
node scripts/cleanup.js
```

## Updating the Proxy

### Docker Deployment
```bash
# Stop the container
docker-compose down

# Pull/copy new code
git pull  # or copy new files

# Rebuild
docker-compose build

# Start with new image
docker-compose up -d
```

### Node.js Deployment
```bash
# Stop the proxy
pm2 stop oye-proxy  # or kill the process

# Pull/copy new code
git pull  # or copy new files

# Install any new dependencies
npm install

# Restart
pm2 restart oye-proxy  # or node index.js
```

## Troubleshooting

### Container won't start (Docker)
```bash
# Check logs
docker-compose logs

# Check if port is already in use
sudo netstat -tlnp | grep 8080
```

### Proxy won't start (Node.js)
```bash
# Check if port is already in use
sudo netstat -tlnp | grep 8080

# Check for errors
node index.js  # Run directly to see error messages

# Check Node.js version
node --version  # Should be v16 or higher
```

### Authentication issues

**Docker:**
```bash
# Reset user password
docker exec -it oye-proxy node db/init.js admin newpassword
```

**Node.js:**
```bash
# Reset user password
node db/init.js admin newpassword
```

**Both:**
```bash
# Clear browser localStorage
# Open browser console: localStorage.removeItem('authToken')
```

### Database locked errors

**Docker:**
```bash
# Stop container
docker-compose down

# Check for stale lock files (WAL mode files)
ls -la data/db/
rm -f data/db/oye-proxy.db-wal data/db/oye-proxy.db-shm

# Restart
docker-compose up -d
```

**Node.js:**
```bash
# Stop proxy
pm2 stop oye-proxy  # or kill the process

# Check for stale lock files (WAL mode files)
ls -la data/db/
rm -f data/db/oye-proxy.db-wal data/db/oye-proxy.db-shm

# Restart
pm2 restart oye-proxy  # or node index.js
```

### Chargers not connecting
- Check firewall: `sudo ufw allow 8080/tcp`
- Check Docker network: `docker network inspect bridge`
- Verify charger URL includes `/ocpp/{chargePointId}`

## Firewall Configuration

If using UFW:
```bash
# Allow proxy port
sudo ufw allow 8080/tcp

# Allow SSH (if not already)
sudo ufw allow 22/tcp

# Enable firewall
sudo ufw enable
```

## Optional: Auto-Start on Boot

### Docker with systemd

Instead of using Docker Compose manually, you can set up Docker to start on boot:

```bash
# Enable Docker to start on boot
sudo systemctl enable docker

# Create compose service
sudo nano /etc/systemd/system/oye-proxy.service
```

Paste:
```ini
[Unit]
Description=OYE OCPP Proxy
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/oye-proxy
ExecStart=/usr/bin/docker-compose up -d
ExecStop=/usr/bin/docker-compose down

[Install]
WantedBy=multi-user.target
```

Enable:
```bash
sudo systemctl daemon-reload
sudo systemctl enable oye-proxy
sudo systemctl start oye-proxy
```

### Node.js with PM2

PM2 makes it easy to auto-start Node.js applications:

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start the proxy
pm2 start index.js --name oye-proxy

# Save PM2 process list
pm2 save

# Generate and configure startup script
pm2 startup

# Follow the instructions printed by PM2
```

After running `pm2 startup`, PM2 will print a command to run with sudo. Execute that command to enable auto-start on boot.

**Managing with PM2:**
```bash
# View status
pm2 status

# View logs
pm2 logs oye-proxy

# Restart
pm2 restart oye-proxy

# Stop
pm2 stop oye-proxy

# Monitor resources
pm2 monit
```

## Monitoring

### Resource Usage

**Docker:**
```bash
docker stats oye-proxy
```

**Node.js:**
```bash
# If using PM2
pm2 monit

# Or use standard Linux tools
top -p $(pgrep -f "node index.js")
```

### Disk Usage
```bash
# Works for both Docker and Node.js
du -sh data/db data/logs
```

### Active Connections

**Docker:**
```bash
docker exec -it oye-proxy sh -c 'wget -qO- http://localhost:8080/'
```

**Node.js:**
```bash
curl http://localhost:8080/
# Or
wget -qO- http://localhost:8080/
```

## Security Recommendations

1. **Change the auto-generated admin password immediately** after first login (click username → Change Password in the web dashboard)
2. **Use strong passwords** (minimum 8 characters required, 16+ recommended)
3. **Set up nginx** with SSL/TLS for production
4. **Limit port access** to known charger IPs
5. **Regular backups** of the database
6. **Monitor logs** for unauthorized access attempts
7. **Delete or disable unused user accounts**

## Features Specific to Deployment

### Automatic Charging (Offline Mode)

When deploying in standalone mode or with unreliable CSMS connectivity:

1. Enable **Automatic Charging** in the configuration
2. Set a **Default ID Tag** (e.g., `FREE_CHARGING`, `ADMIN_TAG`)
3. The proxy will automatically:
   - Accept all authorization requests when CSMS is unavailable
   - Start charging sessions when chargers enter "Preparing" state
   - Use the configured ID tag for transaction records

This is ideal for:
- Private charging installations
- Backup/failover scenarios
- Development and testing environments

## Support


---

## Option 3: Google Cloud Run (Serverless)

Deploying to Google Cloud Run allows the proxy to scale to zero when not in use and eliminates server maintenance. We use **Cloud SQL (PostgreSQL)** for persistence.

### Prerequisites
- Google Cloud Project
- `gcloud` CLI installed and authenticated

### 1. Setup Cloud SQL (PostgreSQL)

1.  **Create an instance:**
    ```bash
    gcloud sql instances create oye-proxy-db \
        --database-version=POSTGRES_15 \
        --cpu=1 --memory=3840MiB \
        --region=us-central1
    ```

2.  **Create database:**
    ```bash
    gcloud sql databases create oye_proxy --instance=oye-proxy-db
    ```

3.  **Create user:**
    ```bash
    gcloud sql users create oye_user \
        --instance=oye-proxy-db \
        --password=YOUR_SECURE_PASSWORD
    ```

### 2. Deploy to Cloud Run

Run the following command to build and deploy. Replace `PROJECT_ID` and `YOUR_SECURE_PASSWORD` with your values.

```bash
# Set your project ID
export PROJECT_ID=$(gcloud config get-value project)

# 1. Build and push the image
gcloud builds submit --tag gcr.io/$PROJECT_ID/oye-proxy

# 2. Deploy
gcloud run deploy oye-proxy \
    --image gcr.io/$PROJECT_ID/oye-proxy \
    --platform managed \
    --region us-central1 \
    --allow-unauthenticated \
    --port 8080 \
    --add-cloudsql-instances $PROJECT_ID:us-central1:oye-proxy-db \
    --set-env-vars="NODE_ENV=production" \
    --set-env-vars="DB_HOST=/cloudsql/$PROJECT_ID:us-central1:oye-proxy-db" \
    --set-env-vars="DB_USER=oye_user" \
    --set-env-vars="DB_PASSWORD=YOUR_SECURE_PASSWORD" \
    --set-env-vars="DB_NAME=oye_proxy" \
    --set-env-vars="INITIAL_ADMIN_PASSWORD=SuperSecretAdminPassword"
```

> **Note:** `INITIAL_ADMIN_PASSWORD` is used to set the default admin password on the first run.

### 3. Verify Deployment

1.  Get the service URL from the output.
2.  Open the URL in your browser.
3.  Login with user `admin` and the password you set in `INITIAL_ADMIN_PASSWORD`.

