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

// English stop words — words that appear in nearly every memory and every query.
// Without filtering these out, BM25 scores every memory > 0 against any English
// query (because "the", "user", "what" etc. are everywhere), which defeats the
// precision floor in recall.ts. We keep this list short and conservative —
// content words like "live", "work", "name" stay in.
const BM25_STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "have", "has", "had", "having",
  "i", "you", "he", "she", "it", "we", "they", "me", "us", "them",
  "my", "your", "his", "her", "its", "our", "their",
  "this", "that", "these", "those",
  "what", "which", "who", "whom", "where", "when", "why", "how",
  "and", "or", "but", "if", "then", "else",
  "of", "to", "from", "in", "on", "at", "by", "for", "with", "about",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "up", "down", "out", "over", "under", "again", "further",
  "any", "all", "some", "no", "not", "nor", "only", "own", "same",
  "so", "than", "too", "very", "can", "will", "just", "should", "now",
  "user", "users",  // domain-specific: every memory describes "the user"
])

// Lightweight suffix stripper. Catches the common BM25 mismatches:
// works/work, lives/live, runs/run, working/work, worked/work, cities/city.
// Not a full Porter stemmer — just enough that legitimate factual queries
// don't get gated by the precision floor due to verb-tense / plural mismatch.
function stem(word: string): string {
  if (word.length <= 3) return word
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y"    // cities → city
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3)           // working → work
  if (word.endsWith("ed")  && word.length > 4) return word.slice(0, -2)           // worked → work
  // Strip "es" only when preceded by a sibilant — otherwise just strip "s".
  // teaches/watches/wishes → teach/watch/wish (drop "es").
  // lives/loves/runs → live/love/run (drop only "s") — "lives".slice(-2)="es"
  // would otherwise strip both letters and produce "liv".
  if (word.endsWith("ches") || word.endsWith("shes") || word.endsWith("xes") || word.endsWith("zes")) {
    return word.slice(0, -2)
  }
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) {
    return word.slice(0, -1)                                                      // works → work
  }
  return word
}

const tokenize = (text: string): string[] =>
  text.toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 0 && !BM25_STOP_WORDS.has(t))
    .map(stem)

export function buildAndCacheBM25(userId: string, memories: MemoryDoc[]): BM25Engine {
  const engine = BM25()
  engine.defineConfig({ fldWeights: { value: 1, key: 2 } })
  engine.definePrepTasks([tokenize])
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
