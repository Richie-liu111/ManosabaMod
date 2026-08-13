# ManosabaMod macOS 移植 — 目标与差距文档

> 随代码演进更新。最后更新：2026-08-12（ChoiceHandler + CutIn 闭环）。

> **蓝本勘定（2026-08-11/12）**：Windows 对照的蓝本是 **ManosabaMod1 群文件版 ManosabaLoader.dll**（254KB，md5 ea00a666，ilspycmd 反编译 `/tmp/manosaba1_decomp.cs`，10232 行）——唯一包含 `ModChoiceHandlerLoader` + `ModObjectionCutInLoader` 的版本。GitHub 源码仓库 `ManosabaMod-2.0.0`（csproj v1.0.0）**没有**这两个类；GitHub release 的 ManosabaMod2 DLL（221KB）与 `ManosabaMod`（221KB，md5 86d623ab）同源，也都没有。C# 侧参考路径：`DoomsGuardians/Project-Cannon-and-Candle`（Packages/com.elringus.naninovel/，与 dump.cs 签名完全匹配）。
>
> **上游脉络（2026-08-12 GitHub 核实）**：IrisuM/ManosabaMod 的 PR 贡献——v2.0.0（2026-03-21）= #4（zyf722：图鉴自定义/视频/schema 迁移）+ #5（Asa-Chiri：OGG/任意 WAV 音频）+ #6（Asa-Chiri：语言切换资源修复）；master 2026-04-27 合入 #7–#10（均 Asa-Chiri，提交署名 Weicheng Zhao，Co-Authored-By Claude Opus：DisplayName 统一+颜色恢复、多语言本地化、菜单 UI 本地化、@choice handler + @gosubCutIn），未发 release。群文件 DLL（254KB）即此状态构建；GitHub release（221KB，md5 86d623ab）= v2.0.0。macOS 蓝本源码（`ManosabaLoader/`）与其逐文件对齐。

## 目标

在 macOS ARM 原生游戏（魔法少女的魔女审判/manosaba）上，用 **Frida 运行时注入**（IL2CPP C API 动态解析，无静态地址依赖）实现与 Windows 版 ManosabaLoader（BepInEx + Il2CppInterop + Harmony）**功能对齐**的 MOD 加载器：加载 mod 的剧本/本地化/语音/音频/背景/立绘/视频，并注入魔女图鉴（WitchBook 全分类）数据与审判环节自定义。实现方式是镜像 Windows 模块的机制，不依赖任何 Windows RVA。

架构现状：`src/` 多文件 ES modules 工程，`frida-compile` 打包单 bundle 注入（`dist/manosabamod.js`）。日志分层（2026-08-10 起）：终端彩色（ERROR 红/WARN 黄/INFO 青/DEBUG 灰）+ 游戏根 `modlog.txt` 文件 + 崩溃前 flush（详见 ARCHITECTURE.md 八节）；机制日志走 `MOD_DEBUG` 开关（默认关），游戏侧 `Unity.LogError` 全量抓取为最高优先级信号（ARCHIVE 教训 2/3）。

## Windows vs macOS 功能对照

| Windows 模块 (ManosabaLoader/, 仓库内) | 功能 | macOS 状态 |
|------|------|------|
| ModResourceLoader（含 AddModStartMenu） | mod 资源管线注册（ProvisionSources 注入）+ 菜单（含翻页） | ✅ 已实现（菜单翻页 2026-08-03 从 16h 回迁） |
| ModClueLoader + ModWitchBookPatch | WitchBook 线索注入 + 修复 | ✅ 已实现（含会话隔离/override/默认面板恢复） |
| ModProfileLoader | WitchBook 档案注入 | ✅ 已实现 |
| ModRuleNoteLoader | WitchBook 规则/笔记注入 | ✅ 已实现 |
| ModMovieLoader | 视频 URL 流式播放 | ✅ 已实现 |
| Utils/ModTextureHelper | PNG → Texture2D → Addressables 注册 | ✅ 已实现 |
| Utils/AuthorTaggedTextGenerator | 角色名富文本（姓/名分级字号+颜色） | ✅ 已实现（buildAuthorTemplate） |
| ModAudioPatch | WavToAudioClipConverter 补丁 | ⚠️ 部分（注册等价；原装转换器仅 **PCM16/44100Hz/立体声** wav，非标 wav 音高偏移、ogg 未支持 — 2026-08-12 决策 ffmpeg 转码，见已知开放项） |
| ModMetadataGenerator | 角色/背景/剧本元数据默认类型 | ⚠️ 部分（macOS 手写 CharacterMetadata 字段，无独立模块） |
| ModChapterDisplay | 存档画面自定义章节名 | ✅ 已实现 |
| ModUiStrings（#9） | mod 菜单 UI 文案本地化 | ⚠️ 边缘（macOS 菜单文案硬编码中文，不随语言切换；中文环境无感） |
| ModDebugTools | 调试工具（RenderTexture 截图等） | ❌ 未实现（macOS 用 probe_*.js 探针替代） |
| ScriptWorkingManager / ModManager | 工作区/配置管理 | ⚠️ 由 run_mod.sh 命令行约定替代 |

## 差距 / 未闭环清单

1. **mod 自定义 ChoiceHandler（魔女审判环节）** — ✅ 2026-08-11/12 已闭环
   - 镜像 C# 蓝本 `ModChoiceHandlerLoader` 四步：真 VirtualResourceProvider + `AddResource<GameObject>`（真 Resource，path 含 `ModChoiceHandlers/{Id}` prefix）+ ChoiceHandlerMetadata（Implementation 从原版 Trial meta 逐字节复制）+ `providersMap.Add("ModChoiceHandlers", vrp)`。actor 由游戏自己构造（克隆 BasePanel 原版面板 + mod 立绘替换）。
   - **两个最终根因**：① 往 Resource 塞组件而非 GameObject（ResourceExistsBlocking<T> 双条件，必须精确匹配）→ Instantiate 后 `get_gameObject`；② Resource.path 必须含 prefix（LoadedResource.ctor 的 BuildLocalPath 校验）。
2. **CutIn** — ✅ 2026-08-12 已闭环
   - 机制：SetVariableValue postfix 把 objectionCutInSpawnPath 改写为 Hiro（insideRewrite 守卫）+ pendingEntry；SetSpawnParameters postfix → BuildInstanceCache（GetComponentsInChildren<Image/SpriteRenderer>(true)，23 渲染器）→ SwapSpritesFromCache（按 sprite 名匹配 6 key）→ 动画不覆盖替换（1s 后 re-dump 验证）。
   - **最终根因（替换成功但不可见）**：`invoke()` 经 `il2cpp_runtime_invoke` 读 ≤8B 值类型返回（float/bool）读到垃圾——`get_pixelsPerUnit` 读回 1.77e-18（真值 37.8）→ `Sprite.Create` 以近零 ppu 创建 → sprite 无限放大不可见。修复：`directCall()`（utils.js）直读 MethodInfo 首字段 methodPointer，按正确返回类型（'float'）读 s0；Vector2/Rect 是 HFA（s0-s3）仍走缓冲 + 归一化守卫（[0,1] 回落 0.5）。详见 ARCHITECTURE.md 的 directCall 节。
   - 验证：6 sprite 全部显示（ppu=37.82/75.76/65.91/72.96 原版真实值），shader 分布与原版一致，动画不覆盖。
3. **ModChapterDisplay（存档章节名）** — ✅ 2026-08-12 已闭环
   - hook `WitchTrialsGameStateSlot.SetNonEmptyState`（实际实例类；C# 蓝本 patch 基类 GameStateSlotExtended，macOS 双 hook 都覆盖）onEnter 预覆写 + onLeave 兜底覆写 `_subTitleLabel`。
   - 数据：run_mod.sh 扫描 info.json 的 `ChapterNames`（值支持本地化 dict）注入全局 chapterNames（脚本路径 → 章节名）。
   - 布局：`GameStateMap.playbackSpot` offset 运行时读；`PlaybackSpot.scriptPath` 固定 @0x0（按名查找与字段类型反查在 macOS 上都返回 scriptPath@0x10 的错类，被实例内存实证推翻）；`_subTitleLabel` offset 运行时读。
   - **踩坑**：`set_richText`/`set_text` 经 `il2cpp_runtime_invoke` 调用 access violation at 0x1 → 改用 `directCall()` 直调 methodPointer（invoke 不可靠的又一样本）。空槽 `_subTitleLabel` 可能是非 null 垃圾指针，`A.ogc` 前必须做小地址守卫。
4. **菜单翻页** — ✅ 2026-08-03 已回迁（perPage=4，`ChoiceList_<页>` 方案，镜像 Windows AddModStartMenu）并通过回归验证（TestWitchBook 位于第 3 页，翻页进入正常）。

## 已知开放项（非阻断）

- **音频 ogg 支持**（2026-08-12 调研后决策：不做，ogg 用 ffmpeg 转 wav；2026-08-13 起 run_mod.sh 启动前自动检测非标音频，纯 Python 读文件头毫秒级，发现后列出清单询问 y/N、确认才批量转换——转换是改文件操作不擅自执行；检测零依赖，仅转换需 ffmpeg；**检测为可选增强**：normalize_audio.py 不存在时 run_mod.sh 整块跳过，加载器不依赖）：
  - 根因（probe_audio.js P1/P2 实证）：原装 `WavToAudioClipConverter` ① `<Representations>k__BackingField` 仅含 `(".wav","audio/wav")` → `.ogg` 文件过不了资源定位（LocalResourceLocator 按 Representation.Extension 匹配扩展名）；② 解码仅 `Pcm16ToFloatArray`（PCM16），OggS 数据必然失败。带 ogg 的 mod 实测报 `Failed to load '114514/L01' resource of type 'UnityEngine.AudioClip'`。
  - 调研结论：C# 蓝本 = Harmony patch（ModAudioPatch.cs 注入 Representations + 接管 ConvertBlocking）+ NVorbis 解码；macOS 若要实现需注入 Representations（`A.an` 构造 struct 数组写 backing field，探针已验证可行）+ 接管 ConvertBlocking（UnityPlayer.dylib 导出 `FMOD_ov_*` 可复用，arm64 上 callbacks 结构在 x5 第 6 参）。成本高于收益 → 决策：ffmpeg 转 wav（README 已有此指导）。
  - **wav 同样受限**（不只 ogg）：原装解码器 `Pcm16ToFloatArray` 只做 PCM16（44100Hz 立体声假设），48kHz 等非标采样率/位深/声道的 wav 会播放失败或音高偏移（上游 #5 修的就是这个）。统一转码参数：`ffmpeg -i in.ogg -ar 44100 -ac 2 -sample_fmt s16 out.wav`（ogg 与任意 wav 均适用）。
- **进程生命周期**（2026-08-12 修复，不影响功能）：
  - `ctrl+c` ：杀启动器 + 收掉游戏（SIGTERM → 3s → SIGKILL）+ 清理本次 frida-helper。
  - 游戏存活检测（`os.kill(pid, 0)` 每秒探测）：游戏退出（程序坞/崩溃/kill）→ 脚本自动 detach 收尾，不再残留孤儿 bash（此前 python 死循环不监控游戏，每次运行残留 1 个 bash，实测累计 10 个）。
  - frida-helper 服务进程在游戏/客户端退出后不自动退出（PPID=1 孤儿，每次运行残留 1 个，历史累计 127 个）→ 收尾时按 spawn 前基线 diff 主动 kill 本次新增的 helper。
  - 注意：程序坞退出时游戏，或者游戏内退出表现为: "未响应"不退出（退出流程卡住，可能与 frida 注入有关），需强制退出或 ctrl+c；os.kill 检测只认进程消亡，不认未响应状态。
  - 手动退出游戏时生成 `~/Library/Logs/DiagnosticReports/manosaba-*.ips`：SIGSEGV at `__cxa_throw`（IL2CPP 退出期 C++ 异常路径），属 frida 注入进程退出的已知摩擦，与 mod 运行期功能无关。

## 参考

- Windows 参考实现：仓库内 [ManosabaLoader/](../ManosabaLoader/)（BepInEx + Harmony 版源码）
- 游戏原生 mod 文档（剧本语法/样例）：《试试写一个魔女裁判》《开始一个简单的对话》等
