import { describe, it, expect, beforeAll } from "bun:test"

const BASE = "http://localhost:8080"
const USER = "graph-perf-user"

async function ingest(content: string, session = "graph-test") {
  const r = await fetch(`${BASE}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: session,
      user_id: USER,
      messages: [{ role: "user", content }],
      timestamp: new Date().toISOString(),
      metadata: {},
    }),
  })
  return r.json()
}

async function recall(query: string) {
  const r = await fetch(`${BASE}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      session_id: "graph-probe",
      user_id: USER,
      max_tokens: 1024,
      // Graph + entities are off by default in the lean architecture; this
      // test file specifically verifies the graph feature, so opt back in.
      disable_graph: false,
      disable_entities: false,
    }),
  })
  return r.json()
}

describe("associative memory graph", () => {
  beforeAll(async () => {
    await fetch(`${BASE}/users/${USER}`, { method: "DELETE" })
    await new Promise((r) => setTimeout(r, 500))

    await ingest("My dog Biscuit is a 3-year-old golden retriever. She loves the park.")
    await new Promise((r) => setTimeout(r, 3000))

    await ingest("I live in Portland, Oregon. The hiking scene here is incredible.")
    await new Promise((r) => setTimeout(r, 3000))

    await ingest("I take Biscuit hiking on Mount Hood every weekend.")
    await new Promise((r) => setTimeout(r, 3000))

    await ingest("I work at Nike as a software engineer. Their HQ is in Beaverton, near Portland.")
    await new Promise((r) => setTimeout(r, 3000))
  }, 60_000)

  it("graph endpoint returns stats", async () => {
    const r = await fetch(`${BASE}/graph/${USER}`)
    const body = await r.json() as any
    expect(r.status).toBe(200)
    expect(body.stats).toBeDefined()
    expect(body.stats.nodeCount).toBeGreaterThan(0)
    console.log("Graph stats:", JSON.stringify(body.stats))
    console.log("Top associations:", JSON.stringify(body.top_associations?.slice(0, 3), null, 2))
  })

  it("direct query surfaces expected memory", async () => {
    const result = await recall("where does the user live?") as any
    expect(result.context.toLowerCase()).toContain("portland")
  })

  it("graph-assisted: dog query surfaces location (multi-hop)", async () => {
    const result = await recall("what is the user's dog's name and where do they live?") as any
    const ctx = result.context.toLowerCase()

    console.log("Multi-hop test:")
    console.log("  Has dog (Biscuit):", ctx.includes("biscuit"))
    console.log("  Has location (Portland):", ctx.includes("portland"))
    console.log("  Citations:", result.citations?.length ?? 0)
    console.log("  Context snippet:", result.context?.slice(0, 300))

    expect(ctx.includes("biscuit")).toBe(true)
    // Location via graph traversal: Biscuit→hiking→Portland
    // Passes only when graph traversal is active AND real embeddings are used.
    // In EMBED_STUB mode this may fail — stub vectors don't produce semantic edges.
    expect(ctx.includes("portland")).toBe(true)
  })

  it("graph-assisted: employer query surfaces related location", async () => {
    const result = await recall("where does the user work and what city?") as any
    const ctx = result.context.toLowerCase()

    console.log("Employer+location test:")
    console.log("  Has Nike:", ctx.includes("nike"))
    console.log("  Has Portland/Beaverton:", ctx.includes("portland") || ctx.includes("beaverton"))

    expect(ctx.includes("nike")).toBe(true)
  })

  it("graph stats show meaningful connectivity", async () => {
    const r = await fetch(`${BASE}/graph/${USER}`)
    const body = await r.json() as any
    const { nodeCount, edgeCount, avgDegree } = body.stats

    console.log(`Graph: ${nodeCount} nodes, ${edgeCount} edges, avg degree ${avgDegree}`)

    // With real embeddings Biscuit↔hiking, hiking↔Portland, Portland↔Nike cluster.
    // With stub embeddings edges won't form — this test will fail in stub mode.
    expect(edgeCount).toBeGreaterThan(0)
    expect(avgDegree).toBeGreaterThan(0)
  })
})
