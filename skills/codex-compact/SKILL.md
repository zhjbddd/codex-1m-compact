---
name: codex-compact
description: >-
  OpenAI Codex-aligned 1M context checkpoint compaction and context management.
  Use when the user runs /codex-compact, asks to compact or compress the
  conversation context, asks how much context is left ("context left",
  "token usage"), wants to configure a 1M/2M context window or auto-compact
  threshold (e.g. 900K), or needs to recall untruncated details from earlier turns.
---

# Codex 1M Context Compaction

This skill connects Antigravity to the `codex-1m-compact` MCP server so
context compaction, 1M window accounting, and handoff continuity match OpenAI
Codex CLI (`/compact`, `compact.rs`, `900K / 1.0M` checkpoints).

## Workflows

### 1. Inspect Context Status ("how much context is left?")
1. Call `codex-1m-compact`'s `context_status` tool.
2. Report the Codex-style metrics concisely:
   - **`XX.X% context left`** (`<session1mTokens> / <modelContextWindow>`)
   - Active API prompt window & prompt cache hit rate
   - Any backend early truncations bridged by the **1M Anti-Amnesia Shield**
   - Active checkpoints count and FTS5 1M ledger coverage.

### 2. Perform Codex Checkpoint Compaction (`/codex-compact [focus]`)
When the user asks to compact/compress the context (optionally specifying a
focus such as `/codex-compact focus on API migration`):
1. Call `get_codex_compact_prompt` (passing `focusInstructions` if the user
   provided one).
2. Read the returned Codex `CONTEXT CHECKPOINT COMPACTION` template, preserved
   chronological user messages (`20K` budget), and recent timeline.
3. Synthesize a crisp, grounded **4-section Codex Handoff Summary**:
   - **1. Current Progress & Key Decisions**
   - **2. Context, Constraints & User Preferences**
   - **3. Remaining Tasks & Clear Next Steps**
   - **4. Critical Data, File Paths & References**
4. Decide whether to create a fresh physical window (`spawnNewSession: true` if
   the user explicitly asked for a clean session / physical window reset, or
   `false` for an in-place checkpoint that preserves the current thread while
   resetting the 1M baseline).
5. Call `compact_now` with `llmHandoffSummary`, `focusInstructions`, and
   `spawnNewSession`.
6. Present the compacted summary card (`before -> after`, `XX.X% context left`,
   Checkpoint `#N`), and if `handoffConvId` was returned, include a clickable
   link: `[Continue in Compacted Session →](conversation://<handoffConvId>)`.

### 3. Configure 1M Window & Thresholds
When the user asks to change the window size (e.g., `1M`, `1048576`, `2M`),
auto-compact threshold (`900K`, `85%`), HUD mode, or Anti-Amnesia Shield:
1. Call `configure_1m_policy` with the requested fields.
2. Confirm the updated settings clearly.

### 4. Recall Untruncated 1M History
If earlier instructions, file paths, symbol names, or command outputs were
truncated from the active prompt:
1. Call `recall_1m_history` with targeted keywords or file names.
2. Answer directly from the exact verbatim steps recovered from the SQLite FTS5
   1M ledger.
