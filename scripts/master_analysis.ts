#!/usr/bin/env bun
/**
 * Master architecture analysis.
 *
 * Loads every fixture in fixtures/, ingests it, then probes each query under
 * three retrieval configs:
 *
 *   - minimal:  BM25 + cosine + RRF only (disable_rewrite, _graph, _entities)
 *   - default:  the shipped config (rewrite + graph + entities ON;
 *                                   rerank + hyde + derived OFF)
 *   - all_on:   every retrieval feature ON (overrides every disable_* to false)
 *
 * Reports:
 *   - Per-fixture × config: hit rate by probe type, latency p50/p95/mean
 *   - Cross-config deltas: quality and latency
 *   - Cost-per-hit ratios for the LLM-augmented features
 *   - Verdict: does the data support the shipped default, or argue for
 *              promoting/demoting features?
 *
 * Requires real Voyage embeddings. Plan for ~15-25 min on the paid tier.
 *
 * Usage:
 *   docker compose up --build -d
 *   bun run scripts/master_analysis.ts
 *   bun run scripts/master_analysis.ts > analysis_report.md
 *
 *   # Optional env:
 *   BASE=http://localhost:8080  override service URL
 *   FIXTURES=small_factual,medium_temporal  comma-separated stems to load
 *                                           (default: every *.json in fixtures/)
 *   SKIP_INGEST=1  reuse a previously-ingested user_id from FIXTURE_USER_<NAME>
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { resolve } from "node:path"

const BASE = process.env.BASE ?? "http://localhost:8080"
const FIXTURES_DIR = resolve(import.meta.dir, "..", "fixtures")
const RUN_TAG = `master-${Date.now()}`

interface Turn {
  ts: string
  session?: string
  content: string
}

interface Probe {
  query: string
  expect: string[]
  forbid?: string[]
  type: string
}

interface Fixture {
  name: string
  description: string
  persona?: string
  turns: Turn[]
  probes: Probe[]
}

interface Config {
  name: string
  flags: Record<string, boolean>
}

interface ProbeResult {
  fixture: string
  config: string
  query: string
  type: string
  hit: boolean
  latency_ms: number
  total_ms: number
  context_len: number
  citation_count: number
}

// ─── Configs ─────────────────────────────────────────────────────────────────

const CONFIGS: Config[] = [
  {
    name: "minimal",
    flags: {
      disable_rewrite: true,
      disable_graph: true,
      disable_entities: true,
      // hyde, rerank, derived already off by default
    },
  },
  {
    name: "default",
    flags: {
      // No flags — uses shipped defaults.
    },
  },
  {
    name: "all_on",
    flags: {
      disable_rewrite: false,
      disable_graph: false,
      disable_entities: false,
      disable_rerank: false,
      disable_hyde: false,
      disable_derived: false,
    },
  },
]

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  let parsed: any = null
  try { parsed = await res.json() } catch { /* 204 */ }
  return { status: res.status, body: parsed ?? {} }
}

async function del(path: string) {
  await fetch(`${BASE}${path}`, { method: "DELETE" })
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ─── Fixture loading ─────────────────────────────────────────────────────────

function loadFixtures(): Fixture[] {
  const filter = process.env.FIXTURES?.split(",").map((s) => s.trim())
  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => !filter || filter.includes(f.replace(/\.json$/, "")))

  const fixtures: Fixture[] = []
  for (const file of files) {
    const path = resolve(FIXTURES_DIR, file)
    const raw = JSON.parse(readFileSync(path, "utf8"))
    const name = file.replace(/\.json$/, "")

    // The graph_stress_corpus + new fixtures use the flat schema.
    // The legacy conversations.json uses an array-of-conversations schema.
    if (Array.isArray(raw)) {
      // Flatten conversations.json → one fixture per conversation
      for (const conv of raw) {
        fixtures.push({
          name: `${name}/${conv.session_id ?? conv.description?.slice(0, 20) ?? "conv"}`,
          description: conv.description ?? "",
          persona: undefined,
          turns: (conv.turns ?? []).map((t: any, i: number) => ({
            ts: t.timestamp ?? `2025-01-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
            session: conv.session_id,
            content: t.messages?.[0]?.content ?? "",
          })),
          probes: (conv.probes ?? []).map((p: any) => ({
            query: p.query,
            expect: Array.isArray(p.expected_contains) ? p.expected_contains
                   : p.expected_contains == null ? []
                   : [p.expected_contains],
            forbid: Array.isArray(p.expected_not_contains) ? p.expected_not_contains
                   : p.expected_not_contains == null ? undefined
                   : [p.expected_not_contains],
            type: p.type ?? "direct",
          })),
        })
      }
    } else if (raw.turns && raw.probes) {
      fixtures.push({
        name,
        description: raw.description ?? "",
        persona: raw.persona,
        turns: raw.turns,
        probes: raw.probes,
      })
    }
  }
  return fixtures
}

// ─── Ingest + probe ──────────────────────────────────────────────────────────

async function ingestFixture(fixture: Fixture, userId: string) {
  console.error(`  [ingest] ${fixture.turns.length} turns…`)
  for (let i = 0; i < fixture.turns.length; i++) {
    const t = fixture.turns[i]
    const r = await post("/turns", {
      session_id: t.session ?? `${userId}-default`,
      user_id: userId,
      messages: [{ role: "user", content: t.content }],
      timestamp: t.ts,
      metadata: {},
    })
    if (r.status !== 201) {
      console.error(`    [warn] turn ${i + 1} returned ${r.status}`)
    }
    // Brief pause to let extraction land before next turn (avoids
    // ALREADY_FOUND empty + key-collision races on rapid ingests).
    await wait(800)
  }
  // Extra settle: derived background pipeline (if enabled) and
  // graph edge building should drain before we probe.
  await wait(2500)
}

function evaluateProbe(probe: Probe, context: string): boolean {
  const ctx = context.toLowerCase()

  if (probe.type === "noise") {
    // Noise probes pass when no forbidden term appears in the context.
    // (Context being empty also passes.)
    if (!probe.forbid || probe.forbid.length === 0) return ctx.length === 0
    return !probe.forbid.some((f) => ctx.includes(f.toLowerCase()))
  }

  // Non-noise: hit when at least one expected term appears.
  if (probe.expect.length === 0) return true // no constraint
  return probe.expect.some((e) => ctx.includes(e.toLowerCase()))
}

async function runProbes(
  fixture: Fixture,
  userId: string,
  config: Config,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = []
  for (const probe of fixture.probes) {
    const t0 = performance.now()
    const r = await post("/recall", {
      query: probe.query,
      session_id: `${userId}-probe`,
      user_id: userId,
      max_tokens: 1024,
      ...config.flags,
    })
    const wallMs = performance.now() - t0
    const context = String(r.body?.context ?? "")
    const citations: unknown[] = r.body?.citations ?? []
    const totalMs = Number(r.body?.timings?.total_ms ?? wallMs)

    results.push({
      fixture: fixture.name,
      config: config.name,
      query: probe.query,
      type: probe.type,
      hit: evaluateProbe(probe, context),
      latency_ms: wallMs,
      total_ms: totalMs,
      context_len: context.length,
      citation_count: citations.length,
    })
  }
  return results
}

// ─── Stats helpers ───────────────────────────────────────────────────────────

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  return sorted[idx]
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

function groupBy<T, K extends string | number>(items: T[], key: (x: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = map.get(k) ?? []
    list.push(item)
    map.set(k, list)
  }
  return map
}

// ─── Reporting ───────────────────────────────────────────────────────────────

function printHeader(s: string) {
  console.log("")
  console.log(s)
  console.log("=".repeat(s.length))
}

function printSubheader(s: string) {
  console.log("")
  console.log(s)
  console.log("-".repeat(s.length))
}

function fmtPct(num: number, den: number): string {
  if (den === 0) return "  -"
  const pct = (100 * num) / den
  return `${num}/${den} (${pct.toFixed(0)}%)`
}

function fmtMs(n: number): string {
  return `${n.toFixed(0)} ms`
}

function reportPerFixture(fixtures: Fixture[], all: ProbeResult[]) {
  printHeader("Per-fixture × per-config results")

  for (const fx of fixtures) {
    printSubheader(`fixture: ${fx.name}  (${fx.turns.length} turns, ${fx.probes.length} probes)`)
    if (fx.description) console.log(fx.description)

    const byType = groupBy(fx.probes, (p) => p.type)
    const types = [...byType.keys()].sort()

    // Header row: probe type | minimal | default | all_on (latency)
    console.log("")
    console.log(
      `${"probe type".padEnd(14)} | ${types.map(() => "").join(" | ")}`.replace(/\|.*$/, ""),
    )
    const colWidth = 22
    const hdr = ["probe type".padEnd(14)]
    for (const cfg of CONFIGS) hdr.push(cfg.name.padEnd(colWidth))
    console.log(hdr.join(" │ "))
    console.log("-".repeat(hdr.join(" │ ").length))

    for (const t of types) {
      const probes = byType.get(t)!
      const row = [t.padEnd(14)]
      for (const cfg of CONFIGS) {
        const matching = all.filter(
          (r) => r.fixture === fx.name && r.config === cfg.name && r.type === t,
        )
        const hits = matching.filter((r) => r.hit).length
        const meanMs = mean(matching.map((r) => r.total_ms))
        row.push(`${fmtPct(hits, probes.length).padEnd(10)} ${fmtMs(meanMs).padStart(9)}`.padEnd(colWidth))
      }
      console.log(row.join(" │ "))
    }

    // Fixture totals
    const totalRow = ["TOTAL".padEnd(14)]
    for (const cfg of CONFIGS) {
      const matching = all.filter(
        (r) => r.fixture === fx.name && r.config === cfg.name,
      )
      const hits = matching.filter((r) => r.hit).length
      const p50 = percentile(matching.map((r) => r.total_ms), 0.5)
      const p95 = percentile(matching.map((r) => r.total_ms), 0.95)
      totalRow.push(
        `${fmtPct(hits, fx.probes.length).padEnd(10)} p50:${fmtMs(p50)} p95:${fmtMs(p95)}`.padEnd(colWidth + 12),
      )
    }
    console.log("-".repeat(hdr.join(" │ ").length))
    console.log(totalRow.join(" │ "))
  }
}

function reportOverall(fixtures: Fixture[], all: ProbeResult[]) {
  printHeader("Overall: aggregated across all fixtures")

  const allTypes = new Set(all.map((r) => r.type))
  console.log("")
  const hdr = ["probe type".padEnd(14)]
  const colWidth = 26
  for (const cfg of CONFIGS) hdr.push(cfg.name.padEnd(colWidth))
  console.log(hdr.join(" │ "))
  console.log("-".repeat(hdr.join(" │ ").length))

  for (const t of [...allTypes].sort()) {
    const row = [t.padEnd(14)]
    for (const cfg of CONFIGS) {
      const matching = all.filter((r) => r.config === cfg.name && r.type === t)
      const hits = matching.filter((r) => r.hit).length
      const meanMs = mean(matching.map((r) => r.total_ms))
      row.push(
        `${fmtPct(hits, matching.length).padEnd(12)} mean:${fmtMs(meanMs)}`.padEnd(colWidth),
      )
    }
    console.log(row.join(" │ "))
  }

  // Grand totals
  console.log("-".repeat(hdr.join(" │ ").length))
  const totalRow = ["GRAND TOTAL".padEnd(14)]
  for (const cfg of CONFIGS) {
    const matching = all.filter((r) => r.config === cfg.name)
    const hits = matching.filter((r) => r.hit).length
    const p50 = percentile(matching.map((r) => r.total_ms), 0.5)
    const p95 = percentile(matching.map((r) => r.total_ms), 0.95)
    const meanMs = mean(matching.map((r) => r.total_ms))
    totalRow.push(
      `${fmtPct(hits, matching.length).padEnd(12)} mean:${fmtMs(meanMs)} p95:${fmtMs(p95)}`
        .padEnd(colWidth),
    )
  }
  console.log(totalRow.join(" │ "))
}

function reportDeltas(all: ProbeResult[]) {
  printHeader("Cross-config deltas (vs. default)")

  const byCfg = (name: string) => all.filter((r) => r.config === name)
  const def = byCfg("default")
  const min = byCfg("minimal")
  const allOn = byCfg("all_on")

  const hits = (rs: ProbeResult[]) => rs.filter((r) => r.hit).length
  const meanLat = (rs: ProbeResult[]) => mean(rs.map((r) => r.total_ms))

  const total = def.length

  console.log("")
  console.log(
    `${"config".padEnd(10)} │ ${"hit rate".padEnd(16)} │ ${"Δ hits".padEnd(8)} │ ${"mean latency".padEnd(14)} │ ${"Δ latency".padEnd(14)} │ ${"cost / extra hit".padEnd(20)}`,
  )
  console.log("-".repeat(100))

  const baselineHits = hits(def)
  const baselineLat = meanLat(def)

  for (const [name, rs] of [
    ["minimal", min],
    ["default", def],
    ["all_on", allOn],
  ] as const) {
    const h = hits(rs)
    const lat = meanLat(rs)
    const dh = h - baselineHits
    const dlat = lat - baselineLat
    const costPer = dh > 0 ? `${(dlat / dh).toFixed(0)} ms / hit` : dh < 0 ? "(loses hits)" : "—"
    console.log(
      `${name.padEnd(10)} │ ` +
      `${fmtPct(h, total).padEnd(16)} │ ` +
      `${(dh >= 0 ? `+${dh}` : `${dh}`).padEnd(8)} │ ` +
      `${fmtMs(lat).padEnd(14)} │ ` +
      `${(dlat >= 0 ? `+${fmtMs(dlat)}` : `−${fmtMs(-dlat)}`).padEnd(14)} │ ` +
      `${costPer.padEnd(20)}`,
    )
  }
}

function reportVerdict(fixtures: Fixture[], all: ProbeResult[]) {
  printHeader("Verdict: does the data support the shipped default?")

  const types = ["direct", "multihop", "temporal", "aggregation", "behavioral", "noise"]
  const features = [
    { name: "BM25+cosine+RRF (always on)", evidence: "Direct probe hit rate" },
    { name: "Query rewrite (default ON)", evidence: "default - minimal hit delta" },
    { name: "Graph + entities (default ON)", evidence: "Multihop probes default vs minimal" },
    { name: "Temporal detector (always ON)", evidence: "Temporal probes hit rate" },
    { name: "Aggregation detector (always ON)", evidence: "Aggregation probes hit rate" },
    { name: "Precision floor (always ON)", evidence: "Noise probes hit rate" },
    { name: "Reranker (default OFF)", evidence: "all_on - default hit delta" },
    { name: "HyDE (default OFF)", evidence: "all_on - default hit delta" },
    { name: "Derived memories (default OFF)", evidence: "Behavioral probes default vs all_on" },
  ]

  const def = all.filter((r) => r.config === "default")
  const min = all.filter((r) => r.config === "minimal")
  const allOn = all.filter((r) => r.config === "all_on")

  console.log("")
  for (const t of types) {
    const defHits = def.filter((r) => r.type === t && r.hit).length
    const minHits = min.filter((r) => r.type === t && r.hit).length
    const allHits = allOn.filter((r) => r.type === t && r.hit).length
    const total = def.filter((r) => r.type === t).length
    if (total === 0) continue
    console.log(
      `  ${t.padEnd(13)}  minimal:${fmtPct(minHits, total).padEnd(12)} ` +
      `default:${fmtPct(defHits, total).padEnd(12)} ` +
      `all_on:${fmtPct(allHits, total)}`,
    )
  }

  console.log("")
  console.log("Architectural reads:")
  console.log("")

  // Compute deltas
  const defHits = def.filter((r) => r.hit).length
  const minHits = min.filter((r) => r.hit).length
  const allHits = allOn.filter((r) => r.hit).length
  const defLat = mean(def.map((r) => r.total_ms))
  const minLat = mean(min.map((r) => r.total_ms))
  const allLat = mean(allOn.map((r) => r.total_ms))

  const upgradeHits = defHits - minHits
  const upgradeLat = defLat - minLat
  const turbohitsDiff = allHits - defHits
  const turboLatDiff = allLat - defLat

  console.log(
    `  rewrite + graph + entities (default-vs-minimal): ` +
    `${upgradeHits >= 0 ? "+" : ""}${upgradeHits} hits ` +
    `for ${upgradeLat >= 0 ? "+" : "−"}${fmtMs(Math.abs(upgradeLat))} per recall.`,
  )
  if (upgradeHits > 0 && upgradeLat > 0) {
    console.log(
      `    → cost / hit: ${(upgradeLat / upgradeHits).toFixed(0)} ms.  ` +
      `${upgradeLat / upgradeHits < 1500 ? "Defensible default." : "Borderline — consider per-request opt-in."}`,
    )
  } else if (upgradeHits === 0 && upgradeLat > 200) {
    console.log(`    → no measured gain for ${fmtMs(upgradeLat)} of latency. Move to opt-in.`)
  } else if (upgradeHits === 0) {
    console.log(`    → no measured gain on this corpus. Cost is small enough that retention is fine.`)
  }

  console.log("")
  console.log(
    `  rerank + hyde + derived (all_on-vs-default): ` +
    `${turbohitsDiff >= 0 ? "+" : ""}${turbohitsDiff} hits ` +
    `for ${turboLatDiff >= 0 ? "+" : "−"}${fmtMs(Math.abs(turboLatDiff))} per recall.`,
  )
  if (turbohitsDiff > 0) {
    console.log(
      `    → ${turboLatDiff / turbohitsDiff > 2000 ? "Expensive but real" : "Worth promoting"}: ` +
      `${(turboLatDiff / turbohitsDiff).toFixed(0)} ms per hit.`,
    )
  } else if (turbohitsDiff === 0) {
    console.log(
      `    → zero binary gain. Optional features target precision@1 / vocab fallback / ` +
      `behavioural enrichment — invisible to Recall@K. Off-by-default validated.`,
    )
  } else {
    console.log(`    → all_on REGRESSED. Token-budget tax from derived-memories profile section?`)
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

async function main() {
  const startTime = performance.now()

  // Health check
  try {
    const r = await fetch(`${BASE}/health`)
    if (r.status !== 200) throw new Error(`health: ${r.status}`)
  } catch (err: any) {
    console.error(`Service not reachable at ${BASE}: ${err?.message ?? err}`)
    console.error(`Start it with:  docker compose up --build -d`)
    process.exit(1)
  }

  const fixtures = loadFixtures()
  if (fixtures.length === 0) {
    console.error(`No fixtures matched. Set FIXTURES=stem1,stem2 or check fixtures/.`)
    process.exit(1)
  }

  console.error(`Loaded ${fixtures.length} fixture(s):`)
  for (const f of fixtures) {
    console.error(`  • ${f.name}  (${f.turns.length} turns, ${f.probes.length} probes)`)
  }
  console.error("")

  // ── Ingest each fixture once into a unique user_id, then probe under all configs.
  const userByFixture = new Map<string, string>()
  const allResults: ProbeResult[] = []

  for (const fx of fixtures) {
    const userId = `${RUN_TAG}-${fx.name.replace(/[^a-z0-9]/gi, "_")}`
    userByFixture.set(fx.name, userId)

    console.error(`\n── ${fx.name} ──`)
    if (process.env.SKIP_INGEST !== "1") {
      await ingestFixture(fx, userId)
    } else {
      console.error(`  [skip] reusing existing data for ${userId}`)
    }

    for (const cfg of CONFIGS) {
      console.error(`  [probe] config=${cfg.name}  (${fx.probes.length} probes)`)
      const results = await runProbes(fx, userId, cfg)
      allResults.push(...results)
      const hits = results.filter((r) => r.hit).length
      const meanMs = mean(results.map((r) => r.total_ms))
      console.error(`    → ${fmtPct(hits, fx.probes.length)}, mean ${fmtMs(meanMs)}`)
    }
  }

  // ── Reports
  console.log("# Master architecture analysis")
  console.log("")
  console.log(`Run: \`${RUN_TAG}\``)
  console.log(`Fixtures: ${fixtures.length}`)
  console.log(`Probes: ${fixtures.reduce((n, f) => n + f.probes.length, 0)}`)
  console.log(`Total recall calls: ${allResults.length}`)
  console.log(`Wall time: ${((performance.now() - startTime) / 1000).toFixed(0)} s`)
  console.log("")
  console.log("Configs compared:")
  console.log("- **minimal** — BM25 + cosine + RRF only (no rewrite/graph/entities/etc.)")
  console.log("- **default** — shipped config (rewrite + graph + entities ON; rerank/hyde/derived OFF)")
  console.log("- **all_on**  — every retrieval feature enabled")

  reportPerFixture(fixtures, allResults)
  reportOverall(fixtures, allResults)
  reportDeltas(allResults)
  reportVerdict(fixtures, allResults)

  // Cleanup
  if (process.env.KEEP_DATA !== "1") {
    console.error("\n── Cleanup ──")
    for (const userId of userByFixture.values()) {
      await del(`/users/${userId}`)
    }
    console.error(`Deleted ${userByFixture.size} test user(s).`)
  }
}

main().catch((err) => {
  console.error("Master analysis failed:", err)
  process.exit(1)
})
