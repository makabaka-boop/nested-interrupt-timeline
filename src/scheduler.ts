import type {
  AppliedEventRecord,
  EventType,
  InterruptEvent,
  LineConfig,
  PendingEvidence,
  ReplayAction,
  ReplayConfig,
  ReplayResult,
  StackFrame,
  TickTrace,
} from "./types";

export class ReplayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayValidationError";
  }
}

interface RuntimeLine {
  config: LineConfig;
  order: number;
  masked: boolean;
  /** Edge: retained pending bit. Level: latched scheduling condition. */
  latched: boolean;
  /** Level physical line. Always false for edge lines. */
  asserted: boolean;
  active: boolean;
  /** Tick when the current non-active pending condition became schedulable/visible. */
  pendingSince: number | null;
  /** Merged pulses for the current edge bit. */
  edgePulseCount: number;
}

interface QueuedEvent extends InterruptEvent {
  eventId: string;
  insertion: number;
}

interface Candidate {
  line: RuntimeLine;
  pendingSince: number;
}

function assertFiniteInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new ReplayValidationError(`${name} must be a safe integer`);
  }
}

/** Validate a reusable configuration. The UI can call this before reset. */
export function validateConfig(config: ReplayConfig): void {
  if (!config || !Array.isArray(config.lines)) {
    throw new ReplayValidationError("config.lines must be an array");
  }
  if (config.lines.length < 1 || config.lines.length > 8) {
    throw new ReplayValidationError("configure between 1 and 8 interrupt lines");
  }
  if (!Number.isSafeInteger(config.maxTicks) || config.maxTicks < 1 || config.maxTicks > 500) {
    throw new ReplayValidationError("maxTicks must be an integer between 1 and 500");
  }

  const ids = new Set<string>();
  config.lines.forEach((line, index) => {
    if (!line || typeof line.id !== "string" || line.id.trim() === "") {
      throw new ReplayValidationError(`line ${index + 1} has an empty ID`);
    }
    if (ids.has(line.id)) {
      throw new ReplayValidationError(`duplicate line ID: ${line.id}`);
    }
    ids.add(line.id);
    assertFiniteInteger(line.priority, `priority for ${line.id}`);
    if (line.priority < 0 || line.priority > 999) {
      throw new ReplayValidationError(`priority for ${line.id} must be between 0 and 999`);
    }
    if (line.mode !== "edge" && line.mode !== "level") {
      throw new ReplayValidationError(`mode for ${line.id} must be edge or level`);
    }
    assertFiniteInteger(line.handlerTicks, `handlerTicks for ${line.id}`);
    if (line.handlerTicks < 1 || line.handlerTicks > 500) {
      throw new ReplayValidationError(`handlerTicks for ${line.id} must be between 1 and 500`);
    }
  });
}

export function validateEvents(events: readonly InterruptEvent[], config: ReplayConfig): void {
  const byId = new Map(config.lines.map((line) => [line.id, line]));
  const eventIds = new Set<string>();
  events.forEach((event, index) => {
    if (!event) {
      throw new ReplayValidationError(`event ${index + 1} is invalid`);
    }
    assertFiniteInteger(event.tick, `event ${index + 1} tick`);
    if (event.tick < 0 || event.tick >= config.maxTicks) {
      throw new ReplayValidationError(
        `event ${index + 1} tick ${event.tick} is outside 0..${config.maxTicks - 1}`,
      );
    }
    if (!byId.has(event.lineId)) {
      throw new ReplayValidationError(`event ${index + 1} references unknown line ${event.lineId}`);
    }
    if (!["trigger", "release", "mask", "unmask"].includes(event.type)) {
      throw new ReplayValidationError(`event ${index + 1} has unknown type ${String(event.type)}`);
    }
    if (event.type === "release" && byId.get(event.lineId)?.mode === "edge") {
      throw new ReplayValidationError(`edge line ${event.lineId} cannot receive a release event`);
    }
    if (event.id !== undefined) {
      if (eventIds.has(event.id)) {
        throw new ReplayValidationError(`duplicate event ID: ${event.id}`);
      }
      eventIds.add(event.id);
    }
  });
}

/**
 * Deterministic, hardware-free interrupt replay state machine.
 *
 * Event application and completion happen at the start of a tick. A handler
 * dispatched during a tick executes that tick; completion is observed at the
 * start of a later tick. Therefore handlerTicks=1 enters at tick t and the
 * completion action is emitted at tick t+1.
 */
export class ReplayController {
  private readonly config: ReplayConfig;
  private readonly lines: RuntimeLine[];
  private readonly lineById = new Map<string, RuntimeLine>();
  private queue: QueuedEvent[] = [];
  private allEvents: QueuedEvent[] = [];
  private traces: TickTrace[] = [];
  private stack: StackFrame[] = [];
  private currentTick = 0;
  private insertionCounter = 0;
  private invocationCounter = 0;

  constructor(config: ReplayConfig, initialEvents: readonly InterruptEvent[] = []) {
    validateConfig(config);
    validateEvents(initialEvents, config);
    this.config = config;
    this.lines = config.lines.map((line, order) => ({
      config: line,
      order,
      masked: line.initiallyMasked === true,
      latched: false,
      asserted: false,
      active: false,
      pendingSince: null,
      edgePulseCount: 0,
    }));
    this.lines.forEach((line) => this.lineById.set(line.config.id, line));
    initialEvents.forEach((event) => this.enqueue(event));
  }

  get tick(): number {
    return this.currentTick;
  }

  get finished(): boolean {
    return this.currentTick >= this.config.maxTicks;
  }

  get result(): ReplayResult {
    return {
      config: this.config,
      traces: this.traces.map((trace) => clone(trace)),
      events: this.allEvents
        .slice()
        .sort(compareQueuedEvents)
        .map(({ eventId: _eventId, insertion: _insertion, ...event }) => clone(event)),
    };
  }

  /** Add one or more events while replaying. Their tick may equal the current tick. */
  addEvents(events: readonly InterruptEvent[]): void {
    validateEvents(events, this.config);
    for (const event of events) {
      if (event.tick < this.currentTick) {
        throw new ReplayValidationError(
          `cannot enqueue event at ${event.tick}; replay has already reached ${this.currentTick}`,
        );
      }
      this.enqueue(event);
    }
  }

  advance(ticks = 1): TickTrace[] {
    if (!Number.isSafeInteger(ticks) || ticks < 1) {
      throw new ReplayValidationError("ticks to advance must be a positive integer");
    }
    const output: TickTrace[] = [];
    const target = Math.min(this.config.maxTicks, this.currentTick + ticks);
    while (this.currentTick < target) {
      const trace = this.step();
      this.traces.push(trace);
      output.push(trace);
    }
    return output;
  }

  static run(config: ReplayConfig, events: readonly InterruptEvent[] = []): ReplayResult {
    const controller = new ReplayController(config, events);
    controller.advance(config.maxTicks);
    return controller.result;
  }

  private enqueue(event: InterruptEvent): void {
    const insertion = this.insertionCounter++;
    const eventId = event.id ?? `E${String(insertion + 1).padStart(3, "0")}`;
    if (this.queue.some((queued) => queued.eventId === eventId)) {
      throw new ReplayValidationError(`duplicate event ID: ${eventId}`);
    }
    this.queue.push({ ...event, id: eventId, eventId, insertion });
    this.allEvents.push({ ...event, id: eventId, eventId, insertion });
    this.queue.sort(compareQueuedEvents);
  }

  private step(): TickTrace {
    const tick = this.currentTick;
    const pendingBefore = this.snapshot();
    const events: AppliedEventRecord[] = [];

    const due = this.queue.filter((event) => event.tick === tick);
    this.queue = this.queue.filter((event) => event.tick !== tick);
    for (const event of due) {
      events.push(this.applyEvent(event, tick));
    }

    const pendingAfterEvents = this.snapshot();
    const actions: ReplayAction[] = [];

    // Completion from work done during the previous tick happens before new dispatch.
    this.completeTop(tick, actions);

    // At most one frame can enter/preempt during a tick. A resumed frame is
    // the same scheduler decision and is emitted together when appropriate.
    this.dispatch(tick, actions);

    const trace: TickTrace = {
      tick,
      pendingBefore,
      events,
      pendingAfterEvents,
      actions,
      pending: this.snapshot(),
      stack: clone(this.stack),
      runningLineId: this.stack.at(-1)?.lineId ?? null,
    };

    // Every currently selected top frame executes one tick of work.
    const top = this.stack.at(-1);
    if (top) {
      top.remaining -= 1;
    }
    this.currentTick += 1;
    return trace;
  }

  private applyEvent(event: QueuedEvent, tick: number): AppliedEventRecord {
    const line = this.lineById.get(event.lineId);
    if (!line) {
      throw new ReplayValidationError(`unknown line ${event.lineId}`);
    }
    const effect = this.eventEffect(line, event.type, tick);
    return {
      eventId: event.eventId,
      tick,
      lineId: line.config.id,
      type: event.type,
      effect,
    };
  }

  private eventEffect(line: RuntimeLine, type: EventType, tick: number): AppliedEventRecord["effect"] {
    if (type === "mask") {
      if (line.masked) return "already-masked";
      line.masked = true;
      return "masked";
    }
    if (type === "unmask") {
      if (!line.masked) return "already-unmasked";
      line.masked = false;
      // An edge bit remains retained. A level line's time is based on the
      // original assertion, so it keeps that FIFO timestamp while masked.
      return "unmasked";
    }

    if (line.config.mode === "edge") {
      if (type !== "trigger") {
        throw new ReplayValidationError(`edge line ${line.config.id} only accepts trigger`);
      }
      line.edgePulseCount += 1;
      if (line.latched) return "coalesced";
      line.latched = true;
      // A pulse during the same handler is retained for re-entry after return.
      if (!line.active) line.pendingSince = tick;
      return line.active ? "armed-active" : "latched-new";
    }

    if (type === "release") {
      const wasAsserted = line.asserted;
      line.asserted = false;
      if (!line.active) {
        line.latched = false;
        line.pendingSince = null;
      }
      return wasAsserted ? "released" : "not-asserted";
    }

    // Level trigger/assert.
    if (line.asserted) return "already-asserted";
    line.asserted = true;
    if (!line.active) {
      line.latched = true;
      line.pendingSince = tick;
    }
    return "asserted";
  }

  private completeTop(tick: number, actions: ReplayAction[]): void {
    const top = this.stack.at(-1);
    if (!top || top.remaining > 0) return;

    const line = this.lineById.get(top.lineId);
    if (!line) throw new Error(`runtime line missing: ${top.lineId}`);
    line.active = false;
    this.stack.pop();
    actions.push({
      kind: "complete",
      tick,
      lineId: line.config.id,
      invocationId: top.invocationId,
      remaining: 0,
    });

    if (line.config.mode === "edge") {
      if (line.latched && !line.masked) {
        line.pendingSince = tick;
      }
    } else if (line.asserted) {
      // Held level is immediately eligible for another invocation.
      line.latched = true;
      line.pendingSince = tick;
    } else {
      line.latched = false;
      line.pendingSince = null;
    }
  }

  private dispatch(tick: number, actions: ReplayAction[]): void {
    const candidate = this.selectCandidate();
    if (!candidate) {
      if (this.stack.length > 0) {
        const top = this.stack.at(-1);
        if (top && top.state === "preempted") {
          top.state = "running";
          actions.push({
            kind: "resume",
            tick,
            lineId: top.lineId,
            invocationId: top.invocationId,
            remaining: top.remaining,
          });
        }
      }
      return;
    }

    const current = this.stack.at(-1);
    if (current && candidate.line.config.priority <= current.priority) {
      // Same priority waits by pending moment then ID; lower priority cannot enter.
      if (current.state === "preempted") {
        current.state = "running";
        actions.push({
          kind: "resume",
          tick,
          lineId: current.lineId,
          invocationId: current.invocationId,
          remaining: current.remaining,
        });
      }
      return;
    }

    if (this.stack.length > 0) {
      const suspended = this.stack.at(-1);
      if (suspended) {
        if (suspended.state === "preempted") {
          // The just-completed handler was nested; its caller first gets its
          // normal resume action, even when a different high-priority line then
          // preempts it in the same scheduling decision.
          suspended.state = "running";
          actions.push({
            kind: "resume",
            tick,
            lineId: suspended.lineId,
            invocationId: suspended.invocationId,
            remaining: suspended.remaining,
          });
        }
        suspended.state = "preempted";
        actions.push({
          kind: "preempt",
          tick,
          lineId: suspended.lineId,
          invocationId: suspended.invocationId,
          preemptedLine: suspended.lineId,
          remaining: suspended.remaining,
        });
      }
    }

    this.enterCandidate(candidate, tick, actions);
  }

  private selectCandidate(): Candidate | null {
    const selected: Candidate[] = [];
    for (const line of this.lines) {
      if (!line.latched || line.masked || line.active || line.pendingSince === null) continue;
      selected.push({ line, pendingSince: line.pendingSince });
    }
    if (selected.length === 0) return null;
    selected.sort((a, b) => {
      const priorityGap = b.line.config.priority - a.line.config.priority;
      if (priorityGap !== 0) return priorityGap;
      const timeGap = a.pendingSince - b.pendingSince;
      if (timeGap !== 0) return timeGap;
      // Same pending moment: deterministic ID tie-break, then configuration order.
      const byId = a.line.config.id.localeCompare(b.line.config.id);
      return byId !== 0 ? byId : a.line.order - b.line.order;
    });
    return selected[0] ?? null;
  }

  private enterCandidate(candidate: Candidate, tick: number, actions: ReplayAction[]): void {
    const line = candidate.line;
    this.invocationCounter += 1;
    const invocationId = `I${String(this.invocationCounter).padStart(3, "0")}`;
    const frame: StackFrame = {
      lineId: line.config.id,
      invocationId,
      priority: line.config.priority,
      remaining: line.config.handlerTicks,
      state: "running",
      enteredAt: tick,
    };
    line.latched = false;
    line.pendingSince = null;
    line.active = true;
    if (line.config.mode === "edge") line.edgePulseCount = 0;
    this.stack.push(frame);
    actions.push({
      kind: "enter",
      tick,
      lineId: line.config.id,
      invocationId,
      remaining: line.config.handlerTicks,
    });
  }

  private snapshot(): PendingEvidence[] {
    const top = this.stack.at(-1);
    return this.lines.map((line): PendingEvidence => {
      const pending = line.config.mode === "edge" ? line.latched : line.asserted;
      const active = line.active;
      const waiting = pending && !active && !(top?.lineId === line.config.id);
      let reason: PendingEvidence["reason"] = "none";
      if (pending) {
        if (line.masked) reason = "masked";
        else if (active) reason = "active-same-line";
        else if (top) {
          if (line.config.priority > top.priority) reason = "higher-priority-running";
          else if (line.config.priority === top.priority) reason = "same-priority-fifo";
          else reason = "lower-priority";
        } else {
          reason = line.config.mode === "edge" ? "edge-latched" : "level-asserted";
        }
      }
      return {
        lineId: line.config.id,
        masked: line.masked,
        mode: line.config.mode,
        latched: line.latched,
        asserted: line.asserted,
        active,
        pending,
        runnable: pending && !line.masked && !active,
        waiting,
        waitingSince: waiting ? line.pendingSince : null,
        reason,
        edgePulseCount: line.edgePulseCount,
      };
    });
  }
}

function compareQueuedEvents(a: QueuedEvent, b: QueuedEvent): number {
  return a.tick - b.tick || a.insertion - b.insertion;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
