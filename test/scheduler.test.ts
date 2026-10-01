import { describe, expect, it } from "vitest";
import { ReplayController, validateConfig } from "../src/scheduler";
import type {
  ActionKind,
  AppliedEventRecord,
  EventType,
  InterruptEvent,
  PendingEvidence,
  ReplayConfig,
  TickTrace,
  TriggerMode,
} from "../src/types";

interface RefLine {
  id: string;
  priority: number;
  mode: TriggerMode;
  ticks: number;
  order: number;
  masked: boolean;
  edgePending: boolean;
  level: boolean;
  inStack: boolean;
  since: number | null;
  pulses: number;
}

interface RefFrame {
  id: string;
  invocation: string;
  priority: number;
  remaining: number;
  suspended: boolean;
  enteredAt: number;
}

interface RefEvent extends InterruptEvent {
  eid: string;
  seq: number;
}

class ReferenceMachine {
  private lines: RefLine[];
  private events: RefEvent[] = [];
  private seq = 0;
  private invocations = 0;
  private stack: RefFrame[] = [];
  private readonly maxTicks: number;

  constructor(config: ReplayConfig, initial: InterruptEvent[]) {
    validateConfig(config);
    this.maxTicks = config.maxTicks;
    this.lines = config.lines.map((line, order) => ({
      id: line.id,
      priority: line.priority,
      mode: line.mode,
      ticks: line.handlerTicks,
      order,
      masked: line.initiallyMasked === true,
      edgePending: false,
      level: false,
      inStack: false,
      since: null,
      pulses: 0,
    }));
    initial.forEach((event) => this.add(event));
  }

  add(event: InterruptEvent): void {
    const seq = this.seq++;
    const eid = event.id ?? `E${String(seq + 1).padStart(3, "0")}`;
    this.events.push({ ...event, id: eid, eid, seq });
    this.events.sort((a, b) => a.tick - b.tick || a.seq - b.seq);
  }

  run(): TickTrace[] {
    return Array.from({ length: this.maxTicks }, (_, tick) => this.step(tick));
  }

  private find(id: string): RefLine {
    const line = this.lines.find((candidate) => candidate.id === id);
    if (!line) throw new Error(`missing line ${id}`);
    return line;
  }

  private step(tick: number): TickTrace {
    const before = this.evidence();
    const applied: AppliedEventRecord[] = [];
    const due = this.events.filter((event) => event.tick === tick);
    this.events = this.events.filter((event) => event.tick !== tick);
    for (const event of due) applied.push(this.apply(event, tick));
    const afterEvents = this.evidence();

    const kinds: ActionKind[] = [];
    const actions = [] as TickTrace["actions"];
    this.finishIfDue(tick, actions);
    this.schedule(tick, actions);

    for (const action of actions) kinds.push(action.kind);
    const trace: TickTrace = {
      tick,
      pendingBefore: before,
      events: applied,
      pendingAfterEvents: afterEvents,
      actions,
      pending: this.evidence(),
      stack: this.stack.map((frame) => ({
        lineId: frame.id,
        invocationId: frame.invocation,
        priority: frame.priority,
        remaining: frame.remaining,
        state: frame.suspended ? "preempted" : "running",
        enteredAt: frame.enteredAt,
      })),
      runningLineId: this.stack.at(-1)?.id ?? null,
    };
    const top = this.stack.at(-1);
    if (top) top.remaining -= 1;
    return trace;
  }

  private apply(event: RefEvent, tick: number): AppliedEventRecord {
    const line = this.find(event.lineId);
    let effect: AppliedEventRecord["effect"];
    switch (event.type) {
      case "mask":
        effect = line.masked ? "already-masked" : "masked";
        line.masked = true;
        break;
      case "unmask":
        effect = line.masked ? "unmasked" : "already-unmasked";
        line.masked = false;
        break;
      case "release":
        effect = line.level ? "released" : "not-asserted";
        line.level = false;
        if (!line.inStack) {
          line.edgePending = false;
          line.since = null;
        }
        break;
      case "trigger":
        if (line.mode === "edge") {
          line.pulses += 1;
          if (line.edgePending) {
            effect = "coalesced";
          } else {
            line.edgePending = true;
            effect = line.inStack ? "armed-active" : "latched-new";
            if (!line.inStack) line.since = tick;
          }
        } else if (line.level) {
          effect = "already-asserted";
        } else {
          line.level = true;
          effect = "asserted";
          if (!line.inStack) {
            line.edgePending = true;
            line.since = tick;
          }
        }
        break;
    }
    return {
      eventId: event.eid,
      tick,
      lineId: line.id,
      type: event.type,
      effect,
    };
  }

  private isPending(line: RefLine): boolean {
    return line.mode === "edge" ? line.edgePending : line.level;
  }

  private finishIfDue(tick: number, actions: TickTrace["actions"]): void {
    const top = this.stack.at(-1);
    if (!top || top.remaining !== 0) return;
    const line = this.find(top.id);
    line.inStack = false;
    this.stack.pop();
    actions.push({ kind: "complete", tick, lineId: line.id, invocationId: top.invocation, remaining: 0 });
    if (line.mode === "edge") {
      if (line.edgePending && !line.masked) line.since = tick;
    } else if (line.level) {
      line.edgePending = true;
      line.since = tick;
    } else {
      line.edgePending = false;
      line.since = null;
    }
  }

  private schedule(tick: number, actions: TickTrace["actions"]): void {
    const choices = this.lines
      .filter((line) => this.isPending(line) && !line.masked && !line.inStack && line.since !== null)
      .sort((a, b) => b.priority - a.priority || (a.since ?? 0) - (b.since ?? 0) || a.id.localeCompare(b.id) || a.order - b.order);
    const choice = choices[0];
    const top = this.stack.at(-1);

    if (!choice) {
      if (top?.suspended) {
        top.suspended = false;
        actions.push({ kind: "resume", tick, lineId: top.id, invocationId: top.invocation, remaining: top.remaining });
      }
      return;
    }

    if (top && choice.priority <= top.priority) {
      if (top.suspended) {
        top.suspended = false;
        actions.push({ kind: "resume", tick, lineId: top.id, invocationId: top.invocation, remaining: top.remaining });
      }
      return;
    }

    const caller = this.stack.at(-1);
    if (caller) {
      if (caller.suspended) {
        caller.suspended = false;
        actions.push({ kind: "resume", tick, lineId: caller.id, invocationId: caller.invocation, remaining: caller.remaining });
      }
      caller.suspended = true;
      actions.push({
        kind: "preempt",
        tick,
        lineId: caller.id,
        invocationId: caller.invocation,
        preemptedLine: caller.id,
        remaining: caller.remaining,
      });
    }

    this.invocations += 1;
    const invocation = `I${String(this.invocations).padStart(3, "0")}`;
    choice.inStack = true;
    choice.edgePending = false;
    choice.since = null;
    if (choice.mode === "edge") choice.pulses = 0;
    this.stack.push({
      id: choice.id,
      invocation,
      priority: choice.priority,
      remaining: choice.ticks,
      suspended: false,
      enteredAt: tick,
    });
    actions.push({ kind: "enter", tick, lineId: choice.id, invocationId: invocation, remaining: choice.ticks });
  }

  private evidence(): PendingEvidence[] {
    const top = this.stack.at(-1);
    return this.lines.map((line) => {
      const pending = this.isPending(line);
      let reason: PendingEvidence["reason"] = "none";
      if (pending) {
        if (line.masked) reason = "masked";
        else if (line.inStack) reason = "active-same-line";
        else if (top) {
          if (line.priority > top.priority) reason = "higher-priority-running";
          else if (line.priority === top.priority) reason = "same-priority-fifo";
          else reason = "lower-priority";
        } else reason = line.mode === "edge" ? "edge-latched" : "level-asserted";
      }
      return {
        lineId: line.id,
        masked: line.masked,
        mode: line.mode,
        latched: line.edgePending,
        asserted: line.level,
        active: line.inStack,
        pending,
        runnable: pending && !line.masked && !line.inStack,
        waiting: pending && !line.inStack && top?.id !== line.id,
        waitingSince: pending && !line.inStack && top?.id !== line.id ? line.since : null,
        reason,
        edgePulseCount: line.pulses,
      };
    });
  }
}

function compact(traces: TickTrace[]) {
  return traces.map((trace) => ({
    tick: trace.tick,
    running: trace.runningLineId,
    stack: trace.stack.map((frame) => [frame.lineId, frame.invocationId, frame.state, frame.remaining]),
    events: trace.events.map((event) => [event.eventId, event.lineId, event.type, event.effect]),
    actions: trace.actions.map((action) => [
      action.kind,
      action.lineId,
      action.invocationId,
      action.remaining,
      action.preemptedLine ?? null,
    ]),
    pending: trace.pending.map((line) => [
      line.lineId,
      Number(line.masked),
      Number(line.latched),
      Number(line.asserted),
      Number(line.active),
      Number(line.pending),
      Number(line.runnable),
      Number(line.waiting),
      line.waitingSince,
      line.reason,
      line.edgePulseCount,
    ]),
    before: trace.pendingBefore.map((line) => [line.lineId, Number(line.pending), Number(line.masked), Number(line.active)]),
    afterEvents: trace.pendingAfterEvents.map((line) => [
      line.lineId,
      Number(line.pending),
      Number(line.masked),
      Number(line.active),
      line.waitingSince,
      line.reason,
    ]),
  }));
}

function expectMatchesReference(config: ReplayConfig, events: InterruptEvent[]): void {
  const actual = new ReplayController(config, events);
  actual.advance(config.maxTicks);
  const expected = new ReferenceMachine(config, events).run();
  expect(compact(actual.result.traces)).toEqual(compact(expected));
}

const config: ReplayConfig = {
  maxTicks: 30,
  lines: [
    { id: "LOW", priority: 1, mode: "edge", handlerTicks: 5 },
    { id: "MID", priority: 4, mode: "edge", handlerTicks: 3 },
    { id: "HIGH", priority: 8, mode: "edge", handlerTicks: 2 },
    { id: "LVL", priority: 5, mode: "level", handlerTicks: 2 },
    { id: "A", priority: 3, mode: "edge", handlerTicks: 3 },
    { id: "B", priority: 3, mode: "edge", handlerTicks: 2 },
  ],
};

describe("interrupt replay scheduler", () => {
  it("nests preemption and resumes callers in completion order", () => {
    const events: InterruptEvent[] = [
      { tick: 0, lineId: "LOW", type: "trigger" },
      { tick: 2, lineId: "MID", type: "trigger" },
      { tick: 3, lineId: "HIGH", type: "trigger" },
    ];
    const traces = ReplayController.run(config, events).traces;
    const at = (tick: number) => traces[tick]!;
    expect(at(0).actions.map((a) => a.kind)).toEqual(["enter"]);
    expect(at(0).runningLineId).toBe("LOW");
    expect(at(2).actions.map((a) => `${a.kind}:${a.lineId}`)).toEqual(["preempt:LOW", "enter:MID"]);
    expect(at(2).stack.map((frame) => frame.lineId)).toEqual(["LOW", "MID"]);
    expect(at(3).actions.map((a) => `${a.kind}:${a.lineId}`)).toEqual(["preempt:MID", "enter:HIGH"]);
    expect(at(3).stack.map((frame) => frame.state)).toEqual(["preempted", "preempted", "running"]);
    expect(at(4).actions).toEqual([]);
    expect(at(4).runningLineId).toBe("HIGH");
    expect(at(5).actions.map((a) => `${a.kind}:${a.lineId}`)).toEqual(["complete:HIGH", "resume:MID"]);
    expect(at(7).actions.map((a) => `${a.kind}:${a.lineId}`)).toEqual(["complete:MID", "resume:LOW"]);
    expect(at(10).actions.map((a) => a.kind)).toEqual(["complete"]);
    expect(at(10).stack).toEqual([]);
    expectMatchesReference(config, events);
  });

  it("retains one masked edge pending bit and merges repeated triggers", () => {
    const simple: ReplayConfig = {
      maxTicks: 9,
      lines: [{ id: "IRQ", priority: 2, mode: "edge", handlerTicks: 2 }],
    };
    const events: InterruptEvent[] = [
      { tick: 0, lineId: "IRQ", type: "mask" },
      { tick: 1, lineId: "IRQ", type: "trigger" },
      { tick: 2, lineId: "IRQ", type: "trigger" },
      { tick: 3, lineId: "IRQ", type: "unmask" },
    ];
    const traces = ReplayController.run(simple, events).traces;
    expect(traces[2]!.pending[0]!).toMatchObject({
      pending: true,
      runnable: false,
      waiting: true,
      reason: "masked",
      edgePulseCount: 2,
    });
    expect(traces[3]!.actions.map((action) => action.kind)).toEqual(["enter"]);
    expect(traces[3]!.events[0]!.effect).toBe("unmasked");
    expect(traces[5]!.actions.map((action) => action.kind)).toEqual(["complete"]);
    expectMatchesReference(simple, events);
  });

  it("re-enters a held level handler after completion and stops after release", () => {
    const simple: ReplayConfig = {
      maxTicks: 9,
      lines: [{ id: "LEVEL", priority: 3, mode: "level", handlerTicks: 2 }],
    };
    const events: InterruptEvent[] = [
      { tick: 0, lineId: "LEVEL", type: "trigger" },
      { tick: 4, lineId: "LEVEL", type: "release" },
    ];
    const traces = ReplayController.run(simple, events).traces;
    expect(traces[0]!.actions.map((a) => a.kind)).toEqual(["enter"]);
    expect(traces[2]!.actions.map((a) => `${a.kind}:${a.lineId}`)).toEqual(["complete:LEVEL", "enter:LEVEL"]);
    expect(traces[2]!.stack[0]!.invocationId).not.toBe(traces[0]!.stack[0]!.invocationId);
    expect(traces[4]!.actions.map((a) => a.kind)).toEqual(["complete"]);
    expect(traces[4]!.runningLineId).toBeNull();
    expect(traces[4]!.pending[0]!).toMatchObject({ asserted: false, pending: false, runnable: false });
    expectMatchesReference(simple, events);
  });

  it("holds same-priority edges in pending-time then ID order", () => {
    const fifo: ReplayConfig = {
      maxTicks: 12,
      lines: [
      { id: "A", priority: 3, mode: "edge", handlerTicks: 1 },
      { id: "B", priority: 3, mode: "edge", handlerTicks: 3 },
      { id: "C", priority: 3, mode: "edge", handlerTicks: 2 },
      ],
    };
    const events: InterruptEvent[] = [
      { tick: 0, lineId: "B", type: "trigger" },
      { tick: 0, lineId: "C", type: "trigger" },
      { tick: 1, lineId: "A", type: "trigger" },
    ];
    const traces = ReplayController.run(fifo, events).traces;
    expect(traces[0]!.runningLineId).toBe("B");
    expect(traces[0]!.pending.find((line) => line.lineId === "C")!.reason).toBe("same-priority-fifo");
    expect(traces[3]!.actions.map((a) => `${a.kind}:${a.lineId}`)).toEqual(["complete:B", "enter:C"]);
    expect(traces[5]!.actions.map((a) => `${a.kind}:${a.lineId}`)).toEqual(["complete:C", "enter:A"]);
    expectMatchesReference(fifo, events);
  });

  it("keeps a masked level asserted and enters on unmask without losing level evidence", () => {
    const simple: ReplayConfig = {
      maxTicks: 8,
      lines: [{ id: "LV", priority: 5, mode: "level", handlerTicks: 2 }],
    };
    const events: InterruptEvent[] = [
      { tick: 0, lineId: "LV", type: "mask" },
      { tick: 1, lineId: "LV", type: "trigger" },
      { tick: 3, lineId: "LV", type: "unmask" },
    ];
    const traces = ReplayController.run(simple, events).traces;
    expect(traces[1]!.pending[0]!).toMatchObject({ asserted: true, pending: true, runnable: false, reason: "masked" });
    expect(traces[3]!.actions.map((a) => a.kind)).toEqual(["enter"]);
    expectMatchesReference(simple, events);
  });

  it("matches the independent reference machine for a mixed batch", () => {
    const events: InterruptEvent[] = [
      { tick: 0, lineId: "LOW", type: "trigger" },
      { tick: 1, lineId: "LVL", type: "mask" },
      { tick: 1, lineId: "LVL", type: "trigger" },
      { tick: 2, lineId: "MID", type: "trigger" },
      { tick: 3, lineId: "HIGH", type: "trigger" },
      { tick: 5, lineId: "A", type: "trigger" },
      { tick: 5, lineId: "B", type: "trigger" },
      { tick: 6, lineId: "LVL", type: "unmask" },
      { tick: 7, lineId: "LOW", type: "trigger" },
      { tick: 10, lineId: "LVL", type: "release" },
      { tick: 12, lineId: "HIGH", type: "mask" },
      { tick: 13, lineId: "HIGH", type: "trigger" },
      { tick: 14, lineId: "HIGH", type: "trigger" },
      { tick: 16, lineId: "HIGH", type: "unmask" },
      { tick: 20, lineId: "B", type: "mask" },
      { tick: 21, lineId: "B", type: "trigger" },
      { tick: 23, lineId: "B", type: "unmask" },
    ];
    expectMatchesReference(config, events);
  });

  it("produces the same trajectory when events are added in different batches", () => {
    const batches: InterruptEvent[][] = [
      [
        { tick: 0, lineId: "LOW", type: "trigger" },
        { tick: 1, lineId: "LVL", type: "mask" },
        { tick: 1, lineId: "LVL", type: "trigger" },
      ],
      [
        { tick: 2, lineId: "MID", type: "trigger" },
        { tick: 3, lineId: "HIGH", type: "trigger" },
      ],
      [
        { tick: 5, lineId: "A", type: "trigger" },
        { tick: 5, lineId: "B", type: "trigger" },
        { tick: 6, lineId: "LVL", type: "unmask" },
        { tick: 7, lineId: "LOW", type: "trigger" },
      ],
      [
        { tick: 10, lineId: "LVL", type: "release" },
        { tick: 12, lineId: "HIGH", type: "mask" },
      ],
      [
        { tick: 13, lineId: "HIGH", type: "trigger" },
        { tick: 14, lineId: "HIGH", type: "trigger" },
        { tick: 16, lineId: "HIGH", type: "unmask" },
      ],
      [
        { tick: 20, lineId: "B", type: "mask" },
        { tick: 21, lineId: "B", type: "trigger" },
        { tick: 23, lineId: "B", type: "unmask" },
      ],
    ];

    const allEvents = batches.flat();
    const oneShot = ReplayController.run(config, allEvents);

    const streamed = new ReplayController(config);
    let batch = 0;
    while (!streamed.finished) {
      const nextTick = config.maxTicks - streamed.tick;
      const batchLimit = streamed.tick + Math.min(5, nextTick);
      while (batches[batch]?.[0] && batches[batch]![0]!.tick < batchLimit) {
        streamed.addEvents(batches[batch]!);
        batch += 1;
      }
      streamed.advance(Math.min(5, config.maxTicks - streamed.tick));
    }

    expect(compact(streamed.result.traces)).toEqual(compact(oneShot.traces));
    expect(streamed.result.events.map((event) => event.tick)).toEqual(allEvents.map((event) => event.tick));
  });
});
