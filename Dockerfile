# Superatom project backend (+ its frontend bundle) as one image.
# Built per project by docker-compose.yml; see the usage notes there.

ARG NODE_VERSION=24

# ─── Build: install every package the backend compiles against, then build ───
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

# Manifests first so dependency layers are reused when only source changes.
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml frontend/
COPY backend/package.json backend/pnpm-lock.yaml backend/pnpm-workspace.yaml backend/.npmrc backend/
COPY database/postgres/package.json database/postgres/pnpm-lock.yaml database/postgres/pnpm-workspace.yaml database/postgres/
COPY database/chromadb/package.json database/chromadb/pnpm-lock.yaml database/chromadb/pnpm-workspace.yaml database/chromadb/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    for dir in frontend backend database/postgres database/chromadb; do \
      (cd "$dir" && pnpm install --frozen-lockfile) || exit 1; \
    done

COPY . .
# backend's tsc also compiles database/{postgres,chromadb}/src into backend/dist.
RUN cd frontend && pnpm build && cd ../backend && pnpm build

# ─── Runtime ───
FROM node:${NODE_VERSION}-bookworm-slim
# python3: SQL rewrite worker (backend/sqlrewrite, sqlglot is vendored).
# postgresql-client: readiness check + project_details row in the entrypoint.
# curl + jq: the coding agent's tools (backend/agent-tools/common) call the script bridge with them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 postgresql-client ca-certificates curl jq tini \
 && rm -rf /var/lib/apt/lists/*

# A tool missing its binary fails silently at a user's first question, so fail the build instead.
RUN for c in curl jq node python3 psql sed awk tr cut; do \
      command -v "$c" > /dev/null || { echo "missing in the runtime image: $c"; exit 1; }; \
    done

# Codex CLI for the coding-agent answer flow (the default; SA_ANSWER_FLOW=agents opts out).
# >= 0.156 is required: older codex has no metadata for the default model and the API refuses it.
ARG CODEX_VERSION=0.156.1
RUN npm install -g @openai/codex@${CODEX_VERSION} && npm cache clean --force

ENV NODE_ENV=production
WORKDIR /app/backend
COPY --from=build --chown=node:node /app/backend /app/backend
COPY --from=build --chown=node:node /app/database/postgres /app/database/postgres
COPY --from=build --chown=node:node /app/frontend/dist /app/frontend/dist
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/sa-entrypoint

# The app writes logs into its working dir; volume mount points are owned by
# `node` so the named volumes inherit it.
RUN mkdir -p duckdb uploads scripts-store tmp state \
 && chown node:node . duckdb uploads scripts-store tmp state

USER node
ENTRYPOINT ["tini", "--", "sa-entrypoint"]
CMD ["node", "dist/backend/src/app.js"]
