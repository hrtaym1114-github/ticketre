// チケトレ — Sidepanel Script

let battleStartTime = null;

const statusLabels = {
  'lp-consent': { icon: '📋', text: 'LP同意画面 → 自動通過中' },
  'loading': { icon: '🔄', text: '読み込み中...' },
  'sorry': { icon: '❌', text: 'sorryページ → リトライ中' },
  'waiting': { icon: '⏳', text: '待機中（リロード禁止）' },
  'congested': { icon: '🚧', text: 'アクセス集中 → 開き直し待ち' },
  'blank': { icon: '⚪', text: '真っ白 → 30秒後リロード' },
  'purchase': { icon: '🎉', text: '購入画面到達！' },
  'not-yet': { icon: '⏰', text: '発売前 → 30秒後リトライ' },
  'sold-out': { icon: '🔴', text: '予定枚数終了' },
  'error': { icon: '⚠️', text: 'エラー → リトライ中' },
  'login': { icon: '🔐', text: 'ログイン画面' },
  'confirm': { icon: '📋', text: '確認画面' },
  'normal': { icon: '📄', text: 'ページ表示中' }
};

// --- タイマー ---
setInterval(() => {
  if (!battleStartTime) return;
  const elapsed = Date.now() - battleStartTime;
  const min = String(Math.floor(elapsed / 60000)).padStart(2, '0');
  const sec = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');
  document.getElementById('timer').textContent = `${min}:${sec} 経過`;
}, 1000);

// --- 状態更新 ---
function updateUI(tabStates, battleMode) {
  const container = document.getElementById('tabsContainer');

  if (!tabStates || Object.keys(tabStates).length === 0) {
    if (!battleMode) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">🎫</div>
          <p>ポップアップから「🚀 発射」を押すと<br>ここに各タブの状況がリアルタイム表示されます</p>
        </div>`;
    }
    return;
  }

  const entries = Object.entries(tabStates).sort((a, b) => a[1].priority - b[1].priority);
  let totalRetries = 0;

  container.innerHTML = '';
  entries.forEach(([tabId, state]) => {
    const info = statusLabels[state.status] || statusLabels['normal'];
    totalRetries += state.retryCount || 0;

    const priorityClass = state.priority <= 1 ? 'p1' : state.priority <= 2 ? 'p2' : state.priority <= 3 ? 'p3' : '';

    const card = document.createElement('div');
    card.className = `tab-card status-${state.status}`;

    const header = document.createElement('div');
    header.className = 'tab-header';
    header.innerHTML = `
      <span class="tab-show">${state.show || 'Tab ' + tabId}</span>
      <span class="tab-priority ${priorityClass}">優先度 ${state.priority}</span>
    `;
    card.appendChild(header);

    const statusDiv = document.createElement('div');
    statusDiv.className = 'tab-status';
    statusDiv.innerHTML = `
      <span class="tab-status-icon">${info.icon}</span>
      <span class="tab-status-text">${info.text}</span>
    `;
    card.appendChild(statusDiv);

    if (state.retryCount) {
      const retryDiv = document.createElement('div');
      retryDiv.className = 'tab-retry';
      retryDiv.textContent = `リトライ: ${state.retryCount}回`;
      card.appendChild(retryDiv);
    }

    if (state.status === 'purchase') {
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'tab-actions';
      const btn = document.createElement('button');
      btn.textContent = '▶▶▶ このタブに切り替え';
      btn.addEventListener('click', () => focusTab(tabId));
      actionsDiv.appendChild(btn);
      card.appendChild(actionsDiv);
    }

    // 全タブに「開き直す」ボタンを表示（purchase以外）
    if (state.status !== 'purchase') {
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'tab-actions';
      const reopenBtn = document.createElement('button');
      reopenBtn.className = 'reopen-btn';
      reopenBtn.textContent = '🔁 新しいタブで開き直す';
      reopenBtn.addEventListener('click', () => reopenInNewTab(tabId, state.originalUrl || state.url));
      actionsDiv.appendChild(reopenBtn);
      card.appendChild(actionsDiv);
    }

    container.appendChild(card);
  });

  document.getElementById('totalRetries').textContent = `リトライ: ${totalRetries}回`;
  document.getElementById('tabCount').textContent = `タブ: ${entries.length}`;
  document.getElementById('battleStatus').textContent = battleMode ? '⚔ バトル中' : '待機中';
  document.getElementById('battleStatus').style.color = battleMode ? '#e94560' : '#888';

  if (battleMode && !battleStartTime) {
    battleStartTime = Date.now();
  }
  if (!battleMode) {
    battleStartTime = null;
    document.getElementById('timer').textContent = '--:--';
  }
}

function focusTab(tabId) {
  chrome.tabs.update(+tabId, { active: true });
}

function reopenInNewTab(oldTabId, url) {
  chrome.runtime.sendMessage({
    type: 'REOPEN_TAB',
    oldTabId: +oldTabId,
    url: url
  });
}

// --- メッセージ受信 ---
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STATE_UPDATE') {
    updateUI(message.tabStates, message.battleMode);
  }
});

// --- 初期状態取得 ---
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
  if (chrome.runtime.lastError) return;
  if (response) {
    updateUI(response.tabStates, response.battleMode);
  }
});

// --- 定期ポーリング（フォールバック） ---
setInterval(() => {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response) {
      updateUI(response.tabStates, response.battleMode);
    }
  });
}, 2000);
