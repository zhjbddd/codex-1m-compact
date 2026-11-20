import { readFileSync } from 'node:fs';
import {
  buildAntiAmnesiaRecoveryMessage,
  consumePendingHandoffInjection,
  performCompaction,
  updateHudBucket,
  updateHudTurnKey,
} from '../lib/compactor.mjs';
import { loadConfig } from '../lib/config.mjs';
import { syncConversationLedger } from '../lib/ledger.mjs';
import { resolveAppDataDir, resolvePluginDataDir } from '../lib/paths.mjs';
import { formatTokens } from '../lib/transcript.mjs';

function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf-8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function makeHudStep(markdown, systemText = '') {
  return {
    systemMessage: {
      systemMessage: systemText,
      metadata: {
        user_markdown: markdown,
      },
    },
  };
}

function handleSessionStart(payload, dataDir, appDataDir) {
  const convId = payload.conversationId || 'default';
  const synced = syncConversationLedger({
    conversationId: convId,
    transcriptPath: payload.transcriptPath,
    dataDir,
    appDataDir,
  });
  const config = synced.config;

  if (config.inlineHudMode === 'off') {
    emit({});
    return;
  }

  const thresholdPct = config.modelContextWindow > 0
    ? Math.round((config.autoCompactTokenLimit / config.modelContextWindow) * 100)
    : 90;

  const badge =
    `🟢 **Codex 1M Context Active** · Window \`${formatTokens(config.modelContextWindow)}\` · ` +
    `Auto-compact at \`${formatTokens(config.autoCompactTokenLimit)}\` (\`${thresholdPct}%\`) · ` +
    `\`/codex-compact\` ready`;

  emit({
    injectSteps: [makeHudStep(badge, '')],
  });
}

function handlePreInvocation(payload, dataDir, appDataDir) {
  const convId = payload.conversationId || 'default';
  const synced = syncConversationLedger({
    conversationId: convId,
    transcriptPath: payload.transcriptPath,
    dataDir,
    appDataDir,
  });

  const { status, config } = synced;

  // 1. Automatic Codex compaction at configured 1M threshold (default 900K / 1M).
  if (config.autoCompactEnabled && status.session1mTokens >= config.autoCompactTokenLimit) {
    const compacted = performCompaction({
      conversationId: synced.conversationId,
      transcriptPath: payload.transcriptPath,
      dataDir: synced.dataDir,
      appDataDir: synced.appDataDir,
      triggerType: 'auto_900k',
      queueInPlaceInjection: false,
    });

    const pctLeft = compacted.afterPercentLeft.toFixed(1);
    const badge =
      `🗜️ **Context compacted (Codex 1M)** · ` +
      `\`${formatTokens(compacted.beforeTokens)} → ${formatTokens(compacted.afterTokens)}\` · ` +
      `**${pctLeft}% left** of \`${formatTokens(config.modelContextWindow)}\` · ` +
      `Checkpoint #${compacted.generation}`;

    emit({
      injectSteps: [makeHudStep(badge, compacted.fullHandoffPayload)],
      terminationBehavior: '',
    });
    return;
  }

  // 2. Pending manual checkpoint queued by Sidecar UI ("Compact In-Place").
  const pendingHandoff = consumePendingHandoffInjection(synced.conversationId, synced.dataDir);
  if (pendingHandoff) {
    const pctLeft = status.percentLeft.toFixed(1);
    const badge =
      `🗜️ **Context compacted (Manual Checkpoint #${status.currentGeneration})** · ` +
      `**${pctLeft}% left** (\`${formatTokens(status.session1mTokens)} / ${formatTokens(config.modelContextWindow)}\`)`;

    emit({
      injectSteps: [makeHudStep(badge, pendingHandoff)],
      terminationBehavior: '',
    });
    return;
  }

  // 3. Anti-Amnesia Shield: bridge silent early backend truncation (~140K-250K) up to 1M.
  if (config.antiAmnesiaShield && status.pendingRecoveryDropTokens > 0) {
    const recoveryMsg = buildAntiAmnesiaRecoveryMessage({
      conversationId: synced.conversationId,
      dataDir: synced.dataDir,
      droppedTokens: status.pendingRecoveryDropTokens,
      status,
      config,
    });

    const badge =
      `🛡️ **1M Anti-Amnesia Shield** · Bridged backend truncation ` +
      `(\`-${formatTokens(status.pendingRecoveryDropTokens)}\` preserved in 1M Ledger · ` +
      `**${status.percentLeft.toFixed(1)}% of ${formatTokens(config.modelContextWindow)} left**)`;

    emit({
      injectSteps: [makeHudStep(badge, recoveryMsg)],
      terminationBehavior: '',
    });
    return;
  }

  // 4. Optional zero-token Codex "% context left" inline HUD at milestones or warnings.
  const mode = config.inlineHudMode;
  if (mode === 'off') {
    emit({});
    return;
  }

  let shouldShowHud = false;
  if (mode === 'always') {
    if (status.session1mTokens > 0) {
      const turnKey = `${status.totalSteps}:${String(payload.lastUserInput || '').slice(0, 120)}`;
      if (Number(payload.invocationNum || 0) <= 1) {
        shouldShowHud = updateHudTurnKey(synced.conversationId, synced.dataDir, turnKey);
      }
    }
  } else if (mode === 'warnings_only') {
    if (status.percentLeft <= 20) {
      const bucket = Math.floor(status.percentUsed / 5);
      shouldShowHud = updateHudBucket(synced.conversationId, synced.dataDir, bucket);
    }
  } else {
    // 'milestones': fire once whenever crossing a new 10% usage bucket (10%, 20%, ..., 90%)
    const bucket = Math.floor(status.percentUsed / 10);
    if (bucket >= 1) {
      shouldShowHud = updateHudBucket(synced.conversationId, synced.dataDir, bucket);
    }
  }

  if (shouldShowHud) {
    const icon = status.percentLeft <= 15 ? '🟠' : '⚡';
    const cachePct = (status.cacheHitRate * 100).toFixed(0);
    const badge =
      `${icon} **1M Context**: **${status.percentLeft.toFixed(1)}% left** ` +
      `(\`${formatTokens(status.session1mTokens)} / ${formatTokens(config.modelContextWindow)}\` · ` +
      `Active \`${formatTokens(status.activeApiTokens)}\` · Cache \`${cachePct}%\`) · ` +
      `[1M Context](sidecar://codex-1m-compact/dashboard/)`;

    emit({
      injectSteps: [makeHudStep(badge, '')],
      terminationBehavior: '',
    });
    return;
  }

  emit({});
}

function handlePostToolUse(payload, dataDir, appDataDir) {
  syncConversationLedger({
    conversationId: payload.conversationId || 'default',
    transcriptPath: payload.transcriptPath,
    dataDir,
    appDataDir,
  });
  emit({});
}

function handleStop(payload, dataDir, appDataDir) {
  syncConversationLedger({
    conversationId: payload.conversationId || 'default',
    transcriptPath: payload.transcriptPath,
    dataDir,
    appDataDir,
  });
  emit({ decision: 'allow' });
}

const eventArg = process.argv[2] || '';
const payload = readStdinJson();
const eventName = eventArg || payload.hookEventName || '';

try {
  const dataDir = resolvePluginDataDir(process.env.PLUGIN_DATA);
  const appDataDir = resolveAppDataDir(dataDir);
  // Ensure config file exists on first hook execution.
  loadConfig(dataDir);

  if (eventName === 'SessionStart') {
    handleSessionStart(payload, dataDir, appDataDir);
  } else if (eventName === 'PreInvocation') {
    handlePreInvocation(payload, dataDir, appDataDir);
  } else if (eventName === 'PostToolUse') {
    handlePostToolUse(payload, dataDir, appDataDir);
  } else if (eventName === 'Stop') {
    handleStop(payload, dataDir, appDataDir);
  } else {
    emit({});
  }
} catch (err) {
  process.stderr.write(`[codex-1m-compact hook error] ${err?.stack || err}\n`);
  if (eventName === 'Stop') {
    emit({ decision: 'allow' });
  } else {
    emit({});
  }
}
