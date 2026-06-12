# Neogebra 整改路线图（Roadmap）

> 目标：把一个工程质量已经很高、但建立在 GeoGebra 私有 DOM 逆向之上的原型，
> 整改为**非侵入、对升级有韧性、对插件可信赖**的插件框架。
>
> 贯穿全文的第一设计原则：**非侵入式设计哲学（Non-intrusive by design）**。
> 一个理想的扩展框架应当像一位有教养的客人——尊重宿主的原生体验，
> 把对 GeoGebra 既有界面、性能与文档的干扰降到最低。
> 注入后的 GeoGebra 在外观、启动表现、文件产物上都应与官方版保持一致，
> 框架的能力对需要它的人随手可得（约定手势 Right-Shift 唤出），
> 对不使用它的人则完全无感、不构成任何视觉或认知负担。
>
> 质量基线定位：**与官方体验无差别（Indistinguishable-from-stock）**。
> 即一个普通用户在日常使用、乃至打开 DevTools 随意查看时，
> 都不应感到这是一个被改动过的、不稳定的或带有杂质的 GeoGebra。
> 这既是产品观感的要求，也是对宿主软件的基本尊重。

---

## 0. 设计原则（贯穿所有阶段）

1. **最小视觉足迹（Minimal visual footprint）**：不向官方界面新增按钮、图标、菜单项或角标，
   避免改变用户已经熟悉的 GeoGebra 布局。框架 UI 仅在用户主动唤出时出现，平时完全退场。
2. **零运行噪声（Quiet runtime）**：正常路径下不向 GeoGebra 控制台输出任何带
   `[GGB-Extend]` / `[ngb-ai]` / `[plugin:*]` 字样的日志，保持宿主控制台清爽。
   诊断日志只在显式 debug 开关下出现。
3. **干净的命名空间（Clean namespace）**：页面运行时不在全局对象、DOM 属性、id、网络 UA 上
   散布框架专有标识，避免与宿主或其他脚本产生命名冲突与混淆。命名一律中性化、随机化或闭包内化。
4. **文档可移植（Portable documents）**：任何写入 GeoGebra 文档（.ggb）或磁盘的内容，
   要么不写，要么在保存/卸载前彻底清理，确保用户分享出去的文件在任何环境下都能干净打开。
5. **优雅降级，绝不错乱（Graceful degradation）**：DOM 探测失败时宁可不渲染，
   也绝不在官方界面上留下错位的残骨——一个错位的元素比一个缺失的功能更损害宿主体验。

> 一个值得强调的工程认识：**对"无差别体验"威胁最大的不是 UI 元素，而是运行时的杂质**。
> 现有代码已经做到了"界面零新增按钮"，但 console 日志、`window.__ggbExtend*__` 全局、
> `data-ngb-*` 属性、`.ggb` 里的 `ngbUI…` 对象，恰恰是任何稍加查看的用户最先撞见的"杂质"。
> P0 阶段的足迹治理主要在清理这些，而非界面层面。

---

## 阶段总览

| 阶段 | 主题 | 出口标准 |
|------|------|----------|
| **P0** | 正确性与足迹治理 | 不丢数据、零运行杂质、文件可移植 |
| **P1** | 抗 GeoGebra 升级的韧性 | DOM 适配层 + 自检降级 + 真机 E2E |
| **P2** | 安全与可信边界收紧 | 网络/IPC/插件信任模型闭环 |
| **P3** | 非侵入前提下的体验打磨 | 主题统一、i18n、唤出手势可靠 |
| **附录 A** | AI Assistant 专项优化 | 持久化、流式/取消、渲染、足迹对齐 |

每条目标注：**问题 → 方案 → 验收**。建议严格按阶段推进——
P0 的问题在用户手里必然爆发，P1 的脆弱性在 GeoGebra 升级时必然爆发。

---

## P0 — 正确性与足迹治理（先做，阻断式）

这一阶段不加功能，只堵漏。包含两类：会丢数据/损坏的硬 bug，和影响"无差别体验"的运行时足迹。

### P0-1　存储未持久化（数据丢失，最高优先级）
- **问题**：`runtime/src/index.js` 的 `makeStorage` 直接返回 `MemoryStorage`
  （注释自承 "v0.2: in-memory"）。但 AI 助手把 API key、会话标题写进 `ctx.storage`，
  **重启 GeoGebra 后全部丢失**。host bridge 的 `get/set-settings` IPC 已存在却没接上。
- **方案**：实现 `HostStorage`，以 `pluginId` 为命名空间，读写经 `ggb-extend:get-settings`
  / `set-settings`，落到 `state.json` 的 `settings[pluginId]`。内存层做写穿缓存。
  敏感字段（API key）至少做混淆存储，不以明文键名直观出现在 state.json（见 P0-6）。
- **验收**：配置 API key → 退出 → 重开，key 仍在；单测覆盖跨实例读写。

### P0-2　disable→enable→disable 资源泄漏
- **问题**：`loader.js` 的 `loadOne` 只在加载时注册一次 docks/rows 清理 disposable；
  `runDisposables` 是 `pop` 式一次性消费。第一次 disable 后清理函数已被消费殆尽，
  第二次 enable 新建的 native row / dock，在再次 disable 时不会被销毁，DOM 与监听器泄漏。
- **方案**：把 disposable 生命周期与"每次 enable"绑定，而非"一次加载"。
  enable 时重建 disposable 列表，disable 时全部执行并清空；或让 ctx 维护
  per-activation 的 disposable 栈。
- **验收**：反复 enable/disable 同一插件 N 次，DOM 中容器节点数与监听器数不增长。

### P0-3　辅助对象污染用户文件（文档可移植）
- **问题**：`createNativeRow` 用 `evalCommand("ngbUI…=1")` 创建**真实** GeoGebra 对象
  来借壳渲染。该对象会被写进 .ggb 文件、进入撤销栈。把文件分享给没装框架的人，
  对方会看到一堆莫名的数字对象——破坏文件的可移植性，也暴露了框架的存在。
- **方案**（保证文档干净，建议组合）：
  1. 监听保存事件（或 hook 文件导出路径），在序列化前临时删除所有辅助对象，保存后重建；
  2. 评估能否改用**不进入构造存档**的对象类型或内部命名空间（研究 GeoGebra 是否有
     auxiliary/internal 对象不被持久化）；
  3. 兜底：辅助对象名去框架品牌化，改为中性随机前缀（见 P0-5），降低被识别概率。
- **验收**：创建会话后保存 .ggb，用纯净版 GeoGebra 打开，看不到任何辅助对象。

### P0-4　state.json 并发写损坏
- **问题**：多个注入实例共享同一份 `state.json`，`writeState` 是非原子的
  `writeFileSync`，读-改-写无锁。两个 GeoGebra 同时改插件开关或网络批准，会互相覆盖、
  极端情况写出半截 JSON 导致全局状态损坏。
- **方案**：原子写（写 `state.json.tmp` 再 `rename`）；写前重读合并，缩小读-改-写窗口；
  解析失败时回退到 `.bak` 而非清零。
- **验收**：并发压力测试（多进程交替写）后 state.json 始终是合法 JSON 且无丢更新。

### P0-5　运行时命名空间清理（无差别体验核心）
- **问题**：页面里散布框架专有标识——`window.__ggbExtendRuntime__` /
  `__ggbExtendToggle__` / `__ggbExtendPanel__` / `__ggbExtendReady__` /
  `__ggbExtendTheme__`，DOM 属性 `data-ngb-container` / `data-ngb-row` /
  `data-ngb-dock` / `data-ngb-marble`，对象名前缀 `ngbUI`，host id `ggb-extend-host-root`，
  bridge `window.ggbExtendHost`。这些既可能与宿主/其他脚本冲突，也让页面显得不"纯净"。
- **方案**：
  - 全局变量：能进闭包的进闭包；必须挂 window 的，改为**单个随机化键**（如启动时
    生成的非语义 key），插件与面板通过约定句柄获取，而非可猜的名字。
  - DOM 属性 / id：改为中性、随机化或哈希化命名，不含框架品牌字样。
  - E2E 钩子（`__ggbExtendReady__`、`ggb-extend:ready` 事件）：仅在测试构建注入，
    生产构建剥离。
- **验收**：在生产构建的注入实例里，`Object.keys(window)` 与 DOM 搜索框架字样均无命中；
  E2E 仍可通过测试构建跑通。

### P0-6　控制台静默化（无差别体验核心）
- **问题**：`proxy-core` / `preload` / `runtime` / `loader` / `panel-manager`
  在正常启动路径就 `console.log("[GGB-Extend] …")`，污染宿主控制台。
- **方案**：引入统一日志器，默认 **silent**；仅当 `GGB_EXTEND_DEBUG` 或用户在设置里
  显式开启时输出。错误同样走该日志器（生产静默，debug 可见），保留 fail-safe 行为不变。
  注意 AI 助手的 `[ngb-ai]` 已经做了 debug gating，把全框架对齐到同一标准。
- **验收**：纯净启动 + 正常操作，控制台零输出；开 debug 后日志完整。

### P0-7　生命周期钩子超时护栏
- **问题**：`loadAll` 串行 `await` 每个插件的 `onLoad/onEnable`。一个挂起（如 await 一个
  永不 resolve 的网络）的插件会卡死整条加载链，面板与其余插件全部起不来——
  既是稳定性问题，也直接拖慢 GeoGebra 启动，破坏"启动表现与官方一致"。
- **方案**：给每个生命周期钩子加 watchdog（如 10s），超时标记该插件 failed 并继续，
  错误已 per-plugin 捕获，补上超时这一维度。
- **验收**：植入一个故意 hang 的测试插件，框架仍在限定时间内完成加载、面板可用。

---

## P1 — 抗 GeoGebra 升级的韧性

整个融合层建立在对 GeoGebra Classic 6 私有 DOM（`.avItem` / `.elemText` /
`.marblePanel` / `.dockPanelParent` / `.algebraPanel`）和硬编码像素（48 / 58 / 68px）的
逆向之上。GeoGebra 一次升级即可让一切静默失效或错位。本阶段把"脆弱"变成"可检测、可降级"。

### P1-1　抽出 DOM 适配层
- **问题**：选择器与像素常量散落在 `algebra-row.js`、`algebra-dock.js` 内，
  与逻辑耦合，无法集中维护，也无法按版本切换。
- **方案**：新建 `ggb-dom-adapter` 模块，集中所有选择器、尺寸常量、节点定位函数。
  按 GeoGebra 版本号挂 **profile**：新版本只需新增一份 profile，核心逻辑不动。
  尺寸尽量改为**运行时量测**（measure 一个真实 marble/row）而非写死。
- **验收**：算法代码内不再出现裸选择器/魔法像素；切换 profile 可在不改逻辑下适配。

### P1-2　启动自检与优雅降级
- **问题**：当前若选择器未命中，行为未定义——最坏是在官方界面上画出错位的残骨，
  这比"功能缺失"更损害宿主体验。
- **方案**：启动时跑一次 self-check（探测每个关键选择器是否命中、量测是否合理）。
  - 全部通过 → 正常融合；
  - 部分失败 → **优雅降级**：不渲染 native row / dock，面板（仅在用户主动唤出时）
    给出一行"当前 GeoGebra 版本未完全适配"的低调提示；
  - 关键失败 → 完全退场，不在界面留下任何视觉痕迹。
- **验收**：人为破坏一个选择器，注入实例不在界面上留下任何错位元素；唤出面板有降级提示。

### P1-3　共享 MutationObserver
- **问题**：每个 native row、每个 dock 各自在整棵树挂 subtree observer。
  会话/行数增多时性能下降，且 observer 风暴可能拖慢 GeoGebra，让宿主出现卡顿。
- **方案**：runtime 层维护**单个**共享 observer，向订阅者分发；统一 debounce。
- **验收**：N 个 native row 场景下 observer 数恒为 1；CPU 占用不随行数线性上升。

### P1-4　真机 E2E + 像素回归
- **问题**：单测覆盖好，但都不 against 真实 GeoGebra。DOM 逆向方案最需要的护栏恰恰缺失。
- **方案**：用 `ggb-test/` 里那份 GeoGebra app + Playwright 跑真机 E2E：
  注入→唤出面板→创建 native row→量测 marble/row 像素与官方基准比对（截图回归）。
  把它接进 CI，作为升级 GeoGebra 时的回归闸门。
- **验收**：E2E 在 CI 绿；故意改坏适配层能让像素回归测试变红。

### P1-5　`transformPluginSource` 退役为 dev-only
- **问题**：`loader.js` 用正则把 `export default` / `import ... from '@neogebra/sdk'`
  改写为可 `new Function` 执行的形式。正则会误命中字符串/注释中的同形文本，
  1300 行的 AI 助手已逼近临界；一旦炸裂表现为插件静默失效。
- **方案**：要求插件发布**预 bundle 的 IIFE/UMD 产物**（examples 已如此），
  把 ESM 正则转换降级为仅 dev 便利；或在桌面端"安装插件"时用 esbuild 真编译一次落盘。
- **验收**：AI 助手等大插件以 bundle 形式加载，不经正则转换；转换器仅在 dev 路径出现。

---

## P2 — 安全与可信边界收紧

### P2-1　SSRF 补 DNS 解析层
- **问题**：`isBlockedHost` 只校验主机名**字面量**。公网域名解析到内网 IP
  （DNS rebinding）可绕过，插件得以触达本机/内网。
- **方案**：在 `https.request` 前对解析结果做校验——用 `dns.lookup` 取 IP，
  对 IP 复用现有私网/保留段判断；或用 request 的 `lookup` 选项钩住，拒绝解析到内网的连接。
- **验收**：构造一个解析到 `127.0.0.1` 的公网域名，请求被拒。

### P2-2　IPC 调用方身份校验
- **问题**：`ggb-extend:net-fetch` 信任 `request.pluginId`。任何 renderer 代码都能以
  **任意 pluginId** 发起请求，冒用其他插件已批准的 host，绕过网络授权。
- **方案**：校验 `event.sender`，把请求与真实来源插件绑定，而非由 payload 自报 pluginId。
  同时收紧 `read-plugin-source` 等通道的调用约束。
- **验收**：伪造 pluginId 的请求拿不到其他插件的 host 批准。

### P2-3　新插件默认禁用 + 主动确认
- **问题**：`enabled[m.id] !== false` 表示**默认启用**——往 `GGB_Plugins` 拖一个文件夹，
  下次启动即执行其任意代码。既是安全问题，也违背"用户未明确同意就不运行"的非侵入原则。
- **方案**：新插件默认 **disabled**；仅在用户主动唤出面板时提示"发现新插件，是否启用"，
  保持"界面平时不打扰用户"的原则——不主动弹任何东西。
- **验收**：新拖入的插件不自动执行；面板内可一键启用。

### P2-4　插件来源与完整性（可选，视目标）
- **方案**：为插件目录记录哈希清单，加载前比对，篡改则拒载并标记。
  这条偏深度防护，在当前质量目标下可作为后续可选项。

---

## P3 — 非侵入前提下的体验打磨

> 本阶段刻意**不做**向官方界面新增可见入口——那与最小视觉足迹原则冲突。
> 重点是让"已经唤出后"的体验和"唤出手势本身"更可靠、更与宿主协调。

### P3-1　主题 token 统一（明暗双态）
- **问题**：现存三套主题机制并行——`readGgbTheme()`（CSS 变量）、`detectTheme()`
  （背景亮度采样）、AI 助手里硬编码的浅色值（`.collapsed .title` 写死 `rgb(0,0,0)`、
  textarea/modal 写死 `#fff`）。暗色模式下 AI 助手会刺眼地不协调，**与宿主观感割裂**。
- **方案**：SDK 输出一套完整明暗双态 token（surface / border / text 分层 + 宿主字体），
  所有 UI 只消费 token，删除一切硬编码颜色。用共享 observer 监听主题切换并广播，
  替代"仅面板打开时刷新一次"。
- **验收**：切到暗色，面板、设置弹窗、AI 会话行全部随之变化，无残留浅色硬编码。

### P3-2　字体与质感对齐
- **问题**：面板用 Roboto，代数区用 mathsans/calibri；hybrid 行保留的官方 ⋯ 菜单作用在
  隐藏的辅助数字对象上，点开会暴露怪异内容。
- **方案**：面板/弹窗改为消费 `readGgbTheme()` 的宿主字体；对 hybrid 行的 ⋯ 菜单，
  评估拦截替换为插件菜单，或隐藏该按钮（避免暴露辅助对象、保持行为干净）。
- **验收**：UI 字体与代数区一致；⋯ 菜单不暴露辅助对象相关项。

### P3-3　唤出手势的可靠性与可配置
- **问题**：Right-Shift 是唯一入口，符合最小视觉足迹原则，但：部分紧凑/外接键盘无独立右 Shift；
  与某些输入法/系统快捷键可能冲突；用户换机器后不知道手势。
- **方案**（保持界面零新增入口）：
  - 手势**可配置**（存设置），默认仍 Right-Shift；
  - 提供 1–2 个备选手势（如连续三击某键、特定组合键）作为后备；
  - **不**在 GeoGebra 界面内做常驻提示——把手势说明放在桌面 manager（非 GeoGebra 内）的
    文档/首启引导里，让宿主界面保持干净，同时用户仍能学到手势。
- **验收**：无右 Shift 的键盘可用备选手势唤出；GeoGebra 界面内无新增提示元素。

### P3-4　modal 的键盘与无障碍
- **问题**：设置面板与网络批准弹窗都无 Esc 关闭、无焦点陷阱。`panel-manager._releaseFocus`
  已认真处理"关闭时归还焦点给 GeoGebra"（这点对体验很关键——别让 GeoGebra 像卡住），
  打开侧也要同等严谨。
- **方案**：modal 支持 Esc 关闭、焦点陷阱、关闭后焦点归还（复用 `_releaseFocus` 思路）。
  网络批准弹窗默认聚焦 **Block**（安全默认）。
- **验收**：键盘可完整操作 modal；关闭后 GeoGebra 立即响应输入。

### P3-5　i18n（与宿主语言一致）
- **问题**：UI 为英文，而 GeoGebra 本身全面本地化。一个英文面板出现在中文 GeoGebra 里，
  与宿主语言割裂，观感突兀。
- **方案**：SDK 提供极简 i18n helper，读取 GeoGebra 当前语言（语言 API 或 DOM lang），
  先做 zh-CN / en 两份；面板、弹窗、AI 助手共用。
- **验收**：中文 GeoGebra 下 UI 自动中文；英文环境英文。

---

## 建议执行顺序与依赖

```
P0 (阻断式，先全做)
  ├─ P0-1 持久化 ──┐
  ├─ P0-2 disposable │ 正确性
  ├─ P0-3 文件可移植 ┤
  ├─ P0-4 原子写 ────┘
  ├─ P0-5 命名空间 ──┐
  ├─ P0-6 静默日志 ──┤ 足迹治理
  └─ P0-7 钩子超时 ──┘
       ↓
P1 (抗升级)  P1-1 适配层 → P1-2 自检降级 → P1-4 E2E（闸门）
             P1-3 共享 observer、P1-5 转换器退役 可并行
       ↓
P2 (安全)    P2-1/2/3 闭环网络与插件信任
       ↓
P3 (体验)    P3-1 主题 → 其余可并行
       ↓
附录 A       AI Assistant 专项（依赖 P0-1 持久化）
```

理由：P0 的数据丢失与运行杂质在用户首次使用就会暴露；P1 的 DOM 脆弱在 GeoGebra
升级时必然爆发，且 E2E 是后续所有改动的回归闸门；P2 收紧边界；P3 在非侵入前提下打磨观感。

---

## 附录 A — AI Assistant 专项优化

AI 助手是框架的旗舰插件（"嵌入式 agent，融入环境，直接调用本地工具"），
它的体验直接决定框架的价值上限。以下优化多数依赖 P0-1（持久化）落地。

### A-1　持久化（依赖 P0-1，最高优先级）
API key、会话标题、各项设置现在存在内存里，重启即失。P0-1 完成后，这些自动落盘。
额外要求：API key 走混淆/分离存储，不在 state.json 里以直观键名明文出现——
既是安全考量，也避免用户误把含密钥的 state.json 分享出去。

### A-2　流式输出 + 可取消（体验质变）
- **现状**：无流式，`timeoutMs: 90000`，用户可能盯着 "Thinking…" 90 秒且无法取消。
  对一个"嵌入式 agent"，这是最伤体感的点。
- **方案**：
  - 短期：加**取消按钮** + elapsed 计时。取消需把 `AbortController` 贯通到 `netFetch`
    —— 当前 IPC 链路不支持中断，需在 host 侧支持请求取消。
  - 中期：`netFetch` 增加 **SSE 流式**支持，token 逐步渲染。工具 chips 的逐步显示已做得很好，
    把文本也做成流式即可。
- **验收**：长请求可中途取消；回答逐字出现而非一次性弹出。

### A-3　追加式渲染（修闪烁与选区丢失）
- **现状**：`Conversation.render()` 每次全量 `innerHTML` 重建，每个 tool-call 回调都触发一次。
  消息多了会闪烁、丢失文本选区、滚动跳动。
- **方案**：改为追加式——只 append 新消息/新 chip，复用既有节点；不必引入框架。
- **验收**：连续多轮对话无整屏闪烁，可正常选中并复制历史消息。

### A-4　会话标题自动化
- **现状**：标题需到设置面板手动改，默认是 `Conversation N`。
- **方案**：用第一条用户消息截断生成默认标题，成本极低、体验明显提升；用户仍可改名。
- **验收**：发首条消息后，会话行标题自动变为该消息摘要。

### A-5　足迹对齐
- AI 助手的 `[ngb-ai]` 日志已做 debug gating，符合 P0-6 方向——保持。
- 会话用的辅助对象命名（`ngbAiConvo*`）随 P0-3/P0-5 一并去品牌化、随机化，
  确保保存的 .ggb 不残留 AI 会话相关对象。
- 网络批准弹窗（`confirmNetAccess`）的标识与措辞去品牌化，默认聚焦 Block（见 P3-4）。

### A-6　Agent 鲁棒性（小修）
- `runAgentLoop` 的 `MAX_AGENT_ITERATIONS=6` 用尽时给出的兜底文案可更具引导性。
- `transformPluginSource` 退役（P1-5）后，AI 助手务必以 bundle 形式分发——
  它是最可能触发正则误命中的插件。
- 命令安全分类器（`classifyCommand`）已相当完善（CJK/script/markdown/risky 多层拦截），
  建议补一组对抗性单测固化这些边界，防回归。

---

*文档版本：v2 · 适配框架 v1.8.0 · 维护者：唐晓翼*
