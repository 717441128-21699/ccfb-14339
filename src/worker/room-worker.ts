/**
 * 浏览器 Worker 版房间服务:
 * 用真实 setInterval 驱动 SimHarness,主线程只收渲染快照、发场景控制。
 * 这样锁步/网络/AI 的全部逻辑都在 Worker 线程里,与渲染互不阻塞。
 */

import { SimHarness } from '../net/harness';
import type { LinkConfig } from '../core/types';

export interface RenderUnit {
  id: number;
  owner: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  ai: boolean;
}

export interface RenderSnapshot {
  frame: number;
  simMs: number;
  units: RenderUnit[];
  map: { width: number; height: number };
  stats: ReturnType<SimHarness['room']['stats']>;
  events: string[];
  hashMatch: boolean;
  ghostCount: number;
}

export type MainToWorker =
  | { kind: 'restart'; options: WorkerOptions }
  | { kind: 'set-link'; playerId: number; patch: Partial<LinkConfig> }
  | { kind: 'disconnect'; playerId: number }
  | { kind: 'reconnect'; playerId: number }
  | { kind: 'script-burst'; playerId: number }
  | { kind: 'pause' }
  | { kind: 'resume' };

export interface WorkerOptions {
  playerCount: number;
  unitsPerPlayer: number;
  autoInput: boolean;
  seed: number;
}

let harness: SimHarness | null = null;
let paused = false;
let timer: ReturnType<typeof setInterval> | null = null;
let lastEventCount = 0;

function build(opts: WorkerOptions): SimHarness {
  return new SimHarness({
    playerCount: opts.playerCount,
    unitsPerPlayer: opts.unitsPerPlayer,
    seed: opts.seed,
    autoInput: opts.autoInput
  });
}

function snapshot(h: SimHarness): RenderSnapshot {
  const aiOwners = new Set(
    h.room.stats().filter((s) => s.aiControlled).map((s) => s.playerId)
  );
  const units: RenderUnit[] = h.room.world.units.map((u) => ({
    id: u.id,
    owner: u.owner,
    x: u.x,
    y: u.y,
    hp: u.hp,
    maxHp: u.maxHp,
    alive: u.alive,
    ai: aiOwners.has(u.owner)
  }));
  const newEvents = h.events.slice(lastEventCount).map((e) => {
    switch (e.kind) {
      case 'backfill':
        return `帧 ${e.frame}:玩家 ${e.playerId} 缺指令,补空`;
      case 'player-dropped':
        return `帧 ${e.frame}:玩家 ${e.playerId} 掉线,AI 接管`;
      case 'delay-change':
        return `帧 ${e.frame}:玩家 ${e.playerId} 延迟 ${e.oldDelay}→${e.newDelay} 帧`;
      case 'script-flag':
        return `帧 ${e.at}:玩家 ${e.playerId} 疑似脚本 — ${e.reason}`;
      case 'rejected':
        return `指令拒绝:${e.reason}`;
      case 'hash-mismatch':
        return `帧 ${e.frame}:玩家 ${e.playerId} 哈希不一致!`;
    }
  });
  lastEventCount = h.events.length;
  return {
    frame: h.room.frame,
    simMs: h.nowMs,
    units,
    map: { width: h.room.world.map.width, height: h.room.world.map.height },
    stats: h.room.stats(),
    events: newEvents,
    hashMatch: h.allHashesMatch(),
    ghostCount: h.clients.reduce((n, c) => n + c.snapshot().pendingCommands, 0)
  };
}

function start(opts: WorkerOptions): void {
  if (timer) clearInterval(timer);
  harness = build(opts);
  paused = false;
  lastEventCount = 0;
  // 25ms 推进一次(线束内部 5ms 粒度,每次推 5 个 tick)
  timer = setInterval(() => {
    if (paused || !harness) return;
    harness.advance(25);
    (postMessage as (msg: RenderSnapshot) => void)(snapshot(harness));
  }, 25);
}

self.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data;
  if (!harness || msg.kind === 'restart') {
    if (msg.kind === 'restart') start(msg.options);
    return;
  }
  switch (msg.kind) {
    case 'set-link':
      harness.setLink(msg.playerId, msg.patch);
      break;
    case 'disconnect':
      harness.disconnect(msg.playerId);
      break;
    case 'reconnect':
      harness.reconnect(msg.playerId);
      break;
    case 'script-burst':
      harness.scriptBurst(msg.playerId);
      break;
    case 'pause':
      paused = true;
      break;
    case 'resume':
      paused = false;
      break;
  }
};

// 模块加载即给一个默认对局,UI 打开就有画面
start({ playerCount: 2, unitsPerPlayer: 200, autoInput: true, seed: 20261121 });
