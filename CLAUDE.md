# Memory Service — Agent Brief

## Project

AI agent memory service. Ingests conversation turns, extracts structured
memories via LLM, answers recall queries with hybrid retrieval.
Built for a technical hiring eval — correctness and code quality are graded.

## Stack

- Runtime: Bun (NOT Node)
- Framework: Hono + @hono/zod-validator
- Database: bun:sqlite (built-in — NOT better-sqlite3, different API)
- LLMs: @anthropic-ai/sdk for text generation, voyageai for embeddings
- Validation: Zod
- Tests: bun test

## Project structure

memory-service/
├── CLAUDE.md
├── CHANGELOG.md
├── README.md
├── docker-compose.yml
├── Dockerfile
├── package.json
├── bun.lockb
├── .env.example
├── src/
│   ├── main.ts          → Hono app + all 7 routes, nothing else
│   ├── db.ts            → bun:sqlite connection, schema, prepared queries
│   ├── models.ts        → Zod schemas + inferred TS types
│   ├── extraction.ts    → LLM extraction pipeline
│   ├── embeddings.ts    → Voyage AI calls + vector math + embed cache
│   ├── recall.ts        → BM25 + cosine + RRF + context assembly
│   └── cache.ts         → in-process Map caches, invalidation
├── tests/
│   ├── test_contract.ts
│   └── test_persistence.ts
└── fixtures/
    └── conversations.json

## Non-negotiable constraints

### Synchronous correctness

POST /turns MUST be synchronous. Memories must be queryable immediately
after 201 returns. Never fire-and-forget extraction. Never use job queues.
The spec gives 60s timeout — use it for inline synchronous extraction.

### bun:sqlite API (not better-sqlite3)

// CORRECT
import { Database } from "bun:sqlite"
const db = new Database(path, { create: true })
const stmt = db.query("SELECT * FROM foo WHERE id = $id")
stmt.all({ $id: "123" })
stmt.get({ $id: "123" })
db.run("PRAGMA journal_mode=WAL")
db.transaction(fn)()

// WRONG — this is better-sqlite3, do not use
const stmt = db.prepare(...)
stmt.run(...)

### Error handling

- Bad input → 4xx via Zod validation, never 500
- LLM failure → log + return [] memories, do not crash /turns
- Empty store → return {"context":"","citations":[]}, never error on cold session
- Every route has try/catch
- Global app.onError catches anything that escapes

### Docker volume

DB_PATH must be /app/data/memory.db — inside the named volume mount.
Never /tmp, never relative paths, never outside /app/data/.

### Memory extraction rule

Never store raw message text as a memory value.
Always extract structured descriptive phrases.
BAD:  value = "I just started at Notion last week"
GOOD: value = "works at Notion, started recently"

### Vectors

Stored as BLOB (Float32Array → Buffer) in embeddings table.
Normalized at encode time so dot product = cosine similarity.
Cosine search runs in-memory — no sqlite-vec extension needed.

## Current build state

[x] Session 1 — Docker infrastructure
[x] Session 2 — Database schema
[x] Session 3 — Models + middleware + route stubs
[ ] Session 4 — Embeddings
[x] Session 5 — Extraction
[x] Session 6 — Recall + cache + wire-up
[x] Session 7 — Tests + fixtures
[ ] Session 8 — CHANGELOG v1

Update this checklist as sessions complete.

## Env vars

ANTHROPIC_API_KEY  — Claude Sonnet (extraction) + Claude Haiku (reranking)
VOYAGE_API_KEY     — embeddings, model voyage-3-lite
DB_PATH            — /app/data/memory.db
MEMORY_AUTH_TOKEN  — optional, if set validates Bearer token on all requests

## Key design decisions (defend these in README)

- Bun over Node: bun:sqlite built-in removes native addon compilation,
  TypeScript runs natively, 95MB Docker image vs 160MB
- Single SQLite file over Postgres/Redis: zero infra, persists via Docker
  volume, sufficient for eval scale, WAL mode handles concurrent reads
- Voyage AI for embeddings: Anthropic has no embeddings API,
  voyage-3-lite free tier, better retrieval quality than OpenAI embeddings
- In-process Map cache over Redis: single instance, Map is faster
  (no network hop), Redis solves multi-instance problems we don't have
- Synchronous extraction over job queue: spec requires immediate
  consistency, 60s timeout is sufficient for inline LLM calls
- Two-pass extraction: explicit pass (Sonnet) + implicit pass (Haiku)
  in parallel via Promise.all — quality + speed balanced

## Session discipline

- Complete one session fully before starting the next
- Run the verification step at the end of each session
- If verification fails, fix it before moving on
- Never skip the CHANGELOG entry — write it while the session is fresh

## v2 build state

[x] Session 1 — v1 completed
[x] Session 2-1 — Noise fix + latency logging
[x] Session 2-2 — BM25 + RRF
[ ] Session 2-3 — Batch embedding fallback
[ ] Session 2-4 — Query rewriting
[x] Session 2-5 — Multi-hop retrieval
[x] Session 2-6 — Tests + fixture updates + CHANGELOG

## What NOT to touch in v2

- Extraction architecture (two-pass parallel) — working, don't refactor
- Transaction pattern in db.ts — working
- Supersession logic in extraction.ts — working
- Tier budget assembly structure — extending, not replacing
- All 18 existing contract tests — must still pass after every session

## v6 build state

[x] Per-request feature toggles (`disable_rewrite`/`disable_entities`/`disable_rerank` in models.ts + main.ts)
[x] Per-phase timings in `/recall` response (recall.ts)
[x] `scripts/feature_ablation.ts` with fixture loading + warmup + REPEAT majority voting
[x] `fixtures/graph_stress_corpus.json` (80 turns, 20 probes, 4 types)
[x] Voyage rate-limit pacing removed from all scripts (paid 2000 RPM tier)
[x] Precision floor in recall.ts Step 3d (PRECISION_FLOOR_COSINE, env-tunable)
[x] BM25 stop-word filter + lightweight stemmer in cache.ts
[x] CHANGELOG v6 entry written with corrected interpretation (measurement vs feature design)
[x] Verification: `EMBED_STUB=1 bun test` matches v6-prep baseline (80 pass / 4 known stub-incompatible fails — same as before v6 changes; zero regressions introduced)

## Things explicitly NOT in v6 (acknowledged, not addressed)

- Two probe failures in `feature_ablation.ts` (`what does the user collect?`, `what movie did the user watch last weekend?`) — extraction-vocabulary gap and threshold-calibration case respectively, not retrieval-pipeline gaps. Documented in CHANGELOG v6.
- A more comprehensive ablation that measures precision@1 (reranker), profile-section presence (derived), sparse-graph corpus (entities). Listed as "what a better ablation would measure" in CHANGELOG v6 — out of scope for this iteration.
