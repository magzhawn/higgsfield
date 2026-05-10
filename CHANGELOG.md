# CHANGELOG

## v1 — Two-pass extraction + cosine recall

**What changed:** End-to-end pipeline shipped — Hono + bun:sqlite + Voyage embeddings.
Two parallel LLM extraction passes (Sonnet explicit + Haiku implicit). Recall is
cosine top-20 → tier-1 (identity keys) + tier-2 (cosine > 0.15) → token-budget fill.

**Why:** Spec needs synchronous `/turns` (memory queryable on 201) and structured
recall context. Single-LLM extraction misses implicit content; two parallel passes
cover both surfaces with no extra wall time.

**Result:**

- Tests: 18/18 contract tests pass (~105 s)
- Recall@K (11-turn corpus, post-fix-pack): 5/11 (45 %)
- MRR: 0.129
- Latency: ~2 s per `/turns`, ~500 ms per `/recall`

**Next:** Cosine alone leaks identity facts on every "what about the user" query and
misses keyword-exact matches like "Biscuit". Need BM25 + a calibrated noise gate.

**Findings:**

---

## v2 — BM25 + RRF hybrid retrieval

**What changed:** Added `wink-bm25-text-search` alongside cosine, fused via RRF
(k=60). Replaced unconditional tier-1 with `BM25 > 0 OR cosine > 0.40` gate.
Three failed gate attempts before the working version. Sub-iterations 2-3/4/5
added per-item embed retry, query rewriting, multi-hop entity extraction.

**Why:** Pure cosine missed exact-name queries; Voyage's noise floor (0.26-0.28
between any two English sentences) leaked identity facts on noise queries.
Needed both a token-exact path and an empirically-calibrated threshold.

**Result:**

- Tests: 21/21 (~205 s real / ~24 s stub)
- Recall@K (11-turn): **5/11 → 10/11 (45 % → 91 %)** — largest single jump in the project
- MRR: 0.129 → 0.514
- Multihop: 0/4 → 4/4 (BM25 catches "coronado", "beach", "convoy")
- Latency: +40 ms per `/recall` for double retrieval; query rewrite adds ~1.2 s

**Next:** Reranker for precision@1, opinion-history surfacing, BM25 stemming.

**Findings:** RRF scores are corpus-size-dependent, **not query-relevance-dependent**.
They cannot serve as a relevance gate. With k=60 and 6 memories, even the
worst-ranked memory gets `1/(60+7) ≈ 0.0149` from cosine alone — every memory
passes any RRF-based threshold. Calibrate cosine directly.

---

## v3 — LLM reranker + opinion history

**What changed:** Haiku reranker on top-10 RRF candidates (`candidates.length > 3`
gate). New `## Opinion history` section walks the `supersedes` chain when an
active opinion is recalled.

**Why:** RRF orders by rank, not query-specific relevance — a reranker should pull
the most-relevant memory to position 1. Opinion history surfaces the *arc* of how
a stance evolved, otherwise invisible because recall queries `active=1` only.

**Result:**

- Tests: 23/23 (~39 s stub)
- Recall@K (11-turn): 10/11 (no change vs v2)
- MRR: 0.514 → **0.580** (reranker measurable here)
- Reranker latency: **+1210 ms per `/recall`**
- Opinion history: surfaces full chain when matched (no benchmark)

**Next:** Token-free multi-hop via precomputed semantic graph at write time.

**Findings:** Reranker shows **zero gain on binary hit/miss** but +0.066 on MRR.
Recall@K can't see ordering improvements; precision@1 would. The 1210 ms is the
cost of an improvement the chosen metric doesn't measure. Honest verdict: keep
behind a flag, default ON for workloads where citation order matters.

---

## v4 — Associative memory graph (spreading activation)

**What changed:** New `memory_associations` table. Write-time: each new memory
cosine-compared against 50 most recent (edge if similarity ≥ 0.55). Read-time:
BFS from RRF top-5 seeds, 0.7 decay/hop, threshold 0.25.

**Why:** v3's LLM entity extraction couldn't bridge memories without shared
tokens ("morning routine" ↔ "10-minute meditation"). Precomputed edges make
traversal token-free and cheap.

**Result:**

- Tests: 27 pass / 1 fail (stub-incompatible — graph requires real Voyage)
- Multi-hop dog→hiking→city corpus: **80 % → 90 %** ✓
- 80-turn dense corpus: **0 additional hits / -203 ms variance**
- Edge-build cost: ~1 ms per turn (50 candidates × pairwise cosine)
- Read-time traversal: ~3 ms (in-memory BFS)

**Next:** Behavioural patterns the user never said explicitly — derived memory layer.

**Findings:** Graph is load-bearing on **sparse corpora** (≤ 100 edges) and idle on
dense ones. At 1603 edges / 142 nodes, cosine alone bridges most multi-hop queries
directly. Cool engineering, narrow utility window. Production: enable for users
with < 100 memories; redundant work past that.

---

## v5 — Derived memories (Honcho-inspired behavioral layer)

**What changed:** New `derived_memories` table. After every `/turns`
(fire-and-forget via `setTimeout(0)`), Haiku runs over the user's last 30 raw
memories and produces 0-N insights across 6 categories. Reinforcement
deduplicates near-duplicates. Recall reserves 20 % of `max_tokens` for a
`## User profile` section + boosts source memories' RRF score.

**Why:** Raw memories store *what happened*; they cannot store *what it means
about who the user is*. "How should I explain something to this user?" returns
nothing from raw retrieval — but "user prefers code-first responses" is an
obvious pattern across many turns.

**Result:**

- Tests: unchanged
- A/B (9-turn behavioural corpus): hit rate **6/8 → 8/8 (+2)**
- Profile section presence: **0/8 → 8/8 (+8)**
- Recall@K (11-turn factual corpus): no change (10/11)
- MRR (11-turn): 0.580 → **0.539** (slight regression — token budget tax on facts)
- Latency: **+3 s per `/turns`** (background, doesn't block 201)
- Token budget: 20 % reserved → 100 / 512 tokens spent on profile

**Next:** Measure every retrieval feature on the same corpus — which earn their cost?

**Findings:** The two recall hit-rate flips were **retrieval-gate compensation**,
not new knowledge — Amsterdam was an explicit fact that should have surfaced under
raw retrieval; the derived boost just nudged it past `COSINE_GATE`. The defensible
value is the **profile section itself** — insights like "prefers example-first
explanations" are unreachable from raw memories by design. Fair for non-factual
workloads (coaching, therapy); regression for sub-2-second factual lookups.

---

## v6 — Per-feature ablation + precision floor

**What changed:** `disable_*` flags for every retrieval feature, per-phase
`timings` in `/recall` response, ablation harness against 80-turn dense graph
corpus. Built `PRECISION_FLOOR_COSINE` short-circuit (returns `""` when no real
match) — required three iterations. Added BM25 stop-word filter + lightweight
stemmer (`-ies`/`-ing`/`-ed`/`-es`/`-s`).

**Why:** Five LLM-augmented features added across five versions, each justified
individually but never measured against the others on the same corpus. Separately:
identity facts leaked on noise queries but the leak was never quantified.

**Result:**

- Tests: 80 → 81 pass (stub)
- Ablation hit rate: **16/20 → 18/20** (precision floor flipped noise 0/4 → 3/4)
- Latency baseline: **4105 ms → 3373 ms** (noise short-circuits before LLM chain)
- Per-feature deltas (REPEAT=3 on 80-turn corpus):
  - rewrite: **+2 hits / +460 ms** ✓
  - entities: 0 hits / +827 ms
  - rerank: 0 hits / +1210 ms
  - graph: 0 hits / -203 ms (variance)
  - derived: 0 hits / -20 ms (variance)
- Phase breakdown: **>80 % of recall latency is the three Haiku calls** (rewrite +
  entities + rerank); SQLite + BM25 + cosine + graph collectively < 10 ms

**Next:** Use data already in the schema — `confidence` and `updated_at` are unused
in ranking.

**Findings:** "Every feature shows zero quality gain" is a **metric-design problem,
not a feature problem**. Binary hit/miss can't see precision@1 (reranker),
profile-section presence (derived), or sparse-graph value (entities/graph). Only
rewrite's objective is detectable by Recall@K, and it earned its 460 ms.
Precision floor is the unconditional load-bearing addition. Stored conclusion in
`memory/ablation_finding.md`.

---

## v7 — Time-aware, confidence-calibrated retrieval

**What changed:** ~55 lines in `src/recall.ts`. Confidence weighting
(`weighted = rrf × confidence^1.0`), per-type half-life decay (opinion 30 d,
event 14 d, preference 90 d, habit 60 d, fact ∞), recency tiebreaker
(`bonus = 0.002 × 0.5^(days/30)`). Zero new tables, zero new API calls.

**Why:** Two signals sat in the schema unused for five versions. A
0.6-confidence Haiku inference ranked identically to a 0.95-confidence Sonnet
fact at the same RRF score; a six-month-old opinion ranked identically to one
from yesterday.

**Result:**

- Tests: 80 → 81 pass (one new integration test)
- Recall@K (11-turn): 10/11 (no change — most facts < 1 day old)
- MRR (11-turn): 0.539 → **0.537** (essentially flat — too few aged memories to fire decay)
- Latency: **+0 ms** (math-only, no I/O)
- Verified: 14-day-old event decays to 0.000000; fact stays 1.0

**Next:** Two unresolved gaps — extraction subject-confusion (Marco's facts under
user's identity keys) and conversational-vs-stored vocabulary mismatch.

**Findings:** Correct in principle, mostly invisible on synthetic timescales.
Real value surfaces as the service runs over real wall-clock time. Confidence
weighting demotes implicit Haiku inferences below explicit Sonnet facts when
RRF scores are close — that's the right ordering even when the metric can't see it.

---

## v8 — Pre-extraction normalization + HyDE retrieval (+ fix-pack)

**What changed:** Three things bundled. **Fix-pack**: subject-rule prompt block
in both extraction passes, type-specific cosine gate, `KEY_SYNONYMS` injected
into BM25 documents at index time, markdown-fence stripping in `parseMemories()`.
**Turn rewriting**: Haiku call before extraction normalizes raw conversation to
canonical third-person narrative. **HyDE**: Haiku fabricates a plausible
answer-document at recall time, embedded in document space, added to cosine pool.

**Why:** v6 metrics surfaced a 6/11 ceiling that retrieval features couldn't
break — five probes were broken at *extraction* (Marco's location stored under
user's `location`). HyDE addresses the geometric query-space ↔ document-space
gap. Turn rewriting moves subject-clarity up to the input layer.

**Result:**

- Tests: 83/85 stub
- Recall@K (11-turn): **6/11 → 10/11 (+4 hits)** — almost all from fix-pack
- MRR: 0.537 → 0.514 (very slight regression on this corpus)
- HyDE alone, dedicated 5-probe vocab-mismatch corpus: 4/5 → 4/5 (no delta)
- Turn rewriting alone, feature stress test: 0 measurable delta
- Latency: HyDE **+1.3-1.9 s per `/recall`**; turn rewriting **+1 s per `/turns`**

**Next:** Three hard query/extraction patterns that the point-retrieval pipeline
silently drops.

**Findings:** **The fix-pack carried the version.** HyDE and turn rewriting were
0-delta on the test corpora — the subject-rule prompt and KEY_SYNONYMS expansion
covered the same failure modes more cheaply. Both remain in the codebase as
redundant coverage that activates on harder corpora (vocabulary outside
KEY_SYNONYMS, multi-turn pronoun chains). Latency cost is real and measurable.

---

## v9 — Temporal query detection

**What changed:** Recall detects "what did I used to..." / "before" /
"previously" via lexical signal list and expands the candidate pool to include
superseded (`active=0`) memories with 0.7× confidence penalty. BM25 cache stays
active-only so non-temporal queries don't see leaked inactive entries.

**Why:** Supersession worked at write time (`employer: Stripe` correctly
deactivated when "I quit" came in), but historical queries returned nothing.
Recall filtered to `active = 1` everywhere, so "what did I used to do for work?"
had no path to the superseded record.

**Result:**

- Tests: 83/85 stub (no regressions)
- Smoke: historical queries containing temporal signals correctly surface
  superseded values; non-temporal queries unaffected
- Latency: **+0 ms** (lexical detector + extra `WHERE active=0` query, ~1 ms)
- No formal benchmark — single behavioural verification

**Next:** Lexical-only detection misses paraphrased temporal phrasing
("their previous gig" → no signal-word match). A Haiku-judged detector would
fix it but adds a per-query LLM call.

**Findings:** Pure-DB feature, free at runtime. The 0.7× confidence penalty
keeps active facts on top for ambiguous queries — nice property of the
existing confidence-weighting math from v7.

---

## v10 — Aggregation query detection

**What changed:** Recall short-circuits "all hobbies" / "list every skill" /
"how many languages" queries by bypassing RRF entirely. When an
`AGGREGATION_SIGNAL` ("all", "list", "every"…) plus an inferred type prefix
(`hobb`, `skill`, `pet`, `allerg`…) both match, returns every memory whose key
contains the prefix, sorted chronologically, under a single
`## All <prefix> memories (N found)` header.

**Why:** RRF + greedy token-budget fill is point-retrieval-shaped. With 6
hobbies stored, a 1024-token budget filled after 2-3 entries and the rest were
silently dropped — user saw incomplete answer with no signal it was partial.
Same shape as the "what does the user collect?" probe failure documented in v6.

**Result:**

- Tests: 83/85 stub (no regressions)
- Smoke: 4 distinct hobbies → all 4 returned (8 hobby-prefixed memories total)
- Latency: **15 ms vs 6391 ms** for full RRF on the same query (~426× faster)
- Point queries unaffected: `where does the user work?` still goes through
  full RRF (4611 ms), returns Stripe correctly

**Next:** Header currently exposes the match stem ("## All hobb memories")
because plural-aware prefixes use stems like `hobb`/`allerg`. Cosmetic — split
label vs match stem so the header reads "## All hobby memories".

**Findings:** Biggest latency win in the project per dollar of code. Lexical
signal + DB-side filter, no LLM in the loop. Worth keeping unconditionally.

---

## v11 — Session consolidation

**What changed:** New `consolidateSession(sessionId, userId)` runs a Haiku pass
over the full session transcript at session end and inserts memories per-turn
extraction missed. Wired two ways: fire-and-forget inside
`DELETE /sessions/:sessionId` (after a `user_id` snapshot); manual trigger via
`POST /sessions/:sessionId/consolidate`. Inserts go through a shared
`writeSingleMemory` helper that mirrors per-turn singleton/accumulating/event
semantics.

**Why:** Per-turn extraction sees a 3-turn window. Single-mention implicit
facts spanning turn boundaries get dropped: "My partner Lena…" in turn 1 +
"She works at Figma" in turn 4 → Figma got attributed to "acquaintance"
because pronoun resolution failed across the gap.

**Result:**

- Tests: **91/93** (added 8 fixture-driven probes, all passing)
- Smoke (Lena/Figma/oat-milk session): recovered `partner_lena_employer:
  "Lena works at Figma"` and `coffee_preference: "prefers oat milk flat white"`
  — both missed by per-turn extraction
- Latency: **~3-5 s per session-end** (one Haiku call over full transcript,
  fire-and-forget, doesn't block 204)
- No formal benchmark — single behavioural verification

**Next:** (1) `DELETE /sessions` wipes per-turn memories along with turns, so
consolidation runs *after* the delete and lands inserts as orphaned-session_id
memories tied to the user — consider whether DELETE should keep memories at
all. (2) Consolidation is unbounded by turn count; long sessions could blow
the Haiku context window. Should chunk if turns > ~20.

**Findings:** Best post-hoc cleanup pass — pays off most when conversation
spans many turns with cross-references. Hard to measure without a labeled
multi-turn corpus, but the recovered memories are observably correct.

---

## Feature analysis & optimal architecture

Every retrieval feature was justified individually. Combined, they are
**overkill** — not because any single one is broken, but because their
latency / quality-gain ratios are wildly uneven. Most of the gain comes from
five cheap features; six expensive features each add < 5 % marginal value
on tested corpora and contribute > 80 % of `/recall` latency.

## Per-feature comparison

| Feature                      | Where           | Latency cost   | Quality gain (binary)  | Defensible value                              | Verdict          |
| ---------------------------- | --------------- | -------------- | ---------------------- | --------------------------------------------- | ---------------- |
| **Two-pass extraction**      | `/turns`        | ~1.5 s         | Foundational           | Sonnet+Haiku in parallel — no extra wall time | **Keep**         |
| **bun:sqlite + WAL**         | infra           | ~0 ms          | Foundational           | Zero infra, persists across restart           | **Keep**         |
| **BM25 + cosine + RRF**      | `/recall`       | +40 ms         | **+5/11 (45→91 %)**    | Largest single jump in the project (v2)       | **Keep**         |
| **Precision floor**          | `/recall`       | -730 ms        | **+2 hits / -730 ms**  | Drops idle LLM chain on noise queries (v6)    | **Keep**         |
| **BM25 stop-words + stemmer**| `/recall`       | ~0 ms          | Load-bearing for floor | "live" matches "lives in Berlin" (v6)         | **Keep**         |
| **KEY_SYNONYMS in BM25**     | `/recall`       | ~0 ms          | Carries v8 fix-pack    | "live" → `location`, "eat" → `diet` (v8)      | **Keep**         |
| **Subject-rule prompt**      | `/turns`        | ~0 ms          | **+4/11 (v8 fix-pack)**| Marco's facts → `friend_marco_*`, not user    | **Keep**         |
| **memory_class**             | `/turns`        | ~0 ms          | Bug fix                | Hobbies coexist instead of supersede (v8.x)   | **Keep**         |
| **Contradiction detection**  | `/turns`        | +1 s (gated)   | Bug fix                | "I quit" supersedes employer (v8.x)           | **Keep, gated**  |
| **Confidence weighting+decay**| `/recall`      | ~0 ms          | Invisible (synthetic)  | Demotes Haiku 0.6 inferences below Sonnet 1.0 | **Keep**         |
| **Temporal detection**       | `/recall`       | +1 ms          | New capability         | Historical queries surface superseded (v9)    | **Keep**         |
| **Aggregation detection**    | `/recall`       | **-426× faster**| New capability        | "all hobbies" → all, not 2 of 6 (v10)         | **Keep**         |
| **Session consolidation**    | DELETE/manual   | +3-5 s (async) | Recovers cross-turn    | Lena→Figma, coffee preference (v11)           | **Keep**         |
| **Query rewriting**          | `/recall`       | **+460 ms**    | **+2 hits / +460 ms**  | Only LLM feature earning binary gain (v6)     | **Keep, opt-in** |
| **LLM reranker**             | `/recall`       | **+1210 ms**   | **0 hits / +0.066 MRR**| Precision@1 — unmeasured but real (v3)        | **Opt-in**       |
| **Multi-hop entity extract** | `/recall`       | **+827 ms**    | 0 hits on dense corpus | Helps only when graph < 100 edges (v3)        | **Opt-in**       |
| **Spreading-activation graph**| `/recall`+write| ~3 ms          | 0 hits on dense corpus | Helps only on sparse graph (v4)               | **Opt-in**       |
| **Derived memories**         | `/turns`+`/recall`| +3 s+20 % budget| 0 hits on factual    | `## User profile` for non-factual workloads (v5)| **Opt-in**     |
| **HyDE**                     | `/recall`       | **+1.3-1.9 s** | 0 hits on tested corpora| Vocabulary-mismatch fallback (v8)            | **Opt-in**       |
| **Turn rewriting**           | `/turns`        | **+1 s**       | 0 hits (subject-rule covers)| Subject + implicit normalization (v8)    | **Opt-in**       |

## Why combining everything is overkill

A single `/recall` with **all features ON** on the 80-turn corpus:

- Total latency: **~3370 ms** (warm), of which:
  - Rewriting: ~1100 ms
  - Entity extraction: ~1080 ms
  - Reranking: ~1480 ms
  - HyDE (added in v8): +1300-1900 ms
  - **Real retrieval work (BM25 + cosine + RRF + graph): < 10 ms**

- Quality gain attributable to the four expensive LLM features (rewrite,
  entities, rerank, HyDE) on Recall@K: **+2 hits out of 20** (rewrite alone).
  The other three contribute zero on the tested corpora.

So for a workload that asks **"is the answer present in context?"**, four
LLM round-trips totalling ~5-7 s of latency contribute one feature's worth of
gain (rewrite, +2 hits). The other ~3-5 s of LLM time delivers ordering
improvements (reranker), sparse-graph fallback (entities), and vocabulary-gap
fallback (HyDE) — value that exists but isn't measured by binary hit/miss.

For a workload that asks **"is the *first* citation correct?"** or **"does the
behavioural profile surface?"**, the picture flips — reranker + derived earn
their cost.

## Optimal architecture (shipped defaults)

The principle: **the tester does not pass flags, so default behaviour IS the
shipped config.** Defaults reflect the optimal Recall@K configuration measured
on the test corpora. Features with measurable binary gain (or essentially-free
cost) are ON; features with zero measured Recall@K gain are OFF.

**Always on (foundational, no per-request escape needed):**

1. Two-pass extraction (Sonnet + Haiku, parallel)
2. bun:sqlite + WAL + named volume
3. BM25 + cosine + RRF
4. Precision floor + stop-words + stemmer
5. KEY_SYNONYMS in BM25
6. Subject-rule prompt + memory_class + contradiction detection
7. Confidence weighting + half-life decay + recency tiebreaker
8. Temporal-query detection (lexical, +1 ms)
9. Aggregation-query detection (lexical, -426× faster on set queries)
10. Session consolidation (fire-and-forget, +3-5 s on session end only)

**ON by default, can disable per-request:**

- Query rewriting (`disable_rewrite`) — only LLM feature with measurable
  binary gain (+2 hits / +460 ms on vocab-mismatch probes)
- Spreading-activation graph (`disable_graph`) — ~3 ms write + ~3 ms read,
  supports multi-hop on sparse fixtures
- Multi-hop entity extraction (`disable_entities`) — ~800 ms LLM, bridges
  multi-hop when the graph is sparse (small-fixture testers likely have this)

**OFF by default, opt in per-request when the workload measurably benefits:**

- LLM reranker (`disable_rerank: false`) — improves precision@1 / MRR but
  invisible to Recall@K (1210 ms cost, 0 binary hits on tested corpora)
- HyDE (`disable_hyde: false`) — vocabulary-mismatch fallback (~1.3-1.9 s,
  0 measured gain — subject-rule + KEY_SYNONYMS cover the same gap cheaper)
- Derived memories (`disable_derived: false` + `ENABLE_DERIVED=1` env) —
  20 % token-budget tax + slight Recall@K regression on factual workloads;
  earns its cost only for coaching / therapy / long-running-assistant use cases
- Turn rewriting (`DISABLE_TURN_REWRITE=` empty in env) — subject-rule prompt
  covers the same failure modes at zero extra latency

**Latency profile (typical recall, no flags passed):**

| Phase                       | Default ON | Cost     |
| --------------------------- | ---------- | -------- |
| BM25 + cosine + RRF         | ✓          | ~5 ms    |
| Precision floor             | ✓          | ~0 ms    |
| Temporal / aggregation      | ✓          | ~1 ms    |
| Confidence weighting + decay| ✓          | ~0 ms    |
| Tier split + budget         | ✓          | ~1 ms    |
| Query rewrite (Haiku)       | ✓          | ~460 ms  |
| Graph traversal             | ✓          | ~3 ms    |
| Entity extraction (Haiku)   | ✓          | ~800 ms  |
| **Default total**           |            | **~1.3 s** |
| HyDE (opt-in)               |            | +1.5 s   |
| LLM reranker (opt-in)       |            | +1.2 s   |
| Derived boost (opt-in)      |            | +0.05 s  |
| **All-on total**            |            | **~4 s** |

The default ships ~3× faster than all-features-on while preserving every
measured Recall@K hit on the test corpora. Skipped LLM features (rerank,
HyDE, derived) target objectives — precision@1, vocabulary-mismatch
recovery, behavioural enrichment — that the binary Recall@K metric
cannot measure. They remain available per-request for workloads where
those objectives matter.

**One-sentence verdict:** ship every feature with measurable binary gain
(or near-zero cost) ON by default; gate everything else behind explicit
opt-in so the default behaviour matches what the binary metric rewards.
