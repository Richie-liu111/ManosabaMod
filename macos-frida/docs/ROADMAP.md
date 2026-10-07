# ManosabaMod macOS 移植 — 路线图与差距

> 随代码演进更新。最后更新：2026-08-23（新增 macOS 自研致谢演出复刻 — ⚠️ 试验性, 上游无此功能, 见「差距」6）。

> **蓝本勘定（2026-08-11/12）**：Windows 对照的蓝本是**上游 Windows 版 ManosabaLoader.dll**（离线反编译对照，仅作参考实现）——唯一包含 `ModChoiceHandlerLoader` + `ModObjectionCutInLoader` 的版本。GitHub 源码仓库 `ManosabaMod-2.0.0`（csproj v1.0.0）**没有**这两个类；GitHub release 的 ManosabaMod2 DLL（221KB）与 `ManosabaMod`（221KB，md5 86d623ab）同源，也都没有。C# 侧参考路径：`DoomsGuardians/Project-Cannon-and-Candle`（Packages/com.elringus.naninovel/，与 dump.cs 签名完全匹配）。
>
> **上游脉络（2026-08-12 GitHub 核实）**：IrisuM/ManosabaMod 的 PR 贡献——v2.0.0（2026-03-21）= #4（zyf722：图鉴自定义/视频/schema 迁移）+ #5（Asa-Chiri：OGG/任意 WAV 音频）+ #6（Asa-Chiri：语言切换资源修复）；master 2026-04-27 合入 #7–#10（均 Asa-Chiri，提交署名 Weicheng Zhao，Co-Authored-By Claude Opus：DisplayName 统一+颜色恢复、多语言本地化、菜单 UI 本地化、@choice handler + @gosubCutIn），未发 release。上游 GitHub release 的版本即对应此状态。macOS 蓝本源码（`ManosabaLoader/`）与其逐文件对齐。语言切换资源修复对应提交 **`66e5388b`**（LocaleHelper + LocaleWatcherComponent + ReInjectModProvisionSources，见「差距」5）；mod 名称/描述/作者/章节名多语言本地化对应提交 **`7b021a11`**（schema 2.1→2.2，与 某 mod info.json ja 变体配套）。

## 目标

在 macOS ARM 原生游戏（魔法少女的魔女审判/manosaba）上，用 **Frida 运行时注入**（IL2CPP C API 动态解析，无静态地址依赖）实现与 Windows 版 ManosabaLoader（BepInEx + Il2CppInterop + Harmony）**功能对齐**的 MOD 加载器：加载 mod 的剧本/本地化/语音/音频/背景/立绘/视频，并注入魔女图鉴（WitchBook 全分类）数据与审判环节自定义。实现方式是镜像 Windows 模块的机制，不依赖任何 Windows RVA。

架构现状：`src/` 多文件 ES modules 工程，`frida-compile` 打包单 bundle 注入（`dist/manosabamod.js`）。日志分层（2026-08-10 起）：终端彩色（ERROR 红/WARN 黄/INFO 青/DEBUG 灰）+ 游戏根 `modlog.log` 文件 + 崩溃前 flush（详见 ARCHITECTURE.md 八节）；机制日志走 `MOD_DEBUG` 开关（默认关），游戏侧 `Unity.LogError` 全量抓取为最高优先级信号（ARCHIVE 教训 2/3）。

## Windows vs macOS 功能对照

| Windows 模块 (ManosabaLoader/, 仓库内) | 功能 | macOS 状态 |
|------|------|------|
| ModResourceLoader（含 AddModStartMenu） | mod 资源管线注册（ProvisionSources 注入）+ 菜单（含翻页） | ✅ 已实现（菜单翻页 2026-08-03 从 16h 回迁） |
| ModClueLoader + ModWitchBookPatch | WitchBook 线索注入 + 修复 | ✅ 已实现（含会话隔离/override/默认面板恢复） |
| ModProfileLoader | WitchBook 档案注入 | ⚠️ 部分（macOS 走**替代路径**：渲染期覆写姓名 + 页面注入；上游那两次 `CharacterData`/`AuthorData` 数据注册被停用，理由疑已过期 — 见「差距」7） |
| ModRuleNoteLoader | WitchBook 规则/笔记注入 | ✅ 已实现 |
| ModMovieLoader | 视频 URL 流式播放 | ✅ 已实现 |
| Utils/ModTextureHelper | PNG → Texture2D → Addressables 注册 | ✅ 已实现 |
| Utils/AuthorTaggedTextGenerator | 角色名富文本（姓/名分级字号+颜色） | ✅ 已实现（buildAuthorTemplate） |
| ModAudioPatch | WavToAudioClipConverter 补丁 | ⚠️ 部分（注册等价；原装转换器仅 **PCM16/44100Hz/立体声** wav，非标 wav 音高偏移、ogg 未支持 — 2026-08-12 决策 ffmpeg 转码，见已知开放项） |
| ModMetadataGenerator | 角色/背景/剧本元数据默认类型 | ⚠️ 部分（macOS 手写 CharacterMetadata 字段，无独立模块） |
| ModChapterDisplay | 存档画面自定义章节名 | ✅ 已实现 |
| ModUiStrings（#9） | mod 菜单 UI 文案本地化 | ⚠️ 边缘（macOS 菜单文案硬编码中文，不随语言切换；中文环境无感） |
| ModDebugTools | 调试工具（RenderTexture 截图等） | ❌ 未实现（macOS 侧用本地 `probe_*.js` 探针; 探针不随仓库发布） |
| ScriptWorkingManager / ModManager | 工作区/配置管理 | ⚠️ 由 run_mod.sh 命令行约定替代 |
| （Windows 无此模块） | 致谢演出复刻（staff 滚动 + 共犯 36 屏 + 製作段） | ⚠️ 试验性（macOS 自研, **上游无此功能**, 稳定性未实测 — 见「差距」6） |

## 差距 / 未闭环清单

1. **mod 自定义 ChoiceHandler（魔女审判环节）** — ✅ 2026-08-11/12 已闭环
   - 镜像 C# 蓝本 `ModChoiceHandlerLoader` 四步：真 VirtualResourceProvider + `AddResource<GameObject>`（真 Resource，path 含 `ModChoiceHandlers/{Id}` prefix）+ ChoiceHandlerMetadata（Implementation 从原版 Trial meta 逐字节复制）+ `providersMap.Add("ModChoiceHandlers", vrp)`。actor 由游戏自己构造（克隆 BasePanel 原版面板 + mod 立绘替换）。
   - **两个最终根因**：① 往 Resource 塞组件而非 GameObject（ResourceExistsBlocking<T> 双条件，必须精确匹配）→ Instantiate 后 `get_gameObject`；② Resource.path 必须含 prefix（LoadedResource.ctor 的 BuildLocalPath 校验）。
2. **CutIn** — ✅ 2026-08-12 已闭环
   - 机制：SetVariableValue postfix 把 objectionCutInSpawnPath 改写为原版模板名（insideRewrite 守卫）+ pendingEntry；SetSpawnParameters postfix → BuildInstanceCache（GetComponentsInChildren<Image/SpriteRenderer>(true)，23 渲染器）→ SwapSpritesFromCache（按 sprite 名匹配 6 key）→ 动画不覆盖替换（1s 后 re-dump 验证）。
   - **最终根因（替换成功但不可见）**：`invoke()` 经 `il2cpp_runtime_invoke` 读 ≤8B 值类型返回（float/bool）读到垃圾——`get_pixelsPerUnit` 读回 1.77e-18（真值 37.8）→ `Sprite.Create` 以近零 ppu 创建 → sprite 无限放大不可见。修复：`directCall()`（utils.js）直读 MethodInfo 首字段 methodPointer，按正确返回类型（'float'）读 s0；Vector2/Rect 是 HFA（s0-s3）仍走缓冲 + 归一化守卫（[0,1] 回落 0.5）。详见 ARCHITECTURE.md 的 directCall 节。
   - 验证：6 sprite 全部显示（ppu=37.82/75.76/65.91/72.96 原版真实值），shader 分布与原版一致，动画不覆盖。
3. **ModChapterDisplay（存档章节名）** — ✅ 2026-08-12 已闭环
   - hook `WitchTrialsGameStateSlot.SetNonEmptyState`（实际实例类；C# 蓝本 patch 基类 GameStateSlotExtended，macOS 双 hook 都覆盖）onEnter 预覆写 + onLeave 兜底覆写 `_subTitleLabel`。
   - 数据：run_mod.sh 扫描 info.json 的 `ChapterNames`（值支持本地化 dict）注入全局 chapterNames（脚本路径 → 章节名）。
   - 布局：`GameStateMap.playbackSpot` offset 运行时读；`PlaybackSpot.scriptPath` 固定 @0x0（按名查找与字段类型反查在 macOS 上都返回 scriptPath@0x10 的错类，被实例内存实证推翻）；`_subTitleLabel` offset 运行时读。
   - **踩坑**：`set_richText`/`set_text` 经 `il2cpp_runtime_invoke` 调用 access violation at 0x1 → 改用 `directCall()` 直调 methodPointer（invoke 不可靠的又一样本）。空槽 `_subTitleLabel` 可能是非 null 垃圾指针，`A.ogc` 前必须做小地址守卫。
4. **菜单翻页** — ✅ 2026-08-03 已回迁（perPage=4，`ChoiceList_<页>` 方案，镜像 Windows AddModStartMenu）并通过回归验证（某个 mod 位于第 3 页，翻页进入正常）。
5. **语言切换后 mod 资源重注入** — ✅ 2026-08-18 已修（残留:切语言卡顿）
   - **现象**：游戏内切语言（zh-Hans ↔ ja）后：① 剧本内 `Failed to load 'zh-Hans' localization document for '<mod>/<script>'` ×N → `Failed to hold` 卡死；② 退出到标题黑屏（覆写标题剧本的 mod 的 `@back <mod 资产>` 等 mod 资产加载失败 → `Unity.LogException` → 死在 `@ShowUI TitleUI` 前 → TitleUi.Activate 永不触发 → 重注入钩子永不执行 → 自锁）。
   - **根因**：Naninovel 切语言时对**所有** `LocalizableResourceLoader<T>` 调用 `InitializeProvisionSources()` 重建 ProvisionSources 列表，抹掉 mod 注入的 provider（Scripts/Text/Audio/Voice/Backgrounds/Characters 全中）。macOS loader 唯一重注入点在 `TitleUi.Activate` hook（providers.js）→ 中途切换无恢复。**与 mod 内容无关**：`@print/@toast/@choice` 的 `|#ID|` 都只是"在错误时机被迫重载 doc"的触发器；此前把 `@choice |#ID|` 误判为根因，已排除（118 条 `@print |#ID|` 在 provider 被抹后同样 `Failed to hold`）。
   - **证据**（2026-08-18 modlog）：`RL.HandleLocaleChanged('ja')` ×几十 = 每个 loader 实例都在重建；随后 Backgrounds/Stills loader 只剩游戏自带 4 个 provider、`<mod 资产> ResourceExists mp=0x0` → LogException。
   - **修复**（2026-08-18，providers.js + choice.js，细节见 [PITFALLS.md](PITFALLS.md) 7.5）：hook `ResourceLoader<T>.HandleLocaleChanged`（FSG 共享体，一次覆盖所有 T 实例化）**onLeave → 主线程同步重注入**：遍历 modList 重跑 `addModLoader`；`insertProvisionSource` 带去重（同 prefix 幂等跳过）。覆盖全部 5 类 provider（Scripts/Text/Audio/Voice/Backgrounds(MainBackground|Stills|Tricks)/Characters），比上游 C# 版（仅 Text/Audio/Voice）更全——标题黑屏正是 Backgrounds。
   - **与上游 66e5388b 的差异 —— 不用 JS timer**：上游用 LocaleWatcherComponent（MonoBehaviour.Update）连续 ~10 帧重注入；macOS 初版镜像用 setTimeout 链，但 Frida timer 跑在**脚本线程**而非 Unity 主线程，与主线程异步 reload（UniTask 续体）竞争 → 2026-08-18 多次 SIGBUS/SIGSEGV 崩溃（GameAssembly 无符号偏移 +0xab2da0/0xb52c34/0xdc9988）。改 onLeave 同步重注入后，同一场景实测 **358 次重注入零崩溃**（主线程语义对齐上游）。
   - **已知残留 —— 切语言卡顿**：一次切换 ~200+ 次重注入（每个 loader 实例各一次，间隔 ~20ms≈每帧），每次全量 `addModLoader`（30 mod × 5 类）。去重只省 insert，findSvc / LRP 创建 / converters dict 填充仍每帧重复 → 主线程被占用数秒 → 肉眼卡顿。优化方向：① **verify-before-repair**——重注入前先扫各 loader 列表，全在则跳过（绝大多数重注入冗余）；② 按 loader 定向重注入——只补刚被 wipe 的 loader，最贴上游语义，但 LRP 若只被 JS 记录引用会被 IL2CPP GC 回收成悬垂指针，需额外 rooting。
   - **附带修复 —— WitchBook 缺语言条目**：mod 的 info.json 某条目缺某语言（如某 mod 的 Clues 只有 zh-Hans）时，日文下图鉴查 `inner[ja]` → KeyNotFoundException → name/desc 空白。`registerLocalizedDict`（witchbook/pages.js）现在补全全部 7 种游戏语言，缺的用已有文本回退（`pickLocaleText`：zh-Hans→ja→任意），与游戏 .txt "Missing translation → source locale" 语义一致（2026-08-18 已修）。

6. **致谢演出复刻** — ⚠️ 试验性（2026-08-19+, macOS 自研, **上游 Windows 版 ManosabaMod 无此功能**）
   - 复刻原版结尾致谢演出: staff 主名单滚动（CreditRollVerticalScroll.ScrollAsync,
     ContentHeight/_scrollSpeed=248）+ 原版 stills 9 张（拍数时序）+ 共犯者 Special Thanks
     36 屏翻页（zh 420 + ja 4544 合并完整名单, 0.51s fade + 2.30s display ≈ 3.3s/屏, 与
     实测原版节奏一致）+ 製作・販売/Acacia/© 段滚动。
   - 全部静态本地数据驱动（`data.json` + `thanks-pages.json`）, 运行时零提取; 原版节奏
     参数（bpm/拍数/_scrollSpeed）运行时读 director, 不硬编码。
   - **稳定性未经充分实测**: 依赖 CreditsDirectorAct2 运行时参数与 CreditsUI 场景结构,
     游戏版本更新可能失效。测试脚本/数据在仓库外（`test-tools/`）不随仓库分发。
   - 机制细节与踩坑（主线程泵/breakpoint triggered/运行时字典不全）见 [ARCHITECTURE.md](ARCHITECTURE.md) 九节。

7. **图鉴自定义角色的数据注册（上游 `CharacterData`/`AuthorData` 注入）** — ⚠️ 被停用，**停用理由疑已过期，待复测**
   - 上游 C# `ModProfileLoader.TryInjectCharacterData()` / `TryInjectAuthorData()` 把 mod 新角色
     注册进 `CharacterData._items` / `AuthorData._items`（名称模板），再由游戏自己的
     `AuthorTaggedTextGenerator.BuildFullName` 渲染 —— 上游在 **3 处**无条件调用（`ModWitchBookPatch`
     + `ModProfileLoader` 两处），另有 macOS 侧**完全没有**对应物的 `TryInjectProfileData()`（`ProfileData._items`）。
   - macOS 侧这两个函数**写好了但在 `src/witchbook/index.js:199-200` 被注释掉**，注释写于 2026-08-02：
     "角色档案数据注入可能破坏场景 (5 个 ArgumentException)"。
   - macOS 目前靠**替代路径**达到相近效果：姓名 = `hookProfileName` 在 `ProfilePage.RefreshPageContent`
     onLeave 覆写 `_authorLabel`（渲染期，不注册数据）；条目 = 页面级注入（`injectPage`，
     **故意不注 `Data._items`** —— 那是缓存的 ScriptableObject，注入会跨会话残留）。
   - **为什么怀疑停用理由已过期**：那条 ArgumentException 属 7.6 的"重复 `Add` / `Contains` 守卫失效"
     一类（`providersMap.ContainsKey` 写成 `ret.toInt32() === 1`），**2026-09-25 已由 `invokeBool` 修掉**；
     而这两个函数自己的守卫是 `listContainsId`（utils.js 的自扫实现，根本不走 invoke 装箱那条路）。
   - **待办（一次实验就能定案）**：取消注释 → 跑一次图鉴 → 看 `CharacterData 注入 N 个角色` 是否出现、
     有没有 ArgumentException、以及档案页的**年龄/身高/体重/名/姓**字段是否比现在更完整。
     若确实已无问题，则应恢复这两次调用（消除与上游的功能差距）；若仍崩，把新证据写回这里替换那句"可能"。

## 已知开放项（非阻断）

- **音频 ogg 支持**（2026-08-12 调研后决策：不做，ogg 用 ffmpeg 转 wav；2026-08-13 起 run_mod.sh 启动前自动检测非标音频，纯 Python 读文件头毫秒级，发现后列出清单询问 y/N、确认才批量转换——转换是改文件操作不擅自执行；检测零依赖，仅转换需 ffmpeg；**检测为可选增强**：normalize_audio.py 不存在时 run_mod.sh 整块跳过，加载器不依赖）：
  - 根因（当时用本地探针 probe_audio.js 的 P1/P2 实测得出; 该探针不随仓库发布）：原装 `WavToAudioClipConverter` ① `<Representations>k__BackingField` 仅含 `(".wav","audio/wav")` → `.ogg` 文件过不了资源定位（LocalResourceLocator 按 Representation.Extension 匹配扩展名）；② 解码仅 `Pcm16ToFloatArray`（PCM16），OggS 数据必然失败。带 ogg 的 mod 实测报 `Failed to load '114514/L01' resource of type 'UnityEngine.AudioClip'`。
  - 调研结论：C# 蓝本 = Harmony patch（ModAudioPatch.cs 注入 Representations + 接管 ConvertBlocking）+ NVorbis 解码；macOS 若要实现需注入 Representations（`A.an` 构造 struct 数组写 backing field，探针已验证可行）+ 接管 ConvertBlocking（UnityPlayer.dylib 导出 `FMOD_ov_*` 可复用，arm64 上 callbacks 结构在 x5 第 6 参）。成本高于收益 → 决策：ffmpeg 转 wav（README 已有此指导）。
  - **wav 同样受限**（不只 ogg）：原装解码器 `Pcm16ToFloatArray` 只做 PCM16（44100Hz 立体声假设），48kHz 等非标采样率/位深/声道的 wav 会播放失败或音高偏移（上游 #5 修的就是这个）。统一转码参数：`ffmpeg -i in.ogg -ar 44100 -ac 2 -sample_fmt s16 out.wav`（ogg 与任意 wav 均适用）。
- **进程生命周期**（2026-08-12 修复，不影响功能）：
  - `ctrl+c` ：杀启动器 + 收掉游戏（SIGTERM → 3s → SIGKILL）+ 清理本次 frida-helper。
  - 游戏存活检测（`os.kill(pid, 0)` 每秒探测）：游戏退出（程序坞/崩溃/kill）→ 脚本自动 detach 收尾，不再残留孤儿 bash（此前 python 死循环不监控游戏，每次运行残留 1 个 bash，实测累计 10 个）。
  - frida-helper 服务进程在游戏/客户端退出后不自动退出（PPID=1 孤儿，每次运行残留 1 个，历史累计 127 个）→ 收尾时按 spawn 前基线 diff 主动 kill 本次新增的 helper。
  - **退出"未响应"已修（2026-10-06，commit 736ba3e）**：根因就是"frida 的 JS 线程 attach 进 IL2CPP 域 → 运行时 shutdown 收不了尾"（当时只能猜"可能与 frida 注入有关"）；现在退出入口只置位、由 JS 线程自己在 50ms 内把自身摘出域，游戏内退出 / 程序坞 / Cmd+Q 三条路径均 1~2 秒干净退出。`os.kill` 检测仍只认进程消亡，但 watchdog 补上了"进程卡着不死"这种情形（`MOD_EXIT_GRACE`，默认 3s，`=0` 关闭）。详见 [PITFALLS.md](PITFALLS.md) 7.15。
  - 退出期崩溃报告（`~/Library/Logs/DiagnosticReports/manosaba-*.ips`）：2026-10-06 前的 `SIGSEGV at __cxa_throw` 现象随上面的修复一起消失；**若再出现，先查是不是 `il2cpp_thread_detach` 被从错误的线程调用** —— 我们踩过：在退出钩子（主线程）里调 `il2cpp_thread_current()` 会摘掉主线程，0.0x 秒后崩在 `Environment::get_CurrentManagedThreadId`（NULL 解引用）。

## 参考

- Windows 参考实现：仓库内 [ManosabaLoader/](../ManosabaLoader/)（BepInEx + Harmony 版源码）
- 游戏原生 mod 文档（剧本语法/样例）：《试试写一个魔女裁判》《开始一个简单的对话》等
