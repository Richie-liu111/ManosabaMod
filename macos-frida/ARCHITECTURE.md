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

没有 BepInEx / .NET / Harmony,直接用 **Frida 在 IL2CPP 运行时层面**做同样的事:

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

### 6. WitchBook 全 4 分类 — 数据注入 + 会话隔离 (镜像 Windows ModClueLoader + ModProfileLoader + ModRuleNoteLoader)

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
- **会话隔离 — 整页重建** (防止跨剧本/跨会话继承):
  - **只注入当前 mod** 的条目。
  - **override** (mod id == 原版 id, 如 `Hiro`): 注入时移除原版同 id 条目 + 注入 mod 版。
  - **整页重建**: 页面首次出现时捕获原版 `_loadedDataItemMap` 快照 (按页面实例);
    mod 切换/回标题时 **清空 map → 从快照重添全部原版条目** → 重建 `_itemIds` →
    补缺失 dict 项 → 注入当前 mod。每次会话从原版基座开始, override 完全可逆 (含 v1)。
  - 面板恢复捕获的原版默认文本/占位图 (`_defaultTexture`),空态非纯白。

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
├── Audio/  Voice/         ← 音频 (wav 等)
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
| voice / audio (.wav) | ✅ |
| WitchBook 全 4 分类 (Clue/Profile/Rule/Note) + 新角色 | ✅ (数据注入 + 状态 + 纹理 + 姓名) |
| WitchBook 会话隔离 (整页重建 + override 可逆) | ✅ |
| 背景 (Backgrounds/MainBackground|Stills|Tricks) | ✅ (JpgOrPngToTextureConverter provider) |
| 立绘 (@char Characters/SimpleCharacters) | ✅ (ActorMetadata 注册 + providersMap) |
| Movie (.mp4/.webm/.ogv) | ✅ (URL 流式) |
