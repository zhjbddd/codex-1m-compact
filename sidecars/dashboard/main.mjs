import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performCompaction } from '../../lib/compactor.mjs';
import { loadConfig, saveConfig } from '../../lib/config.mjs';
import { listCheckpoints, openLedgerDb, searchLedger, syncConversationLedger } from '../../lib/ledger.mjs';
import { findLatestConversationId, resolveAppDataDir, resolvePluginDataDir } from '../../lib/paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch {
    const fallback = join(homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'index.mjs');
    return await import(pathToFileURL(fallback).href);
  }
}

const { SidecarApp, Response } = await loadSidecarSdk();

const appDataDir = resolveAppDataDir();
const dataDir = resolvePluginDataDir();
loadConfig(dataDir);

function readAsset(filename) {
  return readFileSync(join(__dirname, filename), 'utf-8');
}

function resolveTargetConvId(requested) {
  if (requested && typeof requested === 'string' && requested.trim() && requested !== 'null' && requested !== 'undefined') {
    return requested.trim();
  }
  if (process.env.ANTIGRAVITY_CONVERSATION_ID) {
    return process.env.ANTIGRAVITY_CONVERSATION_ID;
  }
  return findLatestConversationId(appDataDir) || 'default';
}

const app = new SidecarApp();

app.page('/', () => new Response(readAsset('index.html'), { contentType: 'text/html; charset=utf-8' }));
app.page('/styles.css', () => new Response(readAsset('styles.css'), { contentType: 'text/css; charset=utf-8' }));
app.page('/app.js', () => new Response(readAsset('app.js'), { contentType: 'application/javascript; charset=utf-8' }));

app.api(
  '/api/status',
  (data) => {
    const convId = resolveTargetConvId(data.conversationId);
    const synced = syncConversationLedger({
      conversationId: convId,
      dataDir,
      appDataDir,
    });
    const checkpoints = listCheckpoints(synced.conversationId, dataDir, 15);
    return {
      conversationId: synced.conversationId,
      status: synced.status,
      config: synced.config,
      checkpoints,
      lsAvailable: Boolean(process.env.ANTIGRAVITY_LS_ADDRESS),
    };
  },
  'GET',
);

app.api(
  '/api/config',
  (data) => {
    const updated = saveConfig(dataDir, data || {});
    return { config: updated };
  },
  'POST',
);

app.api(
  '/api/search',
  (data) => {
    const convId = resolveTargetConvId(data.conversationId);
    return searchLedger({
      conversationId: convId,
      dataDir,
      appDataDir,
      query: data.q || '',
      limit: Number(data.limit) || 12,
    });
  },
  'GET',
);

app.api(
  '/api/compact',
  (data) => {
    const convId = resolveTargetConvId(data.conversationId);
    const mode = data.mode === 'handoff_session' ? 'handoff_session' : 'in_place';
    const focusInstructions = typeof data.focusInstructions === 'string' ? data.focusInstructions : '';

    const compacted = performCompaction({
      conversationId: convId,
      dataDir,
      appDataDir,
      triggerType: mode === 'handoff_session' ? 'sidecar_handoff' : 'sidecar_in_place',
      focusInstructions,
      queueInPlaceInjection: mode === 'in_place',
    });

    let newConversationId = '';
    let handoffError = null;
    if (mode === 'handoff_session') {
      try {
        const model =
          data.model && data.model !== 'inherit'
            ? data.model
            : compacted.config.preferredHandoffModel && compacted.config.preferredHandoffModel !== 'inherit'
              ? compacted.config.preferredHandoffModel
              : 'pro';
        const res = app.startConversation(compacted.fullHandoffPayload, {
          model,
          projectId: data.projectId || app.config.projectId,
        });
        newConversationId =
          res?.conversationId ||
          res?.conversation_id ||
          res?.response?.conversationId ||
          res?.response?.conversation_id ||
          '';

        if (newConversationId) {
          const db = openLedgerDb(convId, dataDir);
          try {
            db.prepare('UPDATE checkpoints SET handoff_conv_id = ? WHERE generation = ?').run(
              newConversationId,
              compacted.generation,
            );
          } finally {
            db.close();
          }
        }
      } catch (err) {
        handoffError = err?.message || String(err);
      }
    }

    const checkpoints = listCheckpoints(convId, dataDir, 15);
    return {
      mode,
      compacted,
      status: compacted.status,
      config: compacted.config,
      checkpoints,
      newConversationId,
      handoffError,
    };
  },
  'POST',
);

if (!existsSync(join(__dirname, 'index.html'))) {
  throw new Error('Missing dashboard frontend assets.');
}

await app.run();
