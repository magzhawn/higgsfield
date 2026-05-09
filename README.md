# Memory Service

An AI agent memory layer that ingests conversation turns, extracts structured facts about users, and answers natural-language recall queries. Drop it in front of any LLM to give it persistent, cross-session memory.

## Architecture

```text
POST /turns  →  LLM extraction  →  SQLite + embeddings
POST /recall →  BM25 + cosine   →  RRF fusion → context string
```

### Ingestion pipeline

When a turn is posted, the service runs two LLM extraction passes in parallel:

- **Explicit pass** (`claude-sonnet-4-6`) — extracts facts that are directly stated: location, employer, role, diet, pets, opinions.
- **Implicit pass** (`claude-haiku-4-5-20251001`) — finds facts implied rather than stated ("Walking Biscuit this morning" → `pet_name: has a dog named Biscuit`), and detects corrections across turns.

Both passes use a canonical key list so the same concept always gets the same key name regardless of how it's phrased. New memories supersede old ones with the same `(user_id, key)` — the previous value is preserved with `active=0` for audit, not deleted.

After extraction, all memory values are batch-embedded with Voyage AI (`voyage-3-lite`) and stored as normalized Float32 BLOBs in SQLite. The entire pipeline is **synchronous** — a `201` response means memories are immediately queryable.

### Retrieval pipeline

`POST /recall` runs in five steps:

1. **Query rewriting** — Haiku generates 2 alternative phrasings to catch vocabulary mismatches (e.g. "occupation" → "job title / employer").
2. **BM25 scoring** — token-exact match across all query variants. Handles proper nouns and technical terms that cosine might score weakly.
3. **Cosine scoring** — dot product between query and memory embeddings (pre-normalized, so dot product = cosine similarity).
4. **RRF fusion** — Reciprocal Rank Fusion (k=60) combines both ranked lists into a single score.
5. **Multi-hop expansion** — Haiku extracts named entities from the top results, then cosine-searches for connected memories. This bridges facts with no direct textual link (e.g. a pet name query that implies a city).

Memories that pass the gate (`BM25 > 0 OR cosine > 0.40`) are assembled into a token-budgeted context string. Identity-key facts (employer, location, etc.) surface in `## Known facts about this user`; other relevant memories go in `## Relevant memories`.

### Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Bun | `bun:sqlite` built-in removes native addon compilation; TypeScript runs natively; 95 MB Docker image |
| Framework | Hono + `@hono/zod-validator` | Typed request validation, fast, minimal |
| Database | SQLite (WAL mode) | Zero infra, Docker volume persistence, sufficient for eval scale |
| Embeddings | Voyage AI `voyage-3-lite` | No Anthropic embeddings API; better retrieval quality than OpenAI embeddings; free tier available |
| LLM | Anthropic Claude (Sonnet + Haiku) | Sonnet for high-quality extraction; Haiku for speed-sensitive rewriting and entity extraction |
| Cache | In-process `Map` | Single instance; no network hop; Map invalidated on every write |

## Setup

### Prerequisites

- Docker and Docker Compose
- An Anthropic API key (`claude-sonnet-4-6` and `claude-haiku-4-5-20251001`)
- A Voyage AI API key (`voyage-3-lite`, free tier available at voyageai.com)

### Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
VOYAGE_API_KEY=pa-...
DB_PATH=/app/data/memory.db
# MEMORY_AUTH_TOKEN=your-secret   # optional: enables Bearer token auth on all routes
```

### Start the service

```bash
docker compose up --build -d
```

The service starts on `http://localhost:8080`. Check `GET /health` to confirm it is up.

### Interactive API explorer

Open `http://localhost:8080/docs` in a browser for the Swagger UI. All routes have example request bodies you can send directly from the UI.

## Usage

### Ingest a conversation turn

```bash
curl -X POST http://localhost:8080/turns \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "sess-1",
    "user_id":    "user-1",
    "messages": [
      {"role": "user", "content": "I live in Berlin and work at Notion as a product manager."}
    ],
    "timestamp": "2024-01-15T10:30:00Z"
  }'
# → {"id": "550e8400-..."}
```

The call blocks until extraction and embedding are complete (~2–10 s depending on LLM latency). The returned `id` is the turn ID.

### Recall memories for a query

```bash
curl -X POST http://localhost:8080/recall \
  -H "Content-Type: application/json" \
  -d '{
    "query":      "where does the user live",
    "session_id": "sess-1",
    "user_id":    "user-1"
  }'
# → {
#     "context":   "## Known facts about this user\n- [2024-01-15] location: lives in Berlin",
#     "citations": [{"turn_id": "550e8400-...", "score": 0.0328, "snippet": "lives in Berlin"}]
#   }
```

Paste `context` directly into your LLM system prompt. Empty `context` means no relevant memories were found — the LLM continues without hallucinating facts.

### Inspect raw memories

```bash
curl http://localhost:8080/users/user-1/memories
```

Returns all memories for the user including superseded (`active: false`) ones so you can inspect the full history.

### Delete a session or user

```bash
curl -X DELETE http://localhost:8080/sessions/sess-1
curl -X DELETE http://localhost:8080/users/user-1
```

Both cascade to turns, memories, and embeddings.

## Testing

### Fast (stub embedder — ~24 seconds)

```bash
bun run test:fast
```

Spins up the container with `EMBED_STUB=1`, which replaces Voyage AI with a deterministic hash-based embedder. All 21 contract tests pass. No Voyage API calls. LLM extraction still uses the real Claude API.

Use this for development iteration.

### Full (real embeddings — ~11 minutes)

```bash
docker compose up --build -d
bun test
```

Uses real Voyage embeddings. Subject to the free-tier rate limit (3 RPM). Use this before shipping to validate end-to-end retrieval quality.

## Fact evolution

When a new memory has the same canonical key as an existing active memory for the same user, the old record is marked `active=0` (superseded) before the new one is inserted. The superseded record is never deleted — it remains inspectable via `GET /users/:userId/memories` with `active: false` and a `supersedes` field pointing to the record it replaced.

This handles:

- Direct fact updates ("I moved to Berlin" after "I live in NYC")
- Explicit corrections ("actually I meant Notion, not Stripe")
- Role changes, location moves, opinion updates

The supersession chain is inspectable end-to-end: each memory's `supersedes` field points to the previous version's `id`.

## Tradeoffs

**Optimized for:** extraction quality, synchronous correctness, and low operational complexity.

**Given up:**

- Horizontal scalability — single SQLite file, single instance
- Sub-second `/turns` latency — synchronous LLM extraction takes 2–10 s
- Perfect implicit fact recall — multi-turn inference not implemented
- Opinion history in recall — superseded opinions invisible to queries (stored in DB, not surfaced unless explicitly queried)

`COSINE_GATE = 0.40` was calibrated empirically against Voyage `voyage-3-lite` vectors. Unrelated English sentences score 0.26–0.28; relevant memories score 0.40+. The 0.12 margin makes the gate stable.

## Scaling path

**Current (eval scale):** SQLite adjacency list for the memory graph, in-memory cosine search for vector retrieval, in-process Map caches. Handles hundreds of memories per user with sub-second recall latency on a paid embedding API.

**At ~10k memories per user:** Replace in-memory cosine scan with sqlite-vec ANN indexing. Edge building switches from exhaustive pairwise to approximate nearest neighbor. The `/graph/:userId/rebuild` endpoint triggers a full reindex.

**At production scale:**

- Migrate `memory_associations` to Neo4j. The adjacency list schema maps directly to a property graph. Cypher replaces the BFS implementation in `graph.ts`. PageRank becomes available for ranking memories by network centrality — a better signal than RRF position for long-lived users with dense memory graphs.
- Replace SQLite with Postgres + pgvector for ANN search and horizontal scaling.
- The HTTP contract and extraction pipeline are unchanged — only the storage and retrieval layers swap out.

## Failure modes

**Missing `ANTHROPIC_API_KEY`:** `/turns` returns 201 but with no extracted memories (extraction catches the error and returns an empty array). The turn is persisted. `/recall` returns empty context.

**Missing `VOYAGE_API_KEY`:** Memories are extracted but not embedded. `/recall` returns empty context because the embeddings JOIN finds nothing. Service stays up.

**Voyage rate limit (free tier: 3 RPM):** `batchEmbedAndStore` retries with exponential backoff (21 s / 42 s / 63 s). `/turns` blocks until embeddings succeed or retries are exhausted.

**Container restart mid-write:** SQLite WAL mode + `db.transaction()` guarantees atomicity. Incomplete transactions are rolled back on restart. No partial state.

**Cold session (no memories):** `/recall` returns `{"context":"","citations":[]}` — never errors.

**Malformed input:** Zod validation returns 400 before any DB or LLM calls execute. Service never crashes on bad input.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes | — | Used for extraction (Sonnet) and recall (Haiku) |
| `VOYAGE_API_KEY` | Yes (prod) | — | Used for document and query embeddings |
| `DB_PATH` | Yes | — | Must be `/app/data/memory.db` inside Docker |
| `MEMORY_AUTH_TOKEN` | No | — | If set, all routes require `Authorization: Bearer <token>` |
| `EMBED_STUB` | No | — | Set to `1` to enable the hash-based stub embedder (testing only) |
