# MoltSwarm API Server
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/
COPY scripts/ ./scripts/

# Expose port (7777 - verified free on OnlyFlies server)
EXPOSE 7777
ENV PORT=7777

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:7777/api/v1/health || exit 1

# Run
CMD ["node", "src/index.js"]
