# syntax=docker/dockerfile:1
#
# LearnForge Commercial — portable production image.
#
# Runs the same code as the Netlify deployment (static pages + the 15
# /commercial-api handlers) on any container host with PostgreSQL: Northflank,
# Render, Fly, Railway, Docker Swarm, Kubernetes, or a single VM.
#
#   docker build -t learnforge-commercial .
#   docker run -p 8080:8080 \
#     -e DATABASE_URL=postgres://user:pass@host:5432/learnforge \
#     -e PUBLIC_SITE_URL=https://your-domain.example \
#     -e SUPABASE_URL=https://<project>.supabase.co \
#     -e SUPABASE_PUBLISHABLE_KEY=... \
#     -e STRIPE_SECRET_KEY=... \
#     -e STRIPE_WEBHOOK_SECRET=... \
#     -e STRIPE_PRICE_FAMILY=... \
#     -e STRIPE_PRICE_TEACHER=... \
#     learnforge-commercial
#
# Node 22.18+ is required: the unchanged netlify/functions/*.mts handlers are
# executed through Node's native TypeScript support.

FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app

# Dependencies first for layer caching. `pg` is the only runtime dependency the
# portable API path needs.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Only public assets are copied into the image: no release archives, no tests,
# no CI configuration. The static allow-list in runtime/router.mjs enforces the
# same boundary at request time.
COPY index.html pricing.html auth.html support.html privacy.html terms.html commercial-config.js ./
COPY netlify ./netlify
COPY runtime ./runtime

USER node

EXPOSE 8080

# Liveness probe only (no database access) so a paused/absent database cannot
# restart-loop the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/_runtime/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "runtime/server.mjs"]
