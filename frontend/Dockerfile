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

# Baked into the bundle. The browser runs on the host, so the default
# points at the compose-published server port on localhost.
ARG VITE_SERVER_URL=http://localhost:8123
ENV VITE_SERVER_URL=$VITE_SERVER_URL
RUN npm --prefix frontend run build

FROM nginx:alpine
COPY --from=build /repo/frontend/dist /usr/share/nginx/html
EXPOSE 80
