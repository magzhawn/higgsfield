// Associative memory graph — spreading activation theory (Collins & Loftus, 1975)
// Edges represent semantic similarity between memory values.
// Built at write time; traversed at read time after RRF, before the reranker.

import { db, q, tx } from "./db"
import { unpack, cosineSimilarity } from "./embeddings"

const EDGE_MIN_STRENGTH = 0.55
const ACTIVATION_SEED = 1.0
const ACTIVATION_DECAY = 0.7
const ACTIVATION_THRESHOLD = 0.25
const MAX_HOPS = 2
const MAX_CANDIDATES = 50

export interface Association {
  memoryId: string
  activation: number
  hopDepth: number
}

export function buildAssociations(newMemoryIds: string[], userId: string): void {
  if (newMemoryIds.length === 0) return

  const newMems = newMemoryIds
    .map((id) =>
      db.query(`
        SELECT m.id, m.key, m.value, e.vector
        FROM memories m
        LEFT JOIN embeddings e ON e.memory_id = m.id
        WHERE m.id = $id
      `).get({ $id: id }) as any
    )
    .filter((m) => m?.vector)

  if (newMems.length === 0) {
    console.log(`[graph] 0 edges — no vectors for new memories`)
    return
  }

  // Fetch existing active memories, exclude new ones in JS to avoid mixing
  // named and positional params in a single bun:sqlite call.
  const allExisting = db.query(`
    SELECT m.id, m.key, e.vector
    FROM memories m
    JOIN embeddings e ON e.memory_id = m.id
    WHERE m.user_id = $user_id AND m.active = 1
    ORDER BY m.created_at DESC
    LIMIT $limit
  `).all({ $user_id: userId, $limit: MAX_CANDIDATES + newMemoryIds.length }) as any[]

  const newIdsSet = new Set(newMemoryIds)
  const existing = allExisting
    .filter((m) => !newIdsSet.has(m.id as string))
    .slice(0, MAX_CANDIDATES)

  if (existing.length === 0) {
    console.log(`[graph] 0 edges — first batch for user, no prior memories to associate`)
    return
  }

  tx(() => {
    for (const newMem of newMems) {
      const newVec = unpack(newMem.vector as Buffer)
      for (const existMem of existing) {
        if (newMem.id === existMem.id) continue
        const existVec = unpack(existMem.vector as Buffer)
        const strength = cosineSimilarity(newVec, existVec)
        if (strength >= EDGE_MIN_STRENGTH) {
          q.insertAssociation.run({
            $id: `${newMem.id}:${existMem.id}`,
            $source_id: newMem.id,
            $target_id: existMem.id,
            $strength: Math.round(strength * 10000) / 10000,
          })
        }
      }
    }
  })

  const placeholders = newMemoryIds.map(() => "?").join(",")
  const edgeCount =
    (db
      .query(`SELECT COUNT(*) as n FROM memory_associations WHERE source_id IN (${placeholders})`)
      .get(...(newMemoryIds as [string, ...string[]])) as any)?.n ?? 0

  console.log(`[graph] built ${edgeCount} edges for ${newMems.length} new memories`)
}

export async function rebuildGraph(userId: string): Promise<{
  nodesProcessed: number
  edgesBuilt: number
}> {
  db.query(`
    DELETE FROM memory_associations
    WHERE source_id IN (SELECT id FROM memories WHERE user_id = $user_id)
  `).run({ $user_id: userId })

  const memories = db.query(`
    SELECT m.id, m.key, m.value, e.vector
    FROM memories m
    JOIN embeddings e ON e.memory_id = m.id
    WHERE m.user_id = $user_id AND m.active = 1
  `).all({ $user_id: userId }) as any[]

  if (memories.length < 2) {
    return { nodesProcessed: memories.length, edgesBuilt: 0 }
  }

  let edgesBuilt = 0
  tx(() => {
    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const a = memories[i]
        const b = memories[j]
        if (!a.vector || !b.vector) continue
        const sim = cosineSimilarity(unpack(a.vector), unpack(b.vector))
        if (sim >= EDGE_MIN_STRENGTH) {
          q.insertAssociation.run({
            $id: `${a.id}:${b.id}`,
            $source_id: a.id,
            $target_id: b.id,
            $strength: Math.round(sim * 10000) / 10000,
          })
          edgesBuilt++
        }
      }
    }
  })

  console.log(`[graph] full rebuild: ${memories.length} nodes, ${edgesBuilt} edges`)
  return { nodesProcessed: memories.length, edgesBuilt }
}

export function spreadActivation(
  seedIds: string[],
  allMemoryIds: Set<string>
): Association[] {
  if (seedIds.length === 0) return []

  const activation = new Map<string, number>()
  const hopDepth = new Map<string, number>()

  for (const id of seedIds) {
    activation.set(id, ACTIVATION_SEED)
    hopDepth.set(id, 0)
  }

  let frontier = [...seedIds]

  for (let hop = 1; hop <= MAX_HOPS; hop++) {
    const nextFrontier: string[] = []

    for (const sourceId of frontier) {
      const sourceAct = activation.get(sourceId) ?? 0
      const spreadAmount = sourceAct * ACTIVATION_DECAY
      if (spreadAmount < ACTIVATION_THRESHOLD) continue

      const neighbors = q.getAssociations.all({
        $source_id: sourceId,
        $min_strength: EDGE_MIN_STRENGTH,
      }) as Array<{ target_id: string; strength: number }>

      for (const neighbor of neighbors) {
        const neighborAct = spreadAmount * neighbor.strength
        const current = activation.get(neighbor.target_id) ?? 0
        if (neighborAct > current) {
          activation.set(neighbor.target_id, neighborAct)
          hopDepth.set(neighbor.target_id, hop)
          nextFrontier.push(neighbor.target_id)
        }
      }
    }

    frontier = [...new Set(nextFrontier)]
  }

  const seedSet = new Set(seedIds)
  return Array.from(activation.entries())
    .filter(([id, act]) => !seedSet.has(id) && act >= ACTIVATION_THRESHOLD && allMemoryIds.has(id))
    .map(([id, act]) => ({
      memoryId: id,
      activation: Math.round(act * 10000) / 10000,
      hopDepth: hopDepth.get(id) ?? MAX_HOPS,
    }))
    .sort((a, b) => b.activation - a.activation)
}

export function getGraphStats(userId: string): {
  nodeCount: number
  edgeCount: number
  avgDegree: number
} {
  const nodeCount =
    (db
      .query("SELECT COUNT(*) as n FROM memories WHERE user_id = $user_id AND active = 1")
      .get({ $user_id: userId }) as any)?.n ?? 0

  const edgeCount =
    (db
      .query(
        "SELECT COUNT(*) as n FROM memory_associations WHERE source_id IN (SELECT id FROM memories WHERE user_id = $user_id)"
      )
      .get({ $user_id: userId }) as any)?.n ?? 0

  const avgDegree = nodeCount > 0 ? (edgeCount * 2) / nodeCount : 0

  return {
    nodeCount,
    edgeCount,
    avgDegree: Math.round(avgDegree * 100) / 100,
  }
}
