/**
 * src/derived.ts — derived memory pipeline (Honcho-inspired behavioral layer)
 *
 * HYPOTHESIS: derived_memories improves recall quality in two ways:
 *
 * 1. PROFILE ENRICHMENT
 *    Raw memories store what happened. Derived memories store what it
 *    means about who the user is. A query about how to explain something
 *    returns nothing from raw memories — but derived memories surface
 *    "user prefers bullet points over prose" even though the user never
 *    said that explicitly.
 *
 * 2. GRAPH AMPLIFICATION
 *    Derived memories create a second node type in the association graph.
 *    Raw memories that contributed to a high-confidence derived insight
 *    get a relevance boost at recall time — the derived layer amplifies
 *    memories that have proven meaningful across multiple interactions.
 *
 * MEASURABLE PREDICTION:
 * - With derived memories: context contains a "## User profile" section
 *   for users with 3+ turns, surfacing implicit behavioral patterns.
 * - Citation count increases for queries about user behavior/preferences
 *   because derived memories link previously unconnected raw memories.
 * - Multi-session queries about communication style or goals return
 *   more relevant context than pure raw-memory retrieval.
 *
 * RISK: derivation adds ~1.5s latency to /turns (async, fire-and-forget
 * so it doesn't block 201). Risk of hallucinated insights if the LLM
 * over-infers from limited data — confidence scoring and reinforcement
 * counting are the mitigations.
 *
 * Six categories:
 *   communication_style  — how they prefer to receive information
 *   cognitive_pattern    — how they think and process
 *   emotional_state      — current mood/pressure (decays, low confidence)
 *   goal                 — what they're working toward right now
 *   constraint           — what limits them
 *   relationship_pattern — how they relate to the assistant
 */

import Anthropic from "@anthropic-ai/sdk"
import { db, q } from "./db"

const MIN_MEMORIES_FOR_DERIVATION = 2
const INSIGHT_SIMILARITY_THRESHOLD = 0.75

type DerivedCategory =
  | "communication_style"
  | "cognitive_pattern"
  | "emotional_state"
  | "goal"
  | "constraint"
  | "relationship_pattern"

interface DerivedInsight {
  category: DerivedCategory
  insight: string
  confidence: number
  source_memory_ids: string[]
}

interface MemoryRow {
  id: string
  key: string
  value: string
  type: string
  confidence: number
  created_at: string
}

interface DerivedRow {
  id: string
  user_id: string
  category: string
  insight: string
  source_memory_ids: string
  confidence: number
  reinforcement_count: number
  last_reinforced_at: string
  active: number
  created_at: string
  updated_at: string
}

const DERIVATION_PROMPT = `You are analyzing a user's conversation memories to derive
psychological and behavioral insights.

You will see recent memories extracted from conversations with this user.
Your job: identify patterns that reveal WHO THIS USER IS, not just what they said.

Categories to consider:
- communication_style: How do they prefer to receive information? (bullet points vs prose,
  concise vs detailed, examples vs abstractions, direct vs diplomatic)
- cognitive_pattern: How do they think? (systems thinker, detail-oriented, big-picture,
  visual, analytical, intuitive)
- emotional_state: Current emotional context (under pressure, excited, frustrated,
  focused) — use LOW confidence (0.4-0.6), these change quickly
- goal: What are they working toward right now? Active goals only.
- constraint: What limits them? (time pressure, skill gap, context switching)
- relationship_pattern: How do they relate to the assistant? (prefers suggestions vs
  direct answers, collaborative vs directive, skeptical vs trusting)

RULES:
- Only derive what the evidence actually supports. Do not infer beyond the data.
- Prefer NOT deriving over hallucinating a pattern.
- communication_style and cognitive_pattern need 3+ supporting signals to derive.
- emotional_state only needs 1 signal but use low confidence (0.4-0.6).
- Return empty array if no clear patterns emerge.
- insights must be specific and actionable, not generic.
  BAD: "user is smart"
  GOOD: "user prefers seeing concrete code examples before explanations"

Recent memories for this user:
{MEMORIES}

Return ONLY valid JSON, no markdown:
{
  "insights": [
    {
      "category": "communication_style|cognitive_pattern|emotional_state|goal|constraint|relationship_pattern",
      "insight": "specific actionable description",
      "confidence": 0.0-1.0,
      "source_memory_ids": ["id1", "id2"]
    }
  ]
}

Return {"insights": []} if nothing clear emerges.`

function getClient(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

/**
 * Main entry point. Called fire-and-forget from POST /turns.
 * Never throws — all errors are caught and logged.
 */
export async function deriveMemories(
  userId: string,
  _newMemoryIds: string[],
): Promise<void> {
  if (process.env.EMBED_STUB) return

  try {
    const recentMemories = db.query(`
      SELECT id, key, value, type, confidence, created_at
      FROM memories
      WHERE user_id = $user_id AND active = 1
      ORDER BY created_at DESC
      LIMIT 30
    `).all({ $user_id: userId }) as MemoryRow[]

    if (recentMemories.length < MIN_MEMORIES_FOR_DERIVATION) {
      console.log(`[derived] skipping — only ${recentMemories.length} memories`)
      return
    }

    const existingDerived = q.getDerivedByUser.all({
      $user_id: userId,
    }) as DerivedRow[]

    const memoriesText = recentMemories
      .map((m) => `[${m.id.slice(0, 8)}] ${m.key}: ${m.value}`)
      .join("\n")

    const t0 = performance.now()
    const resp = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [
        {
          role: "user",
          content: DERIVATION_PROMPT.replace("{MEMORIES}", memoriesText),
        },
      ],
    })

    const text = resp.content.find((b) => b.type === "text")?.text ?? ""

    let insights: DerivedInsight[] = []
    try {
      const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim()
      const parsed = JSON.parse(cleaned)
      insights = Array.isArray(parsed?.insights) ? parsed.insights : []
    } catch {
      console.log("[derived] parse failed, skipping")
      return
    }

    if (insights.length === 0) {
      console.log(`[derived] no insights derived (${(performance.now() - t0).toFixed(0)}ms)`)
      return
    }

    let inserted = 0
    let reinforced = 0

    for (const insight of insights) {
      if (
        !insight ||
        typeof insight.category !== "string" ||
        typeof insight.insight !== "string" ||
        typeof insight.confidence !== "number"
      ) continue

      const existing = existingDerived.find(
        (d) =>
          d.category === insight.category &&
          textSimilarity(d.insight, insight.insight) > INSIGHT_SIMILARITY_THRESHOLD,
      )

      if (existing) {
        q.reinforceDerived.run({ $id: existing.id })
        reinforced++
      } else {
        const id = crypto.randomUUID()
        const validSourceIds = (insight.source_memory_ids ?? [])
          .filter((sid) => recentMemories.some((m) => m.id === sid || m.id.startsWith(sid)))
          // Re-map short prefix ids back to full UUIDs (prompt shows first 8 chars)
          .map((sid) => recentMemories.find((m) => m.id === sid || m.id.startsWith(sid))!.id)

        q.insertDerived.run({
          $id: id,
          $user_id: userId,
          $category: insight.category,
          $insight: insight.insight,
          $confidence: insight.confidence,
          $source_memory_ids: JSON.stringify(validSourceIds),
          $reinforcement_count: 1,
        })
        // Provenance is tracked via derived_memories.source_memory_ids (JSON);
        // getDerivedBoosts reads it directly. No need for graph edges since
        // memory_associations has FK constraints to memories(id).
        inserted++
      }
    }

    console.log(
      `[derived] ${inserted} new insights, ${reinforced} reinforced` +
        ` for user ${userId.slice(0, 8)} (${(performance.now() - t0).toFixed(0)}ms)`,
    )
  } catch (err: any) {
    console.error("[derived] derivation failed:", err?.message ?? err)
  }
}

/**
 * Word-overlap similarity for deduplication. Not semantic — just good
 * enough for "same insight phrased differently". Avoids an API call.
 */
function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3))
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3))
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length
  return intersection / Math.max(wordsA.size, wordsB.size)
}

/**
 * Returns formatted derived memory context for recall assembly.
 * Called from recall.ts when building the context string.
 */
export function getDerivedContext(
  userId: string,
  maxTokens: number,
): { text: string; tokenCount: number } {
  const derived = q.getDerivedByUser.all({ $user_id: userId }) as DerivedRow[]
  if (derived.length === 0) return { text: "", tokenCount: 0 }

  const confident = derived.filter(
    (d) => d.confidence >= 0.6 && d.reinforcement_count >= 1,
  )
  if (confident.length === 0) return { text: "", tokenCount: 0 }

  const grouped: Record<string, string[]> = {}
  for (const d of confident) {
    if (!grouped[d.category]) grouped[d.category] = []
    grouped[d.category].push(d.insight)
  }

  const lines: string[] = []
  for (const [cat, insights] of Object.entries(grouped)) {
    const label = cat.replace(/_/g, " ")
    for (const insight of insights.slice(0, 2)) {
      lines.push(`- ${label}: ${insight}`)
    }
  }
  if (lines.length === 0) return { text: "", tokenCount: 0 }

  const approxTokens = (s: string) => Math.ceil(s.split(/\s+/).length * 1.3)
  const headerTokens = approxTokens("## User profile")

  // Greedy fit within budget
  const fitLines: string[] = []
  let used = headerTokens
  for (const line of lines) {
    const lt = approxTokens(line)
    if (used + lt > maxTokens) break
    fitLines.push(line)
    used += lt
  }
  if (fitLines.length === 0) return { text: "", tokenCount: 0 }

  const text = "## User profile\n" + fitLines.join("\n")
  return { text, tokenCount: used }
}

/**
 * Returns derived memory boost scores for raw memories.
 * Memories linked to high-confidence derived insights get a small
 * RRF score boost at recall time.
 */
export function getDerivedBoosts(userId: string): Map<string, number> {
  const boosts = new Map<string, number>()

  const derived = q.getDerivedByUser.all({ $user_id: userId }) as DerivedRow[]
  const highConfidence = derived.filter(
    (d) => d.confidence >= 0.75 && d.reinforcement_count >= 2,
  )

  for (const d of highConfidence) {
    let sourceIds: string[] = []
    try {
      sourceIds = JSON.parse(d.source_memory_ids)
    } catch {
      continue
    }

    const boost = 0.002 * d.confidence * Math.min(d.reinforcement_count, 5)

    for (const memId of sourceIds) {
      const existing = boosts.get(memId) ?? 0
      boosts.set(memId, Math.max(existing, boost))
    }
  }

  return boosts
}
