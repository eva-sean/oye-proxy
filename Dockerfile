# Use Node.js LTS
FROM node:20-alpine

# Install cron and bash
RUN apk add --no-cache dcron bash

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create directories for data persistence
RUN mkdir -p /app/data/db /app/logs

# Initialize database
RUN DB_PATH=/app/data/db/oye-proxy.db node db/init.js

# Setup cron job
RUN crontab scripts/crontab

# Expose port (default 8080, configurable via ENV)
EXPOSE 8080

# Create startup script
RUN echo '#!/bin/bash' > /app/start.sh && \
    echo '# Initialize database if it does not exist or is empty' >> /app/start.sh && \
    echo 'node db/init.js' >> /app/start.sh && \
    echo 'crond' >> /app/start.sh && \
    echo 'node index.js' >> /app/start.sh && \
    chmod +x /app/start.sh

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:${PORT:-8080}/', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start cron and app
CMD ["/app/start.sh"]
