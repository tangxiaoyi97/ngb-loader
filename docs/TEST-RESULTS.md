# 真机验证结果记录 (v0.1.0)

> 记录人:测试员(唐晓翼) · 环境:macOS · Apple Silicon (arm64) · Node v24.15.0
> 目标:GeoGebra Classic 6.0.570(folder 布局,已签名)· Electron 38

本文件记录 v0.1.0 在真机上的首次端到端验证过程、暴露的问题、修复方式,以及对注入技术稳定性的诚实评估。供后续每次 GeoGebra 升级时复查参照。

---

## 一、最终结果:✅ 通过

GeoGebra 在注入后正常启动,按 **右 Shift** 成功唤出 GGB-Extend 玻璃面板。
渲染进程 DevTools Console 关键日志(证明整条注入链打通):

```
[GGB-Extend/preload] chained original preload: .../Resources/core/preload.js   ← 链上了 GeoGebra 自己的 preload
[GGB-Extend/preload] bridge exposed as window.ggbExtendHost                      ← 我们的安全桥已暴露
[GGB-Extend/preload] panel injected into main world                             ← 面板已注入主世界并挂载
```

主进程终端关键日志:
```
[GGB-Extend] proxy core starting…
[GGB-Extend] BrowserWindow patched (preload chaining active).
[GGB-Extend] IPC channels registered. Plugins dir: ~/Library/Application Support/GeoGebra (NeoGebra)/GGB_Plugins
```

> 备注:GeoGebra 自身打印的 `language not recognized: C`、`aria-hidden ...` 警告与本框架无关,是 GeoGebra 原生行为。

---

## 二、验证过程(A 段逻辑层 + B 段真机)

### A 段(任意机器,无需 GUI)
| 步骤 | 命令 | 结果 |
|---|---|---|
| A1 构建 | `npm run build` | ✅ panel 34.9KB + proxy 组装 |
| A2 自动化测试 | `npm test` | ✅ 38/38 通过 |
| A3 浏览器预览 | `open packages/panel/preview.html` | ✅ 面板可开合,右 Shift 生效 |

### B 段(真机注入 GeoGebra)
| 步骤 | 命令 | 结果 |
|---|---|---|
| B1 复制副本 | `cp -R "/Applications/GeoGebra Classic 6.app" ~/Desktop/GGB-Test.app` | ✅ |
| B2 注入前体检 | `npm run doctor -- --path ~/Desktop/GGB-Test.app` | ✅ pristine · folder · 已签名 |
| B3 预览 | `... inject --dry-run` | ✅ 列出 3 步计划,无改动 |
| B4 注入 | `... inject` | ✅ 复制完整代理 + 清隔离 + ad-hoc 重签名 |
| B5 启动看面板 | `GGB_EXTEND_DEBUG=1 ".../MacOS/GeoGebra Classic 6"` | ✅ 面板滑出 |

---

## 三、真机暴露并修复的两个 Bug

真机测试的价值就在于此 —— 沙箱里全过的代码,真机暴露了两个问题。

### Bug #1 — CLI 默认装了"裸代理"(无面板)
**现象:** 首次 `inject` 日志显示 `Writing inline proxy payload`,面板出不来。
**根因:** CLI 只有显式传 `--proxy` 才用完整代理(`packages/proxy-core/dist`),默认回退到只负责引导、不含面板的内联代理。
**修复:** CLI 增加 `resolveDefaultProxyDir()`,默认自动定位并使用 `proxy-core/dist`;找不到才回退内联,并打印黄色警告提示先 `npm run build`。
**验证:** 重装后日志变为 `Copying proxy payload from .../proxy-core/dist`,`app/` 内含 `assets/panel.bundle.js`。

### Bug #2(关键) — Electron 38 下 BrowserWindow 补丁未生效
**现象:** 主进程报 `could not install patched BrowserWindow: Cannot redefine property: BrowserWindow`,但紧接着又误报 "patched";DevTools 不弹、右 Shift 无反应。
**根因:** Electron 38 把 `require('electron').BrowserWindow` 暴露为**不可重定义(non-configurable)的 getter**。原实现用 `Object.defineProperty` 和直接赋值去替换它,两种都失败 → 补丁实际没装上(且日志误报成功)。
**修复:** 改为**三级递进**安装策略,并新增"模块加载器劫持"兜底:
1. `Object.defineProperty`(旧/dev 版本可成)
2. 直接赋值(部分版本可成)
3. **劫持 `Module._load`**:拦截 `require('electron')`,返回一个 `Proxy` 视图,其中 `BrowserWindow` 替换为我们的子类,其余属性原样透传。
   并加入 `verify()`(检查 `require('electron').BrowserWindow === 我们的类`),只有真正生效才打印成功,否则明确报 FAILED。
**验证:** 新增针对 "non-configurable BrowserWindow(Electron 38+)" 的回归测试;真机重装后报错消失,面板正常唤出。

---

## 四、注入/加载技术稳定性评估(诚实版)

**采用的核心手法:** 在主进程用 `Module._load` 劫持 `require('electron')`,把窗口构造函数 `BrowserWindow` 换成会注入我们 `preload.js` 的子类;`preload.js` 再在渲染进程链式调用 GeoGebra 原 preload、暴露安全桥、把面板注入主世界并挂到 closed Shadow DOM。

**稳的方面:**
- `Module._load` 劫持是 Electron 生态成熟通用技术(被大量魔改工具采用),不碰 Electron 的 C++ 绑定,只在 Node CommonJS 加载层拦截,API 多年稳定。
- 侵入面极小:只接管 `require('electron')` 返回值的 `BrowserWindow` 一个属性,其余透传。
- 失败安全:全部引导逻辑包在 try/catch,补丁装不上最多面板不出,GeoGebra 照常运行。
- 无损可逆:原始负载只是被重命名为 `core`,卸载逐字节还原(SHA-256 验证);`.unpacked` 原生模块目录一并迁移/还原。
- 有回归测试守护(含 Electron 38 锁定属性场景),38/38 全过。

**需长期关注的风险(非当前问题,是维护成本):**
1. **依赖 CJS `require('electron')`** —— 若未来 GeoGebra 改为纯 ESM 主进程,`Module._load` 拦不到。短期内 ESM 主进程仍很边缘。
2. **`require.main === module` 自启动判断** —— 已加 `GGB_EXTEND_AUTOSTART=1` 环境变量作备用触发。
3. **GeoGebra/Electron 大版本升级** —— 这是所有"无侵入魔改"框架的固有成本。建议每次升级在副本上重跑 `npm run doctor` + 注入验证。

**结论:** 对 v0.1.0 与当前 GeoGebra,该方案**可靠、稳定、隔离干净、失败安全**。它与 GeoGebra 运行时实现存在耦合(任何注入式框架都无法避免),靠"升级即在副本验证"来长期保证 —— `doctor` 脚本与测试套件即为此准备。

---

## 五、待办(后续里程碑)
- [ ] B6/B7 验收闭环(放入示例插件 → 卸载还原)
- [ ] **插件加载闭环**:面板开关 → 真正 load/run 插件代码(IPC 与 SDK 均已就绪并测试,差最后串联)
- [ ] `create-ggb-plugin` 脚手架(规划书 4.3)
- [ ] 真机 Playwright + Xvfb E2E(脚本已就绪,需可下载 Electron 的环境)
