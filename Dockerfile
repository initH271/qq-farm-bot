FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod
COPY client.js ./
COPY src/ ./src/
COPY proto/ ./proto/
COPY gameConfig/ ./gameConfig/
USER node
ENTRYPOINT ["node", "client.js"]
