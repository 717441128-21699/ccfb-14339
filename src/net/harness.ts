/**
 * 测试/Worker 共用的集成线束:虚拟时钟驱动 房间服务 + 虚拟链路 + N 个客户端。
 *
 * 时钟粒度 5ms,所有组件只通过线束感知时间,因此整局对局可在测试里
 * 全速确定性复现。
 */

import { FRAME_MS, OrderType } from '../core/types';
import type {
  ClientToRoom,
  LinkConfig,
  Order,
  RoomEvent,
  RoomToClient
} from '../core/types';
import { RoomService } from './room';
import { VirtualClient } from './virtual-client';
import { VirtualLink } from './virtual-link';

const TICK_MS = 5;

export interface HarnessOptions {
  playerCount?: number;
  unitsPerPlayer?: number;
  seed?: number;
  mapWidthUnits?: number;
  mapHeightUnits?: number;
  stallFrames?: number;
  disconnectFrames?: number;
  /** 自动让玩家周期性下随机移动命令(模拟真实流量) */
  autoInput?: boolean;
}

export class SimHarness {
  readonly room: RoomService;
  readonly link: VirtualLink;
  readonly clients: VirtualClient[];
  readonly opts: Required<HarnessOptions>;
  nowMs = 0;
  private closedFrames = 0;
  readonly events: RoomEvent[] = [];

  constructor(options: HarnessOptions = {}) {
    const opts: Required<HarnessOptions> = {
      playerCount: options.playerCount ?? 2,
      unitsPerPlayer: options.unitsPerPlayer ?? 200,
      seed: options.seed ?? 20261121,
      mapWidthUnits: options.mapWidthUnits ?? 128,
      mapHeightUnits: options.mapHeightUnits ?? 128,
      stallFrames: options.stallFrames ?? 12,
      disconnectFrames: options.disconnectFrames ?? 30,
      autoInput: options.autoInput ?? true
    };
    this.opts = opts;

    this.room = new RoomService(
      {
        playerCount: opts.playerCount,
        seed: opts.seed,
        unitsPerPlayer: opts.unitsPerPlayer,
        mapWidthUnits: opts.mapWidthUnits,
        mapHeightUnits: opts.mapHeightUnits,
        stallFrames: opts.stallFrames,
        disconnectFrames: opts.disconnectFrames,
        now: () => this.nowMs
      },
      (msg, targets) => {
        // 房间事件同步镜像到线束,便于测试断言;消息本身仍正常进入链路
        if (msg.kind === 'event') this.events.push(msg.event);
        this.link.sendDown(msg, targets);
      }
    );

    this.link = new VirtualLink(
      opts.playerCount,
      opts.seed,
      0,
      (msg) => this.room.handle(msg),
      (playerId, msg) => this.clients[playerId]?.receive(msg)
    );

    this.clients = [];
    for (let i = 0; i < opts.playerCount; i++) {
      const client = new VirtualClient(
        i,
        opts.seed,
        opts.playerCount,
        opts.unitsPerPlayer,
        opts.mapWidthUnits,
        opts.mapHeightUnits,
        (msg) => this.link.sendUp(msg)
      );
      this.clients.push(client);
      client.hello();
    }
  }

  /** 推进虚拟时钟,返回期间关闭的帧数 */
  advance(ms: number): number {
    const target = this.nowMs + ms;
    const before = this.closedFrames;
    while (this.nowMs < target) {
      this.nowMs += TICK_MS;
      // 先投递到期链路消息,再驱动房间:本 tick 到达的指令能赶上本帧
      this.link.advance(this.nowMs);
      if (this.opts.autoInput) this.autoIssue();
      for (const c of this.clients) c.noteTick();

      const bundle = this.room.tick();
      if (bundle.frame >= 0) this.closedFrames++;
    }
    return this.closedFrames - before;
  }

  /** 直接推进到指定房间帧已关闭 */
  advanceToFrame(frame: number, maxMs = 60000): void {
    const deadline = this.nowMs + maxMs;
    while (this.room.frame < frame && this.nowMs < deadline) {
      this.advance(FRAME_MS);
    }
    if (this.room.frame < frame) throw new Error(`未能在 ${maxMs}ms 内推进到帧 ${frame}`);
  }

  // -------------------------------------------------------------------------
  // 场景控制
  // -------------------------------------------------------------------------

  setLink(playerId: number, patch: Partial<LinkConfig>): void {
    this.link.setLink(playerId, patch);
  }

  disconnect(playerId: number): void {
    this.link.disconnect(playerId);
  }

  reconnect(playerId: number): void {
    this.link.reconnect(playerId);
  }

  /** 测试钩子:让房间直接产生一条脚本标记 */
  scriptBurst(playerId: number): void {
    this.room.handle({ kind: 'script-burst', playerId });
  }

  /** 玩家显式下令(绕开自动输入) */
  issue(playerId: number, orders: Array<{ unitId: number; order: Order }>): void {
    this.clients[playerId].issueOrders(orders);
  }

  moveOrder(x: number, y: number): Order {
    return { type: OrderType.Move, x, y, targetId: 0 };
  }

  // -------------------------------------------------------------------------

  private autoIssue(): void {
    // 按客户端各自的权威帧节拍发令:每推进一个新帧就为"延迟窗之后的目标帧"
    // 准备一条命令。目标帧由 VirtualClient 的延迟门决定,天然覆盖一个往返。
    for (const c of this.clients) {
      const snap = c.snapshot();
      if (!snap.connected || snap.dropped) continue;
      if (c.lastIssuedFrame === snap.frame) continue;
      c.lastIssuedFrame = snap.frame;

      // 每 5 帧真正下一次令(4Hz 人类节奏),其余帧不产生输入 —— 远低于脚本阈值
      if (snap.frame % 5 !== 0) continue;
      const own = c.world.units.filter((u) => u.alive && u.owner === c.playerId).slice(0, 10);
      const seed = snap.frame * 37 + c.playerId * 101;
      const orders = own.map((u) => ({
        unitId: u.id,
        order: this.moveOrder(
          u.x + ((seed + u.id * 13) % 2048) - 1024,
          u.y + ((seed + u.id * 29) % 2048) - 1024
        )
      }));
      c.issueOrders(orders);
    }
  }

  get closedFrameCount(): number {
    return this.closedFrames;
  }

  /**
   * 已追上房间帧的客户端,其世界哈希是否与房间一致。
   * 帧包仍在链路上的客户端(权威帧落后)不参与比较 —— 那是在途延迟,不是分叉。
   */
  allHashesMatch(): boolean {
    const h = this.room.world.hash();
    return this.clients
      .filter((c) => c.authoritativeFrame === this.room.frame)
      .every((c) => c.world.hash() === h);
  }

  /** 所有客户端是否都已收到并执行到房间当前帧 */
  allClientsCaughtUp(): boolean {
    return this.clients.every((c) => c.authoritativeFrame === this.room.frame);
  }
}
