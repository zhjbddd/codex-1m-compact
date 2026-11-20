import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const PLUGIN_ID = 'codex-1m-compact';

function isUnresolvedPlaceholder(value) {
  return !value || typeof value !== 'string' || value.includes('${');
}

/**
 * Resolves the Antigravity application data directory (e.g. ~/.gemini/antigravity).
 * Honors CODEX_COMPACT_APPDATA_DIR, PLUGIN_DATA, and ANTIGRAVITY_EXECUTABLE_DATA_DIR.
 */
export function resolveAppDataDir(explicitDataDir) {
  if (!isUnresolvedPlaceholder(process.env.CODEX_COMPACT_APPDATA_DIR)) {
    return resolve(process.env.CODEX_COMPACT_APPDATA_DIR);
  }

  for (const candidate of [explicitDataDir, process.env.CODEX_COMPACT_DATA_DIR, process.env.PLUGIN_DATA]) {
    if (isUnresolvedPlaceholder(candidate)) continue;
    const abs = resolve(candidate);
    if (basename(dirname(abs)) === 'plugin_data') {
      return dirname(dirname(abs));
    }
  }

  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (!isUnresolvedPlaceholder(execDataDir)) {
    let cur = resolve(execDataDir);
    while (cur !== dirname(cur)) {
      if (basename(cur) === 'sidecar_data') {
        return dirname(cur);
      }
      cur = dirname(cur);
    }
  }

  return join(homedir(), '.gemini', 'antigravity');
}

/**
 * Resolves and ensures the persistent plugin data directory exists.
 */
export function resolvePluginDataDir(explicitDataDir) {
  let target = null;
  for (const candidate of [
    explicitDataDir,
    process.env.CODEX_COMPACT_DATA_DIR,
    process.env.PLUGIN_DATA,
  ]) {
    if (!isUnresolvedPlaceholder(candidate)) {
      target = resolve(candidate);
      break;
    }
  }
  if (!target) {
    target = join(resolveAppDataDir(), 'plugin_data', PLUGIN_ID);
  }
  mkdirSync(target, { recursive: true });
  return target;
}

/**
 * Resolves transcript_full.jsonl and transcript.jsonl paths for a conversation.
 */
export function resolveTranscriptPaths({ conversationId, transcriptPath, appDataDir } = {}) {
  const baseAppDir = appDataDir || resolveAppDataDir();
  let logsDir = null;

  if (transcriptPath && typeof transcriptPath === 'string' && !isUnresolvedPlaceholder(transcriptPath)) {
    logsDir = dirname(resolve(transcriptPath));
  } else if (conversationId && typeof conversationId === 'string') {
    logsDir = join(baseAppDir, 'brain', sanitizeId(conversationId), '.system_generated', 'logs');
  }

  if (!logsDir) {
    return { logsDir: null, fullPath: null, compactPath: null, preferredPath: null };
  }

  const fullPath = join(logsDir, 'transcript_full.jsonl');
  const compactPath = join(logsDir, 'transcript.jsonl');

  let preferredPath = null;
  if (existsSync(fullPath)) {
    preferredPath = fullPath;
  } else if (existsSync(compactPath)) {
    preferredPath = compactPath;
  } else if (transcriptPath) {
    preferredPath = resolve(transcriptPath);
  }

  return { logsDir, fullPath, compactPath, preferredPath };
}

/**
 * Finds the most recently active conversation ID in <appData>/brain/.
 */
export function findLatestConversationId(appDataDir) {
  const baseAppDir = appDataDir || resolveAppDataDir();
  const brainDir = join(baseAppDir, 'brain');
  if (!existsSync(brainDir)) return null;

  let entries = [];
  try {
    entries = readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let bestId = null;
  let bestMtime = -1;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const convId = entry.name;
    const logsDir = join(brainDir, convId, '.system_generated', 'logs');
    const fullPath = join(logsDir, 'transcript_full.jsonl');
    const compactPath = join(logsDir, 'transcript.jsonl');

    for (const candidate of [fullPath, compactPath]) {
      try {
        const st = statSync(candidate);
        if (st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs;
          bestId = convId;
        }
        break;
      } catch {
        // Ignore missing log files
      }
    }
  }

  return bestId;
}

/**
 * Sanitizes a conversation identifier for safe use in file paths.
 */
export function sanitizeId(id) {
  return String(id || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Atomically writes JSON to disk with Windows EPERM fallback.
 */
export function writeJsonAtomic(filePath, data) {
  const abs = resolve(filePath);
  mkdirSync(dirname(abs), { recursive: true });
  const tmpPath = `${abs}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  const serialized = JSON.stringify(data, null, 2) + '\n';
  writeFileSync(tmpPath, serialized, 'utf-8');
  try {
    renameSync(tmpPath, abs);
  } catch {
    copyFileSync(tmpPath, abs);
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort temp cleanup
    }
  }
}

/**
 * Safely reads and parses a JSON file, returning fallback on missing or corrupt files.
 */
export function readJsonSafe(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
