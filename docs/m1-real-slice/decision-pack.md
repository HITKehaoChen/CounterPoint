# Decision Pack — CounterPoint Web Console 当前通过 /api/stream（SSE）+ 5 秒轮询兜底获取实时状态。M1 需要一个真实技术决策：实时更新通道应保持 SSE（现状）、改用 WebSocket，还是退化为纯轮询？

- Deliberation: `delib_msq9tftf_29278556c2`
- Protocol: 0.1.0 (format 0.1.0)
- State: decided
- Created: 2026-08-12T15:55:26.163Z
- Decided: 2026-08-12T16:04:05.916Z

## Task Packet

CounterPoint Web Console 当前通过 /api/stream（SSE）+ 5 秒轮询兜底获取实时状态。M1 需要一个真实技术决策：实时更新通道应保持 SSE（现状）、改用 WebSocket，还是退化为纯轮询？

### Goals
- 提供近实时的状态/Timeline 更新（秒级延迟可接受）
- 与单进程、本地优先（单文件 JSON 存储）架构匹配
- 兼容现代浏览器与 React/Vite 前端栈
- 断线、代理中断、休眠、服务器重启等场景有可测试的兜底

### Constraints
- 不引入外部基础设施（Redis、消息队列、第三方推送）
- 尽量不新增运行时依赖；若必须新增，须给出理由
- REST POST 写路径保持不变
- 单用户 local-first 部署，不需要跨进程广播
- 保持 Node.js 内置 http 服务器，不更换框架

### Rubric
- 架构契合度 — 与单进程/本地优先/现有代码结构匹配 (weight 1)
- 实时性 — 状态与 Timeline 更新的端到端延迟 (weight 0.8)
- 实现与运维复杂度 — 代码量、依赖、心智负担 (weight 0.8)
- 断线与兜底 — 重连、恢复、不丢事件 (weight 0.8)
- 可测试性 — 能否用真实编译/测试/检索验证 (weight 0.6)

## Candidates

### Candidate B

保持 SSE（现状）作为实时通道，保留轮询作为兜底而非永久降级；不引入 WebSocket，也不退回纯轮询。理由：CounterPoint 是单进程、本地优先、REST 写路径架构，实时更新只需要服务器→客户端单向推送，现有进程内 EventBus 到 SSE 的映射已经用约十行代码完成且零新增依赖；WebSocket 提供不需要的全双工能力，且 Node 内置 http 不原生支持 upgrade，采用它要么新增 ws 依赖要么手写帧协议，复杂度最高而无功能收益；纯轮询虽满足秒级延迟下限，但空闲时也持续重建 HumanView，对单文件 JSON 存储构成无谓负载。SSE 的关键韧性来自客户端把流当作『变更通知』并在收到事件后重新 GET 权威 view——因此断线、代理中断、休眠、服务器重启后都能收敛到最新状态，无需 Last-Event-ID 或回放。需要做的不是换通道，而是修正前端 onerror 在首次瞬时错误即永久关闭 EventSource 的行为，改为依赖原生自动重连并以延迟/并行轮询兜底。

- Confidence: 0.8
- Commitment: `3f42093867ad9430…`
- Artifacts: adr-008-realtime-channel@v1
- Unknowns:
  - 未来是否会经反向代理/CDN 部署，以及代理缓冲策略能否配置
  - 多标签页/多窗口并发订阅的实际规模（HTTP/1.1 每域名 6 连接限制是否触及）
  - 未来是否出现客户端→服务器流式输入需求，或跨进程/多实例扩展需求
  - JsonFileStore 在更大数据集下 GET/view 重建的实际成本（影响轮询兜底间隔的取舍）
- Decision conditions:
  - 出现双向流式需求（如流式 Agent 输出需回传客户端）→ 改 WebSocket
  - 部署环境必须经过会缓冲 SSE 的代理/CDN 且无法关闭缓冲 → 重新评估（WebSocket 或纯轮询）
  - 需要跨进程/多实例广播 → 进程内 bus + SSE 不再适用，需引入外部 bus
  - 实测 GET/view 重建成本高到使轮询兜底不可接受 → 维持事件驱动并进一步降低轮询兜底频率

#### Claims
- [fact] 保持 SSE 与单进程、本地优先架构最契合：服务器只需单向推送（客户端写路径已全部走 REST POST），进程内 EventBus 可直接映射为 SSE 流，无需跨进程广播。
- [fact] 改用 WebSocket 需要新增运行时依赖（如 ws）或手写 HTTP upgrade 与帧协议，显著增加代码量与运维负担，而单用户场景下无功能收益。
- [design] SSE 变更通知 + 全量 view 重取的组合具有强断线恢复能力：客户端始终以权威 GET 收敛，断线/代理中断/休眠/服务器重启后不丢事件，且无需 Last-Event-ID 或事件回放。
- [fact] SSE 与 WebSocket 在本场景的端到端延迟无实质差异（均为亚秒级推送），因此实时性不构成选择 WebSocket 的理由。
- [preference] 纯轮询在 5 秒间隔可满足『秒级延迟可接受』的目标，但空闲时也持续重建 HumanView，对单文件 JSON 存储构成无谓负载；SSE 仅在变化时触发重取，效率更高。
- [risk] 现状前端 useDeliberation 的 onerror 处理在首次瞬时错误即关闭 EventSource 并永久转轮询，弱化了 SSE 收益；应依赖 EventSource 原生自动重连，并以延迟/并行轮询作为兜底。
- [risk] SSE 在缓冲型代理/CDN 之后可能停顿；本地优先部署规避了该风险，但需文档化 X-Accel-Buffering: no 等缓冲处理以备未来经代理部署。

### Candidate A

推荐保持 SSE 作为实时更新的主通道并加固现状实现，保留并强化已有的 5 秒轮询作为可测试的降级兜底，不引入 WebSocket。核心理由：当前 SSE 是『通知通道』语义——客户端忽略事件载荷，收到触发后全量重拉 HumanView——事件丢失不产生状态丢失，轮询兜底与 SSE 在正确性上完全等价，兜底路径天然覆盖断线/代理/休眠/重启全部要求的故障模式；SSE 在 Node 下零新增运行时依赖即可实现与集成测试（node:http 服务端 + 内置 fetch 流式帧解析，本评审已实测通过；Node 无全局 EventSource 客户端这一点也已实测确认）；WebSocket 的双向能力因写路径固定为 REST POST 而完全闲置，却要付出新增运行时依赖 ws 或手写 RFC6455、手写重连退避、Vite 代理额外配置的成本；纯轮询虽满足『秒级延迟可接受』，但在产品核心时刻（围观 Blind Run 实时推进时的 run.update 事件突发）劣化体验，且会废弃 PRD 建议技术栈已预留的推送通道与现成代码。必须做的加固：修复客户端『粘性』降级缺陷（首次 onerror 即永久放弃 SSE，服务器重启后无法自动恢复）、事件风暴时对重拉做尾随去抖、补加单调 id: 与 Last-Event-ID 为未来增量载荷留升级路径。

- Confidence: 0.82
- Commitment: `81b88d6e8657222f…`
- Artifacts: adr-realtime-channel@v4, sse-smoke-test-report@v1
- Unknowns:
  - Vite dev proxy 是否已配置 /api 转发且对 SSE 流式响应无缓冲（提供资料未覆盖 apps/web/vite.config.ts）
  - tests/api 下是否已有 /api/stream 的既有测试覆盖（未提供测试文件内容）
  - 真实目标部署链路（非 localhost）的代理缓冲行为——本地优先部署下风险低但未验证
- Decision conditions:
  - 出现服务器主动发起指令或双向通信需求 → 重新评估 WebSocket
  - 实测 SSE 在 Vite dev proxy 或目标部署链路持续不稳定（持续缓冲/频繁断连）→ 降级为纯轮询，仍满足秒级目标
  - 前端改为直接消费事件增量载荷（不再全量重拉）→ 必须启用 id:/Last-Event-ID 与重放缓冲，并重新评审通道选择
  - 单进程约束解除、需要跨进程/多节点广播 → 进程内 EventBus 整体失效，需外部基础设施，另立 ADR
  - 团队评估通知通道维护成本高于其价值（页面仅需固定间隔刷新）→ 删除 bus+stream，纯轮询

#### Claims
- [fact] 当前 SSE 实现是『通知通道』而非数据通道：web 端忽略事件载荷，仅在收到 event/run.update 消息后全量重拉 GET /api/deliberations/:id 的 HumanView；因此事件丢失不会造成状态丢失，任何后续触发或轮询都能自愈。
  - Evidence: src_web_use_deliberation@v1, src_api_server@v1
- [fact] 服务端 /api/stream 已具备：15s 心跳注释帧、retry: 3000 重连指令、no-cache/no-transform 头、按 deliberationId 过滤的进程内 EventBus fan-out，且 stream 路由被排除在全局互斥锁之外，不阻塞写路径——现有实现与单进程 local-first 架构契合良好。
  - Evidence: src_api_server@v1, src_event_bus@v1
- [fact] 现有客户端兜底是『粘性』的：EventSource 首次触发 onerror 即 close 并永久切换为 5s 轮询，直至页面重载或组件重挂载——服务器重启或瞬时网络抖动后无法自动恢复 SSE，这是保持 SSE 方案必须修复的最主要缺陷。
  - Evidence: src_web_use_deliberation@v1
- [fact] SSE 在 API 层可零新增运行时依赖实现与集成测试：node:http 直接输出 SSE 帧；本机 Node v24.14.0 实测没有全局 EventSource 客户端（typeof EventSource === 'undefined'），但用内置 fetch 流式读取+帧解析（约 30 行测试辅助）即可做端到端断言，本评审已实测通过；浏览器端 EventSource 为原生 API，服务端零依赖。
  - Evidence: src_package_json@v1, src_api_server@v1
- [design] 切换到 WebSocket 没有收益只有成本：写路径固定为 REST POST（约束），双向能力完全闲置；Node http 无内置服务端 WebSocket，必须新增运行时依赖 ws 或手写 RFC6455（掩码、分片、ping/pong、关闭握手，高风险）；客户端需手写自动重连与指数退避（EventSource 内建）；Vite dev 代理需额外 ws:true 配置。
  - Evidence: src_package_json@v1
- [design] 保持 SSE 优于退化为纯轮询：轮询最坏 5s 延迟虽满足『秒级延迟可接受』，但盲跑/评审运行期间 run.update 事件突发正是用户围观的核心时刻，亚秒级触发显著优于固定间隔；PRD 建议技术栈明确预留『SSE 或 WebSocket 推送状态和事件』，且现有 bus+stream 代码已可用，保持成本低于新建成本。
  - Evidence: src_prd_realtime_excerpt@v1
- [risk] 事件驱动重拉在事件突发时可能比 5s 轮询更频繁（run.update 风暴导致连续多次全量 GET），需在客户端做尾随去抖（~300ms）合并重拉，否则把延迟优化变成请求放大。
  - Evidence: src_web_use_deliberation@v1
- [fact] 5s 轮询兜底已实现且天然覆盖全部要求的故障模式（断线/代理中断/休眠/服务器重启——无连接状态即无连接故障），应保留为可测试的降级路径；建议兜底间隔收紧至 3s 以贴近秒级目标。
  - Evidence: src_web_use_deliberation@v1
- [design] 应为 SSE 事件补加单调递增 id: 字段并支持 Last-Event-ID（成本极低），为未来前端直接消费增量载荷留升级路径；MVP 阶段因通知通道语义无需事件重放缓冲。
  - Evidence: src_api_server@v1
- [fact] jsdom 测试环境未实现 EventSource，web 层 hook 测试需最小 test double——这反而是优势：onerror/自动重连/兜底切换路径可确定性模拟；若 API 层测试需要真实客户端语义，可加 eventsource 作为 devDependency（不影响运行时依赖面），MVP 可不用。
  - Evidence: src_package_json@v1

## Divergence Matrix

_No shared conclusions._

### Unique claims
- 保持 SSE 与单进程、本地优先架构最契合：服务器只需单向推送（客户端写路径已全部走 REST POST），进程内 EventBus 可直接映射为 SSE 流，无需跨进程广播。 (pos_msqa3l1a_8e2d36e26b)
- 改用 WebSocket 需要新增运行时依赖（如 ws）或手写 HTTP upgrade 与帧协议，显著增加代码量与运维负担，而单用户场景下无功能收益。 (pos_msqa3l1a_8e2d36e26b)
- SSE 变更通知 + 全量 view 重取的组合具有强断线恢复能力：客户端始终以权威 GET 收敛，断线/代理中断/休眠/服务器重启后不丢事件，且无需 Last-Event-ID 或事件回放。 (pos_msqa3l1a_8e2d36e26b)
- SSE 与 WebSocket 在本场景的端到端延迟无实质差异（均为亚秒级推送），因此实时性不构成选择 WebSocket 的理由。 (pos_msqa3l1a_8e2d36e26b)
- 纯轮询在 5 秒间隔可满足『秒级延迟可接受』的目标，但空闲时也持续重建 HumanView，对单文件 JSON 存储构成无谓负载；SSE 仅在变化时触发重取，效率更高。 (pos_msqa3l1a_8e2d36e26b)
- 现状前端 useDeliberation 的 onerror 处理在首次瞬时错误即关闭 EventSource 并永久转轮询，弱化了 SSE 收益；应依赖 EventSource 原生自动重连，并以延迟/并行轮询作为兜底。 (pos_msqa3l1a_8e2d36e26b)
- SSE 在缓冲型代理/CDN 之后可能停顿；本地优先部署规避了该风险，但需文档化 X-Accel-Buffering: no 等缓冲处理以备未来经代理部署。 (pos_msqa3l1a_8e2d36e26b)
- 当前 SSE 实现是『通知通道』而非数据通道：web 端忽略事件载荷，仅在收到 event/run.update 消息后全量重拉 GET /api/deliberations/:id 的 HumanView；因此事件丢失不会造成状态丢失，任何后续触发或轮询都能自愈。 (pos_msqa3l1i_36b1e20ea1)
- 服务端 /api/stream 已具备：15s 心跳注释帧、retry: 3000 重连指令、no-cache/no-transform 头、按 deliberationId 过滤的进程内 EventBus fan-out，且 stream 路由被排除在全局互斥锁之外，不阻塞写路径——现有实现与单进程 local-first 架构契合良好。 (pos_msqa3l1i_36b1e20ea1)
- 现有客户端兜底是『粘性』的：EventSource 首次触发 onerror 即 close 并永久切换为 5s 轮询，直至页面重载或组件重挂载——服务器重启或瞬时网络抖动后无法自动恢复 SSE，这是保持 SSE 方案必须修复的最主要缺陷。 (pos_msqa3l1i_36b1e20ea1)
- SSE 在 API 层可零新增运行时依赖实现与集成测试：node:http 直接输出 SSE 帧；本机 Node v24.14.0 实测没有全局 EventSource 客户端（typeof EventSource === 'undefined'），但用内置 fetch 流式读取+帧解析（约 30 行测试辅助）即可做端到端断言，本评审已实测通过；浏览器端 EventSource 为原生 API，服务端零依赖。 (pos_msqa3l1i_36b1e20ea1)
- 切换到 WebSocket 没有收益只有成本：写路径固定为 REST POST（约束），双向能力完全闲置；Node http 无内置服务端 WebSocket，必须新增运行时依赖 ws 或手写 RFC6455（掩码、分片、ping/pong、关闭握手，高风险）；客户端需手写自动重连与指数退避（EventSource 内建）；Vite dev 代理需额外 ws:true 配置。 (pos_msqa3l1i_36b1e20ea1)
- 保持 SSE 优于退化为纯轮询：轮询最坏 5s 延迟虽满足『秒级延迟可接受』，但盲跑/评审运行期间 run.update 事件突发正是用户围观的核心时刻，亚秒级触发显著优于固定间隔；PRD 建议技术栈明确预留『SSE 或 WebSocket 推送状态和事件』，且现有 bus+stream 代码已可用，保持成本低于新建成本。 (pos_msqa3l1i_36b1e20ea1)
- 事件驱动重拉在事件突发时可能比 5s 轮询更频繁（run.update 风暴导致连续多次全量 GET），需在客户端做尾随去抖（~300ms）合并重拉，否则把延迟优化变成请求放大。 (pos_msqa3l1i_36b1e20ea1)
- 5s 轮询兜底已实现且天然覆盖全部要求的故障模式（断线/代理中断/休眠/服务器重启——无连接状态即无连接故障），应保留为可测试的降级路径；建议兜底间隔收紧至 3s 以贴近秒级目标。 (pos_msqa3l1i_36b1e20ea1)
- 应为 SSE 事件补加单调递增 id: 字段并支持 Last-Event-ID（成本极低），为未来前端直接消费增量载荷留升级路径；MVP 阶段因通知通道语义无需事件重放缓冲。 (pos_msqa3l1i_36b1e20ea1)
- jsdom 测试环境未实现 EventSource，web 层 hook 测试需最小 test double——这反而是优势：onerror/自动重连/兜底切换路径可确定性模拟；若 API 层测试需要真实客户端语义，可加 eventsource 作为 devDependency（不影响运行时依赖面），MVP 可不用。 (pos_msqa3l1i_36b1e20ea1)

### Unresolved conflicts
- Vite dev proxy /api forwarding and its buffering behavior toward SSE streams is unverified (vite.config.ts not covered by provided material) — if it buffers, events stall and the fallback polling cadence becomes the de facto latency ceiling
- Target deployment chain (non-localhost) proxy/CDN buffering behavior for SSE is untested; X-Accel-Buffering: no-style handling is only documented, not validated
- Full HumanView GET rebuild cost on the single-file JSON store is unmeasured — under event-storm refetch and 3–5s polling it is the dominant factor in end-to-end latency and idle load, which B's claim-5 also flags
- Sticky-onerror fix relies on native EventSource auto-reconnect semantics across proxies/idle/sleep on the actual browser targets; deterministic coverage needs the jsdom test double path to be built
- Multi-tab/multi-window concurrent subscriptions against HTTP/1.1 per-domain connection limits are unverified

> ⚠ Unresolved conflicts are NOT hidden from the final decision.

## Challenges & Responses

- **在单进程、单文件存储下，如果服务器重启或 SSE 连接被代理/休眠中断，你的方案如何保证客户端不丢事件？请给出机制、恢复点与可验证条件。** (target claim:claim_run_msq9tfum_5846e783be_1, status answered)
  - Response: （响应由 m1-operator 依据 Worker B 已提交的 Position 整理）
方案要点：推荐保持 SSE 作为实时更新的主通道并加固现状实现，保留并强化已有的 5 秒轮询作为可测试的降级兜底，不引入 WebSocket。核心理由：当前 SSE 是『通知通道』语义——客户端忽略事件载荷，收到触发后全量重拉 HumanView——事件丢失不产生状态丢失，轮询兜底与 SSE 在正确性上完全等价，兜底路径天然覆盖断线/代理/休眠/重启全部要求的故障模式；SSE 在 Node 下零新增运行时依赖即可实现与集成测试（node:http 服务端 + 内置 fetch 流式帧解析，本评审已实测通过；Node 无全局 EventSource 客户端这一点也已实测确认）；WebSocket 的双向能力因写路径固定为 REST POST 而完全闲置，却要付出新增运行时依赖 ws 或手写 RFC6455、手写重连退避、Vite 代理额外配置的成本；纯轮询虽满足『秒级延迟可接受』，但在产品核心时刻（围观 Blind Run 实时推进时的 run.update 事件突发）劣化体验，且会废弃 PRD 建议技术栈已预留的推送通道与现成代码。必须做的加固：修复客户端『粘性』降级缺陷（首次 onerror 即永久放弃 SSE，服务器重启后无法自动恢复）、事件风暴时对重拉做尾随去抖、补加单调 id: 与 Last-Event-ID 为未来增量载荷留升级路径。
生效条件：出现服务器主动发起指令或双向通信需求 → 重新评估 WebSocket；实测 SSE 在 Vite dev proxy 或目标部署链路持续不稳定（持续缓冲/频繁断连）→ 降级为纯轮询，仍满足秒级目标；前端改为直接消费事件增量载荷（不再全量重拉）→ 必须启用 id:/Last-Event-ID 与重放缓冲，并重新评审通道选择；单进程约束解除、需要跨进程/多节点广播 → 进程内 EventBus 整体失效，需外部基础设施，另立 ADR；团队评估通知通道维护成本高于其价值（页面仅需固定间隔刷新）→ 删除 bus+stream，纯轮询

## Evidence

- **VERIFIED** (command_result) exit 0 (expected 0) in 167ms; stdout 1519 bytes
  - Targets: claim:claim-1, claim:claim-2, claim:claim-3, claim:claim-4, claim:claim-5, claim:claim-6, claim:claim-7, claim:claim_run_msq9tfum_5846e783be_1, claim:claim_run_msq9tfum_5846e783be_2, claim:claim_run_msq9tfum_5846e783be_3, claim:claim_run_msq9tfum_5846e783be_4, claim:claim_run_msq9tfum_5846e783be_5, claim:claim_run_msq9tfum_5846e783be_6, claim:claim_run_msq9tfum_5846e783be_7, claim:claim-8, claim:claim-9, claim:claim-10
  - Reproducibility: reproducible
  - Command: node scripts/evidence-scan.mjs SSE EventSource WebSocket setInterval -- package.json apps/api apps/web src
- **VERIFIED** (command_result) exit 0 (expected 0) in 147ms; stdout 641 bytes
  - Targets: claim:claim-1, claim:claim-2, claim:claim-3, claim:claim-4, claim:claim-5, claim:claim-6, claim:claim-7, claim:claim_run_msq9tfum_5846e783be_1, claim:claim_run_msq9tfum_5846e783be_2, claim:claim_run_msq9tfum_5846e783be_3, claim:claim_run_msq9tfum_5846e783be_4, claim:claim_run_msq9tfum_5846e783be_5, claim:claim_run_msq9tfum_5846e783be_6, claim:claim_run_msq9tfum_5846e783be_7, claim:claim-8, claim:claim-9, claim:claim-10
  - Reproducibility: reproducible
  - Command: node scripts/evidence-scan.mjs text/event-stream retry: 3000 heartbeat EventSource -- apps/api apps/web src
- **VERIFIED** (command_result) exit 0 (expected 0) in 5030ms; stdout 48 bytes
  - Targets: claim:claim-1, claim:claim-2, claim:claim-3, claim:claim-4, claim:claim-5, claim:claim-6, claim:claim-7, claim:claim_run_msq9tfum_5846e783be_1, claim:claim_run_msq9tfum_5846e783be_2, claim:claim_run_msq9tfum_5846e783be_3, claim:claim_run_msq9tfum_5846e783be_4, claim:claim_run_msq9tfum_5846e783be_5, claim:claim_run_msq9tfum_5846e783be_6, claim:claim_run_msq9tfum_5846e783be_7, claim:claim-8, claim:claim-9, claim:claim-10, claim:claim-1, claim:claim-2, claim:claim-3, claim:claim-4, claim:claim-6, claim:claim_run_msq9tfum_5846e783be_1, claim:claim_run_msq9tfum_5846e783be_2, claim:claim_run_msq9tfum_5846e783be_3, claim:claim_run_msq9tfum_5846e783be_4, claim:claim_run_msq9tfum_5846e783be_5, claim:claim_run_msq9tfum_5846e783be_6, claim:claim-8, claim:claim-9, claim:claim-10
  - Reproducibility: reproducible
  - Command: node C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js run typecheck
- **VERIFIED** (command_result) exit 0 (expected 0) in 13007ms; stdout 8043 bytes
  - Targets: claim:claim-1, claim:claim-2, claim:claim-3, claim:claim-4, claim:claim-5, claim:claim-6, claim:claim-7, claim:claim_run_msq9tfum_5846e783be_1, claim:claim_run_msq9tfum_5846e783be_2, claim:claim_run_msq9tfum_5846e783be_3, claim:claim_run_msq9tfum_5846e783be_4, claim:claim_run_msq9tfum_5846e783be_5, claim:claim_run_msq9tfum_5846e783be_6, claim:claim_run_msq9tfum_5846e783be_7, claim:claim-8, claim:claim-9, claim:claim-10, claim:claim-1, claim:claim-2, claim:claim-3, claim:claim-4, claim:claim-6, claim:claim_run_msq9tfum_5846e783be_1, claim:claim_run_msq9tfum_5846e783be_2, claim:claim_run_msq9tfum_5846e783be_3, claim:claim_run_msq9tfum_5846e783be_4, claim:claim_run_msq9tfum_5846e783be_5, claim:claim_run_msq9tfum_5846e783be_6, claim:claim-8, claim:claim-9, claim:claim-10
  - Reproducibility: reproducible
  - Command: node C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js test

## Review

- Recommendation: **candidate_a**
- Evidence sufficiency: sufficient
- Rubric fit: 5
- Rubric latency: 4
- Rubric complexity: 4
- Rubric reliability: 5
- Rubric testability: 5

Both candidates converge on the same core decision — keep SSE, avoid WebSocket, fix the sticky onerror fallback — and the review evidence verifies both. Candidate A wins on depth and verification: (1) it documents the existing /api/stream implementation in verified detail (heartbeat, retry: 3000, no-cache/no-transform, per-deliberationId EventBus fan-out, stream route excluded from the write-path mutex) and explicitly grounds the choice in the PRD's reserved push channel, giving the strongest architecture fit evidence; (2) it carries actual empirical verification — node:http + built-in fetch streaming SSE integration test run and the confirmed absence of a global EventSource in Node v24.14.0 — which directly substantiates the testability rubric, while B makes no testability claims at all; (3) its hardening plan is more complete and lower-risk than B's: trailing debounce (~300ms) prevents run.update event storms from amplifying full HumanView refetches (a real risk B does not address), keeping the tested 5s polling as a first-class, deliberately testable fallback that covers all required failure modes (断线/代理/休眠/重启), and adding id:/Last-Event-ID as a near-zero-cost upgrade path is strictly better than B's blanket 'no replay needed' stance since MVP semantics don't require replay but the field is free. Complexity is comparable between the two (zero new runtime deps either way); A's added items are small and each maps to a stated risk or decision condition. B's recommendation is sound but thinner: its claims about SSE's resilience and latency parity with WebSocket are plausible and evidence-supported, yet its fallback story (native reconnect + delayed/parallel polling) is less precisely specified and untested, and its claim-7 admits the buffering-proxy risk without a mitigation path. Recommendation: candidate_a.

### Unresolved risks
- Vite dev proxy /api forwarding and its buffering behavior toward SSE streams is unverified (vite.config.ts not covered by provided material) — if it buffers, events stall and the fallback polling cadence becomes the de facto latency ceiling
- Target deployment chain (non-localhost) proxy/CDN buffering behavior for SSE is untested; X-Accel-Buffering: no-style handling is only documented, not validated
- Full HumanView GET rebuild cost on the single-file JSON store is unmeasured — under event-storm refetch and 3–5s polling it is the dominant factor in end-to-end latency and idle load, which B's claim-5 also flags
- Sticky-onerror fix relies on native EventSource auto-reconnect semantics across proxies/idle/sleep on the actual browser targets; deterministic coverage needs the jsdom test double path to be built
- Multi-tab/multi-window concurrent subscriptions against HTTP/1.1 per-domain connection limits are unverified

## Decision

- Action: **approve**
- Selected refs: position:pos_msqa3l1i_36b1e20ea1

M1 operator gate: candidate_a. Both candidates converge on the same core decision — keep SSE, avoid WebSocket, fix the sticky onerror fallback — and the review evidence verifies both. Candidate A wins on depth and verification: (1) it documents the existing /api/stream implementation in verified detail (heartbeat, retry: 3000, no-cache/no-transform, per-deliberationId EventBus fan-out, stream route excluded from the write-path mutex) and explicitly grounds the choice in the PRD's reserved push channel, giving the strongest architecture fit evidence; (2) it carries actual empirical verification — node:http + built-in fetch streaming SSE integration test run and the confirmed absence of a global EventSource in Node v24.14.0 — which directly substantiates the testability rubric, while B makes no testability claims at all; (3) its hardening plan is more complete and lower-risk than B's: trailing debounce (~300ms) prevents run.update event storms from amplifying full HumanView refetches (a real risk B does not address), keeping the tested 5s polling as a first-class, deliberately testable fallback that covers all required failure modes (断线/代理/休眠/重启), and adding id:/Last-Event-ID as a near-zero-cost upgrade path is strictly better than B's blanket 'no replay needed' stance since MVP semantics don't require replay but the field is free. Complexity is comparable between the two (zero new runtime deps either way); A's added items are small and each maps to a stated risk or decision condition. B's recommendation is sound but thinner: its claims about SSE's resilience and latency parity with WebSocket are plausible and evidence-supported, yet its fallback story (native reconnect + delayed/parallel polling) is less precisely specified and untested, and its claim-7 admits the buffering-proxy risk without a mitigation path. Recommendation: candidate_a.

### Conditions
- 上线前为 SSE 增加 last-event-id/EventSource 重放，验证重启不丢事件
- 用真实浏览器会话做断线/休眠恢复测试
- 若部署演进为多进程或多用户，重新评估 WebSocket/广播方案

### Dissent / retained risks
- Vite dev proxy /api forwarding and its buffering behavior toward SSE streams is unverified (vite.config.ts not covered by provided material) — if it buffers, events stall and the fallback polling cadence becomes the de facto latency ceiling
- Target deployment chain (non-localhost) proxy/CDN buffering behavior for SSE is untested; X-Accel-Buffering: no-style handling is only documented, not validated
- Full HumanView GET rebuild cost on the single-file JSON store is unmeasured — under event-storm refetch and 3–5s polling it is the dominant factor in end-to-end latency and idle load, which B's claim-5 also flags
- Sticky-onerror fix relies on native EventSource auto-reconnect semantics across proxies/idle/sleep on the actual browser targets; deterministic coverage needs the jsdom test double path to be built
- Multi-tab/multi-window concurrent subscriptions against HTTP/1.1 per-domain connection limits are unverified

## Traceability

- Resolved refs: 31
- Unresolved refs: 0

## Timeline

- `2026-08-12T15:55:26.163Z` participant.added (m1-operator)
- `2026-08-12T15:55:26.168Z` deliberation.created (m1-operator)
- `2026-08-12T15:55:26.174Z` participant.added (m1-operator)
- `2026-08-12T15:55:26.180Z` participant.added (m1-operator)
- `2026-08-12T15:55:26.187Z` participant.added (m1-operator)
- `2026-08-12T15:55:26.195Z` task_packet.frozen (m1-operator)
- `2026-08-12T15:55:26.207Z` blind_run.started (protocol-engine)
- `2026-08-12T16:03:19.486Z` run.committed (run_msq9tfuk_7c6bd1c931)
- `2026-08-12T16:03:19.495Z` run.committed (run_msq9tfum_5846e783be)
- `2026-08-12T16:03:19.509Z` blind_run.completed (protocol-engine)
- `2026-08-12T16:03:19.518Z` candidates.revealed (protocol-engine)
- `2026-08-12T16:03:19.519Z` challenging.started (protocol-engine)
- `2026-08-12T16:03:19.545Z` challenge.created (run_msq9tfuk_7c6bd1c931)
- `2026-08-12T16:03:19.553Z` challenge.answered (run_msq9tfum_5846e783be)
- `2026-08-12T16:03:19.561Z` verifying.started (protocol-engine)
- `2026-08-12T16:03:19.738Z` evidence.recorded (verifier)
- `2026-08-12T16:03:19.890Z` evidence.recorded (verifier)
- `2026-08-12T16:03:24.927Z` evidence.recorded (verifier)
- `2026-08-12T16:03:37.943Z` evidence.recorded (verifier)
- `2026-08-12T16:03:37.951Z` evidence_pack.frozen (protocol-engine)
- `2026-08-12T16:04:05.887Z` review.submitted (run_msqa3zae_5755338d16)
- `2026-08-12T16:04:05.916Z` decision.recorded (m1-operator)
