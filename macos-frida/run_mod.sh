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
SCRIPT="$PWD/dist/manosabamod.js"
MOD_ROOT="${1:-$GAME_DIR/ManosabaMod}"

# 日志系统: modlog.txt 默认在游戏根 (每运行截断重开), MOD_LOG 可覆盖;
# MOD_NO_COLOR=1 关闭终端颜色 (重定向/全量捕获时用: MOD_NO_COLOR=1 ./run_mod.sh > all.log)
MOD_LOG="${MOD_LOG:-$GAME_DIR/modlog.txt}"
MOD_NO_COLOR="${MOD_NO_COLOR:-0}"
PLAYER_LOG="$HOME/Library/Logs/Re,AER/manosaba/Player.log"

if [ ! -f "$GAME" ]; then echo "错误: 找不到游戏 $GAME"; exit 1; fi

# 构建: src/ 是唯一源码源, frida-compile 打包成 dist/manosabamod.js (多文件 → 单 bundle)
# 日志分层: 机制日志默认关, MOD_DEBUG=1 开启; 游戏侧 Unity.LogError 始终全量
if [ -d "$PWD/src" ]; then
    echo ">>> 构建 dist/manosabamod.js ..."
    if ! (command -v npx >/dev/null && npx --no-install frida-compile src/entry.js -o dist/manosabamod.js -S); then
        if [ -f "$PWD/node_modules/.bin/frida-compile" ]; then
            "$PWD/node_modules/.bin/frida-compile" src/entry.js -o dist/manosabamod.js -S || { echo "错误: frida-compile 构建失败"; exit 1; }
        else
            echo "错误: 找不到 frida-compile (npm install 未执行?)"
            exit 1
        fi
    fi
fi
if [ ! -f "$SCRIPT" ]; then echo "错误: 找不到脚本 $SCRIPT (构建失败?)"; exit 1; fi

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
echo ">>> Mod 日志: $MOD_LOG (MOD_DEBUG=${MOD_DEBUG:-0})"

# 探针: PROBE=<文件路径> ./run_mod.sh — 附加独立探针脚本 (不走 📦 bundle, 与 bundle 并行)
# 用于托管链验证 (probe_choice_real.js) 等诊断; 默认空 = 不附加。
PROBE="${PROBE:-}"

# 导出环境变量给 Python (heredoc 用带引号形式, 避免转义被 shell 处理)
export GAME SCRIPT MOD_ROOT MOD_DEBUG MOD_LOG MOD_NO_COLOR PLAYER_LOG PROBE
$PY << 'ENDPY'
import frida, time, json, os, re, sys

GAME = os.environ['GAME']
SCRIPT = os.environ['SCRIPT']
MOD_ROOT = os.environ['MOD_ROOT']
MOD_DEBUG = os.environ.get('MOD_DEBUG') == '1'
MOD_LOG = os.environ.get('MOD_LOG') or ''
MOD_NO_COLOR = os.environ.get('MOD_NO_COLOR') == '1'
PLAYER_LOG = os.environ.get('PLAYER_LOG') or ''
PROBE = os.environ.get('PROBE') or ''
IS_TTY = sys.stdout.isatty()
# 关键事实 (2026-08-10 实证): 本 setup 中 bundle 的 console.log 不经 frida 消息桥,
# 由 V8 runtime 直接写到游戏进程的 stdout 副本 (spawn 保留的父进程 fd) → 剥色必须在 JS 侧:
# 非 TTY (重定向/管道) 或 MOD_NO_COLOR=1 时注入 MOD_NO_COLOR=true → log.js 输出明文。
JS_NO_COLOR = (not IS_TTY) or MOD_NO_COLOR

JS_BASE = open(SCRIPT, encoding='utf-8').read()

# 本地化对象 → 字符串 (Name/Description/Author 可能是 {zh-Hans:..., ja:...})
def resolve_loc(v):
    if isinstance(v, str):
        return v
    if isinstance(v, dict):
        for k in ('zh-Hans', 'ja', 'zh-Hant', 'ko', 'en-US'):
            if v.get(k):
                return v[k]
        if v:
            return next(iter(v.values()))
    return ''

# 扫描 Mod
mods = []
if os.path.isdir(MOD_ROOT):
    for d in sorted(os.listdir(MOD_ROOT)):
        ip = os.path.join(MOD_ROOT, d, 'info.json')
        if os.path.isfile(ip):
            try:
                info = json.load(open(ip, encoding='utf-8'))
                mods.append({'Name': resolve_loc(info.get('Name')) or d, 'key': d, 'Enter': info.get('Enter', '')})
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
    # 翻页 (镜像 Windows AddModStartMenu): 每页 perPage 条, # ChoiceList_<页> 标签
    # 此文件仅作参考 (菜单实际由 bundle 内 Script.FromText 构造, 与 src/menu.js buildMenuText 保持一致)
    t = "@ProcessInput false\n@trialMode false\n@HideUI AutoToggle,WitchBookButtonUI AllowToggle:false time:0\n" + \
        "@ShowUI ControlPanel time:0\n@back SubId:\"Overlay\" SolidColor tint:\"#000000\" time:0 Lazy:false\n"
    per_page = 4
    page, idx = 0, 0
    t += "# ChoiceList_%d\n" % page

    def add_choice(nm, body):
        return '@choice "%s" Lock:false play:true show:true\n%s    @goto .GoToModScript\n' % (nm, body)

    t += add_choice('原版游戏剧情', setline('nextScenario', 'Act01_Chapter01/Act01_Chapter01_Adv01') + setline('modKey', '__vanilla__'))
    idx += 1
    for i, m in enumerate(mods):
        nm = (m.get('Name') or 'Mod%d' % i).replace('"', '\\"')
        if idx >= per_page:
            if page > 0:
                t += '@choice "上一页" Lock:false play:true show:true\n    @goto .ChoiceList_%d\n' % (page - 1)
            t += '@choice "下一页" Lock:false play:true show:true\n    @goto .ChoiceList_%d\n' % (page + 1)
            t += '@Stop\n'
            page += 1
            t += "# ChoiceList_%d\n" % page
            idx = 0
        t += add_choice(nm, setline('nextScenario', m.get('Enter') or 'Act01_Chapter01/Act01_Chapter01_Adv01') + setline('modKey', m['key']))
        idx += 1
    if page > 0:
        t += '@choice "上一页" Lock:false play:true show:true\n    @goto .ChoiceList_%d\n' % (page - 1)
    t += "@Stop\n\n# GoToModScript\n" + \
         "@ProcessInput true set:Continue.true,Pause.true,Skip.true,ToggleSkip.true,AutoPlay.true,ToggleUI.true,ShowBacklog.true,Rollback.true\n" + \
         "@ClearBacklog\n@goto {nextScenario}\n"
    return t

menu_dir = os.path.join(MOD_ROOT, 'ModLoader', 'Scripts')
os.makedirs(menu_dir, exist_ok=True)
menu_path = os.path.join(menu_dir, 'ModStart.nani')
with open(menu_path, 'w', encoding='utf-8') as f:
    f.write(build_menu_text(mods))
print(f'>>> 已写入菜单文件: {menu_path}')

# 📦 asset bundle 必须以 📦 开头 (frida 走 asset 编译); 变量经 Script.evaluate fragment 注入全局 (frida-tools REPL 同机制)
MOD_DEBUG_JS = 'var MOD_DEBUG=true;' if MOD_DEBUG else ''
NO_UPDATE_JS = 'var NO_UPDATE_HOOK=true;' if os.environ.get('NO_UPDATE_HOOK') == '1' else ''
# MOD_LOG/MOD_NO_COLOR 用 json.dumps (路径含空格/中文安全); 空 MOD_LOG → JS 端走默认兜底路径
inject_code = ('var modList=%s;var MOD_ROOT=%s;var movieMap=%s;var MOD_LOG=%s;var MOD_NO_COLOR=%s;'
               % (mods_str, json.dumps(MOD_ROOT), movie_map_json, json.dumps(MOD_LOG), json.dumps(JS_NO_COLOR))) \
              + MOD_DEBUG_JS + NO_UPDATE_JS
inj = 'Script.evaluate("mod-vars", %s);' % json.dumps(inject_code)
inj_frag = f"{len(inj.encode('utf-8'))} /frida/mod-vars.js\n✄\n{inj}"
bundle_body = JS_BASE[2:] if JS_BASE.startswith("📦\n") else JS_BASE
FULL_JS = "📦\n" + inj_frag + "\n✄\n" + bundle_body
# ===== probe_embed.js 崩溃诊断探针 (已停用, 仅保留说明) =====
# 用途: 2026-08-04 排查"原版审判环节偶发崩溃"(_itemIds=Graphic[] 泛型共享 → Contains 抛 MAE)
# 的临时诊断脚本。独立 frida 脚本附加(不走 📦 包, 与 📦 内 fragment 相互独立), 钩
# GameAssembly+0x3404d4 转储异常对象 + 原生栈, 按异常类型做 5 条/类 廉价过滤。
# 2026-08-11: 诊断已完成 + 探针日志是良性 OperationCanceledException(UniTask 异步取消)噪音,
# 游戏目录探针文件已删除, 此处调用一并停用。
# 以后若再排查崩溃: 把 probe_embed.js 放回 run_mod.sh 同级目录, 再取消下面两段注释即可重新附加。
#_probe_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'probe_embed.js')

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
# runtime="v8": frida-compile 17 的 📦 asset bundle 需要 V8 runtime 编译 (QuickJS 默认不支持)
def on_msg(m, d):
    # 注意: bundle 的 console.log 不经此回调 (见 JS_NO_COLOR 注释); 这里只兜底 frida 错误消息等
    s = m.get('payload', '') or m.get('description', '')
    try:
        print(s, flush=True)
    except Exception:
        print(s.encode('utf-8', 'replace').decode('utf-8', 'replace'), flush=True)
script = session.create_script(FULL_JS, runtime="v8")
script.on('message', on_msg)
script.load()
# PROBE=<文件路径>: 附加独立探针脚本 (不走 📦 包, 与 bundle 并行; 消息经消息桥 send → 此回调 print)
# 例: PROBE="$PWD/probe_choice_real.js" ./run_mod.sh
if PROBE and os.path.isfile(PROBE):
    probe_code = open(PROBE, encoding='utf-8').read()
    pscript = session.create_script(probe_code, runtime="v8")
    pscript.on('message', on_msg)
    pscript.load()
    print('>>> 已附加探针: %s (%d 字节)' % (PROBE, len(probe_code.encode('utf-8'))))
device.resume(pid)
print(f'>>> 游戏已启动 (PID={pid}) | Ctrl+C 停止')
try:
    while True: time.sleep(1)
except KeyboardInterrupt:
    session.detach()
    print('\n>>> 已停止')
    print('>>> Mod 日志: %s (MOD_DEBUG=%s)' % (MOD_LOG or '<游戏根>/modlog.txt', MOD_DEBUG))
    if PLAYER_LOG and os.path.isfile(PLAYER_LOG):
        print('>>> Unity 日志: %s' % PLAYER_LOG)
ENDPY
