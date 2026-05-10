// =============================================================================
// FIXTURE TEST — recall quality on fixtures/conversations.json
//
// Spec deliverable: "Ship a small fixture in fixtures/ (3-5 scripted
// conversations + probe queries with expected facts). Your tests should
// ingest the conversations, run the probes against /recall, and report a
// basic quality metric."
//
// This file owns the literal-spec-loader path. The inline fixture in
// test_stress.test.ts ("recall quality — self-built fixture") covers the
// same surface with hard-coded data so stress tests stay self-contained.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const BASE = process.env.STRESS_BASE_URL ?? "http://localhost:8080"
const STUB_MODE = process.env.EMBED_STUB === "1"
const FIXTURE_PATH = resolve(import.meta.dir, "..", "fixtures", "conversations.json")

interface ProbeRaw {
  query: string
  expected_contains: string | string[] | null
  expected_not_contains?: string | string[] | null
  type?: string
}
interface ConversationRaw {
  description: string
  session_id: string
  user_id: string
  turns: Array<{ messages: Array<{ role: string; content: string }>; timestamp: string }>
  probes: ProbeRaw[]
}

const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ConversationRaw[]

// Normalize probe expectations — the JSON fixture uses both string and
// array forms across conversations. Treat empty/null as "no constraint".
function asList(v: string | string[] | null | undefined): string[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function ingest(userId: string, sessionId: string, msgs: Array<{ role: string; content: string }>, ts: string) {
  const res = await fetch(`${BASE}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, user_id: userId, messages: msgs, timestamp: ts, metadata: {} }),
  })
  return res.status
}

async function recall(userId: string, query: string) {
  const res = await fetch(`${BASE}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, session_id: `probe-${userId}`, user_id: userId, max_tokens: 1024 }),
  })
  return (await res.json()) as { context: string; citations: unknown[] }
}

async function deleteUser(userId: string) {
  await fetch(`${BASE}/users/${userId}`, { method: "DELETE" })
}

// Aggregate probe outcomes across the whole fixture so we can print a single
// quality metric line at the end of the suite, per the spec's "report a basic
// quality metric (even if it's just X of Y expected facts appeared in context)".
const probeResults: Array<{ conv: string; query: string; hit: boolean }> = []

for (const conv of fixtures) {
  describe(`fixture: ${conv.description}`, () => {
    beforeAll(async () => {
      let i = 0
      for (const turn of conv.turns) {
        await ingest(conv.user_id, conv.session_id, turn.messages, turn.timestamp)
        // Inter-turn pause lets per-turn extraction land before the next
        // ingest, especially under real-Voyage rate-limit pressure.
        await wait(1500)
        i++
      }
    }, 120_000)

    afterAll(async () => {
      await deleteUser(conv.user_id)
    })

    for (const probe of conv.probes) {
      const must = asList(probe.expected_contains).map((s) => s.toLowerCase())
      const mustNot = asList(probe.expected_not_contains).map((s) => s.toLowerCase())
      const label = `${probe.query} → contains ${JSON.stringify(must)}`

      it(label, async () => {
        const { context } = await recall(conv.user_id, probe.query)
        const ctx = context.toLowerCase()

        const hit = must.length === 0 || must.some((needle) => ctx.includes(needle))
        const negHit = mustNot.some((needle) => ctx.includes(needle))

        probeResults.push({ conv: conv.description, query: probe.query, hit: hit && !negHit })

        // Stub embeddings have no semantics — soften assertions so the suite
        // still reports a quality metric instead of cascading-failing.
        // Under real Voyage these become hard expectations.
        if (STUB_MODE) {
          expect(typeof context).toBe("string")
        } else {
          expect(hit).toBe(true)
          if (mustNot.length > 0) expect(negHit).toBe(false)
        }
      }, 60_000)
    }
  })
}

describe("fixture: quality summary", () => {
  it("prints X-of-Y expected facts retrieved", () => {
    const total = probeResults.length
    const hits = probeResults.filter((r) => r.hit).length
    const ratio = total > 0 ? hits / total : 0
    console.log(
      `[fixture] recall quality: ${hits}/${total} probes hit ` +
        `(${(ratio * 100).toFixed(0)}%) — ` +
        `mode=${STUB_MODE ? "stub" : "real"}`,
    )
    // Sanity floor — we always expect at least one keyword-resolvable probe
    // (e.g. "Biscuit", "Mochi") to land even under stub embeddings.
    expect(total).toBeGreaterThan(0)
    expect(hits).toBeGreaterThan(0)
  })
})
