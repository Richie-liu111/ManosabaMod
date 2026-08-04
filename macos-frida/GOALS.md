# ManosabaMod macOS 移植 — 目标与差距文档

> 活的文档，随代码演进更新。最后更新：2026-08-03（多文件重构）。

## 目标

在 macOS ARM 原生游戏（魔法少女的魔女审判/manosaba）上，用 **Frida 运行时注入**（IL2CPP C API 动态解析，无静态地址依赖）实现与 Windows 版 ManosabaLoader（BepInEx + Il2CppInterop + Harmony）**功能对齐**的 MOD 加载器：加载 mod 的剧本/本地化/语音/音频/背景/立绘/视频，并注入魔女图鉴（WitchBook 全分类）数据与审判环节自定义。实现方式是镜像 Windows 模块的机制，不依赖任何 Windows RVA。

架构现状：`src/` 多文件 ES modules 工程，`frida-compile` 打包单 bundle 注入（`dist/manosabamod.js`）。机制日志走 `MOD_DEBUG` 开关（默认关），游戏侧 `Unity.LogError` 全量抓取为最高优先级信号（ARCHIVE 教训 2/3）。

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
| ModAudioPatch | WavToAudioClipConverter 补丁 | ✅ 等价（populateConvertersDict 直填 converters） |
| ModMetadataGenerator | 角色/背景/剧本元数据默认类型 | ⚠️ 部分（macOS 手写 CharacterMetadata 字段，无独立模块） |
| ModChapterDisplay | 存档画面自定义章节名 | ❌ 未实现 |
| ModDebugTools | 调试工具（RenderTexture 截图等） | ❌ 未实现（macOS 用 probe_*.js 探针替代） |
| ScriptWorkingManager / ModManager | 工作区/配置管理 | ⚠️ 由 run_mod.sh 命令行约定替代 |

## 差距 / 未闭环清单

1. **mod 自定义 ChoiceHandler（魔女裁判环节的 mod 面板）** — ❌ 未闭环
   - 场景：mod 剧本用 `@choice handler:"<modId>"` 指定 mod 的立绘。
2. **CutIn** — ❌ 未实现（参考：Windows 版 objectionCutInSpawnPath 改写 + sprite 替换思路）
3. **ModChapterDisplay（存档章节名）** — ❌ 未实现（镜像参考：Windows ModChapterDisplay.cs，GameStateSlotExtended.SetNonEmptyState）
4. **菜单翻页** — ✅ 2026-08-03 已回迁（perPage=4，`ChoiceList_<页>` 方案，镜像 Windows AddModStartMenu）并通过回归验证（TestWitchBook 位于第 3 页，翻页进入正常）。

## 参考

- Windows 参考实现：仓库内 [ManosabaLoader/](../ManosabaLoader/)（BepInEx + Harmony 版源码）
- 游戏原生 mod 文档（剧本语法/样例，随游戏发布、不在本仓库）：《试试写一个魔女裁判》《开始一个简单的对话》等
