# ManosabaMod macOS 移植 (Frida)

用 **Frida** 在 macOS (Apple Silicon) 上加载 ManosabaMod,不依赖 BepInEx。
mod 剧本 / 本地化 / voice / audio / movie / 背景 / 立绘 已通过 provider 管线加载。

## 结构总览

```
游戏目录 (Steam 安装) — 部署后的工作布局
~/Library/Application Support/Steam/steamapps/common/manosaba_game/
├── manosaba.app/                    ← 游戏本体 (Frida 注入目标)
├── run_mod.sh                       ← 启动脚本 (从仓库部署到这里)
├── dist/manosabamod.js              ← 主 Frida 脚本 (frida-compile 构建产物, 部署到这里)
├── normalize_audio.py               ← 可选: 音频标准化 (不部署则跳过该功能, 见"音频标准化"节)
└── ManosabaMod/                     ← mod 目录 (首次运行 run_mod.sh 自动创建)
    ├── 1919180/                     ← 你的 mod (含 info.json + Scripts/...)
    └── ModLoader/Scripts/           ← 启动时自动生成 (菜单剧本)

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
    │   ├── menu.js / providers.js / movie.js / chapterdisplay.js
    │   └── witchbook/               ← WitchBook (state/data/textures/pages/session/characters/index)
    ├── package.json                 ← npm: frida-compile (devDependency, 仅改源码需要)
    ├── dist/manosabamod.js          ← 打包产物 (单 bundle, 仓库随版本提交, 安装直接用)
    ├── run_mod.sh                   ← 启动脚本 (在仓库里运行会自动构建)
    └── normalize_audio.py           ← 可选: 非标音频检测/转换 (run_mod.sh 启动前调用)
```

## 使用方法

### 打包版 vs 源码版

- **打包版（普通安装）**：必选 `run_mod.sh` + `dist/manosabamod.js` 两个文件（仓库直接提供，
  无需 Node.js/npm）；`normalize_audio.py` 是**可选增强**（音频标准化,见"音频标准化"节,不部署则跳过）。
  mod 目录放在游戏目录 `ManosabaMod/` 下即可。
- **源码版（开发）**：改 `src/` 后需要 `npm install` + 重新构建（见下文"开发"）。

### 前置条件
- macOS **Apple Silicon** (arm64)
- `python3` + `frida`(`pip install frida-tools`)
- 游戏装在 Steam 默认位置
- `ffmpeg`(仅音频转换步骤需要;检测是纯 Python 零依赖,没有 ffmpeg 时转换步骤警告并跳过,非标音频播放受限)

### 部署 + 启动

```bash
# 1. 克隆仓库 (任何位置)
git clone https://github.com/Richie-liu111/ManosabaMod.git

# 2. 部署到游戏目录 (必选: run_mod.sh + dist/manosabamod.js 两个文件即可运行)
GAME="$HOME/Library/Application Support/Steam/steamapps/common/manosaba_game"
cp ManosabaMod/macos-frida/run_mod.sh "$GAME/"
cp ManosabaMod/macos-frida/normalize_audio.py "$GAME/"   # 可选: 音频标准化 (不复制则跳过, 见下方"音频标准化"节)
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
4. **音频规范化检测**(可选增强, 仅当同目录存在 `normalize_audio.py`, 2026-08-13 起): 调用
   `normalize_audio.py --check`,纯 Python 读文件头扫描全部 mod 音频,判断是否
   PCM16/44100Hz/立体声。发现非标音频 (ogg/48kHz/32kHz/单声道 等)
   → 终端列出清单 + 删除警告 + 询问是否批量转成标准 wav (y/N,回车默认不转换,照常启动,非标音频可能无声/音高偏移);确认后才执行转换 (`--apply`)。`NORMALIZE_AUDIO=0`
   关闭检测,`force` 不询问直接转;非 TTY(重定向/脚本)下只报告不询问。也可手动执行
   `python3 normalize_audio.py --apply`。仅转换需要 `ffmpeg`(缺少时该步警告,不阻断游戏启动)。
5. 启动游戏并注入 `dist/manosabamod.js`

### 音频标准化(可选增强,非必装)

`normalize_audio.py` 解决的是:游戏原装转换器只支持 PCM16/44100Hz/立体声 wav,非标音频
(ogg/48kHz/32kHz/单声道 等)会无声或音高偏移。装了它,run_mod.sh 启动前检测到非标音频时
会列出清单并询问是否批量转换。**它是"改文件"操作**:

- 转换会覆盖同名 .wav、**删除 ogg 源文件**,建议先备份
- 发现非标准音频时终端先列出清单并给出删除警告,再询问 y/N —— 回车默认不转换,照常启动
  (只是音频无声/音高偏移,ogg 剧本加载时会报错)
- 不部署该文件,run_mod.sh 自动跳过检测与转换,加载器本体完全不受影响

**日志分层**: 机制日志默认关闭 (运行噪音小), `MOD_DEBUG=1 ./run_mod.sh` 开启;
游戏侧 `Unity.LogError` 始终全量输出 (最高优先级排查信号)。

**开发 (源码版)**: 改 `src/` 后不需要手动构建 — `run_mod.sh` 在仓库里运行时自动重新构建。
亦可手动: `cd ManosabaMod/macos-frida && npx frida-compile src/entry.js -o dist/manosabamod.js -S`
(首次需要 `npm install` 安装 frida-compile)。重新构建后记得重新部署到游戏目录。

### 游戏目录定位顺序

1. **已部署**:本脚本在 `manosaba.app` 旁边 → 直接用当前目录
2. Steam 默认位置:`~/Library/Application Support/Steam/steamapps/common/manosaba_game`
3. 环境变量 `GAME`(手动指定)

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
| 本地化 (.txt) / voice | ✅ |
| 音频 (.wav, 限 PCM16/44100Hz/立体声) | ✅ |
| 音频 (.ogg) | ❌ 不支持, 用 ffmpeg 转 wav (`ffmpeg -i in.ogg -ar 44100 -ac 2 -sample_fmt s16 out.wav`; 原因见 GOALS.md) |
| Movie (.mp4/.webm/.ogv) | ✅ |
| 背景 (@back) / 立绘 (@char) | ✅ |
| 角色名富文本 (姓/名分级字号+颜色) | ✅ |
| WitchBook 全 4 分类 (线索/人物/规定/记录) + 新角色 | ✅ |
| WitchBook 会话隔离 (整页重建, override 可逆) | ✅ |
| 审判自定义面板 (@choice handler:"<Id>") | ✅ |
| 自定义论破动画 (@gosubCutIn) | ✅ |
| 存档章节名 (info.json ChapterNames) | ✅ |
| 调试工具 | ❌ 未实现 (用 probe_*.js 探针替代) |

## 已知问题 (2026-08-18)

- **已知残留（2026-08-18）**：切语言瞬间有肉眼可见卡顿 —— 每个 loader 实例各触发一次
  全量重注入（实测一次切换 ~200 次，间隔 ~20ms≈每帧），主线程被同步 IL2CPP 调用占用数秒。
  优化方向（verify-before-repair / 按 loader 定向重注入）见 GOALS.md「差距」5。
- 修复细节见 [GOALS.md](GOALS.md)「差距」5 / [ARCHITECTURE.md](ARCHITECTURE.md) 7.5。

架构、工作原理、与 Windows 版差异、mod 格式兼容性详见 [ARCHITECTURE.md](ARCHITECTURE.md)。
