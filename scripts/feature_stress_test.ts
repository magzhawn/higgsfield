#!/usr/bin/env bun
/**
 * Feature stress test for the recent extraction + retrieval features.
 *
 * Each phase targets one feature's specific failure mode. Where a per-request
 * flag exists, we true-A/B (HyDE). Where only an env var exists, we restart
 * the container between phases (turn rewriting). Where neither exists, we
 * verify behavior end-to-end (contradiction detection, memory_class).
 *
 * Phases:
 *   1. Turn rewriting   — A/B via DISABLE_TURN_REWRITE env (container restart)
 *                         Targets: subject-confusion + implicit-content extraction
 *   2. Contradiction    — behavioral check (no per-request flag)
 *                         Targets: signal-word-gated supersession of stale facts
 *   3. memory_class     — behavioral check (no per-request flag)
 *                         Targets: hobby/skill accumulation without supersession
 *   4. HyDE             — A/B via disable_hyde request flag
 *                         Targets: query↔document embedding-space gap
 *
 * The container is restarted twice for phase 1 via a temp compose override file
 * (docker-compose.stress.yml) that is created and removed by this script —
 * the canonical docker-compose.yml stays untouched.
 *
 * Usage:
 *   bun run scripts/feature_stress_test.ts
 *   BASE=http://localhost:8080 bun run scripts/feature_stress_test.ts
 *
 * Requires real Voyage credentials — extraction non-determinism in stub mode
 * makes the verification probes unreliable.
 *
 * Estimated runtime: ~6-8 minutes (2 container restarts + 4 phases of ingest/probe).
 */

import { writeFileSync, existsSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"

const BASE = process.env.BASE ?? "http://localhost:8080"
const REPO_ROOT = resolve(import.meta.dir, "..")
const OVERRIDE_PATH = resolve(REPO_ROOT, "docker-compose.stress.yml")

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ─── Docker orchestration ────────────────────────────────────────────────────

async function runDocker(args: string[]): Promise<void> {
  const proc = Bun.spawn(["docker", ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })
  await proc.exited
}

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`)
      if (r.ok) return
    } catch { /* not up yet */ }
    await sleep(1000)
  }
  throw new Error(`health timeout after ${timeoutMs}ms`)
}

async function restartWithRewrite(disabled: boolean): Promise<void> {
  if (disabled) {
    // Temp compose override sets DISABLE_TURN_REWRITE=1 on the memory service
    const override =
      "services:\n  memory:\n    environment:\n      DISABLE_TURN_REWRITE: \"1\"\n"
    writeFileSync(OVERRIDE_PATH, override)
    await runDocker([
      "compose", "-f", "docker-compose.yml", "-f", OVERRIDE_PATH,
      "up", "-d", "--force-recreate",
    ])
  } else {
    if (existsSync(OVERRIDE_PATH)) unlinkSync(OVERRIDE_PATH)
    await runDocker(["compose", "down"])
    await runDocker(["compose", "up", "-d"])
  }
  await sleep(2000)
  await waitForHealth()
}

async function cleanup(): Promise<void> {
  if (existsSync(OVERRIDE_PATH)) unlinkSync(OVERRIDE_PATH)
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

interface Citation { turn_id: string; score: number; snippet: string }
interface RecallResponse { context: string; citations: Citation[]; timings?: Record<string, number> }
interface MemoryRecord {
  id: string; type: string; key: string; value: string
  confidence: number; active: boolean
}

async function ingest(userId: string, sessionId: string, content: string, ts: string): Promise<void> {
  const r = await fetch(`${BASE}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      user_id: userId,
      messages: [{ role: "user", content }],
      timestamp: ts,
      metadata: {},
    }),
  })
  if (!r.ok) throw new Error(`ingest failed: ${r.status} ${await r.text()}`)
}

async function listMemories(userId: string): Promise<MemoryRecord[]> {
  const r = await fetch(`${BASE}/users/${userId}/memories`)
  const body = (await r.json()) as { memories: MemoryRecord[] }
  return body.memories ?? []
}

async function recall(
  userId: string,
  query: string,
  flags: Record<string, boolean> = {},
): Promise<RecallResponse> {
  const r = await fetch(`${BASE}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query, session_id: "stress", user_id: userId, max_tokens: 1024, ...flags,
    }),
  })
  return (await r.json()) as RecallResponse
}

async function deleteUser(userId: string): Promise<void> {
  await fetch(`${BASE}/users/${userId}`, { method: "DELETE" })
}

const containsAny = (text: string, terms: string[]): boolean => {
  const lower = text.toLowerCase()
  return terms.some((t) => lower.includes(t.toLowerCase()))
}

const firstMatchingRank = (citations: Citation[], terms: string[]): number => {
  for (let i = 0; i < citations.length; i++) {
    if (containsAny(citations[i].snippet, terms)) return i + 1
  }
  return Infinity
}

function pad(s: string, n: number, align: "left" | "right" = "left"): string {
  if (s.length >= n) return s.slice(0, n)
  return align === "left" ? s + " ".repeat(n - s.length) : " ".repeat(n - s.length) + s
}

// ─── Result accumulator ──────────────────────────────────────────────────────

interface PhaseResult {
  phase: string
  feature: string
  metric: string
  withFeature: string
  withoutFeature: string
  verdict: "PASS" | "FAIL" | "INFO"
}

const results: PhaseResult[] = []

// ─── PHASE 1 — Turn rewriting A/B ────────────────────────────────────────────
// Tests two failure modes the rewrite step addresses:
//   (a) subject confusion: third-party facts attributed to user identity keys
//   (b) implicit content:  conversational signals not extracted as preferences

const PHASE_1_TURNS = [
  {
    ts: "2025-01-01T09:00:00Z",
    content:
      "I work at Stripe in San Francisco. My friend Marco runs an indie game studio called Tidepool in La Jolla.",
  },
  {
    ts: "2025-01-02T09:00:00Z",
    content:
      "Skip the theory, just show me working code examples. I learn faster from concrete code than abstract explanations.",
  },
]

interface Phase1Snapshot {
  employerValue: string | null
  locationValue: string | null
  hasFriendMarcoKey: boolean
  hasPreferenceKey: boolean
  totalMemories: number
}

async function runPhase1Side(label: string): Promise<Phase1Snapshot> {
  const userId = `stress-rewrite-${label}-${Date.now()}`
  for (const t of PHASE_1_TURNS) {
    await ingest(userId, "rewrite-stress", t.content, t.ts)
    await sleep(500)
  }
  await sleep(6000) // settle
  const mems = await listMemories(userId)
  const active = mems.filter((m) => m.active)

  const findKey = (k: string) => active.find((m) => m.key === k)?.value ?? null

  const snapshot: Phase1Snapshot = {
    employerValue: findKey("employer"),
    locationValue: findKey("location"),
    hasFriendMarcoKey: active.some((m) => m.key.startsWith("friend_marco")),
    hasPreferenceKey: active.some(
      (m) => m.key.startsWith("preference") || m.key.includes("learning") || m.key.includes("communication"),
    ),
    totalMemories: active.length,
  }
  await deleteUser(userId)
  return snapshot
}

async function phase1(): Promise<void> {
  console.log("\n════════════════════════════════════════════════════")
  console.log("  Phase 1 — Turn rewriting (A/B via container restart)")
  console.log("════════════════════════════════════════════════════")

  console.log("→ Restarting WITHOUT turn rewriting (DISABLE_TURN_REWRITE=1)…")
  await restartWithRewrite(true)
  console.log("→ Ingesting corpus…")
  const off = await runPhase1Side("off")
  console.log(`  OFF snapshot: employer=${JSON.stringify(off.employerValue)?.slice(0,60)}, ` +
    `location=${JSON.stringify(off.locationValue)?.slice(0,40)}, ` +
    `friend_marco_key=${off.hasFriendMarcoKey}, preference_key=${off.hasPreferenceKey}, total=${off.totalMemories}`)

  console.log("→ Restarting WITH turn rewriting (default)…")
  await restartWithRewrite(false)
  console.log("→ Ingesting corpus…")
  const on = await runPhase1Side("on")
  console.log(`  ON snapshot:  employer=${JSON.stringify(on.employerValue)?.slice(0,60)}, ` +
    `location=${JSON.stringify(on.locationValue)?.slice(0,40)}, ` +
    `friend_marco_key=${on.hasFriendMarcoKey}, preference_key=${on.hasPreferenceKey}, total=${on.totalMemories}`)

  // Verdicts
  const employerCorrupted = (v: string | null) => v !== null && /tidepool|game studio/i.test(v)
  const locationCorrupted = (v: string | null) => v !== null && /la jolla/i.test(v)

  results.push({
    phase: "1", feature: "turn rewriting", metric: "subject confusion (employer)",
    withFeature: employerCorrupted(on.employerValue) ? "Tidepool ❌" : `${on.employerValue ?? "(none)"}`,
    withoutFeature: employerCorrupted(off.employerValue) ? "Tidepool ❌" : `${off.employerValue ?? "(none)"}`,
    verdict: employerCorrupted(on.employerValue) ? "FAIL" : "PASS",
  })
  results.push({
    phase: "1", feature: "turn rewriting", metric: "subject confusion (location)",
    withFeature: locationCorrupted(on.locationValue) ? "La Jolla ❌" : `${on.locationValue ?? "(none)"}`,
    withoutFeature: locationCorrupted(off.locationValue) ? "La Jolla ❌" : `${off.locationValue ?? "(none)"}`,
    verdict: locationCorrupted(on.locationValue) ? "FAIL" : "PASS",
  })
  results.push({
    phase: "1", feature: "turn rewriting", metric: "third-party prefixed key (friend_marco_*)",
    withFeature: on.hasFriendMarcoKey ? "present ✓" : "absent ✗",
    withoutFeature: off.hasFriendMarcoKey ? "present ✓" : "absent ✗",
    verdict: on.hasFriendMarcoKey ? "PASS" : "FAIL",
  })
  results.push({
    phase: "1", feature: "turn rewriting", metric: "implicit→explicit (preference key)",
    withFeature: on.hasPreferenceKey ? "extracted ✓" : "missed ✗",
    withoutFeature: off.hasPreferenceKey ? "extracted ✓" : "missed ✗",
    verdict: on.hasPreferenceKey && !off.hasPreferenceKey ? "PASS"
      : on.hasPreferenceKey && off.hasPreferenceKey ? "INFO"  // both extracted — rewrite didn't add
      : "FAIL",
  })
}

// ─── PHASE 2 — Contradiction detection ───────────────────────────────────────

async function phase2(): Promise<void> {
  console.log("\n════════════════════════════════════════════════════")
  console.log("  Phase 2 — Contradiction detection (behavioral)")
  console.log("════════════════════════════════════════════════════")
  const userId = `stress-contra-${Date.now()}`
  console.log("→ Ingesting assertion turn (employer = Stripe)…")
  await ingest(userId, "contra-stress",
    "I work at Stripe as a senior engineer.",
    "2025-01-01T09:00:00Z")
  await sleep(6000)
  console.log("→ Ingesting retraction turn (\"I quit\" — signal word triggers Haiku check)…")
  await ingest(userId, "contra-stress",
    "I quit my job last month. No longer employed anywhere.",
    "2025-02-01T09:00:00Z")
  await sleep(8000)

  const mems = await listMemories(userId)
  const employerRows = mems.filter((m) => m.key === "employer")
  const stripeActive = employerRows.find(
    (m) => m.active && /stripe/i.test(m.value),
  )
  console.log(`  employer rows: ${employerRows.length}, Stripe active: ${stripeActive ? "YES ❌" : "no ✓"}`)

  results.push({
    phase: "2", feature: "contradiction detection",
    metric: "Stripe employer superseded after quit",
    withFeature: stripeActive ? "still active ❌" : "deactivated ✓",
    withoutFeature: "n/a (no flag — feature is signal-gated, always-on)",
    verdict: stripeActive ? "FAIL" : "PASS",
  })

  await deleteUser(userId)
}

// ─── PHASE 3 — memory_class accumulation ─────────────────────────────────────

async function phase3(): Promise<void> {
  console.log("\n════════════════════════════════════════════════════")
  console.log("  Phase 3 — memory_class accumulation (behavioral)")
  console.log("════════════════════════════════════════════════════")
  const userId = `stress-accum-${Date.now()}`
  console.log("→ Ingesting hobby turn 1 (hiking)…")
  await ingest(userId, "accum-stress",
    "I go hiking every Sunday morning with my dog.",
    "2025-01-01T09:00:00Z")
  await sleep(6000)
  console.log("→ Ingesting hobby turn 2 (climbing — should NOT supersede hiking)…")
  await ingest(userId, "accum-stress",
    "I also started rock climbing at the gym last month.",
    "2025-02-01T09:00:00Z")
  await sleep(6000)

  const mems = await listMemories(userId)
  const activeHobbies = mems.filter((m) => m.active && m.key.startsWith("hobby"))
  const hasHiking = activeHobbies.some((m) => /hik/i.test(m.value))
  const hasClimbing = activeHobbies.some((m) => /climb/i.test(m.value))

  console.log(`  active hobby memories: ${activeHobbies.length}, ` +
    `hiking=${hasHiking}, climbing=${hasClimbing}`)
  for (const h of activeHobbies) console.log(`    ${h.key}: ${h.value.slice(0, 60)}`)

  results.push({
    phase: "3", feature: "memory_class (accumulating)",
    metric: "both hobbies coexist after second turn",
    withFeature: hasHiking && hasClimbing ? "both active ✓" :
      hasClimbing && !hasHiking ? "hiking lost ❌" :
      hasHiking && !hasClimbing ? "climbing missing ❌" :
      "neither found ❌",
    withoutFeature: "n/a (no flag — pre-fix bug was: second hobby supersedes first)",
    verdict: hasHiking && hasClimbing ? "PASS" : "FAIL",
  })

  await deleteUser(userId)
}

// ─── PHASE 4 — HyDE A/B ──────────────────────────────────────────────────────
// Statement-form facts vs question-form queries with deliberately mismatched
// vocabulary. HyDE generates a hypothetical that lives in document space and
// should bridge the gap that question-form embeddings can't.

const HYDE_CORPUS = [
  { ts: "2025-01-01T09:00:00Z", content: "I am based in Boston, Massachusetts." },
  { ts: "2025-01-02T09:00:00Z", content: "I am employed at Stripe as a backend engineer." },
  { ts: "2025-01-03T09:00:00Z", content: "I follow a vegetarian diet — no meat, no fish." },
  { ts: "2025-01-04T09:00:00Z", content: "My pet is a Welsh Corgi named Pickle." },
  { ts: "2025-01-05T09:00:00Z", content: "I enjoy weekend hiking and rock climbing." },
]

interface HydeProbe {
  query: string
  expect: string[]   // any term hits
}

const HYDE_PROBES: HydeProbe[] = [
  { query: "where does the user reside?",          expect: ["boston", "massachusetts"] },
  { query: "what's the user's profession?",        expect: ["stripe", "engineer", "backend"] },
  { query: "what dietary restrictions does the user follow?", expect: ["vegetarian"] },
  { query: "does the user have any pets?",         expect: ["pickle", "corgi"] },
  { query: "what does the user do for fun?",       expect: ["hiking", "climbing"] },
]

interface HydeRow {
  query: string
  hitOff: boolean
  hitOn: boolean
  rankOff: number
  rankOn: number
}

async function phase4(): Promise<void> {
  console.log("\n════════════════════════════════════════════════════")
  console.log("  Phase 4 — HyDE A/B (per-request flag)")
  console.log("════════════════════════════════════════════════════")
  const userId = `stress-hyde-${Date.now()}`
  console.log(`→ Ingesting ${HYDE_CORPUS.length} statement-form facts…`)
  for (const t of HYDE_CORPUS) {
    await ingest(userId, "hyde-stress", t.content, t.ts)
    await sleep(500)
  }
  await sleep(8000)

  console.log(`→ Probing ${HYDE_PROBES.length} question-form queries × 2 configs…`)
  const rows: HydeRow[] = []
  for (const p of HYDE_PROBES) {
    const off = await recall(userId, p.query, { disable_hyde: true })
    const on = await recall(userId, p.query, { disable_hyde: false })
    const row: HydeRow = {
      query: p.query,
      hitOff: containsAny(off.context, p.expect),
      hitOn: containsAny(on.context, p.expect),
      rankOff: firstMatchingRank(off.citations, p.expect),
      rankOn: firstMatchingRank(on.citations, p.expect),
    }
    rows.push(row)
    const rankStr = (n: number) => (n === Infinity ? "—" : String(n))
    console.log(
      `  ${pad(p.query.slice(0, 48), 50)} ` +
      `OFF ${row.hitOff ? "✓" : "✗"}@${rankStr(row.rankOff)}  ` +
      `ON ${row.hitOn ? "✓" : "✗"}@${rankStr(row.rankOn)}`,
    )
  }

  const hitsOff = rows.filter((r) => r.hitOff).length
  const hitsOn = rows.filter((r) => r.hitOn).length
  const mrr = (rs: HydeRow[], side: "off" | "on") =>
    rs.reduce((s, r) => s + (side === "off"
      ? (r.rankOff === Infinity ? 0 : 1 / r.rankOff)
      : (r.rankOn === Infinity ? 0 : 1 / r.rankOn)), 0) / rs.length
  const mrrOff = mrr(rows, "off")
  const mrrOn = mrr(rows, "on")

  console.log(`  Recall@K:  OFF ${hitsOff}/${rows.length}   ON ${hitsOn}/${rows.length}   Δ ${hitsOn - hitsOff >= 0 ? "+" : ""}${hitsOn - hitsOff}`)
  console.log(`  MRR:       OFF ${mrrOff.toFixed(3)}        ON ${mrrOn.toFixed(3)}     Δ ${(mrrOn - mrrOff >= 0 ? "+" : "")}${(mrrOn - mrrOff).toFixed(3)}`)

  results.push({
    phase: "4", feature: "HyDE",
    metric: `Recall@K on ${rows.length} vocab-mismatch probes`,
    withFeature: `${hitsOn}/${rows.length}`,
    withoutFeature: `${hitsOff}/${rows.length}`,
    verdict: hitsOn >= hitsOff ? "PASS" : "FAIL",
  })
  results.push({
    phase: "4", feature: "HyDE",
    metric: "Mean Reciprocal Rank",
    withFeature: mrrOn.toFixed(3),
    withoutFeature: mrrOff.toFixed(3),
    verdict: mrrOn >= mrrOff ? "PASS" : "INFO",
  })

  await deleteUser(userId)
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════════")
  console.log("  Feature Stress Test — recent extraction + retrieval features")
  console.log("════════════════════════════════════════════════════")
  console.log(`  Service:  ${BASE}`)
  console.log(`  Override: ${OVERRIDE_PATH}`)

  // Don't try to start docker if it's not already up — first phase will restart anyway.
  // But we do need to fail fast if docker isn't reachable at all.
  const initial = await fetch(`${BASE}/health`).catch(() => null)
  if (!initial?.ok) {
    console.log("→ Service not responding — bringing up canonical compose…")
    await runDocker(["compose", "up", "-d"])
    await sleep(2000)
    await waitForHealth()
  }

  try {
    await phase1()
    await phase2()
    await phase3()
    await phase4()
  } finally {
    // Always restore canonical state and remove the override file
    console.log("\n→ Restoring canonical container state…")
    await restartWithRewrite(false)
    await cleanup()
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════════════════════════════════════════════════════════")
  console.log("  Summary — feature stress test results")
  console.log("════════════════════════════════════════════════════════════════════════════════════════════════")
  console.log()
  console.log(
    pad("Ph", 3) + " " +
    pad("Feature", 26) + " " +
    pad("Metric", 36) + " " +
    pad("Without", 22) + " " +
    pad("With", 22) + " " +
    "Verdict"
  )
  console.log("─".repeat(122))
  for (const r of results) {
    const verdictColor =
      r.verdict === "PASS" ? "\x1b[32mPASS\x1b[0m" :
      r.verdict === "FAIL" ? "\x1b[31mFAIL\x1b[0m" :
      "\x1b[33mINFO\x1b[0m"
    console.log(
      pad(r.phase, 3) + " " +
      pad(r.feature, 26) + " " +
      pad(r.metric, 36) + " " +
      pad(r.withoutFeature.slice(0, 22), 22) + " " +
      pad(r.withFeature.slice(0, 22), 22) + " " +
      verdictColor,
    )
  }

  const passes = results.filter((r) => r.verdict === "PASS").length
  const fails  = results.filter((r) => r.verdict === "FAIL").length
  const infos  = results.filter((r) => r.verdict === "INFO").length
  console.log()
  console.log(`Total: ${passes} PASS / ${fails} FAIL / ${infos} INFO  (${results.length} checks)`)
  console.log()
}

main().catch(async (err) => {
  console.error(err)
  await cleanup()
  process.exit(1)
})
