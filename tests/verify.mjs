import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_SUMMARY_PREFIX } from '../lib/compactor.mjs';
import { searchLedger, syncConversationLedger } from '../lib/ledger.mjs';
import { findLatestConversationId } from '../lib/paths.mjs';
import { cleanUserMessage } from '../lib/transcript.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');

function makeStepLine(step) {
  return JSON.stringify(step) + '\n';
}

function runHook(eventName, payload, env) {
  const res = spawnSync('node', ['scripts/hook-runner.mjs', eventName], {
    cwd: PLUGIN_ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  assert.equal(res.status, 0, `${eventName} exited with ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

async function runMcpSession(requests, env) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn('node', ['mcp/server.mjs', `--data-dir=${env.CODEX_COMPACT_DATA_DIR}`], {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responses = [];
    let outBuf = '';
    let errBuf = '';

    child.stdout.on('data', (chunk) => {
      outBuf += chunk.toString('utf-8');
      const lines = outBuf.split(/\r?\n/);
      outBuf = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) {
          responses.push(JSON.parse(line));
        }
      }
      if (responses.length >= requests.filter((r) => r.id !== undefined).length) {
        child.stdin.end();
      }
    });

    child.stderr.on('data', (chunk) => {
      errBuf += chunk.toString('utf-8');
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`MCP server exited ${code}: ${errBuf}`));
      } else {
        resolvePromise({ responses, errBuf });
      }
    });

    for (const req of requests) {
      child.stdin.write(JSON.stringify(req) + '\n');
    }
  });
}

const tempRoot = mkdtempSync(join(tmpdir(), 'codex-1m-compact-test-'));
const appDataDir = join(tempRoot, 'appdata');
const dataDir = join(appDataDir, 'plugin_data', 'codex-1m-compact');
const convId = '11111111-2222-3333-4444-555555555555';
const logsDir = join(appDataDir, 'brain', convId, '.system_generated', 'logs');
mkdirSync(logsDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const transcriptFull = join(logsDir, 'transcript_full.jsonl');
const testEnv = {
  CODEX_COMPACT_APPDATA_DIR: appDataDir,
  CODEX_COMPACT_DATA_DIR: dataDir,
  PLUGIN_DATA: dataDir,
};

try {
  console.log('1. Testing Transcript Ingestion & Real Token Accounting...');
  const initialLines = [
    makeStepLine({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-18T00:00:00Z',
      content: '<USER_REQUEST>\nConstraint ZERO_TRUST_TOKEN: never use SHA-256 without HMAC in src/auth.ts.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nIgnore this metadata\n</ADDITIONAL_METADATA>',
    }),
    makeStepLine({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-18T00:00:05Z',
      input_tokens: 40000,
      cache_read_tokens: 120000,
      output_tokens: 650,
      content: 'Inspected auth module and preserved HMAC constraint.',
      tool_calls: [{ name: 'read_file', args: { Path: '"e:\\project\\src\\auth.ts"' } }],
    }),
    makeStepLine({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-18T00:00:06Z',
      content: 'export function verifyToken() { /* HMAC-SHA256 implementation */ }',
    }),
  ];
  writeFileSync(transcriptFull, initialLines.join(''), 'utf-8');

  assert.equal(
    cleanUserMessage('<USER_REQUEST>\nhello world\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nmeta\n</ADDITIONAL_METADATA>'),
    'hello world',
  );

  const s1 = syncConversationLedger({
    conversationId: convId,
    transcriptPath: transcriptFull,
    dataDir,
    appDataDir,
  });
  assert.equal(s1.status.activeApiTokens, 160000);
  assert.equal(s1.status.cacheHitRate, 120000 / 160000);
  assert.equal(s1.status.session1mTokens >= 160000, true);
  assert.equal(s1.status.filesTouched.includes('e:\\project\\src\\auth.ts'), true);
  console.log('   PASS: Exact API tokens (160K), cache hit (75%), and cleanUserMessage verified.');

  console.log('2. Testing 1M Anti-Amnesia Shield on Early Backend Truncation (160K -> 35K)...');
  appendFileSync(
    transcriptFull,
    makeStepLine({
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-18T00:01:00Z',
      input_tokens: 15000,
      cache_read_tokens: 20000,
      output_tokens: 300,
      content: 'Backend silently compacted early window.',
    }),
    'utf-8',
  );

  const hookShieldOut = runHook(
    'PreInvocation',
    { conversationId: convId, transcriptPath: transcriptFull },
    testEnv,
  );
  assert.equal(hookShieldOut.injectSteps.length, 1);
  const shieldStep = hookShieldOut.injectSteps[0].systemMessage;
  assert.match(shieldStep.metadata.user_markdown, /Anti-Amnesia Shield/);
  assert.match(shieldStep.systemMessage, /ZERO_TRUST_TOKEN/);
  assert.match(shieldStep.systemMessage, /Another language model started to solve this problem/);

  const s2 = syncConversationLedger({
    conversationId: convId,
    transcriptPath: transcriptFull,
    dataDir,
    appDataDir,
  });
  assert.equal(s2.status.backendDropCount, 1);
  assert.equal(s2.status.cumulativeBackendDroppedTokens, 125000);
  assert.equal(s2.status.session1mTokens, 160000);
  console.log('   PASS: Bridged 125K silent backend drop -> 1M ledger stayed at 160K + injected Anti-Amnesia anchor.');

  console.log('3. Testing Automatic 900K Codex Compaction (780K API + 125K Bridged = 905K)...');
  appendFileSync(
    transcriptFull,
    [
      makeStepLine({
        step_index: 4,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-11-18T00:02:00Z',
        content: '<USER_REQUEST>\nNow migrate tests to Vitest and keep API backward compatible.\n</USER_REQUEST>',
      }),
      makeStepLine({
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-18T00:02:20Z',
        input_tokens: 280000,
        cache_read_tokens: 500000,
        output_tokens: 900,
        content: 'Updated auth integration tests and validated token expiry.',
        tool_calls: [{ name: 'edit_file', args: { Path: '"e:\\project\\tests\\auth.test.ts"' } }],
      }),
    ].join(''),
    'utf-8',
  );

  const hookCompactOut = runHook(
    'PreInvocation',
    { conversationId: convId, transcriptPath: transcriptFull },
    testEnv,
  );
  assert.equal(hookCompactOut.injectSteps.length, 1);
  const compactStep = hookCompactOut.injectSteps[0].systemMessage;
  assert.match(compactStep.metadata.user_markdown, /Context compacted \(Codex 1M\)/);
  assert.ok(compactStep.systemMessage.includes(CODEX_SUMMARY_PREFIX));
  assert.match(compactStep.systemMessage, /### 1\. Current Progress & Key Decisions/);
  assert.match(compactStep.systemMessage, /### 2\. Context, Constraints & User Preferences/);
  assert.match(compactStep.systemMessage, /### 3\. Remaining Tasks & Clear Next Steps/);
  assert.match(compactStep.systemMessage, /### 4\. Critical Data, File Paths & References/);
  assert.match(compactStep.systemMessage, /ZERO_TRUST_TOKEN/);

  const s3 = syncConversationLedger({
    conversationId: convId,
    transcriptPath: transcriptFull,
    dataDir,
    appDataDir,
  });
  assert.equal(s3.status.checkpointCount, 1);
  assert.ok(s3.status.session1mTokens < 25000, `Expected reset <25K, got ${s3.status.session1mTokens}`);
  assert.ok(s3.status.percentLeft > 97, `Expected >97% left, got ${s3.status.percentLeft}`);
  console.log(`   PASS: Auto-compacted at 905K -> reset to ${s3.status.session1mTokens} tokens (${s3.status.percentLeft.toFixed(1)}% left).`);

  console.log('4. Testing FTS5 1M History Recall...');
  const recallRes = searchLedger({
    conversationId: convId,
    dataDir,
    appDataDir,
    query: 'ZERO_TRUST_TOKEN',
  });
  assert.ok(recallRes.results.length >= 1, 'Expected FTS5 to find ZERO_TRUST_TOKEN');
  assert.equal(recallRes.results[0].step_index, 0);
  console.log('   PASS: FTS5 retrieved exact untruncated Step 0 constraint after compaction.');

  console.log('5. Testing Stdio MCP Server End-to-End...');
  const mcpResult = await runMcpSession(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'context_status', arguments: { conversationId: convId } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'configure_1m_policy', arguments: { modelContextWindow: 1048576, autoCompactTokenLimit: 920000 } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_codex_compact_prompt', arguments: { conversationId: convId, focusInstructions: 'Keep Vitest plan' } } },
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'compact_now',
          arguments: {
            conversationId: convId,
            focusInstructions: 'Keep Vitest plan',
            llmHandoffSummary: '### 1. Current Progress & Key Decisions\n- Auth verified.\n### 2. Context, Constraints & User Preferences\n- ZERO_TRUST_TOKEN\n### 3. Remaining Tasks & Clear Next Steps\n- Run Vitest.\n### 4. Critical Data, File Paths & References\n- src/auth.ts',
          },
        },
      },
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'recall_1m_history', arguments: { conversationId: convId, query: 'HMAC-SHA256' } } },
    ],
    testEnv,
  );
  assert.equal(mcpResult.responses.length, 7);
  const toolsListResp = mcpResult.responses.find((r) => r.id === 2);
  assert.equal(toolsListResp.result.tools.length, 5);
  const cfgResp = mcpResult.responses.find((r) => r.id === 4);
  assert.equal(cfgResp.result.structuredContent.config.modelContextWindow, 1048576);
  const compactResp = mcpResult.responses.find((r) => r.id === 6);
  assert.equal(compactResp.result.structuredContent.generation, 2);
  const searchResp = mcpResult.responses.find((r) => r.id === 7);
  assert.ok(searchResp.result.structuredContent.results.length >= 1);
  console.log('   PASS: Stdio MCP server handled initialize, tools/list, and all 5 tools cleanly.');

  console.log('6. Running Read-Only Smoke Test on Live Conversation Transcript...');
  const realAppDir = join(homedir(), '.gemini', 'antigravity');
  const realConvId = findLatestConversationId(realAppDir);
  const realTranscript = realConvId
    ? join(realAppDir, 'brain', realConvId, '.system_generated', 'logs', 'transcript_full.jsonl')
    : '';
  if (realConvId && existsSync(realTranscript)) {
    const smokeDataDir = join(tempRoot, 'smoke_data');
    mkdirSync(smokeDataDir, { recursive: true });
    const smoke = syncConversationLedger({
      conversationId: realConvId,
      transcriptPath: realTranscript,
      dataDir: smokeDataDir,
      appDataDir: realAppDir,
    });
    assert.ok(smoke.status.totalSteps > 0, 'Expected real transcript steps > 0');
    assert.ok(smoke.status.activeApiTokens > 0, 'Expected real API tokens > 0');
    console.log(
      `   PASS: Real conversation parsed (${smoke.status.totalSteps} steps, ` +
      `${smoke.status.activeApiTokens} active API tokens, ` +
      `${smoke.status.percentLeft.toFixed(1)}% of 1M left).`,
    );
  } else {
    console.log('   SKIP: Real transcript not found at default path.');
  }

  console.log('\nALL TESTS PASSED');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
