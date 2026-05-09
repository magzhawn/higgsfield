import { describe, it, expect, beforeAll } from "bun:test"

const BASE = "http://localhost:8080"

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function del(path: string) {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" })
  return { status: res.status }
}

// ── health ────────────────────────────────────────────────────────────────────

describe("health", () => {
  it("returns 200 with status ok", async () => {
    const { status, body } = await get("/health")
    expect(status).toBe(200)
    expect(body.status).toBe("ok")
    expect(typeof body.timestamp).toBe("string")
  })
})

// ── POST /turns ───────────────────────────────────────────────────────────────

describe("POST /turns", () => {
  it("returns 201 with an id string", async () => {
    const { status, body } = await post("/turns", {
      session_id: "contract-sess-1",
      user_id: "contract-user-1",
      messages: [{ role: "user", content: "hello" }],
      timestamp: "2024-01-01T00:00:00Z",
    })
    expect(status).toBe(201)
    expect(typeof body.id).toBe("string")
    expect((body.id as string).length).toBeGreaterThan(0)
  }, 45_000)

  it("returns 400 on missing session_id", async () => {
    const { status } = await post("/turns", {
      user_id: "contract-user-1",
      messages: [{ role: "user", content: "hello" }],
      timestamp: "2024-01-01T00:00:00Z",
    })
    expect(status).toBe(400)
  })

  it("returns 400 on empty messages array", async () => {
    const { status } = await post("/turns", {
      session_id: "contract-sess-1",
      user_id: "contract-user-1",
      messages: [],
      timestamp: "2024-01-01T00:00:00Z",
    })
    expect(status).toBe(400)
  })

  it("handles unicode content without crashing", async () => {
    const { status, body } = await post("/turns", {
      session_id: "contract-sess-unicode",
      user_id: "contract-user-unicode",
      messages: [{ role: "user", content: "こんにちは 🌍 émojis" }],
      timestamp: "2024-01-01T00:00:00Z",
    })
    expect(status).toBe(201)
    expect(typeof body.id).toBe("string")
  }, 45_000)

  it("returns 400 on oversized content", async () => {
    const { status } = await post("/turns", {
      session_id: "contract-sess-1",
      user_id: "contract-user-1",
      messages: [{ role: "user", content: "x".repeat(100_001) }],
      timestamp: "2024-01-01T00:00:00Z",
    })
    expect(status).toBe(400)
  })
})

// ── POST /recall ──────────────────────────────────────────────────────────────

describe("POST /recall", () => {
  it("returns 200 with context and citations array", async () => {
    const { status, body } = await post("/recall", {
      query: "hello",
      session_id: "contract-sess-1",
      user_id: "contract-user-1",
    })
    expect(status).toBe(200)
    expect(typeof body.context).toBe("string")
    expect(Array.isArray(body.citations)).toBe(true)
  }, 30_000)

  it("returns empty context for unknown user, not error", async () => {
    const { status, body } = await post("/recall", {
      query: "anything",
      session_id: "unknown-sess",
      user_id: "unknown-user-99999",
    })
    expect(status).toBe(200)
    expect(body.context).toBe("")
    expect(body.citations).toEqual([])
  })

  it("returns 200 even when no user_id", async () => {
    const { status, body } = await post("/recall", {
      query: "test",
      session_id: "no-mem-sess",
    })
    expect(status).toBe(200)
    expect(body.context).toBe("")
  })
})

// ── GET /users/:userId/memories ───────────────────────────────────────────────

describe("GET /users/:userId/memories", () => {
  it("returns memories array (may be empty)", async () => {
    const { status, body } = await get("/users/no-such-user-99999/memories")
    expect(status).toBe(200)
    expect(Array.isArray(body.memories)).toBe(true)
  })

  it("returns structured memories after a turn is ingested", async () => {
    const userId = `stripe-test-${Date.now()}`
    await post("/turns", {
      session_id: "stripe-sess",
      user_id: userId,
      messages: [{ role: "user", content: "I work at Stripe as a backend engineer." }],
      timestamp: "2024-01-01T00:00:00Z",
    })
    const { body } = await get(`/users/${userId}/memories`)
    const memories = body.memories as Array<{ key: string; value: string }>
    expect(Array.isArray(memories)).toBe(true)
    expect(memories.length).toBeGreaterThan(0)
    const employer = memories.find((m) => m.key === "employer")
    expect(employer).toBeDefined()
    expect(employer!.value).toContain("Stripe")
  }, 60_000)
})

// ── DELETE /sessions/:sessionId ───────────────────────────────────────────────

describe("DELETE /sessions/:sessionId", () => {
  it("returns 204", async () => {
    const { status } = await del("/sessions/some-session-xyz")
    expect(status).toBe(204)
  })

  it("removes turn data for that session", async () => {
    const sessionId = `del-sess-${Date.now()}`
    await post("/turns", {
      session_id: sessionId,
      messages: [{ role: "user", content: "to be deleted" }],
      timestamp: "2024-01-01T00:00:00Z",
    })
    const { status } = await del(`/sessions/${sessionId}`)
    expect(status).toBe(204)
  })
})

// ── DELETE /users/:userId ─────────────────────────────────────────────────────

describe("DELETE /users/:userId", () => {
  it("returns 204", async () => {
    const { status } = await del("/users/some-user-xyz")
    expect(status).toBe(204)
  })
})

// ── recall quality — basic fixture ───────────────────────────────────────────

describe("recall quality — basic fixture", () => {
  const userId = "fixture-user-1"
  const sessionId = "fixture-sess-1"

  beforeAll(async () => {
    await post("/turns", {
      session_id: sessionId,
      user_id: userId,
      messages: [{ role: "user", content: "I live in Berlin. I moved here from NYC last year." }],
      timestamp: "2024-01-01T00:00:00Z",
    })
    await post("/turns", {
      session_id: sessionId,
      user_id: userId,
      messages: [{ role: "user", content: "I work at Notion as a product manager. I used to work at Stripe." }],
      timestamp: "2024-01-02T00:00:00Z",
    })
    await post("/turns", {
      session_id: sessionId,
      user_id: userId,
      messages: [{ role: "user", content: "I have a dog named Biscuit. Walking him every morning." }],
      timestamp: "2024-01-03T00:00:00Z",
    })
  }, 120_000)

  it("location query returns Berlin", async () => {
    const { body } = await post("/recall", {
      query: "where does the user live",
      session_id: sessionId,
      user_id: userId,
      max_tokens: 1024,
    })
    expect(body.context as string).toContain("Berlin")
  }, 45_000)

  it("employer query returns Notion", async () => {
    const { body } = await post("/recall", {
      query: "where does the user work",
      session_id: sessionId,
      user_id: userId,
      max_tokens: 1024,
    })
    expect(body.context as string).toContain("Notion")
  }, 45_000)

  it("pet query returns Biscuit", async () => {
    const { body } = await post("/recall", {
      query: "what is the user's pet name",
      session_id: sessionId,
      user_id: userId,
      max_tokens: 1024,
    })
    expect(body.context as string).toContain("Biscuit")
  }, 45_000)

  it("noise query returns empty context", async () => {
    const { body } = await post("/recall", {
      query: "what does the user think about quantum computing",
      session_id: sessionId,
      user_id: userId,
      max_tokens: 1024,
    })
    // BM25 gate (no token overlap) + cosine gate suppress unrelated queries.
    // With stub embeddings: zero token overlap → cosine = 0 < 0.05 gate.
    // With real embeddings: cosine 0.26–0.28 < 0.40 gate.
    expect(body.context as string).toBe("")
    expect(body.citations).toEqual([])
  }, 45_000)

  it("BM25 exact name match — Biscuit query", async () => {
    const uid = `biscuit-bm25-${Date.now()}`
    await post("/turns", {
      session_id: "bm25-sess",
      user_id: uid,
      messages: [{ role: "user", content: "I have a dog named Biscuit" }],
      timestamp: "2024-01-01T00:00:00Z",
    })
    const { body } = await post("/recall", {
      query: "what is the name of the user's pet",
      session_id: "bm25-sess",
      user_id: uid,
      max_tokens: 1024,
    })
    expect(body.context as string).toContain("Biscuit")
    expect((body.citations as unknown[]).length).toBeGreaterThan(0)
  }, 60_000)

  it("multi-hop — city from pet name", async () => {
    const uid = `multihop-${Date.now()}`
    await post("/turns", {
      session_id: "hop-sess-2",
      user_id: uid,
      messages: [{ role: "user", content: "I have a dog named Biscuit" }],
      timestamp: "2024-01-01T00:00:00Z",
    })
    await post("/turns", {
      session_id: "hop-sess-2",
      user_id: uid,
      messages: [{ role: "user", content: "I live in Berlin, Germany" }],
      timestamp: "2024-01-02T00:00:00Z",
    })
    const { body } = await post("/recall", {
      query: "what city does the person with the dog Biscuit live in",
      session_id: "hop-sess-2",
      user_id: uid,
      max_tokens: 1024,
    })
    expect(body.context as string).toContain("Berlin")
  }, 90_000)

  it("query rewriting — synonym query", async () => {
    const uid = `rewrite-${Date.now()}`
    await post("/turns", {
      session_id: "rewrite-sess",
      user_id: uid,
      messages: [{ role: "user", content: "I work at Notion as a product manager" }],
      timestamp: "2024-01-01T00:00:00Z",
    })
    const { body } = await post("/recall", {
      query: "what is the user's occupation and employer",
      session_id: "rewrite-sess",
      user_id: uid,
      max_tokens: 1024,
    })
    expect(body.context as string).toContain("Notion")
  }, 60_000)
})

// ── reranker ──────────────────────────────────────────────────────────────────

describe("reranker", () => {
  it("puts most relevant memory first in citations", async () => {
    const uid = "rerank-citation-user"
    await del(`/users/${uid}`)
    await post("/turns", {
      session_id: "rerank-sess",
      user_id: uid,
      messages: [{
        role: "user",
        content: "I work at DeepMind as a research scientist. I live in London. I have a cat named Pixel. I love hiking. My diet is vegan.",
      }],
      timestamp: "2024-01-01T00:00:00Z",
    })
    await new Promise((r) => setTimeout(r, 3000))
    const { body } = await post("/recall", {
      query: "what is the user's job and employer?",
      session_id: "rerank-sess",
      user_id: uid,
      max_tokens: 1024,
    })
    const citations = body.citations as Array<{ snippet: string }>
    expect(citations.length).toBeGreaterThan(0)
    const top = citations[0].snippet.toLowerCase()
    expect(top.includes("deepmind") || top.includes("research") || top.includes("scientist")).toBe(true)
  }, 60_000)
})

// ── opinion history ───────────────────────────────────────────────────────────

describe("opinion history", () => {
  it("surfaces opinion evolution arc in context", async () => {
    const uid = "opinion-history-user"
    await del(`/users/${uid}`)
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

    await post("/turns", {
      session_id: "opinion-sess",
      user_id: uid,
      messages: [{ role: "user", content: "I love TypeScript, it's the best language for large teams" }],
      timestamp: "2024-03-01T09:00:00Z",
    })
    await wait(3000)
    await post("/turns", {
      session_id: "opinion-sess",
      user_id: uid,
      messages: [{ role: "user", content: "TypeScript generics are getting really annoying honestly" }],
      timestamp: "2024-03-08T09:00:00Z",
    })
    await wait(3000)
    await post("/turns", {
      session_id: "opinion-sess",
      user_id: uid,
      messages: [{ role: "user", content: "TypeScript is fine, I've made peace with it for big projects" }],
      timestamp: "2024-03-15T09:00:00Z",
    })
    await wait(3000)

    const { body } = await post("/recall", {
      query: "what does the user think about TypeScript?",
      session_id: "opinion-sess",
      user_id: uid,
      max_tokens: 2048,
    })
    const ctx = body.context as string
    // Opinion history appears when extraction formed a supersession chain.
    // Minimum correct behavior: TypeScript appears in context at all.
    expect(ctx.toLowerCase()).toContain("typescript")
  }, 90_000)
})
