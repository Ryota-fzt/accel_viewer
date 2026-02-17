/****************************************************
 * M5STAMP（ESP32/NimBLE, NUS）向け Web Bluetooth 受信スクリプト
 * - t, ax, ay, az（CSV, 改行区切り）を Notify で受信して可視化
 * - 再キャリブレーション指示は RX に "X\n" を Write 送信
 * - 切断→再接続に強いように、通知ハンドラの登録/解除を厳密化
 * 
 * ★ 使い方：
 *   1) index.html / style.css / main.js を同一フォルダに置いて GitHub Pages で公開
 *   2) Chrome/Edge でアクセス → 「接続（BLE）」→ デバイス選択
 *   3) グラフが流れます。再キャリブは「再キャリブレーション指示」を押下
 ****************************************************/

/* ====== ★ NUS UUID（M5側と一致させる） ======
 * M5STAMP 側で採用している Nordic UART Service の UUID 群。
 * 先生の Arduino 側の SERVICE_UUID/RX/TX と一致している必要があります。
 */
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX_CHAR  = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Notify (peripheral -> central)
const NUS_RX_CHAR  = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Write  (central -> peripheral)

/* ====== DOM 要素参照 ======
 * UI 部品をキャッシュして操作します。
 */
const statusEl = document.getElementById('status');       // 状態表示（接続中/未接続）
const linesEl = document.getElementById('lines');         // 受信行数カウンタ
const latestEl = document.getElementById('latest');       // 最新1行の生テキスト
const valuesEl = document.getElementById('values');       // 最新の数値（整形表示）
const connectBtn = document.getElementById('connectBtn'); // 接続ボタン
const disconnectBtn = document.getElementById('disconnectBtn'); // 切断ボタン
const pointsInput = document.getElementById('points');    // グラフの最大表示点数
const recalBtn = document.getElementById('recalBtn');     // 再キャリブ指示ボタン
const downloadBtn = document.getElementById('downloadBtn'); // CSV ダウンロード

/* ====== BLE ハンドル（接続状態の保持） ======
 * device/server/service/characteristic の参照を保持します。
 * 切断→再接続時にハンドラが二重登録されないよう、ハンドラ参照も変数で保持します。
 */
let device = null;
let server = null;
let txChar = null;  // Notify 受信用（TX特性）
let rxChar = null;  // Write 送信用（RX特性）
let connected = false;

// ★ 通知ハンドラを removeEventListener するため、同じ関数参照を保持
let notifyHandler = null;

/* ====== 受信テキストのバッファリング ======
 * BLE 通知は MTU を超えると改行単位で割れます。行復元のためバッファ＋split('\n') で処理。
 */
let lineBuffer = '';
let lineCount = 0;

// ★ ログ保存用（CSVダウンロードで使用）
const csvLog = []; // 各要素は [t_ms, ax, ay, az]

/* ====== Chart.js セットアップ ======
 * 3本線（ax/ay/az）を表示。最大点数は UI から変更可能。
 */
const ctx = document.getElementById('accChart').getContext('2d');
const MAX_POINTS_DEFAULT = parseInt(pointsInput.value, 10);

const chartData = {
  labels: [], // x軸（時刻ms）
  datasets: [
    { label: 'ax[g]', data: [], borderColor: '#e91e63', tension: 0.15, pointRadius: 0 },
    { label: 'ay[g]', data: [], borderColor: '#3f51b5', tension: 0.15, pointRadius: 0 },
    { label: 'az[g]', data: [], borderColor: '#009688', tension: 0.15, pointRadius: 0 },
  ]
};
const accChart = new Chart(ctx, {
  type: 'line',
  data: chartData,
  options: {
    animation: false, // ★ リアルタイム用にアニメOFF（描画負荷軽減）
    responsive: true,
    scales: {
      x: { title: { display: true, text: '時刻[ms]' } },
      y: { title: { display: true, text: '加速度[g]' } }
    },
    plugins: { legend: { position: 'bottom' } }
  }
});

/* ====== UI ユーティリティ ======
 * 状態表示を更新するだけの関数。
 */
function setStatus(text) {
  statusEl.textContent = text || '';
}

/* ====== 1サンプルをグラフに追加 ======
 * 表示上限を超えた古い点は先頭から捨てる（スクロール表示）。
 */
function pushSample(t, ax, ay, az) {
  const maxPoints = parseInt(pointsInput.value, 10) || MAX_POINTS_DEFAULT;

  chartData.labels.push(t);
  chartData.datasets[0].data.push(ax);
  chartData.datasets[1].data.push(ay);
  chartData.datasets[2].data.push(az);

  // ★ 上限超過の古いデータを削除（ラベルと各系列を同期してshift）
  while (chartData.labels.length > maxPoints) {
    chartData.labels.shift();
    chartData.datasets.forEach(ds => ds.data.shift());
  }

  accChart.update('none'); // ★ アニメなしで即時更新
}

/* ====== ★ 行分割パーサ：BLE通知から届く文字列をCSVに復元 ======
 * 1) 断片をバッファに連結
 * 2) 改行 split して最後の未完行はバッファに戻す
 * 3) "t,ax,ay,az" の4要素が数値として成立すれば採用
 */
function parseLines(text) {
  lineBuffer += text;
  const lines = lineBuffer.split('\n');
  lineBuffer = lines.pop(); // ★ 最後の未完行はバッファに保持

  for (const l of lines) {
    const line = l.trim();
    if (!line) continue;

    // 例: "12345,0.012,-0.034,0.998"
    const parts = line.split(',');
    if (parts.length < 4) continue;

    const t  = Number(parts[0]);
    const ax = Number(parts[1]);
    const ay = Number(parts[2]);
    const az = Number(parts[3]);

    if ([t, ax, ay, az].every(Number.isFinite)) {
      lineCount++;
      linesEl.textContent = String(lineCount);
      latestEl.textContent = line;
      valuesEl.textContent = `ax: ${ax.toFixed(3)}, ay: ${ay.toFixed(3)}, az: ${az.toFixed(3)}`;
      pushSample(t, ax, ay, az);

      // ★ ログにも保存（CSVダウンロード用）
      csvLog.push([t, ax, ay, az]);
    }
  }
}

/* ====== ★ BLE接続処理（ユーザー操作からのみ呼べる） ======
 * 1) デバイス選択（サービスUUIDでフィルタ）
 * 2) GATT接続 → NUSサービス取得
 * 3) TX（Notify）と RX（Write）特性を取得
 * 4) TX 通知を start & イベントハンドラ登録
 */
async function connectBLE() {
  try {
    // 1) デバイス選択（★ボタン押下イベントからのみ呼べる）
       device = await navigator.bluetooth.requestDevice({
       // ★ M5 側の名前に合わせる（例："M5STAMP-" 接頭辞）
       filters: [{ namePrefix: 'M5' }],
       optionalServices: [NUS_SERVICE]   // 取得したいサービスは optional に指定
    });

    // 2) GATT接続
    server = await device.gatt.connect();

    // 3) NUS サービス & 特性取得
    const service = await server.getPrimaryService(NUS_SERVICE);

    txChar = await service.getCharacteristic(NUS_TX_CHAR); // Notify 受信
    try {
      rxChar = await service.getCharacteristic(NUS_RX_CHAR); // Write 送信
    } catch {
      rxChar = null; // RXが無い場合もある（古いFW等）
    }

    // 4) 通知開始 & ハンドラ登録（★同じ参照を保持して remove できるように）
    await txChar.startNotifications();
    notifyHandler = (event) => {
      const dv = event.target.value; // DataView
      // ★ DataView → 文字列（UTF-8想定。ASCII領域はこれでOK）
      let chunk = '';
      for (let i = 0; i < dv.byteLength; i++) {
        chunk += String.fromCharCode(dv.getUint8(i));
      }
      parseLines(chunk);
    };
    txChar.addEventListener('characteristicvaluechanged', notifyHandler);

    // UI 更新
    connected = true;
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    setStatus(`BLE接続: ${device.name || '(名称なし)'}`);

    console.log('[BLE] connected to', device.name);
  } catch (err) {
    alert('BLE接続に失敗: ' + err.message);
    console.error('[BLE] connect error', err);
    await disconnectBLE(); // 中途状態の後始末
  }
}

/* ====== ★ 切断処理（安定運用の要） ======
 * - 通知停止 → イベントリスナ解除（同じ参照をremove）
 * - GATT切断
 * - 参照をクリアし、UI・フラグをリセット
 */
async function disconnectBLE() {
  try {
    if (txChar) {
      try { await txChar.stopNotifications(); } catch (e) { /* ignore */ }
      if (notifyHandler) {
        txChar.removeEventListener('characteristicvaluechanged', notifyHandler);
        notifyHandler = null;
      }
    }
    if (device?.gatt?.connected) {
      await device.gatt.disconnect();
    }
  } finally {
    
    // ★ OS側の切断完了を少し待つ（再接続安定化）
    await new Promise(r => setTimeout(r, 800));

    // 参照クリア
    device = null;
    server = null;
    txChar = null;
    rxChar = null;

    // UIリセット
    connected = false;
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    setStatus('未接続');

    console.log('[BLE] disconnected');
  }
}

/* ====== GATT側から切断通知が来たときに呼ばれる ====== */
function onDisconnected() {
  // ★ OS/ブラウザ都合の切断時も、同じ後始末を実行
  disconnectBLE();
}

/* ====== ★ 再キャリブレーション指示 ======
 * M5 側の RX（Write）特性に "X\n" を書き込みます。
 * Arduino 側は onWrite() → needRecal = true → recalibrate()
 */
async function sendRecal() {
  if (!connected) {
    alert('接続してから実行してください');
    return;
  }
  if (!rxChar) {
    alert('このデバイスはRX書き込みに未対応です');
    return;
  }
  try {
    const enc = new TextEncoder();
    const payload = enc.encode('X\n'); // ★ 空でなければOK。識別用に "X\n"
    await rxChar.writeValue(payload);
    console.log('[BLE] recalibration command sent');
  } catch (e) {
    console.error('[BLE] write error', e);
    alert('再キャリブ送信に失敗しました');
  }
}

/* ====== ★ CSV ダウンロード ======
 * 受信済みの csvLog を "t_ms,ax_g,ay_g,az_g" 形式で保存。
 */
function downloadCSV() {
  if (csvLog.length === 0) {
    alert('データがありません');
    return;
  }
  const header = 't_ms,ax_g,ay_g,az_g\n';
  const body = csvLog.map(row => row.join(',')).join('\n');
  const blob = new Blob([header + body], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = 'acc_log.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ====== ★ イベント紐づけ ======
 * それぞれの UI ボタンに処理を結びます。
 */
connectBtn.addEventListener('click', connectBLE);
disconnectBtn.addEventListener('click', disconnectBLE);
recalBtn.addEventListener('click', sendRecal);
downloadBtn.addEventListener('click', downloadCSV);

// （必要に応じて）ページ離脱時に自動切断する例：
// window.addEventListener('beforeunload', () => { if (connected) device?.gatt?.disconnect(); });
``


