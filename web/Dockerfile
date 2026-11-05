FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --include=dev
COPY . .
RUN npm run typecheck && npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 SERVER_SHUTDOWN_TIMEOUT=55 \
    DATABASE_PATH=/state/downloads.sqlite3 TG_SESSION_PATH=/state/telegram.session \
    CONFIG_PATH=/configuration/config.json MEDIA_ROOT=/media TEMP_ROOT=/tmp/telegram
RUN mkdir -p /state /configuration /media/TV /media/.incoming /tmp/telegram \
    && chown -R node:node /state /configuration /media /tmp/telegram \
    && chmod 700 /state /configuration /media/.incoming /tmp/telegram
COPY --from=build --chown=node:node /app/.output ./.output
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
