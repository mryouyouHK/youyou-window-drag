# 窗口拖动 · Window Drag

在 macOS 桌面版 Harness 里，**按住窗口最顶部任意位置往下拖，整个窗口跟着移动**。

其它平台 / 浏览器里插件不插入任何东西、也不改变任何交互（浏览器没有窗口可拖，也不该吞掉页面点击）。

## 为什么原生拖不动

macOS 桌面版是一个 `hiddenInset` 窗口：没有原生标题栏，能否移动窗口完全取决于页面里
`-webkit-app-region: drag` 的盒子。外壳把每一条 chrome 行都标了 `data-window-drag`，
`ui-web` 的 base.css 再把这个标记翻译成 darwin 的 drag 规则 —— 设计上是对的。

问题出在同一张 base.css 的另一条规则：所有交互元素（`button` / `a` / `input` /
`[tabindex]` / 各种 ARIA 控件）都是 `-webkit-app-region: no-drag`。Electron 按
**文档顺序**合成可拖拽区域，后出现的 `no-drag` 盒子会把它覆盖到的 drag 区域减掉。
真实 DOM 里这类盒子成百上千，压到 chrome 行上的那部分把 drag 区域吃掉，只剩几个像素，
于是看起来“标题栏完全拖不动”。

## 插件怎么修

不修改官方任何文件，只做一件事：在 `<body>` 的**最后一个子元素**位置放一条通栏拖拽带。

- 文档顺序在最后 ⇒ 它压过所有 `no-drag` 盒子，顶部这一条永远是 drag 区域；
- 高度 16px：在 hiddenInset 红绿灯（顶部 18px 起）之上，也在 chrome 行第一条控件之上，
  下面的一切照常点击；
- 静止时完全透明；鼠标悬停时有一层极淡的蓝色提示（仅在渲染器能收到 hover 时可见）；
- 原生全屏时自动隐藏（全屏窗口本来不可拖动，顶部也不该被吞点击）；
- `data-platform` 标记只由桌面端 preload 写入，所以浏览器里不会插入任何东西；
- 幂等：始终只存在一条；若有新的 `<body>` 直属节点挂上来，自动把拖拽带重新排到最后。

## 安装

```sh
# desktop profile（mac app 自己管理的那份）
dsh plugin --profile desktop add /path/to/default-workspace/window-drag
```

或手工：把目录 link 进 `~/.dsh/profiles/desktop/node_modules/youyou-window-drag`，并在
`~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里各加
`youyou-window-drag`，然后在该目录执行 `pnpm install`。

client 包是在宿主启动时组装进 bundle 的，**装好后要完整退出 app（⌘Q）再打开**，
只关窗口或刷新页面不会加载新插件。

## 验证

1. 重启后把窗口从全屏 / 最大化状态拉回普通大小；
2. 按住窗口最顶端（红绿灯右侧、或窗口右上角的顶部 16px 内）拖动 —— 窗口整体移动；
3. 顶部以下的按钮、输入框、滚动都保持原来的行为。

自动冒烟测试（无浏览器、无依赖，校验注册契约 / 拖拽带内联样式 / 保持最后挂载 /
非 darwin 不插入 / 卸载清理）：

```sh
node --test window-drag/test/client-smoke.test.mjs
```

## 调整

- 抓取区太窄：把 `client.js` 里的 `BAND_HEIGHT` 调到 20–24；代价是开始盖住 chrome 行
  控件的上半部分（按钮在 y≈10–38）。
- 不想要悬停提示：删掉 `HOVER_TINT` 相关规则。

## 已知边界

- 只修“拖窗口”这一件事：不做双击缩放、不做双击最大化（macOS 的系统行为）。
- 浏览器里的 Web GUI 不会出现拖拽带（那里没有窗口可拖）。
- 本机暂时无法用渲染层驱动做像素级回归，验证以重启后的人工拖动为准。
