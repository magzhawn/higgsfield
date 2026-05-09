// @ts-ignore — no types published for wink-bm25-text-search
import BM25 from "wink-bm25-text-search"

type BM25Engine = ReturnType<typeof BM25>

interface MemoryDoc {
  id: string
  value: string
  key: string
}

const embedCache = new Map<string, Float32Array>()
const memoriesCache = new Map<string, any[]>()
const bm25Cache = new Map<string, BM25Engine>()
const graphCache = new Map<string, Map<string, number>>()

export function getCachedEmbed(text: string): Float32Array | null {
  return embedCache.get(text) ?? null
}

export function setCachedEmbed(text: string, vec: Float32Array): void {
  if (embedCache.size >= 5000) embedCache.clear()
  embedCache.set(text, vec)
}

export function getCachedMemories(userId: string): any[] | null {
  return memoriesCache.get(userId) ?? null
}

export function setCachedMemories(userId: string, memories: any[]): void {
  memoriesCache.set(userId, memories)
}

export function getCachedBM25(userId: string): BM25Engine | null {
  return bm25Cache.get(userId) ?? null
}

export function setCachedBM25(userId: string, index: BM25Engine): void {
  bm25Cache.set(userId, index)
}

export function getCachedNeighbors(memoryId: string): Map<string, number> | null {
  return graphCache.get(memoryId) ?? null
}

export function setCachedNeighbors(memoryId: string, neighbors: Map<string, number>): void {
  graphCache.set(memoryId, neighbors)
}

export function invalidateUser(userId: string): void {
  memoriesCache.delete(userId)
  bm25Cache.delete(userId)
  // graph cache is keyed by memoryId, not userId — clear all (small, rebuilt quickly)
  graphCache.clear()
}

export function buildAndCacheBM25(userId: string, memories: MemoryDoc[]): BM25Engine {
  const engine = BM25()
  engine.defineConfig({ fldWeights: { value: 1, key: 2 } })
  engine.definePrepTasks([
    (text: string) => text.toLowerCase().split(/\W+/).filter(Boolean),
  ])
  for (const mem of memories) {
    engine.addDoc({ value: mem.value, key: mem.key }, mem.id)
  }
  // wink-bm25 requires at least 3 documents to consolidate
  for (let i = memories.length; i < 3; i++) {
    engine.addDoc({ value: `__pad__${i}`, key: "__pad__" }, `__pad__${i}`)
  }
  engine.consolidate()
  setCachedBM25(userId, engine)
  return engine
}
