#!/usr/bin/env bun
/**
 * A/B comparison: recall WITH vs WITHOUT derived memories
 *
 * Ingests a multi-session corpus designed to produce
 * derivable behavioral patterns, then probes with queries
 * that benefit from profile enrichment vs pure factual recall.
 *
 * Usage: bun run scripts/derived_compare.ts
 */

const BASE = process.env.BASE ?? "http://localhost:8080"
const USER = `derived-ab-${Date.now()}`

const CORPUS = [
  {
    content: "I'm a senior backend engineer at Stripe. I live in Amsterdam.",
    ts: "2025-01-01T09:00:00Z",
  },
  {
    content:
      "Can you explain how the event loop works? I want to understand the whole system before I look at specific implementations.",
    ts: "2025-01-02T09:00:00Z",
  },
  {
    content:
      "Skip the theory, just show me a working example of async/await vs promises. I'll figure out the why from the code.",
    ts: "2025-01-03T09:00:00Z",
  },
  {
    content:
      "I've got a production issue. Database queries are slow. Quick answer only — what are the top 3 things to check?",
    ts: "2025-01-04T09:00:00Z",
  },
  {
    content:
      "Don't explain what a database index is. Just show me the SQL to add one to a users table on email column.",
    ts: "2025-01-05T09:00:00Z",
  },
  {
    content:
      "I'm preparing our system for a 10x traffic spike next month. Been thinking about caching strategies and horizontal scaling.",
    ts: "2025-01-06T09:00:00Z",
  },
  {
    content:
      "Before we add caching, I want to map out all the failure modes. What breaks when Redis goes down?",
    ts: "2025-01-07T09:00:00Z",
  },
  {
    content:
      "What's the right approach for distributed locking? Don't give me pros and cons of 5 options. Just tell me what to use.",
    ts: "2025-01-08T09:00:00Z",
  },
  {
    content:
      "Short question: is Kafka overkill for 10k events/day? Yes or no first, then one sentence why.",
    ts: "2025-01-09T09:00:00Z",
  },
]

interface Probe {
  query: string
  type: "factual" | "behavioral" | "implicit"
  expect: string[]
  expectProfile?: boolean
}

const PROBES: Probe[] = [
  { query: "where does the user work?", type: "factual", expect: ["stripe"] },
  { query: "what city does the user live in?", type: "factual", expect: ["amsterdam"] },

  {
    query: "how should I format a technical explanation for this user?",
    type: "behavioral",
    expect: ["code", "example", "direct", "concise"],
    expectProfile: true,
  },
  {
    query: "what communication style does this user prefer?",
    type: "behavioral",
    expect: ["code", "direct", "example", "concise"],
    expectProfile: true,
  },
  {
    query: "what is the user currently working on?",
    type: "behavioral",
    expect: ["scaling", "traffic", "caching", "performance"],
    expectProfile: false,
  },

  {
    query: "does this user prefer theory or practice?",
    type: "implicit",
    expect: ["practice", "code", "example", "direct"],
    expectProfile: true,
  },
  {
    query: "how does this user approach problem solving?",
    type: "implicit",
    expect: ["system", "big picture", "understand", "whole"],
    expectProfile: true,
  },
  {
    query: "is this user under time pressure?",
    type: "implicit",
    expect: ["quick", "short", "production", "time"],
    expectProfile: false,
  },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function ingest(content: string, ts: string): Promise<void> {
  const r = await fetch(`${BASE}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: "derived-corpus",
      user_id: USER,
      messages: [{ role: "user", content }],
      timestamp: ts,
      metadata: {},
    }),
  })
  if (!r.ok) throw new Error(`ingest failed: ${r.status}`)
}

async function probeRecall(
  query: string,
  disableDerived: boolean,
): Promise<{ context: string; citations: number; latency: number }> {
  const t0 = performance.now()
  const r = await fetch(`${BASE}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      session_id: "ab-probe",
      user_id: USER,
      max_tokens: 1024,
      disable_derived: disableDerived,
    }),
  })
  const body = (await r.json()) as { context?: string; citations?: unknown[] }
  return {
    context: body.context ?? "",
    citations: body.citations?.length ?? 0,
    latency: performance.now() - t0,
  }
}

const hitsAny = (context: string, terms: string[]): boolean => {
  const lower = context.toLowerCase()
  return terms.some((t) => lower.includes(t.toLowerCase()))
}

const hasProfileSection = (context: string): boolean =>
  context.includes("## User profile")

async function main() {
  console.log("═══════════════════════════════════════════════════")
  console.log("  Derived Memories A/B Comparison")
  console.log("═══════════════════════════════════════════════════")
  console.log(`  Service: ${BASE}`)
  console.log(`  User:    ${USER}`)
  console.log()

  const health = await fetch(`${BASE}/health`).catch(() => null)
  if (!health?.ok) {
    console.error("Service not running. Start with: docker compose up -d")
    process.exit(1)
  }

  await fetch(`${BASE}/users/${USER}`, { method: "DELETE" })
  await sleep(500)

  console.log(`Phase 1: Ingest ${CORPUS.length} turns`)
  for (let i = 0; i < CORPUS.length; i++) {
    const t0 = performance.now()
    await ingest(CORPUS[i].content, CORPUS[i].ts)
    const elapsed = performance.now() - t0
    console.log(
      `  [${i + 1}/${CORPUS.length}] ${elapsed.toFixed(0)}ms — ${CORPUS[i].content.slice(0, 55)}…`,
    )
    await sleep(500)
  }

  console.log()
  console.log("Phase 2: Waiting for derivation pipeline…")
  await sleep(8000)

  console.log()
  console.log("Phase 3: Derived memories inspection")
  const derivedR = await fetch(`${BASE}/users/${USER}/derived`)
  const derivedBody = (await derivedR.json()) as { derived_memories?: any[] }
  const derived = derivedBody.derived_memories ?? []

  if (derived.length === 0) {
    console.log("  WARNING: no derived memories found")
    console.log("  Possible causes: EMBED_STUB=1, insufficient turns, or LLM returned empty")
  } else {
    console.log(`  ${derived.length} derived memories:`)
    for (const d of derived) {
      console.log(
        `  [${d.category}] (${d.confidence.toFixed(2)} conf, x${d.reinforcement_count}) ${d.insight.slice(0, 80)}`,
      )
    }
  }

  console.log()
  console.log("Phase 4: A/B probe — same query, derived ON vs OFF")
  console.log()

  interface Row {
    query: string
    type: string
    offHit: boolean
    onHit: boolean
    offProfile: boolean
    onProfile: boolean
    offCitations: number
    onCitations: number
    offLatency: number
    onLatency: number
  }

  const rows: Row[] = []

  for (const probe of PROBES) {
    process.stdout.write(`  ${probe.query.slice(0, 45).padEnd(46)} `)

    const off = await probeRecall(probe.query, true)
    const on = await probeRecall(probe.query, false)

    const offHit = hitsAny(off.context, probe.expect)
    const onHit = hitsAny(on.context, probe.expect)
    const offProfile = hasProfileSection(off.context)
    const onProfile = hasProfileSection(on.context)

    const effect =
      onHit && !offHit ? "+derived" : !onHit && offHit ? "-derived" : "same"
    const profileEffect = onProfile && !offProfile ? "+profile" : ""

    console.log(
      `OFF=${offHit ? "✓" : "✗"} ON=${onHit ? "✓" : "✗"} ${effect} ${profileEffect}`,
    )

    rows.push({
      query: probe.query,
      type: probe.type,
      offHit,
      onHit,
      offProfile,
      onProfile,
      offCitations: off.citations,
      onCitations: on.citations,
      offLatency: off.latency,
      onLatency: on.latency,
    })
  }

  console.log()
  console.log("═══════════════════════════════════════════════════")
  console.log("  Results")
  console.log("═══════════════════════════════════════════════════")
  console.log()

  const header =
    "Query".padEnd(46) +
    " Type       " +
    "Derived OFF    " +
    "Derived ON     " +
    "Effect"
  console.log(header)
  console.log("─".repeat(header.length + 10))

  let offTotal = 0,
    onTotal = 0,
    offProfileTotal = 0,
    onProfileTotal = 0,
    offLatTotal = 0,
    onLatTotal = 0

  for (const r of rows) {
    offTotal += r.offHit ? 1 : 0
    onTotal += r.onHit ? 1 : 0
    offProfileTotal += r.offProfile ? 1 : 0
    onProfileTotal += r.onProfile ? 1 : 0
    offLatTotal += r.offLatency
    onLatTotal += r.onLatency

    const offCell = `${r.offHit ? "✓" : "✗"} ${r.offCitations}c ${r.offProfile ? "📋" : ""}`
    const onCell = `${r.onHit ? "✓" : "✗"} ${r.onCitations}c ${r.onProfile ? "📋" : ""}`
    const effect =
      r.onHit && !r.offHit
        ? "\x1b[32m+derived\x1b[0m"
        : !r.onHit && r.offHit
        ? "\x1b[31m-derived\x1b[0m"
        : "same"

    console.log(
      r.query.slice(0, 45).padEnd(46) +
        " " +
        r.type.padEnd(11) +
        " " +
        offCell.padEnd(15) +
        " " +
        onCell.padEnd(15) +
        " " +
        effect,
    )
  }

  console.log()
  const total = rows.length
  const behavioral = rows.filter(
    (r) => r.type === "behavioral" || r.type === "implicit",
  )
  const bOff = behavioral.filter((r) => r.offHit).length
  const bOn = behavioral.filter((r) => r.onHit).length

  console.log("Summary")
  console.log("───────")
  console.log(`Overall hit rate:           ${offTotal}/${total} → ${onTotal}/${total}`)
  console.log(
    `Behavioral/implicit probes: ${bOff}/${behavioral.length} → ${bOn}/${behavioral.length}  ← derived should help here`,
  )
  console.log(
    `Profile section appears:    ${offProfileTotal}/${total} → ${onProfileTotal}/${total}`,
  )
  console.log(
    `Avg recall latency:         ${(offLatTotal / total).toFixed(0)}ms → ${(onLatTotal / total).toFixed(0)}ms`,
  )

  console.log()
  console.log("Derived memories breakdown:")
  const byCategory: Record<string, number> = {}
  for (const d of derived) {
    byCategory[d.category] = (byCategory[d.category] ?? 0) + 1
  }
  for (const [cat, count] of Object.entries(byCategory)) {
    console.log(`  ${cat}: ${count}`)
  }

  console.log()
  console.log("Hypothesis validation:")
  if (onProfileTotal > offProfileTotal) {
    console.log("  ✓ Profile enrichment confirmed — ## User profile appears with derived ON")
  } else {
    console.log("  ✗ Profile enrichment not visible — check getDerivedContext confidence thresholds")
  }
  if (bOn > bOff) {
    console.log("  ✓ Behavioral query improvement confirmed — derived memories help implicit queries")
  } else if (bOn === bOff) {
    console.log("  ~ Behavioral queries unchanged — patterns may need more turns to derive")
  } else {
    console.log("  ✗ Regression detected — derived memories hurting recall")
  }

  await fetch(`${BASE}/users/${USER}`, { method: "DELETE" })

  console.log()
  console.log("═══════════════════════════════════════════════════")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
