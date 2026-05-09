#!/usr/bin/env bun
/**
 * Per-feature latency vs quality ablation.
 *
 * Ingests a combined corpus (graph multi-hop fixtures + derived behavioral
 * corpus), then probes each query under N configurations:
 *   - baseline: every feature ON
 *   - ablated:  one feature OFF at a time
 *
 * Reports for each feature:
 *   - latency delta (baseline_ms - ablated_ms) = cost of the feature
 *   - quality delta (baseline_hits - ablated_hits) = value of the feature
 *   - quality-per-100ms ratio = bang for buck
 *
 * Also reports per-phase timings from the recall response (rewrite_ms,
 * embed_ms, bm25_ms, cosine_ms, entities_ms, graph_ms, derived_*_ms,
 * rerank_ms) averaged across probes.
 *
 * Usage:
 *   bun run scripts/feature_ablation.ts                           # 11-turn inline corpus
 *   FIXTURE=fixtures/graph_stress_corpus.json bun run scripts/feature_ablation.ts  # 80-turn dense graph corpus
 *   REPEAT=3 bun run scripts/feature_ablation.ts                  # avg N runs per probe
 *   BASE=http://localhost:8080 bun run scripts/feature_ablation.ts
 *
 * Requires real Voyage embeddings. Paid tier (2000 RPM) recommended —
 * the script makes ~500 embed calls during ingest + warmup + ablation
 * (multiply by ~7 for the 80-turn fixture).
 */

import { readFileSync, existsSync } from "node:fs"

const BASE = process.env.BASE ?? "http://localhost:8080"
const USER = `ablation-${Date.now()}`
const SESSION = "ablation-corpus"
const REPEAT = Number(process.env.REPEAT ?? 1)
const FIXTURE_PATH = process.env.FIXTURE

// ─── Corpus (combined) ───────────────────────────────────────────────────────
// Mix of factual identity, multi-hop entity chains, and behavioral signals.

interface Turn {
  content: string
  ts: string
  session?: string
}

interface Probe {
  query: string
  expect: string[]
  forbid?: string[]                   // noise probes: hit when none of these appear
  type: string                        // "direct" | "single_hop" | "multi_hop" | "multihop" | "behavioral" | "noise"
}

interface Fixture {
  turns: Turn[]
  probes: Probe[]
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
  { query: "where does the user live?",                            expect: ["san diego"],                       type: "direct" },
  { query: "what is the user's dog's name?",                       expect: ["pickle"],                          type: "direct" },
  { query: "where does the user work?",                            expect: ["qualcomm"],                        type: "direct" },
  { query: "what does the user eat?",                              expect: ["vegetarian"],                      type: "direct" },
  { query: "what city does the user's dog live in?",               expect: ["san diego"],                       type: "multihop" },
  { query: "where does the dog go for walks?",                     expect: ["coronado", "beach"],               type: "multihop" },
  { query: "what does the user's friend do for work?",             expect: ["game", "studio", "tidepool"],      type: "multihop" },
  { query: "where does the user eat tacos?",                       expect: ["convoy", "san diego"],             type: "multihop" },
  { query: "how should I format a technical explanation for this user?", expect: ["code", "example", "direct", "concise"], type: "behavioral" },
  { query: "does this user prefer theory or practice?",            expect: ["practice", "code", "example", "direct"],     type: "behavioral" },
  { query: "what is the user currently working on?",               expect: ["scaling", "traffic", "caching", "performance"], type: "behavioral" },
]

let CORPUS: Turn[] = INLINE_CORPUS
let PROBES: Probe[] = INLINE_PROBES

if (FIXTURE_PATH) {
  if (!existsSync(FIXTURE_PATH)) {
    console.error(`Fixture not found: ${FIXTURE_PATH}`)
    process.exit(1)
  }
  const fx = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture
  CORPUS = fx.turns
  PROBES = fx.probes
  console.log(`Loaded fixture from ${FIXTURE_PATH}: ${CORPUS.length} turns, ${PROBES.length} probes`)
}

// ─── Configurations ──────────────────────────────────────────────────────────
// Each config flips ONE feature OFF (everything else ON). Baseline = all ON.

interface Config {
  name: string
  flags: {
    disable_rewrite?: boolean
    disable_entities?: boolean
    disable_rerank?: boolean
    disable_graph?: boolean
    disable_derived?: boolean
  }
}

const CONFIGS: Config[] = [
  { name: "baseline",     flags: {} },
  { name: "no_rewrite",   flags: { disable_rewrite: true } },
  { name: "no_entities",  flags: { disable_entities: true } },
  { name: "no_rerank",    flags: { disable_rerank: true } },
  { name: "no_graph",     flags: { disable_graph: true } },
  { name: "no_derived",   flags: { disable_derived: true } },
]

// ─── HTTP plumbing ───────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface RecallResponse {
  context: string
  citations: unknown[]
  timings: Record<string, number>
}

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

async function probe(query: string, flags: Config["flags"]): Promise<{
  latency: number
  context: string
  timings: Record<string, number>
}> {
  const t0 = performance.now()
  const r = await fetch(`${BASE}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      session_id: "ablation-probe",
      user_id: USER,
      max_tokens: 1024,
      ...flags,
    }),
  })
  const wallLatency = performance.now() - t0
  const body = (await r.json()) as RecallResponse
  return {
    latency: wallLatency,
    context: body.context ?? "",
    timings: body.timings ?? {},
  }
}

const hitsAny = (ctx: string, terms: string[]): boolean => {
  const lower = ctx.toLowerCase()
  return terms.some((t) => lower.includes(t.toLowerCase()))
}

// Probe pass logic:
// - normal probe: hit when ANY expect[] term appears
// - noise probe (no expect[], has forbid[]): hit when NONE of forbid[] terms appear
//   (system did not fabricate user-specific facts on an unrelated query)
function probePassed(ctx: string, p: Probe): boolean {
  if (p.expect.length > 0) {
    return hitsAny(ctx, p.expect)
  }
  if (p.forbid && p.forbid.length > 0) {
    return !hitsAny(ctx, p.forbid)
  }
  return false
}

// Normalize all the probe-type variants to a stable bucket name.
function bucket(t: string): string {
  if (t === "multi_hop") return "multihop"
  if (t === "single_hop") return "single"
  return t  // direct, multihop, single, behavioral, noise
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

interface ConfigStats {
  hits: number
  total: number
  latencyTotal: number
  phaseTotals: Record<string, number>
  // per-probe-type breakdown
  byType: Record<string, { hits: number; total: number }>
}

function newStats(): ConfigStats {
  return {
    hits: 0,
    total: 0,
    latencyTotal: 0,
    phaseTotals: {},
    byType: {
      direct:     { hits: 0, total: 0 },
      single:     { hits: 0, total: 0 },
      multihop:   { hits: 0, total: 0 },
      behavioral: { hits: 0, total: 0 },
      noise:      { hits: 0, total: 0 },
    },
  }
}

function pad(s: string, n: number, align: "left" | "right" = "left"): string {
  if (s.length >= n) return s.slice(0, n)
  return align === "left" ? s + " ".repeat(n - s.length) : " ".repeat(n - s.length) + s
}

const fmtMs = (ms: number) => `${ms.toFixed(0)}ms`
const fmtPct = (n: number) => `${(n * 100).toFixed(0)}%`

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════════════════════")
  console.log("  Per-Feature Latency × Quality Ablation")
  console.log("════════════════════════════════════════════════════════════════")
  console.log(`  Service: ${BASE}`)
  console.log(`  User:    ${USER}`)
  console.log(`  Repeat:  ${REPEAT} run(s) per probe`)
  console.log()

  const health = await fetch(`${BASE}/health`).catch(() => null)
  if (!health || !health.ok) {
    console.error(`Service unreachable at ${BASE}`)
    process.exit(1)
  }
  if (process.env.EMBED_STUB) {
    console.warn("WARNING: EMBED_STUB is set. Most features short-circuit.")
    console.warn("         Run with real Voyage credentials for meaningful results.\n")
  }

  // Phase 1 — ingest
  console.log(`Phase 1: ingest ${CORPUS.length} turns`)
  const ingestStart = performance.now()
  for (let i = 0; i < CORPUS.length; i++) {
    const t0 = performance.now()
    await ingest(CORPUS[i])
    const elapsed = performance.now() - t0
    console.log(`  [${i + 1}/${CORPUS.length}] ${elapsed.toFixed(0)}ms — ${CORPUS[i].content.slice(0, 60)}…`)
    if (i < CORPUS.length - 1) {
      await sleep(500)
    }
  }
  console.log(`Total ingest: ${((performance.now() - ingestStart) / 1000).toFixed(1)}s`)

  // Rebuild graph so spreading activation has edges to traverse.
  if (!process.env.EMBED_STUB) {
    console.log()
    console.log("Rebuilding graph for full edge coverage…")
    const r = await fetch(`${BASE}/graph/${USER}/rebuild`, { method: "POST" })
    const body = (await r.json()) as { nodesProcessed: number; edgesBuilt: number }
    console.log(`  ${body.nodesProcessed} nodes, ${body.edgesBuilt} edges`)
  }

  // Allow derivation to settle (fire-and-forget pipeline runs after each /turns).
  console.log()
  console.log("Waiting 8s for background derivation pipeline…")
  await sleep(8000)

  // Phase 2 — warm up: every query gets one full-baseline call so the
  // in-process embed cache is hot for all subsequent configs. Without this
  // the first config in each (probe, config) tuple would absorb the cold
  // embed cost, skewing the per-feature attribution.
  // We capture timings from the warmup pass to also report cold-cache costs.
  console.log()
  console.log(`Phase 2a: warming embed cache (${PROBES.length} primer calls)`)
  const coldPhaseTotals: Record<string, number> = {}
  for (const p of PROBES) {
    const r = await probe(p.query, {})
    for (const [k, v] of Object.entries(r.timings)) {
      coldPhaseTotals[k] = (coldPhaseTotals[k] ?? 0) + v
    }
  }

  // Phase 2b — probe under each configuration
  console.log()
  console.log(`Phase 2b: probe ${PROBES.length} queries × ${CONFIGS.length} configs × ${REPEAT} runs`)
  console.log(`         (${PROBES.length * CONFIGS.length * REPEAT} total recall calls)`)
  console.log()

  const stats: Record<string, ConfigStats> = {}
  for (const c of CONFIGS) stats[c.name] = newStats()

  for (const p of PROBES) {
    process.stdout.write(`  ${pad(p.query.slice(0, 50), 52)}`)
    for (const cfg of CONFIGS) {
      let hitCount = 0
      let latency = 0
      const phaseAcc: Record<string, number> = {}

      for (let r = 0; r < REPEAT; r++) {
        const res = await probe(p.query, cfg.flags)
        if (probePassed(res.context, p)) hitCount++
        latency += res.latency
        for (const [k, v] of Object.entries(res.timings)) {
          phaseAcc[k] = (phaseAcc[k] ?? 0) + v
        }
      }
      latency /= REPEAT
      for (const k of Object.keys(phaseAcc)) phaseAcc[k] /= REPEAT
      // Majority vote: >=ceil(REPEAT/2) runs must hit
      const hit = hitCount >= Math.ceil(REPEAT / 2)

      const s = stats[cfg.name]
      const b = bucket(p.type)
      s.total += 1
      if (s.byType[b]) s.byType[b].total += 1
      if (hit) {
        s.hits += 1
        if (s.byType[b]) s.byType[b].hits += 1
      }
      s.latencyTotal += latency
      for (const [k, v] of Object.entries(phaseAcc)) {
        s.phaseTotals[k] = (s.phaseTotals[k] ?? 0) + v
      }

      process.stdout.write(` ${cfg.name === "baseline" ? "B" : "A"}=${hit ? "✓" : "✗"}`)
    }
    process.stdout.write("\n")
  }

  // ─── Report 1: per-config quality + latency ──────────────────────────────
  console.log()
  console.log("Report 1 — Quality vs latency by config")
  console.log("───────────────────────────────────────")
  // Only print the per-type columns that have probes
  const buckets = ["direct", "single", "multihop", "behavioral", "noise"]
    .filter((b) => stats["baseline"].byType[b].total > 0)
  const colWidth = 8
  const header = pad("Config", 14) + " | " + pad("Hits", 12) +
    buckets.map((b) => " | " + pad(b, colWidth)).join("") +
    " | " + pad("Avg latency", 12, "right")
  console.log(header)
  console.log("-".repeat(header.length))
  for (const cfg of CONFIGS) {
    const s = stats[cfg.name]
    const hitStr = `${s.hits}/${s.total} (${fmtPct(s.hits / s.total)})`
    const cells = buckets.map((b) => `${s.byType[b].hits}/${s.byType[b].total}`)
    const latStr = fmtMs(s.latencyTotal / s.total)
    console.log(
      pad(cfg.name, 14) + " | " + pad(hitStr, 12) +
      cells.map((c) => " | " + pad(c, colWidth)).join("") +
      " | " + pad(latStr, 12, "right")
    )
  }

  // ─── Report 2: feature cost vs benefit ───────────────────────────────────
  console.log()
  console.log("Report 2 — Feature cost vs benefit (vs baseline)")
  console.log("────────────────────────────────────────────────")
  console.log("  Latency cost = baseline_avg_ms - ablated_avg_ms (positive = feature adds latency)")
  console.log("  Quality gain = baseline_hits - ablated_hits     (positive = feature improves recall)")
  console.log("  Bang/buck    = quality_gain per 100ms of cost")
  console.log()
  console.log(
    pad("Feature", 14) + " | " +
    pad("Latency cost", 14, "right") + " | " +
    pad("Quality gain", 14, "right") + " | " +
    pad("Multihop Δ", 11, "right") + " | " +
    pad("Noise Δ", 9, "right") + " | " +
    pad("Bang/100ms", 12, "right")
  )
  console.log("-".repeat(94))

  const baseline = stats["baseline"]
  const baselineLat = baseline.latencyTotal / baseline.total

  for (const cfg of CONFIGS) {
    if (cfg.name === "baseline") continue
    const s = stats[cfg.name]
    const ablatedLat = s.latencyTotal / s.total
    const latencyCost = baselineLat - ablatedLat                  // ms attributable to the feature
    const qualityGain = baseline.hits - s.hits                    // probes the feature recovered
    const mhDelta = baseline.byType.multihop.hits - s.byType.multihop.hits
    const noiseDelta = baseline.byType.noise.hits - s.byType.noise.hits
    const bangPer100 = latencyCost > 5 ? (qualityGain / latencyCost) * 100 : qualityGain >= 0 ? Infinity : -Infinity

    const featureName = cfg.name.replace("no_", "")
    const bangStr =
      !isFinite(bangPer100) ? (bangPer100 > 0 ? "free win" : "free loss")
      : bangPer100.toFixed(3)

    console.log(
      pad(featureName, 14) + " | " +
      pad(fmtMs(latencyCost), 14, "right") + " | " +
      pad(`${qualityGain >= 0 ? "+" : ""}${qualityGain}`, 14, "right") + " | " +
      pad(`${mhDelta >= 0 ? "+" : ""}${mhDelta}`, 11, "right") + " | " +
      pad(`${noiseDelta >= 0 ? "+" : ""}${noiseDelta}`, 9, "right") + " | " +
      pad(bangStr, 12, "right")
    )
  }

  // ─── Report 3: per-phase latency breakdown ───────────────────────────────
  console.log()
  console.log("Report 3 — Per-phase latency breakdown")
  console.log("──────────────────────────────────────")
  console.log("  COLD = first call per query (embed cache miss)")
  console.log("  WARM = post-warmup (every config in Report 2 sees this)")
  console.log()
  const PHASE_ORDER = [
    "fetch_ms", "derived_ctx_ms", "rewrite_ms", "embed_ms",
    "bm25_ms", "cosine_ms", "entities_ms", "graph_ms",
    "derived_boost_ms", "rerank_ms", "total_ms",
  ]
  const warmPhases = baseline.phaseTotals
  const warmTotalAvg = (warmPhases.total_ms ?? 0) / baseline.total
  const coldTotalAvg = (coldPhaseTotals.total_ms ?? 0) / PROBES.length
  console.log(
    `  ${pad("phase", 18)} ${pad("COLD", 9, "right")} ${pad("WARM", 9, "right")}  ${pad("warm %", 7, "right")}`
  )
  console.log("-".repeat(60))
  for (const phase of PHASE_ORDER) {
    const coldAvg = (coldPhaseTotals[phase] ?? 0) / PROBES.length
    const warmAvg = (warmPhases[phase] ?? 0) / baseline.total
    const pct = warmTotalAvg > 0 ? (warmAvg / warmTotalAvg) * 100 : 0
    const bar = "█".repeat(Math.min(20, Math.round(pct / 5)))
    console.log(
      `  ${pad(phase, 18)} ${pad(fmtMs(coldAvg), 9, "right")} ${pad(fmtMs(warmAvg), 9, "right")}  ${pad(pct.toFixed(0) + "%", 7, "right")}  ${bar}`
    )
  }
  console.log()
  console.log(`  Cold-cache total avg: ${fmtMs(coldTotalAvg)} (first request a user makes)`)
  console.log(`  Warm-cache total avg: ${fmtMs(warmTotalAvg)} (subsequent requests, same query)`)

  // ─── Report 4: bang-for-buck ranking ─────────────────────────────────────
  console.log()
  console.log("Report 4 — Verdict")
  console.log("──────────────────")
  interface Verdict {
    feature: string
    cost: number
    gain: number
  }
  const verdicts: Verdict[] = []
  for (const cfg of CONFIGS) {
    if (cfg.name === "baseline") continue
    const s = stats[cfg.name]
    verdicts.push({
      feature: cfg.name.replace("no_", ""),
      cost: baselineLat - s.latencyTotal / s.total,
      gain: baseline.hits - s.hits,
    })
  }

  const cheapWins = verdicts.filter((v) => v.gain > 0 && v.cost < 200)
  const expensiveWins = verdicts.filter((v) => v.gain > 0 && v.cost >= 200)
  const noOps = verdicts.filter((v) => v.gain === 0 && v.cost > 50)
  const regressions = verdicts.filter((v) => v.gain < 0)

  if (cheapWins.length) {
    console.log("  ✓ Cheap wins (gain > 0, cost < 200ms):")
    for (const v of cheapWins) console.log(`    ${v.feature}: +${v.gain} hits for ${fmtMs(v.cost)}`)
  }
  if (expensiveWins.length) {
    console.log("  ~ Expensive but valuable (gain > 0, cost >= 200ms):")
    for (const v of expensiveWins) console.log(`    ${v.feature}: +${v.gain} hits for ${fmtMs(v.cost)}`)
  }
  if (noOps.length) {
    console.log("  ⚠ No measurable benefit on this corpus (gain = 0, cost > 50ms):")
    for (const v of noOps) console.log(`    ${v.feature}: 0 hits gained, ${fmtMs(v.cost)} burned`)
  }
  if (regressions.length) {
    console.log("  ✗ Regressions (feature appears to HURT recall):")
    for (const v of regressions) console.log(`    ${v.feature}: ${v.gain} hits, ${fmtMs(v.cost)}`)
  }

  // Cleanup
  console.log()
  console.log("Cleaning up test user…")
  await fetch(`${BASE}/users/${USER}`, { method: "DELETE" })
  console.log("Done.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
