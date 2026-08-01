#!/usr/bin/env python3
# run_v3test.py — 跑 v3 (注入 modList/MOD_ROOT), 收集 N 秒后杀掉
import frida, time, json, os, sys

GAME = "/Users/richie/manosaba decompile/manosaba_game_mac/manosaba.app/Contents/MacOS/manosaba"
MOD_ROOT = "/Users/richie/manosaba decompile/manosaba_game_mac/ManosabaMod"
seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 45
JS_BASE = open("/Users/richie/manosaba decompile/manosabamod_v3.js", encoding="utf-8").read()

# 扫描 mod (同 run_mod.sh)
mods = []
for d in sorted(os.listdir(MOD_ROOT)):
    ip = os.path.join(MOD_ROOT, d, "info.json")
    if os.path.isfile(ip):
        try:
            info = json.load(open(ip, encoding="utf-8"))
            mods.append({"Name": info["Name"], "key": d, "Enter": info.get("Enter", "")})
        except Exception as e:
            print("跳过:", e)

parts = []
for m in mods:
    name_json = json.dumps(m["Name"], ensure_ascii=False)
    parts.append("{Name:" + name_json + ',key:"' + m["key"] + '",Enter:"' + m["Enter"] + '"}')
mods_str = "[" + ",".join(parts) + "]"
FULL_JS = f"var modList={mods_str};var MOD_ROOT=\"{MOD_ROOT}\";\"use strict\";\n" + JS_BASE
print(f">>> modList={mods_str}")

device = frida.get_local_device()
pid = device.spawn([GAME])
print(f">>> spawned PID={pid} collect={seconds}s", flush=True)
session = device.attach(pid)
script = session.create_script(FULL_JS)

def on_msg(m, d):
    if m.get("type") == "send":
        print(m.get("payload", ""), flush=True)
    elif m.get("type") == "error":
        print("[script-err]", m.get("stack") or m.get("description"), flush=True)

script.on("message", on_msg)
script.load()
device.resume(pid)
time.sleep(seconds)
print(">>> killing", flush=True)
try:
    device.kill(pid)
except Exception as e:
    print("kill err:", e)
print(">>> done")
