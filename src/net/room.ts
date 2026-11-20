/**
 * 房间服务(权威帧调度器)。
 *
 * 不直接持有传输:通过 send 回调下发消息,由上层(Worker 或测试里的
 * VirtualLink)注入延迟/丢包/断连。这样同一套逻辑既能在 Worker 里跑,
 * 也能在单测里确定性地驱动。
 *
 * 每帧流程:
 *   1. RTT 探活 ping、掉线判定,掉线玩家由 ContinuityAI 以其身份补指令;
 *   2. 等待所有人的该帧指令;超过 stallFrames 仍未到齐则补空指令并记 backfill;
 *   3. 帧关闭时延迟按帧爬坡(每帧最多 ±1),发出 delay-change 事件;
 *   4. 组 FrameBundle(按 playerId 升序)并广播;
 *   5. 权威世界 step,供 AI 索敌与校验使用。
 */

import { ContinuityAI } from '../core/ai';
import { GameMap } from '../core/map';
import { FRAME_MS } from '../core/types';
import { DelayController, RttTracker } from './delay';
import { CommandValidator } from './validator';
import { World } from '../core/world';
import type {
  ClientToRoom,
  CommandBatch,
  FrameBundle,
  PlayerFrameSlot,
  PlayerNetStats,
  RoomEvent,
  RoomToClient
} from '../core/types';

export interface RoomOptions {
  playerCount: number;
  seed: number;
  unitsPerPlayer: number;
  mapWidthUnits?: number;
  mapHeightUnits?: number;
  /** 缺指令后等待的帧数,超过即补空 */
  stallFrames?: number;
  /** 多久(帧)没有任何消息判定掉线,交给 AI */
  disconnectFrames?: number;
  now: () => number;
}

interface PlayerRuntime {
  id: number;
  rtt: RttTracker;
  delay: DelayController;
  /** frame -> 已到达的指令批 */
  commands: Map<number, CommandBatch>;
  /** 最近一次收到任何上行消息的墙钟时间(活性检测用) */
  lastContactMs: number;
  backfillCount: number;
  /** 是否曾提交过指令(供统计/调试) */
  everSentCommand: boolean;
  connected: boolean;
  dropped: boolean;
  ai: ContinuityAI | null;
  pendingPing: { nonce: number; sentAt: number } | null;
}

export class RoomService {
  readonly opts: Required<Omit<RoomOptions, 'mapWidthUnits' | 'mapHeightUnits'>> & {
    mapWidthUnits: number;
    mapHeightUnits: number;
  };
  readonly world: World;
  readonly validator: CommandValidator;
  frame = 0;
  private readonly players: PlayerRuntime[];
  private readonly send: (msg: RoomToClient, targets?: number[]) => void;
  private readonly now: () => number;
  private pingNonce = 1;
  /** 下一帧的墙钟时间,按 FRAME_MS 固定步进 */
  private nextFrameAt = 0;
  /** 下一次探活 ping 的墙钟时间(独立于帧推进,停顿时也照常探测) */
  private nextPingAt = 0;
  /** 每 500ms 探一次 RTT:间隔大于最差链路 RTT,避免在途探测被覆盖 */
  private static readonly PING_INTERVAL_MS = 500;

  constructor(opts: RoomOptions, send: (msg: RoomToClient, targets?: number[]) => void) {
    this.now = opts.now;
    this.send = send;
    const map = GameMap.generate(
      opts.seed,
      opts.mapWidthUnits ?? 128,
      opts.mapHeightUnits ?? 128
    );
    this.world = new World(map, opts.seed, {
      playerCount: opts.playerCount,
      unitsPerPlayer: opts.unitsPerPlayer
    });
    this.validator = new CommandValidator(this.world, opts.playerCount);
    this.opts = {
      playerCount: opts.playerCount,
      seed: opts.seed,
      unitsPerPlayer: opts.unitsPerPlayer,
      mapWidthUnits: opts.mapWidthUnits ?? 128,
      mapHeightUnits: opts.mapHeightUnits ?? 128,
      stallFrames: opts.stallFrames ?? 12,
      disconnectFrames: opts.disconnectFrames ?? 30,
      now: opts.now
    };
    this.players = [];
    for (let i = 0; i < opts.playerCount; i++) {
      const rtt = new RttTracker();
      this.players.push({
        id: i,
        rtt,
        delay: new DelayController(i, rtt),
        commands: new Map(),
        lastContactMs: 0,
        backfillCount: 0,
        everSentCommand: false,
        connected: true,
        dropped: false,
        ai: null,
        pendingPing: null
      });
    }
  }

  // -------------------------------------------------------------------------
  // 入站消息
  // -------------------------------------------------------------------------

  handle(msg: ClientToRoom): void {
    switch (msg.kind) {
      case 'hello': {
        const p = this.players[msg.playerId];
        if (p) {
          p.lastContactMs = this.now();
          this.send(
            {
              kind: 'welcome',
              playerId: p.id,
              playerCount: this.opts.playerCount,
              seed: this.opts.seed,
              frameMs: 50
            },
            [p.id]
          );
        }
        return;
      }
      case 'command':
        this.onCommand(msg.batch, false);
        return;
      case 'pong':
        this.onPong(msg.playerId, msg.pingSentAt, msg.nonce);
        return;
      case 'frame-ack':
        this.touch(msg.playerId);
        return;
      case 'hash':
        // 客户端状态校验和与权威世界比对
        if (msg.frame === this.world.frame) {
          const expected = this.world.hash();
          if (expected !== msg.hash) {
            this.emit({
              kind: 'hash-mismatch',
              playerId: msg.playerId,
              frame: msg.frame,
              expected,
              got: msg.hash
            });
          }
        }
        this.touch(msg.playerId);
        return;
      case 'script-burst': {
        const reason = this.validator.injectScriptBurst(msg.playerId, this.frame);
        this.emit({ kind: 'script-flag', playerId: msg.playerId, reason, at: this.frame });
        return;
      }
      case 'set-link':
      case 'disconnect-player':
      case 'reconnect-player':
        // 这些是模拟器控制面消息,由 VirtualLink 处理,房间不直接接收
        return;
    }
  }

  private touch(playerId: number): void {
    const p = this.players[playerId];
    if (p) p.lastContactMs = this.now();
  }

  private onCommand(batch: CommandBatch, internalAi: boolean): void {
    const p = this.players[batch.playerId];
    if (!p) return;
    p.lastContactMs = this.now();
    p.everSentCommand = true;
    const result = this.validator.validate(batch, this.frame, internalAi);
    if (!result.ok) {
      this.emit({ kind: 'rejected', reason: result.reason ?? '校验失败', command: batch });
      return;
    }
    if (result.scriptFlag) {
      this.emit({
        kind: 'script-flag',
        playerId: batch.playerId,
        reason: result.scriptFlag,
        at: this.frame
      });
    }
    // 同帧多条:后到覆盖(seq 已保证递增)
    p.commands.set(batch.targetFrame, batch);
  }

  private onPong(playerId: number, sentAt: number, nonce: number): void {
    const p = this.players[playerId];
    if (!p) return;
    p.lastContactMs = this.now();
    if (!p.pendingPing || p.pendingPing.nonce !== nonce) return;
    const rtt = Math.max(1, this.now() - sentAt);
    p.pendingPing = null;
    p.rtt.sample(rtt);
  }

  private emit(event: RoomEvent): void {
    this.send({ kind: 'event', event });
  }

  // -------------------------------------------------------------------------
  // 每帧调度
  // -------------------------------------------------------------------------

  /**
   * 定时器入口,按细粒度(线束里 5ms)反复调用。
   *
   * 帧调度:墙钟每 FRAME_MS 关闭一帧并广播,固定 20Hz 不随网络抖动。
   * - 单帧无命令是合法锁步输入,不阻塞关帧;
   * - 只有玩家超过 stallFrames 没有任何上行消息才判定卡顿,该槽位补空;
   * - 超过 disconnectFrames 无消息判定掉线,交给 ContinuityAI;
   * - 延迟爬坡只在帧关闭时发生,停顿/目标抖动都不会让当前延迟跳变。
   * 返回 frame=-1 的占位包表示本次没有帧关闭(不广播、不推进)。
   */
  tick(): FrameBundle {
    const nowMs = this.now();

    // 1. 探活 ping:按墙钟独立调度,帧停顿/未到帧边界都不中断 RTT 测量
    if (nowMs >= this.nextPingAt) {
      this.nextPingAt = nowMs + RoomService.PING_INTERVAL_MS;
      for (const p of this.players) {
        if (p.dropped) continue;
        // 上一个探测还没回来就不覆盖,否则高延迟链路会永远测不到新 RTT
        if (p.pendingPing) continue;
        const nonce = this.pingNonce++;
        p.pendingPing = { nonce, sentAt: nowMs };
        this.send({ kind: 'ping', nonce, sentAt: nowMs }, [p.id]);
      }
    }

    // 未到下一帧边界:不尝试关帧,等链路把消息送进来
    if (nowMs < this.nextFrameAt) {
      return { frame: -1, slots: [], delays: [], drops: [] };
    }
    const frame = this.frame;

    // 目标延迟每个 tick 都跟随最新 RTT 重算;实际爬坡仍只在帧关闭时发生,
    // 因此停顿期间目标可更新,但当前延迟不会跳变。
    for (const p of this.players) {
      if (p.rtt.sampleCount > 0) p.delay.recomputeTarget();
    }

    // 2. 掉线判定 + AI 接管(按墙钟:超过 disconnectFrames 无任何上行消息)
    const disconnectMs = this.opts.disconnectFrames * FRAME_MS;
    for (const p of this.players) {
      if (p.dropped) continue;
      if (nowMs - p.lastContactMs >= disconnectMs) {
        p.dropped = true;
        p.connected = false;
        p.ai = new ContinuityAI(p.id, frame);
        this.emit({ kind: 'player-dropped', playerId: p.id, frame, aiTakeover: true });
      }
    }

    // 3. AI 以掉线玩家身份补本帧指令(幂等:已有该帧指令则跳过)
    for (const p of this.players) {
      if (!p.dropped || !p.ai || p.commands.has(frame)) continue;
      const batch = p.ai.produce(this.world, frame);
      this.onCommand(batch, true);
    }

    // 4. 卡顿判定(按墙钟,帧停顿也可靠):
    //    锁步里单帧无命令合法、不阻塞帧;只有玩家超过 stallFrames 没有任何
    //    上行消息(命令/ack/pong)才判定卡顿,本帧对其补空。
    const stallMs = this.opts.stallFrames * FRAME_MS;
    const stalledPlayers: number[] = [];
    for (const p of this.players) {
      if (p.dropped || p.commands.has(frame)) continue;
      if (nowMs - p.lastContactMs >= stallMs) stalledPlayers.push(p.id);
    }
    const stalledSet = new Set(stalledPlayers);

    // 5. 帧关闭:延迟按帧爬坡(停顿期间不爬坡 => 当前延迟不跳变、画面不跳)
    for (const p of this.players) {
      if (p.delay.ramp()) {
        const ev = p.delay.consumeChangeEvent();
        if (ev) {
          this.emit({
            kind: 'delay-change',
            playerId: p.id,
            oldDelay: ev.oldDelay,
            newDelay: ev.newDelay,
            frame
          });
        }
      }
    }

    const slots: PlayerFrameSlot[] = [];
    for (const p of this.players) {
      const batch = p.commands.get(frame);
      if (batch) {
        slots.push({ playerId: p.id, orders: batch.orders, backfilled: false });
      } else if (stalledSet.has(p.id)) {
        // 卡顿玩家超时缺帧:真正的补空,计数并告警
        slots.push({ playerId: p.id, orders: [], backfilled: true });
        p.backfillCount++;
        this.emit({ kind: 'backfill', playerId: p.id, frame });
      } else {
        // 正常的"本帧无输入"(或已由 AI 接管):空槽位,不算补空事件
        slots.push({ playerId: p.id, orders: [], backfilled: false });
      }
    }

    const bundle: FrameBundle = {
      frame,
      slots: slots.sort((a, b) => a.playerId - b.playerId),
      delays: this.players.map((p) => p.delay.delayFrames),
      drops: this.players.filter((p) => p.dropped && p.ai?.sinceFrame === frame).map((p) => p.id)
    };

    // 6. 权威世界推进,然后清理该帧队列;下一帧在一个标准帧长之后
    this.world.step(bundle.slots);
    for (const p of this.players) p.commands.delete(frame);
    this.frame++;
    this.nextFrameAt = nowMs + FRAME_MS;

    this.send({ kind: 'bundle', bundle });
    this.broadcastStats();
    return bundle;
  }

  static isClosed(bundle: FrameBundle): boolean {
    return bundle.frame >= 0;
  }

  // -------------------------------------------------------------------------

  /** 客户端按自己当前延迟给新指令定目标帧时使用 */
  suggestedTargetFrame(playerId: number): number {
    return this.frame + this.players[playerId].delay.delayFrames;
  }

  stats(): PlayerNetStats[] {
    return this.players.map((p) => ({
      playerId: p.id,
      rttEwmaMs: Math.round(p.rtt.rttEwmaMs),
      rttLatestMs: Math.round(p.rtt.rttLatestMs),
      jitterMs: Math.round(p.rtt.jitterEwmaMs),
      delayFrames: p.delay.delayFrames,
      targetDelayFrames: p.delay.targetDelayFrames,
      connected: p.connected,
      dropped: p.dropped,
      aiControlled: p.dropped,
      backfillCount: p.backfillCount,
      scriptFlags: this.validator.flagCount(p.id)
    }));
  }

  private broadcastStats(): void {
    this.send({ kind: 'stats', stats: this.stats(), frame: this.frame, roomTimeMs: this.now() });
  }
}
