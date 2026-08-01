# ManosabaMod macOS 移植 (Frida)

用 **Frida** 在 macOS (Apple Silicon) 上加载 ManosabaMod,不依赖 BepInEx。
mod 剧本 / 本地化 / voice / audio 已通过 provider 管线加载。

## 仓库结构

```
ManosabaMod-macOS/                    ← 本仓库 (IrisuM/ManosabaMod 的 fork)
├── ManosabaLoader/                   ← 原版 Windows 加载器源码 (C#/BepInEx, 仅参考)
├── README.md                         ← 仓库总览 (含本目录入口)
└── macos-frida/                      ← macOS 移植 (本目录)
    ├── README.md                     ← 使用说明 (本文件)
    ├── ARCHITECTURE.md               ← 架构 / 原理 / 与 Windows 版区别 / mod 兼容性
    ├── manosabamod_v3.js             ← 主 Frida 脚本 (所有注入逻辑都在这里)
    └── run_mod.sh                    ← 启动脚本 (自动找游戏 + 注入)
```

## 使用方法

### 前置条件
- macOS **Apple Silicon** (arm64)
- `python3` + `frida`(`pip install frida-tools`)
- 游戏放在工作区:`<工作区>/manosaba_game_mac/manosaba.app`
- mod 放在:`<工作区>/manosaba_game_mac/ManosabaMod/<ModName>/`(含 `info.json`)

### 以本机为例

假设游戏在 `/Users/richie/manosaba decompile/manosaba_game_mac/`,
你的 mod(如 Gapless quantum spin liquid)在
`/Users/richie/manosaba decompile/manosaba_game_mac/ManosabaMod/1919180/`:

```bash
cd /Users/richie/manosaba decompile/ManosabaMod-macOS/macos-frida
./run_mod.sh
```

`run_mod.sh` 自动完成:
1. 从 `macos-frida/` **向上查找**包含 `manosaba_game_mac` 的目录 → 定位工作区
   (所以仓库放哪都行,不必和游戏同目录)
2. 扫描 `ManosabaMod/*/info.json` → 生成 mod 选择菜单
3. 启动游戏并注入 `manosabamod_v3.js`(Steam 绕过 + 菜单 + provider 管线)

游戏内操作:
1. 标题画面 → 点「开始」
2. 出现 mod 选择菜单(原版剧情 + 每个 mod 一项)
3. 点你的 mod → 剧本播放(voice 正常)

### 其他用法
```bash
./run_mod.sh /path/to/Mods          # 指定 mod 根目录
GAME=/path/to/manosaba ./run_mod.sh # 找不到游戏时手动指定二进制
```

## 状态

| 功能 | 状态 |
|------|------|
| mod 菜单 | ✅ |
| mod 剧本 (.nani) | ✅ |
| 本地化 (.txt) / voice / audio (.wav) | ✅ |
| WitchBook 线索 / 背景 / Movie | ⏳ |

架构、工作原理、与 Windows 版差异、mod 格式兼容性详见 [ARCHITECTURE.md](ARCHITECTURE.md)。
