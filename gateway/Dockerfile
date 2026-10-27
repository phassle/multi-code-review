FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/mcr
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production HOME=/tmp
USER node
EXPOSE 7700
CMD ["node", "src/server.ts"]
