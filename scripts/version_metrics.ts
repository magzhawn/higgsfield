#!/usr/bin/env bun
/**
 * Version metrics simulator.
 *
 * Ingests the inline corpus once, then probes each version's recall
 * behavior by toggling the disable_* flags on /recall to simulate which
 * features were active at each version. Reports Recall@K and MRR per
 * version, plus per-type breakdowns (direct / multihop / behavioral)
 * and per-probe pass/fail tables.
 *
 * Self-contained — corpus and probes are copied from feature_ablation.ts
 * rather than imported, so this script can be run in isolation.
 *
 * Usage:
 *   bun run scripts/version_metrics.ts
 *   VOYAGE_PAID=1 bun run scripts/version_metrics.ts   # 500 ms pacing
 *   BASE=http://localhost:8080 bun run scripts/version_metrics.ts
 *
 * Note: v5 and v6 use identical flags because confidence weighting and
 * memory decay are always-on inside recall.ts (no per-request kill switch).
 * The two rows will produce identical numbers — that fidelity is intentional.
 * To genuinely A/B v5 vs v6 the recall.ts file would need a new env-var
 * or request-flag gate around CONFIDENCE_WEIGHT / DECAY_ENABLED.
 */

const BASE = process.env.BASE ?? "http://localhost:8080"
const USER = `version-metrics-${Date.now()}`
const SESSION = "version-corpus"
// Sleep between probes: 500 ms on paid Voyage, 22 s on free tier (3 RPM).
const PROBE_SLEEP_MS = process.env.VOYAGE_PAID ? 500 : 22000

// ─── Corpus + probes (copied verbatim from feature_ablation.ts) ──────────────

interface Turn {
  content: string
  ts: string
}

interface Probe {
  query: string
  expect: string[]
  type: "direct" | "multihop" | "behavioral"
}

const INLINE_CORPUS: Turn[] = [
  // identity / multi-hop chain (graph_compare)
  { content: "I have a Welsh Corgi named Pickle. She's the love of my life.",                                ts: "2025-01-01T09:00:00Z" },
  { content: "I take Pickle to Coronado Beach every Saturday morning for a long walk.",                     ts: "2025-01-02T09:00:00Z" },
  { content: "I live in San Diego, California. The weather here is perfect year-round.",                    ts: "2025-01-03T09:00:00Z" },
  { content: "I work at Qualcomm as a chip architect. The main campus is in Sorrento Valley.",              ts: "2025-01-04T09:00:00Z" },
  { content: "I'm a vegetarian. I love the taco shops along Convoy Street.",                                ts: "2025-01-05T09:00:00Z" },
  { content: "On weekends I surf at Pacific Beach with my friend Marco.",                                   ts: "2025-01-06T09:00:00Z" },
  { content: "Marco runs an indie game studio called Tidepool in La Jolla.",                                ts: "2025-01-07T09:00:00Z" },
  // behavioral / derived signals (derived_compare)
  { content: "Skip the theory, just show me a working example of async/await vs promises.",                 ts: "2025-01-08T09:00:00Z" },
  { content: "Don't explain what a database index is. Just show me the SQL to add one to a users table.",   ts: "2025-01-09T09:00:00Z" },
  { content: "Quick answer only — what are the top 3 things to check when DB queries are slow?",            ts: "2025-01-10T09:00:00Z" },
  { content: "I'm preparing our system for a 10x traffic spike next month — caching and horizontal scale.", ts: "2025-01-11T09:00:00Z" },
]

const INLINE_PROBES: Probe[] = [
  // Direct
  { query: "where does the user live?",              expect: ["san diego"],                    type: "direct" },
  { query: "what is the user's dog's name?",         expect: ["pickle"],                       type: "direct" },
  { query: "where does the user work?",              expect: ["qualcomm"],                     type: "direct" },
  { query: "what is the user's diet?",               expect: ["vegetarian"],                   type: "direct" },

  // Multihop
  { query: "what city does the user's dog live in?", expect: ["san diego"],                    type: "multihop" },
  { query: "where does the dog go for walks?",       expect: ["coronado", "beach"],            type: "multihop" },
  { query: "what does the user's friend Marco do?",  expect: ["game", "tidepool", "studio"],   type: "multihop" },
  { query: "where does the user eat tacos?",         expect: ["convoy", "san diego"],          type: "multihop" },

  // Behavioral
  { query: "how should I explain something to this user?",   expect: ["code", "example", "direct"],          type: "behavioral" },
  { query: "does this user prefer theory or practice?",      expect: ["practice", "code", "example"],        type: "behavioral" },
  { query: "what is the user preparing for at work?",        expect: ["scaling", "traffic", "spike", "10x"], type: "behavioral" },
]

// ─── Version configurations ──────────────────────────────────────────────────
// Each version flips on the features that existed at that point in the
// project's history; later features are disabled via the per-request flags.

interface VersionConfig {
  name: string
  flags: {
    disable_rewrite?: boolean
    disable_entities?: boolean
    disable_rerank?: boolean
    disable_graph?: boolean
    disable_derived?: boolean
    disable_bm25?: boolean
  }
}

const VERSIONS: VersionConfig[] = [
  {
    name: "v1 (cosine-only, no BM25, no rerank)",
    // disable_bm25 (added post-v6) lets us genuinely simulate v1 instead
    // of falling back to v2's BM25+RRF. With BM25 off, RRF degrades to
    // cosine-only ranking and the precision floor depends entirely on
    // originalMaxCosine < PRECISION_FLOOR_COSINE.
    flags: { disable_bm25: true, disable_rewrite: true, disable_entities: true, disable_graph: true, disable_rerank: true, disable_derived: true },
  },
  {
    name: "v2 (BM25 + RRF, noise gate)",
    flags: { disable_rewrite: true, disable_entities: true, disable_graph: true, disable_rerank: true, disable_derived: true },
  },
  {
    name: "v3 (+ query rewrite + reranker)",
    flags: { disable_graph: true, disable_derived: true },
  },
  {
    name: "v4 (+ spreading activation graph)",
    flags: { disable_derived: true },
  },
  {
    name: "v5 (+ derived memories)",
    flags: {},
  },
  {
    name: "v6 (+ confidence weighting + decay)",
    // Identical flags to v5 — confidence weighting + decay are always-on
    // inside recall.ts. The numbers will match v5; see header comment.
    flags: {},
  },
]

// ─── HTTP plumbing ───────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Citation { turn_id: string; score: number; snippet: string }
interface RecallResponse { context: string; citations: Citation[] }

async function ingest(t: Turn): Promise<void> {
  const r = await fetch(`${BASE}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: SESSION,
      user_id: USER,
      messages: [{ role: "user", content: t.content }],
      timestamp: t.ts,
      metadata: {},
    }),
  })
  if (!r.ok) throw new Error(`ingest failed: ${r.status} ${await r.text()}`)
}

async function probeRecall(query: string, flags: VersionConfig["flags"]): Promise<RecallResponse> {
  const r = await fetch(`${BASE}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      session_id: "version-probe",
      user_id: USER,
      max_tokens: 1024,
      ...flags,
    }),
  })
  const body = (await r.json()) as Partial<RecallResponse>
  return { context: body.context ?? "", citations: body.citations ?? [] }
}

const hitsAny = (text: string, terms: string[]): boolean => {
  const lower = text.toLowerCase()
  return terms.some((t) => lower.includes(t.toLowerCase()))
}

// First citation index (1-indexed) whose snippet contains any expected term.
// Returns Infinity when no citation matches — reciprocal rank then = 0.
function firstMatchingRank(citations: Citation[], expect: string[]): number {
  for (let i = 0; i < citations.length; i++) {
    if (hitsAny(citations[i].snippet, expect)) return i + 1
  }
  return Infinity
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

interface ProbeResult {
  probe: Probe
  hit: boolean
  rank: number
  reciprocalRank: number
}

interface VersionResult {
  config: VersionConfig
  probeResults: ProbeResult[]
  hits: number
  total: number
  mrr: number
  byType: Record<string, { hits: number; total: number }>
}

async function runVersion(config: VersionConfig): Promise<VersionResult> {
  const probeResults: ProbeResult[] = []
  for (const p of INLINE_PROBES) {
    const res = await probeRecall(p.query, config.flags)
    const hit = hitsAny(res.context, p.expect)
    const rank = firstMatchingRank(res.citations, p.expect)
    probeResults.push({
      probe: p,
      hit,
      rank,
      reciprocalRank: rank === Infinity ? 0 : 1 / rank,
    })
    await sleep(PROBE_SLEEP_MS)
  }

  const hits = probeResults.filter((r) => r.hit).length
  const total = probeResults.length
  const mrr = probeResults.reduce((s, r) => s + r.reciprocalRank, 0) / total
  const byType: Record<string, { hits: number; total: number }> = {
    direct: { hits: 0, total: 0 },
    multihop: { hits: 0, total: 0 },
    behavioral: { hits: 0, total: 0 },
  }
  for (const r of probeResults) {
    const b = byType[r.probe.type]
    if (!b) continue
    b.total += 1
    if (r.hit) b.hits += 1
  }
  return { config, probeResults, hits, total, mrr, byType }
}

function pad(s: string, n: number, align: "left" | "right" = "left"): string {
  if (s.length >= n) return s.slice(0, n)
  return align === "left" ? s + " ".repeat(n - s.length) : " ".repeat(n - s.length) + s
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const health = await fetch(`${BASE}/health`).catch(() => null)
  if (!health || !health.ok) {
    console.error(`Service unreachable at ${BASE}`)
    process.exit(1)
  }

  console.log("════════════════════════════════════════════════════")
  console.log("  Version Recall Metrics")
  console.log("════════════════════════════════════════════════════")
  console.log(`  Service:     ${BASE}`)
  console.log(`  User:        ${USER}`)
  console.log(`  Probe sleep: ${PROBE_SLEEP_MS}ms`)
  console.log()

  // Phase 1 — ingest the corpus once
  console.log(`Phase 1: ingest ${INLINE_CORPUS.length} turns (one-time)`)
  const ingestStart = performance.now()
  for (let i = 0; i < INLINE_CORPUS.length; i++) {
    const t0 = performance.now()
    await ingest(INLINE_CORPUS[i])
    const elapsed = performance.now() - t0
    console.log(`  [${i + 1}/${INLINE_CORPUS.length}] ${elapsed.toFixed(0)}ms — ${INLINE_CORPUS[i].content.slice(0, 60)}…`)
    if (i < INLINE_CORPUS.length - 1) await sleep(500)
  }
  console.log(`Total ingest: ${((performance.now() - ingestStart) / 1000).toFixed(1)}s`)
  console.log()

  // Wait for derivation pipeline
  console.log("Waiting 8s for background derivation pipeline…")
  await sleep(8000)
  console.log()

  // Phase 2 — run each version
  const results: VersionResult[] = []
  for (const cfg of VERSIONS) {
    console.log(`════════════════════════════════════════════════════`)
    console.log(`  ${cfg.name}`)
    console.log(`════════════════════════════════════════════════════`)
    console.log(`  flags: ${JSON.stringify(cfg.flags)}`)
    const r = await runVersion(cfg)
    results.push(r)

    console.log()
    console.log("  Per-probe breakdown:")
    console.log(`  ${pad("Type", 11)} ${pad("Hit", 4)} ${pad("Rank", 5)} Query`)
    console.log("  " + "─".repeat(80))
    for (const pr of r.probeResults) {
      const rankStr = pr.rank === Infinity ? "—" : String(pr.rank)
      const hitStr = pr.hit ? "✓" : "✗"
      console.log(`  ${pad(pr.probe.type, 11)} ${pad(hitStr, 4)} ${pad(rankStr, 5)} ${pr.probe.query.slice(0, 60)}`)
    }
    console.log()
    console.log(`  Recall@K: ${r.hits}/${r.total} (${((r.hits / r.total) * 100).toFixed(0)}%)   MRR: ${r.mrr.toFixed(3)}`)
    console.log()
  }

  // Phase 3 — summary table
  console.log("════════════════════════════════════════════════════════════════════════════════════════════════")
  console.log("  Summary — all versions side-by-side")
  console.log("════════════════════════════════════════════════════════════════════════════════════════════════")
  console.log()
  console.log(
    pad("Version", 45) +
    pad("Recall@K", 12) +
    pad("MRR", 8) +
    pad("Direct", 8) +
    pad("Multihop", 10) +
    pad("Behavioral", 11)
  )
  console.log("─".repeat(94))
  for (const r of results) {
    const recall = `${r.hits}/${r.total}  ${((r.hits / r.total) * 100).toFixed(0)}%`
    const mrr = r.mrr.toFixed(3)
    const d = `${r.byType.direct.hits}/${r.byType.direct.total}`
    const m = `${r.byType.multihop.hits}/${r.byType.multihop.total}`
    const b = `${r.byType.behavioral.hits}/${r.byType.behavioral.total}`
    console.log(
      pad(r.config.name, 45) +
      pad(recall, 12) +
      pad(mrr, 8) +
      pad(d, 8) +
      pad(m, 10) +
      pad(b, 11)
    )
  }

  console.log()
  console.log("Cleaning up test user…")
  await fetch(`${BASE}/users/${USER}`, { method: "DELETE" })
  console.log("Done.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
