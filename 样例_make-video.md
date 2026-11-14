---
id: make-video-20261114
goal: DeepSeek Super-agent 原理讲解成片
nodes:
  A: { title: 调研-原理链路, role: 调研员1, in: [], out: [raw/spec.md], check: 每条结论附出处 }
  C: { title: 调研-竞品拆解, role: 调研员2, in: [], out: [raw/peers.md], check: 至少 3 个同类 }
  B: { title: 核验, role: 核查员, in: [A, C], join: all, out: [checked.md], check: 冲突项必须裁决 }
  D: { title: 大纲, role: 编辑, in: [B], gate: human, blank: [受众, 时长] }
  E: { title: 分镜, role: 制作, in: [D], out: [shots.md] }
  F: { title: 成片, role: 制作, in: [E], out: [final.mp4] }
---

# make-video 工作流（图式计划）

真身是上面的 YAML，下面是它的视图。改结构改 YAML，改依赖看图。

## 1. 主图

![流程图](img/01-流程图.png)

上面这张 PNG 就是用它下面这段代码渲染的，**逐字相同**，可以直接复制：

```mermaid
flowchart LR
  subgraph S1["① 并行调研"]
    A["调研·原理链路"]
    C["调研·竞品拆解"]
  end
  subgraph S2["② 核验"]
    B["核验 join=all"]
  end
  A -->|raw/spec.md| B
  C -->|raw/peers.md| B
  B -->|checked.md| D{"卡点① 大纲确认"}
  D --> E["分镜"]
  E --> F["成片"]
  classDef gate fill:#ffe0e0,stroke:#c0392b,stroke-width:2px
  class D gate
```

## 2. 兜底：单行版（分号分隔，粘贴丢换行也能过）

与主图同一套依赖与边标签，只是去掉了 subgraph（分组无法挤进单行），并已实测渲染通过：

```mermaid
flowchart LR; A["调研·原理链路"]-->|raw/spec.md| B["核验"]; C["调研·竞品拆解"]-->|raw/peers.md| B; B-->|checked.md| D{"卡点① 大纲确认"}; D-->E["分镜"]; E-->F["成片"]
```

## 3. 最小诊断块（纯 ASCII，用来判断是不是引擎问题）

```mermaid
graph LR
A-->B
C-->B
```

如果第 3 块也报错，说明是 Typora 的 mermaid 版本问题，不是语法问题：升级 Typora，或改用 Obsidian（自带较新 mermaid）。

## 4. 合流语义

`C --> B` 和 `A --> B` 同时存在，就是 fan-in：B 必须等 A、C 都交付才启动。对应 YAML 里的 `in: [A, C]` 与 `join: all`。看板/思维导图表达不了这个，因为它们没有"入边集合"这个概念。

## 5. 留白与卡点

`gate: human` 表示停下等人；`blank: [受众, 时长]` 是必须由人填的参数。Agent 执行时读到这两个字段会中断并提问，而不是自己猜。

## 6. 同一份 YAML 的另外两张视图

结构图看依赖，状态机看返工，甘特看排期。三者都从同一份 nodes/edges 推出来，不需要维护两份。

### 6.1 状态机（重跑与回退）

![状态机](img/02-状态机.png)

```mermaid
stateDiagram-v2
    [*] --> research
    research --> verify: A、C 齐
    verify --> outline: 无冲突
    verify --> research: 冲突补证
    outline --> outline: 等留白填写
    outline --> shots: 人确认
    shots --> video
    video --> [*]
    note right of outline: 卡点① 大纲确认
```

`verify --> research` 这条回边就是截图里那些回环箭头，它说明“核验发现冲突要打回重调”，而不是简单重试。

### 6.2 甘特（排期）

![甘特](img/03-甘特.png)

```mermaid
gantt
    title make-video 排期
    dateFormat YYYY-MM-DD
    axisFormat %m-%d
    section 调研
    原理链路 :a1, 2026-11-15, 2d
    竞品拆解 :a2, 2026-11-15, 2d
    section 核验
    交叉核验 :b1, after a1, 1d
    section 卡点
    大纲确认 :milestone, m1, after b1, 0d
    section 产出
    分镜 :c1, after m1, 2d
    成片 :c2, after c1, 3d
```

`after a1` 自动把核验排在调研之后，卡点用 `milestone` 标成零宽度节点。
