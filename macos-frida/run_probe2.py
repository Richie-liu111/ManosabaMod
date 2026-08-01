#!/usr/bin/env python3
# run_probe2.py <script.js> [seconds] — 注入探针, 收集输出, 杀掉游戏
import frida, time, sys, os

GAME = "/Users/richie/manosaba decompile/manosaba_game_mac/manosaba.app/Contents/MacOS/manosaba"
js_name = sys.argv[1] if len(sys.argv) > 1 else "probe_provider.js"
seconds = int(sys.argv[2]) if len(sys.argv) > 2 else 60
JS = open(os.path.join("/Users/richie/manosaba decompile", js_name), encoding="utf-8").read()

device = frida.get_local_device()
pid = device.spawn([GAME])
print(f">>> spawned PID={pid} script={js_name} collect={seconds}s", flush=True)
session = device.attach(pid)
script = session.create_script(JS)

def on_msg(m, d):
    if m.get("type") == "send":
        print(m.get("payload", ""), flush=True)
    elif m.get("type") == "error":
        print("[script-err]", (m.get("stack") or m.get("description")), flush=True)

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
