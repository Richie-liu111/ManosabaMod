# 自定义致谢演出 — MOD 作者教程

> ⚠️ **试验性功能**（macOS 独有，上游 Windows 版 ManosabaMod 无此功能，稳定性未充分实测）。
> 本教程面向 mod 作者：如何在自己的 mod 剧本里插入自定义致谢演出
> （staff 主名单滚动 + 共犯者 Special Thanks 多屏翻页 + 製作段滚动）。
> 机制细节（内部实现/踩坑）见 [ARCHITECTURE.md](ARCHITECTURE.md) 九节。

## 1. 一句话原理

你的 mod 提供**静态数据**（名单 JSON），剧本用几个 `@set` 变量触发，加载器把名单填入
游戏原版的致谢 UI 组件（staff 滚动 = CreditRollVerticalScroll，共犯 = SpecialThanks 翻页），
并驱动原版节奏参数（bpm/拍数/滚动速度）在运行时播放。**内容（名单文本）全部来自你的
数据文件；演出画面背景用的是游戏原版的致谢 CG（9 张 stills，当前版本不可替换）**；
底色/转场/音乐由你的剧本自己编排（`@back`/`@bgm`，见下方示例）。

## 2. 文件布局

```
ManosabaMod/<你的ModId>/
├── info.json
├── data.json                  ← 主名单（staff）+ 旧版共犯数据（可省, 见 §4）
├── Assets/
│   └── thanks-pages.json      ← 共犯者 Special Thanks 全量屏数据（推荐放这里, 见 §5）
└── Scripts/
    └── 你的剧本.nani          ← 里面用 @set 触发
```

- `data.json` 放在 **mod 根目录**（trigger 值 = 相对 mod 根的文件名，如 `"data.json"`）
- `thanks-pages.json` **固定位置** = `mod 根/Assets/thanks-pages.json`（加载器硬编码此路径；
  该文件存在时自动覆盖 data.json 里的旧 thanks 数据）

## 3. 剧本里怎么触发 — 完整示例

协议是 4 步：**trigger（读数据）→ phase 1（staff 滚动）→ phase 2（共犯翻页+製作段，轮询完成信号）
→ phase 3（收尾）**。三段依次串行，各自时长由控制器写变量、剧本 `@wait` 等待：

```
; ---- 前置（你的演出场景：黑幕、音乐、立绘收走等, 自行编排） ----

; ① trigger: 读 data.json + 武装（值写文件名, 不写路径前缀）
@set "g_modCreditRoll = \"data.json\""

; ② phase 1: staff 主名单滚动 —— 控制器同步执行填文本+开始滚动,
;    然后写 g_staffDuration（= 滚动时长, 秒）; @wait 它
@set "g_modCreditRollPhase = 1"
@wait {g_staffDuration}

; ③ phase 2: 共犯者 Special Thanks 翻页 + 製作・販売/Acacia/© 段滚动
;    — 完成后控制器写 g_creditDone = 1; 下面用轮询循环等它
@set "g_modCreditRollPhase = 2"
@set "g_creditDone = 0"
# WaitCreditDone
@wait "0.5"
@set "g_creditTick = 1"        ; ★ 主线程泵: 必须每轮 @set 一次, 製作段滚动靠它推进
@if "g_creditDone == 0"
    @goto .WaitCreditDone
    @wait "0.5"
# CreditDoneRelease

; ④ phase 3: 收尾（清共犯文本 + 隐藏致谢 UI + 解除武装）
@set "g_modCreditRollPhase = 3"
@Wait "2"

; ---- 后续（淡出回标题/进下段剧情, 自行编排） ----
```

> `# EndCredits2` 标签：**原版模式**（trigger 值 = `"original"`，见 §7）播完原版全流程后
> 会跳回剧本的 `EndCredits2` 标签，剧本里保留一个同名空标签即可（缺失会报 label not found）。
> 自定义模式下该标签无用但无害，示例中已包含。

## 4. data.json — staff 主名单

```json
{
 "staff": {
  "speed": 248,
  "endPause": 0,
  "items": [
   { "key": "Full|Roll_1|",     "text": "企画" },
   { "key": "Full|Name_1|",     "text": "Acacia<size=0.8em>（合同会社Re,AER）" },
   { "key": "Left|Roll_6|",     "text": "キャスト" },
   { "key": "Name_6|Line_1|Left",  "text": "桜羽エマ" },
   { "key": "Name_6|Line_1|Right", "text": "三木谷奈々" }
  ]
 }
}
```

| 字段 | 含义 |
|------|------|
| `staff.speed` | 滚动速度 px/s（原版 248；改慢→滚动变慢，改快→变快） |
| `staff.endPause` | 滚动结束后额外停留秒数（原版 2，当前示例 0 = 滚完立即进共犯） |
| `staff.items[]` | 逐条目：`key` 决定填进哪个标签槽，`text` 是显示文本 |

**key 规则**：`祖父容器|父槽|标签后缀` 三段，直接对应游戏原版致谢 prefab 的标签槽结构：

| key 段 | 是什么 | 常见值 |
|--------|--------|--------|
| 祖父容器 | 主名单 content 的直接子级容器 | `Full`（全宽单列）/ `Left`（左栏） |
| 父槽 | 条目槽名 | `Roll_N`（职衔）/ `Name_N`（人名）/ `Line_N`（多列行） |
| 标签后缀 | 槽内标签序号 | 空（单槽）/ `Left` `Right`（左右双栏）/ `_1` `_2`…（多槽堆叠）/ `Nested_N`（嵌套） |

- `Full|Roll_1|` = 全宽槽 "Roll_1" 的标签
- `Name_6|Line_1|Left` = 人名 6 号块、第 1 行、左栏标签
- `Left|Name_7|_1` = 左栏人名 7 号块、第 1 个子槽

**最稳做法**：key 按上表模式复用即可，不必自己发明槽位 —— 新条目复用一个同型 key
（`Full|Roll_N|` 与 `Name_6|Line_N|Left/Right` 是最常见的两类；连续条目用递增 N）。
`text` 支持 Naninovel 富文本（`<size=0.8em>` 等）。

**语种**：staff 下也可按语种分组（加载器回退链：当前语种 → `ja` → `zh-Hans` → 任意）：
```json
{ "staff": { "speed": 248, "endPause": 0,
  "zh-Hans": [ { "key": "Full|Roll_1|", "text": "企划" } ],
  "ja":      [ { "key": "Full|Roll_1|", "text": "企画" } ] } }
```
`items` 与语种数组二选一（`items` 优先，也是最简单的写法）。
zh-Hans 语种下加载器自动把标签字体换成简中动态字体（原版 TsukushiMincho 无简中字形）。

## 5. Assets/thanks-pages.json — 共犯者 Special Thanks

```json
{
 "order": [ "zh-Hans", "ja" ],
 "ja": {
  "label": "Special Thanks",
  "pages": [
   [ "行1富文本", "行2富文本", "行3富文本" ],
   [ "下一页行1", "下一页行2" ]
  ]
 }
}
```

| 字段 | 含义 |
|------|------|
| `order` | 语种顺序 |
| `pages` | 屏数组；**每屏 = 一个字符串数组 = 一页显示的行**；每行 = 一行内多个名字，用 `<space=80>` 分隔，`<size=1.7em>` 调字号 |

示例行（一页 6 行、每行 3-6 个名字）：
```
"<size=1.7em>レアシャイン</size><space=80><size=1.7em>うるとらあらもーど</size>"
```
播放节奏（每屏淡入 0.51s + 展示 2.30s + 淡出 0.51s ≈ 3.3s/屏）由加载器运行时读
原版导演参数驱动，**无需在数据里配**。总时长 = 屏数 × 每屏时长，36 屏 ≈ 2 分钟。

### 与 data.json 的关系

`thanks-pages.json` 和 `data.json` 是**各管一段**，不是并列数据源：

- `data.json` → **staff 主名单**（§4）。它里面的旧 `thanks` 字段是早期开发时的小采样
  （几十行），属于遗留格式，**可以整个省略**——只要 `Assets/thanks-pages.json` 存在，
  加载器就用后者覆盖共犯数据，data.json 里有没有 thanks 都无所谓。
- `Assets/thanks-pages.json` → **共犯者 Special Thanks 全量屏数据**（36 屏，
  zh 420 + ja 4544 合并名单）。固定路径，存在即优先；缺失时才回退 data.json 的旧结构。

所以自定义时：**staff 写 data.json，共犯写 Assets/thanks-pages.json**，两者互不依赖。

## 6. 变量协议速查

| 变量 | 谁写 | 含义 |
|------|------|------|
| `g_modCreditRoll` | 剧本写 | trigger：值 = json 文件名（或 `"original"` 见 §7）；成功→武装，失败→后续 phase 走安全时长（不悬挂） |
| `g_modCreditRollPhase` | 剧本写 | 1 = staff 滚动；2 = 共犯翻页+製作段；3 = 收尾 |
| `g_staffDuration` | 控制器写 | phase 1 后 = staff 滚动+停留秒数（= 高度/speed + endPause） |
| `g_thanksDuration` | 控制器写 | phase 2 后 = 共犯翻页总秒数（参考用，主流程靠轮询 g_creditDone） |
| `g_creditDone` | 控制器写 | phase 2 完成信号：0 → 1；剧本轮询 |
| `g_creditTick` | 剧本写 | 主线程泵：轮询循环里每轮 `@set "g_creditTick = 1"`，製作段滚动和原版模式 PlayAsync 靠它在同步 hook 里推进 |

防御行为（都是让你**不悬挂**）：未 trigger 直接 phase → 写安全时长 3s/5s；数据无效 → 同左；
共犯/製作段 360s 超时兜底 → 强制写 `g_creditDone = 1`。

## 7. 原版模式（可选）：直接用原版致谢

trigger 值写 `"original"` 不读 json，直接调原版 `CreditsUI.PlayAsync(2)` 播原版全流程
（stills + 原版名单 + 原版 Special Thanks，内容/语种/节奏全原版）：

```
@set "g_modCreditRoll = \"original\""
@set "g_modCreditRollPhase = 1"
@wait "1"
@set "g_modCreditRollPhase = 2"
@set "g_creditDone = 0"
# WaitCreditDone
@wait "0.5"
@set "g_creditTick = 1"
@if "g_creditDone == 0"
    @goto .WaitCreditDone
    @wait "0.5"
# CreditDoneRelease
# EndCredits2            ; ← 原版模式播完会跳这个标签, 必须有
@set "g_modCreditRollPhase = 3"
```
另两个内部值 `"extract"` / `"probe-thanks"` 是开发探针，mod 作者不用。

## 8. 注意事项

1. **试验性**：演出依赖游戏原版 CreditsUI 场景结构与 CreditsDirectorAct2 运行时参数，
   游戏更新可能失效；失效时剧本不会崩（安全时长兜底），但演出不显示。
2. **音乐**：bgm 由你的剧本自行播放/停止（示例里 `@bgm ... Loop:false` + 结束后 `@StopBgm`）。
   歌曲长度与演出时长的配比需要自己调（staff 时长 = `g_staffDuration` 可提前查日志预估）。
3. **轮询循环里必须有 `@set "g_creditTick = 1"`**：省略会导致製作段不播（它是 JS 定时器线程，
   引擎级 API 只能在主线程同步 hook 里调 —— 这是本功能最重要的坑）。
4. **phase 顺序**：严格 1 → 2 → 3；中途存档/读档回放时变量已持久化，加载器有防御（未武装的
   phase 直接写安全时长），但演出不会重放。
5. 演出期间隐藏 UI/关闭输入由你自己编排：进演出前 `@ProcessInput false` + `@HideUI ...`，
   演出结束后用 `@ProcessInput true set:Continue.true,....` 恢复（Naninovel 标准用法）。
