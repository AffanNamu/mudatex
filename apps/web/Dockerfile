# Mudatex web console image. Build context is apps/web. Set API_URL when running the container.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npx vite build

FROM nginxinc/nginx-unprivileged:1.27-alpine
USER root
COPY docker/nginx.conf.template docker/security-headers.inc.template /etc/nginx/templates-mudatex/
COPY docker/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
COPY --from=build /app/dist /usr/share/nginx/html
# The start-up script writes config.js and the server block, so the unprivileged user owns those places.
RUN rm -f /etc/nginx/conf.d/default.conf && touch /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/security-headers.inc \
 && chown -R nginx:nginx /usr/share/nginx/html /etc/nginx/conf.d
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
