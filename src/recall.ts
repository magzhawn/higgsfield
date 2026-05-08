import { q } from "./db"
import { embed, unpack, cosineSimilarity } from "./embeddings"
import { getCachedMemories, setCachedMemories } from "./cache"
import type { Citation } from "./models"

const IDENTITY_KEYS = new Set([
  "employer", "location", "role", "diet", "pet_name", "pet_type",
  "relationship_status", "health_condition",
])

const OVERHEAD = 60
const TIER1_FLOOR = 0.10

interface MemoryRow {
  id: string
  turn_id: string
  type: string
  key: string
  value: string
  confidence: number
  session_id: string
  created_at: string
  vector: Buffer | null
}

export function countTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3)
}

export async function recall(
  query: string,
  userId: string,
  maxTokens: number
): Promise<{ context: string; citations: Citation[] }> {
  // Step 1 — fetch memories (use cache)
  let memories = getCachedMemories(userId) as MemoryRow[] | null
  if (!memories) {
    memories = q.getMemoriesByUser(userId) as MemoryRow[]
    setCachedMemories(userId, memories)
  }
  if (memories.length === 0) return { context: "", citations: [] }

  // Step 2 — embed query
  const queryVec = await embed(query, "query")

  // Step 3 — score by cosine similarity, keep top 20
  const scored = memories
    .map((m) => ({
      memory: m,
      score: m.vector ? cosineSimilarity(queryVec, unpack(m.vector)) : 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)

  // Step 4 — token budget assembly
  const tier1: typeof scored = []
  const tier2: typeof scored = []

  for (const item of scored) {
    const { memory } = item
    if (
      (memory.type === "fact" || memory.type === "preference") &&
      IDENTITY_KEYS.has(memory.key) &&
      item.score > TIER1_FLOOR
    ) {
      tier1.push(item)
    } else if (item.score > 0.15) {
      tier2.push(item)
    }
  }

  // TODO: TIER 3 — recent turns (not implemented in v1)

  let used = OVERHEAD
  const tier1Lines: string[] = []
  const tier2Lines: string[] = []
  const citations: Citation[] = []

  function tryAdd(item: (typeof scored)[0], lines: string[]): boolean {
    const { memory, score } = item
    const date = memory.created_at.slice(0, 10)
    const line = `- [${date}] ${memory.key}: ${memory.value}`
    const tokens = countTokens(line)

    if (used + tokens <= maxTokens) {
      lines.push(line)
      citations.push({
        turn_id: memory.turn_id,
        score: Math.round(score * 10000) / 10000,
        snippet: memory.value.slice(0, 120),
      })
      used += tokens
      return true
    }

    if (maxTokens - used > 20) {
      const prefix = `- [${date}] ${memory.key}: `
      const budget = maxTokens - used - countTokens(prefix) - countTokens("[truncated]")
      const words = memory.value.split(" ")
      let truncated = ""
      for (const word of words) {
        const candidate = truncated ? `${truncated} ${word}` : word
        if (countTokens(candidate) > budget) break
        truncated = candidate
      }
      lines.push(`${prefix}${truncated} [truncated]`)
      citations.push({
        turn_id: memory.turn_id,
        score: Math.round(score * 10000) / 10000,
        snippet: memory.value.slice(0, 120),
      })
    }

    return false
  }

  for (const item of tier1) {
    if (!tryAdd(item, tier1Lines)) break
  }

  for (const item of tier2) {
    if (!tryAdd(item, tier2Lines)) break
  }

  // Step 5 — format output
  if (tier1Lines.length === 0 && tier2Lines.length === 0) {
    return { context: "", citations: [] }
  }

  let context = ""
  if (tier1Lines.length > 0) {
    context = "## Known facts about this user\n" + tier1Lines.join("\n")
  }
  if (tier2Lines.length > 0) {
    const section = "## Relevant memories\n" + tier2Lines.join("\n")
    context = context ? `${context}\n\n${section}` : section
  }

  return { context, citations }
}
