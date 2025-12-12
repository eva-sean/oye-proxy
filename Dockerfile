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

# Initialize schema (optional at build time for raw docker, but init.js runs at startup too)
# We skip build-time init for Cloud Run flexibility (env vars might not be present yet)

# Expose port
EXPOSE 8080

# Create startup script
# We run init.js at startup to ensure migrations run against the actual connected DB
RUN echo '#!/bin/bash' > /app/start.sh && \
    echo 'node db/init.js' >> /app/start.sh && \
    echo 'if [ -f scripts/crontab ]; then crontab scripts/crontab && crond; fi' >> /app/start.sh && \
    echo 'node index.js' >> /app/start.sh && \
    chmod +x /app/start.sh

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:${PORT:-8080}/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start
CMD ["/app/start.sh"]

