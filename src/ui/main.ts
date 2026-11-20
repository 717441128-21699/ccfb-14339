/**
 * 主线程:承载渲染与控制面板,房间逻辑全部在 Worker 中。
 */

import './style.css';
import type { MainToWorker, RenderSnapshot } from '../worker/room-worker';

const PLAYER_COLORS = ['#5aa7ff', '#ff8a5a', '#46d39a', '#c084fc', '#f472b6', '#facc15'];

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const worker = new Worker(new URL('../worker/room-worker.ts', import.meta.url), { type: 'module' });

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const frameEl = $('frame');
const simMsEl = $('simms');
const hashEl = $('hash');
const ghostEl = $('ghost');
const statsBody = $('stats').querySelector('tbody')!;
const logEl = $('log');

let latest: RenderSnapshot | null = null;
let disconnected = false;

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function draw(snap: RenderSnapshot): void {
  const { width, height } = snap.map;
  const scale = canvas.width / Math.max(width, height);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 网格
  ctx.strokeStyle = '#1b2331';
  ctx.lineWidth = 1;
  for (let gx = 0; gx <= width; gx += 256 * 4) {
    ctx.beginPath();
    ctx.moveTo(gx * scale, 0);
    ctx.lineTo(gx * scale, canvas.height);
    ctx.stroke();
  }
  for (let gy = 0; gy <= height; gy += 256 * 4) {
    ctx.beginPath();
    ctx.moveTo(0, gy * scale);
    ctx.lineTo(canvas.width, gy * scale);
    ctx.stroke();
  }

  for (const u of snap.units) {
    if (!u.alive) continue;
    const r = Math.max(2, u.maxHp > 100 ? 3.2 : 2.6);
    ctx.beginPath();
    ctx.arc(u.x * scale, u.y * scale, r, 0, Math.PI * 2);
    ctx.fillStyle = PLAYER_COLORS[u.owner % PLAYER_COLORS.length];
    ctx.globalAlpha = u.ai ? 0.55 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (u.ai) {
      ctx.strokeStyle = '#ffb454';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function renderHud(snap: RenderSnapshot): void {
  frameEl.textContent = String(snap.frame);
  simMsEl.textContent = String(snap.simMs);
  hashEl.textContent = snap.hashMatch ? '一致 ✓' : '不一致 ✗';
  hashEl.style.color = snap.hashMatch ? 'var(--ok)' : 'var(--bad)';
  ghostEl.textContent = String(snap.ghostCount);

  statsBody.innerHTML = '';
  for (const s of snap.stats) {
    const tr = document.createElement('tr');
    const state = s.dropped ? 'AI 接管' : s.connected ? '在线' : '断连';
    tr.innerHTML =
      `<td>${s.playerId}</td>` +
      `<td>${s.rttEwmaMs}</td>` +
      `<td>${s.jitterMs}</td>` +
      `<td>${s.delayFrames}→${s.targetDelayFrames}</td>` +
      `<td>${s.backfillCount}</td>` +
      `<td style="color:${s.dropped ? 'var(--warn)' : 'var(--ok)'}">${state}${
        s.scriptFlags ? ` ·脚本×${s.scriptFlags}` : ''
      }</td>`;
    statsBody.appendChild(tr);
  }

  for (const line of snap.events) {
    const li = document.createElement('li');
    li.textContent = line;
    if (line.includes('掉线') || line.includes('不一致') || line.includes('拒绝')) li.className = 'bad';
    else if (line.includes('补空') || line.includes('脚本')) li.className = 'warn';
    logEl.prepend(li);
    while (logEl.children.length > 40) logEl.lastElementChild?.remove();
  }
}

worker.onmessage = (ev: MessageEvent<RenderSnapshot>) => {
  latest = ev.data;
  draw(latest);
  renderHud(latest);
};

// ---------------------------------------------------------------------------
// 控制面板
// ---------------------------------------------------------------------------

const post = (msg: MainToWorker): void => worker.postMessage(msg);

const lat = $('lat') as HTMLInputElement;
const jit = $('jit') as HTMLInputElement;
const loss = $('loss') as HTMLInputElement;
const latv = $('latv');
const jitv = $('jitv');
const lossv = $('lossv');

function pushLink(): void {
  latv.textContent = `${lat.value}ms`;
  jitv.textContent = `${jit.value}ms`;
  lossv.textContent = `${loss.value}%`;
  post({
    kind: 'set-link',
    playerId: 1,
    patch: {
      baseLatencyMs: Number(lat.value),
      jitterMs: Number(jit.value),
      lossRate: Number(loss.value) / 100
    }
  });
}

[lat, jit, loss].forEach((el) => el.addEventListener('input', pushLink));

$('good').addEventListener('click', () => {
  lat.value = '25';
  jit.value = '5';
  loss.value = '0';
  pushLink();
});

$('bad').addEventListener('click', () => {
  lat.value = '150';
  jit.value = '30';
  loss.value = '5';
  pushLink();
});

// RTT 50→300:先 25ms 单向(RTT≈50),1 秒后切到 150ms(RTT≈300)
$('rtt50').addEventListener('click', () => {
  lat.value = '25';
  jit.value = '5';
  pushLink();
  setTimeout(() => {
    lat.value = '150';
    jit.value = '10';
    pushLink();
  }, 1000);
});

$('disconnect').addEventListener('click', () => {
  post({ kind: 'disconnect', playerId: 1 });
  disconnected = true;
  $('disconnect').setAttribute('disabled', '');
  $('reconnect').removeAttribute('disabled');
});

$('reconnect').addEventListener('click', () => {
  post({ kind: 'reconnect', playerId: 1 });
  disconnected = false;
  $('reconnect').setAttribute('disabled', '');
  $('disconnect').removeAttribute('disabled');
});

$('script').addEventListener('click', () => post({ kind: 'script-burst', playerId: 1 }));

let paused = false;
$('pause').addEventListener('click', (e) => {
  paused = !paused;
  (e.target as HTMLButtonElement).textContent = paused ? '继续' : '暂停';
  post({ kind: paused ? 'pause' : 'resume' });
});

$('restart').addEventListener('click', () => {
  post({
    kind: 'restart',
    options: {
      playerCount: 2,
      unitsPerPlayer: Number(($('units') as HTMLSelectElement).value),
      autoInput: ($('auto') as HTMLInputElement).checked,
      seed: 20261121
    }
  });
  logEl.innerHTML = '';
});

void canvas;
void latest;
void disconnected;
