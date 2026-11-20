/**
 * 房间侧指令校验与脚本行为检测。
 *
 * 校验项:
 * 1. 身份:指令只能操作自己拥有的存活单位;
 * 2. 时序:seq 严格递增、targetFrame 落在房间允许窗口内;
 * 3. 频度(人手极限):
 *    - 滑动窗口内动作(批)数量超阈值,且连续两个窗口超标 -> 脚本;
 *    - 单个单位在窗口内被反复下令的比例异常 -> 微操机器人;
 *    - 单帧指令条数硬上限(框选全员合法,但不可能超过自身单位总数)。
 *
 * 校验失败只拒绝该批并产生 rejected 事件;脚本标记是独立事件,
 * 不直接中断对局(处置策略留给上层)。
 */

import type { CommandBatch } from '../core/types';
import { Unit, World } from '../core/world';

/** 3 秒窗口(20Hz) */
export const RATE_WINDOW_FRAMES = 60;
/** 窗口内动作批上限:约 8 次/秒,已高于职业选手瞬时峰值 */
const MAX_BATCHES_PER_WINDOW = 24;
/** 连续多少个窗口超标才标记(容忍一次爆发) */
const FLAG_AFTER_WINDOWS = 2;
/** 单个单位窗口内被下令帧数上限 */
const MAX_UNIT_ORDER_FRAMES = 30;
/** targetFrame 允许领先房间帧的最大幅度 */
const MAX_FRAME_AHEAD = 24;

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  scriptFlag?: string;
}

interface PlayerRateState {
  lastSeq: number;
  /** 最近动作所在帧(滚动窗口) */
  batchFrames: number[];
  /** unitId -> 窗口内被下令的帧列表 */
  unitFrames: Map<number, number[]>;
  hotWindows: number;
  flags: number;
}

export class CommandValidator {
  private readonly rates = new Map<number, PlayerRateState>();
  private readonly world: World;
  private readonly playerCount: number;

  constructor(world: World, playerCount: number) {
    this.world = world;
    this.playerCount = playerCount;
  }

  private state(playerId: number): PlayerRateState {
    let s = this.rates.get(playerId);
    if (!s) {
      s = { lastSeq: -1, batchFrames: [], unitFrames: new Map(), hotWindows: 0, flags: 0 };
      this.rates.set(playerId, s);
    }
    return s;
  }

  /** 测试钩子:直接注入一批动作时间戳,验证脚本标记链路 */
  injectScriptBurst(playerId: number, frame: number): string {
    const s = this.state(playerId);
    for (let k = 0; k < MAX_BATCHES_PER_WINDOW + 6; k++) s.batchFrames.push(frame - k);
    s.hotWindows = FLAG_AFTER_WINDOWS;
    s.flags++;
    return `动作频率 ${s.batchFrames.length} 批/${RATE_WINDOW_FRAMES} 帧,超过人手极限 ${MAX_BATCHES_PER_WINDOW}`;
  }

  validate(batch: CommandBatch, roomFrame: number, internalAi = false): ValidationResult {
    const { playerId } = batch;
    if (playerId < 0 || playerId >= this.playerCount) {
      return { ok: false, reason: `未知玩家 ${playerId}` };
    }
    const s = this.state(playerId);

    // --- 时序校验 ---
    if (batch.seq <= s.lastSeq) {
      return { ok: false, reason: `seq 回退/重复:${batch.seq} <= ${s.lastSeq}` };
    }
    if (batch.targetFrame < roomFrame) {
      return { ok: false, reason: `目标帧 ${batch.targetFrame} 已过期(当前 ${roomFrame})` };
    }
    if (batch.targetFrame > roomFrame + MAX_FRAME_AHEAD) {
      return { ok: false, reason: `目标帧过于超前:${batch.targetFrame}` };
    }

    // --- 归属与内容校验 ---
    const seenUnits = new Set<number>();
    let owned = 0;
    for (const e of batch.orders) {
      if (seenUnits.has(e.unitId)) {
        return { ok: false, reason: '同一单位单帧多条指令' };
      }
      seenUnits.add(e.unitId);
      const u: Unit | undefined = this.world.byId[e.unitId];
      if (!u) return { ok: false, reason: `单位 ${e.unitId} 不存在` };
      if (!u.alive) return { ok: false, reason: `单位 ${e.unitId} 已阵亡` };
      if (u.owner !== playerId) {
        return { ok: false, reason: `越权操作:单位 ${e.unitId} 属于玩家 ${u.owner}` };
      }
      owned++;
    }
    if (owned > this.world.aliveCount(playerId)) {
      return { ok: false, reason: '指令数超过拥有的单位数' };
    }

    // --- 频度检测(房间自身的 AI 流量豁免,但仍做上面的归属校验) ---
    let scriptFlag: string | undefined;
    if (!internalAi) {
      this.prune(s, roomFrame);
      s.batchFrames.push(roomFrame);
      for (const unitId of seenUnits) {
        let arr = s.unitFrames.get(unitId);
        if (!arr) {
          arr = [];
          s.unitFrames.set(unitId, arr);
        }
        arr.push(roomFrame);
      }

      if (s.batchFrames.length > MAX_BATCHES_PER_WINDOW) {
        s.hotWindows++;
        if (s.hotWindows >= FLAG_AFTER_WINDOWS) {
          scriptFlag = `持续高频操作:${s.batchFrames.length} 批/${RATE_WINDOW_FRAMES} 帧,阈值 ${MAX_BATCHES_PER_WINDOW}`;
          s.flags++;
          s.hotWindows = 0;
        }
      } else {
        s.hotWindows = 0;
      }
      if (!scriptFlag) {
        for (const [unitId, arr] of s.unitFrames) {
          if (arr.length > MAX_UNIT_ORDER_FRAMES) {
            scriptFlag = `单位 ${unitId} 在 ${RATE_WINDOW_FRAMES} 帧内被下令 ${arr.length} 次,疑似微操脚本`;
            s.flags++;
            break;
          }
        }
      }
    }

    s.lastSeq = batch.seq;
    return scriptFlag ? { ok: true, scriptFlag } : { ok: true };
  }

  flagCount(playerId: number): number {
    return this.rates.get(playerId)?.flags ?? 0;
  }

  private prune(s: PlayerRateState, frame: number): void {
    const cutoff = frame - RATE_WINDOW_FRAMES;
    while (s.batchFrames.length && s.batchFrames[0] < cutoff) s.batchFrames.shift();
    for (const [id, arr] of s.unitFrames) {
      while (arr.length && arr[0] < cutoff) arr.shift();
      if (arr.length === 0) s.unitFrames.delete(id);
    }
  }
}
