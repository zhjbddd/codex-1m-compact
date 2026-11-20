import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatCodexStatusMarkdown,
  performCompaction,
  prepareCodexCompactPrompt,
} from '../lib/compactor.mjs';
import { loadConfig, saveConfig } from '../lib/config.mjs';
import { listCheckpoints, searchLedger, syncConversationLedger } from '../lib/ledger.mjs';
import { findLatestConversationId, resolveAppDataDir, resolvePluginDataDir } from '../lib/paths.mjs';
import { formatTokens } from '../lib/transcript.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = {
  name: 'codex-1m-compact',
  version: '1.0.0',
};

function parseCliArgs(argv) {
  let dataDirArg = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--data-dir=')) {
      dataDirArg = arg.slice('--data-dir='.length);
    } else if (arg === '--data-dir' && argv[i + 1]) {
      dataDirArg = argv[i + 1];
      i += 1;
    }
  }
  const dataDir = resolvePluginDataDir(dataDirArg);
  const appDataDir = resolveAppDataDir(dataDir);
  return { dataDir, appDataDir };
}

const { dataDir, appDataDir } = parseCliArgs(process.argv.slice(2));

const TOOLS = [
  {
    name: 'context_status',
    description:
      'Inspect live 1M context window usage, Codex "% context left", real API prompt/cache hit rate, Antigravity backend truncations bridged by Anti-Amnesia Shield, category token breakdown, and checkpoints.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'string',
          description: 'Optional conversation UUID. Defaults to the most recently active conversation.',
        },
      },
    },
  },
  {
    name: 'get_codex_compact_prompt',
    description:
      'Retrieve OpenAI Codex\'s CONTEXT CHECKPOINT COMPACTION template pre-populated with chronological user messages (20K token budget), recent timeline steps, and touched files so you can author a precision handoff summary before calling compact_now.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'string',
          description: 'Optional conversation UUID. Defaults to the latest active conversation.',
        },
        focusInstructions: {
          type: 'string',
          description: 'Optional user focus directive (like `/compact <focus>` in Codex CLI).',
        },
      },
    },
  },
  {
    name: 'compact_now',
    description:
      'Execute Codex context checkpoint compaction: saves a structured 4-part handoff summary and preserved user constraints to SQLite, resets the 1M ledger baseline, and optionally spawns a clean new Antigravity conversation pre-loaded with the compacted history.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'string',
          description: 'Optional conversation UUID. Defaults to the latest active conversation.',
        },
        focusInstructions: {
          type: 'string',
          description: 'Optional focus instructions for this compaction checkpoint.',
        },
        llmHandoffSummary: {
          type: 'string',
          description:
            'Recommended: your 4-section Codex handoff summary (1. Current Progress & Key Decisions, 2. Context/Constraints/Preferences, 3. Remaining Tasks, 4. Critical Data & File Paths). If omitted, synthesized deterministically from the ledger.',
        },
        spawnNewSession: {
          type: 'boolean',
          description:
            'When true, starts a brand-new clean conversation via agentapi pre-loaded with Codex SUMMARY_PREFIX + handoff summary so physical prompt size resets immediately.',
        },
        model: {
          type: 'string',
          description: 'Optional model alias/id when spawnNewSession is true (e.g. "pro", "flash", or model id).',
        },
      },
    },
  },
  {
    name: 'recall_1m_history',
    description:
      'Full-text search (SQLite FTS5 + BM25) across the entire 1M+ untruncated conversation history—including steps dropped by backend compaction—to recover exact user constraints, code snippets, file paths, or tool outputs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keywords, file path, symbol name, or error message.',
        },
        conversationId: {
          type: 'string',
          description: 'Optional conversation UUID. Defaults to the latest active conversation.',
        },
        sourceFilter: {
          type: 'string',
          description: 'Optional filter such as USER_INPUT, PLANNER_RESPONSE, or GENERIC.',
        },
        stepStart: { type: 'integer' },
        stepEnd: { type: 'integer' },
        limit: {
          type: 'integer',
          description: 'Maximum results to return (default 8, max 30).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'configure_1m_policy',
    description:
      'Configure Codex 1M context window parameters: modelContextWindow (e.g. 1000000, 1048576, 2000000, 400000, 200000), autoCompactTokenLimit (e.g. 900000), effectiveContextWindowPercent (default 95), userMessageMaxTokens (default 20000), autoCompactEnabled, antiAmnesiaShield, or inlineHudMode.',
    inputSchema: {
      type: 'object',
      properties: {
        modelContextWindow: { type: 'integer' },
        autoCompactTokenLimit: { type: 'integer' },
        effectiveContextWindowPercent: { type: 'integer' },
        userMessageMaxTokens: { type: 'integer' },
        autoCompactEnabled: { type: 'boolean' },
        antiAmnesiaShield: { type: 'boolean' },
        inlineHudMode: {
          type: 'string',
          enum: ['always', 'milestones', 'warnings_only', 'off'],
        },
      },
    },
  },
];

function resolveAgentApiBinary() {
  if (process.env.ANTIGRAVITY_AGENTAPI_EXE && existsSync(process.env.ANTIGRAVITY_AGENTAPI_EXE)) {
    return process.env.ANTIGRAVITY_AGENTAPI_EXE;
  }
  const localAppData = process.env.LOCALAPPDATA || '';
  if (localAppData) {
    const candidate = join(localAppData, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function spawnCompactedConversation({ payload, model, title }) {
  const exe = resolveAgentApiBinary();
  if (!exe) {
    throw new Error('Could not locate Antigravity language_server.exe / ANTIGRAVITY_AGENTAPI_EXE to spawn a new session.');
  }
  const args = ['agentapi', 'new-conversation'];
  if (model && model !== 'inherit') {
    args.push('--model', model);
  }
  if (title) {
    args.push('--title', title);
  }
  args.push(payload);

  const out = execFileSync(exe, args, {
    encoding: 'utf-8',
    env: process.env,
    timeout: 20000,
  });
  return out.trim() ? JSON.parse(out) : {};
}

function resolveConvId(args) {
  if (args?.conversationId && String(args.conversationId).trim()) {
    return String(args.conversationId).trim();
  }
  return findLatestConversationId(appDataDir) || 'default';
}

function callTool(name, args = {}) {
  const convId = resolveConvId(args);

  if (name === 'context_status') {
    const synced = syncConversationLedger({ conversationId: convId, dataDir, appDataDir });
    const checkpoints = listCheckpoints(synced.conversationId, dataDir, 5);
    const md = formatCodexStatusMarkdown(synced.status, synced.config);
    return {
      content: [{ type: 'text', text: md }],
      structuredContent: {
        status: synced.status,
        config: synced.config,
        recentCheckpoints: checkpoints,
      },
    };
  }

  if (name === 'get_codex_compact_prompt') {
    const prep = prepareCodexCompactPrompt({
      conversationId: convId,
      dataDir,
      appDataDir,
      focusInstructions: args.focusInstructions || '',
    });

    const userPreview = prep.preservedUserMessages
      .map((m, idx) => `${idx + 1}. [Step ${m.stepIndex}] ${m.text}`)
      .join('\n');

    const text = [
      prep.promptTemplate,
      '',
      prep.focusInstructions ? `**User Focus**: ${prep.focusInstructions}` : '**User Focus**: (none specified)',
      '',
      `### Preserved Chronological User Messages (${prep.preservedUserMessages.length} turns, budget ${formatTokens(prep.config.userMessageMaxTokens)} tokens)`,
      userPreview || '(none)',
      '',
      `### Touched Files (${prep.filesTouched.length})`,
      prep.filesTouched.map((f) => `- ${f}`).join('\n') || '(none)',
      '',
      `### Current 1M Usage`,
      `${prep.status.percentLeft.toFixed(1)}% context left (${formatTokens(prep.status.session1mTokens)} / ${formatTokens(prep.config.modelContextWindow)})`,
    ].join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: prep,
    };
  }

  if (name === 'compact_now') {
    let handoffConvId = '';
    const compacted = performCompaction({
      conversationId: convId,
      dataDir,
      appDataDir,
      triggerType: args.spawnNewSession ? 'manual_handoff' : 'manual_in_place',
      focusInstructions: args.focusInstructions || '',
      llmHandoffSummary: args.llmHandoffSummary || '',
      queueInPlaceInjection: false,
    });

    let spawnError = null;
    if (args.spawnNewSession) {
      try {
        const res = spawnCompactedConversation({
          payload: compacted.fullHandoffPayload,
          model: args.model || compacted.config.preferredHandoffModel,
          title: `Compacted #${compacted.generation} (${formatTokens(compacted.beforeTokens)} -> ${formatTokens(compacted.afterTokens)})`,
        });
        handoffConvId =
          res?.conversationId ||
          res?.conversation_id ||
          res?.response?.conversationId ||
          res?.response?.conversation_id ||
          '';
      } catch (err) {
        spawnError = err?.message || String(err);
      }
    }

    const lines = [
      `🗜️ **Context compacted (Codex 1M)** · Checkpoint #${compacted.generation}`,
      `- **Before**: \`${formatTokens(compacted.beforeTokens)}\` / \`${formatTokens(compacted.config.modelContextWindow)}\``,
      `- **After**: \`${formatTokens(compacted.afterTokens)}\` (**${compacted.afterPercentLeft.toFixed(1)}% context left**)`,
      `- **Preserved User Turns**: ${compacted.userMessageCount}`,
    ];

    if (handoffConvId) {
      lines.push(`- **Clean Continuation Session**: [${handoffConvId}](conversation://${handoffConvId})`);
    } else if (spawnError) {
      lines.push(`- **Session Handoff Note**: In-place checkpoint succeeded; spawning separate session failed (${spawnError}).`);
    }

    lines.push('', '### Handoff Summary Saved', compacted.summaryMarkdown);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        ...compacted,
        handoffConvId,
        spawnError,
      },
    };
  }

  if (name === 'recall_1m_history') {
    const res = searchLedger({
      conversationId: convId,
      dataDir,
      appDataDir,
      query: args.query,
      sourceFilter: args.sourceFilter,
      stepStart: args.stepStart,
      stepEnd: args.stepEnd,
      limit: args.limit,
    });

    const formatted =
      res.results.length === 0
        ? `No matches found in 1M ledger for query: \`${args.query}\`.`
        : res.results
            .map(
              (r) =>
                `#### [Step ${r.step_index}] ${r.type} (${r.source}) · ~${formatTokens(r.estimated_tokens)} tokens\n` +
                `Files: ${r.files_json}\n` +
                `${r.content || r.snippet}`,
            )
            .join('\n\n---\n\n');

    return {
      content: [{ type: 'text', text: formatted }],
      structuredContent: res,
    };
  }

  if (name === 'configure_1m_policy') {
    const patch = {};
    for (const key of [
      'modelContextWindow',
      'autoCompactTokenLimit',
      'effectiveContextWindowPercent',
      'userMessageMaxTokens',
      'autoCompactEnabled',
      'antiAmnesiaShield',
      'inlineHudMode',
    ]) {
      if (args[key] !== undefined) patch[key] = args[key];
    }
    const updated = saveConfig(dataDir, patch);
    const thresholdPct = Math.round((updated.autoCompactTokenLimit / updated.modelContextWindow) * 100);
    const summary = [
      `✅ **Codex 1M Policy Updated**`,
      `- **Model Context Window**: \`${formatTokens(updated.modelContextWindow)}\` (${updated.modelContextWindow.toLocaleString()} tokens)`,
      `- **Auto-Compact Threshold**: \`${formatTokens(updated.autoCompactTokenLimit)}\` (${thresholdPct}%) · Enabled: ${updated.autoCompactEnabled}`,
      `- **Effective Window Target**: ${updated.effectiveContextWindowPercent}%`,
      `- **Preserved User Budget**: \`${formatTokens(updated.userMessageMaxTokens)}\``,
      `- **Anti-Amnesia Shield**: ${updated.antiAmnesiaShield}`,
      `- **Inline HUD Mode**: \`${updated.inlineHudMode}\``,
    ].join('\n');

    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: { config: updated },
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// Dual-framing stdio transport (newline-delimited JSON default, Content-Length auto-detected).
let useContentLength = false;
let recvBuffer = Buffer.alloc(0);

function sendResponse(msg) {
  const json = JSON.stringify(msg);
  if (useContentLength) {
    const byteLen = Buffer.byteLength(json, 'utf-8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

function handleRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;

  // Notifications without id do not receive responses.
  if (id === undefined || id === null) {
    return;
  }

  try {
    if (method === 'initialize') {
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
        },
      });
      return;
    }

    if (method === 'ping') {
      sendResponse({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const result = callTool(toolName, toolArgs);
      sendResponse({
        jsonrpc: '2.0',
        id,
        result,
      });
      return;
    }

    sendResponse({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    });
  } catch (err) {
    sendResponse({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: err?.message || String(err),
      },
    });
  }
}

function processBuffer() {
  while (recvBuffer.length > 0) {
    // Strip leading whitespace/newlines when looking for framing header.
    const asText = recvBuffer.toString('utf-8');
    const trimmedStart = asText.replace(/^[\r\n]+/, '');
    if (trimmedStart.length !== asText.length) {
      const drop = Buffer.byteLength(asText, 'utf-8') - Buffer.byteLength(trimmedStart, 'utf-8');
      recvBuffer = recvBuffer.subarray(drop);
      if (recvBuffer.length === 0) break;
    }

    if (recvBuffer.subarray(0, 15).toString('ascii').toLowerCase().startsWith('content-length:')) {
      useContentLength = true;
      const headerEnd = recvBuffer.indexOf('\r\n\r\n');
      const altEnd = headerEnd >= 0 ? headerEnd : recvBuffer.indexOf('\n\n');
      const sepLen = headerEnd >= 0 ? 4 : 2;
      if (altEnd < 0) break;

      const headerStr = recvBuffer.subarray(0, altEnd).toString('ascii');
      const match = headerStr.match(/content-length:\s*(\d+)/i);
      if (!match) {
        recvBuffer = recvBuffer.subarray(altEnd + sepLen);
        continue;
      }
      const len = Number(match[1]);
      const bodyStart = altEnd + sepLen;
      if (recvBuffer.length < bodyStart + len) break;

      const body = recvBuffer.subarray(bodyStart, bodyStart + len).toString('utf-8');
      recvBuffer = recvBuffer.subarray(bodyStart + len);
      try {
        handleRpcMessage(JSON.parse(body));
      } catch (err) {
        process.stderr.write(`[codex-1m-compact mcp] invalid JSON payload: ${err.message}\n`);
      }
    } else {
      const nlIdx = recvBuffer.indexOf(0x0a);
      if (nlIdx < 0) break;
      const line = recvBuffer.subarray(0, nlIdx).toString('utf-8').trim();
      recvBuffer = recvBuffer.subarray(nlIdx + 1);
      if (!line) continue;
      try {
        handleRpcMessage(JSON.parse(line));
      } catch (err) {
        process.stderr.write(`[codex-1m-compact mcp] invalid JSON line: ${err.message}\n`);
      }
    }
  }
}

// Initialize config eagerly at startup.
loadConfig(dataDir);

process.stdin.on('data', (chunk) => {
  recvBuffer = Buffer.concat([recvBuffer, chunk]);
  processBuffer();
});

process.stdin.on('end', () => {
  process.exit(0);
});
