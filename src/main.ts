import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { initDb, q, db } from "./db"
import openapiSpec from "../openapi.json"
import {
  TurnRequestSchema,
  RecallRequestSchema,
  SearchRequestSchema,
} from "./models"
import { errorHandler, payloadSizeMiddleware, authMiddleware } from "./middleware"
import { extractMemories } from "./extraction"
import { recall, searchMemories } from "./recall"
import { embed, unpack, cosineSimilarity } from "./embeddings"
import { invalidateUser } from "./cache"
import { deriveMemories } from "./derived"

const app = new Hono()

app.use("*", payloadSizeMiddleware)
app.use("*", authMiddleware)
errorHandler(app)

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() })
})

app.post("/turns", zValidator("json", TurnRequestSchema), async (c) => {
  try {
    const t0 = performance.now()
    const body = c.req.valid("json")
    const id = crypto.randomUUID()
    q.insertTurn.run({
      $id: id,
      $session_id: body.session_id,
      $user_id: body.user_id ?? null,
      $messages: JSON.stringify(body.messages),
      $timestamp: body.timestamp,
      $metadata: JSON.stringify(body.metadata),
    })
    console.log(`[turns] persisted in ${(performance.now() - t0).toFixed(0)}ms`)
    let memoryIds: string[] = []
    if (body.user_id) {
      memoryIds = await extractMemories(id, body.user_id, body.session_id, body.messages)
      invalidateUser(body.user_id)
    }
    console.log(`[turns] extraction done in ${(performance.now() - t0).toFixed(0)}ms`)
    console.log(`[turns] total ${(performance.now() - t0).toFixed(0)}ms`)

    // Fire-and-forget derivation — never awaited, never blocks the 201.
    // setTimeout(0) hands off after the response is queued. Derived state
    // is read directly from derived_memories at recall time, so no cache
    // invalidation is needed when this completes.
    if (body.user_id && !process.env.EMBED_STUB) {
      const userId = body.user_id
      setTimeout(() => {
        deriveMemories(userId, memoryIds).catch((err) =>
          console.error("[derived] background derivation error:", err?.message ?? err),
        )
      }, 0)
    }

    return c.json({ id }, 201)
  } catch (err) {
    console.error(err)
    return c.json({ error: "internal error" }, 500)
  }
})

app.post("/recall", zValidator("json", RecallRequestSchema), async (c) => {
  try {
    const t0 = performance.now()
    const {
      query, user_id, max_tokens,
      disable_graph, disable_derived,
      disable_rewrite, disable_entities, disable_rerank,
    } = c.req.valid("json")
    if (!user_id) return c.json({ context: "", citations: [] })
    const { context, citations, timings } = await recall(
      query, user_id, max_tokens,
      disable_graph, disable_derived,
      disable_rewrite, disable_entities, disable_rerank,
    )
    console.log(`[recall] ${(performance.now() - t0).toFixed(0)}ms`)
    return c.json({ context, citations, timings })
  } catch (err) {
    console.error(err)
    return c.json({ context: "", citations: [] })
  }
})

app.post("/search", zValidator("json", SearchRequestSchema), async (c) => {
  try {
    const { query, user_id, session_id, limit } = c.req.valid("json")
    if (!user_id && !session_id) return c.json({ results: [] })

    if (user_id) {
      const ranked = await searchMemories(query, user_id, limit)
      const results = ranked.map(({ memory: m, rrfScore }) => ({
        content: m.value,
        score: rrfScore,
        session_id: m.session_id,
        timestamp: m.created_at,
        metadata: (() => { try { return JSON.parse(m.metadata ?? "{}") } catch { return {} } })(),
      }))
      return c.json({ results })
    }

    // session-only search: cosine only (no BM25 index for session scope)
    const queryVec = await embed(query, "query")
    type MemRow = { id: string; value: string; session_id: string; created_at: string; metadata: string; vector: Buffer | null }
    const memories = db.query(`
      SELECT m.*, e.vector
      FROM memories m
      LEFT JOIN embeddings e ON e.memory_id = m.id
      WHERE m.session_id = ? AND m.active = 1
      ORDER BY m.created_at DESC
    `).all(session_id as string) as MemRow[]

    const results = memories
      .map((m) => ({
        content: m.value,
        score: m.vector ? cosineSimilarity(queryVec, unpack(m.vector)) : 0,
        session_id: m.session_id,
        timestamp: m.created_at,
        metadata: (() => { try { return JSON.parse(m.metadata) } catch { return {} } })(),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    return c.json({ results })
  } catch (err) {
    console.error(err)
    return c.json({ results: [] })
  }
})

app.get("/users/:userId/memories", async (c) => {
  try {
    const { userId } = c.req.param()
    const rows = db.query(
      "SELECT * FROM memories WHERE user_id = ? ORDER BY created_at DESC"
    ).all(userId) as Array<{
      id: string; type: string; key: string; value: string
      confidence: number; session_id: string; turn_id: string
      created_at: string; updated_at: string; supersedes: string | null
      active: number
    }>
    const memories = rows.map((r) => ({
      id: r.id,
      type: r.type,
      key: r.key,
      value: r.value,
      confidence: r.confidence,
      source_session: r.session_id,
      source_turn: r.turn_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      supersedes: r.supersedes,
      active: r.active === 1,
    }))
    return c.json({ memories })
  } catch (err) {
    console.error(err)
    return c.json({ error: "internal error" }, 500)
  }
})

app.delete("/sessions/:sessionId", async (c) => {
  try {
    const { sessionId } = c.req.param()
    q.deleteSession(sessionId)
    return c.body(null, 204)
  } catch (err) {
    console.error(err)
    return c.json({ error: "internal error" }, 500)
  }
})

app.delete("/users/:userId", async (c) => {
  try {
    const { userId } = c.req.param()
    q.deleteUser(userId)
    invalidateUser(userId)
    return c.body(null, 204)
  } catch (err) {
    console.error(err)
    return c.json({ error: "internal error" }, 500)
  }
})

app.get("/users/:userId/derived", async (c) => {
  try {
    const { userId } = c.req.param()
    const derived = q.getDerivedByUser.all({ $user_id: userId })
    return c.json({ derived_memories: derived })
  } catch (err) {
    console.error("Derived memories fetch error:", err)
    return c.json({ derived_memories: [] })
  }
})

app.get("/graph/:userId", async (c) => {
  const { userId } = c.req.param()
  try {
    const { getGraphStats } = await import("./graph")
    const stats = getGraphStats(userId)
    const topAssociations = db.query(`
      SELECT m1.key as source_key, m1.value as source_value,
             m2.key as target_key, m2.value as target_value, a.strength
      FROM memory_associations a
      JOIN memories m1 ON m1.id = a.source_id
      JOIN memories m2 ON m2.id = a.target_id
      WHERE m1.user_id = $user_id
      ORDER BY a.strength DESC
      LIMIT 20
    `).all({ $user_id: userId })
    return c.json({ stats, top_associations: topAssociations })
  } catch (err) {
    console.error("Graph stats error:", err)
    return c.json({ stats: { nodeCount: 0, edgeCount: 0, avgDegree: 0 }, top_associations: [] })
  }
})

app.post("/graph/:userId/rebuild", async (c) => {
  const { userId } = c.req.param()
  try {
    const { rebuildGraph } = await import("./graph")
    const result = await rebuildGraph(userId)
    return c.json({ rebuilt: true, userId, ...result })
  } catch (err: any) {
    console.error("Graph rebuild error:", err)
    return c.json({ error: "rebuild failed" }, 500)
  }
})

app.get("/openapi.json", (c) => c.json(openapiSpec))

app.get("/docs", (c) =>
  c.html(`<!DOCTYPE html>
<html>
  <head>
    <title>Memory Service API</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"/>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.onload = () => SwaggerUIBundle({ url: "/openapi.json", dom_id: "#swagger-ui", deepLinking: true })
    </script>
  </body>
</html>`)
)

// ── Startup ───────────────────────────────────────────────────────────────────

initDb()
console.log("Memory service ready on :8080")

export default {
  port: 8080,
  fetch: app.fetch,
}
