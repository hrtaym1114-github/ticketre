// チケトレ — Popup Script

// --- デフォルト公演データ ---
let shows = [];
let showIdCounter = 0;

// --- 公演の追加 ---
function addShow(data = {}) {
  showIdCounter++;
  const show = {
    id: showIdCounter,
    name: data.name || '',
    url: data.url || '',
    dates: data.dates || '',
    enabled: data.enabled !== undefined ? data.enabled : true,
    priority: data.priority || shows.length + 1
  };
  shows.push(show);
  renderShows();
}

function removeShow(id) {
  shows = shows.filter(s => s.id !== id);
  shows.forEach((s, i) => s.priority = i + 1);
  renderShows();
}

function renderShows() {
  const list = document.getElementById('showList');
  list.innerHTML = '';
  shows.forEach(show => {
    const div = document.createElement('div');
    div.className = 'show-item';
    div.innerHTML = `
      <input type="checkbox" ${show.enabled ? 'checked' : ''} data-id="${show.id}" class="show-check">
      <div style="flex:1">
        <input type="text" value="${show.name}" placeholder="会場名（例: 静岡エコパ）"
          data-id="${show.id}" class="show-name-input"
          style="width:100%;margin-bottom:4px;padding:4px 6px;font-size:11px;">
        <div class="url-input">
          <input type="text" value="${show.url}" placeholder="会場URL（ticketInformation.do?eventCd=...）"
            data-id="${show.id}" class="show-url-input">
          <span class="status">${show.url ? '✅' : '—'}</span>
        </div>
        <input type="text" value="${show.dates || ''}" placeholder="希望日時（例: 4/4 17:00, 4/5 12:00）"
          data-id="${show.id}" class="show-dates-input"
          style="width:100%;margin-top:4px;padding:4px 6px;font-size:11px;color:#ffaa44;">
      </div>
      <select data-id="${show.id}" class="show-priority">
        ${[1,2,3,4,5,6,7,8,9,10].map(n => `<option value="${n}" ${show.priority === n ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
      <button style="background:none;border:none;color:#888;cursor:pointer;font-size:16px;"
        data-id="${show.id}" class="show-remove">✕</button>
    `;
    list.appendChild(div);
  });

  // イベントリスナー
  list.querySelectorAll('.show-check').forEach(el => {
    el.addEventListener('change', (e) => {
      const s = shows.find(s => s.id === +e.target.dataset.id);
      if (s) s.enabled = e.target.checked;
    });
  });
  list.querySelectorAll('.show-name-input').forEach(el => {
    el.addEventListener('input', (e) => {
      const s = shows.find(s => s.id === +e.target.dataset.id);
      if (s) s.name = e.target.value;
    });
  });
  list.querySelectorAll('.show-url-input').forEach(el => {
    el.addEventListener('input', (e) => {
      const s = shows.find(s => s.id === +e.target.dataset.id);
      if (s) {
        s.url = e.target.value;
        e.target.nextElementSibling.textContent = s.url ? '✅' : '—';
      }
    });
  });
  list.querySelectorAll('.show-dates-input').forEach(el => {
    el.addEventListener('input', (e) => {
      const s = shows.find(s => s.id === +e.target.dataset.id);
      if (s) s.dates = e.target.value;
    });
  });
  list.querySelectorAll('.show-priority').forEach(el => {
    el.addEventListener('change', (e) => {
      const s = shows.find(s => s.id === +e.target.dataset.id);
      if (s) s.priority = +e.target.value;
    });
  });
  list.querySelectorAll('.show-remove').forEach(el => {
    el.addEventListener('click', (e) => {
      removeShow(+e.target.dataset.id);
    });
  });
}

document.getElementById('addShowBtn').addEventListener('click', () => addShow());

// --- sendMessage with timeout ---
function sendMsg(msg, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          console.warn('[チケトレ]', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(response);
        }
      });
    } catch (e) {
      clearTimeout(timer);
      console.warn('[チケトレ] sendMessage error:', e);
      resolve(null);
    }
  });
}

function gatherConfig() {
  return {
    paymentMethod: document.getElementById('paymentMethod').value,
    ticketCount: +document.getElementById('ticketCount').value,
    retryEnabled: document.getElementById('retryEnabled').checked,
    retryIntervalBase: (+document.getElementById('retryInterval').value) * 1000,
    retryJitter: 2000,
    maxRetries: +document.getElementById('maxRetries').value,
    soundEnabled: document.getElementById('soundEnabled').checked,
    autoFillEnabled: document.getElementById('autoFillEnabled').checked,
    shows: shows.map(s => ({
      name: s.name,
      url: s.url,
      dates: s.dates || '',
      enabled: s.enabled,
      priority: s.priority
    }))
  };
}

// --- 設定の保存 ---
document.getElementById('saveBtn').addEventListener('click', async () => {
  const config = gatherConfig();

  await chrome.storage.local.set({
    ticketreCredentials: {
      userId: document.getElementById('userId').value,
      password: document.getElementById('password').value
    }
  });

  await chrome.storage.local.set({ ticketreConfig: config });
  sendMsg({ type: 'SET_CONFIG', config });

  const btn = document.getElementById('saveBtn');
  btn.textContent = '✅ 保存完了';
  setTimeout(() => { btn.textContent = '💾 保存'; }, 1500);
});

// --- 発射 ---
document.getElementById('launchBtn').addEventListener('click', async () => {
  const config = gatherConfig();
  const targets = config.shows.filter(s => s.enabled && s.url);

  if (targets.length === 0) {
    document.getElementById('launchBtn').textContent = '⚠ 公演URLを設定してください';
    setTimeout(() => { document.getElementById('launchBtn').textContent = '🚀 発射'; }, 2000);
    return;
  }

  // 保存してからバトル開始
  await chrome.storage.local.set({
    ticketreCredentials: {
      userId: document.getElementById('userId').value,
      password: document.getElementById('password').value
    }
  });
  await chrome.storage.local.set({ ticketreConfig: config });

  const response = await sendMsg({ type: 'START_BATTLE', config });
  if (response?.ok) {
    document.getElementById('launchBtn').style.display = 'none';
    document.getElementById('stopBtn').style.display = 'block';
  }
});

// --- 停止 ---
document.getElementById('stopBtn').addEventListener('click', async () => {
  await sendMsg({ type: 'STOP_BATTLE' });
  document.getElementById('launchBtn').style.display = 'block';
  document.getElementById('stopBtn').style.display = 'none';
});

// --- サイドパネル ---
document.getElementById('sidepanelBtn').addEventListener('click', () => {
  try {
    chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  } catch (e) {
    console.warn('[チケトレ] サイドパネルを開けません:', e);
  }
});

// --- 初期化: 保存済み設定の復元 ---
async function loadSaved() {
  try {
    const cred = await chrome.storage.local.get('ticketreCredentials');
    if (cred?.ticketreCredentials) {
      document.getElementById('userId').value = cred.ticketreCredentials.userId || '';
      document.getElementById('password').value = cred.ticketreCredentials.password || '';
    }

    const saved = await chrome.storage.local.get('ticketreConfig');
    const result = saved?.ticketreConfig || null;

    if (result) {
      document.getElementById('paymentMethod').value = result.paymentMethod || 'credit';
      document.getElementById('ticketCount').value = result.ticketCount || 2;
      document.getElementById('retryEnabled').checked = result.retryEnabled !== false;
      document.getElementById('retryInterval').value = (result.retryIntervalBase || 5000) / 1000;
      document.getElementById('maxRetries').value = result.maxRetries || 30;
      document.getElementById('soundEnabled').checked = result.soundEnabled !== false;
      document.getElementById('autoFillEnabled').checked = result.autoFillEnabled !== false;

      if (result.shows && result.shows.length > 0) {
        result.shows.forEach(s => addShow(s));
      }
    }
  } catch (e) {
    console.warn('[チケトレ] loadSaved error:', e);
  }

  if (shows.length === 0) {
    addShow({ name: '新潟 朱鷺メッセ', url: 'https://ticket.pia.jp/sp/ticketInformation.do?eventCd=2606386&rlsCd=001', dates: '5/2-3', priority: 1 });
    addShow({ name: '沖縄 サントリーアリーナ', url: 'https://ticket.pia.jp/sp/ticketInformation.do?eventCd=2606425&rlsCd=001', dates: '6/13-14', priority: 2 });
  }

  try {
    const state = await sendMsg({ type: 'GET_STATE' });
    if (state?.battleMode) {
      document.getElementById('launchBtn').style.display = 'none';
      document.getElementById('stopBtn').style.display = 'block';
    }
  } catch (e) {
    // ignore
  }
}

loadSaved();
