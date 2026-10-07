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
- 探针/诊断脚本 (本地 `probe_*.js`, 被 .gitignore 排除、不随仓库发布) 必须作为**独立** `create_script` 附加 —
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
  `run_mod.sh`**) → 到点杀进程 → 读 `modlog.log` 断言 → 退出码。
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

### 7.14 菜单剧本"丢了剧本路径" → New Game 黑屏 (2026-10-05, 与 7.13③ 是**两条不同支路**)

**现象**: New Game 之后黑屏, 菜单不出现。日志指纹 (与 7.13③ 明确不同):

```
Failed to load 'zh-Hans' localization document for '' scenario script. ...   ×N   ← 每条选项一次
Naninovel.Error: Failed to load '' resource of type 'Naninovel.Script'
  at ResourceLoaderExtensions.LoadOrErr[TResource](loader, path, holder)
  at Naninovel.TextLocalizer.Load(text, holder) → LocalizableText.Load(holder)
  at Naninovel.Command.<PreloadStaticTextResources>b__31_0(LocalizableTextParameter t)
```

`N` = 菜单剧本里 `@choice` 的条数 (脚本 play 时 Naninovel 会预载**全部** command 的静态文本;
N 现在由 `[菜单] 菜单剧本已注册 … 选项数=` 那行直接给出, 不用再数)。7.13③ 是"重定向没落地" →
指纹是 ~87 条 `Failed to load '' ...Naninovel.Script`(脚本加载), 且 INFO 重定向行不会出现。

**链路** (逐段有日志/源码实证):
① `System/System_Title` 的 `# StartGame` 末尾 `@goto {nextScenario}`, 由 loader 把该 `GotoModified.Path` 改写成
   `ModLoader/Scripts/ModStart` (菜单剧本, `Script.FromText` 合成, 以两个 key 进 ScriptLoader 缓存)。
② 剧本 play 时逐条预载静态文本: 每个选项按 `ToL10nPath(剧本路径)` = `Text/Scripts/<剧本路径>` 找本地化文档;
   找不到就记友好错误, 再走兜底"从剧本本身取原文" → `ScriptLoader.LoadOrErr<Script>(<剧本路径>)`。
③ 正常: 剧本路径 = `ModStart` → 文档命中 (`registerMenuText` 注册的空 TextAsset) → 只有
   `Missing translation for '…Text/Scripts/ModStart#~hash'. Will use source locale instead.` (WARN) →
   兜底加载脚本 `ModStart` (第二个 key) → 菜单正常出。
④ 故障: 剧本路径 = **空串** → 文档路径 `Text/Scripts/` 未注册 → N 条友好错误 → 兜底按空路径加载脚本 →
   `LoadOrErr` 抛 `Naninovel.Error` → 预载中断 → 菜单演不起来; 而标题为进 StartGame 已经
   `@back Overlay SolidColor #000000` + `@Wait 1.8` 淡黑完了 ⇒ **黑屏**。

**为什么"加了某个 mod 才中招"是错觉**: 同一份 mod 列表在同一晚另一次启动完全正常
(菜单选项文本按 `Text/Scripts/ModStart#~hash` 正常解析, 该 mod 自己的文档
`Text/Scripts/<mod>/Main#~hash` 也正常)。**故障是间歇性的, 与 mod 内容无关**; 改 mod 列表只是
改变了菜单文本长度/分配时序, 从而改变了下一条的命中概率。

**根因 (已实证) —— 注入侧托管字符串"无根", 被自动 GC 回收后内存复用** (与 7.8 同一族):
`makeS("ModStart")` 造出的托管字符串在 `il2cpp_runtime_invoke` 之前**没有任何托管引用**
(只在 JS 变量里; Boehm 只扫栈/寄存器/静态数据段, **不扫 V8 堆**), 而这段窗口里还夹着菜单文本
(约 4.5 KB) 的分配。这里一触发自动 GC, path 字符串就被回收, 其内存被后续分配复用 →
`Script.path` 与**全部**文本的 PlaybackSpot (它们引用的是同一个字符串对象) 一起变成垃圾。

**实锤证据 (2026-10-05 17:13 那次 `MOD_GC_PROBE=1`)**:

```
[菜单][GC-PROBE] 强制 GC 前 path 字符串读回="ModStart"
[菜单][GC-PROBE] il2cpp_gc_collect=已调用 + churn(256×512B) 后读回="ModStart" (本次未变)
[菜单][P0] 构造后 (build): Script.path="@Stop"   ← 不是空, 是菜单文本里那段子串!
→ 28 条 Failed to load 'zh-Hans' localization document for '@Stop'
→ 1 条 Naninovel.Error: Failed to load '@Stop' resource of type 'Naninovel.Script' → 菜单没出现
```

即: path 字符串被回收后, 它的内存块被**解析器造的 `"@Stop"` 子串**占了 (同类小字符串, 同一堆桶)。
15:57 那次故障读到的是空串 (同一机制的另一种落点), 二者现象同源。**这解释了"为什么是间歇的、
为什么和 mod 列表有关"**: 区别只在自动 GC 有没有落在那个窗口、以及内存被谁复用。
`il2cpp_gc_collect()` 显式调用反而没回收它 (保守扫描可能从栈上捡到了残留指针), 真正致命的是
`makeS(text)` 大分配触发的那次自动 GC —— 这也正是修法要掐掉的东西。

**探针 (全部默认关, 见 run_mod.sh 顶部; 排查时才开 —— 玩家视角这些是纯噪音)**:
| 开关 | 做什么 | 看什么 |
|---|---|---|
| `MOD_MENU_PROBE=1` | ① 构造菜单剧本后读回 `Script.path`(@0x18, lines@0x30 已实证), 点 New Game 瞬间 (`TitleUi.StartGame` onEnter) 再读一次; ② 挂 `TextManager.GetDocument`/`IsScriptL10nDocument` 与 textLoader/scriptLoader 的 `Load` | 两行 `[菜单][探针] Script.path=…`: 构造时就空 = 传参/解析丢了; 之后才空 = 悬垂字符串被回收复用。文档键是 `Scripts/<p>`、资源路径是 `Text/Scripts/<p>` (见上表) |
| `MOD_GC_PROBE=1` | 在构造窗口里 `il2cpp_gc_collect()` + 垃圾冲刷 | 修复前被这个压力打成 `"@Stop"`; 修复后 path 稳定 (会把手感弄坏, 只用于诊断跑) |
| `MOD_FAULT=menu-nopath` | 故意用空 path 构造菜单剧本 | 兜底层的回归测试: 注入仍在, 菜单也应照常显示 |

常态只留两条健康指纹 (各一次进标题一行): `[菜单] 已把标题 StartGame 重定向 → …` 与
`[菜单] 菜单剧本已注册 (FromText): ModStart 选项数=N` (选项数 = 故障时游戏侧报错条数的对账依据)。

**排查流程落点**: `MOD_LOG_ARCHIVE=1 ./run_mod.sh` 时, 启动前会把上一轮 `modlog.log` 复制归档到
同目录 `logs/` (每次启动被截断重开, 间歇性故障最容易丢的就是现场 —— 2026-10-05 已丢过一份)。
**默认关**: 对玩家来说只是一堆没用的文件, 只有排查时才需要留现场。

**修法 (2026-10-05, 三层)**:
1. **临界区关 GC** (`utils.js` 的 `withGcDisabled` / `gcDisable`+`gcEnable`): "造托管对象 → 立刻交给
   托管侧"的整段用 `il2cpp_gc_disable/enable` 罩住 (计数器式 API, 可嵌套, `finally` 里配平) ——
   期间**任何线程**都触发不了自动 GC, 对象不可能被回收。已用在 `registerMenu` / `registerMenuText`
   全段、`hookStartGame` 的 NamedString 段。
2. **分配顺序**: 大字符串先造、path 字符串最后造且紧接 `invoke` —— invoke 之前不再夹任何托管分配,
   本线程也就没有触发 GC 的机会 (`invoke` 内部只做 native `Memory.alloc` + `il2cpp_runtime_invoke`,
   路径指针在原生寄存器/栈上, 保守扫描可见)。
3. **空路径兜底 key**: 菜单剧本额外注册 `""`、菜单文档额外注册 `"Text/Scripts"` / `"Text/Scripts/"`
   / `""` —— 即使路径又被毁成空串, 兜底"按空路径读剧本原文"仍能命中菜单自己, 菜单照常显示
   (只剩一条 `Missing translation` 警告)。注意这层只兜"空串"形态; 像 `"@Stop"` 那种垃圾值兜不住 ——
   所以第 1/2 层才是根治。

   **踩点 (2026-10-05 17:26 实测)**: 文档 key 一开始只注册了 `"Text/Scripts/"` → 没命中, 因为
   `ToL10nPath` 用的是 .NET `Path.Combine("Text/Scripts", scriptPath)` —— 第二参为空串时**返回不带
   尾斜杠的 `Text/Scripts`**。漏了这一个字符的后果很有意思, 值得记一笔: 兜底脚本 key 已生效 →
   预载不再抛错 → **黑屏消失了, 但失败只是往后挪了一步**: 文档查不到 → 文本没加载 → `@choice`
   执行时 `Naninovel.Commands.AddChoice.Execute → GetOrAddHandler → GetOrAddActor` 抛
   **`Failed to hold`** → 选项面板不建 → 现象变成"**有背景、没有选项、能退回标题**"。
   所以判断"菜单坏没坏"不能只看有没有黑屏, 还要看 `AdvChoiceInit` 有没有打出来 (选项面板建了没)。

**回归验证 (用现成探针做 A/B, 2026-10-05 已全部实测通过)**:

| 场景 | 修复前 | 修复后实测 |
|---|---|---|
| 默认跑 (多次) | 偶发: 构造后/点击时采样 ✗ + N 条空路径报错 + 黑屏 | 两次采样都 ✓ `Script.path="ModStart"`, 0 报错, 菜单正常 |
| `MOD_GC_PROBE=1` | 17:13 实测 `Script.path="@Stop"` + 黑屏 | 压力照打 (`GC disabled=true`), 采样仍 ✓、菜单照常出 (两次激活都是) |
| `MOD_FAULT=menu-nopath` | 确定性黑屏 (17:13:03: `<null>` + 28 条报错) | 采样仍 ✗ (注入是故意的), 但 `GetDocument('Scripts/')` 全命中、0 条 `Failed to load/hold`、**选项正常显示** |

**路径约定 —— 两层名字容易混 (2026-10-05 用 P0-3 探针在正常跑里实测确认)**:

| 层 | 形式 | 实测证据 |
|---|---|---|
| **文档键** (`TextManager.GetDocument` / `docByPath`) | `Scripts/<scriptPath>` | 正常跑 `GetDocument('Scripts/ModStart') = 命中`; 空 scriptPath → `Scripts/` |
| **资源路径** (ResourceLoader 缓存 / `Hold`) | `Text/Scripts/<scriptPath>` | `Failed to hold 'Text/Scripts/' …: resource is not loaded` |

原始 4 键 `["Text/Scripts/ModStart", "Scripts/ModStart", "ModLoader/Text/Scripts/ModStart", "ModStart"]`
恰好两层都覆盖了 (所以正常跑一直没事), 空路径兜底就必须**两层都给**: `Scripts` / `Scripts/` (文档) +
`Text/Scripts` / `Text/Scripts/` (资源) + `""`。前两轮只给了资源那侧 → 文档查不到 → 文本没加载 →
`AddChoice.Execute → GetOrAddHandler → GetOrAddActor` 抛 `Failed to hold` → **选项面板不建**,
现象是"有背景、没选项、能退回标题"(不是黑屏) —— 所以判"菜单坏没坏"要看 `AdvChoiceInit` 有没有出现。

**同类审计 (待办)**: 其它 `makeS(...)` 跨越后续托管分配的写法同理脆弱 —— 典型如
`menu.js` 里 `A.on(lrClass)` 造出的 LoadedResource 跨越 `makeS(键)` 与 ctor invoke、各类
`makeLocalResourceProvider` + ProvisionSource 组装。本次只收了已实证的菜单链路; 后续新增
"造托管对象再交出去"的代码, 请照 §1 用 `withGcDisabled` 包住, 或把 `makeS` 的结果**同语句**
写进托管字段 (窗口为 0)。

### 7.15 游戏内退出 → 黑屏 + 未响应 (进程永不退出) — attach 进 IL2CPP 域的 frida 线程卡死 shutdown (2026-10-06)

**现象**: 游戏内点"退出"后窗口黑着不关, Dock 显示"未响应", 进程一直活着; 只能强制退出或 ctrl+c。
modlog 尾部只留一条 `findSvc(...) NOT FOUND in 0 services` (引擎已 DestroyServices = shutdown 已开始)。

**根因 (实证, 逐帧比对)**: `sample` 抓到的卡死栈, 手工复现与自动化复现**完全一致**:

```
__NSFireTimer → UnityPlayer +0x5dca78 → GameAssembly +0x3579b8 → +0x32e420 → +0x12f0
  → _dispatch_semaphore_wait_slow (带超时)          ← 主线程永远停在这
```
而 frida 的 JS 线程 (`gum-js-loop`) 空闲在 kevent, 其余 26 个线程也都在等活干 —— 即
**主线程在等一个不会来的信号**。变量剥离 (自动化 A/B, 全部同一环境同一时点):

| 条件 | 结果 |
|---|---|
| 不 attach (只有 Steam 绕过) + 退出 | ✅ 干净退出 |
| **attach (`il2cpp_thread_attach`) + 退出** | ❌ 卡死 (栈与手工一致) |
| attach, **退出前 detach** | ✅ 干净退出 |
| attach, 退出**已经卡住后**再 detach | ❌ 卡死 (那条 detach 消息 2 分钟后才被 JS 线程执行) |

即: **把 frida 的 JS 线程 attach 进 IL2CPP 域, 本身就会让游戏退不掉**; 与 mod 的钩子/注入/菜单全无关
(纯 frida + attach + `Application.Quit` 就能复现)。`il2cpp_gc_disable/enable` 无关, 我们全部轮询早已在
退出感知里自停。

**为什么必须"在退出入口那一下"detach**: shutdown 一卡住, JS 线程就再也不能跑 JS 了
(实测消息排队 2 分钟; 那期间 sample 里它是 kevent 空闲态 —— 像被 Boehm 的 stop-the-world 或
运行时的线程收拢按住)。所以"退出后再补一刀"的救援路线走不通, 只能在**退出请求进入的那一帧**动手。

**修法 (最终版, 改了两轮才对)**: `utils.js: detachJsThread()` (`il2cpp_thread_detach` 是 C 导出, 见
entry.js 的 `A.td`), 触发链是: 退出入口钩子**只置位** → 一个 **50ms 的纯 JS 定时器**看标志, 由
**JS 线程自己**把自己摘出去 (`_quitEntry` 只置位; 钩子覆盖
① `UnityEngine.Application.Internal_ApplicationWantsToQuit` (0 参静态, **覆盖所有退出请求**: 游戏内按钮 /
Cmd+Q / 程序坞 / AppleEvent) 与 ② `UnityEngine.Application.Quit(int)` (游戏内按钮直接入口))。
摘除后 JS 线程不再进 IL2CPP: 轮询受 `isShuttingDown()` 守卫自停, 退出期只剩纯 JS 的退出上报。

**⚠️ 第一版就是这么写错的 (真踩了, 留下一份 .ips)**: `detachJsThread()` 里先调
`il2cpp_thread_current()` 拿线程对象 —— 它返回的是**调用者**; 而钩子回调跑在**主线程**上 →
摘掉的是主线程 → 0.0x 秒后主线程在玩家循环里调 `Environment::get_CurrentManagedThreadId`
(读 "当前线程的 Il2CppThread") 拿到 NULL → SIGSEGV (`KERN_INVALID_ADDRESS at 0x0`), 崩在:
`GameAssembly +0x1238268 ← +0x126614c ← +0x350fe4 ← UnityPlayer +0x5cd7e8 (玩家循环)`。
**教训**: `il2cpp_thread_detach` 清的是**调用者**的线程注册 (GC 侧是 thread-local),
所以它只能由"要被摘的那个线程"自己调; **永远只用 attach 时记下的那个线程对象** (`noteJsThread`),
不要用 `il2cpp_thread_current()`。

**窗口有多窄 (实测)**: 钩子置位后 JS 线程**还能跑** —— 三次验证里自摘耗时 18ms / 39ms / 39ms / 47ms,
50ms 定时器足够; 但 shutdown 一卡住就再也不能跑 (消息能排队 2 分钟), 所以"卡了再补一刀"必然失败
(实验: 退出前 detach ✅ / 退出后 0.25s detach ❌ / 退出后 3s detach ❌)。

**实测 (真实 bundle 端到端, 两条路径)**: `PROBE=test-tools/autoquit.js ./run_mod.sh` (等价点退出按钮)
→ `检测到退出 (Application.Quit) — JS 线程已从 IL2CPP 域摘下 (detach=true)` → **1.2s 后进程退出**;
`osascript -e 'quit app "manosaba"'` → `(Application.wantsToQuit) detach=true` → 干净退出。
两次日志里"引擎已开始退出"的下一条都是"游戏进程已退出", **看门狗没有出手**。

**已知代价 (接受)**: 若某个 `wantsToQuit` 处理器把退出**取消**掉, 我们已经 detach 了 —— 那一轮 mod 的
IL2CPP 侧功能会失效 (轮询已停), 重启即恢复。本作没有这种取消逻辑 (实测两条路径都真退)。

**兜底 (与根因无关也保留)**: `run_mod.sh` 的看门狗 —— mod 上报 `engine-shutdown` 后 `MOD_EXIT_GRACE`
秒 (默认 3) 进程还没退就 SIGTERM→SIGKILL 收掉, 免得玩家每次手动强退。开销 = 原来那 1s 存活轮询里
多一个整数比较 (`os.kill(pid,0)` 微秒级), 可忽略; `MOD_EXIT_GRACE=0` 关闭。

**第三个坑 (只在探针里踩到)**: 探针脚本别从 t=0 就去调 il2cpp —— GameAssembly 的 dlopen 就发生在
`il2cpp_init` 里, 这时候调 `il2cpp_domain_get` 会和初始化抢, 实测让游戏**启动 1 秒后 SIGABRT**
(abort 栈顶是 `il2cpp_init`)。等 6s 再探 (`autoquit.js` 已加延迟)。

**排查工具 (都在 test-tools/)**: `quit_probe.py` (自动复现: `ATTACH=0/1 DETACH=before/after/hook QUIT=invoke/osascript`)、
`autoquit.js` (给 run_mod.sh 当 PROBE 用, 自动点退出按钮)、`dump_methods.py` (运行时导出方法表,
把 sample 的裸地址翻译成人话; Il2CppDumper 不认这个 fat Mach-O, 这条路走不通)。
**踩过的坑**: `Module.findGlobalExportByName` 在本环境**查不到 GameAssembly 的导出** (libSystem 的能查到,
极易误判) → 必须 `Process.enumerateModules()` 拿模块对象再 `findExportByName`; 且 GameAssembly 是
spawn 之后才 dlopen 的, 找导出必须轮询等待。

### 7.16 图鉴角色数据注册复测  (2026-10-07)

**背景**: `injectCharacterData()` / `injectAuthorData()` 自 2026-08-02 起被注释掉 (理由"角色档案数据
注入可能破坏场景, 5 个 ArgumentException")。复测判定该理由**已过期** (那类异常属 7.6 的装箱守卫故障,
2026-09-25 已由 `invokeBool` 修掉; 这两个函数自己的守卫是 `listContainsId`, 根本不走那条路),
调用已恢复, 真机零异常。但过程中挖出的三条东西比结论本身更值钱:

**① 数据注册有"时序窗口", 过了就永远吃不到 —— 这是缓存语义, 不是 bug。**
`CharacterData`/`AuthorData` 唯一的运行时消费者 `AuthorTextBuilder` 在 `LoadDataAsync` 里把
`_nameData`(0x48)/`_authorData`(0x50) 建成**一次性快照**, 之后不再重建。所以注入只对"注入之后新建的
builder"生效:
- 对话框 (`WitchTrialsTextPrinterPanel`) 的 builder 随审判场景新建 → **命中**, 姓名走富文本模板;
- backlog 面板 (`WitchTrialsLogUi`) 与图鉴人物页 (`ProfilePage`) 的 builder 在**游戏启动时**已建好 →
  永远"未命中"。

**推论**: 靠"更早注入"救这两处是不可能的 —— mod 身份要等剧本加载才知道 (`ScriptLoader.Load`), 那时游戏
早建完了。实测把注入挂到 `ScriptLoader.Load` 上确实"更早了一点点", 但比首次注入(开图鉴时)还**晚 9ms**,
零收益。→ 这两处只能**渲染完再覆写标签** (`hookProfileName` / `hookLogAuthorName`, 上游
`LogAuthorFormat_Patch` 也是这么干的)。

**判定方法 (可复用)**: 注入后 snapshot 目标 builder 的字典是否含该 id + hook `TryBuildAuthorText` 看
命中/未命中 —— 一眼分清"数据没写进去"和"写进去了但那个消费者看不到", 这是两种完全不同的修法。

**② async 方法的"存根"可能 hook 不上。** 为拿"字典何时定型"的证据, 我 hook 了
`AuthorTextBuilder.LoadDataAsync` —— 它整场**一次都没触发** (同类里 `TryBuildAuthorText` hook 正常)。
推测 async 方法编译出的存根极短(只有 `AsyncUniTaskMethodBuilder.Start`), 被 IL2CPP **内联**进调用方,
attach 在存根上自然不响。**教训**: 探针不响时先怀疑"是不是被内联了", 别急着下"没被调用"的结论。
(本条的结论最终由**注入时刻 vs 快照时刻**的时间戳对比独立坐实, 不依赖那个 hook —— 探针失效时换一条
证据链, 比修探针划算。)

**③ `A.gf` 不查基类; "探错类"会给出看起来像平台差异的假结论。**
`A.gf` = `il2cpp_class_get_field_from_name`, **不查基类** (utils.js:384 有注)。首轮我探
`WitchTrialsLogMessageUi._authorTextBuilder` 得到"字段未找到", 差点写成"macOS 与 Windows 字段名不一致"。
真相是**探错了类**: 持有 builder 的是面板 `WitchTrialsLogUi` (0x160), 而 `WitchTrialsLogMessageUi`
只在 `ModifyAuthorPanel(AuthorTextBuilder)` 里**把 builder 当参数收下**, 自己不存。
**规矩**: 报"字段不存在"之前先确认这个类到底持不持有它 —— 类上有个"要用某对象"的方法, 不等于它把该对象
存成了字段。要跨基类找字段用 `findFieldAnywhere()` (characters.js), 找不到就当功能不可用、绝不猜偏移。

**同场次的附带发现**: `CharacterDataItem._age/_height/_weight` (0x28/0x30/0x38) 全游戏**没有任何读取点**
(`AuthorTextBuilder` 只取 `_name`/`_familyName`) → info.json 里的 `Age`/`Height`/`Weight` 是纯作者元数据,
不会显示。旧文档"复测后看年龄/身高/体重字段是否更完整"这条判据据此**作废** (见 ROADMAP 差距 7)。
