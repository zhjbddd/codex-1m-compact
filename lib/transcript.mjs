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

/**
 * Strips Antigravity runtime metadata wrappers from USER_INPUT steps so
 * Codex's collect_user_messages preserves clean user intent and constraints.
 */
export function cleanUserMessage(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';

  const userReqMatch = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (userReqMatch) {
    return userReqMatch[1].trim();
  }

  return rawContent
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, '')
    .trim();
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
