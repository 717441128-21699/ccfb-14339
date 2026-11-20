/**
 * 虚拟玩家客户端。
 *
 * 职责:
 * - 持有与房间同种子的本地确定性世界,收到 FrameBundle 后按帧序推进;
 * - 输入延迟门:本地产生的指令按"房间当前帧 + 个人延迟"定目标帧,
 *   延迟变化只影响新指令,已排队指令的目标帧不改写 —— 画面不跳;
 * - 幽灵预览:对已提交但尚未生效的指令做本地外推,渲染层半透明显示;
 * - 周期性上报世界哈希,与房间权威哈希交叉校验。
 */

import { GameMap } from '../core/map';
import { World } from '../core/world';
import { OrderType } from '../core/types';
import type {
  ClientToRoom,
  CommandBatch,
  FrameBundle,
  Order,
  RoomEvent,
  RoomToClient
} from '../core/types';

export interface ClientSnapshot {
  frame: number;
  stallFrames: number;
  delayFrames: number;
  connected: boolean;
  dropped: boolean;
  lastHash: number;
  hashMismatches: number;
  pendingCommands: number;
  aliveUnits: number;
  scriptFlags: number;
}

export class VirtualClient {
  readonly playerId: number;
  readonly world: World;
  /** 房间权威帧(已收到并执行的最后一帧) */
  authoritativeFrame = 0;
  private delayFrames = 4;
  private seq = 1;
  /** 线束自动输入排期用:上一次下发命令时的权威帧 */
  lastIssuedFrame = -1;
  private connected = true;
  private dropped = false;
  private stallCounter = 0;
  private maxStall = 0;
  private lastHash = 0;
  private hashMismatches = 0;
  private scriptFlags = 0;
  /** 已提交、等待生效的指令(幽灵预览来源) */
  private pending: Array<{ targetFrame: number; unitId: number; order: Order }> = [];
  /** 乱序到达的帧包缓存,按帧序补放 */
  private bundleBuffer = new Map<number, FrameBundle>();
  private readonly send: (msg: ClientToRoom) => void;

  constructor(
    playerId: number,
    seed: number,
    playerCount: number,
    unitsPerPlayer: number,
    mapWidthUnits: number,
    mapHeightUnits: number,
    send: (msg: ClientToRoom) => void
  ) {
    this.playerId = playerId;
    const map = GameMap.generate(seed, mapWidthUnits, mapHeightUnits);
    this.world = new World(map, seed, { playerCount, unitsPerPlayer });
    this.send = send;
  }

  hello(): void {
    this.send({ kind: 'hello', playerId: this.playerId });
  }

  // -------------------------------------------------------------------------
  // 下行消息
  // -------------------------------------------------------------------------

  receive(msg: RoomToClient): void {
    switch (msg.kind) {
      case 'welcome':
        this.connected = true;
        return;
      case 'ping':
        this.send({
          kind: 'pong',
          playerId: this.playerId,
          pingSentAt: msg.sentAt,
          nonce: msg.nonce
        });
        return;
      case 'bundle':
        this.onBundle(msg.bundle);
        return;
      case 'stats': {
        const mine = msg.stats.find((s) => s.playerId === this.playerId);
        if (mine) {
          // 延迟变化只作用于"之后"产生的指令,不重写 pending
          this.delayFrames = mine.delayFrames;
          this.dropped = mine.dropped;
          this.connected = mine.connected;
          this.scriptFlags = mine.scriptFlags;
        }
        return;
      }
      case 'event':
        this.onEvent(msg.event);
        return;
    }
  }

  private onBundle(bundle: FrameBundle): void {
    // 乱序到达先缓存,按帧序依次消费,绝不跳帧
    this.bundleBuffer.set(bundle.frame, bundle);
    let next = this.bundleBuffer.get(this.authoritativeFrame);
    while (next) {
      this.bundleBuffer.delete(this.authoritativeFrame);
      this.applyBundle(next);
      next = this.bundleBuffer.get(this.authoritativeFrame);
    }
  }

  private applyBundle(bundle: FrameBundle): void {
    this.connected = true;
    this.world.step(bundle.slots);
    this.authoritativeFrame = bundle.frame + 1;
    this.delayFrames = bundle.delays[this.playerId] ?? this.delayFrames;

    // 清理已生效指令
    this.pending = this.pending.filter((c) => c.targetFrame > bundle.frame);

    if (this.stallCounter > this.maxStall) this.maxStall = this.stallCounter;
    this.stallCounter = 0;

    if (this.authoritativeFrame % 30 === 0) {
      this.lastHash = this.world.hash();
      this.send({
        kind: 'hash',
        playerId: this.playerId,
        frame: this.world.frame,
        hash: this.lastHash
      });
    } else {
      this.send({ kind: 'frame-ack', playerId: this.playerId, frame: bundle.frame });
    }
  }

  private onEvent(event: RoomEvent): void {
    switch (event.kind) {
      case 'hash-mismatch':
        if (event.playerId === this.playerId) this.hashMismatches++;
        return;
      case 'player-dropped':
        if (event.playerId === this.playerId) {
          this.dropped = true;
          this.connected = false;
        }
        return;
      case 'script-flag':
        if (event.playerId === this.playerId) this.scriptFlags++;
        return;
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // 上行输入
  // -------------------------------------------------------------------------

  /** 本地玩家下一批命令,经过个人延迟门定目标帧 */
  issueOrders(orders: Array<{ unitId: number; order: Order }>): CommandBatch | null {
    if (!this.connected || this.dropped || orders.length === 0) return null;
    const targetFrame = this.authoritativeFrame + this.delayFrames;
    const batch: CommandBatch = {
      playerId: this.playerId,
      seq: this.seq++,
      targetFrame,
      orders
    };
    for (const e of orders) {
      this.pending.push({ targetFrame, unitId: e.unitId, order: e.order });
    }
    this.send({ kind: 'command', batch });
    return batch;
  }

  /** 每个虚拟时钟 tick 调用:统计卡顿(没收到新帧) */
  noteTick(): void {
    if (!this.dropped) this.stallCounter++;
  }

  /** 幽灵位置:对尚未生效的命令做线性外推(仅用于渲染,不进模拟) */
  ghosts(): Array<{ unitId: number; x: number; y: number; targetFrame: number }> {
    const out: Array<{ unitId: number; x: number; y: number; targetFrame: number }> = [];
    for (const c of this.pending) {
      const u = this.world.byId[c.unitId];
      if (!u || !u.alive) continue;
      const ahead = c.targetFrame - this.authoritativeFrame;
      let x = u.x;
      let y = u.y;
      if (c.order.type === OrderType.Move) {
        const dx = c.order.x - u.x;
        const dy = c.order.y - u.y;
        const dist = Math.hypot(dx, dy);
        const reach = Math.min(dist, u.speed * ahead);
        if (dist > 0) {
          x = u.x + Math.round((dx / dist) * reach);
          y = u.y + Math.round((dy / dist) * reach);
        }
      }
      out.push({ unitId: c.unitId, x, y, targetFrame: c.targetFrame });
    }
    return out;
  }

  snapshot(): ClientSnapshot {
    return {
      frame: this.authoritativeFrame,
      stallFrames: this.stallCounter,
      delayFrames: this.delayFrames,
      connected: this.connected,
      dropped: this.dropped,
      lastHash: this.lastHash,
      hashMismatches: this.hashMismatches,
      pendingCommands: this.pending.length,
      aliveUnits: this.world.aliveCount(this.playerId),
      scriptFlags: this.scriptFlags
    };
  }

  get maxStallFrames(): number {
    return this.maxStall;
  }
}
