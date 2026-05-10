# Memory Service

An AI agent memory layer that ingests conversation turns, extracts structured
facts about users, and answers natural-language recall queries. Drop it in
front of any LLM to give it persistent, cross-session memory.

The default config is **the optimal Recall@K config** measured against the
project's test corpora — every feature with measurable binary gain (or
essentially-free cost) is on. Features with zero measured Recall@K gain on
those corpora (LLM reranker, HyDE, derived behavioural memories,
pre-extraction turn rewriting) live in the codebase as opt-in escape hatches:
disabled by default, enabled per-request when a specific workload (precision@1,
high vocabulary mismatch, behavioural enrichment) measurably benefits.

See [CHANGELOG.md](./CHANGELOG.md) — *Feature analysis & optimal architecture*
for the per-feature latency / quality-gain table that drove this design.

---

## 1. Architecture

```text
┌──────────────┐
│ POST /turns  │   Two-pass extraction (Sonnet + Haiku, parallel)
└──────┬───────┘   ├─ subject-rule prompt → friend_marco_*, partner_*
       │           ├─ memory_class routing → singleton / accumulating / event
       ▼           └─ contradiction detection (signal-word gated)
┌──────────────┐
│  Voyage AI   │   batch embed all values → normalize L2 → BLOB
│ voyage-3-lite│   per-item retry fallback on mid-batch 429
└──────┬───────┘
       ▼
┌──────────────┐   memories(id, user_id, key, value, type, confidence,
│ bun:sqlite   │              active, supersedes, memory_class, …)
│ + WAL mode   │   embeddings(id, memory_id, vector BLOB)
│ Docker vol   │   memory_associations(source_id, target_id, strength)
└──────┬───────┘   derived_memories(insight, category, reinforcement_count)
       ▲
       │ in-process Map cache, invalidated on every write
       │
┌──────┴───────┐   1. cache lookup (active memories only)
│ POST /recall │   2. temporal? → expand pool with superseded
└──────┬───────┘   3. aggregation? → bypass RRF, return all keyed memories
       │           4. embed query → BM25 + cosine → RRF (k=60)
       ▼           5. precision floor → return "" if no real match
   context +       6. (opt-in) rewrite, rerank, HyDE, entities, graph, derived
   citations       7. tier-1 (identity) + tier-2 → token-budget greedy fill

┌────────────────────────┐
│ DELETE /sessions/:id   │   ├─ snapshot user_id
└────────────────────────┘   ├─ deleteSession(turns + memories + assocs)
                             └─ fire-and-forget consolidation pass
                                  (Haiku reads full transcript, recovers
                                   single-mention cross-turn facts)
```

The pipeline is **synchronous on `/turns`** — extraction + embedding + DB
write all complete before the 201 returns, so memories are queryable on the
next call. Recall is **multi-stage** with explicit per-stage timing in the
response body so callers can see exactly which phase costs what. The lean
default skips every optional LLM-augmented stage; clients opt back in
per-request when their workload needs precision@1, vocabulary-mismatch
fallback, or behavioural enrichment.

---

## 2. Backing store choice

**SQLite (bun:sqlite, WAL mode, Docker named volume).**

| Concern              | SQLite (chosen)                                                              | Postgres + pgvector                          | Redis                            |
| -------------------- | ---------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------- |
| Infra to operate     | Zero — single file in `/app/data/`                                           | Server, connection pool, migrations          | Server, eviction policy          |
| Persistence          | Docker named volume                                                          | PV / managed RDS                             | RDB snapshot / AOF               |
| Vector search        | In-memory cosine over Float32 BLOBs (sufficient for hundreds–thousands)      | pgvector ANN                                 | Vector module / RediSearch       |
| Concurrent reads     | WAL mode — readers don't block writers                                       | MVCC                                         | Single-threaded                  |
| Atomicity            | `db.transaction()` wraps multi-step writes                                   | BEGIN / COMMIT                               | MULTI / EXEC                     |
| Container image cost | 95 MB (Bun + SQLite built in)                                                | Separate container + driver                  | Separate container               |
| Eval-scale fit       | ✓ thousands of memories per user, sub-50 ms recall                           | Overkill                                     | No persistence guarantees needed |

The decision is driven by **operational simplicity** for the eval target.
At ~10 k memories per user, swap in `sqlite-vec` for ANN. At horizontal
scale, migrate to Postgres + pgvector — the schema (active flag, supersedes
pointer, memory_class, embedding BLOB) maps directly. The HTTP contract
holds across the migration. See *Scaling path* below.

Vectors are **L2-normalized at encode time** so dot product = cosine
similarity. Stored as Float32 BLOBs (8 bytes per dim × 1024 dims = 8 KB
per memory). All cosine search runs in-memory — no `sqlite-vec` extension
needed at this scale.

---

## 3. Extraction pipeline

`POST /turns` runs **synchronously** — the 201 response is the contract that
memories are queryable.

### What we extract

Two LLM passes fire in parallel (`Promise.all`):

- **Explicit pass** — Sonnet (`claude-sonnet-4-6`). Extracts directly stated
  facts using a canonical key list (`employer`, `location`, `role`, `diet`,
  `pet_name`, `opinion_typescript`, `preference_communication`, …). Subject-rule
  prompt block: facts about other people get prefixed keys
  (`friend_marco_*`, `partner_*`, `sister_*`) — never the user's identity keys.
- **Implicit pass** — Haiku (`claude-haiku-4-5-20251001`). Extracts inferences
  not directly stated ("walking Biscuit" → `pet_name: has a dog named
  Biscuit`) and corrections ("I meant Notion, not Stripe").

Each extracted memory carries:

```ts
{ id, user_id, session_id, turn_id,
  type: "fact" | "preference" | "opinion" | "event",
  key: "snake_case_key",
  value: "descriptive phrase, never raw quote",
  confidence: 0.0-1.0,
  implicit: boolean,
  active: boolean,
  supersedes: string | null,
  memory_class: "singleton" | "accumulating" | "event",
  created_at, updated_at }
```

### Memory class routing

Three behavioural buckets at insert time:

- **Singleton** (`employer`, `location`, `diet`) — supersede previous active
  value (existing record `active=0`, new record's `supersedes` field points
  to the old id).
- **Accumulating** (`hobby`, `skill`, `language`, `pet_name`) — coexist with
  value-similarity dedup (word-overlap > 0.75 → skip insert as duplicate).
  Fixes the v2-era bug where a second hobby silently superseded the first.
- **Event** (`job_change`, `marriage`, `relocation`) — always insert, never
  supersede. Events are timestamped occurrences, not mutable facts.

### Contradiction detection

When the raw turn text contains a signal word (`quit`, `no longer`, `actually`,
`switched`, `divorced`, …), Haiku judges which existing memories are
invalidated by what the user just said. Catches cases exact-key supersession
misses (e.g. "I quit my job" produces no new `employer` key but should still
deactivate the old one).

Cheap-gated: ~90% of turns don't contain a signal word, so the Haiku call is
a no-op for them.

### Embedding

After extraction, all memory values are **batch-embedded** with Voyage AI
(`voyage-3-lite`, `input_type: "document"`) in a single API call. Per-item
retry fallback if the batch returns fewer items than requested
(handles mid-batch 429 from older Voyage tiers).

### Cross-turn cleanup — session consolidation

Per-turn extraction sees a 3-turn context window — single-mention implicit
facts that span turn boundaries get dropped. `consolidateSession()` runs a
Haiku pass over the **full session transcript** and recovers them. Wired two
ways:

- **Fire-and-forget** inside `DELETE /sessions/:sessionId` (after a `user_id`
  snapshot, so consolidated memories survive the cascade delete as
  user-attributed records with an orphaned session_id).
- **Manual trigger** via `POST /sessions/:sessionId/consolidate` for testing
  and on-demand cleanup.

### What we miss and why

- **Multi-session implicit reasoning** — patterns that only become clear
  across many sessions (e.g. "user always asks for code before docs over 6
  months") aren't surfaced unless `ENABLE_DERIVED=1` turns on the derived
  behavioural layer.
- **Long-session context overflow** — `consolidateSession` is unbounded by
  turn count; sessions > ~20 turns risk exceeding Haiku's context window.
  Should chunk; not implemented.
- **Behavioural inference without trigger words** — "I grab an oat milk
  flat white every morning" doesn't contain "prefer" / "drink" / "coffee",
  so the per-turn implicit pass misses the preference. Recovered by
  consolidation, but a single-turn user without a session-end trigger keeps
  only `morning_routine`.
- **Emotional / affective state** — the derived layer's `emotional_state`
  category is intentionally low-confidence (0.4-0.6 by prompt rule) and
  excluded from RRF boosts. We surface the signal but don't act on it.
- **Long-term decay calibration** — half-lives for opinion / event /
  preference / habit are intuition-derived, not learned from retention
  data. Production calibration needs a "was this memory still correct when
  recalled?" signal we don't collect.

---

## 4. Recall strategy

`POST /recall` runs in stages, each with its own timing in the response body.

### End-to-end flow

```text
1. Cache lookup       → active memories (Map, invalidated on every write)
2. Temporal detect    → if "used to" / "before" / "previously", expand pool
                        with superseded memories (0.7× confidence penalty)
3. Aggregation detect → if "all/list/every <key-prefix>", BYPASS RRF and
                        return every key-matching memory chronologically
                        (the ~426× latency win for set queries)
4. Embed query        → primaryVec (always succeeds) + rewrite variants
                        (best-effort, 5s timeout)
5. BM25 score         → token-exact across all query variants, keep highest
                        per memory; track `originalMaxBm25` for floor
6. Cosine score       → dot product (vectors pre-normalized); track
                        `originalMaxCosine` for floor
7. Precision floor    → if originalMaxBm25 == 0 AND originalMaxCosine < 0.55,
                        return {"context": "", "citations": []}
                        (short-circuits all LLM-augmented stages on noise)
8. RRF fusion         → 1/(60 + rank + 1) summed across BM25 + cosine
9. Opt-in expansions  → entity hop / graph traversal / derived boost
10. Confidence × decay → weighted = rrf × confidence^1.0 × 0.5^(days/half_life)
11. Recency tiebreaker → +0.002 × 0.5^(days/30) for non-fact types
12. Opt-in rerank     → Haiku scores top-10 candidates 1-5
13. Tier split        → identity-keyed memories → tier-1; rest → tier-2
14. Token-budget fill → greedy from tier-1, then tier-2; truncate last line
                        if it would overflow
15. Format            → ## Known facts about this user / ## Relevant memories
                        / ## Opinion history (when superseded chain exists)
16. Optional prepend  → ## User profile (only if derived layer is enabled)
```

### Ranking logic

The composite score that drives ordering after stage 11:

```text
final = RRF(BM25_rank, cosine_rank)              // k=60
      × confidence^CONFIDENCE_WEIGHT             // CW = 1.0 (linear)
      × 0.5^(days_since_updated / half_life)     // by memory.type
      + 0.002 × 0.5^(days_since_updated / 30)    // recency tiebreaker
      + entity_hop_boosts (when enabled)
      + graph_activation × 0.012 (when enabled)
      + derived_source_boost (when enabled)
```

Half-lives: `opinion 30d`, `event 14d`, `preference 90d`, `habit 60d`,
`fact ∞` (supersession handles fact staleness — no decay).

### Token-budget priority logic

Default budget is `max_tokens = 1024`. Reserved overhead is 60 tokens for
section headers. The fill order is **strict priority**:

1. **Tier-1 (identity facts)** — memories whose key is in
   `IDENTITY_KEYS` (`employer`, `location`, `role`, `diet`, `pet_name`,
   `pet_type`, `relationship_status`, `health_condition`) AND
   `BM25 > 0 OR cosine > effectiveGate(memory)`. `effectiveGate` is
   `COSINE_GATE - 0.05` for facts, `COSINE_GATE` otherwise.
   `COSINE_GATE = 0.40` for users with ≤ 20 memories, `0.45` above
   (calibrated to the noise floor density at scale).
2. **Tier-2 (other relevant memories)** — same gate, non-identity keys.
3. **Opinion-history arc** (when an opinion is in tier-1 or tier-2) —
   appended after tier-2 if room.
4. **Derived `## User profile`** (when `ENABLE_DERIVED=1` + `disable_derived:
   false`) — pre-charged at up to 20% of `max_tokens` BEFORE tier fill, so
   identity facts never get displaced.

### When budget is tight

Greedy fill from tier-1 first, then tier-2. The line that would overflow
gets **word-truncated** with a `[truncated]` suffix only if at least 20
tokens remain — otherwise dropped entirely. Citations record the
**pre-truncation** snippet (first 120 chars of the original value), so the
caller can fetch the full record via `GET /users/:id/memories` if needed.

This guarantees: identity facts win every tie, partial information beats no
information when the partial is meaningful, and the `citations` list is
always a faithful audit trail regardless of how the context string was
truncated.

### Default vs opt-in latency

| Default          | Typical latency | What runs                                                                                                |
| ---------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| Default (no flags) | ~1.5–2.5 s    | BM25 + cosine + RRF + rewriter + graph + entities + temporal + aggregation + precision floor + confidence/decay + tier fill |
| All opt-ins on   | ~5–7 s          | + HyDE + reranker + derived (improves precision@1, behavioural profile, vocabulary-mismatch fallback)    |

Per-request overrides — all default to the *optimal Recall@K config*. Pass
the flag in the `/recall` body to flip any individual feature.

| Flag                  | Default     | Effect when `true`                                                                |
| --------------------- | ----------- | --------------------------------------------------------------------------------- |
| `disable_rewrite`     | `false`     | Skip Haiku query-rewrite (~460 ms saved; -2 hits on vocab-mismatch probes)        |
| `disable_graph`       | `false`     | Skip spreading-activation graph traversal (~3 ms; loses sparse-graph multi-hop)   |
| `disable_entities`    | `false`     | Skip multi-hop entity extraction (~800 ms; loses cross-memory entity-bridge hops) |
| `disable_temporal`    | `false`     | Skip "what did I used to" → superseded-memory expansion                           |
| `disable_aggregation` | `false`     | Skip "all/list/every" RRF bypass (forces full pipeline on set queries)            |
| `disable_bm25`        | `false`     | Cosine-only retrieval (used by `scripts/version_metrics.ts` for v1 simulation)    |
| `disable_rerank`      | **`true`**  | LLM reranker on top-10 — pass `false` for precision@1 / MRR-sensitive workloads (~+1210 ms) |
| `disable_hyde`        | **`true`**  | HyDE hypothetical-document embedding — pass `false` for high vocab-mismatch corpora (~+1.3-1.9 s) |
| `disable_derived`     | **`true`**  | `## User profile` behavioural section — pass `false` (and set `ENABLE_DERIVED=1`) for non-factual workloads |

---

## 5. Fact evolution

When a new memory has the same `(user_id, key)` as an existing active
**singleton** memory, the old record is marked `active=0` (superseded)
before the new one is inserted. Superseded records are **never deleted** —
they remain inspectable via `GET /users/:userId/memories` with
`active: false` and a `supersedes` field pointing to the previous version.

Three resolution paths cover three patterns:

| Pattern                  | Mechanism                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Direct fact updates      | Exact-key supersession ("I moved to Berlin" after "I live in NYC" → `location` superseded)                      |
| Implicit contradictions  | Haiku-judged supersession when the new turn contains a signal word ("I quit my job" deactivates old `employer`) |
| Accumulating types       | Hobby / skill / language coexist; value-similarity dedup; never supersede                                       |

For **historical queries** ("what did I used to think about X"), the
temporal detector pulls superseded memories back into the candidate pool
with a 0.7× confidence penalty so active facts still outrank them on equal
RRF scores.

For **opinion arcs** (one stance evolving across multiple updates), recall
walks the supersedes chain when an opinion appears in tier-1 or tier-2 and
appends a chronological `## Opinion history` section:

```text
## Opinion history
  [2024-03-01] loves TypeScript, best language for large teams
  [2024-03-15] TypeScript generics are annoying, complexity outweighs benefits
  [2024-03-22] TypeScript is fine for big projects (current)
```

---

## 6. Tradeoffs

**Optimized for:** extraction quality, synchronous correctness on `/turns`,
sub-500 ms `/recall` on the lean default, low operational complexity, full
audit trail (no destructive deletes — supersession preserves history).

### Given up by default (recoverable per-request)

- **Precision@1 ordering** — without the reranker, the most-relevant
  citation may not be position 1. Pass `disable_rerank: false` to opt in
  (~1210 ms cost).
- **Behavioural profile section** — without derived memories,
  `## User profile` doesn't appear in `/recall`. Set `ENABLE_DERIVED=1`
  and pass `disable_derived: false` per-request to opt in.
- **Sparse-graph multi-hop** — without graph or entity extraction, queries
  that require bridging memories with no shared tokens may miss. Pass
  `disable_graph: false, disable_entities: false` for sparse-corpus users.
- **Vocabulary-mismatch fallback** — without HyDE, queries phrased very
  differently from stored memory text may miss. Pass `disable_hyde: false`
  for high-mismatch corpora.
- **Cross-turn pronoun resolution at write time** — without pre-extraction
  turn rewriting, multi-turn pronoun chains can drop facts. Unset
  `DISABLE_TURN_REWRITE` to enable (~1 s cost per `/turns`); session
  consolidation usually catches the same facts at session end.

### Given up architecturally

- **Horizontal scalability** — single SQLite file, single instance.
- **Sub-second `/turns`** — synchronous LLM extraction takes 2-5 s
  (Sonnet + Haiku in parallel).
- **Eventual consistency optimizations** — no job queue, no
  fire-and-forget extraction. The spec requires immediate consistency.
- **Calibrated confidence + half-lives** — values are heuristic, not
  learned from retention data.

`COSINE_GATE = 0.40` (0.45 above 20 memories) calibrated empirically against
`voyage-3-lite`: unrelated English sentences score 0.26-0.28; relevant
memories score 0.40+. The 0.12 margin makes the gate stable.
`PRECISION_FLOOR_COSINE = 0.55` is the additional guard that short-circuits
noise queries.

---

## 7. Failure modes

| Scenario                               | Behaviour                                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Cold session (no memories)**         | `/recall` returns `{"context":"","citations":[]}` — never errors                                                       |
| **No data for user**                   | Tier fetch returns `[]`; recall short-circuits with empty context after 1 ms                                            |
| **Missing `ANTHROPIC_API_KEY`**        | `/turns` returns 201, extraction catches error and returns empty memory list. Turn is persisted; `/recall` empty.       |
| **Missing `VOYAGE_API_KEY`**           | Memories extracted but not embedded. `/recall` falls back to BM25-only (cosine map empty); reduced quality, never crashes |
| **Voyage rate limit**                  | `batchEmbedAndStore` retries with exponential backoff (21s/42s/63s); per-item fallback on mid-batch 429                  |
| **Slow disk / SQLite I/O contention**  | WAL mode lets readers continue while writer blocks; `db.transaction()` is atomic — no partial state                    |
| **Container restart mid-write**        | SQLite WAL + transactions guarantee atomicity; incomplete transactions roll back on restart                            |
| **Container restart between writes**   | Named volume `memory_data` persists; in-process Map cache rebuilds on first read after restart                          |
| **Malformed input (bad JSON, oversize content, missing fields)** | Zod returns 400 *before* any DB or LLM call; `payloadSizeMiddleware` returns 413 above 1 MB              |
| **Unknown route**                      | 404 with JSON body `{"error":"not found"}` — never crashes                                                              |
| **LLM hallucinates JSON-with-markdown**| `parseMemories()` strips ` ```json ` fences; JSON parse failures return `[]` and log; no crash                          |
| **HyDE meta-refusal**                  | Defensive regex catches "I don't / sorry / unfortunately" responses, degrades to non-HyDE retrieval                    |
| **Single user makes parallel `/turns`**| Each turn extracted independently; SQLite serializes writes; no lost writes verified in stress test                     |
| **DELETE on never-existed session/user**| Idempotent — returns 204 regardless                                                                                    |

The global `app.onError` handler catches anything that escapes a route's
own `try/catch` and returns 500 with `{"error":"internal error"}` —
service stays up.

---

## 8. How to run the tests

### Fast (stub embedder — ~3 minutes)

```bash
bun run test:fast
```

Spins up the container with `EMBED_STUB=1` (deterministic hash-based
embedder, zero Voyage API calls). LLM extraction still uses real Claude.
Current baseline: **91 pass / 2 fail**. The 2 known failures need real
Voyage embeddings (graph edge formation + supersedes-row-shape test).

### Full (real embeddings)

```bash
docker compose up --build -d
bun test
```

### Restart-persistence test (gated, opt-in)

```bash
STRESS_RUN_RESTART=1 bun test tests/test_stress.test.ts -t "restart persistence"
```

Verifies that data survives a `docker compose restart memory`. Gated
because it would interfere with parallel test execution.

### Recall-quality fixture

`fixtures/conversations.json` — 4 scripted conversations × 2 turns + 7 probes.
Loaded by `tests/test_fixture.test.ts` which prints a quality metric after
running every probe:

```text
[fixture] recall quality: 6/7 probes hit (86%) — mode=stub
```

### Test files

| File                        | Purpose                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `tests/test_contract.test.ts` | Per-route contract tests — 200/201/204/400/401/404/413 status codes  |
| `tests/test_stress.test.ts`   | Comprehensive stress suite — extraction, ranking, persistence, concurrency, malformed input |
| `tests/test_graph.test.ts`    | Spreading-activation graph behaviour (requires real Voyage)          |
| `tests/test_fixture.test.ts`  | Loads `fixtures/conversations.json`, runs probes, reports quality metric |

---

## Setup

### Prerequisites

- Docker + Docker Compose
- Anthropic API key (`claude-sonnet-4-6` and `claude-haiku-4-5-20251001`)
- Voyage AI API key (`voyage-3-lite`, free tier available at voyageai.com)

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
VOYAGE_API_KEY=pa-...
DB_PATH=/app/data/memory.db
# MEMORY_AUTH_TOKEN=your-secret   # optional: Bearer auth on all routes
# ENABLE_DERIVED=1                # optional: turn on derived-memory pipeline
```

### Start

```bash
docker compose up --build -d
```

Service starts on `http://localhost:8080`. Hit `GET /health` to confirm.

### Interactive API explorer

`http://localhost:8080/docs` — Swagger UI with example request bodies for
every route.

---

## Usage examples

### Ingest a turn

```bash
curl -X POST http://localhost:8080/turns \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "sess-1",
    "user_id":    "user-1",
    "messages":   [{"role":"user","content":"I live in Berlin and work at Notion as a PM."}],
    "timestamp":  "2024-01-15T10:30:00Z"
  }'
# → {"id": "550e8400-..."}
```

### Recall — lean default

```bash
curl -X POST http://localhost:8080/recall \
  -H "Content-Type: application/json" \
  -d '{
    "query":      "where does the user live",
    "session_id": "sess-1",
    "user_id":    "user-1"
  }'
# → < 500 ms typical (BM25 + cosine + RRF + rewriter)
```

### Recall — opt into the precision pipeline

```bash
curl -X POST http://localhost:8080/recall \
  -d '{"query":"...","user_id":"user-1","session_id":"x",
       "disable_rerank": false,
       "disable_graph": false, "disable_entities": false,
       "disable_hyde": false, "disable_derived": false}'
# → +1.2s rerank, +1.3-1.9s HyDE, +0.8s entities, etc.
```

### Aggregation query — automatically detected, RRF bypassed

```bash
curl -X POST http://localhost:8080/recall \
  -d '{"query":"what are all the user'\''s hobbies?","user_id":"user-1","session_id":"x"}'
# → returns every hobby-prefixed memory; ~15ms vs ~6s with full pipeline
```

### Historical query — superseded memories surface

```bash
curl -X POST http://localhost:8080/recall \
  -d '{"query":"what did the user used to do for work?","user_id":"user-1","session_id":"x"}'
# → temporal signal "used to" detected; superseded employer values added
```

### Manually trigger session consolidation

```bash
curl -X POST http://localhost:8080/sessions/sess-1/consolidate
```

### Inspect raw memories (active + superseded)

```bash
curl http://localhost:8080/users/user-1/memories
```

### Delete

```bash
curl -X DELETE http://localhost:8080/sessions/sess-1   # cascades to memories
curl -X DELETE http://localhost:8080/users/user-1      # all data for the user
```

---

## Scaling path

**Current (eval scale):** SQLite adjacency list for the memory graph,
in-memory cosine over all user memories, in-process Map caches. Handles
hundreds of memories per user with sub-500 ms recall on the lean default.

**At ~10 k memories per user:** Replace in-memory cosine scan with
sqlite-vec ANN. Edge building switches from exhaustive pairwise to ANN
candidate search. The `POST /graph/:userId/rebuild` endpoint triggers a
full reindex.

**At production scale:**

- Migrate `memory_associations` to Neo4j. The adjacency-list schema maps
  directly to a property graph; Cypher replaces the BFS in `graph.ts`.
  PageRank becomes available for ranking memories by network centrality
  — a better signal than RRF position for long-lived users with dense
  memory graphs.
- Replace SQLite with Postgres + pgvector for ANN search and horizontal
  scaling.
- The HTTP contract and extraction pipeline are unchanged — only the
  storage and retrieval layers swap out.

---

## Environment variables

| Variable                | Required   | Default     | Description                                                                  |
| ----------------------- | ---------- | ----------- | ---------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`     | Yes        | —           | Used for extraction (Sonnet) + recall (Haiku)                                |
| `VOYAGE_API_KEY`        | Yes (prod) | —           | Used for document and query embeddings                                       |
| `DB_PATH`               | Yes        | —           | Must be `/app/data/memory.db` inside Docker                                  |
| `MEMORY_AUTH_TOKEN`     | No         | —           | If set, all routes require `Authorization: Bearer <token>`                   |
| `EMBED_STUB`            | No         | —           | `1` enables the deterministic hash-based stub embedder (testing)             |
| `ENABLE_DERIVED`        | No         | unset (off) | `1` enables the background derivation pipeline (~3 s per /turns)             |
| `DISABLE_TURN_REWRITE`  | No         | `1` (off)   | `1` disables pre-extraction Haiku rewriting; unset/empty re-enables (~1 s/turn) |
| `PRECISION_FLOOR_COSINE`| No         | `0.55`      | Cosine threshold below which `/recall` returns `""` on noise queries         |
