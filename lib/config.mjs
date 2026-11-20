import { join } from 'node:path';
import { readJsonSafe, resolvePluginDataDir, writeJsonAtomic } from './paths.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  modelContextWindow: 1000000,
  effectiveContextWindowPercent: 95,
  autoCompactTokenLimit: 900000,
  userMessageMaxTokens: 20000,
  autoCompactEnabled: true,
  antiAmnesiaShield: true,
  inlineHudMode: 'always', // 'always' | 'milestones' | 'warnings_only' | 'off'
  preferredHandoffModel: 'inherit',
});

const VALID_HUD_MODES = new Set(['always', 'milestones', 'warnings_only', 'off']);

/**
 * Clamps and validates configuration fields against Codex-aligned limits.
 */
export function normalizeConfig(raw = {}, prev = DEFAULT_CONFIG) {
  const merged = { ...DEFAULT_CONFIG, ...prev, ...raw };

  let modelContextWindow = Math.round(Number(merged.modelContextWindow));
  if (!Number.isFinite(modelContextWindow) || modelContextWindow < 32000) {
    modelContextWindow = DEFAULT_CONFIG.modelContextWindow;
  }
  modelContextWindow = Math.min(2097152, Math.max(32000, modelContextWindow));

  let effectiveContextWindowPercent = Math.round(Number(merged.effectiveContextWindowPercent));
  if (!Number.isFinite(effectiveContextWindowPercent)) {
    effectiveContextWindowPercent = DEFAULT_CONFIG.effectiveContextWindowPercent;
  }
  effectiveContextWindowPercent = Math.min(100, Math.max(50, effectiveContextWindowPercent));

  let autoCompactTokenLimit = Math.round(Number(merged.autoCompactTokenLimit));
  if (!Number.isFinite(autoCompactTokenLimit)) {
    autoCompactTokenLimit = Math.round(modelContextWindow * 0.9);
  }
  autoCompactTokenLimit = Math.min(modelContextWindow, Math.max(16000, autoCompactTokenLimit));

  let userMessageMaxTokens = Math.round(Number(merged.userMessageMaxTokens));
  if (!Number.isFinite(userMessageMaxTokens)) {
    userMessageMaxTokens = DEFAULT_CONFIG.userMessageMaxTokens;
  }
  userMessageMaxTokens = Math.min(200000, Math.max(1000, userMessageMaxTokens));

  const inlineHudMode = VALID_HUD_MODES.has(merged.inlineHudMode)
    ? merged.inlineHudMode
    : DEFAULT_CONFIG.inlineHudMode;

  const preferredHandoffModel =
    typeof merged.preferredHandoffModel === 'string' && merged.preferredHandoffModel.trim()
      ? merged.preferredHandoffModel.trim()
      : 'inherit';

  return {
    modelContextWindow,
    effectiveContextWindowPercent,
    autoCompactTokenLimit,
    userMessageMaxTokens,
    autoCompactEnabled: Boolean(merged.autoCompactEnabled),
    antiAmnesiaShield: Boolean(merged.antiAmnesiaShield),
    inlineHudMode,
    preferredHandoffModel,
  };
}

export function getConfigPath(dataDir) {
  return join(resolvePluginDataDir(dataDir), 'settings.json');
}

/**
 * Loads the persisted Codex 1M compaction policy from settings.json.
 */
export function loadConfig(dataDir) {
  const path = getConfigPath(dataDir);
  const raw = readJsonSafe(path, {});
  return normalizeConfig(raw, DEFAULT_CONFIG);
}

/**
 * Merges and persists updates to settings.json atomically.
 * If modelContextWindow changes without an explicit autoCompactTokenLimit, scales limit proportionally.
 */
export function saveConfig(dataDir, patch = {}) {
  const path = getConfigPath(dataDir);
  const current = loadConfig(dataDir);
  const nextPatch = { ...patch };

  if (
    patch.modelContextWindow !== undefined &&
    patch.autoCompactTokenLimit === undefined &&
    current.modelContextWindow > 0
  ) {
    const ratio = current.autoCompactTokenLimit / current.modelContextWindow;
    const nextWindow = Math.round(Number(patch.modelContextWindow));
    if (Number.isFinite(nextWindow) && nextWindow >= 32000) {
      nextPatch.autoCompactTokenLimit = Math.round(nextWindow * ratio);
    }
  }

  const updated = normalizeConfig(nextPatch, current);
  writeJsonAtomic(path, updated);
  return updated;
}
