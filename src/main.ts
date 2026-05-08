import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { initDb, q, db } from "./db"
import {
  TurnRequestSchema,
  RecallRequestSchema,
  SearchRequestSchema,
} from "./models"
import { errorHandler, payloadSizeMiddleware, authMiddleware } from "./middleware"
import { extractMemories } from "./extraction"
import { recall } from "./recall"
import { embed, unpack, cosineSimilarity } from "./embeddings"
import { invalidateUser } from "./cache"

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
    if (body.user_id) {
      await extractMemories(id, body.user_id, body.session_id, body.messages)
      invalidateUser(body.user_id)
    }
    console.log(`[turns] extraction done in ${(performance.now() - t0).toFixed(0)}ms`)
    console.log(`[turns] total ${(performance.now() - t0).toFixed(0)}ms`)
    return c.json({ id }, 201)
  } catch (err) {
    console.error(err)
    return c.json({ error: "internal error" }, 500)
  }
})

app.post("/recall", zValidator("json", RecallRequestSchema), async (c) => {
  try {
    const t0 = performance.now()
    const { query, user_id, max_tokens } = c.req.valid("json")
    if (!user_id) return c.json({ context: "", citations: [] })
    const { context, citations } = await recall(query, user_id, max_tokens)
    console.log(`[recall] ${(performance.now() - t0).toFixed(0)}ms`)
    return c.json({ context, citations })
  } catch (err) {
    console.error(err)
    return c.json({ context: "", citations: [] })
  }
})

app.post("/search", zValidator("json", SearchRequestSchema), async (c) => {
  try {
    const { query, user_id, session_id, limit } = c.req.valid("json")
    if (!user_id && !session_id) return c.json({ results: [] })

    const queryVec = await embed(query, "query")

    type MemRow = {
      id: string; value: string; session_id: string; created_at: string
      metadata: string; turn_id: string; vector: Buffer | null
    }

    let memories: MemRow[]
    if (user_id) {
      memories = q.getMemoriesByUser(user_id) as MemRow[]
    } else {
      memories = db.query(`
        SELECT m.*, e.vector
        FROM memories m
        LEFT JOIN embeddings e ON e.memory_id = m.id
        WHERE m.session_id = ? AND m.active = 1
        ORDER BY m.created_at DESC
      `).all(session_id as string) as MemRow[]
    }

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

// ── Startup ───────────────────────────────────────────────────────────────────

initDb()
console.log("Memory service ready on :8080")

export default {
  port: 8080,
  fetch: app.fetch,
}
