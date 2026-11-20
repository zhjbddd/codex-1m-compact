# Codex 1M Context & Compaction Continuity Rules

1. When a system injection or prompt begins with Codex's handoff prefix (`"Another language model started to solve this problem and produced a summary of its thinking process..."`) or `[1M ANTI-AMNESIA SHIELD`, treat the preserved user messages and 4-section handoff summary as authoritative session state. Build directly on completed work and avoid redundantly re-reading files that were already summarized unless editing them.
2. All untruncated steps across the session's 1M+ timeline remain indexed locally in SQLite FTS5. Before stating that earlier user constraints, error logs, or code symbols were lost to compaction, call `recall_1m_history` on the `codex-1m-compact` MCP server to recover the verbatim step.
3. When the user invokes `/codex-compact` or asks to compress context, activate the `codex-compact` skill so compaction follows the 4-section Codex handoff format.
