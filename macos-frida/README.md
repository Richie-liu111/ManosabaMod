# ManosabaMod macOS 移植 (Frida)

用 **Frida** 在 macOS (Apple Silicon) 上加载 ManosabaMod,不依赖 BepInEx。
mod 剧本 / 本地化 / voice / audio 已通过 provider 管线加载。

## 结构总览

```
游戏目录 (Steam 安装) — 部署后的工作布局
~/Library/Application Support/Steam/steamapps/common/manosaba_game/
├── manosaba.app/                    ← 游戏本体 (Frida 注入目标)
├── run_mod.sh                       ← 启动脚本 (从仓库部署到这里)
├── manosabamod_v3.js                ← 主 Frida 脚本 (从仓库部署到这里)
└── ManosabaMod/                     ← mod 目录 (首次运行 run_mod.sh 自动创建)
    ├── 1919180/                     ← 你的 mod (含 info.json + Scripts/...)
    └── TaffyModLoader/Scripts/      ← 启动时自动生成 (菜单剧本)

仓库 — 脚本源 (clone 到任何位置, 只用于部署/更新脚本)
ManosabaMod/
├── ManosabaLoader/                  ← 原版 Windows 加载器源码 (C#/BepInEx, 仅参考)
└── macos-frida/
    ├── README.md                    ← 使用说明 (本文件)
    ├── ARCHITECTURE.md              ← 架构 / 原理 / 与 Windows 版区别 / mod 兼容性
    ├── manosabamod_v3.js            ← 主 Frida 脚本
    └── run_mod.sh                   ← 启动脚本
```

## 使用方法

### 前置条件
- macOS **Apple Silicon** (arm64)
- `python3` + `frida`(`pip install frida-tools`)
- 游戏装在 Steam 默认位置

### 部署 + 启动

```bash
# 1. 克隆仓库 (任何位置)
git clone https://github.com/Richie-liu111/ManosabaMod.git

# 2. 部署脚本到游戏目录 
cp ManosabaMod/macos-frida/run_mod.sh \
   ManosabaMod/macos-frida/manosabamod_v3.js \
   "$HOME/Library/Application Support/Steam/steamapps/common/manosaba_game/"

# 3. 启动
cd "$HOME/Library/Application Support/Steam/steamapps/common/manosaba_game"
./run_mod.sh
```

`run_mod.sh` 在**游戏目录里**运行时,直接用 `$PWD` 定位游戏(mod 根 = `$PWD/ManosabaMod`)。
即使不部署、直接从仓库跑,它也会自动找到游戏(见"定位顺序")。

`run_mod.sh` 自动完成:
1. 定位游戏目录(见下方顺序)
2. 扫描 `ManosabaMod/*/info.json` → 生成 mod 选择菜单
3. 启动游戏并注入 `manosabamod_v3.js`

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
| mod 菜单 | ✅ |
| mod 剧本 (.nani) | ✅ |
| 本地化 (.txt) / voice / audio (.wav) | ✅ |
| Movie (.mp4/.webm/.ogv) | ✅ |
| WitchBook 自定义线索 (Clues) | ✅ |
| WitchBook 人物 / 规定 / 记录 | ✅ |
| 背景 / 立绘 | ⏳ |

架构、工作原理、与 Windows 版差异、mod 格式兼容性详见 [ARCHITECTURE.md](ARCHITECTURE.md)。
