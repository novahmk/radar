# Etapa 1: compila o TypeScript
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Etapa 2: imagem final, só com dist e dependências de produção
FROM node:20-slim
ENV NODE_ENV=production \
    TZ=America/Sao_Paulo \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
RUN mkdir -p /data/auth && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
