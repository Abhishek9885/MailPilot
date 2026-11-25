# Engineering setup and pinned versions

This scaffold uses exact direct dependency pins and committed lockfiles to keep local and CI installs repeatable. Versions below are the selected stable versions for this implementation; update them deliberately with a lockfile refresh and the full quality suite.

## Runtime baseline

| Tool | Version/policy | Reason |
|---|---|---|
| Node.js | `>=22.13 <23`; CI/Render pin `.node-version` at `22.23.5` | Current Node 22 line, supported by the selected ESLint 10 and Prisma 7 toolchain. |
| npm | `>=10.9 <12` | npm workspaces and lockfile v3; version 10.9 is present in the inspected environment. |
| Python | `>=3.12,<3.13` | Reproducible interpreter line; current environment is Python 3.12.10. |
| uv | 0.12.18 (developer tooling baseline) | Creates the Python environment and installs the fully pinned Python graph from `uv.lock`. |
| PostgreSQL | `pgvector/pgvector:0.8.7-pg17` | PostgreSQL 17 with pgvector 0.8.7, pinned to the extension release required by iterative HNSW scans. Pin an image digest for deployment. |
| Redis | `redis:7.4.12-alpine` | Local BullMQ transport with AOF persistence and `noeviction`; use a managed, authenticated Redis service in production. |

## Local infrastructure and startup

Docker Compose runs PostgreSQL and Redis. PostgreSQL binds host port `55432`; Redis binds `56379`, both on loopback, and both persist data in Compose-managed volumes. From the repository root, copy `.env.example` to `.env`, install dependencies with `npm ci` and `uv sync --project apps/ai --locked`, then run `npm run db:up`. Wait for both containers to report healthy before running `npm run db:generate` and `npm run db:deploy`.

Start all four local processes with `npm run dev:all`, or use `npm run dev:web`, `npm run dev:api`, `npm run dev:worker`, and `npm run dev:ai` in separate terminals. Docker supplies PostgreSQL and Redis. The full startup and troubleshooting steps are in the root [README](../README.md).

## JavaScript direct versions

The root `package.json` pins shared tooling: TypeScript 5.9.3, Vitest 4.1.12, ESLint 10.15.0, `typescript-eslint` 8.74.0, `globals` 16.4.0, Prisma CLI 7.10.1, tsx 4.20.6, dotenv 16.6.1, dotenv-cli 8.0.0, and concurrently 9.2.5. It also overrides Prisma 7.10.1's exact transitive Effect pin to 3.22.2 to apply the npm-reported ReDoS fix without downgrading Prisma.

| Workspace | Pinned direct versions |
|---|---|
| `apps/web` | Next.js 16.4.6, React/React DOM 19.3.0, Tailwind CSS and PostCSS plugin 4.1.17, `eslint-config-next` 16.4.6 |
| `apps/api` | Express 5.2.1, Prisma Client and PostgreSQL adapter 7.10.1, `pg` 8.16.3, Pino 9.9.0, `openid-client` 6.8.8, BullMQ 6.7.8, ioredis 6.0.0 |
| `packages/shared` | Zod 4.6.7 |
| Tooling | TypeScript 5.9.3, Vitest 4.1.12, ESLint 10.15.0, `typescript-eslint` 8.74.0, Prisma CLI 7.10.1, tsx 4.20.6 |

Prisma 8 is intentionally not selected because its release status is release candidate on the implementation date. Prisma 7 remains the stable supported line; its PostgreSQL setup uses a driver adapter and a generated `prisma-client` output path. See [Prisma ORM release status](https://www.prisma.io/docs/orm/release-status) and the [Prisma 7 PostgreSQL quickstart](https://www.prisma.io/docs/v7/prisma-orm/quickstart/postgresql).

## Python direct versions

`apps/ai/pyproject.toml` pins FastAPI 0.143.0, Uvicorn 0.35.0, Pydantic 2.12.5, pydantic-settings 2.10.1, HTTPX 0.28.1 (runtime model transport and test client), scikit-learn 1.9.1, joblib 1.6.0, NumPy 2.5.5, and SciPy 1.18.1 (the versioned TF-IDF/logistic-regression baseline and evaluation), LangGraph 1.2.22 (read-only RAG StateGraph), tiktoken 0.14.0 (exact embedding input-token limits), psycopg 3.2.10, structlog 25.4.0, pytest 8.4.2, Ruff 0.14.4, and mypy 1.18.2. `uv.lock` pins all transitive dependencies and hashes.

FastAPI 0.143.0 is the stable release shown in its official release notes on 2026-10-08. The OpenAI Responses adapter uses the provider-neutral HTTPX transport; no provider-specific SDK is installed.

## Dependency upgrade process

1. Change exact pins and regenerate `package-lock.json` or `uv.lock`.
2. Review changelogs and peer/runtime requirements before committing the lockfile.
3. Run lint, typecheck, tests, build, Prisma validation, and health checks.
4. Update this version inventory and the tested Node/Python runtime baseline.

On 2026-10-26, Next.js and `eslint-config-next` were updated from 16.4.0 to 16.4.1. On 2026-11-25 they were updated to 16.4.6 for the November security release. The same release refreshed ESLint to 10.15.0 and `typescript-eslint` to 8.74.0; `package.json` pins Effect 3.22.2 because Prisma 7.10.1 pins the vulnerable 3.20.0 transitively. Both full and production `npm audit` report zero vulnerabilities. See the [official Next.js November security release](https://nextjs.org/blog/november-2026-security-release).

Prisma ORM and its PostgreSQL adapter were updated from 7.10.0 to 7.10.1; Zod was updated from 4.1.12 to 4.6.7. The Prisma [7.10.1 release](https://github.com/prisma/orm/releases/tag/7.10.1) updates dependencies with security advisories, and Zod 4.6.7 is above the affected versions reported by npm audit. Lockfile-only transitive updates also address the reported `body-parser` and `fast-uri` advisories.

Vitest was updated from 3.2.4 to 4.1.12 to use a release with the current mocker security fixes; concurrently was updated from 9.2.1 to 9.2.5 to pick up its patched `shell-quote` dependency. See the [Vitest 4.1.12 release](https://github.com/vitest-dev/vitest/releases/tag/v4.1.12) and the [concurrently 9.2.5 release](https://github.com/open-cli-tools/concurrently/releases/tag/v9.2.5).

On 2026-10-28, `openid-client` 6.8.8 was added for the Express Google OpenID Connect authorization-code flow, including state, nonce, PKCE, and ID-token validation. The Google Auth Library Node.js repository was archived in 2025, so the maintained OpenID Connect client is used for app identity. See the [`openid-client` 6.8.8 release](https://github.com/panva/openid-client/releases/tag/v6.8.8) and [Google OpenID Connect claims guidance](https://developers.google.com/identity/openid-connect/reference).

On 2026-11-06, `tiktoken` 0.14.0 was added so the embedding adapter can enforce the selected model's input token limits before sending text to the provider. See the [OpenAI tiktoken release](https://github.com/openai/tiktoken/releases/tag/0.14.0).

On 2026-11-15, LangGraph 1.2.22 was added for the typed read-only RAG StateGraph and conditional evidence routing. On 2026-11-18, `langgraph-checkpoint-postgres` 3.2.1 and `psycopg-pool` 3.3.3 were added for persistent checkpoints and cross-process run locks. See the [LangGraph Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api), [LangGraph persistence guide](https://docs.langchain.com/oss/python/langgraph/persistence), [LangGraph Postgres checkpointer](https://pypi.org/project/langgraph-checkpoint-postgres/3.2.1/), and [1.2.22 package release](https://pypi.org/project/langgraph/1.2.22/).

On 2026-11-19, scikit-learn 1.9.1, joblib 1.6.0, NumPy 2.5.5, and SciPy 1.18.1 were added for the synthetic email classification baseline and evaluation. Training and inference use the same pinned versions because joblib artifacts are pickle-based and are not supported across arbitrary scikit-learn versions. See [scikit-learn model persistence guidance](https://scikit-learn.org/stable/model_persistence.html), [scikit-learn 1.9.1](https://pypi.org/project/scikit-learn/1.9.1/), and [joblib 1.6.0](https://pypi.org/project/joblib/1.6.0/).

On 2026-11-06, the local PostgreSQL image was pinned from the moving `pg17` tag to `pgvector/pgvector:0.8.7-pg17` for reproducible HNSW iterative scans. See the [official pgvector version/tag list](https://github.com/pgvector/pgvector#additional-installation-methods).

On 2026-11-22, BullMQ 6.7.8 and ioredis 6.0.0 were added for Node-side Gmail sync jobs; Redis 7.4.12-alpine is used locally. Jobs use bounded exponential backoff, stable IDs, and PostgreSQL checkpoints/outbox rows. See [BullMQ retries](https://docs.bullmq.io/guide/retrying-failing-jobs), [BullMQ graceful shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown), [BullMQ Redis connections](https://docs.bullmq.io/guide/connections), and [Redis eviction policies](https://redis.io/docs/latest/reference/eviction/).
