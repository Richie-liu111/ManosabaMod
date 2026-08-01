# ManosabaMod macOS 移植 (Frida)

用 **Frida** 在 macOS (Apple Silicon) 上加载 ManosabaMod,不依赖 BepInEx。
mod 剧本 / 本地化 / voice / audio 已通过 provider 管线加载。

## 结构总览

```
游戏 (Steam 标准安装位置)
~/Library/Application Support/Steam/steamapps/common/manosaba_game/
├── manosaba.app/                    ← 游戏本体 (Frida 注入目标)
└── ManosabaMod/                     ← mod 目录 (首次运行 run_mod.sh 自动创建)
    ├── 1919180/                     ← 你的 mod (含 info.json + Scripts/...)
    └── TaffyModLoader/Scripts/      ← 启动时自动生成 (菜单剧本)

仓库 (clone 到任何位置, 脚本会自动找游戏)
ManosabaMod/
├── ManosabaLoader/                  ← 原版 Windows 加载器源码 (C#/BepInEx, 仅参考)
└── macos-frida/
    ├── README.md                    ← 使用说明 (本文件)
    ├── ARCHITECTURE.md              ← 架构 / 原理 / 与 Windows 版区别 / mod 兼容性
    ├── manosabamod_v3.js            ← 主 Frida 脚本 (所有注入逻辑)
    └── run_mod.sh                   ← 启动脚本 (从这里运行)
```

## 使用方法

### 前置条件
- macOS **Apple Silicon** (arm64)
- `python3` + `frida`(`pip install frida-tools`)
- 游戏装在 Steam 默认位置(见结构图),或任意位置(见"其他用法")

### 启动

```bash
# 1. 克隆仓库 (任何位置)
git clone https://github.com/Richie-liu111/ManosabaMod.git
cd ManosabaMod/macos-frida

# 2. 启动 (自动定位 Steam 版游戏)
./run_mod.sh
```

`run_mod.sh` 自动完成:
1. **定位游戏目录**,依次检查:
   ① Steam 默认位置 `~/Library/Application Support/Steam/steamapps/common/manosaba_game`
   ② 若仓库在工作区副本 `manosaba_game_mac` 旁(仅本地开发场景)
   ③ 环境变量 `GAME`(手动指定)
2. 在游戏目录下扫描 `ManosabaMod/*/info.json` → 生成 mod 选择菜单
3. 启动游戏并注入 `manosabamod_v3.js`(Steam 绕过 + 菜单 + provider 管线)

游戏内操作:
1. 标题画面 → 点「开始」
2. 出现 mod 选择菜单(原版剧情 + 每个 mod 一项)
3. 点你的 mod → 剧本播放(voice 正常)

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
| WitchBook 线索 / 背景 / Movie | ⏳ |

架构、工作原理、与 Windows 版差异、mod 格式兼容性详见 [ARCHITECTURE.md](ARCHITECTURE.md)。
