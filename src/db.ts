import { Database } from "bun:sqlite"
import { mkdirSync } from "fs"
import { dirname } from "path"

const DB_PATH = process.env.DB_PATH ?? "/app/data/memory.db"

mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new Database(DB_PATH, { create: true })

let initialized = false

export function initDb(): void {
  if (initialized) return
  initialized = true
  db.run("PRAGMA journal_mode=WAL")
  db.run("PRAGMA foreign_keys=ON")
  db.run("PRAGMA synchronous=NORMAL")

  db.run(`
    CREATE TABLE IF NOT EXISTS turns (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      user_id     TEXT,
      messages    TEXT NOT NULL,
      timestamp   TEXT NOT NULL,
      metadata    TEXT DEFAULT '{}',
      created_at  TEXT DEFAULT (datetime('now'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      turn_id     TEXT NOT NULL,
      type        TEXT NOT NULL,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      confidence  REAL DEFAULT 1.0,
      implicit    INTEGER DEFAULT 0,
      active      INTEGER DEFAULT 1,
      supersedes  TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id        TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      vector    BLOB NOT NULL
    )
  `)

  db.run("CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, active)")
  db.run("CREATE INDEX IF NOT EXISTS idx_memories_key  ON memories(user_id, key, active)")
  db.run("CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id)")

  db.run(`
    CREATE TABLE IF NOT EXISTS memory_associations (
      id          TEXT PRIMARY KEY,
      source_id   TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      strength    REAL NOT NULL,
      created_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (source_id) REFERENCES memories(id),
      FOREIGN KEY (target_id) REFERENCES memories(id)
    )
  `)
  db.run("CREATE INDEX IF NOT EXISTS idx_assoc_source ON memory_associations(source_id)")
  db.run("CREATE INDEX IF NOT EXISTS idx_assoc_target ON memory_associations(target_id)")

  db.run(`
    CREATE TABLE IF NOT EXISTS derived_memories (
      id                   TEXT PRIMARY KEY,
      user_id              TEXT NOT NULL,
      category             TEXT NOT NULL,
      insight              TEXT NOT NULL,
      source_memory_ids    TEXT NOT NULL DEFAULT '[]',
      confidence           REAL DEFAULT 0.7,
      reinforcement_count  INTEGER DEFAULT 1,
      last_reinforced_at   TEXT DEFAULT (datetime('now')),
      active               INTEGER DEFAULT 1,
      created_at           TEXT DEFAULT (datetime('now')),
      updated_at           TEXT DEFAULT (datetime('now'))
    )
  `)
  db.run("CREATE INDEX IF NOT EXISTS idx_derived_user ON derived_memories(user_id, active, category)")

  console.log(`DB ready at ${DB_PATH}`)
}

// Tables must exist before preparing statements
initDb()

// ── Prepared statements (private) ────────────────────────────────────────────

export const q = {
  insertTurn: db.query(`
    INSERT INTO turns (id, session_id, user_id, messages, timestamp, metadata)
    VALUES ($id, $session_id, $user_id, $messages, $timestamp, $metadata)
  `),

  insertMemory: db.query(`
    INSERT INTO memories (id, user_id, session_id, turn_id, type, key, value, confidence, implicit, supersedes)
    VALUES ($id, $user_id, $session_id, $turn_id, $type, $key, $value, $confidence, $implicit, $supersedes)
  `),

  insertEmbedding: db.query(`
    INSERT INTO embeddings (id, memory_id, vector)
    VALUES ($id, $memory_id, $vector)
  `),

  getMemoriesByUser: (userId: string) =>
    db.query(`
      SELECT m.*, e.vector
      FROM memories m
      LEFT JOIN embeddings e ON e.memory_id = m.id
      WHERE m.user_id = $userId AND m.active = 1
      ORDER BY m.created_at DESC
    `).all({ $userId: userId }),

  getAllMemoriesByUser: (userId: string) =>
    db.query(`
      SELECT * FROM memories
      WHERE user_id = $userId
      ORDER BY created_at ASC
    `).all({ $userId: userId }),

  getMemoryByKey: (userId: string, key: string) =>
    db.query(`
      SELECT m.*, e.vector
      FROM memories m
      LEFT JOIN embeddings e ON e.memory_id = m.id
      WHERE m.user_id = $userId AND m.key = $key AND m.active = 1
      LIMIT 1
    `).get({ $userId: userId, $key: key }),

  supersedeMemory: (id: string) =>
    db.query(`
      UPDATE memories SET active = 0, updated_at = datetime('now') WHERE id = $id
    `).run({ $id: id }),

  insertAssociation: db.query(`
    INSERT OR REPLACE INTO memory_associations (id, source_id, target_id, strength)
    VALUES ($id, $source_id, $target_id, $strength)
  `),

  getAssociations: db.query(`
    SELECT target_id, strength FROM memory_associations
    WHERE source_id = $source_id AND strength >= $min_strength
    UNION
    SELECT source_id as target_id, strength FROM memory_associations
    WHERE target_id = $source_id AND strength >= $min_strength
    ORDER BY strength DESC
    LIMIT 20
  `),

  deleteUserAssociations: db.query(`
    DELETE FROM memory_associations
    WHERE source_id IN (SELECT id FROM memories WHERE user_id = $user_id)
    OR target_id IN (SELECT id FROM memories WHERE user_id = $user_id)
  `),

  deleteSessionAssociations: db.query(`
    DELETE FROM memory_associations
    WHERE source_id IN (SELECT id FROM memories WHERE session_id = $session_id)
    OR target_id IN (SELECT id FROM memories WHERE session_id = $session_id)
  `),

  getTurnsBySession: (sessionId: string) =>
    db.query(`
      SELECT * FROM turns WHERE session_id = $sessionId ORDER BY created_at ASC
    `).all({ $sessionId: sessionId }),

  deleteSession: db.transaction((sessionId: string) => {
    db.query(`
      DELETE FROM memory_associations
      WHERE source_id IN (SELECT id FROM memories WHERE session_id = $sessionId)
      OR target_id IN (SELECT id FROM memories WHERE session_id = $sessionId)
    `).run({ $sessionId: sessionId })
    db.query(`
      DELETE FROM derived_memories
      WHERE user_id IN (SELECT DISTINCT user_id FROM turns WHERE session_id = $sessionId)
    `).run({ $sessionId: sessionId })
    db.query(`
      DELETE FROM embeddings WHERE memory_id IN (
        SELECT id FROM memories WHERE session_id = $sessionId
      )
    `).run({ $sessionId: sessionId })
    db.query("DELETE FROM memories WHERE session_id = $sessionId").run({ $sessionId: sessionId })
    db.query("DELETE FROM turns WHERE session_id = $sessionId").run({ $sessionId: sessionId })
  }),

  deleteUser: db.transaction((userId: string) => {
    db.query(`
      DELETE FROM memory_associations
      WHERE source_id IN (SELECT id FROM memories WHERE user_id = $userId)
      OR target_id IN (SELECT id FROM memories WHERE user_id = $userId)
    `).run({ $userId: userId })
    db.query("DELETE FROM derived_memories WHERE user_id = $userId").run({ $userId: userId })
    db.query(`
      DELETE FROM embeddings WHERE memory_id IN (
        SELECT id FROM memories WHERE user_id = $userId
      )
    `).run({ $userId: userId })
    db.query("DELETE FROM memories WHERE user_id = $userId").run({ $userId: userId })
    db.query("DELETE FROM turns WHERE user_id = $userId").run({ $userId: userId })
  }),

  insertDerived: db.query(`
    INSERT INTO derived_memories
      (id, user_id, category, insight, source_memory_ids,
       confidence, reinforcement_count)
    VALUES
      ($id, $user_id, $category, $insight, $source_memory_ids,
       $confidence, $reinforcement_count)
  `),

  getDerivedByUser: db.query(`
    SELECT * FROM derived_memories
    WHERE user_id = $user_id AND active = 1
    ORDER BY confidence DESC, reinforcement_count DESC
  `),

  getDerivedByCategory: db.query(`
    SELECT * FROM derived_memories
    WHERE user_id = $user_id AND category = $category AND active = 1
    ORDER BY confidence DESC
    LIMIT 3
  `),

  reinforceDerived: db.query(`
    UPDATE derived_memories
    SET reinforcement_count = reinforcement_count + 1,
        confidence = MIN(0.98, confidence + 0.05),
        last_reinforced_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = $id
  `),

  deleteDerivedByUser: db.query(`
    DELETE FROM derived_memories WHERE user_id = $user_id
  `),

  deleteDerivedBySession: db.query(`
    DELETE FROM derived_memories
    WHERE user_id IN (
      SELECT DISTINCT user_id FROM turns WHERE session_id = $session_id
    )
  `),
}

export const tx = (fn: () => void) => db.transaction(fn)()
