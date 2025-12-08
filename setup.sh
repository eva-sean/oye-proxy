#!/bin/bash
# Quick setup script for OCPP Proxy

set -e

echo "========================================="
echo "OCPP Proxy Setup"
echo "========================================="
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "ERROR: Docker is not installed."
    echo "Install Docker first: https://docs.docker.com/engine/install/ubuntu/"
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo "ERROR: Docker Compose is not installed."
    echo "Install Docker Compose first: https://docs.docker.com/compose/install/"
    exit 1
fi

echo "✓ Docker and Docker Compose are installed"
echo ""

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "Creating .env file..."
    cp .env.example .env
    echo "✓ Created .env file"
else
    echo "✓ .env file already exists"
fi
echo ""

# Create data directories
echo "Creating data directories..."
mkdir -p data/db data/logs
echo "✓ Created data directories"
echo ""

# Sync package-lock.json with package.json
echo "Syncing npm dependencies..."
npm install
echo "✓ Dependencies synced"
echo ""

# Build Docker image
echo "Building Docker image..."
docker-compose build
echo "✓ Docker image built"
echo ""

# Prompt for admin credentials
echo "========================================="
echo "Create Admin User"
echo "========================================="
read -p "Enter admin username [admin]: " ADMIN_USER
ADMIN_USER=${ADMIN_USER:-admin}

read -sp "Enter admin password: " ADMIN_PASS
echo ""

if [ -z "$ADMIN_PASS" ]; then
    echo "ERROR: Password cannot be empty"
    exit 1
fi

# Start container temporarily to create user
echo ""
echo "Starting container temporarily..."
docker-compose up -d
sleep 3

echo "Creating admin user..."
docker exec oye-proxy node db/init.js "$ADMIN_USER" "$ADMIN_PASS"

echo ""
echo "========================================="
echo "Setup Complete!"
echo "========================================="
echo ""
echo "The OCPP Proxy is now running on port 8080"
echo ""
echo "Dashboard: http://localhost:8080"
echo "Username: $ADMIN_USER"
echo ""
echo "Useful commands:"
echo "  docker-compose logs -f    # View logs"
echo "  docker-compose restart    # Restart proxy"
echo "  docker-compose down       # Stop proxy"
echo ""
echo "Point your chargers to: ws://YOUR_SERVER_IP:8080/ocpp/{chargePointId}"
echo ""
echo "See DEPLOYMENT.md for more information"
echo ""
