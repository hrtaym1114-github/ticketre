// チケトレ — Content Script
// ページ状態検知・自動リトライ・購入フロー補助

(function () {
  'use strict';

  // 多重起動防止
  if (window.__ticketre_loaded) return;
  window.__ticketre_loaded = true;

  // --- 設定 ---
  let retryCount = 0;
  let originalUrl = location.href;
  let config = null;
  let retryTimer = null;
  let blankTimer = null;
  let monitorInterval = null;

  // --- 初期化 ---
  init();

  async function init() {
    // 設定読み込み
    try {
      config = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, resolve);
      });
    } catch (e) {
      config = null;
    }

    if (!config) {
      config = {
        retryEnabled: true,
        retryIntervalBase: 5000,
        retryJitter: 2000,
        maxRetries: 30,
        autoFillEnabled: true,
        soundEnabled: true
      };
    }

    // ストレージから元URL取得（リトライ時用）
    const stored = await chrome.storage.local.get('ticketre_originalUrl_' + getTabKey());
    if (stored['ticketre_originalUrl_' + getTabKey()]) {
      originalUrl = stored['ticketre_originalUrl_' + getTabKey()];
    } else {
      // sorryページでなければ元URLとして記録
      if (!isSorryUrl(location.href)) {
        originalUrl = location.href;
        chrome.storage.local.set({ ['ticketre_originalUrl_' + getTabKey()]: originalUrl });
      }
    }

    // リトライカウント復元
    const rc = await chrome.storage.local.get('ticketre_retryCount_' + getTabKey());
    if (rc['ticketre_retryCount_' + getTabKey()]) {
      retryCount = rc['ticketre_retryCount_' + getTabKey()];
    }

    // ページ状態を検知して処理
    const status = detectPageStatus();
    reportStatus(status);
    handlePageStatus(status);

    // 待機画面の自動遷移を監視
    if (status.type === 'waiting') {
      startTransitionMonitor();
    }

    // 購入画面のヘルパー
    if (status.type === 'purchase') {
      activatePurchaseHelpers();
    }
  }

  // --- タブキー（session storage用） ---
  function getTabKey() {
    return location.host + location.pathname;
  }

  // --- ページ状態検知 ---
  function isLPPage(url) {
    return url.includes('/lp/event.do') || url.includes('lpPath=');
  }

  function detectPageStatus() {
    const url = location.href;
    const bodyText = document.body?.innerText || '';
    const bodyHTML = document.body?.innerHTML || '';

    // 0. LPページは専用タイプ（同意自動通過 + 誤検知防止）
    if (isLPPage(url)) {
      return { type: 'lp-consent', url };
    }

    // 1a. アクセス集中ページ判定（再読み込み禁止の案内）
    if (bodyText.includes('アクセスが集中') && bodyText.includes('再読み込みは行わず')) {
      return { type: 'congested', url };
    }

    // 1b. sorryページ判定
    if (isSorryUrl(url) ||
        (bodyText.includes('アクセスが集中') && !bodyText.includes('お待ちください'))) {
      return { type: 'sorry', url };
    }

    // 2. 待機画面判定
    if (bodyText.includes('お待ちください') ||
        bodyText.includes('しばらくお待ち') ||
        bodyText.includes('順番にご案内')) {
      return { type: 'waiting', url };
    }

    // 2.5 同意・注意事項画面判定（LP以外のURLでも同意画面が出る場合）
    if ((bodyText.includes('申し込みへ進む') || bodyText.includes('お申し込み画面へ')) &&
        (bodyText.includes('必ずご確認ください') || bodyText.includes('注意事項') || bodyText.includes('同意'))) {
      return { type: 'lp-consent', url };
    }

    // 3. 発売前 / 公演なし判定（完売より先にチェック）
    if (bodyText.includes('公演回はありません') ||
        bodyText.includes('公演はありません') ||
        bodyText.includes('この発売で扱っている公演')) {
      return { type: 'not-yet', url };
    }

    // 4. 完売判定（「予定枚数終了次第」等の説明文は除外）
    if ((bodyText.includes('予定枚数終了') && !bodyText.includes('予定枚数終了次第')) ||
        bodyText.includes('完売')) {
      return { type: 'sold-out', url };
    }

    // 5. 受付終了判定（「受付終了となります」等の説明文は除外）
    if ((bodyText.includes('受付終了') && !bodyText.includes('受付終了となります')) ||
        (bodyText.includes('受付は終了') && !bodyText.includes('受付は終了となります'))) {
      return { type: 'sold-out', url };
    }

    // 4. 真っ白画面判定
    if (bodyHTML.trim().length < 100) {
      return { type: 'blank', url };
    }

    // 5. 購入画面判定（フォーム要素がある）
    if (document.querySelector('select, input[type="radio"], .seat-status') ||
        bodyText.includes('席種を選択') ||
        bodyText.includes('枚数') ||
        bodyText.includes('購入に進む')) {
      return { type: 'purchase', url };
    }

    // 6. ログイン画面
    if (document.querySelector('input[type="password"]') &&
        (bodyText.includes('ログイン') || bodyText.includes('PIA会員'))) {
      return { type: 'login', url };
    }

    // 7. 確認画面
    if (bodyText.includes('購入内容の確認') || bodyText.includes('注文内容')) {
      return { type: 'confirm', url };
    }

    // 8. エラー判定
    if (bodyText.includes('エラーが発生') || bodyText.includes('システムエラー')) {
      return { type: 'error', url };
    }

    return { type: 'normal', url };
  }

  function isSorryUrl(url) {
    return url.includes('sorry') || url.includes('maintenance');
  }

  // --- 状態をService Workerに報告 ---
  function reportStatus(status) {
    chrome.runtime.sendMessage({
      type: 'PAGE_STATUS',
      status: status.type,
      retryCount,
      show: config?.currentShow || 'unknown',
      priority: config?.currentPriority || 99
    }).catch(() => {});
  }

  // --- 状態別アクション ---
  function handlePageStatus(status) {
    switch (status.type) {

      case 'lp-consent':
        // LP同意画面 → 自動で同意して通過
        autoPassConsent();
        break;

      case 'congested':
        showOverlay('🚧 アクセス集中', `アクセスが集中しています。新しいタブで自動リトライします... (${retryCount}回目)`);
        if (config?.retryEnabled && retryCount < (config.maxRetries || 30)) {
          const interval = getRetryInterval();
          retryTimer = setTimeout(() => {
            retryCount++;
            chrome.storage.local.set({ ['ticketre_retryCount_' + getTabKey()]: retryCount });
            // リロードではなく新しいタブで開き直す
            chrome.runtime.sendMessage({
              type: 'REOPEN_TAB_SELF',
              url: originalUrl
            });
          }, interval);
          updateOverlayTimer(interval);
        }
        break;

      case 'sorry':
        showOverlay('❌ sorry', `sorryページを検知しました。自動リトライ中... (${retryCount}回目)`);
        if (config?.retryEnabled && retryCount < (config.maxRetries || 30)) {
          const interval = getRetryInterval();
          retryTimer = setTimeout(() => {
            retryCount++;
            chrome.storage.local.set({ ['ticketre_retryCount_' + getTabKey()]: retryCount });
            // F5ではなく元URLに再アクセス
            location.href = originalUrl;
          }, interval);
          updateOverlayTimer(interval);
        }
        break;

      case 'waiting':
        showOverlay('⏳ 待機中', '待機画面です。リロードせずお待ちください。\n自動遷移を監視しています...');
        break;

      case 'blank':
        showOverlay('⚪ 読込中', '画面が真っ白です。30秒待機後に再読み込みします...');
        blankTimer = setTimeout(() => {
          const newStatus = detectPageStatus();
          if (newStatus.type === 'blank') {
            location.reload();
          }
        }, 30000);
        break;

      case 'not-yet':
        showOverlay('⏰ 発売前', 'まだ発売が開始されていません。発売時刻になったらリトライを開始します。');
        // 発売前は30秒間隔でリトライ（軽めに）
        if (config?.retryEnabled) {
          const interval = 30000;
          retryTimer = setTimeout(() => {
            location.href = originalUrl;
          }, interval);
          updateOverlayTimer(interval);
        }
        break;

      case 'sold-out':
        showOverlay('🔴 完売', 'この公演は予定枚数終了です。他のタブを確認してください。');
        chrome.runtime.sendMessage({
          type: 'SOLD_OUT',
          show: config?.currentShow || 'unknown'
        }).catch(() => {});
        break;

      case 'purchase':
        hideOverlay();
        chrome.runtime.sendMessage({
          type: 'PURCHASE_READY',
          show: config?.currentShow || 'unknown',
          priority: config?.currentPriority || 99
        }).catch(() => {});
        // リトライカウントリセット
        retryCount = 0;
        chrome.storage.local.set({ ['ticketre_retryCount_' + getTabKey()]: 0 });
        playSound();
        break;

      case 'login':
        hideOverlay();
        if (config?.autoFillEnabled) {
          autoFillLogin();
        }
        break;

      case 'confirm':
        hideOverlay();
        highlightConfirmPage();
        break;

      case 'error':
        showOverlay('⚠️ エラー', 'エラーが発生しました。5秒後にリロードします...');
        if (config?.retryEnabled) {
          setTimeout(() => location.reload(), 5000);
        }
        break;

      default:
        hideOverlay();
        // normalでもDOM監視を開始（動的展開に備える）
        startDOMObserver();
        break;
    }
  }

  // --- LP同意画面の自動通過 ---
  function autoPassConsent() {
    showNotification('🔄 同意画面を検知しました。自動通過を試みます...');

    // 少し待ってからDOM操作（ページの描画完了を待つ）
    setTimeout(() => {
      // 1. 同意チェックボックスを探してチェック
      const checkboxes = document.querySelectorAll(
        'input[type="checkbox"], input[name*="agree"], input[name*="consent"], input[id*="agree"]'
      );
      checkboxes.forEach(cb => {
        if (!cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          cb.dispatchEvent(new Event('click', { bubbles: true }));
        }
      });

      // 2. 同意・進むボタンをクリック
      // 候補ID
      const btnIds = ['agreement-btn', 'submit', 'next', 'agree'];
      for (const id of btnIds) {
        const btn = document.getElementById(id);
        if (btn) {
          btn.click();
          showNotification('✅ 同意画面を自動通過しました');
          return;
        }
      }

      // フォールバック: テキストでボタンを探す
      const allClickables = document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, a.button, a[href], [role="button"]');
      for (const btn of allClickables) {
        const text = btn.textContent?.trim() || btn.value || '';
        if (text.includes('申し込みへ進む') ||
            text.includes('お申し込み画面') ||
            text.includes('同意する') ||
            text.includes('同意して') ||
            text.includes('次へ進む')) {
          btn.click();
          showNotification('✅ 同意画面を自動通過しました');
          return;
        }
      }

      // submitフォームを直接送信
      const forms = document.querySelectorAll('form');
      if (forms.length === 1) {
        forms[0].submit();
        showNotification('✅ フォームを送信しました');
        return;
      }

      // それでも見つからない場合
      showNotification('⚠ 同意ボタンが見つかりません。手動で「申し込みへ進む」を押してください。');
    }, 500);
  }

  // --- リトライ間隔（ランダム揺らぎ付き） ---
  function getRetryInterval() {
    const base = config?.retryIntervalBase || 5000;
    const jitter = config?.retryJitter || 2000;
    return base + (Math.random() * jitter * 2 - jitter);
  }

  // --- 待機画面の遷移監視 ---
  function startTransitionMonitor() {
    let lastHTML = document.body?.innerHTML || '';
    monitorInterval = setInterval(() => {
      const currentHTML = document.body?.innerHTML || '';
      if (currentHTML !== lastHTML) {
        lastHTML = currentHTML;
        const newStatus = detectPageStatus();
        if (newStatus.type !== 'waiting') {
          clearInterval(monitorInterval);
          reportStatus(newStatus);
          handlePageStatus(newStatus);
        }
      }
    }, 1000);
  }

  // --- 購入画面ヘルパー ---
  function activatePurchaseHelpers() {
    highlightSeats();
    // 動的展開を監視（アコーディオンで座席が後から表示されるケース）
    startDOMObserver();
  }

  function highlightSeats() {
    const allCells = document.querySelectorAll('td, span, div, a, li, button');
    let foundNew = false;
    allCells.forEach(el => {
      if (el.classList.contains('ticketre-available') || el.classList.contains('ticketre-few') || el.classList.contains('ticketre-soldout')) return;
      const text = el.textContent?.trim();
      // 空席あり
      if (text === '○' || text === '◎') {
        el.classList.add('ticketre-available');
        el.style.cssText += '; background: #4CAF50 !important; color: white !important; font-weight: bold !important; font-size: 1.2em !important; border-radius: 4px; padding: 2px 6px;';
        foundNew = true;
      // 残りわずか
      } else if (text === '△') {
        el.classList.add('ticketre-few');
        el.style.cssText += '; background: #FF9800 !important; color: white !important; font-weight: bold !important; border-radius: 4px; padding: 2px 6px;';
        foundNew = true;
      // 売り切れ
      } else if (text === '×' || text === '✕') {
        el.classList.add('ticketre-soldout');
        el.style.cssText += '; opacity: 0.3;';
      }
    });

    if (foundNew) {
      const firstAvailable = document.querySelector('.ticketre-available');
      if (firstAvailable) {
        firstAvailable.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      // 空席発見を通知
      showNotification('🟢 空席を発見しました！緑色にハイライトされた席をご確認ください。');
    }
  }

  // --- DOM変更監視（動的展開対応） ---
  let domObserver = null;
  function startDOMObserver() {
    if (domObserver) return;
    let debounceTimer = null;
    domObserver = new MutationObserver(() => {
      // 短い間に連続して変更があっても、300ms後に1回だけ処理
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        highlightSeats();
        // ページ状態が変わったか再チェック
        const newStatus = detectPageStatus();
        if (newStatus.type !== 'normal' && newStatus.type !== 'purchase') {
          reportStatus(newStatus);
          handlePageStatus(newStatus);
        }
      }, 300);
    });
    domObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // --- ログイン自動入力 ---
  function autoFillLogin() {
    chrome.storage.local.get('ticketreCredentials', (result) => {
      if (!result.ticketreCredentials) return;
      const { userId, password } = result.ticketreCredentials;

      // ID入力
      const idField = document.querySelector('input[name*="id"], input[name*="login"], input[name*="mail"], input[type="email"], input[type="text"]');
      if (idField && userId) {
        idField.value = userId;
        idField.dispatchEvent(new Event('input', { bubbles: true }));
        idField.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // パスワード入力
      const pwField = document.querySelector('input[type="password"]');
      if (pwField && password) {
        pwField.value = password;
        pwField.dispatchEvent(new Event('input', { bubbles: true }));
        pwField.dispatchEvent(new Event('change', { bubbles: true }));
      }

      showNotification('ログイン情報を入力しました。内容を確認してログインボタンを押してください。');
    });
  }

  // --- 確認画面ハイライト ---
  function highlightConfirmPage() {
    showNotification('確認画面です。内容を確認して「購入する」ボタンを押してください。\n※ チケトレは自動で購入ボタンを押しません。');
  }

  // --- オーバーレイUI ---
  function showOverlay(title, message) {
    let overlay = document.getElementById('ticketre-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ticketre-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="ticketre-overlay-inner">
        <div class="ticketre-overlay-title">${title}</div>
        <div class="ticketre-overlay-message">${message.replace(/\n/g, '<br>')}</div>
        <div class="ticketre-overlay-timer" id="ticketre-timer"></div>
        <div class="ticketre-overlay-retry">リトライ回数: ${retryCount}</div>
      </div>
    `;
    overlay.style.display = 'flex';
  }

  function updateOverlayTimer(ms) {
    const timerEl = document.getElementById('ticketre-timer');
    if (!timerEl) return;
    let remaining = Math.ceil(ms / 1000);
    const interval = setInterval(() => {
      remaining--;
      if (timerEl) timerEl.textContent = `次のリトライまで: ${remaining}秒`;
      if (remaining <= 0) clearInterval(interval);
    }, 1000);
    timerEl.textContent = `次のリトライまで: ${remaining}秒`;
  }

  function hideOverlay() {
    const overlay = document.getElementById('ticketre-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  function showNotification(text) {
    let notif = document.getElementById('ticketre-notif');
    if (!notif) {
      notif = document.createElement('div');
      notif.id = 'ticketre-notif';
      document.body.appendChild(notif);
    }
    notif.textContent = text;
    notif.style.display = 'block';
    setTimeout(() => {
      if (notif) notif.style.display = 'none';
    }, 8000);
  }

  // --- 音声アラート ---
  function playSound() {
    if (!config?.soundEnabled) return;
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = 'sine';
      gain.gain.value = 0.3;
      osc.start();
      // ピピピ音
      setTimeout(() => { gain.gain.value = 0; }, 150);
      setTimeout(() => { gain.gain.value = 0.3; }, 250);
      setTimeout(() => { gain.gain.value = 0; }, 400);
      setTimeout(() => { gain.gain.value = 0.3; }, 500);
      setTimeout(() => { osc.stop(); ctx.close(); }, 700);
    } catch (e) {
      console.log('[チケトレ] 音声再生失敗:', e);
    }
  }

  // --- Service Workerからのメッセージ受信 ---
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATE_UPDATE') {
      // 他タブの状態更新を受信（将来使う可能性）
    }
  });

})();
