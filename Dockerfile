# IAgenda: Node com TypeScript direto (sem build). Os dados ficam no volume /dados.
FROM node:22-slim

ENV NODE_ENV=production \
    AGENDA_HOST=0.0.0.0 \
    AGENDA_PORTA=8091 \
    AGENDA_DADOS=/dados \
    TZ=America/Sao_Paulo

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY *.ts ./
COPY publico ./publico

RUN mkdir -p /dados && chown node:node /dados
USER node
VOLUME /dados
EXPOSE 8091

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8091/saude').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# O SQLite do Node ainda é marcado como experimental: o aviso sai do log, o resto continua.
CMD ["node", "--disable-warning=ExperimentalWarning", "servidor.ts"]
