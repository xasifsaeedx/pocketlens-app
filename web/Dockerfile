# PocketLens web app — multi-stage: Vite build → nginx serving the static bundle.
# Build context: web/
#
# The VITE_* values are baked in at build time, so pass them as build args:
#   docker build -t pocketlens-web \
#     --build-arg VITE_SUPABASE_URL=https://your-project.supabase.co \
#     --build-arg VITE_SUPABASE_ANON_KEY=your-anon-key \
#     --build-arg VITE_BACKEND_URL=https://your-api.example.com \
#     --build-arg VITE_API_BASE_URL=https://your-api.example.com \
#     web

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_BACKEND_URL
ARG VITE_API_BASE_URL
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_BACKEND_URL=$VITE_BACKEND_URL \
    VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run build

# ── Serve stage ──────────────────────────────────────────────────────────────
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
