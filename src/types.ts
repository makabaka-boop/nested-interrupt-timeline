export type TriggerMode = "edge" | "level";
export type EventType = "trigger" | "release" | "mask" | "unmask";

/** One of the 1..8 simulated interrupt lines. */
export interface LineConfig {
  /** Unique, non-empty line ID, for example IRQ0. */
  id: string;
  /** Larger numbers preempt smaller numbers. */
  priority: number;
  mode: TriggerMode;
  /** Number of ticks consumed by one handler invocation. */
  handlerTicks: number;
  /** Starts the replay in the masked state. */
  initiallyMasked?: boolean;
}

export interface ReplayConfig {
  lines: LineConfig[];
  /** Absolute replay length. Tick labels are 0..maxTicks-1; capped at 500. */
  maxTicks: number;
}

export interface InterruptEvent {
  tick: number;
  lineId: string;
  type: EventType;
  /** Optional stable identifier. Generated as E001 when omitted. */
  id?: string;
}

export type ActionKind = "enter" | "preempt" | "resume" | "complete";
export type LineModeEventType = EventType;

export interface ReplayAction {
  kind: ActionKind;
  tick: number;
  lineId: string;
  /** Unique invocation instance for a handler frame. */
  invocationId: string;
  /** Handler that was suspended by a preempt action. */
  preemptedLine?: string;
  /** Remaining ticks at the moment this action was emitted. */
  remaining: number;
}

export interface AppliedEventRecord {
  eventId: string;
  tick: number;
  lineId: string;
  type: EventType;
  /**
   * For an edge trigger:
   *  - latched-new: no pending bit existed and one was retained
   *  - coalesced: another edge was already pending
   *  - armed-active: edge was latched while the same handler was active
   * Level trigger/release use asserted / released; mask changes use those values.
   */
  effect:
    | "latched-new"
    | "coalesced"
    | "armed-active"
    | "asserted"
    | "already-asserted"
    | "released"
    | "not-asserted"
    | "masked"
    | "already-masked"
    | "unmasked"
    | "already-unmasked";
}

export interface PendingEvidence {
  lineId: string;
  masked: boolean;
  mode: TriggerMode;
  /** Edge latched bit, or level line currently asserted. */
  latched: boolean;
  /** Physical line level remains asserted (level mode only semantics). */
  asserted: boolean;
  /** This line currently has an active handler frame somewhere in the stack. */
  active: boolean;
  /** Hardware has a pending condition (edge bit or asserted level). */
  pending: boolean;
  /** Pending can be selected by the scheduler. */
  runnable: boolean;
  /** Pending but not selected/running yet. */
  waiting: boolean;
  /** Absolute tick at which the current waiting condition was created. */
  waitingSince: number | null;
  reason:
    | "none"
    | "edge-latched"
    | "level-asserted"
    | "masked"
    | "active-same-line"
    | "preempted"
    | "lower-priority"
    | "same-priority-fifo"
    | "higher-priority-running";
  /** Number of trigger pulses merged into the current edge pending bit. */
  edgePulseCount: number;
}

export interface StackFrame {
  lineId: string;
  invocationId: string;
  priority: number;
  remaining: number;
  state: "running" | "preempted";
  enteredAt: number;
}

export interface TickTrace {
  tick: number;
  /** Snapshot before this tick's events are applied. */
  pendingBefore: PendingEvidence[];
  events: AppliedEventRecord[];
  /** Snapshot after events, before completion/dispatch. */
  pendingAfterEvents: PendingEvidence[];
  actions: ReplayAction[];
  /** Snapshot and execution stack at the end of the tick. */
  pending: PendingEvidence[];
  stack: StackFrame[];
  /** Line ID of the frame executing during this tick, if any. */
  runningLineId: string | null;
}

export interface ReplayResult {
  config: ReplayConfig;
  traces: TickTrace[];
  events: InterruptEvent[];
}
