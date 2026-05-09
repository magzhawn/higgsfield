import Anthropic from "@anthropic-ai/sdk"
import { spreadActivation } from "./graph"
import { q } from "./db"
import { embed, unpack, cosineSimilarity } from "./embeddings"
import { getCachedMemories, setCachedMemories, getCachedBM25, buildAndCacheBM25 } from "./cache"
import { getDerivedContext, getDerivedBoosts } from "./derived"
import type { Citation } from "./models"

const IDENTITY_KEYS = new Set([
  "employer", "location", "role", "diet", "pet_name", "pet_type",
  "relationship_status", "health_condition",
])

const OVERHEAD = 60
const BM25_GATE = 0          // any BM25 score (> 0) qualifies
const RERANK_THRESHOLD = 3   // skip reranker for tiny candidate sets

export interface MemoryRow {
  id: string
  turn_id: string
  type: string
  key: string
  value: string
  confidence: number
  session_id: string
  created_at: string
  metadata?: string
  vector: Buffer | null
}

export type RankedMemory = MemoryRow & { rrfScore: number; rerankerScore?: number }

export function countTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3)
}

async function haiku(prompt: string, maxTokens = 200) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  })
}

async function rewriteQuery(query: string): Promise<string[]> {
  try {
    const resp = await haiku(`
You are a search query expander for a personal memory system.
Given a user query, generate 2 alternative search queries that would
help find relevant memories using different vocabulary.

Original query: "${query}"

Return ONLY valid JSON, no markdown:
{"queries": ["alternative 1", "alternative 2"]}

Rules:
- Keep alternatives short (3-7 words)
- Use different words than the original
- Think about what FACTS would answer this query
- Example: "where does user live" → ["city location home", "moved to lives in"]
`)
    const block = resp.content[0]
    if (block.type !== "text") return [query]
    const text = block.text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim()
    const parsed = JSON.parse(text)
    return [query, ...parsed.queries].slice(0, 3)
  } catch {
    return [query]
  }
}

async function extractEntities(
  topMemories: Array<{ value: string; key: string }>
): Promise<string[]> {
  if (topMemories.length === 0) return []
  try {
    const memoryText = topMemories.map((m) => m.value).join("; ")
    const resp = await haiku(`
Extract specific named entities from these memory values.
Return only proper nouns: names of people, places, pets, companies.
Do not return generic words.

Memories: "${memoryText}"

Return ONLY valid JSON: {"entities": ["entity1", "entity2"]}
Max 4 entities. If none found: {"entities": []}
`)
    const block = resp.content[0]
    if (block.type !== "text") return []
    const text = block.text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim()
    const parsed = JSON.parse(text)
    return parsed.entities.slice(0, 4)
  } catch {
    return []
  }
}

async function rerank(
  query: string,
  candidates: RankedMemory[]
): Promise<RankedMemory[]> {
  if (candidates.length <= RERANK_THRESHOLD) return candidates

  const prompt = `
You are ranking memory snippets by relevance to a user query.
Query: "${query}"

Rate each memory 1-5 (5 = directly answers the query):
${candidates.slice(0, 10).map((m, i) => `${i}. "${m.value}"`).join("\n")}

Return ONLY valid JSON:
{"rankings": [{"index": 0, "score": 5}, {"index": 1, "score": 3}, ...]}
All indices must appear. Scores 1-5.
`

  try {
    const resp = await haiku(prompt, 400)
    const block = resp.content[0]
    if (block.type !== "text") return candidates
    const text = block.text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim()
    const data = JSON.parse(text)
    const scoreMap = new Map<number, number>(
      data.rankings.map((r: { index: number; score: number }) => [r.index, r.score])
    )
    return [
      ...candidates
        .slice(0, 10)
        .map((m, i) => ({ ...m, rerankerScore: scoreMap.get(i) ?? 1 }))
        .sort((a, b) => (b.rerankerScore ?? 0) - (a.rerankerScore ?? 0)),
      ...candidates.slice(10),
    ]
  } catch {
    return candidates
  }
}

function rrf(
  bm25Results: Array<{ id: string; score: number }>,
  cosineResults: Array<{ id: string; score: number }>,
  k = 60
): Map<string, number> {
  const scores = new Map<string, number>()
  const add = (results: Array<{ id: string }>) => {
    results.forEach((r, rank) => {
      scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + rank + 1))
    })
  }
  add(bm25Results)
  add(cosineResults)
  return scores
}

function fetchOpinionHistory(
  activeOpinions: RankedMemory[],
  allMemories: MemoryRow[]
): Map<string, MemoryRow[]> {
  const history = new Map<string, MemoryRow[]>()

  for (const opinion of activeOpinions) {
    const chain: MemoryRow[] = []
    let cursor = (opinion as any).supersedes as string | null

    while (cursor) {
      const ancestor = allMemories.find((m) => m.id === cursor)
      if (!ancestor) break
      chain.push(ancestor)
      cursor = (ancestor as any).supersedes as string | null
    }

    if (chain.length > 0) history.set(opinion.id, chain)
  }

  return history
}

export async function recall(
  query: string,
  userId: string,
  maxTokens: number,
  disableGraph = false,
  disableDerived = false,
  disableRewrite = false,
  disableEntities = false,
  disableRerank = false,
): Promise<{ context: string; citations: Citation[]; timings: Record<string, number> }> {
  const timings: Record<string, number> = {}
  const tStart = performance.now()
  // Step 1 — fetch memories (use cache)
  const tFetch = performance.now()
  let memories = getCachedMemories(userId) as MemoryRow[] | null
  if (!memories) {
    memories = q.getMemoriesByUser(userId) as MemoryRow[]
    setCachedMemories(userId, memories)
  }
  timings.fetch_ms = performance.now() - tFetch
  if (memories.length === 0) return { context: "", citations: [], timings }

  // Reserve up to 20% of the token budget for the derived "User profile"
  // section. Computed up front so tier1/tier2 budget fill knows the cap.
  let derivedSection = ""
  let derivedTokens = 0
  const tDerivedCtx = performance.now()
  if (!disableDerived && !process.env.EMBED_STUB) {
    const DERIVED_BUDGET = Math.floor(maxTokens * 0.20)
    const { text, tokenCount } = getDerivedContext(userId, DERIVED_BUDGET)
    derivedSection = text
    derivedTokens = tokenCount
  }
  timings.derived_ctx_ms = performance.now() - tDerivedCtx

  const memoryCount = memories.length
  const COSINE_GATE = process.env.EMBED_STUB ? 0.20 : memoryCount > 20 ? 0.45 : 0.40

  // Best-effort embed: 5s timeout prevents 429 retry waits from blocking recall.
  // Under rate pressure, rewrite variants and entity hops are skipped gracefully.
  const embedBestEffort = (text: string): Promise<Float32Array | null> =>
    Promise.race([
      embed(text, "query").catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ])

  // Step 2 — rewrite query into multiple angles, embed all variants
  // Stub mode skips rewriting: LLM-generated variants can accidentally match
  // BM25 tokens in memories, making the noise test non-deterministic.
  const tRewrite = performance.now()
  const queries =
    disableRewrite || process.env.EMBED_STUB ? [query] : await rewriteQuery(query)
  timings.rewrite_ms = performance.now() - tRewrite
  // Original query embeds with full retry — must succeed for recall to work.
  // Rewrite variants use best-effort: skipped gracefully under rate pressure.
  const tEmbed = performance.now()
  const primaryVec = await embed(queries[0], "query")
  const rewriteVecs = (
    await Promise.all(queries.slice(1).map(embedBestEffort))
  ).filter(Boolean) as Float32Array[]
  const queryVecs = [primaryVec, ...rewriteVecs]
  timings.embed_ms = performance.now() - tEmbed

  // Step 3a — BM25 scoring across all query variants, keep highest score per memory.
  // Also track scores from the ORIGINAL query alone for the precision floor —
  // rewrite variants are for retrieval recall, not for deciding whether the
  // user's actual question deserves an answer at all.
  const tBm25 = performance.now()
  let bm25Engine = getCachedBM25(userId)
  if (!bm25Engine) bm25Engine = buildAndCacheBM25(userId, memories)

  const bm25Map = new Map<string, number>()
  let originalMaxBm25 = 0
  for (let qi = 0; qi < queries.length; qi++) {
    const raw = bm25Engine.search(queries[qi], memories.length) as Array<[string, number]>
    for (const [id, score] of raw) {
      if ((bm25Map.get(id) ?? 0) < score) bm25Map.set(id, score)
      if (qi === 0 && score > originalMaxBm25) originalMaxBm25 = score
    }
  }
  const bm25Scored = Array.from(bm25Map.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
  timings.bm25_ms = performance.now() - tBm25

  // Step 3b — cosine scoring across all query variants. Same dual tracking:
  // overall best for retrieval, original-query best for the precision floor.
  const tCosine = performance.now()
  const cosineMap = new Map<string, number>()
  let originalMaxCosine = 0
  for (let qi = 0; qi < queryVecs.length; qi++) {
    const qVec = queryVecs[qi]
    for (const m of memories.filter((m) => m.vector)) {
      const s = cosineSimilarity(qVec, unpack(m.vector!))
      if ((cosineMap.get(m.id) ?? 0) < s) cosineMap.set(m.id, s)
      if (qi === 0 && s > originalMaxCosine) originalMaxCosine = s
    }
  }
  const cosineScored = Array.from(cosineMap.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
  timings.cosine_ms = performance.now() - tCosine

  // bm25ScoreMap / cosineScoreMap aliases used by tier split
  const bm25ScoreMap = bm25Map
  const cosineScoreMap = cosineMap

  // Step 3c — RRF fusion
  const rrfScores = rrf(bm25Scored, cosineScored)

  // Step 3d — precision floor: short-circuit when nothing matches.
  // Uses ONLY the original query's BM25 / cosine scores (not rewrite variants).
  // Rewrite expansion can produce variants that incidentally match identity
  // facts even on unrelated questions — this gate asks "is this user's actual
  // question answerable from any memory?" before we trust expanded retrieval.
  // BM25 prep tasks filter English stop words (see cache.ts), so a non-zero
  // BM25 score from the original query means real content-word overlap.
  // Threshold differs by embed mode: stub embeddings produce cosine ~0.17 for
  // unrelated text and ~0.20-0.40 for related text (see v2-dev notes), so the
  // stub threshold sits just above the noise floor. Voyage's distribution is
  // shifted higher (0.26-0.28 unrelated, 0.55+ related) so its threshold is 0.55.
  const PRECISION_FLOOR_COSINE = Number(
    process.env.PRECISION_FLOOR_COSINE ?? (process.env.EMBED_STUB ? 0.18 : 0.55)
  )
  if (originalMaxBm25 === 0 && originalMaxCosine < PRECISION_FLOOR_COSINE) {
    timings.total_ms = performance.now() - tStart
    return { context: "", citations: [], timings }
  }

  // Step 4 — rank all memories by RRF score
  type RankedMemory = MemoryRow & { rrfScore: number }
  const ranked: RankedMemory[] = memories
    .map((m) => ({ ...m, rrfScore: rrfScores.get(m.id) ?? 0 }))
    .sort((a, b) => b.rrfScore - a.rrfScore)

  // Step 4b — multi-hop: extract entities from top results, search for connected memories
  // Stub mode skips extraction: stub cosine already handles cross-memory overlap
  // via prefix stemming, and skipping the Haiku call keeps tests deterministic.
  const tEntities = performance.now()
  const top5 = ranked.slice(0, 5)
  const entities =
    disableEntities || process.env.EMBED_STUB ? [] : await extractEntities(top5)

  if (entities.length > 0) {
    const entityVecs = (
      await Promise.all(entities.map((e) => embedBestEffort(e)))
    ).filter(Boolean) as Float32Array[]

    const hopCandidates: Array<{ id: string; score: number }> = []
    for (const eVec of entityVecs) {
      for (const mem of memories.filter((m) => m.vector)) {
        const s = cosineSimilarity(eVec, unpack(mem.vector!))
        if (s > 0.3) hopCandidates.push({ id: mem.id, score: s })
      }
    }

    for (const hc of hopCandidates) {
      rrfScores.set(hc.id, (rrfScores.get(hc.id) ?? 0) + 1 / (60 + 10))
    }

    ranked.sort((a, b) => (rrfScores.get(b.id) ?? 0) - (rrfScores.get(a.id) ?? 0))
  }
  timings.entities_ms = performance.now() - tEntities

  // Step 4c — spreading activation graph traversal from top RRF seeds
  // Skipped in stub mode (stub vectors aren't semantic) or when caller opts out
  // (used by the stress-test script for A/B comparison).
  const tGraph = performance.now()
  if (!process.env.EMBED_STUB && !disableGraph) {
    const allMemoryIds = new Set(memories.map((m) => m.id))
    const seedIds = ranked.slice(0, 5).map((m) => m.id)
    const activated = spreadActivation(seedIds, allMemoryIds)

    if (activated.length > 0) {
      console.log(`[graph] spreading activation: ${activated.length} memories activated`)
      const rankedIds = new Set(ranked.map((m) => m.id))

      for (const assoc of activated) {
        if (rankedIds.has(assoc.memoryId)) {
          const existing = ranked.find((m) => m.id === assoc.memoryId)!
          existing.rrfScore = (existing.rrfScore ?? 0) + assoc.activation * 0.01
        } else {
          const mem = memories.find((m) => m.id === assoc.memoryId)
          if (mem) {
            ranked.push({ ...mem, rrfScore: assoc.activation * 0.012 })
            rankedIds.add(assoc.memoryId)
          }
        }
      }

      ranked.sort((a, b) => (b.rrfScore ?? 0) - (a.rrfScore ?? 0))
    }
  }
  timings.graph_ms = performance.now() - tGraph

  // Step 4c.5 — derived memory boosts: amplify memories linked to strong insights
  // Applied BEFORE rerank so boosted memories are more likely to enter the
  // rerank top-10 pool, which directly influences tier-1/tier-2 placement.
  const tDerivedBoost = performance.now()
  if (!disableDerived && !process.env.EMBED_STUB) {
    const boosts = getDerivedBoosts(userId)
    if (boosts.size > 0) {
      for (const mem of ranked) {
        const boost = boosts.get(mem.id) ?? 0
        if (boost > 0) mem.rrfScore = (mem.rrfScore ?? 0) + boost
      }
      ranked.sort((a, b) => (b.rrfScore ?? 0) - (a.rrfScore ?? 0))
      console.log(`[derived] applied boosts to ${boosts.size} memories`)
    }
  }
  timings.derived_boost_ms = performance.now() - tDerivedBoost

  // Step 4d — rerank top candidates by relevance to original query
  // Skipped in stub mode to keep recall fully deterministic (no Haiku call).
  const tRerank = performance.now()
  const reranked =
    disableRerank || process.env.EMBED_STUB ? ranked : await rerank(query, ranked)
  timings.rerank_ms = performance.now() - tRerank

  // Step 5 — tier split using RRF score + BM25 gate for tier 1
  const tier1: RankedMemory[] = []
  const tier2: RankedMemory[] = []

  for (const m of reranked) {
    const hasBm25Overlap = (bm25ScoreMap.get(m.id) ?? 0) > BM25_GATE
    const cosineScore = cosineScoreMap.get(m.id) ?? 0
    const isIdentity = IDENTITY_KEYS.has(m.key)

    if (isIdentity && (hasBm25Overlap || cosineScore > COSINE_GATE)) {
      tier1.push(m)
    } else if (!isIdentity && (hasBm25Overlap || cosineScore > COSINE_GATE)) {
      tier2.push(m)
    }
    // below both thresholds → dropped entirely
  }

  // TODO: TIER 3 — recent turns (not implemented in v1)

  // Step 6 — greedy token-budget fill
  // `derivedTokens` is pre-charged so the User profile section never
  // displaces tier-1 identity facts past the maxTokens cap.
  let used = OVERHEAD + derivedTokens
  const tier1Lines: string[] = []
  const tier2Lines: string[] = []
  const citations: Citation[] = []

  function tryAdd(m: RankedMemory, lines: string[]): boolean {
    const date = m.created_at.slice(0, 10)
    const line = `- [${date}] ${m.key}: ${m.value}`
    const tokens = countTokens(line)

    if (used + tokens <= maxTokens) {
      lines.push(line)
      citations.push({
        turn_id: m.turn_id,
        score: Math.round(m.rrfScore * 10000) / 10000,
        snippet: m.value.slice(0, 120),
      })
      used += tokens
      return true
    }

    if (maxTokens - used > 20) {
      const prefix = `- [${date}] ${m.key}: `
      const budget = maxTokens - used - countTokens(prefix) - countTokens("[truncated]")
      const words = m.value.split(" ")
      let truncated = ""
      for (const word of words) {
        const candidate = truncated ? `${truncated} ${word}` : word
        if (countTokens(candidate) > budget) break
        truncated = candidate
      }
      lines.push(`${prefix}${truncated} [truncated]`)
      citations.push({
        turn_id: m.turn_id,
        score: Math.round(m.rrfScore * 10000) / 10000,
        snippet: m.value.slice(0, 120),
      })
    }

    return false
  }

  for (const m of tier1) {
    if (!tryAdd(m, tier1Lines)) break
  }
  for (const m of tier2) {
    if (!tryAdd(m, tier2Lines)) break
  }

  // Step 7 — format output
  if (tier1Lines.length === 0 && tier2Lines.length === 0 && !derivedSection) {
    timings.total_ms = performance.now() - tStart
    return { context: "", citations: [], timings }
  }

  let context = ""
  if (tier1Lines.length > 0) {
    context = "## Known facts about this user\n" + tier1Lines.join("\n")
  }
  if (tier2Lines.length > 0) {
    const section = "## Relevant memories\n" + tier2Lines.join("\n")
    context = context ? `${context}\n\n${section}` : section
  }

  // Step 8 — opinion history: surface supersession arc when opinions are recalled
  const activeOpinions = [...tier1, ...tier2].filter((m) => m.type === "opinion")

  if (activeOpinions.length > 0) {
    const allMems = (q.getAllMemoriesByUser
      ? q.getAllMemoriesByUser(userId)
      : q.getMemoriesByUser(userId)) as MemoryRow[]

    const opinionHistory = fetchOpinionHistory(activeOpinions, allMems)

    if (opinionHistory.size > 0) {
      const lines: string[] = []

      for (const [activeId, ancestors] of opinionHistory) {
        const active = [...tier1, ...tier2].find((m) => m.id === activeId)!
        for (const anc of [...ancestors].reverse()) {
          lines.push(`  [${anc.created_at.slice(0, 10)}] ${anc.value}`)
        }
        lines.push(`  [${active.created_at.slice(0, 10)}] ${active.value} (current)`)
      }

      if (lines.length > 0) {
        context += "\n\n## Opinion history\n" + lines.join("\n")
      }
    }
  }

  // Step 9 — prepend derived "User profile" section (if any).
  // Placed at the top so behavioral signals frame the factual context.
  const finalContext = derivedSection
    ? (context ? `${derivedSection}\n\n${context}` : derivedSection)
    : context
  timings.total_ms = performance.now() - tStart
  return { context: finalContext, citations, timings }
}

export async function searchMemories(
  query: string,
  userId: string,
  limit: number
): Promise<Array<{ memory: MemoryRow; rrfScore: number }>> {
  const memories = q.getMemoriesByUser(userId) as MemoryRow[]
  if (memories.length === 0) return []

  const queryVec = await embed(query, "query")

  let bm25Engine = getCachedBM25(userId)
  if (!bm25Engine) bm25Engine = buildAndCacheBM25(userId, memories)

  const bm25Raw = bm25Engine.search(query, memories.length) as Array<[string, number]>
  const bm25Scored = bm25Raw.map(([id, score]) => ({ id, score }))

  const cosineScored = memories
    .filter((m) => m.vector)
    .map((m) => ({ id: m.id, score: cosineSimilarity(queryVec, unpack(m.vector!)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)

  const rrfScores = rrf(bm25Scored, cosineScored)

  return memories
    .map((m) => ({ memory: m, rrfScore: rrfScores.get(m.id) ?? 0 }))
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit)
}
