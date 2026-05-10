import Anthropic from "@anthropic-ai/sdk"
import { q, tx } from "./db"
import { batchEmbedAndStore } from "./embeddings"
import type { Message } from "./models"

const CANONICAL_KEYS =
  "employer, location, role, diet, pet_name, pet_type, relationship_status, " +
  "family_member, education, hobby, opinion_typescript, opinion_python, " +
  "opinion_react, preference_communication, preference_format, health_condition"

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

function getClient(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
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
    const turnText = formatTurn(messages)

    const explicitPrompt = EXPLICIT_PROMPT
      .replace("{CANONICAL_KEYS}", CANONICAL_KEYS)
      .replace("{TURN_TEXT}", turnText)

    // Both prompts fire simultaneously. ALREADY_FOUND is empty for the parallel
    // implicit pass; key-level supersession in the write loop handles any overlap.
    const implicitPrompt = IMPLICIT_PROMPT
      .replace("{ALREADY_FOUND}", "[]")
      .replace("{TURN_TEXT}", turnText)

    const [explicit, implicit] = await Promise.all([
      runPass(explicitPrompt, "claude-sonnet-4-6"),
      runPass(implicitPrompt, "claude-haiku-4-5-20251001"),
    ])

    const merged = [...explicit, ...implicit]
    if (merged.length === 0) return []

    const insertedIds: string[] = []
    const embedItems: Array<{ memoryId: string; value: string }> = []

    for (const memory of merged) {
      const existing = q.getMemoryByKey(userId, memory.key) as
        | { id: string }
        | null

      const memoryId = crypto.randomUUID()

      tx(() => {
        if (existing) q.supersedeMemory(existing.id)
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
          $supersedes: existing?.id ?? null,
        })
      })

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
