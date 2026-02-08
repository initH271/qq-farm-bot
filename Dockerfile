FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production
COPY client.js ./
COPY src/ ./src/
COPY proto/ ./proto/
USER bun
ENTRYPOINT ["bun", "client.js"]
