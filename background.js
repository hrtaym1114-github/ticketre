// チケトレ — Service Worker (Background)
// タブ状態管理・タブ間通信・リトライ調整

const tabStates = new Map();
let battleMode = false;
let config = null;

// --- 初期化 ---
chrome.runtime.onInstalled.addListener(() => {
  console.log('[チケトレ] Extension installed');
});

// --- メッセージリスナー ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {

    case 'PAGE_STATUS':
      if (tabId) {
        tabStates.set(tabId, {
          show: message.show || 'unknown',
          status: message.status,
          priority: message.priority || 99,
          retryCount: message.retryCount || 0,
          updatedAt: Date.now(),
          url: sender.tab.url
        });
        broadcastState();
      }
      break;

    case 'PURCHASE_READY':
      if (tabId) {
        tabStates.set(tabId, {
          ...tabStates.get(tabId),
          status: 'purchase',
          updatedAt: Date.now()
        });
        // 該当タブにフォーカス
        chrome.tabs.update(tabId, { active: true });
        // 通知
        chrome.notifications.create('purchase-ready', {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'チケトレ — 購入画面到達！',
          message: `${message.show || '公演'} の購入画面に到達しました！`,
          priority: 2,
          requireInteraction: true
        });
        broadcastState();
      }
      break;

    case 'SOLD_OUT':
      if (tabId) {
        tabStates.set(tabId, {
          ...tabStates.get(tabId),
          status: 'sold-out',
          updatedAt: Date.now()
        });
        broadcastState();
        // sold-outなら次の公演に自動切替
        if (battleMode && tabId === currentBattleTabId) {
          switchToNextShow();
        }
      }
      break;

    case 'GET_STATE':
      sendResponse({
        tabStates: Object.fromEntries(tabStates),
        battleMode,
        config
      });
      return true;

    case 'START_BATTLE':
      battleMode = true;
      config = message.config;
      startBattle(message.config);
      sendResponse({ ok: true });
      return true;

    case 'STOP_BATTLE':
      battleMode = false;
      battleQueue = [];
      currentBattleTabId = null;
      tabStates.clear();
      broadcastState();
      sendResponse({ ok: true });
      return true;

    case 'SET_CONFIG':
      config = message.config;
      chrome.storage.local.set({ ticketreConfig: config });
      sendResponse({ ok: true });
      return true;

    case 'GET_CONFIG':
      chrome.storage.local.get('ticketreConfig', (result) => {
        sendResponse(result.ticketreConfig || null);
      });
      return true;

    case 'REGISTER_TAB':
      if (tabId) {
        tabStates.set(tabId, {
          show: message.show || 'unknown',
          status: 'loading',
          priority: message.priority || 99,
          retryCount: 0,
          updatedAt: Date.now(),
          url: sender.tab.url,
          originalUrl: message.originalUrl || sender.tab.url
        });
        broadcastState();
      }
      break;
  }
});

// タブ閉じ検知
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabStates.has(tabId)) {
    tabStates.delete(tabId);
    broadcastState();
  }
});

// --- バトル開始（1公演ずつ順次攻略・セッション競合回避） ---
// ぴあは1ユーザー1セッションのため、同時に複数タブを開くとリダイレクトされる
// → 優先度順に1公演ずつ攻め、sorry/sold-outなら次の公演に切り替え

let battleQueue = []; // 待機中の公演キュー
let currentBattleTabId = null;

async function startBattle(cfg) {
  if (!cfg || !cfg.shows || cfg.shows.length === 0) return;

  battleQueue = cfg.shows
    .filter(s => s.enabled && s.url)
    .sort((a, b) => a.priority - b.priority);

  console.log(`[チケトレ] バトル開始: ${battleQueue.length}公演を優先度順に攻略`);

  // 最優先の公演から開始
  openNextShow();
}

async function openNextShow() {
  if (!battleMode || battleQueue.length === 0) {
    console.log('[チケトレ] 全公演を試行済み or バトル停止');
    return;
  }

  const show = battleQueue[0]; // 先頭を取得（まだ削除しない）
  console.log(`[チケトレ] 攻略開始: ${show.name} (優先度${show.priority})`);

  try {
    const tab = await chrome.tabs.create({
      url: show.url,
      active: true
    });
    currentBattleTabId = tab.id;
    tabStates.set(tab.id, {
      show: show.name,
      status: 'loading',
      priority: show.priority,
      retryCount: 0,
      updatedAt: Date.now(),
      url: show.url,
      originalUrl: show.url
    });
    broadcastState();
  } catch (e) {
    console.error('[チケトレ] タブ作成失敗:', show.name, e);
    battleQueue.shift(); // 失敗した公演をスキップ
    openNextShow();
  }
}

// sold-out時に次の公演に切り替え
function switchToNextShow() {
  if (battleQueue.length > 0) {
    const skipped = battleQueue.shift();
    console.log(`[チケトレ] ${skipped.name} をスキップ → 次の公演へ`);
  }
  if (battleQueue.length > 0) {
    console.log(`[チケトレ] 3秒後に次の公演を開始: ${battleQueue[0].name}`);
    setTimeout(() => openNextShow(), 3000);
  } else {
    console.log('[チケトレ] 全公演を試行済み。');
  }
}

// --- 全タブ・サイドパネルに状態をブロードキャスト ---
function broadcastState() {
  const stateObj = Object.fromEntries(tabStates);
  // content scripts
  for (const [tabId] of tabStates) {
    chrome.tabs.sendMessage(tabId, {
      type: 'STATE_UPDATE',
      tabStates: stateObj,
      battleMode
    }).catch(() => {});
  }
  // side panel
  chrome.runtime.sendMessage({
    type: 'STATE_UPDATE',
    tabStates: stateObj,
    battleMode
  }).catch(() => {});
}
