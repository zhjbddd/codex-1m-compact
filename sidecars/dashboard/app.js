const RING_CIRCUMFERENCE = 2 * Math.PI * 50;

const I18N = {
  zh: {
    loading: '正在加载会话…',
    refreshTitle: '刷新状态',
    langSwitch: 'EN',
    langTitle: 'Switch to English',
    thresholdTitle: '自动压缩阈值',
    pctCaption: '剩余上下文',
    session1mLabel: '1M 会话占用',
    activeApiLabel: '当前活跃窗口',
    focusLabelHtml: '压缩聚焦重点（可选，类似 <code>/compact &lt;focus&gt;</code>）',
    focusPlaceholder: '例如：保留鉴权结构约束与待修测试',
    btnCompactInPlace: '就地压缩',
    btnCompactHandoff: '压缩并新建会话',
    tabOverview: '概览',
    tabSearch: '1M 检索',
    tabPolicy: '策略',
    breakdownTitle: 'Token 构成（当前分段）',
    catUser: '用户提问',
    catModel: '模型输出',
    catTools: '工具与文件',
    catHandoff: '交接锚点',
    vaultTotal: '1M 历史总库',
    bridgedTotal: '已桥接截断',
    checkpointsTitle: 'Codex 检查点',
    noCheckpoints: '暂无检查点。达到阈值时将自动压缩，也可点击上方手动压缩。',
    recallTitle: '全文 1M 历史检索（FTS5）',
    searchPlaceholder: '搜索未截断的提问、文件路径或报错…',
    btnSearch: '搜索',
    searchHint: '输入关键词以检索所有已索引的历史步骤。',
    policyTitle: '1M 窗口与 Codex 策略',
    windowPreset: '窗口预设',
    thresholdPrefix: '自动压缩阈值：',
    userBudgetLabel: '保留用户消息预算（Codex 默认 20K）',
    hudModeLabel: '对话内联 HUD 模式',
    hudMilestones: '里程碑（每 10% 与压缩时）',
    hudAlways: '始终显示（每轮对话）',
    hudWarnings: '仅预警（剩余 ≤20% 与压缩时）',
    hudOff: '关闭（仅侧边栏）',
    toggleAutoCompact: '达到阈值时自动压缩',
    toggleAntiAmnesia: '1M 防失忆护盾（桥接后端提前截断）',
    btnSavePolicy: '保存策略',
    subtitle: (id, win, model) => `会话 ${id} · 窗口 ${win}${model ? ` · ${model}` : ''}`,
    cachedSuffix: (pct) => `(缓存 ${pct}%)`,
    cachePill: (pct) => `缓存 ${pct}%`,
    shieldPill: (n) => `防失忆 ${n} 次`,
    cpPill: (n) => `检查点 ${n}`,
    stepsSuffix: (n) => `${n} 步`,
    checkpointHead: (gen, trigger) => `检查点 #${gen} (${trigger})`,
    compactedMsg: (before, after, left) => `已压缩 ${before} → ${after}（剩余 ${left}%）。`,
    createdSessionMsg: (id) => ` 已创建新会话 <code>${id}</code>。`,
    newSessionFailed: (err) => `（新建会话失败：${err}）`,
    anchorQueued: ' 交接锚点已排队，将在下轮生效。',
    searching: '正在检索 1M 历史台账…',
    noSearchResults: '未找到匹配的历史步骤。',
    searchStepHead: (idx, type) => `步骤 ${idx} · ${type}`,
    searchFailed: (err) => `检索失败：${err}`,
    savedPolicy: (win, limit) => `已保存：窗口 ${win} · 自动压缩阈值 ${limit}。`,
  },
  en: {
    loading: 'Loading conversation…',
    refreshTitle: 'Refresh status',
    langSwitch: '中文',
    langTitle: '切换为中文',
    thresholdTitle: 'Auto-compact threshold',
    pctCaption: 'context left',
    session1mLabel: '1M Session',
    activeApiLabel: 'Active API Window',
    focusLabelHtml: 'Compaction Focus (optional, like <code>/compact &lt;focus&gt;</code>)',
    focusPlaceholder: 'e.g. Preserve auth schema constraints & pending tests',
    btnCompactInPlace: 'Compact In-Place',
    btnCompactHandoff: 'Compact & New Session',
    tabOverview: 'Overview',
    tabSearch: '1M Recall',
    tabPolicy: 'Policy',
    breakdownTitle: 'Token Breakdown (Active Segment)',
    catUser: 'User Prompts',
    catModel: 'Model Output',
    catTools: 'Tools & Files',
    catHandoff: 'Handoff Anchor',
    vaultTotal: 'Total 1M Vault',
    bridgedTotal: 'Bridged Drops',
    checkpointsTitle: 'Codex Checkpoints',
    noCheckpoints: 'No checkpoints yet. Auto-compacts at threshold or click Compact above.',
    recallTitle: 'Full-Text 1M Ledger Recall (FTS5)',
    searchPlaceholder: 'Search untruncated prompts, file paths, errors…',
    btnSearch: 'Search',
    searchHint: 'Enter keywords to search across all indexed turns.',
    policyTitle: '1M Window & Codex Policy',
    windowPreset: 'Window Preset',
    thresholdPrefix: 'Auto-Compact Threshold: ',
    userBudgetLabel: 'Preserved User Messages Budget (Codex default 20K)',
    hudModeLabel: 'Inline Chat HUD Mode',
    hudMilestones: 'Milestones (every 10% + compactions)',
    hudAlways: 'Always (every turn)',
    hudWarnings: 'Warnings Only (≤20% left + compactions)',
    hudOff: 'Off (Sidecar only)',
    toggleAutoCompact: 'Auto-compact when hitting threshold',
    toggleAntiAmnesia: '1M Anti-Amnesia Shield (bridge early backend truncation)',
    btnSavePolicy: 'Save Policy',
    subtitle: (id, win, model) => `Session ${id} · Window ${win}${model ? ` · ${model}` : ''}`,
    cachedSuffix: (pct) => `(${pct}% cached)`,
    cachePill: (pct) => `Cache ${pct}%`,
    shieldPill: (n) => `Shield ${n} drops`,
    cpPill: (n) => `Checkpoints ${n}`,
    stepsSuffix: (n) => `${n} steps`,
    checkpointHead: (gen, trigger) => `Checkpoint #${gen} (${trigger})`,
    compactedMsg: (before, after, left) => `Compacted ${before} → ${after} (${left}% left).`,
    createdSessionMsg: (id) => ` Created clean session <code>${id}</code>.`,
    newSessionFailed: (err) => ` (New session failed: ${err})`,
    anchorQueued: ' Handoff anchor queued for next prompt.',
    searching: 'Searching 1M ledger…',
    noSearchResults: 'No matching steps found.',
    searchStepHead: (idx, type) => `Step ${idx} · ${type}`,
    searchFailed: (err) => `Search failed: ${err}`,
    savedPolicy: (win, limit) => `Saved: ${win} window · compact at ${limit}.`,
  },
};

function detectInitialLang() {
  try {
    const saved = localStorage.getItem('codex1m_lang');
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {}
  return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
}

let currentLang = detectInitialLang();
let currentState = null;
let selectedWindow = 1000000;
let policyDirty = false;

function t() {
  return I18N[currentLang] || I18N.zh;
}

function applyStaticI18n() {
  const dict = t();
  document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (dict[key] !== undefined) el.textContent = dict[key];
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const key = el.dataset.i18nHtml;
    const htmlKey = `${key}Html`;
    if (dict[htmlKey] !== undefined) el.innerHTML = dict[htmlKey];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.dataset.i18nPlaceholder;
    if (dict[key] !== undefined) el.placeholder = dict[key];
  });
  const langBtn = document.getElementById('lang-btn');
  if (langBtn) {
    langBtn.textContent = dict.langSwitch;
    langBtn.title = dict.langTitle;
  }
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) refreshBtn.title = dict.refreshTitle;
  const threshMarker = document.getElementById('threshold-marker');
  if (threshMarker) threshMarker.title = dict.thresholdTitle;
  if (!currentState) {
    document.getElementById('conv-label').textContent = dict.loading;
  }
}

function fmtTokens(n) {
  const num = Math.max(0, Number(n) || 0);
  if (num >= 1000000) return `${(num / 1000000).toFixed(2).replace(/\.00$/, '.0')}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(num));
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getActiveConvId() {
  return window.sidecar?.conversationId || '';
}

async function apiFetch(url, options = {}) {
  const fetcher = window.sidecar?.fetch || fetch;
  const res = await fetcher(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function renderStatus(payload) {
  currentState = payload;
  const dict = t();
  const { status, config, checkpoints, conversationId } = payload;

  const modelLabel = status.activeModel || '';
  document.getElementById('conv-label').textContent = dict.subtitle(
    conversationId.slice(0, 8),
    fmtTokens(config.modelContextWindow),
    modelLabel,
  );

  const pctUsed = Math.min(100, Math.max(0, status.percentUsed || 0));
  const pctLeft = Math.max(0, 100 - pctUsed);
  document.getElementById('pct-left').textContent = `${pctLeft.toFixed(1)}%`;

  const ringFill = document.getElementById('ring-fill');
  ringFill.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;
  ringFill.style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - pctUsed / 100)}`;

  const dot = document.getElementById('health-dot');
  dot.className = 'dot';
  if (pctLeft <= 10) {
    ringFill.style.stroke = 'var(--danger)';
    dot.classList.add('danger');
  } else if (pctLeft <= 25) {
    ringFill.style.stroke = 'var(--warn)';
    dot.classList.add('warn');
  } else {
    ringFill.style.stroke = 'var(--accent)';
  }

  document.getElementById('session-tokens').textContent = `${fmtTokens(status.session1mTokens)} / ${fmtTokens(config.modelContextWindow)}`;
  document.getElementById('session-bar').style.width = `${pctUsed.toFixed(2)}%`;

  const threshPct = Math.min(100, Math.round((config.autoCompactTokenLimit / config.modelContextWindow) * 100));
  document.getElementById('threshold-marker').style.left = `${threshPct}%`;

  const ringThreshold = document.getElementById('ring-threshold');
  ringThreshold.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;
  ringThreshold.style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - threshPct / 100)}`;

  const cachePct = (status.cacheHitRate * 100).toFixed(0);
  const apiPct = Math.min(100, (status.activeApiTokens / config.modelContextWindow) * 100);
  document.getElementById('active-tokens').textContent = `${fmtTokens(status.activeApiTokens)} ${dict.cachedSuffix(cachePct)}`;
  document.getElementById('api-bar').style.width = `${apiPct.toFixed(2)}%`;

  document.getElementById('cache-pill').textContent = dict.cachePill(cachePct);
  document.getElementById('shield-pill').textContent = dict.shieldPill(status.backendDropCount);
  document.getElementById('cp-pill').textContent = dict.cpPill(status.checkpointCount);

  document.getElementById('cat-user').textContent = fmtTokens(status.categories?.userTokens || 0);
  document.getElementById('cat-model').textContent = fmtTokens(status.categories?.modelTokens || 0);
  document.getElementById('cat-tools').textContent = fmtTokens(status.categories?.toolTokens || 0);
  document.getElementById('cat-handoff').textContent = fmtTokens(status.categories?.handoffTokens || 0);
  document.getElementById('vault-total').textContent = `${fmtTokens(status.totalAllTimeEstimatedTokens)} (${dict.stepsSuffix(status.totalSteps)})`;
  document.getElementById('bridged-total').textContent = fmtTokens(status.cumulativeBackendDroppedTokens);

  const cpContainer = document.getElementById('checkpoints-list');
  if (!checkpoints || checkpoints.length === 0) {
    cpContainer.className = 'list-empty';
    cpContainer.textContent = dict.noCheckpoints;
  } else {
    cpContainer.className = '';
    cpContainer.innerHTML = checkpoints
      .map(
        (cp) => `
      <div class="cp-item">
        <div class="cp-head">
          <span>${escapeHtml(dict.checkpointHead(cp.generation, cp.trigger_type))}</span>
          <span>${fmtTokens(cp.before_1m_tokens)} → ${fmtTokens(cp.after_1m_tokens)}</span>
        </div>
        <div class="cp-body">${escapeHtml(cp.summary_markdown)}</div>
      </div>`,
      )
      .join('');
  }

  if (!policyDirty) {
    syncPolicyForm(config);
  }
}

function syncPolicyForm(config) {
  selectedWindow = config.modelContextWindow;
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.window) === selectedWindow);
  });
  const pct = Math.max(50, Math.min(95, Math.round((config.autoCompactTokenLimit / config.modelContextWindow) * 100)));
  document.getElementById('cfg-threshold-pct').value = pct;
  document.getElementById('cfg-threshold-label').textContent = `${pct}% (${fmtTokens((selectedWindow * pct) / 100)})`;
  document.getElementById('cfg-user-budget').value = config.userMessageMaxTokens;
  document.getElementById('cfg-hud-mode').value = config.inlineHudMode;
  document.getElementById('cfg-auto-compact').checked = Boolean(config.autoCompactEnabled);
  document.getElementById('cfg-anti-amnesia').checked = Boolean(config.antiAmnesiaShield);
}

async function refreshStatus() {
  try {
    const convId = encodeURIComponent(getActiveConvId());
    const data = await apiFetch(`/api/status?conversationId=${convId}`);
    renderStatus(data);
  } catch (err) {
    console.error('Status refresh failed:', err);
  }
}

function showFeedback(elId, html, isError = false) {
  const el = document.getElementById(elId);
  el.className = isError ? 'feedback error' : 'feedback';
  el.innerHTML = html;
}

async function runCompact(mode) {
  const dict = t();
  const btnInPlace = document.getElementById('btn-compact-inplace');
  const btnHandoff = document.getElementById('btn-compact-handoff');
  btnInPlace.disabled = true;
  btnHandoff.disabled = true;

  try {
    const focusInstructions = document.getElementById('focus-input').value.trim();
    const res = await apiFetch('/api/compact', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: getActiveConvId(),
        mode,
        focusInstructions,
      }),
    });

    renderStatus({
      conversationId: res.compacted.conversationId,
      status: res.status,
      config: res.config,
      checkpoints: res.checkpoints,
    });

    let msg = dict.compactedMsg(
      fmtTokens(res.compacted.beforeTokens),
      fmtTokens(res.compacted.afterTokens),
      res.compacted.afterPercentLeft.toFixed(1),
    );
    if (mode === 'handoff_session' && res.newConversationId) {
      msg += dict.createdSessionMsg(escapeHtml(res.newConversationId.slice(0, 8)));
      if (window.sidecar?.ui?.toggleConversation) {
        window.sidecar.ui.toggleConversation(res.newConversationId);
      }
    } else if (res.handoffError) {
      msg += dict.newSessionFailed(escapeHtml(res.handoffError));
    } else {
      msg += dict.anchorQueued;
    }
    showFeedback('action-feedback', msg);
  } catch (err) {
    showFeedback('action-feedback', escapeHtml(err.message), true);
  } finally {
    btnInPlace.disabled = false;
    btnHandoff.disabled = false;
  }
}

async function runSearch() {
  const dict = t();
  const q = document.getElementById('search-input').value.trim();
  const box = document.getElementById('search-results');
  box.textContent = dict.searching;
  try {
    const convId = encodeURIComponent(getActiveConvId());
    const data = await apiFetch(`/api/search?conversationId=${convId}&q=${encodeURIComponent(q)}`);
    if (!data.results || data.results.length === 0) {
      box.textContent = dict.noSearchResults;
      return;
    }
    box.innerHTML = data.results
      .map(
        (r) => `
      <div class="search-item">
        <div class="search-head">
          <span>${escapeHtml(dict.searchStepHead(r.step_index, r.type))}</span>
          <span>~${fmtTokens(r.estimated_tokens)} tok</span>
        </div>
        <div class="search-body">${escapeHtml(r.content || r.snippet)}</div>
      </div>`,
      )
      .join('');
  } catch (err) {
    box.textContent = dict.searchFailed(err.message);
  }
}

async function savePolicy() {
  const dict = t();
  try {
    const pct = Number(document.getElementById('cfg-threshold-pct').value);
    const payload = {
      modelContextWindow: selectedWindow,
      autoCompactTokenLimit: Math.round((selectedWindow * pct) / 100),
      userMessageMaxTokens: Number(document.getElementById('cfg-user-budget').value),
      inlineHudMode: document.getElementById('cfg-hud-mode').value,
      autoCompactEnabled: document.getElementById('cfg-auto-compact').checked,
      antiAmnesiaShield: document.getElementById('cfg-anti-amnesia').checked,
    };
    const res = await apiFetch('/api/config', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    policyDirty = false;
    syncPolicyForm(res.config);
    showFeedback(
      'cfg-feedback',
      dict.savedPolicy(fmtTokens(res.config.modelContextWindow), fmtTokens(res.config.autoCompactTokenLimit)),
    );
    await refreshStatus();
  } catch (err) {
    showFeedback('cfg-feedback', escapeHtml(err.message), true);
  }
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${target}`));
  });
});

document.querySelectorAll('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    policyDirty = true;
    selectedWindow = Number(btn.dataset.window);
    document.querySelectorAll('.preset-btn').forEach((b) => b.classList.toggle('active', b === btn));
    const pct = Number(document.getElementById('cfg-threshold-pct').value);
    document.getElementById('cfg-threshold-label').textContent = `${pct}% (${fmtTokens((selectedWindow * pct) / 100)})`;
  });
});

document.getElementById('cfg-threshold-pct').addEventListener('input', (e) => {
  policyDirty = true;
  const pct = Number(e.target.value);
  document.getElementById('cfg-threshold-label').textContent = `${pct}% (${fmtTokens((selectedWindow * pct) / 100)})`;
});

['cfg-user-budget', 'cfg-hud-mode', 'cfg-auto-compact', 'cfg-anti-amnesia'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => {
    policyDirty = true;
  });
});

document.getElementById('lang-btn').addEventListener('click', () => {
  currentLang = currentLang === 'zh' ? 'en' : 'zh';
  try {
    localStorage.setItem('codex1m_lang', currentLang);
  } catch {}
  applyStaticI18n();
  if (currentState) {
    renderStatus(currentState);
  }
});

document.getElementById('refresh-btn').addEventListener('click', refreshStatus);
document.getElementById('btn-compact-inplace').addEventListener('click', () => runCompact('in_place'));
document.getElementById('btn-compact-handoff').addEventListener('click', () => runCompact('handoff_session'));
document.getElementById('search-btn').addEventListener('click', runSearch);
document.getElementById('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch();
});
document.getElementById('cfg-save').addEventListener('click', savePolicy);

applyStaticI18n();
refreshStatus();
setInterval(refreshStatus, 3500);