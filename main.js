// ===== BLE NUS UUID（先生のArduino側に合わせています）=====
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX_CHAR  = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Notify (from device)
const NUS_RX_CHAR  = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Write  (to device)

// ===== DOM =====
const statusEl = document.getElementById('status');
const linesEl = document.getElementById('lines');
const latestEl = document.getElementById('latest');
const valuesEl = document.getElementById('values');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const pointsInput = document.getElementById('points');
const recalBtn = document.getElementById('recalBtn');
const downloadBtn = document.getElementById('downloadBtn');

// ===== BLE Handles =====
let device, server, txChar, rxChar;
let connected = false;

// ===== Parsing / Buffering =====
let lineBuffer = '';
let lineCount = 0;
const csvLog = []; // [t, ax, ay, az]

// ===== Chart.js =====
const ctx = document.getElementById('accChart').getContext('2d');
const MAX_POINTS_DEFAULT = parseInt(pointsInput.value, 10);

const chartData = {
  labels: [],
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
    animation: false,
    responsive: true,
    scales: {
      x: { title: { display: true, text: '時刻[ms]' } },
      y: { title: { display: true, text: '加速度[g]' } }
    },
    plugins: { legend: { position: 'bottom' } }
  }
});

function setStatus(text) { statusEl.textContent = text; }

function pushSample(t, ax, ay, az) {
  const maxPoints = parseInt(pointsInput.value, 10) || MAX_POINTS_DEFAULT;
  chartData.labels.push(t);
  chartData.datasets[0].data.push(ax);
  chartData.datasets[1].data.push(ay);
  chartData.datasets[2].data.push(az);
  while (chartData.labels.length > maxPoints) {
    chartData.labels.shift();
    chartData.datasets.forEach(ds => ds.data.shift());
  }
  accChart.update('none');
}

function parseLines(text) {
  lineBuffer += text;
  const lines = lineBuffer.split('\n');
  lineBuffer = lines.pop(); // keep last partial

  for (const l of lines) {
    const line = l.trim();
    if (!line) continue;
    // "t_ms,ax,ay,az"
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
      csvLog.push([t, ax, ay, az]);
    }
  }
}

// ===== BLE Connect/Disconnect =====
async function connectBLE() {
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE] }],
      optionalServices: [NUS_SERVICE]
    });
    device.addEventListener('gattserverdisconnected', onDisconnected);

    server = await device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);

    txChar = await service.getCharacteristic(NUS_TX_CHAR);
    try { rxChar = await service.getCharacteristic(NUS_RX_CHAR); } catch { rxChar = null; }

    await txChar.startNotifications();
    txChar.addEventListener('characteristicvaluechanged', (event) => {
      const value = event.target.value; // DataView
      let chunk = '';
      for (let i = 0; i < value.byteLength; i++) {
        chunk += String.fromCharCode(value.getUint8(i));
      }
      parseLines(chunk);
    });

    connected = true;
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    setStatus(`BLE接続: ${device.name || '(名称なし)'}`);
  } catch (err) {
    alert('BLE接続に失敗: ' + err.message);
    console.error(err);
    await disconnectBLE();
  }
}

async function disconnectBLE() {
  try {
    if (txChar) {
      try { await txChar.stopNotifications(); } catch {}
      txChar.removeEventListener?.('characteristicvaluechanged', () => {});
    }
    if (device?.gatt?.connected) {
      await device.gatt.disconnect();
    }
  } finally {
    device = server = txChar = rxChar = null;
    connected = false;
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    setStatus('未接続');
  }
}

function onDisconnected() {
  disconnectBLE();
}

// ===== 再キャリブレーション指示 =====
async function sendRecal() {
  if (!connected) return alert('接続してから実行してください');
  if (!rxChar) return alert('このデバイスはRX書き込みに未対応です');
  try {
    const enc = new TextEncoder();
    await rxChar.writeValue(enc.encode('X\n'));
  } catch (e) {
    alert('再キャリブ送信に失敗しました');
  }
}

// ===== CSV ダウンロード =====
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
  a.href = url; a.download = 'acc_log.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ===== UI Events =====
connectBtn.addEventListener('click', connectBLE);
disconnectBtn.addEventListener('click', disconnectBLE);
recalBtn.addEventListener('click', sendRecal);
downloadBtn.addEventListener('click', downloadCSV);