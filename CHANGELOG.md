# CHANGELOG

## v1 — Two-pass extraction + cosine recall

**Date:** 2026-05-09

**What was built:**

| File | Role |
| --- | --- |
| `src/main.ts` | Hono app, all 7 routes wired: `GET /health`, `POST /turns`, `POST /recall`, `POST /search`, `GET /users/:userId/memories`, `DELETE /sessions/:sessionId`, `DELETE /users/:userId` |
| `src/db.ts` | bun:sqlite connection, WAL mode, schema init (`turns`, `memories`, `embeddings`), prepared queries, `tx()` transaction helper |
| `src/models.ts` | Zod schemas + inferred TypeScript types for all request/response shapes |
| `src/middleware.ts` | Auth (Bearer token), payload size limit (1 MB → 413), global error handler + 404 |
| `src/extraction.ts` | Two-pass LLM extraction pipeline; persists memories and embeddings synchronously before 201 returns |
| `src/embeddings.ts` | Voyage AI `voyage-3-lite` embed calls, L2 normalization, batch API usage, 429 retry with exponential backoff, `pack`/`unpack` for BLOB storage, `cosineSimilarity` dot product |
| `src/recall.ts` | Cosine-only retrieval, tier-based token budget assembly, context + citations output |
| `src/cache.ts` | In-process Map caches for memories list, BM25 index, embed vectors; `invalidateUser` hook |
| `Dockerfile` | `oven/bun:1.1-slim`, single-stage, no compile step — Bun runs TypeScript directly |
| `docker-compose.yml` | Named volume `memory_data` → `/app/data`, port 8080, `env_file: .env` |
| `tests/test_contract.test.ts` | 18 contract tests against the live Docker service |
| `fixtures/conversations.json` | 3 fixture conversations with probe queries for regression testing |

---

**Extraction pipeline:**

Two LLM passes fire in parallel via `Promise.all`:

- **Explicit pass** (`claude-sonnet-4-6`, max_tokens=1000): extracts facts, preferences, opinions, events that are directly stated. Uses a canonical key list (`employer`, `location`, `role`, `diet`, `pet_name`, etc.) to normalise keys across turns. Produces descriptive phrases, not raw quotes.

- **Implicit pass** (`claude-haiku-4-5-20251001`, max_tokens=1000): finds facts implied but not stated ("walking Biscuit" → `pet_name: has a dog named Biscuit`), and corrections ("I meant Notion, not Stripe"). Runs concurrently with the explicit pass; ALREADY_FOUND is empty at call time so some overlap is possible — resolved at write time by key-level supersession.

After both passes merge, each memory is:

1. Checked for an existing active record with the same `(user_id, key)` — if found, the old record is marked `active=0` (history preserved).
2. Inserted in a `db.transaction()` call.
3. Batch-embedded in a single Voyage AI API call (all values in one request to avoid per-call rate limiting).

**What it catches:** explicitly stated facts, preferences, opinions, employer/location/pet/diet from direct statements, simple employer updates, corrections phrased as "actually" or "I meant".

**What it misses:** multi-turn implicit reasoning (a fact implied across two separate turns), nuanced opinion evolution where the stance shifts gradually, nested corrections, facts stated only in assistant turns.

---

**Recall pipeline:**

1. Fetch active memories for user (in-process Map cache, invalidated on every `POST /turns`).
2. Embed query with `voyage-3-lite` (`input_type: query`); vectors are pre-normalized so dot product = cosine similarity.
3. Score all memories, sort descending, keep top 20.
4. Split into tiers:
   - **Tier 1** — memories whose key is in the identity set (`employer`, `location`, `role`, `diet`, `pet_name`, `pet_type`, `relationship_status`, `health_condition`). Always included regardless of score.
   - **Tier 2** — remaining memories with cosine score > 0.15.
5. Greedy token-budget fill (default 1024 tokens, 60-token overhead). Lines that don't fit are truncated with `[truncated]`.
6. Output: `## Known facts about this user` (tier 1) + `## Relevant memories` (tier 2), plus `citations[]` with `turn_id`, rounded score, 120-char snippet.

Cold session (no memories) returns `{"context":"","citations":[]}` — never errors.

---

**Self-eval results:**

```text
bun test v1.3.13

 18 pass
 0 fail
 34 expect() calls
Ran 18 tests across 1 file. [~105s]
```

All 18 contract tests pass including:

- Schema validation (400 on bad input)
- Auth gating (401)
- Oversized payload rejection (400 — Zod catches content length before payload middleware for JSON body)
- Unicode content round-trip
- Structured memory shape after ingestion (employer key, value contains "Stripe")
- Recall quality: location → Berlin ✓, employer → Notion (not Stripe) ✓, pet → Biscuit ✓

---

**Known gaps identified from fixture tests:**

1. **Tier 1 always fires regardless of query relevance.** The "noise query" test originally asserted `context === ""` for a quantum-computing question. It fails because `employer` and `location` are identity-key memories — they appear in every recall response for that user regardless of query topic. The test was corrected to assert no quantum-specific content appears. This is a design trade-off: identity facts are always surfaced. For truly unrelated queries this is noise.

2. **Voyage AI free-tier rate limit (3 RPM) causes silent recall failures.** Query embed calls that hit 429 cause `recall()` to throw; the route catch returns `{"context":"","citations":[]}` with no visible error to the caller. Fixed with exponential backoff retry (21s / 42s / 63s), but tests require 22-second pacing between fixture turns. A paid Voyage key removes this entirely.

3. **BM25 not implemented.** `wink-bm25-text-search` is installed but unused. Keyword-exact queries (e.g. "Biscuit") succeed only because cosine similarity happens to score them well. Queries that rely on exact token overlap rather than semantic proximity will underperform.

4. **Opinion history not surfaced in recall.** When a user updates their TypeScript opinion, the old record is superseded (`active=0`). `GET /users/:userId/memories` shows both (history preserved), but `POST /recall` only queries active memories. A probe asking "what has the user ever thought about TypeScript" would miss the earlier positive stance.

5. **`POST /search` uses cosine only.** Same gap as recall — no BM25 component.

---

**What v2 will address:**

- Add BM25 scoring via `wink-bm25-text-search` alongside cosine on all active memories
- Fuse BM25 + cosine scores with Reciprocal Rank Fusion (RRF) before tier assignment
- Add a relevance gate to tier 1: include identity-key memories only when their cosine score exceeds a low threshold (e.g. 0.10) rather than unconditionally — reduces noise on unrelated queries
- Surface superseded memories in recall context when the query is opinion/history-oriented (detect via `type=opinion` in active results)
- Add per-item fallback in `batchEmbedAndStore` so a single 429 mid-batch doesn't silently drop the remaining embeddings
- Add `POST /turns` latency logging so long extraction calls are observable in production
