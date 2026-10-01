import "./style.css";
import { ReplayController, ReplayValidationError } from "./scheduler";
import type {
  EventType,
  InterruptEvent,
  LineConfig,
  PendingEvidence,
  ReplayConfig,
  TickTrace,
  TriggerMode,
} from "./types";

interface EditableLine extends LineConfig {}

interface EditableEvent extends InterruptEvent {
  localId: number;
}

interface Preset {
  name: string;
  maxTicks: number;
  lines: LineConfig[];
  events: InterruptEvent[];
}

const LINE_COLORS = ["#75a7ff", "#8ef0c4", "#ffd166", "#ff7a90", "#b997ff", "#69d2e7", "#f49b69", "#a8e063"];

const presets: Preset[] = [
  {
    name: "嵌套抢占",
    maxTicks: 18,
    lines: [
      { id: "LOW", priority: 1, mode: "edge", handlerTicks: 6 },
      { id: "MID", priority: 4, mode: "edge", handlerTicks: 3 },
      { id: "HIGH", priority: 8, mode: "edge", handlerTicks: 2 },
    ],
    events: [
      { tick: 0, lineId: "LOW", type: "trigger" },
      { tick: 2, lineId: "MID", type: "trigger" },
      { tick: 3, lineId: "HIGH", type: "trigger" },
    ],
  },
  {
    name: "屏蔽边沿合并",
    maxTicks: 12,
    lines: [{ id: "IRQ0", priority: 5, mode: "edge", handlerTicks: 2 }],
    events: [
      { tick: 0, lineId: "IRQ0", type: "mask" },
      { tick: 1, lineId: "IRQ0", type: "trigger" },
      { tick: 2, lineId: "IRQ0", type: "trigger" },
      { tick: 3, lineId: "IRQ0", type: "trigger" },
      { tick: 5, lineId: "IRQ0", type: "unmask" },
    ],
  },
  {
    name: "电平保持重入",
    maxTicks: 10,
    lines: [{ id: "LEVEL", priority: 4, mode: "level", handlerTicks: 2 }],
    events: [
      { tick: 0, lineId: "LEVEL", type: "trigger" },
      { tick: 6, lineId: "LEVEL", type: "release" },
    ],
  },
  {
    name: "同优先级 FIFO",
    maxTicks: 14,
    lines: [
      { id: "A", priority: 3, mode: "edge", handlerTicks: 3 },
      { id: "B", priority: 3, mode: "edge", handlerTicks: 2 },
      { id: "C", priority: 3, mode: "edge", handlerTicks: 1 },
    ],
    events: [
      { tick: 0, lineId: "B", type: "trigger" },
      { tick: 0, lineId: "C", type: "trigger" },
      { tick: 1, lineId: "A", type: "trigger" },
    ],
  },
];

let lines: EditableLine[] = clone(presets[0]!.lines);
let events: EditableEvent[] = withLocalIds(presets[0]!.events);
let maxTicks = presets[0]!.maxTicks;
let eventSerial = events.length;
let controller: ReplayController | null = null;
let traces: TickTrace[] = [];
let selectedTick = 0;
let errorMessage = "";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app root not found");

function clone<T>(value: T): T {
  return structuredClone(value);
}

function withLocalIds(source: InterruptEvent[]): EditableEvent[] {
  return source.map((event, index) => ({ ...event, localId: index }));
}

function lineColor(lineId: string): string {
  const index = lines.findIndex((line) => line.id === lineId);
  return LINE_COLORS[(index < 0 ? 0 : index) % LINE_COLORS.length]!;
}

function makeConfig(): ReplayConfig {
  return {
    maxTicks,
    lines: lines.map(({ id, priority, mode, handlerTicks, initiallyMasked }) => ({
      id,
      priority,
      mode,
      handlerTicks,
      initiallyMasked,
    })),
  };
}

function loadPreset(preset: Preset): void {
  lines = clone(preset.lines);
  events = withLocalIds(preset.events);
  eventSerial = events.length;
  maxTicks = preset.maxTicks;
  controller = null;
  traces = [];
  selectedTick = 0;
  errorMessage = "";
  render();
}

function resetController(): void {
  controller = null;
  traces = [];
  selectedTick = 0;
  errorMessage = "";
}

function runAll(): void {
  try {
    controller = new ReplayController(makeConfig(), events.map(stripLocal));
    traces = controller.advance(maxTicks);
    selectedTick = 0;
    errorMessage = "";
  } catch (error) {
    reportError(error);
  }
  render();
}

function startIncremental(): void {
  try {
    controller = new ReplayController(makeConfig());
    traces = [];
    selectedTick = 0;
    errorMessage = "";
    feedAndAdvance(5);
  } catch (error) {
    reportError(error);
    render();
  }
}

function stepOne(): void {
  try {
    if (!controller) controller = new ReplayController(makeConfig());
    if (!controller.finished) {
      traces.push(...controller.advance(1));
      selectedTick = controller.tick - 1;
    }
    errorMessage = "";
  } catch (error) {
    reportError(error);
  }
  render();
}

function advanceFive(): void {
  try {
    if (!controller) controller = new ReplayController(makeConfig());
    feedAndAdvance(5);
  } catch (error) {
    reportError(error);
    render();
  }
}

function feedAndAdvance(count: number): void {
  if (!controller || controller.finished) return;
  const startTick = controller.tick;
  const targetTick = Math.min(maxTicks, startTick + count);
  const batch = events
    .filter((event) => event.tick >= startTick && event.tick < targetTick)
    .map(stripLocal);
  controller.addEvents(batch);
  const output = controller.advance(count);
  traces.push(...output);
  selectedTick = controller.tick - 1;
  render();
}

function stripLocal(event: EditableEvent): InterruptEvent {
  return { tick: event.tick, lineId: event.lineId, type: event.type };
}

function reportError(error: unknown): void {
  errorMessage = error instanceof ReplayValidationError ? error.message : String(error);
}

function addLine(): void {
  if (lines.length >= 8) return;
  const index = lines.length + 1;
  lines.push({
    id: `IRQ${index}`,
    priority: index,
    mode: "edge",
    handlerTicks: 2,
    initiallyMasked: false,
  });
  resetController();
  render();
}

function removeLine(index: number): void {
  const removed = lines[index]?.id;
  lines.splice(index, 1);
  if (removed) events = events.filter((event) => event.lineId !== removed);
  resetController();
  render();
}

function addEvent(): void {
  events.push({
    localId: eventSerial++,
    tick: 0,
    lineId: lines[0]?.id ?? "",
    type: "trigger",
  });
  resetController();
  render();
}

function removeEvent(localId: number): void {
  events = events.filter((event) => event.localId !== localId);
  resetController();
  render();
}

function eventLabel(type: EventType): string {
  return { trigger: "触发", release: "撤销电平", mask: "屏蔽", unmask: "解除屏蔽" }[type];
}

function effectLabel(effect: string): string {
  const labels: Record<string, string> = {
    "latched-new": "锁存新位",
    coalesced: "合并",
    "armed-active": "活动时挂起",
    asserted: "电平有效",
    "already-asserted": "已有效",
    released: "已撤销",
    "not-asserted": "原本无效",
    masked: "已屏蔽",
    "already-masked": "原本屏蔽",
    unmasked: "已解除",
    "already-unmasked": "原本解除",
  };
  return labels[effect] ?? effect;
}

function reasonLabel(reason: PendingEvidence["reason"]): string {
  const labels: Record<PendingEvidence["reason"], string> = {
    none: "—",
    "edge-latched": "边沿待处理",
    "level-asserted": "电平有效",
    masked: "被屏蔽",
    "active-same-line": "本线处理中",
    preempted: "被抢占",
    "lower-priority": "低优先级等待",
    "same-priority-fifo": "同优先级等待",
    "higher-priority-running": "可抢占",
  };
  return labels[reason];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render(): void {
  app!.innerHTML = "";
  app!.append(renderHeader(), renderLayout());
}

function renderHeader(): HTMLElement {
  const header = el("header", "hero");
  const titleWrap = el("div");
  titleWrap.append(el("h1", undefined, "中断控制器回放台"));
  titleWrap.append(el("p", undefined, "纯 TypeScript 状态机：事件 → 上一 tick 完成 → 严格高优先级抢占 → 当前 tick 执行。"));
  const badges = el("div", "badges");
  badges.append(el("span", "badge", "无真实硬件"));
  badges.append(el("span", "badge", "1–8 条中断线"));
  badges.append(el("span", "badge", "最多 500 tick"));
  badges.append(el("span", "badge", "时间轴与表格共用 traces"));
  header.append(titleWrap, badges);
  return header;
}

function renderLayout(): HTMLElement {
  const layout = el("main", "layout");
  const side = el("div", "stack-side");
  side.append(renderLinesPanel(), renderEventsPanel());
  const output = el("div", "stack-side");
  output.append(renderReplayPanel(), renderTimelinePanel(), renderTablePanel());
  layout.append(side, output);
  return layout;
}

function labeledInput(label: string, input: HTMLElement): DocumentFragment {
  const fragment = new DocumentFragment();
  fragment.append(el("label", "muted", label), input);
  return fragment;
}

function renderLinesPanel(): HTMLElement {
  const panel = el("section", "panel");
  panel.append(el("h2", undefined, "中断线配置"));
  const body = el("div", "panel-body");

  const top = el("div", "form-grid");
  const ticksInput = document.createElement("input");
  ticksInput.type = "number";
  ticksInput.min = "1";
  ticksInput.max = "500";
  ticksInput.value = String(maxTicks);
  ticksInput.addEventListener("change", () => {
    maxTicks = Number(ticksInput.value);
    resetController();
    render();
  });
  top.append(labeledInput("回放 tick 数 (1–500)", ticksInput));
  const add = el("button", undefined, "添加中断线");
  add.disabled = lines.length >= 8;
  add.addEventListener("click", addLine);
  top.append(add);
  body.append(top);

  lines.forEach((line, index) => {
    const row = el("div", "line-row");
    const idWrap = el("div", "line-id");
    const swatch = el("span", "swatch");
    swatch.style.background = LINE_COLORS[index]!;
    const idInput = document.createElement("input");
    idInput.value = line.id;
    idInput.placeholder = "唯一 ID";
    idInput.addEventListener("change", () => {
      const oldId = line.id;
      line.id = idInput.value.trim() || oldId;
      events.forEach((event) => {
        if (event.lineId === oldId) event.lineId = line.id;
      });
      resetController();
      render();
    });
    idWrap.append(swatch, idInput);

    const priority = document.createElement("input");
    priority.type = "number";
    priority.value = String(line.priority);
    priority.title = "数字越大优先级越高";
    priority.addEventListener("change", () => {
      line.priority = Number(priority.value);
      resetController();
      render();
    });

    const mode = document.createElement("select");
    for (const value of ["edge", "level"] as TriggerMode[]) {
      const option = el("option", undefined, value === "edge" ? "边沿" : "电平");
      option.value = value;
      option.selected = line.mode === value;
      mode.append(option);
    }
    mode.addEventListener("change", () => {
      line.mode = mode.value as TriggerMode;
      if (line.mode === "edge") events = events.filter((event) => event.lineId !== line.id || event.type !== "release");
      resetController();
      render();
    });

    const ticks = document.createElement("input");
    ticks.type = "number";
    ticks.min = "1";
    ticks.max = "500";
    ticks.value = String(line.handlerTicks);
    ticks.addEventListener("change", () => {
      line.handlerTicks = Number(ticks.value);
      resetController();
      render();
    });

    const remove = el("button", "icon-button danger", "×");
    remove.title = "删除中断线及其事件";
    remove.addEventListener("click", () => removeLine(index));

    row.append(idWrap, priority, mode, ticks, remove);
    body.append(row);
  });
  body.append(el("div", "muted", "优先级为整数；数值越大越高。边沿 release 无效；电平保持有效会在完成后重入。"));
  panel.append(body);
  return panel;
}

function renderEventsPanel(): HTMLElement {
  const panel = el("section", "panel");
  panel.append(el("h2", undefined, `事件队列（${events.length}）`));
  const body = el("div", "panel-body");
  const add = el("button", undefined, "+ 添加事件");
  add.addEventListener("click", addEvent);
  body.append(add);
  body.append(el("div", "tooltip-note", "同一 tick 内事件按表格中的顺序应用。"));

  events.forEach((event) => {
    const row = el("div", "event-row");

    const tick = document.createElement("input");
    tick.type = "number";
    tick.min = "0";
    tick.max = String(Math.max(0, maxTicks - 1));
    tick.value = String(event.tick);
    tick.addEventListener("change", () => {
      event.tick = Number(tick.value);
      resetController();
      render();
    });

    const line = document.createElement("select");
    lines.forEach((candidate) => {
      const option = el("option", undefined, candidate.id);
      option.value = candidate.id;
      option.selected = candidate.id === event.lineId;
      line.append(option);
    });
    line.addEventListener("change", () => {
      event.lineId = line.value;
      if (event.type === "release" && lines.find((candidate) => candidate.id === event.lineId)?.mode === "edge") {
        event.type = "trigger";
      }
      resetController();
      render();
    });

    const type = document.createElement("select");
    const selectedLine = lines.find((candidate) => candidate.id === event.lineId);
    const available: EventType[] = selectedLine?.mode === "level"
      ? ["trigger", "release", "mask", "unmask"]
      : ["trigger", "mask", "unmask"];
    available.forEach((value) => {
      const option = el("option", undefined, eventLabel(value));
      option.value = value;
      option.selected = event.type === value;
      type.append(option);
    });
    type.addEventListener("change", () => {
      event.type = type.value as EventType;
      resetController();
      render();
    });

    const remove = el("button", "icon-button danger", "×");
    remove.addEventListener("click", () => removeEvent(event.localId));

    row.append(tick, line, type, remove);
    body.append(row);
  });

  if (errorMessage) body.append(el("div", "error", errorMessage));
  panel.append(body);
  return panel;
}

function renderReplayPanel(): HTMLElement {
  const panel = el("section", "panel");
  panel.append(el("h2", undefined, "回放控制"));
  const body = el("div", "panel-body");

  const presetBar = el("div", "preset-bar");
  presets.forEach((preset) => {
    const button = el("button", "ghost", preset.name);
    button.addEventListener("click", () => loadPreset(preset));
    presetBar.append(button);
  });

  const controls = el("div", "actions-bar");
  const run = el("button", "primary", "一次运行到结束");
  run.addEventListener("click", runAll);
  const start = el("button", undefined, "开始分批注入");
  start.addEventListener("click", startIncremental);
  const five = el("button", undefined, "推进 5 tick（注入本窗口事件）");
  five.addEventListener("click", advanceFive);
  const one = el("button", undefined, "单步");
  one.addEventListener("click", stepOne);
  const reset = el("button", "ghost danger", "清空结果");
  reset.addEventListener("click", () => {
    resetController();
    render();
  });
  controls.append(run, start, five, one, reset);

  const status = el("div", "status");
  const currentTick = controller?.tick ?? 0;
  status.append(metric("已生成 tick", `${traces.length} / ${maxTicks}`), metric("控制器 tick", String(currentTick)));
  const entered = traces.flatMap((trace) => trace.actions).filter((action) => action.kind === "enter").length;
  const pending = traces.at(selectedTick)?.pending.filter((line) => line.pending).length ?? 0;
  status.append(metric("进入次数", String(entered)), metric("选中 tick 待处理线", String(pending)));

  body.append(presetBar, controls, status);
  body.append(el("div", "muted", "证据含义：P=挂起条件，M=屏蔽，A=活动栈帧，R=可调度，W=等待，E=边沿脉冲合并数。"));
  panel.append(body);
  return panel;
}

function metric(label: string, value: string): HTMLElement {
  const node = el("div", "metric");
  node.append(el("div", "label", label), el("div", "value", value));
  return node;
}

function renderTimelinePanel(): HTMLElement {
  const panel = el("section", "panel");
  panel.append(el("h2", undefined, "执行栈时间轴"));
  const body = el("div", "panel-body");
  if (traces.length === 0) {
    body.append(el("div", "muted", "运行后最多显示 500 个 tick。每个彩色块是该 tick 的一层栈，越靠上越接近当前处理程序。"));
  } else {
    const wrap = el("div", "timeline-wrap");
    const timeline = el("div", "timeline");
    traces.forEach((trace) => timeline.append(renderTickCell(trace)));
    wrap.append(timeline);
    body.append(wrap);
    body.append(renderLegend());
    body.append(renderSelectedDetail());
  }
  panel.append(body);
  return panel;
}

function renderTickCell(trace: TickTrace): HTMLElement {
  const cell = el("div", `tick-cell${trace.tick === selectedTick ? " selected" : ""}`);
  cell.title = `tick ${trace.tick}`;
  cell.addEventListener("click", () => {
    selectedTick = trace.tick;
    render();
  });
  cell.append(el("div", "tick-label", String(trace.tick)));
  const lane = el("div", "tick-lane");
  trace.stack.forEach((frame) => {
    const chip = el("div", `stack-chip ${frame.state}`, frame.lineId);
    chip.style.background = lineColor(frame.lineId);
    chip.title = `${frame.lineId} / ${frame.invocationId} / remaining=${frame.remaining}`;
    lane.append(chip);
  });
  cell.append(lane);
  const eventStrip = el("div", "event-strip");
  trace.events.forEach((event) => {
    const dot = el("div", `event-dot event-${event.type}`, event.type === "trigger" ? "↑" : event.type === "release" ? "↓" : event.type === "mask" ? "M" : "U");
    dot.title = `${event.eventId} ${event.lineId} ${eventLabel(event.type)}: ${effectLabel(event.effect)}`;
    eventStrip.append(dot);
  });
  cell.append(eventStrip);
  return cell;
}

function renderLegend(): HTMLElement {
  const legend = el("div", "legend");
  legend.append(legendItem("var(--accent-2)", "触发"));
  legend.append(legendItem("var(--warn)", "撤销电平"));
  legend.append(legendItem("var(--danger)", "屏蔽"));
  legend.append(legendItem("var(--purple)", "解除屏蔽"));
  legend.append(el("span", "legend-item", "虚线块：已抢占的下层处理程序"));
  return legend;
}

function legendItem(color: string, text: string): HTMLElement {
  const item = el("span", "legend-item");
  item.append(el("span", "legend-dot"), text);
  item.querySelector<HTMLElement>(".legend-dot")!.style.background = color;
  return item;
}

function renderSelectedDetail(): HTMLElement {
  const trace = traces[selectedTick];
  const grid = el("div", "detail-grid");
  const actionsCard = el("div", "detail-card");
  actionsCard.append(el("h3", undefined, `tick ${selectedTick}：进入 / 抢占 / 恢复 / 完成`));
  const actionList = el("div", "pill-list");
  if (!trace || trace.actions.length === 0) actionList.append(el("span", "muted", "无动作；当前顶层继续执行或 CPU 空闲"));
  trace?.actions.forEach((action) => {
    const text = {
      enter: `进入 ${action.lineId}`,
      preempt: `抢占 ${action.preemptedLine ?? action.lineId}`,
      resume: `恢复 ${action.lineId}`,
      complete: `完成 ${action.lineId}`,
    }[action.kind];
    actionList.append(el("span", "pill", `${text} · ${action.invocationId} · rem=${action.remaining}`));
  });
  actionsCard.append(actionList);

  const stackCard = el("div", "detail-card");
  stackCard.append(el("h3", undefined, "当前 tick 结束栈（底 → 顶）"));
  const stackList = el("div", "pill-list");
  if (!trace || trace.stack.length === 0) stackList.append(el("span", "muted", "空"));
  trace?.stack.forEach((frame) => {
    const pill = el("span", "pill");
    const dot = el("span", "dot");
    dot.style.background = lineColor(frame.lineId);
    pill.append(dot, `${frame.lineId}[${frame.state}] rem=${frame.remaining}`);
    stackList.append(pill);
  });
  stackCard.append(stackList);

  grid.append(actionsCard, stackCard);
  return grid;
}

function renderTablePanel(): HTMLElement {
  const panel = el("section", "panel");
  panel.append(el("h2", undefined, "逐 tick 表格（引用同一轨迹）"));
  const body = el("div", "panel-body");
  if (traces.length === 0) {
    body.append(el("div", "muted", "表格、时间轴和详情均从 ReplayController.advance 返回的 TickTrace[] 渲染。"));
  } else {
    const wrap = el("div", "table-wrap");
    const table = document.createElement("table");
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["tick", "应用事件", "动作", "执行栈", "最终待处理证据"].forEach((title) => headRow.append(el("th", undefined, title)));
    head.append(headRow);
    const tbody = document.createElement("tbody");
    traces.forEach((trace) => {
      const row = document.createElement("tr");
      if (trace.tick === selectedTick) row.className = "selected-row";
      row.addEventListener("click", () => {
        selectedTick = trace.tick;
        render();
      });
      row.append(
        cell(String(trace.tick)),
        renderEventCell(trace),
        renderActionCell(trace),
        renderStackCell(trace),
        renderEvidenceCell(trace),
      );
      tbody.append(row);
    });
    table.append(head, tbody);
    wrap.append(table);
    body.append(wrap);
  }
  panel.append(body);
  return panel;
}

function cell(text: string): HTMLTableCellElement {
  return el("td", undefined, text);
}

function renderEventCell(trace: TickTrace): HTMLTableCellElement {
  const td = document.createElement("td");
  if (trace.events.length === 0) td.append(el("span", "muted", "—"));
  trace.events.forEach((event) => {
    const line = el("div", undefined, `${event.eventId} ${event.lineId} ${eventLabel(event.type)} → ${effectLabel(event.effect)}`);
    td.append(line);
  });
  return td;
}

function renderActionCell(trace: TickTrace): HTMLTableCellElement {
  const td = document.createElement("td");
  if (trace.actions.length === 0) td.append(el("span", "muted", trace.runningLineId ? `执行 ${trace.runningLineId}` : "空闲"));
  trace.actions.forEach((action) => {
    const marker = { enter: "▶", preempt: "↡", resume: "↟", complete: "✓" }[action.kind];
    td.append(el("div", undefined, `${marker} ${action.kind}:${action.lineId} ${action.invocationId} rem=${action.remaining}`));
  });
  return td;
}

function renderStackCell(trace: TickTrace): HTMLTableCellElement {
  const td = document.createElement("td");
  if (trace.stack.length === 0) {
    td.append(el("span", "muted", "[]"));
    return td;
  }
  trace.stack.forEach((frame) => {
    const pill = el("span", "pill");
    const dot = el("span", "dot");
    dot.style.background = lineColor(frame.lineId);
    pill.append(dot, `${frame.lineId}:${frame.remaining}`);
    const wrap = el("div");
    wrap.style.marginBottom = "4px";
    wrap.append(pill);
    td.append(wrap);
  });
  return td;
}

function renderEvidenceCell(trace: TickTrace): HTMLTableCellElement {
  const td = document.createElement("td");
  const grid = el("div", "evidence-grid");
  const head = el("div", "evidence-row head");
  ["线", "P", "M", "A", "R", "W", "原因/E"].forEach((value) => head.append(el("span", undefined, value)));
  grid.append(head);
  trace.pending.forEach((line) => {
    const row = el("div", "evidence-row");
    row.append(el("strong", undefined, line.lineId));
    row.append(state(line.pending), state(line.masked), state(line.active), state(line.runnable), state(line.waiting));
    const detail = el("span", undefined, `${reasonLabel(line.reason)}${line.mode === "edge" ? ` E${line.edgePulseCount}` : ""}`);
    detail.title = line.waitingSince === null ? "无等待时刻" : `waitingSince=${line.waitingSince}`;
    row.append(detail);
    grid.append(row);
  });
  td.append(grid);
  return td;
}

function state(on: boolean): HTMLElement {
  return el("span", on ? "state-on" : "state-off", on ? "1" : "0");
}

render();
