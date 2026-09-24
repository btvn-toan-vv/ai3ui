# Frontend image. Build context MUST be the repo root: the app depends on
# ai3ui via "file:../ai3ui", so both packages are built in one stage.
#   docker build -f frontend/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /repo

# Manifests first for layer caching.
COPY ai3ui/package.json ai3ui/package-lock.json ai3ui/
COPY frontend/package.json frontend/package-lock.json frontend/

COPY ai3ui ai3ui
RUN npm --prefix ai3ui ci && npm --prefix ai3ui run build

COPY frontend frontend
RUN npm --prefix frontend ci

# Baked into the bundle. Empty (default) = same origin: nginx proxies the
# adapter endpoints, so no cross-origin calls no matter how the UI is
# reached. Set VITE_SERVER_URL only when the adapter lives elsewhere.
ARG VITE_SERVER_URL=
ENV VITE_SERVER_URL=$VITE_SERVER_URL
RUN npm --prefix frontend run build

FROM nginx:alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/frontend/dist /usr/share/nginx/html
EXPOSE 80
