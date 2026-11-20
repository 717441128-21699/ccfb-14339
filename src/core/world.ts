/**
 * 确定性锁步模拟:单位、命令执行、移动分离、战斗与状态哈希。
 *
 * 性能目标:2000 单位每帧逻辑 < 8ms。热路径使用扁平数组 + 每帧重建的
 * 链表式空间分桶,避免每帧分配对象。
 */

import { deriveSeed, fp, fpClamp, isqrt, mulberry32, RollingHash } from './fixed';
import { GameMap } from './map';
import { OrderType } from './types';
import type { Order, PlayerFrameSlot } from './types';

export class Unit {
  readonly id: number;
  readonly owner: number;
  readonly kind: number; // 0 近战 1 远程
  x: number;
  y: number;
  hp: number;
  readonly maxHp: number;
  readonly radius: number;
  readonly speed: number; // Q8 / 帧
  readonly range: number; // Q8
  readonly damage: number;
  readonly attackInterval: number; // 帧
  cd = 0;
  alive = true;
  /** 每帧期望速度(Q8),由 movement 阶段覆写 */
  vx = 0;
  vy = 0;

  // 当前命令(持续生效直到被新命令覆盖)
  orderType: OrderType = OrderType.Stop;
  ox = 0;
  oy = 0;
  targetId = 0;

  constructor(id: number, owner: number, kind: number, x: number, y: number) {
    this.id = id;
    this.owner = owner;
    this.kind = kind;
    this.x = x;
    this.y = y;
    if (kind === 0) {
      this.maxHp = 120;
      this.radius = fp(0.45);
      this.speed = fp(1.3);
      this.range = fp(1.1);
      this.damage = 12;
      this.attackInterval = 20;
    } else {
      this.maxHp = 80;
      this.radius = fp(0.4);
      this.speed = fp(1.1);
      this.range = fp(5.2);
      this.damage = 8;
      this.attackInterval = 28;
    }
    this.hp = this.maxHp;
  }

  /** 命令是否已执行完(供掉线 AI 判断接管时机) */
  isIdle(byId: Unit[]): boolean {
    if (this.orderType === OrderType.Stop) return true;
    if (this.orderType === OrderType.Move) {
      const dx = this.ox - this.x;
      const dy = this.oy - this.y;
      return dx * dx + dy * dy <= fp(0.3) * fp(0.3);
    }
    const t = byId[this.targetId];
    return !t || !t.alive;
  }
}

export interface WorldConfig {
  playerCount: number;
  unitsPerPlayer: number;
}

export class World {
  frame = 0;
  readonly map: GameMap;
  readonly units: Unit[] = [];
  /** id 稠密,直接下标取用 */
  readonly byId: Unit[] = [];
  readonly playerCount: number;
  private readonly rand: () => number;
  /** 世界内单位 id 计数:每个世界独立从 1 开始,保证同种子重建结果一致 */
  private idCounter = 0;

  // 空间分桶(每帧重建)
  private head: Int32Array;
  private next: Int32Array;
  private readonly cellSize: number;

  constructor(map: GameMap, seed: number, cfg: WorldConfig) {
    this.map = map;
    this.playerCount = cfg.playerCount;
    this.cellSize = map.cellSize;
    // 初始化为空链表(-1);否则默认 0 会让未建桶的索敌访问野指针
    this.head = new Int32Array(map.cols * map.rows).fill(-1);
    this.next = new Int32Array(0);
    this.rand = mulberry32(deriveSeed(seed, 77));
    this.spawn(cfg.unitsPerPlayer);
  }

  get cols(): number {
    return this.map.cols;
  }

  get rows(): number {
    return this.map.rows;
  }

  private spawn(unitsPerPlayer: number): void {
    const { map } = this;
    for (let p = 0; p < this.playerCount; p++) {
      // 两队:偶数玩家在左侧,奇数在右侧;多人时按纵向条带分配
      const fromLeft = p % 2 === 0;
      const baseX = fromLeft ? fp(6) : map.width - fp(6);
      const band = map.height / Math.max(1, Math.ceil(this.playerCount / 2));
      const bandIndex = p >> 1;
      const baseY = band * bandIndex + band / 2;
      for (let i = 0; i < unitsPerPlayer; i++) {
        const kind = i % 3 === 0 ? 1 : 0;
        const jitterX = fp((this.rand() - 0.5) * 6);
        const jitterY = fp((this.rand() - 0.5) * 6);
        const col = i % 32;
        const row = (i / 32) | 0;
        const x = fpClamp(baseX + jitterX + (fromLeft ? col * fp(0.8) : -col * fp(0.8)), fp(1), map.width - fp(1));
        const y = fpClamp(baseY + jitterY + row * fp(0.8), fp(1), map.height - fp(1));
        const u = new Unit(++this.idCounter, p, kind, x, y);
        this.units.push(u);
        this.byId[u.id] = u;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 每帧入口
  // -------------------------------------------------------------------------

  step(slots: PlayerFrameSlot[]): void {
    this.applyOrders(slots);
    this.rebuildGrid();
    this.movement();
    this.combat();
    this.frame++;
  }

  private applyOrders(slots: PlayerFrameSlot[]): void {
    for (const slot of slots) {
      for (const entry of slot.orders) {
        const u = this.byId[entry.unitId];
        // 模拟层二次鉴权:房间已校验过,这里防内部调用出错
        if (!u || !u.alive || u.owner !== slot.playerId) continue;
        const o: Order = entry.order;
        u.orderType = o.type;
        u.ox = o.x;
        u.oy = o.y;
        u.targetId = o.targetId;
      }
    }
  }

  private rebuildGrid(): void {
    const n = this.units.length;
    if (this.next.length < n) this.next = new Int32Array(n);
    this.head.fill(-1);
    for (let i = 0; i < n; i++) {
      const u = this.units[i];
      if (!u.alive) continue;
      const c = this.map.cellIndex(u.x, u.y);
      this.next[i] = this.head[c];
      this.head[c] = i;
    }
  }

  private forEachNear(x: number, y: number, radiusCells: number, fn: (u: Unit) => void): void {
    const { cols, rows } = this;
    const cx = (x / this.cellSize) | 0;
    const cy = (y / this.cellSize) | 0;
    const x0 = Math.max(0, cx - radiusCells);
    const x1 = Math.min(cols - 1, cx + radiusCells);
    const y0 = Math.max(0, cy - radiusCells);
    const y1 = Math.min(rows - 1, cy + radiusCells);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        let idx = this.head[gy * cols + gx];
        while (idx !== -1) {
          fn(this.units[idx]);
          idx = this.next[idx];
        }
      }
    }
  }

  private movement(): void {
    const units = this.units;
    // 1. 期望速度(朝向命令目标)
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u.alive) continue;
      if (u.cd > 0) u.cd--;

      let tx = u.x;
      let ty = u.y;
      let moving = false;
      if (u.orderType === OrderType.Move) {
        tx = u.ox;
        ty = u.oy;
        moving = true;
      } else if (u.orderType === OrderType.Attack) {
        const t = this.byId[u.targetId];
        if (t && t.alive) {
          tx = t.x;
          ty = t.y;
          const dx = tx - u.x;
          const dy = ty - u.y;
          const dist = isqrt(dx * dx + dy * dy);
          // 进入射程就站住
          moving = dist > u.range + t.radius;
        }
      }
      if (!moving) {
        u.vx = 0;
        u.vy = 0;
        continue;
      }
      const dx = tx - u.x;
      const dy = ty - u.y;
      const dist = isqrt(dx * dx + dy * dy);
      if (dist <= fp(0.3)) {
        u.vx = 0;
        u.vy = 0;
        continue;
      }
      const step = Math.min(u.speed, dist);
      // 整数除法保证跨平台一致
      u.vx = Math.round((dx * step) / dist);
      u.vy = Math.round((dy * step) / dist);
    }

    // 2. 分离:同格及相邻格重叠单位互相推开(单位按 id 顺序,结果确定)
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u.alive) continue;
      this.forEachNear(u.x, u.y, 1, (other) => {
        if (other.id <= u.id || !other.alive) return;
        const dx = other.x - u.x;
        const dy = other.y - u.y;
        const minDist = u.radius + other.radius;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minDist * minDist) return;
        if (d2 === 0) {
          // 完全重叠:沿 id 奇偶确定方向错开,避免抖动
          const push = minDist >> 1;
          const dir = (u.id & 1) === 0 ? 1 : -1;
          u.x -= push * dir;
          other.x += push * dir;
          return;
        }
        const dist = isqrt(d2);
        const overlap = minDist - dist;
        const half = overlap >> 1;
        u.x -= Math.round((dx * half) / dist);
        u.y -= Math.round((dy * half) / dist);
        other.x += Math.round((dx * half) / dist);
        other.y += Math.round((dy * half) / dist);
      });
    }

    // 3. 积分 + 障碍滑动 + 边界
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u.alive) continue;
      const nx = u.x + u.vx;
      const ny = u.y + u.vy;
      if (!this.map.hitsObstacle(nx, ny, u.radius)) {
        u.x = nx;
        u.y = ny;
      } else if (!this.map.hitsObstacle(nx, u.y, u.radius)) {
        u.x = nx; // 只滑 x
      } else if (!this.map.hitsObstacle(u.x, ny, u.radius)) {
        u.y = ny; // 只滑 y
      }
      const [cx, cy] = this.map.clampToBounds(u.x, u.y, u.radius);
      u.x = cx;
      u.y = cy;
    }
  }

  private combat(): void {
    const units = this.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u.alive || u.orderType !== OrderType.Attack || u.cd > 0) continue;
      const t = this.byId[u.targetId];
      if (!t || !t.alive || t.owner === u.owner) continue;
      const dx = t.x - u.x;
      const dy = t.y - u.y;
      const reach = u.range + t.radius;
      if (dx * dx + dy * dy <= u.range * u.range + ((reach * reach) >> 4)) {
        t.hp -= u.damage;
        u.cd = u.attackInterval;
        if (t.hp <= 0) t.alive = false;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 掉线 AI 与测试用查询
  // -------------------------------------------------------------------------

  /** 查找附近最近的敌方单位(分桶限定范围,id 小者平局优先,保证确定) */
  findNearestEnemy(x: number, y: number, owner: number, maxRange: number): Unit | null {
    let best: Unit | null = null;
    let bestD2 = maxRange * maxRange;
    this.forEachNear(x, y, 4, (u) => {
      if (!u.alive || u.owner === owner) return;
      const dx = u.x - x;
      const dy = u.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2 || (d2 === bestD2 && best !== null && u.id < best.id)) {
        bestD2 = d2;
        best = u;
      }
    });
    return best;
  }

  aliveCount(owner?: number): number {
    let n = 0;
    for (const u of this.units) if (u.alive && (owner === undefined || u.owner === owner)) n++;
    return n;
  }

  /** 世界状态校验和:帧号 + 每个存活单位的关键状态(按 id 顺序) */
  hash(): number {
    const h = new RollingHash();
    h.pushInt(this.frame);
    for (const u of this.units) {
      if (!u.alive) continue;
      h.pushInt(u.id).pushInt(u.x).pushInt(u.y).pushInt(u.hp);
      h.pushInt(u.orderType).pushInt(u.targetId).pushInt(u.ox).pushInt(u.oy);
    }
    return h.value();
  }
}
