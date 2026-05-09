#!/usr/bin/env bun
// Stress-tests recall with and without the associative memory graph.
// Ingests a multi-hop-friendly corpus, then probes each query in both modes
// (graph traversal ON / OFF) using the disable_graph flag on /recall.
//
// Usage:
//   bun run scripts/graph_compare.ts
//   BASE=http://localhost:8080 bun run scripts/graph_compare.ts
//
// Requires the service running with real Voyage embeddings — stub vectors
// produce zero graph edges so the comparison is meaningless in stub mode.

const BASE = process.env.BASE ?? "http://localhost:8080"
const USER = `graph-stress-${Date.now()}`
const SESSION = "stress-corpus"

interface Probe {
  query: string
  expectedTokens: string[]   // any token present in context (lowercased) = hit
  description: string
  type: "direct" | "multihop"
}

const FIXTURES: string[] = [
  "I have a Welsh Corgi named Pickle. She's the love of my life.",
  "I take Pickle to Coronado Beach every Saturday morning for a long walk.",
  "I live in San Diego, California. The weather here is perfect year-round.",
  "I work at Qualcomm as a chip architect. The main campus is in Sorrento Valley.",
  "I'm a vegetarian. I love the taco shops along Convoy Street.",
  "On weekends I surf at Pacific Beach with my friend Marco.",
  "Marco runs an indie game studio called Tidepool in La Jolla.",
  "My favorite coffee shop is Bird Rock Coffee Roasters in La Jolla.",
  "I bike commute every day. The Coastal Rail Trail is my main route.",
  "I read sci-fi at night, mostly Le Guin and Ted Chiang.",
]

const PROBES: Probe[] = [
  { query: "where does the user live?",                           expectedTokens: ["san diego"],            description: "Direct: location",              type: "direct" },
  { query: "what is the user's dog's name?",                      expectedTokens: ["pickle"],               description: "Direct: pet name",              type: "direct" },
  { query: "where does the user work?",                           expectedTokens: ["qualcomm"],             description: "Direct: employer",              type: "direct" },
  { query: "what does the user eat?",                             expectedTokens: ["vegetarian"],           description: "Direct: diet",                  type: "direct" },
  { query: "what city does the user's dog live in?",              expectedTokens: ["san diego"],            description: "Multi-hop: pet → city",         type: "multihop" },
  { query: "where does the dog go for walks?",                    expectedTokens: ["coronado", "beach"],    description: "Multi-hop: pet → beach",        type: "multihop" },
  { query: "in what city is the user employed?",                  expectedTokens: ["san diego", "sorrento"], description: "Multi-hop: employer → city",    type: "multihop" },
  { query: "where does the user eat tacos?",                      expectedTokens: ["convoy", "san diego"],  description: "Multi-hop: diet → street",      type: "multihop" },
  { query: "what does the user's friend do for work?",            expectedTokens: ["game", "studio", "tidepool"], description: "Multi-hop: friend → job", type: "multihop" },
  { query: "where does the user go for coffee?",                  expectedTokens: ["bird rock", "la jolla"], description: "Multi-hop: hobby → place",     type: "multihop" },
]

interface ProbeResult {
  latency: number
  context: string
  citationCount: number
}

async function ingest(content: string): Promise<void> {
  const r = await fetch(`${BASE}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: SESSION,
      user_id: USER,
      messages: [{ role: "user", content }],
      timestamp: new Date().toISOString(),
      metadata: {},
    }),
  })
  if (!r.ok) throw new Error(`ingest failed: ${r.status} ${await r.text()}`)
}

async function probe(query: string, disableGraph: boolean): Promise<ProbeResult> {
  const t0 = performance.now()
  const r = await fetch(`${BASE}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      session_id: "stress-probe",
      user_id: USER,
      max_tokens: 1024,
      disable_graph: disableGraph,
    }),
  })
  const latency = performance.now() - t0
  const body = (await r.json()) as { context: string; citations: unknown[] }
  return { latency, context: body.context ?? "", citationCount: body.citations?.length ?? 0 }
}

interface GraphStats {
  nodeCount: number
  edgeCount: number
  avgDegree: number
}

async function getGraphStats(): Promise<GraphStats> {
  const r = await fetch(`${BASE}/graph/${USER}`)
  const body = (await r.json()) as { stats: GraphStats }
  return body.stats
}

function pad(s: string, n: number, align: "left" | "right" = "left"): string {
  if (s.length >= n) return s.slice(0, n)
  return align === "left" ? s + " ".repeat(n - s.length) : " ".repeat(n - s.length) + s
}

function hitsAny(context: string, tokens: string[]): boolean {
  const lower = context.toLowerCase()
  return tokens.some((t) => lower.includes(t))
}

async function main(): Promise<void> {
  console.log(`Memory Graph Stress Comparison`)
  console.log(`==============================`)
  console.log(`Service: ${BASE}`)
  console.log(`User:    ${USER}`)
  console.log()

  // Health check
  const health = await fetch(`${BASE}/health`).catch(() => null)
  if (!health || !health.ok) {
    console.error(`Service unreachable at ${BASE}. Is the container running?`)
    process.exit(1)
  }
  if (process.env.EMBED_STUB) {
    console.warn(`WARNING: EMBED_STUB is set. Stub vectors don't produce graph edges,`)
    console.warn(`         so the comparison will not show any graph benefit.`)
    console.warn(`         Run against a service with real VOYAGE_API_KEY for meaningful results.`)
    console.warn()
  }

  console.log(`Phase 1: ingest ${FIXTURES.length} turns`)
  const ingestStart = performance.now()
  for (let i = 0; i < FIXTURES.length; i++) {
    process.stdout.write(`  [${i + 1}/${FIXTURES.length}] `)
    const t0 = performance.now()
    await ingest(FIXTURES[i])
    const elapsed = performance.now() - t0
    console.log(`${elapsed.toFixed(0)}ms — ${FIXTURES[i].slice(0, 60)}`)
    // Voyage free tier is 3 RPM — pace ingestion to avoid 429s
    if (!process.env.EMBED_STUB && elapsed < 22000 && i < FIXTURES.length - 1) {
      await new Promise((r) => setTimeout(r, 22000 - elapsed))
    }
  }
  console.log(`Total ingest: ${((performance.now() - ingestStart) / 1000).toFixed(1)}s`)
  console.log()

  console.log(`Rebuilding full graph (pairwise edges across all memories)...`)
  const rebuildR = await fetch(`${BASE}/graph/${USER}/rebuild`, { method: "POST" })
  const rebuildBody = (await rebuildR.json()) as { nodesProcessed: number; edgesBuilt: number }
  console.log(`Rebuild: ${rebuildBody.nodesProcessed} nodes, ${rebuildBody.edgesBuilt} edges`)
  console.log()

  const stats = await getGraphStats()
  console.log(`Graph state after rebuild:`)
  console.log(`  nodes:      ${stats.nodeCount}`)
  console.log(`  edges:      ${stats.edgeCount}`)
  console.log(`  avg degree: ${stats.avgDegree}`)
  console.log()

  if (stats.edgeCount === 0) {
    console.warn(`WARNING: 0 graph edges built. Comparison will show no difference.`)
    console.warn(`         Likely cause: stub embeddings, or all memory pairs scored < EDGE_MIN_STRENGTH (0.55).`)
    console.warn()
  }

  console.log(`Phase 2: probe each query in both modes`)
  console.log()

  interface Row {
    probe: Probe
    off: ProbeResult & { hit: boolean }
    on: ProbeResult & { hit: boolean }
  }

  const rows: Row[] = []
  for (const p of PROBES) {
    process.stdout.write(`  ${pad(p.description, 40)} `)
    // Order matters slightly because of in-process caches: alternate to balance.
    const off = await probe(p.query, true)
    const on = await probe(p.query, false)
    const offHit = hitsAny(off.context, p.expectedTokens)
    const onHit = hitsAny(on.context, p.expectedTokens)
    rows.push({
      probe: p,
      off: { ...off, hit: offHit },
      on: { ...on, hit: onHit },
    })
    const delta = onHit && !offHit ? "+graph" : !onHit && offHit ? "-graph" : "same"
    console.log(`OFF=${offHit ? "✓" : "✗"} ON=${onHit ? "✓" : "✗"} ${delta}`)
  }
  console.log()

  // ── Comparison table ──
  console.log(`Results`)
  console.log(`-------`)
  console.log(
    pad("Probe", 40) +
      " | " +
      pad("Graph OFF", 22, "right") +
      " | " +
      pad("Graph ON", 22, "right") +
      " | " +
      "Effect"
  )
  console.log("-".repeat(40 + 3 + 22 + 3 + 22 + 3 + 12))

  let onHits = 0
  let offHits = 0
  let onLatencyTotal = 0
  let offLatencyTotal = 0

  for (const r of rows) {
    if (r.on.hit) onHits++
    if (r.off.hit) offHits++
    onLatencyTotal += r.on.latency
    offLatencyTotal += r.off.latency

    const offCell = `${r.off.hit ? "✓" : "✗"} ${pad(`${r.off.latency.toFixed(0)}ms`, 7, "right")} ${pad(`${r.off.citationCount}c`, 4, "right")}`
    const onCell = `${r.on.hit ? "✓" : "✗"} ${pad(`${r.on.latency.toFixed(0)}ms`, 7, "right")} ${pad(`${r.on.citationCount}c`, 4, "right")}`
    const effect =
      r.on.hit && !r.off.hit
        ? "graph fixed"
        : !r.on.hit && r.off.hit
          ? "graph broke"
          : r.on.hit && r.off.hit
            ? "both hit"
            : "both miss"

    console.log(
      pad(r.probe.description, 40) + " | " + pad(offCell, 22, "right") + " | " + pad(onCell, 22, "right") + " | " + effect
    )
  }

  console.log("-".repeat(40 + 3 + 22 + 3 + 22 + 3 + 12))

  const total = rows.length
  const mh = rows.filter((r) => r.probe.type === "multihop")
  const mhOn = mh.filter((r) => r.on.hit).length
  const mhOff = mh.filter((r) => r.off.hit).length
  const direct = rows.filter((r) => r.probe.type === "direct")
  const dOn = direct.filter((r) => r.on.hit).length
  const dOff = direct.filter((r) => r.off.hit).length

  console.log()
  console.log(`Summary`)
  console.log(`-------`)
  console.log(`Overall hit rate:    ${offHits}/${total} (${((offHits / total) * 100).toFixed(0)}%) → ${onHits}/${total} (${((onHits / total) * 100).toFixed(0)}%)`)
  console.log(`Direct queries:      ${dOff}/${direct.length} → ${dOn}/${direct.length}`)
  console.log(`Multi-hop queries:   ${mhOff}/${mh.length} → ${mhOn}/${mh.length}     ← graph should help here`)
  console.log(`Avg recall latency:  ${(offLatencyTotal / total).toFixed(0)}ms → ${(onLatencyTotal / total).toFixed(0)}ms (Δ ${((onLatencyTotal - offLatencyTotal) / total).toFixed(0)}ms)`)
  console.log()
  console.log(`Graph: ${stats.nodeCount} nodes, ${stats.edgeCount} edges, avg degree ${stats.avgDegree}`)

  // Cleanup
  await fetch(`${BASE}/users/${USER}`, { method: "DELETE" })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
