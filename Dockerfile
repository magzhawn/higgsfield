FROM oven/bun:1.1-slim
WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --production

COPY src/ ./src/
COPY openapi.json ./

EXPOSE 8080
CMD ["bun", "src/main.ts"]
