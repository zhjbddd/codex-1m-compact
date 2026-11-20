const RING_CIRCUMFERENCE = 2 * Math.PI * 50;

let currentState = null;
let selectedWindow = 1000000;
let policyDirty = false;

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
  const { status, config, checkpoints, conversationId } = payload;

  document.getElementById('conv-label').textContent = `Session ${conversationId.slice(0, 8)} · Window ${fmtTokens(config.modelContextWindow)}`;

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

  const apiPct = Math.min(100, (status.activeApiTokens / config.modelContextWindow) * 100);
  document.getElementById('active-tokens').textContent = `${fmtTokens(status.activeApiTokens)} (${(status.cacheHitRate * 100).toFixed(0)}% cached)`;
  document.getElementById('api-bar').style.width = `${apiPct.toFixed(2)}%`;

  document.getElementById('cache-pill').textContent = `Cache ${(status.cacheHitRate * 100).toFixed(0)}%`;
  document.getElementById('shield-pill').textContent = `Shield ${status.backendDropCount} drops`;
  document.getElementById('cp-pill').textContent = `Checkpoints ${status.checkpointCount}`;

  document.getElementById('cat-user').textContent = fmtTokens(status.categories?.userTokens || 0);
  document.getElementById('cat-model').textContent = fmtTokens(status.categories?.modelTokens || 0);
  document.getElementById('cat-tools').textContent = fmtTokens(status.categories?.toolTokens || 0);
  document.getElementById('cat-handoff').textContent = fmtTokens(status.categories?.handoffTokens || 0);
  document.getElementById('vault-total').textContent = `${fmtTokens(status.totalAllTimeEstimatedTokens)} (${status.totalSteps} steps)`;
  document.getElementById('bridged-total').textContent = fmtTokens(status.cumulativeBackendDroppedTokens);

  const cpContainer = document.getElementById('checkpoints-list');
  if (!checkpoints || checkpoints.length === 0) {
    cpContainer.className = 'list-empty';
    cpContainer.textContent = 'No checkpoints yet. Auto-compacts at threshold or click Compact above.';
  } else {
    cpContainer.className = '';
    cpContainer.innerHTML = checkpoints
      .map(
        (cp) => `
      <div class="cp-item">
        <div class="cp-head">
          <span>Checkpoint #${cp.generation} (${escapeHtml(cp.trigger_type)})</span>
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

    let msg = `Compacted ${fmtTokens(res.compacted.beforeTokens)} → ${fmtTokens(res.compacted.afterTokens)} (${res.compacted.afterPercentLeft.toFixed(1)}% left).`;
    if (mode === 'handoff_session' && res.newConversationId) {
      msg += ` Created clean session <code>${escapeHtml(res.newConversationId.slice(0, 8))}</code>.`;
      if (window.sidecar?.ui?.toggleConversation) {
        window.sidecar.ui.toggleConversation(res.newConversationId);
      }
    } else if (res.handoffError) {
      msg += ` (New session failed: ${escapeHtml(res.handoffError)})`;
    } else {
      msg += ' Handoff anchor queued for next prompt.';
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
  const q = document.getElementById('search-input').value.trim();
  const box = document.getElementById('search-results');
  box.textContent = 'Searching 1M ledger…';
  try {
    const convId = encodeURIComponent(getActiveConvId());
    const data = await apiFetch(`/api/search?conversationId=${convId}&q=${encodeURIComponent(q)}`);
    if (!data.results || data.results.length === 0) {
      box.textContent = 'No matching steps found.';
      return;
    }
    box.innerHTML = data.results
      .map(
        (r) => `
      <div class="search-item">
        <div class="search-head">
          <span>Step ${r.step_index} · ${escapeHtml(r.type)}</span>
          <span>~${fmtTokens(r.estimated_tokens)} tok</span>
        </div>
        <div class="search-body">${escapeHtml(r.content || r.snippet)}</div>
      </div>`,
      )
      .join('');
  } catch (err) {
    box.textContent = `Search failed: ${err.message}`;
  }
}

async function savePolicy() {
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
    showFeedback('cfg-feedback', `Saved: ${fmtTokens(res.config.modelContextWindow)} window · compact at ${fmtTokens(res.config.autoCompactTokenLimit)}.`);
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

document.getElementById('refresh-btn').addEventListener('click', refreshStatus);
document.getElementById('btn-compact-inplace').addEventListener('click', () => runCompact('in_place'));
document.getElementById('btn-compact-handoff').addEventListener('click', () => runCompact('handoff_session'));
document.getElementById('search-btn').addEventListener('click', runSearch);
document.getElementById('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch();
});
document.getElementById('cfg-save').addEventListener('click', savePolicy);

refreshStatus();
setInterval(refreshStatus, 3500);
