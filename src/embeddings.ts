import { VoyageAIClient } from "voyageai"
import { q } from "./db"
import { buildAssociations } from "./graph"

const embedCache = new Map<string, Float32Array>()

// ── Stub embedder (EMBED_STUB=1) ──────────────────────────────────────────────
// Hash-based bag-of-words vectors for fast, API-free tests.
// Stop words and 4-char prefix stemming ensure keyword overlap drives cosine.

const STUB_STOPS = new Set([
  "a","an","the","in","on","at","to","of","for","and","or","is","was","are",
  "were","be","been","being","have","has","had","what","where","when","who",
  "how","why","does","did","do","i","my","me","you","your","we","our","they",
  "their","it","its","this","that","these","those","user","users","s","about",
  "with","from","by","as","not","just","really","so","such","now","then",
  "here","there","get","got","went","go","up","out","if","but","no","so",
])

function fnv(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

// 2048 dims + weight=1 keeps single-collision cosine ≈ 0.17, well below the
// 0.20 stub gate, while genuine prefix-stem overlap produces cosine ≥ 0.35.
const STUB_DIMS = 2048

function stubEmbed(text: string): Float32Array {
  const vec = new Float32Array(STUB_DIMS)
  const tokens = text.toLowerCase().split(/\W+/).filter((t) => t.length > 1 && !STUB_STOPS.has(t))
  for (const token of tokens) {
    vec[fnv(token) % STUB_DIMS] += 1
    if (token.length > 4) vec[fnv(token.slice(0, 4)) % STUB_DIMS] += 1
  }
  return normalize(vec)
}

function getClient(): VoyageAIClient {
  if (!process.env.VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY not configured")
  return new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function voyageEmbed(
  input: string | string[],
  type: "document" | "query"
) {
  const client = getClient()
  const delays = [21_000, 42_000, 63_000]
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.embed({ input, model: "voyage-3-lite", inputType: type })
    } catch (err: any) {
      if (err?.statusCode === 429 && attempt < delays.length) {
        console.warn(`Voyage AI 429 — retrying in ${delays[attempt] / 1000}s`)
        await sleep(delays[attempt])
        continue
      }
      throw err
    }
  }
}

export async function embed(
  text: string,
  type: "document" | "query" = "document"
): Promise<Float32Array> {
  if (process.env.EMBED_STUB) return stubEmbed(text)

  const cacheKey = `${type}:${text}`
  const cached = embedCache.get(cacheKey)
  if (cached) return cached

  const response = await voyageEmbed(text, type)

  const raw = response.data?.[0]?.embedding
  if (!raw || raw.length === 0) throw new Error("Voyage AI returned empty embedding")

  const vec = normalize(new Float32Array(raw))

  if (embedCache.size >= 5000) embedCache.clear()
  embedCache.set(cacheKey, vec)

  return vec
}

function normalize(vec: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm)
  if (norm === 0) return vec
  for (let i = 0; i < vec.length; i++) vec[i] /= norm
  return vec
}

export function pack(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer)
}

export function unpack(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.length / 4)
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

export async function embedAndStore(memoryId: string, value: string): Promise<void> {
  const vec = await embed(value, "document")
  const vector = pack(vec)
  q.insertEmbedding.run({ $id: crypto.randomUUID(), $memory_id: memoryId, $vector: vector })
}

function insertEmbedding(memoryId: string, vec: Float32Array): void {
  const cacheKey = `document:${memoryId}`
  if (embedCache.size >= 5000) embedCache.clear()
  embedCache.set(cacheKey, vec)
  q.insertEmbedding.run({ $id: crypto.randomUUID(), $memory_id: memoryId, $vector: pack(vec) })
}

export async function batchEmbedAndStore(
  items: Array<{ memoryId: string; value: string }>,
  userId: string
): Promise<void> {
  if (items.length === 0) return

  if (process.env.EMBED_STUB) {
    for (const { memoryId, value } of items) {
      insertEmbedding(memoryId, stubEmbed(value))
    }
    console.log(`[embed] ${items.length}/${items.length} memories embedded (stub)`)
    return
  }

  if (!process.env.VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY not configured")

  let successCount = 0
  const memoryIds = items.map((i) => i.memoryId)

  // Happy path: one batch call for all items
  try {
    const response = await voyageEmbed(items.map((i) => i.value), "document")
    const data = response.data ?? []
    if (data.length === items.length) {
      for (let i = 0; i < items.length; i++) {
        const raw = data[i]?.embedding
        if (!raw || raw.length === 0) continue
        insertEmbedding(items[i].memoryId, normalize(new Float32Array(raw)))
        successCount++
      }
      console.log(`[embed] ${successCount}/${items.length} memories embedded`)
      if (successCount > 0) buildAssociations(memoryIds, userId)
      return
    }
    console.warn(`Batch embed returned ${data.length}/${items.length} results, falling back to per-item`)
  } catch (batchErr: any) {
    console.warn("Batch embed failed, falling back to per-item:", batchErr.message)
  }

  // Per-item fallback — each memory gets its own attempt with retry
  for (const { memoryId, value } of items) {
    let retries = 2
    while (retries >= 0) {
      try {
        const vec = await embed(value, "document")
        insertEmbedding(memoryId, vec)
        successCount++
        break
      } catch (err: any) {
        if (err?.statusCode === 429 && retries > 0) {
          const wait = (3 - retries) * 21_000
          console.warn(`429 on embed for ${memoryId}, waiting ${wait / 1000}s`)
          await sleep(wait)
          retries--
        } else {
          console.error(`Failed to embed memory ${memoryId} after retries:`, err.message)
          break
        }
      }
    }
  }

  console.log(`[embed] ${successCount}/${items.length} memories embedded`)
  if (successCount > 0) buildAssociations(memoryIds, userId)
}
