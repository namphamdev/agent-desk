# Build stage
FROM oven/bun:1.2 AS build
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun build src/server.ts --target bun --outdir dist

# Runtime stage
FROM oven/bun:1.2-debian
WORKDIR /app
COPY --from=build /app/dist/server.js ./server.js
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src/install.sh ./install.sh

# Data volume mount point
VOLUME ["/app/data"]
ENV DATA_DIR=/app/data
ENV PORT=3000
EXPOSE 3000

# Bun native WebSocket + HTTP server
CMD ["bun", "run", "server.js"]
