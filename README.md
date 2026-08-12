# ManosabaMod

《魔法少女的魔女审判》(manosaba) 的 MOD 加载器:在游戏基础上加载自制剧本、本地化、语音、音频、视频、背景、立绘,注入魔女图鉴数据,并在审判环节支持自定义面板与论破动画。

提供两个版本:

- **Windows (BepInEx)** — [ManosabaLoader/](ManosabaLoader/),原版 C# 加载器
- **macOS (Frida)** — [macos-frida/](macos-frida/),用 Frida 注入 IL2CPP 的 Apple Silicon 移植,不依赖 BepInEx

## 目录

- [功能特性](#功能特性)
- [项目结构](#项目结构)
- [快速开始 — macOS](#快速开始--macos)
- [如何编写自己的 mod](#如何编写自己的-mod)
- [已知限制](#已知限制)
- [文档](#文档)
- [致谢](#致谢)
- [许可证](#许可证)

## 功能特性

| 功能 | 状态 |
|------|------|
| mod 选择菜单(含翻页,每页 4 个) | ✅ |
| mod 剧本 (.nani) | ✅ |
| 本地化 (.txt) / 语音 / 音频 (.wav) | ✅ |
| 视频 (.mp4/.webm/.ogv,URL 流式播放) | ✅ |
| 背景 (`@back`) / 立绘 (`@char`) | ✅ |
| 魔女图鉴 (WitchBook 全 4 分类:线索/人物/规定/记录 + 新角色) | ✅ |
| 魔女图鉴会话隔离(整页重建,override 可逆) | ✅ |
| 审判自定义面板 (`@choice handler:"<modId>"`) | ✅ |
| 自定义论破动画 (`@gosubCutIn`) | ✅ |
| 存档章节名 (info.json `ChapterNames`) | ✅ |

Windows 版与 macOS 版的功能差距(调试工具等)见 [GOALS.md](macos-frida/GOALS.md)。

## 项目结构

```
ManosabaMod/
├── ManosabaLoader/            # Windows 版加载器源码 (C# / BepInEx)
└── macos-frida/               # macOS 版 (Frida)
    ├── src/                   # 源码 (多文件 ES modules)
    │   ├── entry.js           # 初始化编排:API 绑定 / hook 挂载
    │   ├── utils.js           # IL2CPP 调用工具 (invoke / directCall)
    │   ├── io.js              # libc 文件 I/O (Frida 无 File API)
    │   ├── providers.js       # mod 资源管线 (剧本/本地化/语音/背景/立绘)
    │   ├── menu.js            # mod 选择菜单 (翻页)
    │   ├── movie.js           # 视频 URL 流式播放
    │   ├── choice.js          # 审判 @choice handler
    │   ├── cutin.js           # 论破动画 @gosubCutIn
    │   ├── chapterdisplay.js  # 存档章节名 (ChapterNames)
    │   ├── log.js             # 分级彩色日志 + modlog.txt
    │   └── witchbook/         # 魔女图鉴 (state/data/textures/pages/session/characters/index)
    ├── dist/manosabamod.js    # 打包产物 (frida-compile 构建, 随版本提交)
    ├── run_mod.sh             # 启动脚本 (自动构建 + 启动游戏 + 注入)
    ├── ARCHITECTURE.md        # 架构 / 原理 / 与 Windows 版差异
    ├── GOALS.md               # Windows vs macOS 功能对照与差距 (活的)
    └── README.md              # macOS 版使用说明
└── README.md                  # 本文件
```

### 游戏目录部署布局 (macOS)

```
~/Library/Application Support/Steam/steamapps/common/manosaba_game/
├── manosaba.app/              # 游戏本体
├── run_mod.sh                 # 启动脚本 (从仓库部署)
├── dist/manosabamod.js        # Frida bundle (从仓库部署)
└── ManosabaMod/               # mod 目录 (首次运行 run_mod.sh 自动创建)
    ├── <ModId>/               # 你的 mod (info.json + Scripts/...)
    └── ModLoader/Scripts/     # 启动时自动生成 (菜单剧本)
```

## 快速开始 — macOS

**前置条件**:Apple Silicon (arm64);`python3` + `frida`(`pip install frida-tools`);游戏装在 Steam 默认位置。

```bash
# 1. 克隆仓库 (任何位置)
git clone https://github.com/Richie-liu111/ManosabaMod.git

# 2. 部署到游戏目录 (打包版: 只需 run_mod.sh + dist/manosabamod.js 两个文件)
GAME="$HOME/Library/Application Support/Steam/steamapps/common/manosaba_game"
cp ManosabaMod/macos-frida/run_mod.sh "$GAME/"
mkdir -p "$GAME/dist"
cp ManosabaMod/macos-frida/dist/manosabamod.js "$GAME/dist/"

# 3. 启动
cd "$GAME"
./run_mod.sh
```

`run_mod.sh` 自动完成:

1. 定位游戏目录(已部署时直接用当前目录;否则依次检查 Steam 默认位置、工作区副本、`GAME` 环境变量)
2. 若在仓库里运行且有 `src/`,先用 frida-compile 自动重新构建 bundle(源码版开发)
3. 扫描 `ManosabaMod/*/info.json` → 生成 mod 选择菜单(每页 4 个,可翻页)
4. 启动游戏并注入 `dist/manosabamod.js`

**日志**:机制日志默认关闭(运行噪音小),`MOD_DEBUG=1 ./run_mod.sh` 开启;游戏侧 `Unity.LogError` 始终全量输出。日志同时写入游戏目录 `modlog.txt`。更多用法(指定 mod 根目录、非默认游戏位置)见 [macos-frida/README.md](macos-frida/README.md)。

**开发 (源码版)**:改 `src/` 后在仓库里直接运行 `./run_mod.sh` 即自动重新构建;或手动 `cd macos-frida && npx frida-compile src/entry.js -o dist/manosabamod.js`(首次需 `npm install`)。

## 快速开始 — Windows

原版 BepInEx 加载器,源码在 [ManosabaLoader/](ManosabaLoader/)(C# + Harmony)。该目录作为 macOS 移植的参考蓝本,也保留了 Windows 侧的原始实现。

## 如何编写自己的 mod

**macOS**:在游戏目录 `ManosabaMod/<ModId>/` 下创建 mod,启动后菜单自动识别:

```
ManosabaMod/
└── <ModId>/
    ├── info.json          # mod 信息 (名称/描述, 菜单显示用)
    └── Scripts/           # 剧本文件 (.nani)
        └── 任意名字.nani
```

**剧本语法**:使用游戏原生的 Naninovel 语法(`@char`、`@back`、对话、分支……),具体可以参照原作者雪莉苹果汁的教程网站（https://manosabamoddoc.fuyumi.xyz/docs/）。

macOS 版的剧本结构与 Windows 版类似。
理论上能在 Windows 版 ManosabaMod 中的运行的剧本,无需更改就能在 macOS 版中工作。

## 已知限制

- **macOS 进程行为**:`ctrl+c` 只终止启动脚本,游戏本体是独立进程需手动关闭;手动退出游戏时 macOS 可能弹出崩溃报告 (SIGSEGV at `__cxa_throw`,IL2CPP 退出期异常路径),与 mod 运行期功能无关
- **音频解析** 目前只测试了wav, ogg目前还未支持，其他格式未测试。如果voice有ogg格式的音频，建议先用ffmpeg转成wav格式。
- @char SubId:"Middle" + 自定义角色 可能会导致角色立绘在退出剧本时不被清除，建议不要加SubId:"Middle"参数。

## 文档

| 文档 | 内容 |
|------|------|
| [macos-frida/README.md](macos-frida/README.md) | macOS 版完整使用说明(部署/开发/游戏目录定位) |
| [macos-frida/ARCHITECTURE.md](macos-frida/ARCHITECTURE.md) | 架构、原理、与 Windows 版的差异、mod 兼容性 |
| [macos-frida/GOALS.md](macos-frida/GOALS.md) | Windows vs macOS 功能对照与差距清单 |

## 致谢

- [BepInEx](https://github.com/BepInEx/BepInEx) — Windows 版加载器运行框架
- [frida](https://frida.re/) — macOS 版注入框架
- 雪莉苹果汁的 mod 文档与样例  https://manosabamoddoc.fuyumi.xyz/docs/

## 许可证

[GNU LGPL 2.1](LICENSE)