#!/usr/bin/env python3
"""退出卡死分层 A/B 实验 (游戏内 GUI 退出 → 黑屏 + 未响应).

背景 (2026-10-06): `sample` 抓到卡死时主线程停在
    PlayerLoop → GameAssembly → dispatch_semaphore_wait (带超时)
而 frida 的 JS 线程 (gum-js-loop) 空闲在 kevent —— 说明**不是**我们的轮询在退出期乱动
(那层已经用退出感知堵上了), 卡点在游戏/运行时的退出流程本身。
问题只剩"是谁把它带进去的", 用下面几档逐一剥离:

  ① vanilla : 从 Steam 直接启动 (完全不经过 frida)     ← 不用本脚本
  ② bare    : 只做 Steam 处理 (env 传 appid + 抑制 Init), 不碰 IL2CPP
  ③ attach  : Steam 处理 + 把 JS 线程 il2cpp_thread_attach 进域  ← 只多这一步
  ④ full    : 完整 bundle (用 ./run_mod.sh, 本脚本不重复)

**为什么 bare/attach 也要处理 Steam**: 2026-10-06 第一次跑 ②③ 时, 游戏刚启动就被 Steam 截胡
重开 (RestartAppIfNecessary), frida spawn 的那个进程当场退出 —— 测试无效。
现在的做法与生产一致: **appid 由 spawn 的 env 传** (SteamAppId/SteamGameId) + 脚本里只把
`SteamInternal_SteamAPI_Init` 抑制成 NoSteamClient (开着 Steam 时不会真初始化 → 云存档不受影响)。
(2026-10-06 起 bundle 也不再替换 `SteamAPI_RestartAppIfNecessary`, 走的是同一个 env 机制。)

用法:
    python3 test-tools/exit_hang_ab.py bare
    python3 test-tools/exit_hang_ab.py attach
    GAME=/path/to/manosaba.app/Contents/MacOS/manosaba python3 test-tools/exit_hang_ab.py bare

每次跑完在游戏里用 GUI 退出, 记录"窗口是否卡在未响应"; 卡住时另开终端抓栈:
    sample $(pgrep -x manosaba | head -1) 3 -file /tmp/hang-<模式>.txt
"""
import os
import subprocess
import sys
import time

GAME_DEFAULT = os.path.expanduser(
    "~/Library/Application Support/Steam/steamapps/common/manosaba_game/manosaba.app/Contents/MacOS/manosaba")

# Steam 处理: appid 由 spawn 的 env 传 (与 run_mod.sh 一致), 这里只抑制 SteamAPI_Init
STEAM_BYPASS_JS = r"""
try {
    var dl = (typeof Module.findGlobalExportByName === "function")
        ? Module.findGlobalExportByName("dlopen") : Module.findExportByName(null, "dlopen");
    if (!dl) { send({ t: "steam-bypass", ok: false, why: "dlopen 未找到" }); }
    else {
        var done = false;
        Interceptor.attach(dl, {
            onEnter: function (a) { this.p = a[0].readCString(); },
            onLeave: function (r) {
                if (done || r.isNull() || !this.p || this.p.indexOf("libsteam_api") === -1) return;
                var i2 = Module.findGlobalExportByName("SteamInternal_SteamAPI_Init");
                if (i2) Interceptor.replace(i2, new NativeCallback(function () { return 2; }, "int", []));
                done = true;
                send({ t: "steam-bypass", ok: true });
            }
        });
    }
} catch (e) { send({ t: "steam-bypass", ok: false, why: String(e) }); }
"""

# 只多这一步: 把 frida 的 JS 线程 attach 进 IL2CPP 域 (entry.js 里 A.ta 那步)。
# 必须重试: spawn 完立刻跑脚本时 GameAssembly.dylib 还没 dlopen (bundle 里 doInit 也是轮询等它)。
ATTACH_JS = r"""
;(function () {
    var n = 0;
    function step() {
        n++;
        // 坑: Module.findGlobalExportByName 查不到 GameAssembly 的导出 (2026-10-06 实测) ——
        // 必须先用 Process.enumerateModules() 拿到模块对象再 findExportByName, 否则永远 attach 不上。
        var ga = null, mods = Process.enumerateModules();
        for (var i = 0; i < mods.length; i++) if (mods[i].name.indexOf("GameAssembly") >= 0) { ga = mods[i]; break; }
        var pAttach = ga ? ga.findExportByName("il2cpp_thread_attach") : null;
        var pDomGet = ga ? ga.findExportByName("il2cpp_domain_get") : null;
        if (!pAttach || !pDomGet) {
            if (n < 150) setTimeout(step, 200);
            else send({ t: "attach", ok: false, why: "30s 内没等到 il2cpp 导出 (GameAssembly 没加载?)" });
            return;
        }
        var dom = new NativeFunction(pDomGet, "pointer", [])();
        if (dom.isNull()) {                       // 域还没建起来
            if (n < 150) setTimeout(step, 200);
            else send({ t: "attach", ok: false, why: "超时: il2cpp_domain_get() 仍为 NULL" });
            return;
        }
        var t = new NativeFunction(pAttach, "pointer", ["pointer"])(dom);
        send({ t: "attach", ok: true, thread: t.toString(), domain: dom.toString(),
               after_ms: n * 200 });
    }
    step();
})();
"""



def spawn_env():
    """与 run_mod.sh 同款: 把 appid 用环境变量交给游戏 (RestartAppIfNecessary 的第一道判定),
    这样脚本不必再替换 SteamAPI_RestartAppIfNecessary。显式传完整环境, 不依赖 frida 对 env
    是"合并"还是"替换"。"""
    e = dict(os.environ)
    e["SteamAppId"] = os.environ.get("STEAM_APP_ID", "3101040")
    e["SteamGameId"] = e["SteamAppId"]
    return e

def helper_pids():
    try:
        out = subprocess.run(["pgrep", "-x", "frida-helper"], capture_output=True, text=True)
        return set(out.stdout.split())
    except Exception:
        return set()


def main():
    mode = (sys.argv[1] if len(sys.argv) > 1 else "").lower()
    if mode not in ("bare", "attach"):
        print(__doc__)
        return 2
    game = os.environ.get("GAME") or GAME_DEFAULT
    if not os.path.isfile(game):
        print("找不到游戏二进制: %s (用 GAME=... 指定)" % game)
        return 2

    import frida  # 延迟导入: 没装时报错更清楚

    base = helper_pids()
    device = frida.get_local_device()
    pid = None
    session = None
    try:
        pid = device.spawn([game], env=spawn_env())
        session = device.attach(pid)
        code = STEAM_BYPASS_JS + (ATTACH_JS if mode == "attach" else "")
        script = session.create_script(code, runtime="v8")
        script.on("message", lambda m, d: print(">>> 脚本:", m.get("payload") or m.get("description")))
        script.load()
        device.resume(pid)
        print(">>> [%s] 游戏已启动 (PID=%d) | 请在游戏内用 GUI 退出, 观察是否卡在未响应" % (mode, pid))
        while True:
            time.sleep(1)
            try:
                os.kill(pid, 0)
            except OSError:
                print(">>> 游戏进程已退出 — 若『黑屏+未响应』没出现, 说明这一档是干净的")
                break
    except KeyboardInterrupt:
        print("\n>>> 已停止 (ctrl+c)")
    finally:
        if pid is not None:
            try:
                os.kill(pid, 15)
                time.sleep(3)
                try:
                    os.kill(pid, 0)
                    os.kill(pid, 9)
                except OSError:
                    pass
            except OSError:
                pass
        try:
            if session is not None:
                session.detach()
        except Exception:
            pass
        try:
            frida.shutdown()  # 顺手清掉本轮 ~/.cache/frida/frida-<hash>/ (46MB)
        except Exception:
            pass
        for p in (helper_pids() - base):
            try:
                os.kill(int(p), 9)
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
