import { loadConfig } from './config.mjs';
import {
  computeLedgerStatus,
  getMeta,
  getMetaNumber,
  openLedgerDb,
  setMeta,
  syncConversationLedger,
} from './ledger.mjs';
import { findLatestConversationId, resolveAppDataDir, resolvePluginDataDir } from './paths.mjs';
import { estimateTokens, formatTokens } from './transcript.mjs';

/**
 * Exact handoff prefix from OpenAI Codex `prompts/templates/compact/summary_prefix.md`
 */
export const CODEX_SUMMARY_PREFIX =
  'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work.';

/**
 * Prompt template aligned with OpenAI Codex `prompts/templates/compact/prompt.md`
 */
export const CODEX_COMPACT_PROMPT_TEMPLATE = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
1. **Current Progress & Key Decisions**: What has been accomplished, architectural choices, trade-offs, and verified outcomes.
2. **Context, Constraints & User Preferences**: Explicit user requirements, negative constraints, environment/API facts, and coding standards that must not be violated.
3. **Remaining Tasks & Clear Next Steps**: Unfinished items, active bugs or failing checks, and immediate next actions.
4. **Critical Data, File Paths & References**: Exact file paths, symbol names, command results, and identifiers required to continue seamlessly without re-reading already analyzed files.

Keep the handoff dense, concrete, and strictly grounded in observed session steps.`;

/**
 * Mirrors Codex's `collect_user_messages` (`codex-rs/core/src/compact.rs`):
 * retains explicit chronological user messages up to `maxTokens` (default 20,000),
 * always preserving the initial root goal while prioritizing the most recent user constraints.
 */
export function collectUserMessages(db, maxTokens = 20000, afterStepIndex = -1) {
  const rows = db.prepare(`
    SELECT step_index, created_at, clean_text, estimated_tokens
    FROM steps
    WHERE (type = 'USER_INPUT' OR source = 'USER_EXPLICIT')
      AND step_index > ?
      AND length(trim(clean_text)) > 0
    ORDER BY step_index ASC
  `).all(afterStepIndex);

  const filtered = rows.filter(
    (r) =>
      !r.clean_text.includes(CODEX_SUMMARY_PREFIX) &&
      !/^\[plan review(?:\s+due)?\]/i.test(r.clean_text.trimStart()),
  );
  if (filtered.length === 0) return [];

  const capMessage = (text, budget) => {
    if (estimateTokens(text) <= budget) return text;
    const maxChars = Math.max(240, Math.floor(budget * 3.4));
    const head = Math.floor(maxChars * 0.65);
    const tail = Math.max(80, maxChars - head);
    return `${text.slice(0, head)}\n...[truncated middle to fit user budget]...\n${text.slice(-tail)}`;
  };

  const selected = [];
  let usedTokens = 0;

  // Always preserve the earliest user objective (up to 25% of user budget).
  const first = filtered[0];
  const firstBudget = Math.max(400, Math.floor(maxTokens * 0.25));
  const firstText = capMessage(first.clean_text, firstBudget);
  const firstTokens = estimateTokens(firstText);
  selected.push({
    stepIndex: first.step_index,
    createdAt: first.created_at,
    text: firstText,
    tokens: firstTokens,
  });
  usedTokens += firstTokens;

  // Fill remaining budget from most recent user turns backwards, then restore chronological order.
  const recentSelected = [];
  for (let i = filtered.length - 1; i >= 1; i -= 1) {
    const row = filtered[i];
    const remaining = maxTokens - usedTokens;
    if (remaining <= 120) break;
    const msgText = capMessage(row.clean_text, Math.min(remaining, Math.floor(maxTokens * 0.45)));
    const msgTokens = estimateTokens(msgText);
    if (msgTokens <= remaining) {
      recentSelected.push({
        stepIndex: row.step_index,
        createdAt: row.created_at,
        text: msgText,
        tokens: msgTokens,
      });
      usedTokens += msgTokens;
    }
  }

  recentSelected.reverse();
  return [...selected, ...recentSelected];
}

/**
 * Synthesizes a 4-section Codex handoff summary deterministically from the 1M SQLite Ledger
 * when compaction is triggered automatically by hooks or one-click UI buttons.
 */
export function buildDeterministicCheckpointSummary({
  db,
  status,
  userMessages,
  focusInstructions = '',
}) {
  const prevCp = db.prepare(`
    SELECT generation, summary_markdown
    FROM checkpoints
    ORDER BY generation DESC
    LIMIT 1
  `).get();

  const recentPlanner = db.prepare(`
    SELECT step_index, clean_text
    FROM steps
    WHERE type = 'PLANNER_RESPONSE' AND step_index > ? AND length(trim(clean_text)) > 0
    ORDER BY step_index DESC
    LIMIT 8
  `).all(status.checkpointAnchorStep);
  recentPlanner.reverse();

  const recentTools = db.prepare(`
    SELECT step_index, clean_text, files_json
    FROM steps
    WHERE type != 'USER_INPUT' AND type != 'PLANNER_RESPONSE' AND step_index > ?
    ORDER BY step_index DESC
    LIMIT 8
  `).all(status.checkpointAnchorStep);
  recentTools.reverse();

  const progressLines = [];
  if (prevCp && prevCp.summary_markdown) {
    progressLines.push(`- Prior Checkpoint #${prevCp.generation} established baseline progress.`);
  }
  for (const p of recentPlanner) {
    const line = p.clean_text.replace(/\s+/g, ' ').trim().slice(0, 260);
    if (line) progressLines.push(`- [Step ${p.step_index}] ${line}`);
  }
  if (progressLines.length === 0) {
    progressLines.push('- Initial exploration and context accumulation completed prior to compaction.');
  }

  const constraintLines = userMessages.map(
    (m) => `- [User @ Step ${m.stepIndex}] ${m.text.replace(/\s+/g, ' ').trim().slice(0, 320)}`,
  );
  if (constraintLines.length === 0) {
    constraintLines.push('- Follow active workspace rules and user instructions.');
  }

  const latestUser = userMessages.length > 0 ? userMessages[userMessages.length - 1].text.trim() : '';
  const todoLines = [];
  if (focusInstructions && focusInstructions.trim()) {
    todoLines.push(`- **Priority Focus**: ${focusInstructions.trim()}`);
  }
  if (latestUser) {
    todoLines.push(`- Continue fulfilling latest user request: ${latestUser.replace(/\s+/g, ' ').slice(0, 320)}`);
  }
  const errorTools = recentTools.filter((t) => /\b(error|failed|exception|exit code [1-9])\b/i.test(t.clean_text));
  for (const errTool of errorTools.slice(-2)) {
    todoLines.push(`- Review recent tool diagnostic at Step ${errTool.step_index}: ${errTool.clean_text.replace(/\s+/g, ' ').slice(0, 180)}`);
  }
  if (todoLines.length === 0) {
    todoLines.push('- Resume active task from the last verified step.');
  }

  const fileLines = (status.filesTouched || []).slice(0, 25).map((f) => `- \`${f}\``);
  if (fileLines.length === 0) {
    fileLines.push('- No file tool targets recorded yet; use `recall_1m_history` if earlier file references are needed.');
  }

  return [
    '### 1. Current Progress & Key Decisions',
    progressLines.join('\n'),
    '',
    '### 2. Context, Constraints & User Preferences',
    constraintLines.join('\n'),
    '',
    '### 3. Remaining Tasks & Clear Next Steps',
    todoLines.join('\n'),
    '',
    '### 4. Critical Data, File Paths & References',
    fileLines.join('\n'),
    `- Full untruncated 1M ledger (${status.totalSteps} steps, ~${formatTokens(status.totalAllTimeEstimatedTokens)} total tokens) is indexed in SQLite FTS5 and queryable via \`recall_1m_history\`.`,
  ].join('\n');
}

/**
 * Mirrors Codex `build_compacted_history`: combines preserved chronological user messages,
 * Codex's `SUMMARY_PREFIX`, and the structured handoff summary.
 */
export function buildCompactedHandoffPayload({
  userMessages,
  summaryMarkdown,
  focusInstructions = '',
  generation = 1,
  beforeTokens = 0,
}) {
  const userSection =
    userMessages.length > 0
      ? userMessages
          .map((m, idx) => `${idx + 1}. [Step ${m.stepIndex}] ${m.text.trim()}`)
          .join('\n')
      : '1. (No prior explicit user messages recorded.)';

  const parts = [
    `[CONTEXT CHECKPOINT COMPACTION #${generation} · Compressed from ${formatTokens(beforeTokens)} effective 1M tokens]`,
    '',
    CODEX_SUMMARY_PREFIX,
    '',
    '## Preserved User Messages (Chronological Intent & Constraints)',
    userSection,
    '',
    '## Handoff Summary',
    summaryMarkdown.trim(),
  ];

  if (focusInstructions && focusInstructions.trim()) {
    parts.push('', `## Compaction Focus`, focusInstructions.trim());
  }

  parts.push(
    '',
    'Proceed directly from this checkpoint without repeating completed steps. Use MCP tool `recall_1m_history` if you ever need verbatim earlier output.',
  );

  return parts.join('\n');
}

/**
 * Generates Codex's prompt payload for interactive LLM-assisted compaction (`/codex-compact`).
 */
export function prepareCodexCompactPrompt({
  conversationId,
  transcriptPath,
  dataDir,
  appDataDir,
  focusInstructions = '',
} = {}) {
  const synced = syncConversationLedger({ conversationId, transcriptPath, dataDir, appDataDir });
  const db = openLedgerDb(synced.conversationId, synced.dataDir);
  try {
    const userMessages = collectUserMessages(
      db,
      synced.config.userMessageMaxTokens,
      synced.status.checkpointAnchorStep,
    );
    const recentSteps = db.prepare(`
      SELECT step_index, type, source, substr(clean_text, 1, 500) AS preview
      FROM steps
      WHERE step_index > ?
      ORDER BY step_index DESC
      LIMIT 18
    `).all(synced.status.checkpointAnchorStep);
    recentSteps.reverse();

    return {
      conversationId: synced.conversationId,
      status: synced.status,
      config: synced.config,
      promptTemplate: CODEX_COMPACT_PROMPT_TEMPLATE,
      focusInstructions: focusInstructions || '',
      preservedUserMessages: userMessages,
      recentTimeline: recentSteps,
      filesTouched: synced.status.filesTouched,
    };
  } finally {
    db.close();
  }
}

/**
 * Executes Codex context compaction: creates a rolling Checkpoint in SQLite,
 * resets the 1M context ledger baseline, and prepares the handoff payload.
 */
export function performCompaction({
  conversationId,
  transcriptPath,
  dataDir,
  appDataDir,
  triggerType = 'manual',
  focusInstructions = '',
  llmHandoffSummary = '',
  queueInPlaceInjection = true,
  handoffConvId = '',
} = {}) {
  const resolvedAppDir = appDataDir || resolveAppDataDir(dataDir);
  const resolvedDataDir = resolvePluginDataDir(dataDir);
  const synced = syncConversationLedger({
    conversationId,
    transcriptPath,
    dataDir: resolvedDataDir,
    appDataDir: resolvedAppDir,
  });

  const db = openLedgerDb(synced.conversationId, resolvedDataDir);
  try {
    const config = loadConfig(resolvedDataDir);
    const beforeStatus = synced.status;
    const beforeTokens = beforeStatus.session1mTokens;

    // Collect user messages across the active window (or full conversation if anchor reset).
    let userMessages = collectUserMessages(db, config.userMessageMaxTokens, beforeStatus.checkpointAnchorStep);
    if (userMessages.length === 0) {
      userMessages = collectUserMessages(db, config.userMessageMaxTokens, -1);
    }

    const summaryMarkdown =
      llmHandoffSummary && llmHandoffSummary.trim()
        ? llmHandoffSummary.trim()
        : buildDeterministicCheckpointSummary({
            db,
            status: beforeStatus,
            userMessages,
            focusInstructions,
          });

    const nextGeneration = beforeStatus.currentGeneration + 1;
    const fullHandoffPayload = buildCompactedHandoffPayload({
      userMessages,
      summaryMarkdown,
      focusInstructions,
      generation: nextGeneration,
      beforeTokens,
    });

    const handoffTokens = estimateTokens(fullHandoffPayload);
    const createdAt = new Date().toISOString();

    db.exec('BEGIN');
    try {
      db.prepare(`
        INSERT INTO checkpoints (
          generation, created_at, trigger_type, focus_instructions,
          before_1m_tokens, after_1m_tokens, step_index,
          user_messages_json, summary_markdown, full_handoff_payload, handoff_conv_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        nextGeneration,
        createdAt,
        triggerType,
        focusInstructions || '',
        beforeTokens,
        handoffTokens,
        beforeStatus.latestStepIndex,
        JSON.stringify(userMessages),
        summaryMarkdown,
        fullHandoffPayload,
        handoffConvId || '',
      );

      setMeta(db, 'cumulative_backend_dropped_tokens', 0);
      setMeta(db, 'pending_recovery_drop_tokens', 0);
      setMeta(db, 'checkpoint_anchor_step', beforeStatus.latestStepIndex);
      setMeta(db, 'checkpoint_anchor_active_tokens', beforeStatus.activeApiTokens);
      setMeta(db, 'checkpoint_handoff_tokens', handoffTokens);
      setMeta(db, 'last_hud_bucket', -1);

      if (queueInPlaceInjection) {
        setMeta(db, 'pending_handoff_injection', fullHandoffPayload);
      } else {
        setMeta(db, 'pending_handoff_injection', '');
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    const afterStatus = computeLedgerStatus(db, config, synced.conversationId, beforeStatus.transcriptFile);

    return {
      conversationId: synced.conversationId,
      generation: nextGeneration,
      createdAt,
      triggerType,
      beforeTokens,
      afterTokens: afterStatus.session1mTokens,
      afterPercentLeft: afterStatus.percentLeft,
      summaryMarkdown,
      fullHandoffPayload,
      userMessageCount: userMessages.length,
      status: afterStatus,
      config,
    };
  } finally {
    db.close();
  }
}

/**
 * Builds an Anti-Amnesia Continuity Anchor when Antigravity's closed-source backend
 * truncates active API prompt tokens significantly earlier than the user's 1M target.
 */
export function buildAntiAmnesiaRecoveryMessage({
  conversationId,
  dataDir,
  droppedTokens,
  status,
  config,
}) {
  const db = openLedgerDb(conversationId, dataDir);
  try {
    const userMessages = collectUserMessages(db, Math.min(8000, config.userMessageMaxTokens), -1);
    const latestCp = db.prepare(`
      SELECT generation, summary_markdown
      FROM checkpoints
      ORDER BY generation DESC
      LIMIT 1
    `).get();

    const userDigest = userMessages
      .map((m, idx) => `${idx + 1}. [Step ${m.stepIndex}] ${m.text.replace(/\s+/g, ' ').trim().slice(0, 300)}`)
      .join('\n');

    const files = (status.filesTouched || []).slice(0, 20).map((f) => `- \`${f}\``).join('\n');

    const lines = [
      `[1M ANTI-AMNESIA SHIELD · Backend window compacted (~${formatTokens(droppedTokens)} tokens dropped from active prompt while 1M session sits at ${formatTokens(status.session1mTokens)} / ${formatTokens(config.modelContextWindow)})]`,
      '',
      CODEX_SUMMARY_PREFIX,
      '',
      '## Preserved User Intent & Negative Constraints',
      userDigest || '1. (Follow active conversation instructions)',
    ];

    if (latestCp && latestCp.summary_markdown) {
      lines.push('', `## Latest Codex Checkpoint #${latestCp.generation}`, latestCp.summary_markdown);
    }

    if (files) {
      lines.push('', '## Active Workspace Files Already Inspected/Edited', files);
    }

    lines.push(
      '',
      'Do NOT forget early constraints or re-read files unnecessarily. If you need exact details from truncated turns, call the MCP tool `recall_1m_history`.',
    );

    setMeta(db, 'pending_recovery_drop_tokens', 0);
    return lines.join('\n');
  } finally {
    db.close();
  }
}

/**
 * Consumes any pending in-place handoff payload queued by the Sidecar UI or MCP tool.
 */
export function consumePendingHandoffInjection(conversationId, dataDir) {
  const db = openLedgerDb(conversationId, dataDir);
  try {
    const pending = getMeta(db, 'pending_handoff_injection', '') || '';
    if (pending) {
      setMeta(db, 'pending_handoff_injection', '');
    }
    return pending;
  } finally {
    db.close();
  }
}

/**
 * Records the latest HUD percentage bucket so milestone badges only fire once per threshold.
 */
export function updateHudBucket(conversationId, dataDir, nextBucket) {
  const db = openLedgerDb(conversationId, dataDir);
  try {
    const prev = getMetaNumber(db, 'last_hud_bucket', -1);
    if (nextBucket !== prev) {
      setMeta(db, 'last_hud_bucket', nextBucket);
      return true;
    }
    return false;
  } finally {
    db.close();
  }
}

/**
 * Deduplicates 'always' mode inline HUD badges so at most one badge appears per user turn
 * rather than repeating on every intermediate tool-loop invocation.
 */
export function updateHudTurnKey(conversationId, dataDir, turnKey) {
  const db = openLedgerDb(conversationId, dataDir);
  try {
    const prev = getMeta(db, 'last_hud_turn_key', '');
    if (turnKey && turnKey !== prev) {
      setMeta(db, 'last_hud_turn_key', turnKey);
      return true;
    }
    return false;
  } finally {
    db.close();
  }
}

/**
 * Formats a concise Codex-style human-readable status report for MCP or CLI inspection.
 */
export function formatCodexStatusMarkdown(status, config) {
  const pctLeft = status.percentLeft.toFixed(1);
  const pctUsed = status.percentUsed.toFixed(1);
  const cachePct = (status.cacheHitRate * 100).toFixed(0);
  const lines = [
    `### Codex 1M Context Status (\`${status.conversationId}\`)`,
    '',
    ...(status.activeModel ? [`- **Active Model**: \`${status.activeModel}\``] : []),
    `- **${pctLeft}% context left** (${pctUsed}% used)`,
    `- **1M Session Usage**: \`${formatTokens(status.session1mTokens)}\` / \`${formatTokens(config.modelContextWindow)}\` (Auto-compact at \`${formatTokens(config.autoCompactTokenLimit)}\` · Effective \`${formatTokens(status.effectiveWindow)}\`)`,
    `- **Active Prompt API Window**: \`${formatTokens(status.activeApiTokens)}\` (Uncached input \`${formatTokens(status.inputTokens)}\` + Cache read \`${formatTokens(status.cacheReadTokens)}\`, Cache hit \`${cachePct}%\`)`,
    `- **Anti-Amnesia Shield**: ${config.antiAmnesiaShield ? 'Enabled' : 'Disabled'} (${status.backendDropCount} backend truncations bridged, \`${formatTokens(status.cumulativeBackendDroppedTokens)}\` preserved in 1M ledger)`,
    `- **Checkpoints Created**: ${status.checkpointCount} (Current generation: #${status.currentGeneration})`,
    `- **Category Breakdown (Active Segment)**: User \`${formatTokens(status.categories.userTokens)}\` · Model \`${formatTokens(status.categories.modelTokens)}\` · Tools \`${formatTokens(status.categories.toolTokens)}\` · Handoff \`${formatTokens(status.categories.handoffTokens)}\``,
    `- **Total Indexed 1M Ledger**: ${status.totalSteps} steps (\`${formatTokens(status.totalAllTimeEstimatedTokens)}\` tokens searchable via \`recall_1m_history\`)`,
  ];
  return lines.join('\n');
}
