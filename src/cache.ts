const embedCache = new Map<string, Float32Array>()
const memoriesCache = new Map<string, any[]>()
const bm25Cache = new Map<string, any>()

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

export function getCachedBM25(userId: string): any | null {
  return bm25Cache.get(userId) ?? null
}

export function setCachedBM25(userId: string, index: any): void {
  bm25Cache.set(userId, index)
}

export function invalidateUser(userId: string): void {
  memoriesCache.delete(userId)
  bm25Cache.delete(userId)
}
