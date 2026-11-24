# Codex 1M Compact — Antigravity 1M 上下文与 Codex 对齐压缩插件

`codex-1m-compact` 是一个原生 **Google Antigravity 插件**（零第三方 npm 依赖，基于 Node.js 24 内置 `node:sqlite` + FTS5、`hooks.json`、Stdio MCP Server 与 Sidecar Aux-Pane 面板），旨在解决 Antigravity 后端在 ~140K–250K 提前触发有损压缩的问题，**解锁 1M（1,000,000 Tokens）有效上下文体验，并全面对齐 OpenAI Codex CLI 的压缩机制与交互体验**。

---

## 一、GitHub 相关项目调研与对比

在构建本插件前，我们调研了 GitHub 上 Antigravity 与 OpenAI Codex 生态中上下文监控与压缩的核心开源项目：

| 生态 | 代表项目 / Issue | 核心方案 | 局限性与本插件改进 |
| :--- | :--- | :--- | :--- |
| **Antigravity 监控面板** | `dimitr-io/antigravity-desktop-context` | Sidecar 读取对话数据库，镜像 `/context` token 分类统计 | 仅只读监控，无法控制压缩或防止提前失忆 |
| **Antigravity 环状监控** | `antigravity-context-ring` / `Antigravity-Context-Window-Monitor` / `agy-cockpit` | 监听日志与 `CHECKPOINT` 事件，展示上下文环形占用 | 缺少 Codex 风格的压缩流程、1M 账本与历史检索 |
| **Antigravity 输出减负** | `mksglu/context-mode` | 通过 MCP + SQLite FTS5 过滤冗余工具输出 | 侧重减少工具输出体积，未做 1M 断点续传与防失忆 |
| **Antigravity 核心痛点** | `google-antigravity/antigravity-cli` (`#878`, `#1245`, `#1316`) & `lbjlaq/Antigravity-Manager` | 指出 Gemini/Orchestrator 底层原生支持 1M 窗口，但 closed-source harness 会在 ~140K–250K 强制后台压缩导致"失忆" | 本插件通过 **1M 增量账本 + Anti-Amnesia 盾 + 双模式 Codex 压缩** 无侵入解决 |
| **OpenAI Codex 参考实现** | `openai/codex` (`codex-rs/core/src/compact.rs`, `prompts/templates/compact/prompt.md`, `summary_prefix.md`) | `model_context_window = 1000000`、`model_auto_compact_token_limit = 900000`、`collect_user_messages` (20K 预算)、4 段式 Handoff 模板、`SUMMARY_PREFIX` | **本插件 1:1 复刻其核心算法、阈值模型与提示词结构** |
| **Codex / 1M 社区扩展** | `YeungKC/pi-codex-compact`、`ww-w-ai/super-token-saver`、`ranxianglei/billion-context`、`zaki2993/handoff` | 远程/本地 V1/V2 压缩、1M 交接与跨会话迁移 | 面向 Codex / Pi / Claude Code，本插件将其原生引入 Antigravity |

---

## 二、核心能力与 Codex 对齐矩阵

| Codex 体验指标 / 机制 | OpenAI Codex (`openai/codex`) | `codex-1m-compact` (Antigravity 插件) |
| :--- | :--- | :--- |
| **默认上下文窗口** | `model_context_window = 1000000` (`1.0M`) | 默认 `1,000,000`（支持一键切换 `200K` / `400K` / `1.0M` / `1MiB` / `2.0M`） |
| **自动压缩阈值** | `model_auto_compact_token_limit = 900000` (`90%`) | 默认 `900,000`（支持 50%–95% 滑块与 `configure_1m_policy` 精确调节） |
| **有效窗口保留系数** | `effective_context_window_percent = 95` | 默认 `95%`（`950K` 有效安全上限） |
| **核心指标展示** | `XX% context left`（剩余百分比） | Sidecar 仪表盘 + 对话内零 Token `user_markdown` 里程碑徽章实时展示 |
| **用户指令保留** | `collect_user_messages`（`20,000` tokens 上限） | 自动剥离 `<ADDITIONAL_METADATA>` 等包装标签，按时间线保留首条目标与近期约束 |
| **交接摘要格式** | `CONTEXT CHECKPOINT COMPACTION` (`prompt.md`) + `SUMMARY_PREFIX` | 严格采用 4 段式结构化交接摘要 + Codex 原版 `"Another language model started to solve this problem..."` 前缀 |
| **手动压缩命令** | `/compact [focus]` | `/codex-compact [focus]` Skill + Sidecar 一键压缩（支持原位 Checkpoint 或生成全新干净会话） |
| **防早期失忆（1M 桥接）** | 原生透传至 900K | **1M Anti-Amnesia Shield**：自动探测闭源后端 ~150K 的静默截断，在 `PreInvocation` 自动补齐约束锚点与已读文件清单 |
| **全量历史召回** | 无损/外部记忆 | **SQLite WAL + FTS5 1M Vault**：全量未截断对话写入本地数据库，模型可随时调用 `recall_1m_history` 按 BM25 检索任意历史细节 |

---

## 三、架构设计

```text
Antigravity Transcript (transcript_full.jsonl / transcript.jsonl)
       │  增量字节偏移读取（Hook / MCP / Sidecar 共享）
       ▼
┌──────────────────────────────────────────────────────────┐
│  SQLite WAL + FTS5 1M Ledger (plugin_data/conversations) │
│  • 真实 API 统计 (input_tokens + cache_read_tokens)       │
│  • 后端早截断检测 (cumulative_backend_dropped_tokens)      │
│  • 1M 会话等效占用 (session_1m_tokens / 1,000,000)         │
│  • Codex 滚动 Checkpoint 存储 & FTS5 全文倒排索引          │
└───────┬──────────────────────────┬───────────────────────┘
        │                          │
        ▼                          ▼
┌───────────────────┐    ┌───────────────────────────────┐
│ Lifecycle Hooks   │    │ MCP Server + Skill + Sidecar   │
│ (hooks.json)      │    │                               │
│ • SessionStart    │    │ • /codex-compact [focus]      │
│ • PreInvocation   │    │ • context_status              │
│   1. >=900K 自动压缩│   │ • compact_now (原位/新会话)    │
│   2. 消费UI手动压缩 │   │ • recall_1m_history (FTS5)    │
│   3. 反失忆护盾锚点 │   │ • configure_1m_policy         │
│   4. 零Token进度HUD│   │ • Sidecar Aux-Pane 实时仪表盘 │
│ • PostToolUse/Stop│    └───────────────────────────────┘
└───────────────────┘
```

---

## 四、目录结构与安装使用

### 一键克隆与安装
要求：Node.js 22.13+（推荐 Node.js 24+，内置 `node:sqlite` + FTS5，零第三方 npm 依赖）。

```bash
git clone https://github.com/zhjbddd/codex-1m-compact.git
cd codex-1m-compact
node install.mjs
```

安装器会将运行时文件部署至 `~/.gemini/config/plugins/codex-1m-compact/`，Antigravity 2.0 桌面端、Antigravity IDE 与 `agy` CLI 均会自动发现并默认启用。

### 使用方式
1. **自动 1M 护航**：正常长对话无需任何操作。若底层后端在 ~150K 提前截断，Hook 会自动触发 `🛡️ 1M Anti-Amnesia Shield` 保留核心意图并累计 1M 账本；当 1M 会话占用达到 `900K`（90%）时自动生成 Codex Checkpoint。
2. **手动精准压缩**：在对话中直接输入 `/codex-compact`（或 `/codex-compact 重点保留数据库 schema 和测试结果`），由当前模型生成高质量 4 段式 Codex 交接摘要并重置上下文。
3. **打开 Sidecar 仪表盘**：在右侧辅助栏（Aux Pane）打开 `1M Context`，可实时查看剩余上下文百分比、缓存命中率、1M FTS5 历史检索、调节 `200K`–`2M` 策略，或点击 **Compact & New Session** 一键开启干净的低 Token 续接会话。

---

## 五、运行自动化测试

```bash
node tests/verify.mjs
```

测试套件完整覆盖：增量日志解析与真实 API Token 核算、早期后端截断防失忆盾（160K → 35K）、900K 自动触发 Codex Checkpoint 压缩、FTS5 1M 历史全文召回、Stdio MCP Server 端到端 JSON-RPC 通信，以及对真实本地对话日志的只读冒烟测试。

---

## 六、v1.1.0 更新日志（Antigravity `2.35.0` 适配与双语面板）

- **Plan/Execute 内部标记过滤**：自动忽略 Antigravity `2.35.0` 注入的 `[plan review]`、`[plan review due]` 与 `<EPHEMERAL_MESSAGE>`，防止内部调度消息污染 `Preserved User Messages` 或挤占 20K 用户约束预算。
- **实时活跃模型追踪**：在账本与 Sidecar 顶部状态栏中解析并展示当前会话模型（支持 `Gemini 4 Neon`、`Orchestrator (Neon)`、`Claude Opus/Sonnet 5.5` 等 `2.35.0` 新模型及占位符）。
- **简体中文 / English 双语面板**：Sidecar 仪表盘默认跟随中文系统环境显示全中文界面，右上角提供 `EN / 中文` 一键切换按钮。
