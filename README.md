# 中断控制器回放台

一个不连接真实硬件的 TypeScript 中断控制器回放页。核心调度器是纯状态机，页面只渲染同一份 `TickTrace[]`，因此时间轴、详情卡片和逐 tick 表格不会出现口径不一致。

## 运行

```bash
npm install
npm run dev
```

其他命令：

```bash
npm run test:run   # Vitest 一次性测试
npm run build      # strict TypeScript 检查 + Vite 构建
npm run preview    # 预览构建产物
```

## 模型

- 可配置 1～8 条中断线，每条包含唯一 ID、优先级、`edge`/`level` 模式和处理程序所需 tick。
- 事件可在指定 tick 执行：`trigger`、`release`、`mask`、`unmask`。
- 回放长度限制为 1～500 tick，tick 标签为 `0..maxTicks-1`。
- 优先级按整数比较，数值越大优先级越高。

每个 tick 的顺序固定为：

1. 按队列顺序应用本 tick 的所有事件。
2. 处理上一 tick 执行后到期的完成。
3. 选择待处理线：严格更高优先级才可抢占当前顶层。
4. 同优先级按待处理时刻，再按线 ID 排序等待，不能抢占同优先级处理程序。
5. 记录动作、栈和待处理证据。
6. 本 tick 顶层处理程序执行一个 tick，剩余时间减 1。

因此 `handlerTicks=N` 的处理程序在 tick `t` 进入后执行 tick `t..t+N-1`，`complete` 动作在 tick `t+N` 开头产生。

### 边沿与电平

- 边沿：屏蔽期间触发也保留一个待处理位；重复触发合并，并在证据中累计 `edgePulseCount`。处理程序活动期间的重复触发会保留，完成后可再次进入同一处理程序。
- 电平：`trigger` 让物理线保持有效，`release` 撤销。线保持有效时，处理完成后可重入；若在完成 tick 之前撤销，则不会重入。
- 屏蔽会阻止调度，但不删除边沿位，也不撤销已保持的电平。

## 轨迹证据

每个 `TickTrace` 包含：

- `pendingBefore`：tick 事件应用前的证据；
- `events`：实际应用的事件及效果（如 `coalesced`、`asserted`、`masked`）；
- `pendingAfterEvents`：事件后、完成/调度前的证据；
- `actions`：`enter`、`preempt`、`resume`、`complete`；
- `stack`：tick 结束后的完整执行栈及每层剩余 tick；
- `pending`：tick 结束时每条线的硬件/调度证据。

## 测试

`test/scheduler.test.ts` 内置一个独立的逐 tick 参考状态机。它不导入生产调度器的私有函数，而是用测试内的独立数据结构重新执行同一模型，再比较：

- 动作及顺序；
- 嵌套抢占和恢复；
- 屏蔽期间边沿位保留与重复合并；
- 解除屏蔽后的进入；
- 电平保持重入和撤销停止；
- 同优先级按待处理时刻、ID 等待；
- 将事件预载一次运行与分批注入、分批推进的轨迹一致性。
