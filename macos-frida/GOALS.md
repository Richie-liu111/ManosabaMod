# ManosabaMod macOS 移植 — 目标与差距文档

> 活的文档，随代码演进更新。最后更新：2026-08-03（多文件重构）。

## 目标

在 macOS ARM 原生游戏（魔法少女的魔女审判/manosaba）上，用 **Frida 运行时注入**（IL2CPP C API 动态解析，无静态地址依赖）实现与 Windows 版 ManosabaLoader（BepInEx + Il2CppInterop + Harmony）**功能对齐**的 MOD 加载器：加载 mod 的剧本/本地化/语音/音频/背景/立绘/视频，并注入魔女图鉴（WitchBook 全分类）数据与审判环节自定义面板。实现方式是镜像 Windows 模块的机制，不依赖任何 Windows RVA。

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
   - 场景：mod 剧本用 `@choice handler:"<modId>"` 指定 mod 的克隆面板+立绘。游戏原生样例《试试写一个魔女裁判》只演示了原版审判 `handler:"Trial"`，**mod 自定义 handler 的写法没有现成样例**——这也是无法直接照抄的原因之一。
   - 根因（ARCHIVE_2026-08-03.md 第二节）：① 游戏 `Activator.CreateInstance(type,id,meta)` 在 macOS IL2CPP 匹配不到 2 参构造器；② makeS 字符串与游戏字典 key 哈希不匹配。
   - 蓝本：ARCHIVE 第四节「@choice handler 最小可行方案」（16g actor 构造 + 16h 真实字符串 key；**未验证的最后一环** = 真实字符串 key 让 `ResourceExistsAsync` 命中）。存档分支 `save/16h-choice` 有完整排查代码可提取参考。
   - 头号坑（教训 4）：makeS 字符串只能当函数参数，字典 key 必须用游戏侧真实 string 对象。
2. **CutIn** — ❌ 未实现（2026-08-03 核查源码修正：旧文档曾写"已装未实测"有误，实际无任何 CutIn/objectionCutInSpawnPath hook；唯一 SetSpawnParameters 属于 WitchBook SpawnableClue。参考：Windows 版 objectionCutInSpawnPath 改写 + sprite 替换思路）
3. **ModChapterDisplay（存档章节名）** — ❌ 未实现（镜像参考：Windows ModChapterDisplay.cs，GameStateSlotExtended.SetNonEmptyState）
4. **游戏原生剧本验证** — ⚠️ 开放问题：游戏原生 440 剧本（含原版魔女裁判 `@choice handler:"Trial"`）从未在 macOS+Frida 下测试（历史只测过 mod 流程）。原版审判是否正常未知。
5. **菜单翻页** — ✅ 2026-08-03 已回迁（perPage=4，`ChoiceList_<页>` 方案，镜像 Windows AddModStartMenu）并通过回归验证（TestWitchBook 位于第 3 页，翻页进入正常）。

## 参考

- Windows 参考实现：仓库内 [ManosabaLoader/](../ManosabaLoader/)（BepInEx + Harmony 版源码）
- 游戏原生 mod 文档（剧本语法/样例，随游戏发布、不在本仓库）：《试试写一个魔女裁判》《开始一个简单的对话》等
- 16h @choice 排查现场：git 分支 `save/16h-choice`（2500 行完整排查代码，可提取参考）
