# ManosabaMod macOS 移植 — 架构与原理

本文说明 macOS 版 (Frida) 的架构、工作原理、与 Windows 版 (BepInEx) 的区别,
以及为什么 mod 剧本格式天然兼容。

---

## 一、Windows 版加载器怎么工作 (ManosabaLoader)

Windows 版通过 **BepInEx + Il2CppInterop + Harmony** 注入游戏:

```
manosaba.exe
  └─ Doorstop (winhttp.dll 代理) ──► CoreCLR (.NET 6) ──► BepInEx
        ├─ Il2CppInterop  — 把 IL2CPP 对象暴露给 .NET 侧
        ├─ Harmony        — patch 游戏方法 (IL 层)
        └─ ManosabaLoader:
             • AddModLoader    → LocalResourceProvider(root) + converter
                                  + ProvisionSource 插进各 ResourceLoader
             • AddModStartMenu → 构造菜单剧本 → AddLoadedResource 塞缓存
             • HookStartGame   → 把标题剧本 StartGame 的 @goto 重定向到菜单
             • ModManager      → 扫描 ManosabaMod/*/info.json
             • ModClueLoader / ModWitchBookPatch / ModMovieLoader ... (各子系统)
```

## 二、macOS 版 (Frida) 怎么工作

没有 BepInEx / .NET / Harmony,直接用 **Frida 在 IL2CPP 运行时层面**做同样的事。
源码是 `src/` 多文件 ES modules(便于维护),由 **frida-compile 打包成单个
`dist/manosabamod.js` bundle** 注入(📦 asset 格式,`run_mod.sh` 用 `Script.evaluate`
把 modList/MOD_ROOT/movieMap 作为 fragment 注入全局)。

```
manosaba.app (GameAssembly.dylib, IL2CPP)
  └─ Frida 注入
        ├─ dlopen hook            → 绕过 Steam 校验 (SteamAPI 函数替换)
        ├─ il2cpp_thread_attach   → 解锁 il2cpp_runtime_invoke
        ├─ 菜单 (缓存方案)         → Script.FromText + AddLoadedResource
        ├─ provider 管线          → LocalResourceProvider(MOD_ROOT)
        │                          + converters 字典 (FSG 绕过)
        │                          + ProvisionSource 插进
        │                            ScriptLoader / TextManager / voiceLoader / audioLoader
        ├─ Movie 支持             → URL 流式 (get_UrlStreaming/BuildStreamUrl/Play/HoldResources)
        ├─ WitchBook 线索         → 运行时读 info.json Clues + 注入页面数据/状态/纹理
        │                          + 会话隔离 (mod 切换清理 + 恢复原版默认显示)
        └─ Interceptor.attach      → 钩 TitleUi.Activate 决定注入时机
                                     + GotoModified/脚本加载诊断链
                                     + ScriptLoader.Load 识别当前 mod
```

加载 mod 剧本的完整链路:

```
点菜单 → @goto {nextScenario} → GotoModified → ScriptLoader.Load(path)
  → LoadedByLocalPath 缓存 miss → ProvisionSources[0] = 我们的 LocalResourceProvider
  → 定位 <MOD_ROOT>/<modKey>/Scripts/<path>.nani → 读字节
  → converters 字典[typeof(Script)] = NaniToScriptAssetConverter → Script → 播放
```

## 三、核心原理

### 1. il2cpp_thread_attach 
`il2cpp_runtime_invoke` 必须在 attach 到 IL2CPP domain 的线程上调用。
在未 attach 的 Frida 线程上,invoker stub 解引用 `Thread::Current() == NULL` 崩溃。
attach 之后几乎所有方法都能经 runtime_invoke 调用。

### 2. 菜单走缓存, mod 剧本走 provider
- 菜单是**合成文本**,`Script.FromText` 构造后 `AddLoadedResource` 塞进 ScriptLoader
  缓存 (LoadedByLocalPath),不走 provider。
- mod 剧本是**磁盘文件**,走 provider 管线懒加载。两者互不干扰。

### 3. FSG 泛型方法墙 + inflated 绕过
IL2CPP 对引用类型泛型方法使用 fully-shared-generic (FSG) 共享代码。
`il2cpp_runtime_invoke` 对**泛型方法定义**报
`ExecutionEngineException | Invalid call to method`。
但: 从**实例化后的泛型类**取方法 (il2cpp_class_get_method_from_name),
返回 `is_inflated=1` 的可用方法,可直接调用。

因此绕开 `AddConverter<T>`(定义类非泛型,只有泛型 DEF): 直接填充
`Dictionary<Type, List<IConverter>>`:
1. 从字典的 genericInst 挖出 `List<IConverter>` 类
   (`il2cpp_class_get_type` → `data.generic_class` → `context.class_inst` → `type_argv[1]`)
2. `object_new` + inflated `List.ctor` + inflated `List.Add(converter)`
3. `il2cpp_type_get_object(typeof(Script))` 拿托管 Type 作 key
4. inflated `Dictionary.Add(key, list)`

### 4. ScriptLoader.Load
直接 `runtime_invoke` 一个 async 方法 (`ScriptLoader.Load`) 会 SIGSEGV
(缺游戏侧执行上下文,续体无法正确投递)。必须让游戏自己的
`@goto → GotoModified → ScriptLoader.Load` 驱动。

### 5. Movie — URL 流式 (不走 VideoClip provider)
`@movie` 命令实现 `IPreloadable`,**剧本加载时**就会被预取:
```
ScriptPlaylist.LoadResources
  → PlayMovie.PreloadResources()
    → MoviePlayer.HoldResources(name) → get_UrlStreaming = false(默认)
      → 走 videoLoader 加载 VideoClip → mod 视频无 provider → 失败
      → LoadOrErr 抛错 → 整个 @goto 中止 → 黑屏回标题
```
这就是"跳转后剧本一行都没执行就黑屏"的根因——**不是执行到 @movie 才失败,
而是剧本加载时预取就炸了**。

修法与 Windows 版 (ModMovieLoader) 一致,用 **URL 流式播放**绕开 VideoClip:
- `run_mod.sh` 扫描 `<modKey>/Movie/*.mp4|webm|ogv` → 注入 `movieMap = {名字: 绝对路径}`
- 钩 `MoviePlayer.HoldResources` 入口 → 预加载阶段记录 mod 视频名 (pending)
- 钩 `MoviePlayer.get_UrlStreaming` → mod 视频强制返回 true (预加载跳过 VideoClip, 播放走 URL)
- 钩 `MoviePlayer.Play` 入口 → 播放阶段记录 mod 视频名
- 钩 `MoviePlayer.BuildStreamUrl` → 返回 mod 视频本地绝对路径 (VideoPlayer 认绝对路径)

`get_UrlStreaming` / `BuildStreamUrl` 都是同步方法,可安全 hook;异步方法
(`Play`/`HoldResources`/`LoadMovieClip`)不能直接 runtime_invoke,但**入口/返回值
用 Interceptor 拦**没问题。

### 6. WitchBook 4 分类 — 数据注入 + 会话（资源）隔离 (镜像 Windows ModClueLoader + ModProfileLoader + ModRuleNoteLoader)

`@update` 链路: `UpdateWitchBook.Execute` → `WitchBookUi.UpdateVersion` → `WitchBookScreen.UpdateVersion`
→ `XxxPage.UpdateVersion` → `_state.SetVersion`。原版对 `_itemIds` 之外的 id 不处理,
`_localizedTextData` 也没有 mod 条目 → 图鉴不显示,点击还会 KeyNotFoundException。

支持 4 分类 (Clue/Profile/Rule/Note) + 新角色 (Characters):
- **数据来源**: 运行时用 libc (`open/read/lseek`, Frida 无 File API) 读
  `<MOD_ROOT>/<key>/info.json` 的 `Clues`/`Profiles`/`Rules`/`Notes`/`Characters` +
  扫 `WitchBook/{Clues,Profiles}/*.png`。
- **@update 拦截**: 钩 `WitchBookUi.UpdateVersion` + `WitchBookScreen.UpdateVersion`
  (同步方法) → 按 `WitchBookCategory` 路由 (Clue=0 Profile=1 Map=2 Rule=3 Note=4)。
- **数据注入**: 向各 `XxxPage._loadedDataItemMap` 注入 `VersionedItem<TItem>`
  (object_new + 直写字段, 绕开泛型 ctor); 向 `_itemIds` 追加 ID; 向 `_localizedTextData`
  预填 `Dictionary<LocaleKind, ...>`(键用与 `_idVersionPair` 同一 IdVersionPair 实例 →
  原版 RefreshPageContent 直接命中); `_state.SetVersion` 设状态。
  - Clue: `LocalizedTexts(Name, Desc)`; Profile: `string(Desc)`; Rule: `LocalizedTexts(Subtitle, Desc)` + `_numberings`; Note: `LocalizedTexts(Title, Desc)`。
- **人物姓名**: 新角色经 CharacterData + AuthorData 注入 + `ProfilePage.RefreshPageContent`
  onLeave 覆写 `_authorLabel`(BuildFullName 同款富文本: 姓首字大号带色)。
- **纹理**: 读 PNG → `Texture2D` + `ImageConversion.LoadImage` → 注册进
  `AddressablesManager._loadedAssets`,`@spawn "Clue"` 弹窗和缩略图共用。
- **当前 mod 识别**: 钩 `ScriptLoader.Load` 匹配 `modList` 的 `Enter` 路径
  (Windows 读 `modKey` 自定义变量, 思路一致)。
- **会话（资源）隔离 — 整页重建** (防止跨剧本/跨会话继承):
  - **只注入当前 mod** 的条目。
  - **override** (mod id == 原版 id, 如 `Hiro`): 注入时移除原版同 id 条目 + 注入 mod 版。
  - **整页重建**: 页面首次出现时捕获原版 `_loadedDataItemMap` 快照 (按页面实例);
    mod 切换/回标题时 **清空 map → 从快照重添全部原版条目** → 重建 `_itemIds` →
    补缺失 dict 项 → 注入当前 mod。每次会话从原版基座开始, override 完全可逆 (含 v1)。
  - 面板恢复捕获的原版默认文本/占位图 (`_defaultTexture`),空态非纯白。

隔离只隔离剧本资源，如果剧本scripts文件夹有 'System/System_title.nani' 之类的，还是会正常生效（替换游戏原主菜单）

### 7. 背景 + 立绘 (镜像 Windows AddModLoader 背景块 + AddRichCharacter/AddSimpleCharacter)

**背景** (`@back <name>`, Id 默认 MainBackground):
- 对 `BackgroundManagerExtended.GetAppearanceLoader("MainBackground"/"Stills"/"Tricks")`
  各加 ProvisionSource (`<key>/Backgrounds/<backId>`) + `JpgOrPngToTextureConverter` (Texture2D)。
- 覆盖原版背景: 同名文件放 `Backgrounds/<backId>/` 即可 (provider 优先级高于原版)。

**立绘** (`@char <charId>.<appearance>`):
- ① `ResourceProviderManager.providersMap` 加 `<key>` → LRP(root) + Texture2D converter
  (角色 sprite 提供者)。
- ② `CharacterManager.Configuration.MetadataMap` 注册 `CharacterMetadata` (镜像 Windows):
  - `Implementation` = `Naninovel.SpriteCharacter, Elringus.Naninovel.Runtime, Version=..., PublicKeyToken=null`
    (**完整 AQN**, IL2CPP Type.GetType 需全名; 程序集是 Elringus.Naninovel.Runtime)。
  - `Loader` = ResourceLoaderConfiguration{ PathPrefix=`<key>/Characters`, ProviderTypes=[`<key>`] }。
  - `Pivot`(0.5, 0.695), `PixelsPerUnit`=100 (0 → 立绘不可见), DisplayName, Color。
- info.json `Characters`(完整) + `SimpleCharacters`(简单) 都注册。

**测试坑**: 游戏画面顶部有黑色 Overlay 遮罩, mod 剧本须先
`@back SubId:"Overlay" Transparent tint:"#000000"` 清掉 (参考 开始一个简单的对话.md),
否则背景/立绘被遮罩盖住看似"不显示"。

## 四、与 Windows 版的区别

| 维度 | Windows (BepInEx) | macOS (Frida) |
|------|-------------------|---------------|
| 注入 | Doorstop → CoreCLR → BepInEx → Il2CppInterop | Frida → IL2CPP C API |
| Hook 方法 | C# Harmony attribute (patch IL) | `Interceptor.attach` methodPointer |
| 调用托管代码 | 直接 C# | `il2cpp_runtime_invoke` (+ thread_attach) |
| 注册 converter | `AddConverter<T>()` (C# 泛型调用) | 直接填充 converters 字典 (inflated 方法) |
| 异步加载 | 游戏线程自然执行 | 必须让游戏 @goto 驱动 |
| IL2CPP 泛型共享 | 全量实例化 (字段类型与声明一致) | **共享实例化 → 部分字段运行时类型漂移** (见 七) |
| 平台 | Windows x64 | macOS Apple Silicon (arm64) |

## 五、mod 格式兼容性 — 为什么 mod 直接能用

**mod 格式由游戏引擎定义,不是加载器定义。** 两版加载器做的同一件事:
把 mod 文件夹暴露给游戏**同一套资源系统**。

mod 目录结构 (两版完全一致):
```
ManosabaMod/<ModName>/
├── info.json              ← 同一 schema (Name/Enter/Clues/$schemaVersion)
├── Scripts/*.nani         ← Naninovel 剧本语言, 游戏自己的 ScriptParser 解析
├── Text/Scripts/*.txt     ← 本地化文档
├── Audio/  Voice/         ← 音频 (限 PCM16/44100Hz/立体声 wav; ogg 需转码, 见 GOALS.md;
                              run_mod.sh 可自动检测非标音频并询问转换 — 可选增强 normalize_audio.py)
├── Backgrounds/ Characters/ ← 贴图
└── Movie/  WitchBook/     ← 视频 / 线索
```

因此 mod 在 macOS 上**直接加载播放**——游戏引擎读的是同样的文件,加载器只是把
`ManosabaMod/` 目录接进了游戏。

## 六、已支持 / 未支持

| 功能 | 状态 |
|------|------|
| mod 菜单 (标题画面) | ✅ |
| mod 剧本 (.nani) | ✅ |
| 本地化文档 (.txt) | ✅ |
| voice / audio (.wav, 限 PCM16/44100Hz/立体声) | ✅ |
| 音频 (.ogg) | ❌ 不支持 (ffmpeg 转 wav; 根因与 wav 限制见 GOALS.md 已知开放项) |
| WitchBook 全 4 分类 (Clue/Profile/Rule/Note) + 新角色 | ✅ (数据注入 + 状态 + 纹理 + 姓名) |
| WitchBook 会话隔离 (整页重建 + override 可逆) | ✅ |
| 背景 (Backgrounds/MainBackground|Stills|Tricks) | ✅ (JpgOrPngToTextureConverter provider) |
| 立绘 (@char Characters/SimpleCharacters) | ✅ (ActorMetadata 注册 + providersMap) |
| Movie (.mp4/.webm/.ogv) | ✅ (URL 流式) |
| @choice handler:"<Id>" | ✅ |
| CutIn (论破) | ✅ |
| 角色名富文本 (AuthorTaggedTextGenerator) | ✅ |
| 致谢演出复刻 (staff 滚动 + 共犯 36 屏 + 製作段) | ⚠️ 试验性 (macOS 独有, 上游无此功能, 稳定性未实测, 见九节) |
| 调试工具 | ❌ 未实现 (macOS 用 probe_*.js 探针替代) |

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

**已确认事实**: `@char SubId:"Middle" <char>.<appearance>` (如 BoneWingEma 的
`SubId:"Middle" gyEma-Ch2.8`) 显示的立绘在回标题后**不被清除**;
无 SubId 用法的 mod (Rewind) 无残留 → SubId 是差异因素。

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
2. **退出到标题黑屏**: 覆盖标题的 mod 剧本 (如 Rewind 的 `System/System_Title.nani`)
   从脚本缓存正常播放, 但 `@back EmaHiro Id:"Stills"` 等 **mod 资产**加载失败 →
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
`<key>/Backgrounds/Stills` 消失, `EmaHiro ResourceExists mp=0x0` → LogException。

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
主线程被占用数秒 → 肉眼卡顿。优化方向 (见 GOALS.md「差距」5):
① **verify-before-repair**: 重注入前先扫各 loader 列表, 全在则跳过 (绝大多数重注入冗余);
② 按 loader 定向重注入: 只补刚被 wipe 的 loader, 最贴上游语义, 但 LRP 若只被 JS 记录
引用会被 IL2CPP GC 回收 → 悬垂指针, 需额外 rooting。

**附带修复 —— WitchBook 缺语言条目** (2026-08-18): mod info.json 条目缺某语言时
(如 Clues 只有 zh-Hans), 日文下图鉴查 inner[ja] → KeyNotFoundException →
name/desc 空白。`registerLocalizedDict` (witchbook/pages.js) 补全全部 7 种游戏语言
(ja/en-US/zh-Hans/zh-Hant/ko/fr/es), 缺失回退 `pickLocaleText` (zh-Hans→ja→任意),
与游戏 .txt "Missing translation → source locale" 语义一致。

### 7.6 角色元数据守卫失效 → 原版角色被 mod 覆写 (2026-09-25)

**现象**: 装了 **Twilight_TestMod005** (info.json 用**原版角色 id** `Hiro/Warden/…`
声明 `Characters`) 后, 原版剧本 `@char Hiro.Arms3,Eyes1_Normal_Open5,Default` /
`@char Warden.1` 在预加载时报 `Naninovel.Error: Failed to load '<外观>' resource`;
卸载该 mod 后日志 0 条 (modlog1/modlog2 对照)。

**根因**: `witchbook/characters.js` 的 `ContainsId` 守卫写成 `r.ret.toInt32() === 1`
(7.4 补充表第一种) → 守卫永不生效 → `AddRecord` 把原版 `CharacterMetadata`
(LayeredCharacter) 覆盖成 `SpriteCharacter + PathPrefix=<mod>/Characters`。
上游 `ModResourceLoader.AddRichCharacter` 有 `if (ContainsId) return;`。
`providersMap.ContainsKey` 是同一份错误写法的第二处 (modlog2 留下重复 `Add`
的 ArgumentException 实证)。

**修复**: 两处改用 `invokeBool()`。修复后日志给出 `addCharacterProviders:
mod 'Twilight_TestMod005' 新注册 13 个角色, 跳过 16 个已存在 ID`
(29 条声明 = 16 撞原版 + 13 自有) —— 这行现在是"mod 声明原版 id"的可观测信号。
注: `choice.js:chBool` 是 `invokeBool` 的重复实现 (S2 待清理)。

### 7.7 `@update` 连排 → 主线程冻结 2.1 s — 合帧去抖 + 按分类收敛 (2026-09-25)

**现象**: 进入 Twilight 剧本时主线程冻结 **2.12 s** (日志 13:01:16.338→18.460,
1343 行, 占全会话日志 76%)。触发点是 `Twilight_TestMod005/Scripts/…/Main.nani`
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

**现象**: Twilight 会话中 **回标题 → 再进 mod → 点开魔女图鉴** 必闪退 (首次进 mod
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

**现象**: 进 Gapless 剧本后魔女图鉴打不开, 每次点击都抛
`KeyNotFoundException: The given key 'WitchTrials.Models.IdVersionPair' was not present in the dictionary.`,
游戏随之中断打开流程; 同一加载器下 Twilight 剧本正常 (差别只是剧本 `@update` 激活了哪些键)。

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

## 八、日志系统 (2026-08-10 引入)

**动机**: 游戏进程崩溃时 Frida 脚本跟着死, console 缓冲丢失, macOS 系统日志经常
什么都没有。
终端彩色 + 游戏根 `modlog.txt` 文件 + 崩溃前 flush。

**级别与颜色** (src/log.js): ERROR=红 / WARN=黄 / INFO=青 / DEBUG=灰, 行前缀
`[v3][HH:MM:SS.mmm][LEVEL] `。`error/warn/info` 无条件输出; `debug` 内部再门控
`MOD_DEBUG` (双保险)。默认量不变: wblog=INFO 可见, dbg=DEBUG 归 MOD_DEBUG。

**调用点分级** (2026-08-10 审计, 用户确认): 29 处真实失败 → `error()` (类解析失败、
ensureItemIdsString 重建失败、catch 分支); 34 处软失败 → `warn()` (NOT FOUND/未找到/
为空/失败/跳过, 含 `无 mod WitchBook 数据`); 13 处过程噪音 → `dbg()` (`>>> @update 忽略`、
`>>> WitchBook 触发`、`_itemIds off=0x` 字段状态、预填/纹理加载等); 其余保持 INFO
(hooks 就绪 / 注入完成 / mod 切换 / `_itemIds → String[] 重建` / `>>> @update 拦截` /
`+N 纯新 ID` / 状态应用 N 条 / 面板默认值捕获恢复)。消息**文案**未改, grep
`[v3]` (统一前缀) 与 `[WitchBook]` (wblog 前缀) 仍命中。

**文件写入**: libc `open(O_WRONLY|O_CREAT|O_TRUNC)` + 逐行同步 `write` (src/io.js),
崩溃不丢已写行; 每运行截断重开 = 一份干净 modlog.txt。路径: 默认 `<游戏根>/modlog.txt` ,
`MOD_LOG=<path> ./run_mod.sh` 覆盖; 文件不可用 (如 REPL 直跑) 则 console-only 不崩。

**终端彩色与剥色**: 关键事实 (2026-08-10 实证) — 本 setup 中 bundle 的 `console.log`
**不经 frida 消息桥** (on_msg 收不到), 由 V8 runtime 直接写到游戏进程的 stdout 副本
(spawn 时 frida 保留的父进程 fd, 即终端或重定向目标)。因此剥色在 **JS 侧**: run_mod.sh
的 Python 检测 `sys.stdout.isatty()`, 非 TTY (重定向/管道) 或 `MOD_NO_COLOR=1` 时注入
`var MOD_NO_COLOR=true` fragment → log.js 输出明文; TTY 时注入 false → 终端彩色。
on_msg 只兜底 frida 错误消息等 (不含 bundle 日志)。探针 (probe_*.js) 独立脚本、输出
只在终端不进 modlog.txt; 全量捕获 (含探针) 用 `MOD_NO_COLOR=1 ./run_mod.sh > all.log`。

**崩溃前 flush**: `Process.setExceptionHandler` 回调只做同步文件 `write` + `fsync`
追加 `[FATAL] !!! CRASH signal=... address=...`, 然后 `return false` 放行 (崩溃行为
不变)。回调内**禁 console/RPC** (异常上下文死锁风险)。API 不可用则 fallback hook
`abort` / `__pthread_kill`(SIGABRT)。即使 handler 未触发, 同步逐行写已保证已写行不丢,
仅丢崩溃尾部标记。

**Unity/Naninovel 提醒**: 全量钩 `UnityEngine.Debug` Log/LogError/LogWarning/LogException
(永远开, 不受 MOD_DEBUG 影响), 按级别路由: LogError/LogException→ERROR(红)、
LogWarning→WARN(黄)、Log→INFO(青) —— 功能等价于 Windows BepInEx 的 Naninovel Log,
给剧本作者的提醒 (缺翻译 `Missing translation for 'zh-Hans/...'`、剧本解析错) 进终端
也进 modlog.txt。

**约束**: 所有日志调用必须在 `initLog` 之后 (entry.js 顶层先 initLog 再装 crash
handler, 早于首个 wblog)。文件体积第一版不做轮转, `MOD_DEBUG=1` 时 dumpObj FULL 栈
涨得快, 文档注明。

## 九、致谢演出复刻 — 试验性 (macOS 独有, 2026-08-19+)

> **状态: ⚠️ 试验性**。**上游 Windows 版 ManosabaMod 没有此功能** — 这是 macOS 版
> 自研的致谢演出复刻, 与上游功能对齐目标无关。**稳定性未经充分实测**:
> 依赖原版 `CreditsDirectorAct2` 运行时参数 (bpm/拍数/滚动速度) 与 CreditsUI 场景结构,
> 游戏版本更新可能失效。测试脚本与数据 (build/extract/integrate/probe/credits-data)
> 不随仓库分发。

**功能** (src/credit.js, 全部静态本地数据驱动, 运行时零提取):
剧本内 `@set "g_modCreditRoll = \"data.json\""` + `g_modCreditRollPhase` 分阶段触发:

- **phase 1 — staff 主名单滚动**: `CreditRollVerticalScroll.ScrollAsync(height/speed)`,
  222 条目标签逐条目静态填充, 与原版 prefab 布局一致。时长 = ContentHeight/_scrollSpeed
  (248), 写入 `g_staffDuration` 供 nani `@wait`。
- **phase 2 — 原版 stills + 共犯者翻页**: 9 张原版致谢画面 (静态裁图) 按原版拍数时序
  播放; 共犯者 (Special Thanks) 按 36 屏页级状态机翻页 — zh 420 + ja 4544 合并完整
  名单 (原版显示的就是合并全量, 非运行时字典), 每屏一次 TMP 富文本 `set_Text`
  (行 join `<br>`), fade 0.51s + display 2.30s ≈ 3.3s/屏, 与 run-30c 实测原版节奏一致。
- **phase 3 — 製作・販売/Acacia/© 段**: 共犯之后最后一段滚动, 文本为 prefab 静态默认,
  只激活 + ScrollAsync。

**关键坑 (踩过实锤)**:
1. **引擎级 Unity API 必须在主线程调** — JS 定时器线程 (setTimeout/setInterval 回调)
   调 `get_ContentHeight`/`ScrollAsync` = Frida "breakpoint triggered" (IL2CPP 线程保护
   int3)。共犯翻页的 `set_Text` 是纯托管路径侥幸可跑, 但滚动必须走 `g_creditTick`
   nani 轮询泵 → onSVV (SetVariableValue 主线程同步 hook) 执行 (run-30f)。
2. **运行时字典 `_specialThanksCredits@0xA0` 只有部分数据** (ja 459 + zh 420),
   原版显示的是 asset 全量 (4964 人次) — 静态提取自 run-30c TMP set_Text 全量捕获
   (509 条), 按 REPL/APPEND 规则重建 36 屏, 原样保留富文本。
3. **原版节奏参数全部运行时读**: `_scrollSpeed@0x68`、still 拍数 (delay/fade/display@0x6C-0x74)、
   bpm@0x30、共犯 fade/display 拍数 (0.75/3.38) — 不硬编码。
4. **总时长对齐歌曲** (run-30g): 原版演出 = staff 滚动 119s + 共犯 36×3.3s + 製作段,
   无段间空档。mod 侧去掉 endPause/nani 预热等待/多余缓冲后, 全流程 ≈ 260s,
   在 5 分钟歌曲 (bloom) 结束前播完。

**数据文件**: mod 侧 `data.json` (staff 222 条 + thanks 36 屏 + production 3 条)
与 `Assets/thanks-pages.json` (格式见 docs/CREDIT_ROLL.md) — 提取/生成脚本与测试 mod
均在仓库外 (`test-tools/`), 不随仓库分发。
