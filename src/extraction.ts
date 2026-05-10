import Anthropic from "@anthropic-ai/sdk"
import { q, tx } from "./db"
import { batchEmbedAndStore } from "./embeddings"
import type { Message } from "./models"

const CANONICAL_KEYS =
  "employer, location, role, diet, pet_name, pet_type, relationship_status, " +
  "family_member, education, hobby, opinion_typescript, opinion_python, " +
  "opinion_react, preference_communication, preference_format, health_condition"

// Memory-class taxonomy. Each fact falls into one of three behavioral classes:
//   singleton    — one active value at a time (employer, location, diet)
//                  → supersede previous before insert (existing behavior)
//   accumulating — multiple values coexist (hobbies, skills, pets)
//                  → insert alongside existing, dedup by value similarity
//   event        — timestamped occurrences (job_change, promotion, marriage)
//                  → always insert, never supersede
//
// Without this branch, `hobby` (and any other accumulating key) silently
// loses entries: each new "hobby" extraction supersedes the previous one,
// so a user who hikes AND climbs ends up with only the most recent hobby.
const ACCUMULATING_KEYS = new Set([
  // hobbies
  "hobby", "hobby_hiking", "hobby_climbing", "hobby_running",
  "hobby_cooking", "hobby_reading", "hobby_gaming", "hobby_music",
  "hobby_photography", "hobby_painting", "hobby_cycling",
  // skills
  "skill", "skill_typescript", "skill_python", "skill_rust",
  "skill_go", "skill_java", "skill_design",
  // languages
  "language",
  // pets (multiple pets can coexist)
  "pet_name", "pet_type", "pet_breed",
  // social
  "friend", "friend_name", "interest", "project", "side_project",
])

const EVENT_KEYS = new Set([
  "job_change", "relocation", "milestone", "life_event",
  "promotion", "graduation", "marriage", "birth",
  "travel", "purchase", "award",
])

function getMemoryClass(key: string): "singleton" | "accumulating" | "event" {
  const lower = key.toLowerCase()
  if (EVENT_KEYS.has(lower)) return "event"
  if (ACCUMULATING_KEYS.has(lower)) return "accumulating"
  // Prefix match: hobby_anything → accumulating
  for (const ak of ACCUMULATING_KEYS) {
    if (lower.startsWith(ak + "_")) return "accumulating"
  }
  return "singleton"
}

// Word-overlap similarity for value-level deduplication on accumulating
// memories. Same logic as derived.ts textSimilarity — copied rather than
// imported to keep extraction.ts free of cross-module dependencies on a
// derivation-layer helper.
function valueSimilarity(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3))
  const wb = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3))
  if (wa.size === 0 || wb.size === 0) return 0
  const intersection = [...wa].filter((w) => wb.has(w)).length
  return intersection / Math.max(wa.size, wb.size)
}

const EXPLICIT_PROMPT = `Extract facts explicitly stated by the user in this conversation.
Use canonical keys where they fit: {CANONICAL_KEYS}
For anything else invent a snake_case key.

CRITICAL — SUBJECT RULE: Only extract facts about THE USER
(the person speaking in the "user" role messages).

If the user mentions facts about another person — a friend,
colleague, family member, or anyone else — store those facts
under a relationship-prefixed key, NEVER under identity keys.

Examples of CORRECT extraction:
  User: "My friend Marco runs a studio called Tidepool"
  → {key: "friend_marco_employer", value: "Marco runs Tidepool game studio", type: "fact"}
  NOT → {key: "employer", value: "runs Tidepool game studio"}

  User: "My partner Lena works at Figma as a UX designer"
  → {key: "partner_employer", value: "Lena works at Figma as UX designer", type: "fact"}
  NOT → {key: "employer", value: "works at Figma"}

  User: "My sister teaches at UNAM in Mexico City"
  → {key: "sister_employer", value: "sister teaches at UNAM", type: "fact"}
  NOT → {key: "location", value: "based in Mexico City"}

Identity keys (employer, location, role, diet, pet_name, etc.)
MUST refer to the user only. Third-party facts use prefixed keys:
friend_[name]_*, partner_*, sister_*, colleague_*, etc.

Return ONLY valid JSON, no markdown:
{"memories":[{"type":"fact|preference|opinion|event","key":"...","value":"descriptive phrase not raw quote","confidence":0.0-1.0,"implicit":false}]}
Rules:
- value must be a descriptive phrase: "works at Notion as PM" not "Notion"
- opinions: key=opinion_<topic>, include the full stance in value
- if nothing memorable return {"memories":[]}
Conversation:
{TURN_TEXT}`

const IMPLICIT_PROMPT = `Find facts IMPLIED but not directly stated in this conversation.
Also find corrections ("I meant X not Y", "actually...", "wait...").
Already found explicit facts (do not repeat these): {ALREADY_FOUND}

CRITICAL — SUBJECT RULE: Only extract facts about THE USER
(the person speaking in the "user" role messages).

If the user mentions facts about another person — a friend,
colleague, family member, or anyone else — store those facts
under a relationship-prefixed key, NEVER under identity keys.

Examples of CORRECT extraction:
  User: "My friend Marco runs a studio called Tidepool"
  → {key: "friend_marco_employer", value: "Marco runs Tidepool game studio", type: "fact"}
  NOT → {key: "employer", value: "runs Tidepool game studio"}

  User: "My partner Lena works at Figma as a UX designer"
  → {key: "partner_employer", value: "Lena works at Figma as UX designer", type: "fact"}
  NOT → {key: "employer", value: "works at Figma"}

  User: "My sister teaches at UNAM in Mexico City"
  → {key: "sister_employer", value: "sister teaches at UNAM", type: "fact"}
  NOT → {key: "location", value: "based in Mexico City"}

Identity keys (employer, location, role, diet, pet_name, etc.)
MUST refer to the user only. Third-party facts use prefixed keys:
friend_[name]_*, partner_*, sister_*, colleague_*, etc.

Return ONLY valid JSON, no markdown:
{"memories":[{"type":"fact|preference|opinion|event","key":"...","value":"descriptive phrase","confidence":0.0-1.0,"implicit":true,"correction_of":null_or_quoted_text}]}
Rules:
- "walking Biscuit" → implicit fact, key=pet_name, value="has a dog named Biscuit", confidence=0.75
- corrections get confidence=1.0 regardless of phrasing
- if nothing implied return {"memories":[]}
Conversation:
{TURN_TEXT}`

interface ExtractedMemory {
  type: "fact" | "preference" | "opinion" | "event"
  key: string
  value: string
  confidence: number
  implicit: boolean
  correction_of?: string | null
}

// Local row shape for contradiction detection — only the fields we read.
// Mirrors src/recall.ts MemoryRow without dragging the cross-file dependency.
interface MemoryRow {
  id: string
  type: string
  key: string
  value: string
}

// Cheap signal-word gate. Only when the raw turn contains one of these
// phrases do we pay for the Haiku contradiction-detection call. Designed to
// be a no-op for ~90% of turns (most conversations don't contradict prior
// state). Keep this list conservative — every false positive costs ~1 s of
// Haiku latency on /turns.
const CONTRADICTION_SIGNALS = [
  "used to", "no longer", "quit", "left", "changed my mind",
  "actually", "correction", "i meant", "not anymore", "switched",
  "moved on", "stopped", "don't anymore", "completely different",
  "opposite", "was wrong", "previously", "former", "resigned",
  "fired", "laid off", "broke up", "divorced", "sold", "gave up",
]

function hasContradictionSignal(text: string): boolean {
  const lower = text.toLowerCase()
  return CONTRADICTION_SIGNALS.some((s) => lower.includes(s))
}

// Catches the cases that exact-key supersession misses:
//   - The new turn says "I quit" but extracts no new employer fact —
//     existing employer key is never superseded by key-match.
//   - The new turn extracts under a slightly different key
//     ("opinion_ts" vs stored "opinion_typescript") — both stay active.
// Skipped under EMBED_STUB to keep tests deterministic. Never throws — a
// failure to detect a contradiction is preferable to crashing /turns.
async function detectContradictions(
  newMemories: ExtractedMemory[],
  existingMemories: MemoryRow[],
  rawTurnText: string,
): Promise<string[]> {
  if (process.env.EMBED_STUB) return []
  if (existingMemories.length === 0) return []

  // Only check fact and opinion types — events ("went to a concert") and
  // habits ("meditates daily") aren't superseded by contradiction signals.
  const checkable = existingMemories
    .filter((m) => m.type === "fact" || m.type === "opinion")
    .slice(0, 20) // bound LLM input size

  if (checkable.length === 0) return []

  try {
    const existingList = checkable
      .map((m) => `[${m.id.slice(0, 8)}] ${m.key}: ${m.value}`)
      .join("\n")

    const newList =
      newMemories.length > 0
        ? newMemories.map((m) => `${m.key}: ${m.value}`).join("\n")
        : "(none extracted)"

    const resp = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content:
            `A user said: "${rawTurnText}"\n\n` +
            `New memories extracted from this turn:\n${newList}\n\n` +
            `Existing stored memories:\n${existingList}\n\n` +
            `Which existing memories are now CONTRADICTED or INVALIDATED ` +
            `by what the user just said?\n\n` +
            `Return ONLY a valid JSON array of the 8-char memory ID ` +
            `prefixes that should be superseded. Return [] if none.\n` +
            `Be conservative — only include CLEAR contradictions.\n` +
            `Example: ["abc12345", "def67890"]`,
        },
      ],
    })

    const block = resp.content.find((b) => b.type === "text")
    if (!block || block.type !== "text") return []
    // Extract the first JSON array — Haiku occasionally adds prose preamble
    // ("Here are the contradicted memories: [...]") or wraps in code fences.
    // Both patterns survive a literal JSON.parse(text) failure.
    const stripped = block.text.replace(/```json|```/g, "").trim()
    const arrayMatch = stripped.match(/\[[\s\S]*?\]/)
    const jsonText = arrayMatch ? arrayMatch[0] : stripped
    const prefixes = JSON.parse(jsonText) as string[]
    if (!Array.isArray(prefixes)) return []

    // Map 8-char prefixes back to full IDs
    const toSupersede: string[] = []
    for (const prefix of prefixes) {
      if (typeof prefix !== "string") continue
      const match = checkable.find((m) => m.id.startsWith(prefix))
      if (match) toSupersede.push(match.id)
    }

    if (toSupersede.length > 0) {
      console.log(
        `[extract] contradiction: superseding ${toSupersede.length} ` +
          `memories — ${toSupersede.map((id) => id.slice(0, 8)).join(", ")}`,
      )
    }

    return toSupersede
  } catch (err: any) {
    console.error("[extract] contradiction check failed:", err?.message ?? err)
    return [] // never crash extraction
  }
}

function getClient(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

const REWRITE_PROMPT = `You are a narrative normalizer for a memory system.

Rewrite the following conversation turn into a clear, third-person
factual narrative about the participants.

Rules:
1. SUBJECT CLARITY: Every sentence must have an explicit subject.
   - Facts about the USER (the speaker): "The user [fact]."
   - Facts about OTHERS: "The user's friend Marco [fact]." or
     "The user's partner Lena [fact]." Never use pronouns alone.
2. MAKE IMPLICIT EXPLICIT: Convert behavioral signals to explicit statements.
   - "skip the theory, show me code" → "The user prefers to learn through
     working code examples rather than theoretical explanations."
   - "quick answer only" → "The user prefers concise, direct answers."
3. PRESERVE ALL FACTS: Do not add or remove factual content.
4. THIRD PERSON: Write entirely in third person. Never use "I" or "my".
5. COMPLETE SENTENCES: Each fact gets its own sentence.

Original turn:
{MESSAGES}

Return only the rewritten narrative. No preamble, no explanation.`

// Pre-extraction normalizer. Runs before the two-pass Sonnet+Haiku extraction
// so subject-confusion and implicit-content gaps are resolved at the input
// layer rather than relying on prompt rules in every downstream extraction call.
// Skipped when EMBED_STUB=1 (deterministic tests) or DISABLE_TURN_REWRITE=1
// (lets us A/B the feature). The original messages are still persisted to the
// turns table — only the extraction input is rewritten.
async function rewriteTurn(messages: Message[]): Promise<string> {
  const rawText = formatTurn(messages)
  if (process.env.EMBED_STUB || process.env.DISABLE_TURN_REWRITE) return rawText
  try {
    const formatted = messages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n")
    const resp = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{ role: "user", content: REWRITE_PROMPT.replace("{MESSAGES}", formatted) }],
    })
    const block = resp.content.find((b) => b.type === "text")
    const rewritten = block && block.type === "text" ? block.text.trim() : ""
    if (!rewritten) return rawText
    console.log(`[extract] rewrite: ${rewritten.slice(0, 100)}…`)
    return rewritten
  } catch (err: any) {
    console.error("[extract] rewrite failed, using raw:", err?.message ?? err)
    return rawText
  }
}

async function runPass(
  prompt: string,
  model: string
): Promise<ExtractedMemory[]> {
  try {
    const client = getClient()
    const response = await client.messages.create({
      model,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    })
    const text = response.content.find((b) => b.type === "text")?.text ?? ""
    return parseMemories(text)
  } catch (err) {
    console.error(`Extraction pass (${model}) failed:`, err)
    return []
  }
}

function parseMemories(raw: string): ExtractedMemory[] {
  try {
    // Strip markdown code fences. The longer subject-rule prompt sometimes
    // makes Sonnet wrap output in ```json ... ``` despite the "no markdown"
    // instruction. Other LLM helpers in this codebase (rewriteQuery,
    // extractEntities, rerank) do the same defensive strip.
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim()
    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed?.memories)) return []
    return parsed.memories.filter(
      (m: unknown) =>
        m !== null &&
        typeof m === "object" &&
        typeof (m as ExtractedMemory).key === "string" &&
        typeof (m as ExtractedMemory).value === "string"
    )
  } catch {
    return []
  }
}

function formatTurn(messages: Message[]): string {
  return messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n")
}

export async function extractMemories(
  turnId: string,
  userId: string,
  sessionId: string,
  messages: Message[]
): Promise<string[]> {
  try {
    // Step 0 — narrative normalization. Convert raw conversational text to
    // canonical third-person narrative before extraction so subject-confusion
    // and implicit-content gaps are resolved at the input layer.
    const narrativeText = await rewriteTurn(messages)

    const explicitPrompt = EXPLICIT_PROMPT
      .replace("{CANONICAL_KEYS}", CANONICAL_KEYS)
      .replace("{TURN_TEXT}", narrativeText)

    // Both prompts fire simultaneously. ALREADY_FOUND is empty for the parallel
    // implicit pass; key-level supersession in the write loop handles any overlap.
    const implicitPrompt = IMPLICIT_PROMPT
      .replace("{ALREADY_FOUND}", "[]")
      .replace("{TURN_TEXT}", narrativeText)

    const [explicit, implicit] = await Promise.all([
      runPass(explicitPrompt, "claude-sonnet-4-6"),
      runPass(implicitPrompt, "claude-haiku-4-5-20251001"),
    ])

    const merged = [...explicit, ...implicit]

    // Contradiction detection — runs BEFORE the merged.length check so a
    // turn that contradicts existing facts but extracts no new ones still
    // triggers supersession (e.g. "I quit my job" produces no new employer
    // memory but should still deactivate the old one). Gated on a cheap
    // signal-word check so the Haiku call is a no-op for ~90% of turns.
    const rawText = messages.map((m) => m.content).join(" ")
    if (hasContradictionSignal(rawText)) {
      const existingActive = q.getMemoriesByUser(userId) as MemoryRow[]
      const contradictedIds = await detectContradictions(merged, existingActive, rawText)
      for (const id of contradictedIds) {
        q.supersedeMemory(id)
      }
    }

    if (merged.length === 0) return []

    const insertedIds: string[] = []
    const embedItems: Array<{ memoryId: string; value: string }> = []

    for (const memory of merged) {
      const memClass = getMemoryClass(memory.key)
      const memoryId = crypto.randomUUID()

      const doInsert = (supersedesId: string | null) => {
        q.insertMemory.run({
          $id: memoryId,
          $user_id: userId,
          $session_id: sessionId,
          $turn_id: turnId,
          $type: memory.type,
          $key: memory.key,
          $value: memory.value,
          $confidence: memory.confidence ?? 1.0,
          $implicit: memory.implicit ? 1 : 0,
          $supersedes: supersedesId,
          $memory_class: memClass,
        })
      }

      if (memClass === "singleton") {
        // Existing behavior — supersede previous active value before insert.
        const existing = q.getMemoryByKey(userId, memory.key) as
          | { id: string }
          | null
        tx(() => {
          if (existing) q.supersedeMemory(existing.id)
          doInsert(existing?.id ?? null)
        })
      } else if (memClass === "accumulating") {
        // Multiple values coexist for this key. Insert alongside existing
        // entries unless one is sufficiently similar (>0.75 word overlap).
        const sameKey = q.getActiveMemoriesByKey(userId, memory.key) as
          MemoryRow[]
        const isDuplicate = sameKey.some(
          (m) => valueSimilarity(m.value, memory.value) > 0.75,
        )
        if (isDuplicate) {
          console.log(
            `[extract] accumulating dedup: skipped "${memory.value.slice(0, 40)}"`,
          )
          continue // skip this memory entirely — don't insert, don't embed
        }
        tx(() => doInsert(null))
        console.log(
          `[extract] accumulating insert: ${memory.key} = ` +
            `"${memory.value.slice(0, 50)}"`,
        )
      } else {
        // event — always insert, never supersede.
        tx(() => doInsert(null))
        console.log(`[extract] event insert: ${memory.key}`)
      }

      insertedIds.push(memoryId)
      embedItems.push({ memoryId, value: memory.value })
    }

    await batchEmbedAndStore(embedItems, userId)
    return insertedIds
  } catch (err) {
    console.error("extractMemories failed:", err)
    return []
  }
}
