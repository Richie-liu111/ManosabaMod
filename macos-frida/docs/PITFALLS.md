# ManosabaMod macOS 移植 — 已知坑与修复

本篇是 [ARCHITECTURE.md](ARCHITECTURE.md) 的姊妹篇: 前者讲**怎么工作**, 这里只讲**踩过的坑与修法**。
**小节编号沿用原文档的 7.x** (`7.1`~`7.13`), 以便与代码注释/历史记录中的交叉引用对得上。

---

## 七、macOS 已知坑与修复

### 7.1 IL2CPP 泛型共享 → _itemIds 运行时类型漂移 (原版审判偶发闪退/黑屏)

**现象**: 原版审判存档加载偶发闪退 (SIGABRT), 或审判场景黑屏 (证据: 4 份 crash 栈
RVA 0x3404d4 完全一致; 不加载任何 mod 也会发生, 加载 mod 后概率显著升高)。
崩溃与黑屏是**同一个异常**的两种结局 (被 Unity 捕获 → LogError 黑屏; 未捕获 → abort)。

**根因链** (macOS IL2CPP 泛型共享, Windows 版无此问题):
- `WitchBookPageBase<T>._itemIds` 声明为 `T[]`, 页面类按 T 实例化:
  `CluePage`→`Graphic[]`, `NotePage`→`Canvas[]`, `Profile/Rule`→`String[]` (Windows 全是 `string[]`)。
- 游戏自身 `WitchBookPageBase.UpdateVersion` 里 `_itemIds.Contains(id)` 的**共享体**
  把数组强转 `IEnumerable<string>` → 类型检查失败 → **MethodAccessException**
  ("Attempt to access method 'IEnumerable<string>.GetEnumerator' on type 'UnityEngine.UI.Graphic[]' failed")。
- 审判存档加载/`@update` 命令必然走到这里 → 原版 macOS 自身缺陷。

**加载器的双重角色**:
1. 放大器: 注入写 `string[]` 进 `Graphic[]` 字段 = 内存破坏, 且注入的 mod 状态让
   场景重建路径更频繁触发 UpdateVersion。→ 修复 a。
2. 受害者: 即使加载器完全不写, 游戏自己照样会炸 (纯原版偶发)。→ 修复 b。

**修复 a — 写入守卫** (`utils.fieldIsStringArray`): 所有 `_itemIds` 写入点
(`appendItemIds` / `rebuildItemIdsFromMap` / `clearModItemsFromPage` 第 3 段)
先验证运行时类型, 非 `String[]` 不写入 (防内存破坏)。

**修复 b — 换数组根治** (`utils.ensureItemIdsString`, 2026-08-04):
- hook 各页面类 + `WitchBookPageBase` 的 `UpdateVersion` (1-3 参, methodPointer 去重)
  `onEnter` → 若 `_itemIds` 非 `String[]`, 从 `_loadedDataItemMap` 提取全部 id
  **重建真 `string[]` 写回** (内容 = Windows 语义的 id 集合) → 游戏原逻辑
  (Contains 门 + SetVersion) 完整执行 → MAE 无源,原版审判状态设置恢复正常。
- 所有加载器写入点也先 `ensureItemIdsString` 再写 (CluePage 的追加逻辑随之恢复)。

**风险/遗留**: 换数组后游戏其它读 `_itemIds` 的位置 (若有) 语义未验证 ——
当前证据 (Windows mod 只靠 `_itemIds` 做 Contains 门) 表明安全, 待长期回归确认。

### 7.2 @char SubId 立绘残留 (剧本用法层, 非加载器缺陷)

**已确认事实**: `@char SubId:"Middle" <char>.<appearance>` (如某 mod 的
`SubId:"Middle" gyEma-Ch2.8`) 显示的立绘在回标题后**不被清除**;
无 SubId 用法的 mod 无残留 → SubId 是差异因素。

**机制 (推断, 未验证)**: SubId 是 Naninovel 的**槽位参数** — 带 SubId 时 actor
实例注册为复合 key `{charId}-{SubId}` (同屏可显示同一角色多实例); 回标题时引擎的
舞台清理按角色 id 遍历移除, 复合 key 的 SubId 实例找不到 → 留在舞台上 → 残留。

**性质**: 剧本用法层的显示特性, 不影响崩溃/数据; 作者可用 `@hideChars` 或指定槽位
清除。原版剧本同样受此规则约束。

### 7.3 其它已踩坑

- `il2cpp_class_get_field_from_name` / `class_get_method_from_name` 只查本类声明,
  基类字段/方法需沿 `il2cpp_class_get_parent` 走链 (walkCls)。
- `Il2CppDumper` 在 macOS 上不可用 (CodeRegistration/MetadataRegistration 解析不出,
  `il2cpp_codegen_register` 非导出符号)。
- 探针/诊断脚本 (probe_*.js) 必须作为**独立** `create_script` 附加 —
  📦 bundle 的 fragment 是模块资产, 不被 import 就不会执行。

### 7.4 invoke() 读值类型返回值 (float/bool) 读到垃圾 — 必须 directCall (2026-08-12, cutin 不可见根因)

**现象**: CutIn 替换成功 (6/6 key 命中、sprite 已 set) 但画面不可见。日志显示
`Sprite.Create ... ppu=1.7662258224252766e-18` (真值 37.8) → ppu≈0 →
`Sprite.Create` 的 sprite 显示尺寸 = 像素/ppu = 天文数字 → 无限放大 → 不可见。

**根因**: `invoke()` 把 `il2cpp_runtime_invoke` 声明为返回 'pointer', 对 ≤8B 值类型
返回值 (float/bool) 的返回缓冲会失效/被复用 → `ret.readFloat()` 读到垃圾
(实证: `get_pixelsPerUnit` → 1.77e-18; `get_enabled`(bool) → 恒定 0x19A9E290)。
引用类型返回 (对象/字符串) 不受影响 — 这是"对象全正常、数值全垃圾"的鉴别信号。

**修复 — `directCall(mi, retType, args)`** (utils.js):
- 直读 `MethodInfo` **首字段 methodPointer** (offset 0), 用**正确返回类型**的
  NativeFunction (如 `'float'`) 直调 → float 从 s0 寄存器正确读出 (ppu=37.82 实测)。
- 调用点须在已 attach il2cpp 的线程 (与 invoke 同上下文即可, 都是游戏主线程 hook 内)。
- **不适用**: Vector2/Rect 是 HFA (s0-s3 多寄存器返回, NativeFunction 只能取 s0) →
  仍走 invoke 缓冲, 但调用点必须加**归一化守卫** (值域检查, 失效回落安全默认;
  cutin 用 [0,1] 回落 0.5, 语义 = C# 蓝本 rect 无效时回落 0.5)。
- **排查经验**: 新写代码读 float/bool 一律 directCall; 读 Vector2/Rect 必须守卫;
  怀疑此类问题时先 grep `readFloat`/`readS32` 检查返回值来源。

**补充 — bool 返回值的另一条岔路 (2026-09-25)**: 同一个"bool 读法"有三种上下文, 别混:
| 上下文 | 正确读法 | 错误写法后果 |
|---|---|---|
| `il2cpp_runtime_invoke` 返回 bool | **`invokeBool()`** (返回值是**装箱 Boolean 对象指针**, 真值在 `+0x10` 的 1 字节) | `ret.toInt32() === 1` 永远不成立 → 守卫静默失效 (见 7.6) |
| `Interceptor.onLeave(ret)` 取 bool | `ret.toInt32() === 1` (**原始返回寄存器**, 无装箱) | 误用 invokeBool 反而读错 |
| `directCall(mi,'bool',...)` | 直接用返回值 | — |
`movie.js` 的 `get_UrlStreaming` 属第二种, 写法正确; `characters.js` / `providers.js` 的守卫属第一种。

### 7.5 语言切换击穿 mod 资源加载 — 已修复 (2026-08-18), 残留: 切语言卡顿

**现象** (修复前): 游戏内切语言 (zh-Hans ↔ ja) 后:
1. **剧本内卡死**: `Failed to load 'zh-Hans' localization document for '<mod>/<script>'` ×N →
   `Failed to hold 'Text/Scripts/<mod>/<script>'` 剧本卡住。
2. **退出到标题黑屏**: 覆写标题剧本的 mod (如某 mod 的 `System/System_Title.nani`)
   从脚本缓存正常播放, 但 `@back <mod 资产> Id:"Stills"` 等 **mod 资产**加载失败 →
   `Unity.LogException` → 剧本死在 `@ShowUI TitleUI` 之前 → TitleUi.Activate 永不触发
   → 加载器的重注入 hook 永不执行 → **自锁黑屏**。

**根因**: Naninovel 切语言时对**每个** `LocalizableResourceLoader<T>` 实例调用
`InitializeProvisionSources()` —— **清空并重建自己的 ProvisionSources 列表**,
mod 在启动时 `insertProvisionSource` 注入的 provider (Scripts/Text/Audio/Voice/
Backgrounds/Characters) 被全部抹掉。macOS 版**唯一**重注入点是 `TitleUi.Activate`
的 onLeave hook (providers.js / entry.js), 只在回到标题时触发 → **中途切换无恢复**。

**日志证据** (2026-08-18 modlog): 切语言瞬间
`[Choice] RL.HandleLocaleChanged('ja')` 连发数十次 —— 这是 choice.js 的
`chHookClassMethods` 钩在 `ResourceLoader<T>.HandleLocaleChanged` **共享代码体**上,
因此**每一个**本地化 loader 实例的重建都被记录, 即"全量重建"的实锤。
切换后 Backgrounds/Stills loader 的 ProvisionSources 只剩游戏自带 4 项
(`Localization/zh-Hans/Backgrounds/Stills` + `Backgrounds/Stills`), mod 的
`<key>/Backgrounds/Stills` 消失, `<mod 资产> ResourceExists mp=0x0` → LogException。

**修复** (2026-08-18, providers.js + choice.js):
- hook `ResourceLoader<T>.HandleLocaleChanged` (FSG 共享体, 一次覆盖所有 T 实例化)
  **onLeave** → 主线程同步重注入: 遍历 modList 重跑 `addModLoader`
  (providers.js `startReinjectWindow` / `_reinjectAll`)。
- `insertProvisionSource` 去重 (同 prefix 幂等跳过, providers.js `_scanProvisionSources`),
  每次切语言可安全反复调用。
- 覆盖面: Scripts / Text / Audio / Voice / Backgrounds(MainBackground|Stills|Tricks) /

**关键坑 —— 为什么不用 JS timer (崩溃教训)**: 初版镜像上游 LocaleWatcherComponent
的 Update 循环, 用 setTimeout 链做"连续 ~10 帧重注入"。但 Frida 的 JS timer 跑在
**脚本线程**而非 Unity 主线程: 主线程正在异步 reload (UniTask 续体在 __NSFireTimer /
主循环上调度), JS 线程同时调 IL2CPP 写 ProvisionSources → 竞争 → 2026-08-18 多次
SIGBUS / SIGSEGV (GameAssembly 无符号偏移 +0xab2da0 / +0xb52c34 / +0xdc9988,
KERN_PROTECTION_FAILURE / 垃圾指针解引用)。改为 onLeave 同步重注入
(与上游 MonoBehaviour.Update 主线程语义对齐) 后, 同一场景实测 **358 次重注入零崩溃**。

**已知残留 —— 切语言卡顿**: 一次切换每个 loader 实例各触发一次全量重注入,
实测 ~200 次/切换, 间隔 ~20ms (≈每帧), 每次全量 `addModLoader` (30 mod × 5 类)。
去重只省了 insert, findSvc / LRP 创建 / converters dict 填充仍每帧重复 →
主线程被占用数秒 → 肉眼卡顿。优化方向 (见 [ROADMAP.md](ROADMAP.md)「差距」5):
① **verify-before-repair**: 重注入前先扫各 loader 列表, 全在则跳过 (绝大多数重注入冗余);
② 按 loader 定向重注入: 只补刚被 wipe 的 loader, 最贴上游语义, 但 LRP 若只被 JS 记录
引用会被 IL2CPP GC 回收 → 悬垂指针, 需额外 rooting。

**附带修复 —— WitchBook 缺语言条目** (2026-08-18): mod info.json 条目缺某语言时
(如 Clues 只有 zh-Hans), 日文下图鉴查 inner[ja] → KeyNotFoundException →
name/desc 空白。`registerLocalizedDict` (witchbook/pages.js) 补全全部 7 种游戏语言
(ja/en-US/zh-Hans/zh-Hant/ko/fr/es), 缺失回退 `pickLocaleText` (zh-Hans→ja→任意),
与游戏 .txt "Missing translation → source locale" 语义一致。

### 7.6 角色元数据守卫失效 → 原版角色被 mod 覆写 (2026-09-25)

**现象**: 装了**某 mod** (info.json 用**原版角色 id** `<角色A>/<角色B>/…`
声明 `Characters`) 后, 原版剧本 `@char <角色>.<外观组合>` /
`@char <角色>.1` 在预加载时报 `Naninovel.Error: Failed to load '<外观>' resource`;
卸载该 mod 后日志 0 条 (modlog1/modlog2 对照)。

**根因**: `witchbook/characters.js` 的 `ContainsId` 守卫写成 `r.ret.toInt32() === 1`
(7.4 补充表第一种) → 守卫永不生效 → `AddRecord` 把原版 `CharacterMetadata`
(LayeredCharacter) 覆盖成 `SpriteCharacter + PathPrefix=<mod>/Characters`。
上游 `ModResourceLoader.AddRichCharacter` 有 `if (ContainsId) return;`。
`providersMap.ContainsKey` 是同一份错误写法的第二处 (modlog2 留下重复 `Add`
的 ArgumentException 实证)。

**修复**: 两处改用 `invokeBool()`。修复后日志给出 `addCharacterProviders:
该 mod 新注册 13 个角色, 跳过 16 个已存在 ID`
(29 条声明 = 16 撞原版 + 13 自有) —— 这行现在是"mod 声明原版 id"的可观测信号。
注: `choice.js:chBool` 是 `invokeBool` 的重复实现 (S2 待清理)。

### 7.7 `@update` 连排 → 主线程冻结 2.1 s — 合帧去抖 + 按分类收敛 (2026-09-25)

**现象**: 进入该 mod 剧本时主线程冻结 **2.12 s** (日志 13:01:16.338→18.460,
1343 行, 占全会话日志 76%)。触发点是 `某 mod 的剧本`
第 2 行起 **28 条 `@update` 连排** (15 Profile + 3 Rule + 9 Note + 1 Clue), 同一帧内执行。

**根因**: `onWitchBookUpdate` 每命中一条 `@update` 就调用一次**全量**
`tryInjectWitchBook()` (5 分类逐页 remove/add + 纹理注册), 实测每轮 55~80 ms。

**修复** (`witchbook/index.js`, `pages.js`):
- **① 合帧去抖**: 突发 = 与上一条 `@update` 间隔 < `WB_BURST_GAP_MS`(100ms), 或同突发内
  切换到别的分类 ⇒ 才补注入。用 JS 时钟而不是 `Time.frameCount`: 项目里 `directCall`
  的先例全是实例方法, 静态 extern 属性走直调风险不划算; 窗口法零额外 FFI, 失败模式
  只是提前/推迟一次注入。
- **② 按分类收敛**: 只重注入被 `@update` 触及的分类。
- **不变式 (关键)**: 游戏自身 `UpdateVersion` 对 `_itemIds` **之外**的 id 不处理, 而且
  本次调用立刻要用到 → `isItemIdInPage()` 为假时**当场**注入该分类; 只有已在页面里的
  (含原版同 id 覆写: 原版条目本就在 `_itemIds` 内) 才推迟。
- **兜底**: 开图鉴 (BeginToPresent/InitializePages) 仍走全量 → 某次突发后再无 `@update`
  也不会停在旧状态。
- 实测: 同 28 条突发 2.12s → **55ms**; `tryInjectWitchBook 完成` 29→4;
  `清除旧 mod 条目` 798→132。

### 7.8 跨帧持有托管对象指针 → 点开图鉴闪退 (2026-09-25, 与 7.5 的"悬垂指针"同一族)

**现象**: 该 mod 会话中 **回标题 → 再进 mod → 点开魔女图鉴** 必闪退 (首次进 mod
直接点则不崩)。`.ips`: `EXC_BAD_ACCESS / KERN_INVALID_ADDRESS at 0x6f004d00000018`。

**取证**: 反汇编崩溃 PC (`GameAssembly+0x4313D8`) 是一段**字符串内容比较**
(length@0x10 / chars@0x14 = IL2CPP `System.String` 布局), 而 `x1+0x10` 被当成
string 指针的值是 `{len=8,"Mo"}` —— 即**一个 `System.String` 被当作 `IdVersionPair`**
(`Id@0x10 / Version@0x18`) 参与字典键比较。

**根因**: `session.js` 的"原版基座快照" `wbVanillaMap[cat].items` 存的是原版
**`VersionedItem` 包装对象的裸指针**(托管对象); "整页重建"(mod 切换/回标题) 再把
这些旧指针 `Add` 回容器。而快照只在**页面实例指针变化**时才重捕获 —— 回标题时页面
对象没被销毁(只隐藏), 指针没变 ⇒ 不重捕获, 但游戏已重建过 map、老对象被 GC 回收/复用
⇒ 重建把**悬空指针**塞进容器 ⇒ 内存已被复用(常复用成字符串)的伪条目 → 渲染崩溃。

**修复**: 快照**只存值** `{id, ver, item}`, 重建时 `buildVanillaItem()` **新建包装对象**;
`item` 指针(由 Data 资产持有)仍做 **klass 校验**, 不匹配即丢弃 + warn。
**运行时验证**: 修复后日志出现 `profile 整页重建: 丢弃无效快照 123 条 (item 指针类不匹配)`
→ 悬空被实证 (clue/rule/note 零丢弃, 说明校验准确; profile 页实例跨标题存活所以独中招)。
丢弃的 123 条恰好是被覆写的 15 个原版 id 的条目 = 覆写本来就要替换的, 无语义损失。

**通用规则 (本项目第一条铁律)**: **跨帧只存值, 不存托管对象指针**。必须存指针时:
① 用前做 `A.ogc(ptr).toString() === 期望类` 校验, 失效视为可恢复 (重建/丢弃 + warn);
② 参考 7.5 那条"LRP 只被 JS 引用会被 GC 回收→悬垂指针"的同类教训。
**待审同类点**: `state.js` 的 `wbPageDefaults[cls].defaultTex` (纹理指针, 只在首次捕获)、
`wbData.texCache` (我们加载的 Texture2D 是否被游戏侧对象 root)。
→ 上述两点已在同日处理: `defaultTex` 改为恢复面板时从活着的缩略图对象**现读**(不再缓存裸指针),
`texCache` 由 `AddressablesManager._loadedAssets` 持有且会话重置时清空 (低风险, 保留)。

### 7.9 覆写路径白做 + 整页重建的悬垂 item (A3/B3, 2026-09-25)

**B3 — 覆写换血每轮重做**: `injectPage` 里"mod 定义的原版同 id"原先**逐 id** 调
`clearModItemsFromPage` (该函数按 id 集合一趟做 5 步: map 删 / dict 删 / `_itemIds` 重建 /
`_state` 删 / 清 `_currentItemId`), 而且**每次注入都重跑** —— 实测日志里 58 ms 内 30 趟、
全会话 181 趟。修法:
- **合批**: 一次收齐所有待换血 id, 只调一次 `clearModItemsFromPage`;
- **幂等**: `isOverrideInPlace()` 用**三重地址身份** (页面实例 + 我们注入的条目地址 +
  该条目持有的 `IdVersionPair` 地址) 判定"换血已完成" → 整条跳过 (不看版本号: mod 覆写的
  版本号可能与原版相同, 版本号区分不了"原版残留"与"我们注入的");
- 记账落在 `wbOverrides` (原先只写不读的死字段), 会话/剧本切换时 `resetWbOverrides()` 清空;
- 副作用随之收敛: `_currentItemId = ""` 只在真正换血时执行一次, 不再每次注入清空选中项。

**A3 — 快照 item 悬垂改为复用**: 整页重建 (见 7.8) 的快照里, `item` 指针会在游戏重建页面后悬垂。
原先的处理是**丢弃**该条 (静默少一条原版条目)。现改为按 id 从 **Data 资产** (`readDataItemsIndex`)
取回 item 复用 (版本号沿用快照值, 只换 item, 避免改变 map 里的版本集合), 取不到才丢弃并 warn。
顺带 `isVanillaId` 支持传索引: profile 的 100 条 id 从"每条扫一遍 Data 列表 (≈1 万次读)"
变成"一次建索引 (≈104 次读)"。

### 7.10 图鉴打不开 — `IdVersionPair` 字典**按实例匹配** (2026-09-25, 与 7.8 同一现场)

**现象**: 进 **mod A** 剧本后魔女图鉴打不开, 每次点击都抛
`KeyNotFoundException: The given key 'WitchTrials.Models.IdVersionPair' was not present in the dictionary.`,
游戏随之中断打开流程; 同一加载器下 **mod B** 剧本正常 (差别只是剧本 `@update` 激活了哪些键)。

**（2026-09-28 复查: 本条结论经真机探针再次确认 = 实例语义; 中途一度被怀疑, 见 7.13①。另注: 页面 `_loadedDataItemMap` 是 List 而非 Dictionary —— 7.13②）**

**定位手段 (备查, 以后 IL2CPP 无符号问题的标准打法)**:
1. **运行时方法表**: 枚举全部 assembly 的 `il2cpp_class_get_methods`, 取每个 MethodInfo 的
   代码指针 (第 1 个字段) 建"地址 → 类::方法"索引 (本作 12.5 万个方法), 再把异常栈的
   `模块+偏移` 对回去 → 抛出帧 = `WitchTrials.Views.CluePage::RefreshPageContent +0x128`;
2. **离线交叉验证**: `lipo -thin arm64` + `objdump -d` 看该函数的字段偏移用法;
3. **直接问异常**: 挂 `System.ThrowHelper.GetKeyNotFoundException(key)` (缺键抛异常的唯一必经点)
   读出缺失的键 —— 注意它是**静态方法**, Frida `onEnter` 里第一个形参在 **`a[0]`** 而非 `a[1]`;
4. 备用: `KeyNotFoundException..ctor(string)` 打 message + 原生栈 (entry.js 的异常字段 dump
   扫"指向 System.String 的字段", 因为 `A.cgn` 给的是**不带命名空间**的类名, 比较要用 `"String"`)。

**根因 (两条叠加)**:
1. 页面字典 `_localizedTextData` 是 `Dictionary<IdVersionPair, …>`, 它的匹配实际上**按实例**
   (identity 哈希)。而 `restorePageFromData` 整页重建时用 `buildVanillaItem` **new 了等价实例**
   当 `_idVersionPair` → 游戏拿 `map.IdVersionPair` 查字典必然 MISS。我们注入的 mod 条目之所以
   一直没事, 是因为注入时 map 条目的 ivp 与字典键**用的是同一个实例**。
2. 我们判断"键在不在"用的是**值相等**扫描 ⇒ 全部误报"存在" ⇒ 每一层自愈都静默跳过。
   雪上加霜: .NET `Dictionary` 的 `Remove` 只把 `Entry.hashCode` 置 **-1**, **键的指针留在数组里**
   → 已删除条目的残留也被值相等扫描当成存在。

**修法**:
- `session.js` 新增 `dictFindKeyInstance(dict, id, ver)`: 从字典自己的 entries 里取该 (id,ver) 的
  **键实例** (含已删除残留 —— 键指针仍在, 且正是游戏用过的实例, 由字典持有**不会悬空**);
- `restorePageFromData` 重建的 map 条目把 `_idVersionPair` **指向该键实例**;
- `writeLocalizedDictEntry()` 写字典前**先复用字典已有的键实例**, 并从函数返回它
  (调用方用它做端到端核对);
- `dictHasIdVer()` / `getFirstDictValue()` 加 **`hashCode >= 0`** 的存活判定
  (插入时 `hashCode = GetHashCode(key) & 0x7FFFFFFF` 必为非负, 负数只可能是已删除);
- 兜底 (dictheal.js): 每次注入末尾按 `_state` 逐个核对"将要渲染的键", 缺的从游戏 Data 重建
  (`healStateKeys`) —— mod 条目用 mod 文本, 原版条目用该条 item 的 `LocalizedText`, 取不到只 warn。

**副作用 / 经验**:
- "值相等"这个假设此前散布在 6 处判定里, 全部按"实例语义"重审;
- **诊断代码必须永不静默**: 本轮多跑好几轮的原因是自己的过滤条件/API 用错之后被 `try` 吞掉
  (例: 为防字典串台加的"按页面实例过滤"恰好挡住真正被查的"方法内局部字典";
  `Memory.isReadable` 在本版 Frida 不存在 → 扫描函数整体抛错被吞);
- 取证用的 hook (get_Item 兜底 / 渲染前补字典 / ThrowHelper 取证 / 寄存器与栈扫描) 在确认修复后
  **已全部删除**, 生产包只保留"注入末尾按 `_state` 补全"这一条主干。

### 7.11 "诊断代码永不静默" — 治反复返工的工程约定 (2026-09-28)

7.6~7.10 四连修复本身只花了几小时, 但代价是 **~15 次构建 / ~12 次人工实测往返**, 其中前 10 轮
基本在猜 —— 3 次错误假设 + 4 次**自己的诊断代码静默失败**。后者才是真根因:
"看不到输出" 被误读成 "游戏没抛异常", 于是继续瞎猜。本节把教训变成可执行的约定。

**四条约定**:

1. **任何 `catch` 都不许完全无痕。** 223 处 `catch (e) {}` 已全部改掉 (198 处本体 +
   `log.js`/`io.js` 手工):
   - `swallowed("<文件>:<函数>", e)` —— 防御性探测/类没找到就跳过, **DEBUG 级** (默认关),
     每 tag 只打前 3 条 + 1 条"后续静默", 计数留在 `swallowedStats()` (随 `[SELFTEST] SUMMARY` 输出);
   - `swallowedWarn(...)` —— **关键路径**: 吞掉它就会静默产生"字典键丢了→图鉴打不开"这类 bug。
     目前 41 处 (session 19 / pages 10 / characters 2 / textures 2 / dictheal 1 / utils 1 …)。
   - 节流是必需的: 钩子里的异常可能每帧发生, 不节流会把日志淹掉 —— 那样又变成"看不见"。
   - **例外 (必须保持安静)**: 崩溃/异常上下文 (`log.js` 的 `crashLine` / `setExceptionHandler` /
     `SIGABRT` 钩子) —— 那里 console/RPC 会死锁, 只准直接写文件。
   - 工具: `node tools/catch-audit.mjs` (干跑列清单) / `--apply` (改写 + 补 import + 升级 warn)。
2. **同一条"存在性/语义"判定只准有一套说法。** 键存在性判定现有三套, 各自写清语义
   (见 `utils.js:listContainsId` 上方注释): ① List 按值比 id; ② `Dictionary<IdVersionPair,…>` 按
   **实例**匹配 (图鉴页面字典); ③ self-scan 时必须先过滤 `hashCode < 0` 的死槽。
3. **硬编码偏移要有体检。** `fieldOffset(cls,name,fallback)` 在回退时会沿基类链核对真实偏移,
   不一致 → `[WARN] fieldOffset:<字段>` 报警 (每个类+字段只体检一次, 不刷屏)。偏移速查:
   `docs/OFFSETS.md`。
4. **打包产物必须可核对。** 构建前跑 `tools/check-imports.mjs` (frida-compile **不校验具名导出**,
   写错要等 Frida 加载才报 —— 2026-09-25 白跑一轮的直接原因); `run_mod.sh` 启动前打印包 md5;
   `npm run deploy:check` 比 repo 产物与游戏目录产物。

**回归脚手架** (把"人肉点测"降级为"跑一条命令"):

- `src/witchbook/selftest.js` (仅 `MOD_SELFTEST=1` 装载): **字典不变式哨兵** —— 每页 × `_state` 里
  每个 (id,ver), 取**游戏自己的键实例**问一次真实 `ContainsKey`, 必须 true; 外加 KNF 计数与页面统计。
  这正是 7.10 那个坑的永久防线。
- `test-tools/regression.py`: 复刻用户手动流程 (构建 → cp 到游戏目录 → **跑游戏目录的
  `run_mod.sh`**) → 到点杀进程 → 读 `modlog.txt` 断言 → 退出码。
- `test-tools/swallow-test.mjs`: `swallowed` 节流逻辑的纯 node 单测 (不需要游戏)。

**两条流程不能分叉**: 仓库和游戏目录各有一份 `run_mod.sh`, 各自注入**自己旁边**的
`dist/manosabamod.js`, 且只有自己旁边有 `src/` 时才重建 ⇒ 仓库那份会重建、游戏目录那份直接用现成的。
改动要 `cp` 同步, `deploy:check` 就是防它俩分叉的。

### 7.12 哨兵第一次真跑就抓到东西: "我们的记录" ≠ "游戏的状态" (2026-09-28)

MOD_SELFTEST=1 跑一局 (mod A 点图鉴 → 回标题 → mod B 点图鉴), 11 轮里 **5 轮 FAIL**、
**knf=0** (游戏没崩, 图鉴正常) —— 这种"看着没事但断言红了"正是要研究的。

**证据链**:
- FAIL 全部同一条: `字典缺键 profile '<原版条目>' v0`, 且只出现在 mod B 之后;
- mod B 剧本的第 7 行: `@update "<原版条目>" Category:"Profile" Version:0`; 剧本第 1 行还有
  `@gosubResetBook System/System_ResetWitchBook` (游戏侧清空图鉴);
- 但我们的 `>>> @update 拦截` 只打了 **15** 条 profile (其余原版角色条目), **没有这一条**;
- 原因: 这个条目被 data.js 的 "**首个 mod 优先**" 判给了先加载的 mod (字母序在前) →
  在 mod B 里 `isCurrentModItem(profile,'<原版条目>')` 为假 → 我们**按规矩忽略**了这条 @update。
  而**游戏不管我们的规矩**, 照旧把该条目写进 `_state`(16 条) 与 `_itemIds` →
  字典里只有我们注入的 15 条 → `_state` 与字典出现分叉。

**两个真问题 (都已修)**:
1. **heal 读的是"我们的记录"而不是"游戏的状态"**: `healStateKeys` 遍历的是 `wbData.states`
   (我们拦截到的东西), 而它的注释却写着"把该页 `_state` 里将要渲染的键逐个核对" —— 注释与代码不符。
   ⇒ 改成读**页面自己的 `_state._list`** (∪ wbData.states 兜底)。与 7.10 同一个道理:
   **判定要问游戏, 不要问自己的账本**。
2. **哨兵的判据原本抓不到 7.10 那个坑**: 旧写法是"取字典自己的键实例 `dictFindKeyInstance` 问
   ContainsKey" —— 那是**字典自己的键**, 恒为真。7.10 的真相是"字典里有这个键, 但**游戏手里的
   那个实例**不在字典里", 所以必须用 `map 条目的 VersionedItem._idVersionPair`@0x28 (游戏真正拿去
   查字典的实例) 去问。⇒ A1 改为逐条检查 map 条目的 lookup 实例 (值不是 VersionedItem 的页面
   如 Map 退回用条目键, 避免读错字段误报)。
3. 分级: 缺键**同时在渲染集合 (`_loadedDataItemMap`) 里** → FAIL (就是 7.10 那类, 会 KNF);
   只在 `_state` 里 → `NOTE` (渲染不走它, 记录不判)。

**教训**: ① 自愈/断言的**真相源必须是游戏对象本身**, 我们的 `wbData`/`wbData.states` 只是账本;
② 哨兵要按**游戏实际怎么查**来设计 (查哪个实例、走哪条路), 否则写了也是自我安慰;
③ "首个 mod 优先" 的去重只约束**我们注入什么**, 约束不了游戏自己的 `@update` —— 两边的账要能对上。

### 7.13 三条实测判决 + 一处布局读错 (2026-09-28 晚, 收尾 7.10~7.12)

**① 字典是"实例语义"—— 7.10 的结论成立, 中途的怀疑撤回。**
7.11 的哨兵第一次真跑后, 我一度因为"`IdVersionPair` 实现了 `IEquatable`/`GetHashCode`"
怀疑 7.10 的"按实例匹配"写错了。真机探针(一次性, 现留在 selftest 里)给出的判决是:

```
[SELFTEST] 键语义 clue ('1-1' v1):
    Equals(等价新实例)          = true     ← 类自身确实实现了值相等
    字典 ContainsKey(等价新实例) = false    ← 但那个字典不用它
    ⇒ 实例语义 (identity)
```

即: **类型有值相等 ≠ 那个字典按值匹配** (它用的是 identity 比较器)。教训: 判断容器语义要问
**容器实例**本身; 读元数据只能提出假设, 不能当结论 —— 我差点据此改掉一个正确的结论。

**② `_loadedDataItemMap` 是 `List<VersionedItem>`, 不是 `Dictionary`。**
`session.js` 一直按 List 用它 (`RemoveAt` / `_items@0x10` / `_size@0x18` / 元素在 `+0x20+i*8`),
而且**有效** (mod 切换清理、整页重建都靠它)。我却让哨兵的 A1 按 Dictionary 布局读
(`+0x18` → entries 数组 → 24 字节步长) ⇒ 把 `_size`(155) 当指针用 → 被自己的守卫拦成 0 条 →
"A1 一条都没探到", 连续两轮把负对照演成"哨兵没反应"。
**两处更正**: ① 我说"旧日志里的 `map=155` 是垃圾数"是错的, 那正是 List 的 `_size` (已改回);
② 现在 A1 不再猜布局 —— 用游戏自己的 `get_Count` / `get_Item` 访问器, 并把类名与两个候选偏移的
原始值打进 `stats` 行, 谁再改都不用猜。**"猜内存布局"本身就是一种静默失败。**

**③ 菜单间歇性不出现 = 重定向"单次 100ms 赌时机"且失败全静默。**
`hookStartGame` 原来在 `TitleUi.Activate` 后只试一次 (100ms), 各失败分支全是 `dbg`。
若那一刻标题剧本尚未就绪 → 重定向没做 → 游戏按原路径加载 → 日志里刷 ~87 条
`Failed to load '' ...Naninovel.Script` 且菜单不出现 (实测 2026-09-28 19:44 那次);
成功的那次一条都没有 (18:57 / 19:53 / 20:09) —— **现象与"重定向有没有落地"完全对应**。
修法: ① 重试 (100ms 起, 每 150ms, 最多 20 次; 期间安静, 最后一次才 warn);
② 关键步骤改为默认可见 (成功 → INFO `[菜单] 已把标题 StartGame 重定向 → ModLoader/Scripts/ModStart`;
各失败分支 → warn)。这行 INFO 从此就是"菜单流程健康"的指纹。

**④ 工具自证**: 新增的 `check-imports` 反向检查 ("用了 utils.js 的导出却没 import") 在这轮里
**两次抓到我自己漏的 import** (`invokeOk`、`warn`) —— 这类错 frida-compile 不报、只在游戏里
炸成 ReferenceError, 还会被 catch 吞掉。工具的价值当场验证。
