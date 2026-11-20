import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './config.mjs';
import {
  findLatestConversationId,
  resolveAppDataDir,
  resolvePluginDataDir,
  resolveTranscriptPaths,
  sanitizeId,
} from './paths.mjs';
import { summarizeStepForIndex } from './transcript.mjs';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS steps (
  step_index INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  files_json TEXT NOT NULL DEFAULT '[]',
  clean_text TEXT NOT NULL DEFAULT '',
  raw_preview TEXT NOT NULL DEFAULT ''
);

CREATE VIRTUAL TABLE IF NOT EXISTS steps_fts USING fts5(
  step_index UNINDEXED,
  source,
  type,
  files_text,
  clean_text
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  focus_instructions TEXT NOT NULL DEFAULT '',
  before_1m_tokens INTEGER NOT NULL DEFAULT 0,
  after_1m_tokens INTEGER NOT NULL DEFAULT 0,
  step_index INTEGER NOT NULL DEFAULT -1,
  user_messages_json TEXT NOT NULL DEFAULT '[]',
  summary_markdown TEXT NOT NULL DEFAULT '',
  full_handoff_payload TEXT NOT NULL DEFAULT '',
  handoff_conv_id TEXT NOT NULL DEFAULT ''
);
`;

export function getLedgerDbPath(conversationId, dataDir) {
  const pluginData = resolvePluginDataDir(dataDir);
  const convDir = join(pluginData, 'conversations');
  mkdirSync(convDir, { recursive: true });
  return join(convDir, `${sanitizeId(conversationId)}.db`);
}

export function openLedgerDb(conversationId, dataDir) {
  const dbPath = getLedgerDbPath(conversationId, dataDir);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA_SQL);
  return db;
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function getMetaNumber(db, key, fallback = 0) {
  const val = getMeta(db, key, null);
  if (val === null) return fallback;
  const num = Number(val);
  return Number.isFinite(num) ? num : fallback;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function readNewCompleteLines(filePath, startOffset) {
  if (!filePath || !existsSync(filePath)) {
    return { lines: [], nextOffset: startOffset, reset: false };
  }

  const stat = statSync(filePath);
  let offset = Math.max(0, startOffset);
  let reset = false;

  if (stat.size < offset) {
    offset = 0;
    reset = true;
  }

  if (stat.size === offset) {
    return { lines: [], nextOffset: offset, reset };
  }

  const bytesToRead = stat.size - offset;
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(filePath, 'r');
  try {
    let totalRead = 0;
    while (totalRead < bytesToRead) {
      const n = readSync(fd, buffer, totalRead, bytesToRead - totalRead, offset + totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
    const slice = totalRead === bytesToRead ? buffer : buffer.subarray(0, totalRead);
    const lastNewline = slice.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return { lines: [], nextOffset: offset, reset };
    }
    const completeBuf = slice.subarray(0, lastNewline + 1);
    const text = completeBuf.toString('utf-8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return {
      lines,
      nextOffset: offset + lastNewline + 1,
      reset,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Incrementally ingests transcript_full.jsonl / transcript.jsonl into the SQLite 1M Ledger
 * and computes live Codex-aligned 1M context metrics.
 */
export function syncConversationLedger({
  conversationId,
  transcriptPath,
  dataDir,
  appDataDir,
} = {}) {
  const resolvedAppDir = appDataDir || resolveAppDataDir(dataDir);
  const resolvedDataDir = resolvePluginDataDir(dataDir);
  const convId = conversationId || findLatestConversationId(resolvedAppDir) || 'default';

  const db = openLedgerDb(convId, resolvedDataDir);
  try {
    const paths = resolveTranscriptPaths({
      conversationId: convId,
      transcriptPath,
      appDataDir: resolvedAppDir,
    });

    const sourceFile = paths.preferredPath;
    if (sourceFile && existsSync(sourceFile)) {
      const prevFile = getMeta(db, 'ingested_file', '');
      let offset = getMetaNumber(db, 'ingested_offset', 0);
      if (prevFile && prevFile !== sourceFile) {
        offset = 0;
      }

      const { lines, nextOffset } = readNewCompleteLines(sourceFile, offset);

      if (lines.length > 0 || prevFile !== sourceFile) {
        const existsStmt = db.prepare('SELECT 1 FROM steps WHERE step_index = ?');
        const insertStepStmt = db.prepare(`
          INSERT INTO steps (
            step_index, source, type, created_at,
            input_tokens, cache_read_tokens, output_tokens,
            estimated_tokens, files_json, clean_text, raw_preview
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertFtsStmt = db.prepare(`
          INSERT INTO steps_fts (step_index, source, type, files_text, clean_text)
          VALUES (?, ?, ?, ?, ?)
        `);

        let lastActiveApi = getMetaNumber(db, 'last_active_api_tokens', 0);
        let anchorActive = getMetaNumber(db, 'checkpoint_anchor_active_tokens', 0);
        let cumulativeDropped = getMetaNumber(db, 'cumulative_backend_dropped_tokens', 0);
        let dropCount = getMetaNumber(db, 'backend_drop_count', 0);
        let pendingRecoveryDrop = getMetaNumber(db, 'pending_recovery_drop_tokens', 0);
        let linesIngested = getMetaNumber(db, 'ingested_lines', 0);

        db.exec('BEGIN');
        try {
          for (const line of lines) {
            let parsed;
            try {
              parsed = JSON.parse(line);
            } catch {
              continue;
            }
            if (!Number.isFinite(Number(parsed.step_index))) continue;

            const normalized = summarizeStepForIndex(parsed);
            const already = existsStmt.get(normalized.stepIndex);
            if (already) {
              continue;
            }

            insertStepStmt.run(
              normalized.stepIndex,
              normalized.source,
              normalized.type,
              normalized.createdAt,
              normalized.inputTokens,
              normalized.cacheReadTokens,
              normalized.outputTokens,
              normalized.estimatedTokens,
              JSON.stringify(normalized.filesTouched),
              normalized.cleanText,
              normalized.rawPreview,
            );

            insertFtsStmt.run(
              normalized.stepIndex,
              normalized.source,
              normalized.type,
              normalized.filesTouched.join(' '),
              normalized.cleanText,
            );

            linesIngested += 1;

            if (normalized.type === 'PLANNER_RESPONSE') {
              const currActive = normalized.inputTokens + normalized.cacheReadTokens;
              if (currActive > 0) {
                if (lastActiveApi > 0 && (lastActiveApi - currActive) > Math.max(20000, lastActiveApi * 0.25)) {
                  let dropped = 0;
                  if (currActive >= anchorActive) {
                    dropped = lastActiveApi - currActive;
                  } else {
                    dropped = Math.max(0, lastActiveApi - anchorActive);
                    anchorActive = currActive;
                  }
                  cumulativeDropped += dropped;
                  dropCount += 1;
                  pendingRecoveryDrop = lastActiveApi - currActive;
                }
                lastActiveApi = currActive;
              }
            }
          }

          setMeta(db, 'ingested_file', sourceFile);
          setMeta(db, 'ingested_offset', nextOffset);
          setMeta(db, 'ingested_lines', linesIngested);
          setMeta(db, 'last_active_api_tokens', lastActiveApi);
          setMeta(db, 'checkpoint_anchor_active_tokens', anchorActive);
          setMeta(db, 'cumulative_backend_dropped_tokens', cumulativeDropped);
          setMeta(db, 'backend_drop_count', dropCount);
          setMeta(db, 'pending_recovery_drop_tokens', pendingRecoveryDrop);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }
    }

    const config = loadConfig(resolvedDataDir);
    const status = computeLedgerStatus(db, config, convId, sourceFile);
    return {
      conversationId: convId,
      dataDir: resolvedDataDir,
      appDataDir: resolvedAppDir,
      config,
      status,
    };
  } finally {
    db.close();
  }
}

/**
 * Computes full 1M context metrics and breakdowns from the SQLite ledger.
 */
export function computeLedgerStatus(db, config, conversationId = '', transcriptFile = null) {
  const checkpointAnchorStep = getMetaNumber(db, 'checkpoint_anchor_step', -1);
  const checkpointAnchorActiveTokens = getMetaNumber(db, 'checkpoint_anchor_active_tokens', 0);
  const checkpointHandoffTokens = getMetaNumber(db, 'checkpoint_handoff_tokens', 0);
  const cumulativeBackendDroppedTokens = getMetaNumber(db, 'cumulative_backend_dropped_tokens', 0);
  const backendDropCount = getMetaNumber(db, 'backend_drop_count', 0);
  const pendingRecoveryDropTokens = getMetaNumber(db, 'pending_recovery_drop_tokens', 0);
  const pendingHandoffInjection = getMeta(db, 'pending_handoff_injection', '') || '';

  const latestStepRow = db.prepare('SELECT COALESCE(MAX(step_index), -1) AS max_step, COUNT(*) AS step_count FROM steps').get();
  const latestStepIndex = Number(latestStepRow?.max_step ?? -1);
  const totalSteps = Number(latestStepRow?.step_count ?? 0);

  const latestPlanner = db.prepare(`
    SELECT step_index, input_tokens, cache_read_tokens, output_tokens
    FROM steps
    WHERE type = 'PLANNER_RESPONSE' AND (input_tokens + cache_read_tokens) > 0
    ORDER BY step_index DESC
    LIMIT 1
  `).get();

  const latestPlannerStep = latestPlanner ? Number(latestPlanner.step_index) : -1;
  const inputTokens = latestPlanner ? Number(latestPlanner.input_tokens) : 0;
  const cacheReadTokens = latestPlanner ? Number(latestPlanner.cache_read_tokens) : 0;
  const lastOutputTokens = latestPlanner ? Number(latestPlanner.output_tokens) : 0;
  const activeApiTokens = inputTokens + cacheReadTokens;
  const cacheHitRate = activeApiTokens > 0 ? cacheReadTokens / activeApiTokens : 0;

  const postAnchorFloor = Math.max(checkpointAnchorStep, latestPlannerStep);
  const postPlannerRow = db.prepare(`
    SELECT COALESCE(SUM(estimated_tokens), 0) AS est
    FROM steps
    WHERE step_index > ?
  `).get(postAnchorFloor);
  const postPlannerEstimatedTokens = Number(postPlannerRow?.est || 0);

  // Category breakdown since last checkpoint anchor
  const catRows = db.prepare(`
    SELECT type, source, COALESCE(SUM(estimated_tokens), 0) AS est
    FROM steps
    WHERE step_index > ?
    GROUP BY type, source
  `).all(checkpointAnchorStep);

  let userTokens = 0;
  let modelTokens = 0;
  let toolTokens = 0;
  for (const row of catRows) {
    const est = Number(row.est || 0);
    if (row.type === 'USER_INPUT' || row.source === 'USER_EXPLICIT') {
      userTokens += est;
    } else if (row.type === 'PLANNER_RESPONSE') {
      modelTokens += est;
    } else {
      toolTokens += est;
    }
  }

  const allTimeRow = db.prepare('SELECT COALESCE(SUM(estimated_tokens), 0) AS total_est FROM steps').get();
  const totalAllTimeEstimatedTokens = Number(allTimeRow?.total_est || 0);

  let session1mTokens = 0;
  if (activeApiTokens > 0 && latestPlannerStep > checkpointAnchorStep) {
    // Active prompt tokens reported by the API since the last checkpoint + bridged backend drops + unbilled tail.
    const apiDelta = checkpointAnchorStep >= 0
      ? Math.max(0, activeApiTokens - checkpointAnchorActiveTokens)
      : activeApiTokens;
    session1mTokens =
      apiDelta +
      cumulativeBackendDroppedTokens +
      postPlannerEstimatedTokens +
      checkpointHandoffTokens;
  } else {
    // Either before the first planner API measurement or immediately after a checkpoint reset.
    session1mTokens = checkpointHandoffTokens + userTokens + modelTokens + toolTokens;
  }

  const modelContextWindow = config.modelContextWindow;
  const effectiveWindow = Math.round((modelContextWindow * config.effectiveContextWindowPercent) / 100);
  const autoCompactTokenLimit = config.autoCompactTokenLimit;

  const percentUsed = modelContextWindow > 0 ? Math.min(100, (session1mTokens / modelContextWindow) * 100) : 0;
  const percentLeft = Math.max(0, 100 - percentUsed);

  const fileRows = db.prepare('SELECT files_json FROM steps WHERE files_json != \'[]\' ORDER BY step_index DESC LIMIT 200').all();
  const filesSet = new Set();
  for (const r of fileRows) {
    try {
      const arr = JSON.parse(r.files_json);
      if (Array.isArray(arr)) {
        for (const f of arr) {
          if (f && filesSet.size < 40) filesSet.add(f);
        }
      }
    } catch {
      // ignore
    }
  }

  const cpRow = db.prepare('SELECT COUNT(*) AS cnt, COALESCE(MAX(generation), 0) AS max_gen FROM checkpoints').get();
  const checkpointCount = Number(cpRow?.cnt || 0);
  const currentGeneration = Number(cpRow?.max_gen || 0);

  return {
    conversationId,
    transcriptFile,
    modelContextWindow,
    effectiveWindow,
    autoCompactTokenLimit,
    session1mTokens,
    activeApiTokens,
    inputTokens,
    cacheReadTokens,
    lastOutputTokens,
    cacheHitRate,
    cumulativeBackendDroppedTokens,
    backendDropCount,
    pendingRecoveryDropTokens,
    hasPendingHandoffInjection: pendingHandoffInjection.length > 0,
    checkpointAnchorStep,
    checkpointHandoffTokens,
    postPlannerEstimatedTokens,
    percentUsed,
    percentLeft,
    totalSteps,
    latestStepIndex,
    totalAllTimeEstimatedTokens,
    categories: {
      userTokens,
      modelTokens,
      toolTokens,
      handoffTokens: checkpointHandoffTokens,
    },
    filesTouched: [...filesSet],
    checkpointCount,
    currentGeneration,
  };
}

/**
 * Lists stored Codex compaction checkpoints for a conversation.
 */
export function listCheckpoints(conversationId, dataDir, limit = 20) {
  const resolvedDataDir = resolvePluginDataDir(dataDir);
  const convId = conversationId || findLatestConversationId(resolveAppDataDir(dataDir)) || 'default';
  const db = openLedgerDb(convId, resolvedDataDir);
  try {
    return db.prepare(`
      SELECT id, generation, created_at, trigger_type, focus_instructions,
             before_1m_tokens, after_1m_tokens, step_index, summary_markdown, handoff_conv_id
      FROM checkpoints
      ORDER BY generation DESC
      LIMIT ?
    `).all(limit);
  } finally {
    db.close();
  }
}

/**
 * Sanitizes an arbitrary natural-language/path query into safe quoted FTS5 terms.
 */
function buildSafeFtsQuery(rawQuery) {
  const tokens = String(rawQuery || '')
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

/**
 * Searches the full 1M+ conversation history stored in SQLite FTS5.
 */
export function searchLedger({
  conversationId,
  dataDir,
  appDataDir,
  query,
  sourceFilter,
  stepStart,
  stepEnd,
  limit = 8,
} = {}) {
  const resolvedAppDir = appDataDir || resolveAppDataDir(dataDir);
  const resolvedDataDir = resolvePluginDataDir(dataDir);
  const convId = conversationId || findLatestConversationId(resolvedAppDir) || 'default';

  syncConversationLedger({ conversationId: convId, dataDir: resolvedDataDir, appDataDir: resolvedAppDir });
  const db = openLedgerDb(convId, resolvedDataDir);
  try {
    const safeLimit = Math.min(30, Math.max(1, Number(limit) || 8));
    const ftsQuery = buildSafeFtsQuery(query);
    if (!ftsQuery) {
      const rows = db.prepare(`
        SELECT step_index, source, type, created_at, estimated_tokens, files_json,
               substr(clean_text, 1, 600) AS snippet
        FROM steps
        ORDER BY step_index DESC
        LIMIT ?
      `).all(safeLimit);
      return { conversationId: convId, query: '', results: rows };
    }

    const conditions = ['steps_fts MATCH ?'];
    const params = [ftsQuery];

    if (sourceFilter && typeof sourceFilter === 'string') {
      conditions.push('(s.source = ? OR s.type = ?)');
      params.push(sourceFilter, sourceFilter);
    }
    if (Number.isFinite(Number(stepStart))) {
      conditions.push('s.step_index >= ?');
      params.push(Number(stepStart));
    }
    if (Number.isFinite(Number(stepEnd))) {
      conditions.push('s.step_index <= ?');
      params.push(Number(stepEnd));
    }

    params.push(safeLimit);

    let rows = [];
    try {
      rows = db.prepare(`
        SELECT s.step_index, s.source, s.type, s.created_at, s.estimated_tokens, s.files_json,
               snippet(steps_fts, 4, '[', ']', ' ... ', 28) AS snippet,
               substr(s.clean_text, 1, 1400) AS content,
               bm25(steps_fts) AS rank
        FROM steps_fts
        JOIN steps s ON s.step_index = steps_fts.step_index
        WHERE ${conditions.join(' AND ')}
        ORDER BY rank ASC
        LIMIT ?
      `).all(...params);
    } catch {
      const likeTerm = `%${String(query).trim()}%`;
      rows = db.prepare(`
        SELECT step_index, source, type, created_at, estimated_tokens, files_json,
               substr(clean_text, 1, 600) AS snippet,
               substr(clean_text, 1, 1400) AS content
        FROM steps
        WHERE clean_text LIKE ? OR files_json LIKE ?
        ORDER BY step_index DESC
        LIMIT ?
      `).all(likeTerm, likeTerm, safeLimit);
    }

    return {
      conversationId: convId,
      query,
      results: rows,
    };
  } finally {
    db.close();
  }
}
