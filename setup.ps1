# PowerShell setup script for OCPP Proxy (Windows)

$ErrorActionPreference = "Stop"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "OCPP Proxy Setup (Windows)" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# Check if Docker is installed
try {
    $null = docker --version
    Write-Host "✓ Docker is installed" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Docker is not installed." -ForegroundColor Red
    Write-Host "Install Docker Desktop for Windows: https://www.docker.com/products/docker-desktop/" -ForegroundColor Yellow
    exit 1
}
Write-Host ""

# Check if Docker Compose is available
try {
    $null = docker-compose --version
    Write-Host "✓ Docker Compose is installed" -ForegroundColor Green
} catch {
    try {
        $null = docker compose version
        Write-Host "✓ Docker Compose (v2) is installed" -ForegroundColor Green
    } catch {
        Write-Host "ERROR: Docker Compose is not installed." -ForegroundColor Red
        exit 1
    }
}
Write-Host ""

# Create .env file if it doesn't exist
if (-Not (Test-Path .env)) {
    Write-Host "Creating .env file..." -ForegroundColor Yellow
    Copy-Item .env.example .env
    Write-Host "✓ Created .env file" -ForegroundColor Green
} else {
    Write-Host "✓ .env file already exists" -ForegroundColor Green
}
Write-Host ""

# Create data directories
Write-Host "Creating data directories..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path "data\db" | Out-Null
New-Item -ItemType Directory -Force -Path "data\logs" | Out-Null
Write-Host "✓ Created data directories" -ForegroundColor Green
Write-Host ""

# Build Docker image
Write-Host "Building Docker image..." -ForegroundColor Yellow
docker-compose build
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Docker build failed" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Docker image built" -ForegroundColor Green
Write-Host ""

# Prompt for admin credentials
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Create Admin User" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

$adminUser = Read-Host "Enter admin username [admin]"
if ([string]::IsNullOrWhiteSpace($adminUser)) {
    $adminUser = "admin"
}

$adminPass = Read-Host "Enter admin password" -AsSecureString
$adminPassPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminPass)
)

if ([string]::IsNullOrWhiteSpace($adminPassPlain)) {
    Write-Host "ERROR: Password cannot be empty" -ForegroundColor Red
    exit 1
}

# Start container temporarily to create user
Write-Host ""
Write-Host "Starting container temporarily..." -ForegroundColor Yellow
docker-compose up -d
Start-Sleep -Seconds 3

Write-Host "Creating admin user..." -ForegroundColor Yellow
docker exec oye-proxy node db/init.js $adminUser $adminPassPlain

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Setup Complete!" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "The OCPP Proxy is now running on port 8080" -ForegroundColor Green
Write-Host ""
Write-Host "Dashboard: http://localhost:8080" -ForegroundColor Yellow
Write-Host "Username: $adminUser" -ForegroundColor Yellow
Write-Host ""
Write-Host "Useful commands:" -ForegroundColor Cyan
Write-Host "  docker-compose logs -f    # View logs"
Write-Host "  docker-compose restart    # Restart proxy"
Write-Host "  docker-compose down       # Stop proxy"
Write-Host ""
Write-Host "Point your chargers to: ws://YOUR_SERVER_IP:8080/ocpp/{chargePointId}" -ForegroundColor Yellow
Write-Host ""
Write-Host "See DEPLOYMENT.md for more information" -ForegroundColor Cyan
Write-Host ""
