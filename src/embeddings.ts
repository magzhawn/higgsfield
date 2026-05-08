import { VoyageAIClient } from "voyageai"
import { q } from "./db"

const embedCache = new Map<string, Float32Array>()

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

export async function batchEmbedAndStore(
  items: Array<{ memoryId: string; value: string }>
): Promise<void> {
  if (items.length === 0) return
  if (!process.env.VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY not configured")

  const texts = items.map((i) => i.value)
  const response = await voyageEmbed(texts, "document")

  const data = response.data ?? []
  for (let i = 0; i < items.length; i++) {
    const raw = data[i]?.embedding
    if (!raw || raw.length === 0) continue
    const vec = normalize(new Float32Array(raw))
    const cacheKey = `document:${items[i].value}`
    if (embedCache.size >= 5000) embedCache.clear()
    embedCache.set(cacheKey, vec)
    q.insertEmbedding.run({
      $id: crypto.randomUUID(),
      $memory_id: items[i].memoryId,
      $vector: pack(vec),
    })
  }
}
