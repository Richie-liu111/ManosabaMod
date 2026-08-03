# ManosabaMod macOS 移植 (Frida)

用 **Frida** 在 macOS (Apple Silicon) 上加载 ManosabaMod,不依赖 BepInEx。
mod 剧本 / 本地化 / voice / audio 已通过 provider 管线加载。

## 结构总览

```
游戏目录 (Steam 安装) — 部署后的工作布局
~/Library/Application Support/Steam/steamapps/common/manosaba_game/
├── manosaba.app/                    ← 游戏本体 (Frida 注入目标)
├── run_mod.sh                       ← 启动脚本 (从仓库部署到这里)
├── dist/manosabamod.js              ← 主 Frida 脚本 (frida-compile 构建产物, 部署到这里)
└── ManosabaMod/                     ← mod 目录 (首次运行 run_mod.sh 自动创建)
    ├── 1919180/                     ← 你的 mod (含 info.json + Scripts/...)
    └── TaffyModLoader/Scripts/      ← 启动时自动生成 (菜单剧本)

仓库 — 脚本源 (clone 到任何位置, 只用于部署/更新脚本)
ManosabaMod/
├── ManosabaLoader/                  ← 原版 Windows 加载器源码 (C#/BepInEx, 仅参考)
└── macos-frida/
    ├── README.md                    ← 使用说明 (本文件)
    ├── ARCHITECTURE.md              ← 架构 / 原理 / 与 Windows 版区别 / mod 兼容性
    ├── GOALS.md                     ← 目标 / Windows vs macOS 差距文档 (活的)
    ├── src/                         ← 源码 (多文件 ES modules, 唯一源码源)
    │   ├── entry.js                 ← 初始化编排 (API 绑定 / hook 挂载)
    │   ├── utils.js / io.js         ← 基础工具 + libc 文件 I/O
    │   ├── menu.js / providers.js / movie.js
    │   └── witchbook/               ← WitchBook (state/data/textures/pages/session/characters/index)
    ├── package.json                 ← npm: frida-compile (devDependency, 仅改源码需要)
    ├── dist/manosabamod.js          ← 打包产物 (单 bundle, 仓库随版本提交, 安装直接用)
    └── run_mod.sh                   ← 启动脚本 (在仓库里运行会自动构建)
```

## 使用方法

### 打包版 vs 源码版

- **打包版（普通安装）**：只需 `run_mod.sh` + `dist/manosabamod.js` 两个文件（仓库直接提供，
  无需 Node.js/npm）。mod 目录放在游戏目录 `ManosabaMod/` 下即可。
- **源码版（开发）**：改 `src/` 后需要 `npm install` + 重新构建（见下文"开发"）。

### 前置条件
- macOS **Apple Silicon** (arm64)
- `python3` + `frida`(`pip install frida-tools`)
- 游戏装在 Steam 默认位置

### 部署 + 启动

```bash
# 1. 克隆仓库 (任何位置)
git clone https://github.com/Richie-liu111/ManosabaMod.git

# 2. 部署到游戏目录 (打包版: run_mod.sh 放游戏根, bundle 放 dist/ 子目录 — run_mod.sh 按此定位)
GAME="$HOME/Library/Application Support/Steam/steamapps/common/manosaba_game"
cp ManosabaMod/macos-frida/run_mod.sh "$GAME/"
mkdir -p "$GAME/dist"
cp ManosabaMod/macos-frida/dist/manosabamod.js "$GAME/dist/"

# 3. 启动
cd "$GAME"
./run_mod.sh
```

`run_mod.sh` 在**游戏目录里**运行时,直接用 `$PWD` 定位游戏(mod 根 = `$PWD/ManosabaMod`)。
即使不部署、直接从仓库跑,它也会自动找到游戏(见"定位顺序")。

`run_mod.sh` 自动完成:
1. 定位游戏目录(见下方顺序)
2. 若在仓库里运行且有 `src/`,先用 frida-compile 构建 `dist/manosabamod.js`(源码版)
3. 扫描 `ManosabaMod/*/info.json` → 生成 mod 选择菜单 (含翻页, 每页 4 个)
4. 启动游戏并注入 `dist/manosabamod.js`

**日志分层**: 机制日志默认关闭 (运行噪音小), `MOD_DEBUG=1 ./run_mod.sh` 开启;
游戏侧 `Unity.LogError` 始终全量输出 (最高优先级排查信号)。

**开发 (源码版)**: 改 `src/` 后不需要手动构建 — `run_mod.sh` 在仓库里运行时自动重新构建。
亦可手动: `cd ManosabaMod/macos-frida && npx frida-compile src/entry.js -o dist/manosabamod.js -S`
(首次需要 `npm install` 安装 frida-compile)。重新构建后记得重新部署到游戏目录。

### 游戏目录定位顺序

1. **已部署**:本脚本在 `manosaba.app` 旁边 → 直接用当前目录
2. Steam 默认位置:`~/Library/Application Support/Steam/steamapps/common/manosaba_game`
3. 仓库在工作区副本 `manosaba_game_mac` 旁(仅本地开发场景)
4. 环境变量 `GAME`(手动指定)

### 其他用法

```bash
./run_mod.sh /path/to/Mods          # 指定 mod 根目录
GAME=/path/to/manosaba ./run_mod.sh # 游戏不在 Steam 默认位置时
```

## 状态

| 功能 | 状态 |
|------|------|
| mod 菜单 (含翻页, 每页 4 个) | ✅ |
| mod 剧本 (.nani) | ✅ |
| 本地化 (.txt) / voice / audio (.wav) | ✅ |
| Movie (.mp4/.webm/.ogv) | ✅ |
| WitchBook 全 4 分类 (线索/人物/规定/记录) + 新角色 | ✅ |
| WitchBook 会话隔离 (整页重建, override 可逆) | ✅ |
| 背景 (@back) / 立绘 (@char) | ✅ |
| 魔女裁判 mod 面板 (@choice handler:"<modId>") | ❌ 未实现 (见 GOALS.md) |

架构、工作原理、与 Windows 版差异、mod 格式兼容性详见 [ARCHITECTURE.md](ARCHITECTURE.md)。
