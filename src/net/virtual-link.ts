/**
 * 虚拟链路:在 Worker/测试里模拟每条玩家链路的延迟、抖动、丢包与断连。
 *
 * 可靠性语义:
 * - 控制面(ping/pong/ack)为不可靠,丢了就丢了,靠下一轮探测自愈;
 * - 指令/帧包/哈希为可靠:丢包按额外 RTT 重传,只影响有效时延;
 * - 断连期间消息保留在队列中,恢复后照常投递(seq 不变,房间去重)。
 *
 * 每条链路持有独立的确定性 PRNG,抖动与丢包结果可复现。
 */

import { deriveSeed, mulberry32 } from '../core/fixed';
import type { ClientToRoom, LinkConfig, RoomToClient } from '../core/types';

interface InFlight {
  deliverAt: number;
  msg: ClientToRoom | RoomToClient;
  playerId: number;
  direction: 'up' | 'down';
  reliable: boolean;
  attempts: number;
}

const RELIABLE_UP = new Set(['command', 'frame-ack', 'hash', 'hello']);
const RELIABLE_DOWN = new Set(['bundle', 'welcome', 'stats', 'event']);

export class VirtualLink {
  private readonly links: LinkConfig[];
  private readonly rng: Array<() => number>;
  private queue: InFlight[] = [];
  private now: number;
  private readonly toRoom: (msg: ClientToRoom) => void;
  private readonly toClient: (playerId: number, msg: RoomToClient) => void;
  /** 断连期间暂存的上行消息,恢复后重新排队 */
  private readonly parked: InFlight[] = [];

  constructor(
    playerCount: number,
    seed: number,
    startMs: number,
    toRoom: (msg: ClientToRoom) => void,
    toClient: (playerId: number, msg: RoomToClient) => void
  ) {
    this.now = startMs;
    this.toRoom = toRoom;
    this.toClient = toClient;
    this.links = [];
    this.rng = [];
    for (let i = 0; i < playerCount; i++) {
      this.links.push({
        baseLatencyMs: 25,
        jitterMs: 5,
        lossRate: 0,
        disconnected: false
      });
      this.rng.push(mulberry32(deriveSeed(seed, 1000 + i)));
    }
  }

  setLink(playerId: number, patch: Partial<LinkConfig>): void {
    Object.assign(this.links[playerId], patch);
  }

  getLink(playerId: number): LinkConfig {
    return { ...this.links[playerId] };
  }

  /** 客户端 -> 房间 */
  sendUp(msg: ClientToRoom): void {
    const playerId = this.playerOf(msg);
    this.enqueue(msg, playerId, 'up', RELIABLE_UP.has(msg.kind));
  }

  /** 房间 -> 客户端(广播 targets 为空表示全员) */
  sendDown(msg: RoomToClient, targets?: number[]): void {
    const list = targets ?? this.links.map((_, i) => i);
    for (const playerId of list) {
      this.enqueue(msg, playerId, 'down', RELIABLE_DOWN.has(msg.kind));
    }
  }

  private playerOf(msg: ClientToRoom): number {
    switch (msg.kind) {
      case 'hello':
        return msg.playerId;
      case 'command':
        return msg.batch.playerId;
      case 'frame-ack':
      case 'pong':
      case 'hash':
      case 'set-link':
      case 'disconnect-player':
      case 'reconnect-player':
      case 'script-burst':
        return msg.playerId;
    }
  }

  private enqueue(
    msg: InFlight['msg'],
    playerId: number,
    direction: InFlight['direction'],
    reliable: boolean
  ): void {
    const link = this.links[playerId];
    if (link.disconnected) {
      // 断连:可靠消息停车等待,不可靠消息直接丢弃
      if (reliable) this.parked.push({ deliverAt: -1, msg, playerId, direction, reliable, attempts: 0 });
      return;
    }
    const item: InFlight = {
      deliverAt: this.now + this.transitMs(playerId),
      msg,
      playerId,
      direction,
      reliable,
      attempts: 1
    };
    this.insert(item);
  }

  private transitMs(playerId: number): number {
    const link = this.links[playerId];
    const rand = this.rng[playerId]();
    const jitter = (rand * 2 - 1) * link.jitterMs;
    return Math.max(1, Math.round(link.baseLatencyMs + jitter));
  }

  private insert(item: InFlight): void {
    // 队列基本有序,从尾部找插入位置(同刻到达的消息保持入队顺序)
    const q = this.queue;
    let i = q.length;
    while (i > 0 && q[i - 1].deliverAt > item.deliverAt) i--;
    q.splice(i, 0, item);
  }

  /** 推进虚拟时钟并投递到期消息;返回本轮投递数量 */
  advance(nowMs: number): number {
    this.now = nowMs;
    let delivered = 0;
    const q = this.queue;
    while (q.length > 0 && q[0].deliverAt <= nowMs) {
      const item = q.shift()!;
      const link = this.links[item.playerId];
      const lost = link.lossRate > 0 && this.rng[item.playerId]() < link.lossRate;
      if (lost) {
        if (item.reliable) {
          // 模拟重传:一个额外 RTT 后再次到达
          item.attempts++;
          item.deliverAt = nowMs + Math.max(1, Math.round(link.baseLatencyMs * 2));
          this.insert(item);
        }
        continue;
      }
      if (item.direction === 'up') this.toRoom(item.msg as ClientToRoom);
      else this.toClient(item.playerId, item.msg as RoomToClient);
      delivered++;
    }
    return delivered;
  }

  disconnect(playerId: number): void {
    this.links[playerId].disconnected = true;
    // 在途消息:可靠的停车,不可靠的丢弃
    const keep: InFlight[] = [];
    for (const item of this.queue) {
      if (item.playerId !== playerId) {
        keep.push(item);
        continue;
      }
      if (item.reliable) this.parked.push(item);
    }
    this.queue = keep;
  }

  reconnect(playerId: number): void {
    this.links[playerId].disconnected = false;
    const pending = this.parked.splice(0, this.parked.length);
    for (const item of pending) {
      if (item.playerId !== playerId) {
        this.parked.push(item);
        continue;
      }
      item.deliverAt = this.now + this.transitMs(playerId);
      item.attempts = 1;
      this.insert(item);
    }
  }

  get inFlight(): number {
    return this.queue.length + this.parked.length;
  }
}
