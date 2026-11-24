const CJK_REGEX = /[\u3400-\u9FFF\uF900-\uFAFF]/g;

/**
 * Fast hybrid token estimator calibrated for CJK prose and code/JSON payloads.
 */
export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = Math.max(0, text.length - cjkCount);
  return Math.max(1, Math.round(cjkCount * 0.68 + nonCjkCount / 3.8));
}

const MODEL_ALIASES = new Map([
  ['model_placeholder_m318', 'Gemini 3.8 Flash (High)'],
  ['model_placeholder_m319', 'Gemini 3.8 Flash (Medium)'],
  ['model_placeholder_m320', 'Gemini 3.8 Flash (Low)'],
  ['model_placeholder_m322', 'Gemini 3.8 Flash (Tiered)'],
  ['model_placeholder_m400', 'Claude Opus 5.5 (Low)'],
  ['model_placeholder_m401', 'Claude Opus 5.5 (Medium)'],
  ['model_placeholder_m402', 'Claude Opus 5.5 (High)'],
  ['model_placeholder_m403', 'Claude Sonnet 5.5 (Low)'],
  ['model_placeholder_m404', 'Claude Sonnet 5.5 (Medium)'],
  ['model_placeholder_m405', 'Claude Sonnet 5.5 (High)'],
  ['model_placeholder_m417', 'Gemini 4 Argon (High)'],
  ['model_placeholder_m418', 'Gemini 4 Argon (Medium)'],
  ['model_placeholder_m419', 'Gemini 4 Argon (Low)'],
  ['model_placeholder_m427', 'Gemini 4 Carbon (High)'],
  ['model_placeholder_m437', 'Gemini 4 Carbon (Medium)'],
  ['model_placeholder_m438', 'Gemini 4 Carbon (Low)'],
  ['model_placeholder_m525', 'Gemini 4 Hydrogen (High)'],
  ['model_placeholder_m526', 'Gemini 4 Hydrogen (Medium)'],
  ['model_placeholder_m527', 'Gemini 4 Hydrogen (Low)'],
  ['model_placeholder_m528', 'Gemini 4 Hydrogen (XHigh)'],
  ['model_placeholder_m530', 'Gemini 4 Hydrogen (High)'],
  ['model_placeholder_m531', 'Gemini 4 Hydrogen (XHigh)'],
  ['model_placeholder_m532', 'Gemini 4 Neon (High)'],
  ['model_placeholder_m533', 'Gemini 4 Neon (Medium)'],
  ['model_placeholder_m534', 'Gemini 4 Neon (Low)'],
  ['model_placeholder_m535', 'Gemini 4 Neon (XHigh)'],
  ['model_placeholder_m537', 'Orchestrator (Neon)'],
  ['model_placeholder_m578', 'Gemini 4 Hydrogen (Sonar)'],
  ['model_placeholder_m667', 'Orchestrator (Carbon)'],
  ['model_placeholder_m669', 'Gemini 4 Hydrogen (Orchestrator)'],
  ['model_placeholder_m681', 'Orchestrator (Argon)'],
  ['gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'],
  ['gemini-pro-orchestrator', 'Orchestrator (Carbon)'],
  ['gemini-pro-orchestrator-argon', 'Orchestrator (Argon)'],
  ['gemini-flash-worker-agy', 'Gemini 4 Hydrogen (Orchestrator)'],
  ['model_openai_gpt_oss_120b_medium', 'GPT-OSS 120B (Medium)'],
]);

/**
 * Formats Antigravity model IDs/slugs into human-readable labels.
 */
export function formatModelDisplay(rawModel) {
  if (!rawModel || typeof rawModel !== 'string') return '';
  const trimmed = rawModel.trim();
  if (!trimmed) return '';
  const aliased = MODEL_ALIASES.get(trimmed.toLowerCase());
  if (aliased) return aliased;

  const norm = trimmed.toLowerCase().replace(/_/g, '-');
  let m = norm.match(/^gemini-4-(neon|carbon|hydrogen|argon)-(xhigh|high|medium|low|sonar|orchestrator)$/);
  if (m) {
    const fam = m[1][0].toUpperCase() + m[1].slice(1);
    const tier = m[2] === 'xhigh' ? 'XHigh' : m[2][0].toUpperCase() + m[2].slice(1);
    return `Gemini 4 ${fam} (${tier})`;
  }
  m = norm.match(/^gemini-3\.8-flash-(high|medium|low|tiered)$/);
  if (m) {
    const tier = m[1][0].toUpperCase() + m[1].slice(1);
    return `Gemini 3.8 Flash (${tier})`;
  }
  m = norm.match(/^claude-(opus|sonnet|haiku)-(5-5|5\.5|4-6|4\.6|4-5|4\.5)(?:-(high|medium|low|thinking))?$/);
  if (m) {
    const fam = m[1][0].toUpperCase() + m[1].slice(1);
    const ver = m[2].replace('-', '.');
    const tier = m[3] ? ` (${m[3][0].toUpperCase() + m[3].slice(1)})` : '';
    return `Claude ${fam} ${ver}${tier}`;
  }
  m = norm.match(/^gpt-oss-120b-(high|medium|low)$/);
  if (m) {
    return `GPT-OSS 120B (${m[1][0].toUpperCase() + m[1].slice(1)})`;
  }
  return trimmed;
}

/**
 * Returns true if a turn is an internal Plan/Execute transition or ephemeral wrapper
 * that must not be preserved as explicit user intent.
 */
export function isInternalSystemTurn(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return false;
  if (/<USER_REQUEST>/i.test(rawContent)) return false;
  const stripped = rawContent
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, '')
    .replace(/<EPHEMERAL_MESSAGE>[\s\S]*?<\/EPHEMERAL_MESSAGE>/g, '')
    .trim();
  if (!stripped && /<EPHEMERAL_MESSAGE>/i.test(rawContent)) return true;
  return /^\[plan review(?:\s+due)?\]/i.test(stripped);
}

/**
 * Strips Antigravity runtime metadata wrappers from USER_INPUT steps so
 * Codex's collect_user_messages preserves clean user intent and constraints.
 */
export function cleanUserMessage(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';

  const userReqMatch = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (userReqMatch) {
    const inner = userReqMatch[1].trim();
    return /^\[plan review(?:\s+due)?\]/i.test(inner) ? '' : inner;
  }

  if (isInternalSystemTurn(rawContent)) {
    return '';
  }

  const cleaned = rawContent
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, '')
    .replace(/<EPHEMERAL_MESSAGE>[\s\S]*?<\/EPHEMERAL_MESSAGE>/g, '')
    .trim();

  return /^\[plan review(?:\s+due)?\]/i.test(cleaned) ? '' : cleaned;
}

const FILE_ARG_KEYS = ['Path', 'path', 'TargetFile', 'FilePath', 'AbsolutePath', 'file_path'];

/**
 * Extracts normalized file paths and short invocation summaries from planner tool_calls.
 */
export function extractToolCallMeta(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { filesTouched: [], callSummaries: [] };
  }

  const files = new Set();
  const callSummaries = [];

  for (const call of toolCalls) {
    if (!call || typeof call !== 'object') continue;
    const name = call.name || 'tool';
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    const argParts = [];

    for (const key of FILE_ARG_KEYS) {
      if (typeof args[key] === 'string' && args[key].trim()) {
        const cleaned = cleanArgString(args[key]);
        if (cleaned) {
          files.add(cleaned);
          argParts.push(`${key}=${cleaned}`);
        }
      }
    }

    if (typeof args.CommandLine === 'string' && args.CommandLine.trim()) {
      const cmd = cleanArgString(args.CommandLine);
      argParts.push(`cmd=${cmd.slice(0, 120)}`);
    } else if (typeof args.query === 'string' && args.query.trim()) {
      argParts.push(`query=${cleanArgString(args.query).slice(0, 80)}`);
    }

    callSummaries.push(argParts.length > 0 ? `${name}(${argParts.join(', ')})` : `${name}()`);
  }

  return {
    filesTouched: [...files],
    callSummaries,
  };
}

function cleanArgString(val) {
  const trimmed = String(val).trim();
  // Transcript logs sometimes JSON-encode string args inside args values.
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Normalizes a single Antigravity transcript JSONL record for ledger storage and FTS5 indexing.
 */
export function summarizeStepForIndex(step) {
  const stepIndex = Number(step.step_index);
  const source = String(step.source || '');
  const type = String(step.type || '');
  const createdAt = String(step.created_at || '');
  const inputTokens = Math.max(0, Number(step.input_tokens || 0) || 0);
  const cacheReadTokens = Math.max(0, Number(step.cache_read_tokens || 0) || 0);
  const outputTokens = Math.max(0, Number(step.output_tokens || 0) || 0);
  const model = typeof step.model === 'string' ? step.model.trim() : '';
  const rawContent = typeof step.content === 'string' ? step.content : '';

  let cleanText = '';
  let filesTouched = [];

  if (type === 'USER_INPUT' || source === 'USER_EXPLICIT') {
    cleanText = cleanUserMessage(rawContent);
  } else if (type === 'PLANNER_RESPONSE') {
    const { filesTouched: files, callSummaries } = extractToolCallMeta(step.tool_calls);
    filesTouched = files;
    const parts = [];
    if (rawContent.trim()) parts.push(rawContent.trim());
    if (callSummaries.length > 0) parts.push(`Tool calls: ${callSummaries.join('; ')}`);
    cleanText = parts.join('\n');
  } else {
    cleanText = rawContent;
  }

  let estimatedTokens = 0;
  if (type === 'PLANNER_RESPONSE') {
    estimatedTokens = outputTokens > 0
      ? outputTokens
      : estimateTokens(cleanText + (typeof step.thinking === 'string' ? step.thinking : ''));
  } else {
    estimatedTokens = estimateTokens(cleanText || rawContent);
  }

  const rawPreview = (cleanText || rawContent).slice(0, 320);

  return {
    stepIndex,
    source,
    type,
    createdAt,
    model,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    estimatedTokens,
    filesTouched,
    cleanText,
    rawPreview,
  };
}

/**
 * Formats token counts cleanly in Codex style (e.g. 900.0K, 1.0M, 842).
 */
export function formatTokens(n) {
  const num = Math.max(0, Number(n) || 0);
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(2).replace(/\.00$/, '.0')}M`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(Math.round(num));
}
