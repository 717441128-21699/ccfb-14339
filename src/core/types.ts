/**
 * 共享类型与线协议定义。
 *
 * 约定:
 * - 模拟坐标全部为 Q8 定点整数(1 逻辑单位 = 256),模拟内禁止使用浮点,
 *   保证不同机器/浏览器上的逐帧确定性。
 * - 帧号(frame)从 0 开始单调递增,帧长 FRAME_MS。
 * - 同一局内所有玩家看到的 FrameBundle 字节级一致(指令数组按玩家序号排序)。
 */

// ---------------------------------------------------------------------------
// 基础常量
// ---------------------------------------------------------------------------

/** 逻辑帧长:20Hz,一帧 50ms */
export const FRAME_MS = 50;

/** Q8 定点缩放:1 逻辑单位对应的定点数 */
export const FP = 256;

/** 指令类型 */
export const OrderType = {
  Move: 1,
  Attack: 2,
  Stop: 3
} as const;

export type OrderType = (typeof OrderType)[keyof typeof OrderType];

// ---------------------------------------------------------------------------
// 指令 / 帧
// ---------------------------------------------------------------------------

export interface Vec2 {
  x: number;
  y: number;
}

/** 单个单位的一条命令 */
export interface Order {
  type: OrderType;
  /** Move:目的地;Attack:目标单位坐标的冗余快照(权威判定仍以 targetId 为准) */
  x: number;
  y: number;
  /** Attack 目标单位 id,其余类型为 0 */
  targetId: number;
}

/**
 * 玩家在某一帧提交的一批指令。
 * targetFrame 由房间权威指定,客户端建议值可能被房间改写。
 */
export interface CommandBatch {
  playerId: number;
  seq: number;
  targetFrame: number;
  /** unitId -> 命令;同一单位每帧至多一条,后到覆盖先到 */
  orders: Array<{ unitId: number; order: Order }>;
}

/** 每个玩家在一帧内的槽位(空数组 = 该帧无输入,可能是补空) */
export interface PlayerFrameSlot {
  playerId: number;
  orders: Array<{ unitId: number; order: Order }>;
  /** true 表示房间等待超时后替该玩家补的空指令 */
  backfilled: boolean;
}

/** 房间广播的帧包:收齐(或补齐)所有人后整体发出 */
export interface FrameBundle {
  frame: number;
  /** 按 playerId 升序,槽位数量恒等于房间人数 */
  slots: PlayerFrameSlot[];
  /** 该帧关闭时各玩家的输入延迟(帧),用于客户端 UI/幽灵预览 */
  delays: number[];
  /** 该帧生效的掉线接管事件 */
  drops: number[];
}

// ---------------------------------------------------------------------------
// 房间 -> 客户端的控制事件
// ---------------------------------------------------------------------------

export type RoomEvent =
  | { kind: 'rejected'; reason: string; command: CommandBatch }
  | { kind: 'script-flag'; playerId: number; reason: string; at: number }
  | { kind: 'player-dropped'; playerId: number; frame: number; aiTakeover: boolean }
  | { kind: 'delay-change'; playerId: number; oldDelay: number; newDelay: number; frame: number }
  | { kind: 'backfill'; playerId: number; frame: number }
  | { kind: 'hash-mismatch'; playerId: number; frame: number; expected: number; got: number };

// ---------------------------------------------------------------------------
// 链路质量 / 玩家状态
// ---------------------------------------------------------------------------

export interface LinkConfig {
  /** 单向基础延迟 ms */
  baseLatencyMs: number;
  /** 额外抖动幅度 ms(均匀分布 ±jitterMs) */
  jitterMs: number;
  /** 0..1 的丢包率(可靠层会重传,只会增加有效 RTT) */
  lossRate: number;
  /** 链路断开:true 时消息全部挂起,直到恢复 */
  disconnected: boolean;
}

export interface PlayerNetStats {
  playerId: number;
  rttEwmaMs: number;
  rttLatestMs: number;
  jitterMs: number;
  delayFrames: number;
  targetDelayFrames: number;
  connected: boolean;
  dropped: boolean;
  aiControlled: boolean;
  backfillCount: number;
  scriptFlags: number;
}

// ---------------------------------------------------------------------------
// 线程间消息(主线程 <-> Worker 内的房间服务)
// ---------------------------------------------------------------------------

export type ClientToRoom =
  | { kind: 'hello'; playerId: number }
  | { kind: 'command'; batch: CommandBatch }
  | { kind: 'frame-ack'; playerId: number; frame: number }
  | { kind: 'pong'; playerId: number; pingSentAt: number; nonce: number }
  | { kind: 'hash'; playerId: number; frame: number; hash: number }
  | { kind: 'set-link'; playerId: number; link: Partial<LinkConfig> }
  | { kind: 'disconnect-player'; playerId: number }
  | { kind: 'reconnect-player'; playerId: number }
  | { kind: 'script-burst'; playerId: number };

export type RoomToClient =
  | { kind: 'welcome'; playerId: number; playerCount: number; seed: number; frameMs: number }
  | { kind: 'bundle'; bundle: FrameBundle }
  | { kind: 'event'; event: RoomEvent }
  | { kind: 'stats'; stats: PlayerNetStats[]; frame: number; roomTimeMs: number }
  | { kind: 'ping'; nonce: number; sentAt: number };
