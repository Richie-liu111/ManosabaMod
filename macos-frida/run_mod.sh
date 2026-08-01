#!/bin/bash
# ManosabaMod macOS Frida 启动脚本 (macOS 移植)
# 用法: ./run_mod.sh [mod根目录]
# 游戏路径: 自动查找 (工作区副本 manosaba_game_mac → Steam 默认位置), 也可用环境变量 GAME=... 覆盖
cd "$(dirname "$0")"

# 定位游戏目录:
#   ① 部署在游戏目录 (本脚本在 manosaba.app 旁) — 推荐用法
#   ② Steam 默认位置
#   ③ 向上找 manosaba_game_mac (工作区副本)
#   ④ GAME 环境变量
GAME_DIR=""
if [ -d "$PWD/manosaba.app" ]; then
    GAME_DIR="$PWD"
fi
if [ -z "$GAME_DIR" ] && [ -d "$HOME/Library/Application Support/Steam/steamapps/common/manosaba_game/manosaba.app" ]; then
    GAME_DIR="$HOME/Library/Application Support/Steam/steamapps/common/manosaba_game"
fi
D="$PWD"
while [ "$D" != "/" ]; do
    if [ -d "$D/manosaba_game_mac/manosaba.app" ]; then GAME_DIR="$D/manosaba_game_mac"; break; fi
    D="$(dirname "$D")"
done
# GAME 环境变量显式指定时, 从二进制路径推导游戏目录 (供 mod 根定位)
if [ -z "$GAME_DIR" ] && [ -n "$GAME" ]; then
    GAME_DIR="$(dirname "$(dirname "$(dirname "$(dirname "$GAME")")")")"
fi
if [ -z "$GAME" ] && [ -z "$GAME_DIR" ]; then
    echo "错误: 找不到游戏目录 (manosaba.app), 请用 GAME=... 指定游戏二进制"
    exit 1
fi

GAME="${GAME:-$GAME_DIR/manosaba.app/Contents/MacOS/manosaba}"
SCRIPT="$PWD/manosabamod_v3.js"
MOD_ROOT="${1:-$GAME_DIR/ManosabaMod}"

if [ ! -f "$GAME" ]; then echo "错误: 找不到游戏 $GAME"; exit 1; fi
if [ ! -f "$SCRIPT" ]; then echo "错误: 找不到脚本 $SCRIPT"; exit 1; fi

PY=/opt/anaconda3/bin/python3
if ! $PY -c "import frida" 2>/dev/null; then
    PY=python3
    if ! $PY -c "import frida" 2>/dev/null; then
        echo "错误: 找不到 frida，请安装: pip install frida-tools"
        exit 1
    fi
fi

echo ">>> 游戏: $GAME"
echo ">>> 脚本: $SCRIPT"

# 导出环境变量给 Python (heredoc 用带引号形式, 避免转义被 shell 处理)
export GAME SCRIPT MOD_ROOT
$PY << 'ENDPY'
import frida, time, json, os

GAME = os.environ['GAME']
SCRIPT = os.environ['SCRIPT']
MOD_ROOT = os.environ['MOD_ROOT']

JS_BASE = open(SCRIPT, encoding='utf-8').read()

# 扫描 Mod
mods = []
if os.path.isdir(MOD_ROOT):
    for d in sorted(os.listdir(MOD_ROOT)):
        ip = os.path.join(MOD_ROOT, d, 'info.json')
        if os.path.isfile(ip):
            try:
                info = json.load(open(ip, encoding='utf-8'))
                mods.append({'Name': info['Name'], 'key': d, 'Enter': info.get('Enter', '')})
            except Exception as e:
                print(f'  跳过 {ip}: {e}')

# 扫描 Movie 目录: <MOD_ROOT>/<modKey>/Movie/*.mp4|webm|ogv → {视频名: 绝对路径}
movie_map = {}
if os.path.isdir(MOD_ROOT):
    for d in sorted(os.listdir(MOD_ROOT)):
        mvdir = os.path.join(MOD_ROOT, d, 'Movie')
        if os.path.isdir(mvdir):
            for fn in sorted(os.listdir(mvdir)):
                ext = os.path.splitext(fn)[1].lower()
                if ext in ('.mp4', '.webm', '.ogv'):
                    name = os.path.splitext(fn)[0]
                    full = os.path.join(mvdir, fn)
                    if name in movie_map:
                        print(f'  警告: 重复视频名 {name} ({movie_map[name]} vs {full})')
                    else:
                        movie_map[name] = full

# 构建 JS modList 变量
parts = []
for m in mods:
    name_json = json.dumps(m['Name'], ensure_ascii=False)
    parts.append('{Name:' + name_json + ',key:"' + m['key'] + '",Enter:"' + m['Enter'] + '"}')
mods_str = '[' + ','.join(parts) + ']'
movie_map_json = json.dumps(movie_map, ensure_ascii=False)

# 生成并写入菜单剧本文件 (菜单实际由 v3.js 的 Script.FromText 构造, 此文件仅作参考)
def setline(var, val):
    return '    @set "%s=\\"%s\\""\n' % (var, val)

def build_menu_text(mods):
    t = "@ProcessInput false\n@trialMode false\n@HideUI AutoToggle,WitchBookButtonUI AllowToggle:false time:0\n" + \
        "@ShowUI ControlPanel time:0\n@back SubId:\"Overlay\" SolidColor tint:\"#000000\" time:0 Lazy:false\n"
    t += "@choice \"原版游戏剧情\" Lock:false play:true show:true\n"
    t += setline('nextScenario', 'Act01_Chapter01/Act01_Chapter01_Adv01')
    t += setline('modKey', '__vanilla__')
    t += "    @goto .GoToModScript\n"
    for i, m in enumerate(mods):
        nm = (m.get('Name') or 'Mod%d' % i).replace('"', '\\"')
        t += '@choice "%s" Lock:false play:true show:true\n' % nm
        t += setline('nextScenario', m.get('Enter') or 'Act01_Chapter01/Act01_Chapter01_Adv01')
        t += setline('modKey', m['key'])
        t += "    @goto .GoToModScript\n"
    t += "@Stop\n\n# GoToModScript\n" + \
         "@ProcessInput true set:Continue.true,Pause.true,Skip.true,ToggleSkip.true,AutoPlay.true,ToggleUI.true,ShowBacklog.true,Rollback.true\n" + \
         "@ClearBacklog\n@goto {nextScenario}\n"
    return t

menu_dir = os.path.join(MOD_ROOT, 'TaffyModLoader', 'Scripts')
os.makedirs(menu_dir, exist_ok=True)
menu_path = os.path.join(menu_dir, 'TaffyStart.nani')
with open(menu_path, 'w', encoding='utf-8') as f:
    f.write(build_menu_text(mods))
print(f'>>> 已写入菜单文件: {menu_path}')

FULL_JS = f'var modList={mods_str};var MOD_ROOT="{MOD_ROOT}";var movieMap={movie_map_json};"use strict";\n' + JS_BASE

print(f'>>> 发现 {len(mods)} 个 Mod')
for m in mods:
    print(f'    {m["key"]}: {m["Name"][:50]} -> {m["Enter"]}')
if movie_map:
    print(f'>>> 发现 {len(movie_map)} 个 mod 视频')
    for k, v in movie_map.items():
        print(f'    {k}: {v}')
else:
    print('>>> 无 mod 视频')

# 启动
device = frida.get_local_device()
pid = device.spawn([GAME])
session = device.attach(pid)
script = session.create_script(FULL_JS)
script.on('message', lambda m, d: print(m.get('payload', '') or m.get('description', '')))
script.load()
device.resume(pid)
print(f'>>> 游戏已启动 (PID={pid}) | Ctrl+C 停止')
try:
    while True: time.sleep(1)
except KeyboardInterrupt:
    session.detach()
    print('\n>>> 已停止')
ENDPY
