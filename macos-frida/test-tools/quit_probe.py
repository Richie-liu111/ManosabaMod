#!/usr/bin/env python3
"""自动复现"退出 → 黑屏未响应"的探针 (不需要人点任何东西), 用来把诱因一档档剥开.

怎么自动退出:
  QUIT=invoke   (默认) 用 IL2CPP 直接调 `UnityEngine.Application.Quit(0)` —— 游戏内退出按钮那条路
  QUIT=osascript        `osascript -e 'quit app "manosaba"'` —— 走 AppKit 的退出 AppleEvent

2026-10-06 已实测: **不带 bundle、不带 mod**, 只要 frida 在 + JS 线程 attach 进 IL2CPP 域,
再 invoke Application.Quit, 就能复现出与手工完全相同的栈 (逐帧一致):
    __NSFireTimer → UnityPlayer 0x5dca78 → GameAssembly +0x3579b8 → +0x32e420 → +0x12f0
    → _dispatch_semaphore_wait_slow  (主线程卡死, frida 的 JS 线程空闲在 kevent)
所以这个脚本是复现器, 也是 A/B 工具.

用法:
    python3 test-tools/quit_probe.py                 # attach + invoke (已能复现卡死)
    ATTACH=0 python3 test-tools/quit_probe.py        # 不 attach → 看卡死是否消失
    QUIT=osascript python3 test-tools/quit_probe.py  # 换成 AppleEvent 退出
    DELAY=10 WAIT=25 python3 test-tools/quit_probe.py

判读: 卡住时脚本自动 `sample` 抓栈到 /tmp/hang-<attach|noattach>-<quit>.txt, 并对比 Player.log
      尾部有没有走到 Unity 的关闭流程 ([Physics::Module] Cleanup / Input System Shutdown)。
"""
import os
import subprocess
import sys
import time

GAME_DEFAULT = os.path.expanduser(
    "~/Library/Application Support/Steam/steamapps/common/manosaba_game/manosaba.app/Contents/MacOS/manosaba")
PLAYER_LOG = os.path.expanduser("~/Library/Logs/Re,AER/manosaba/Player.log")

STEAM_BYPASS_JS = r"""
try {
    var dl = (typeof Module.findGlobalExportByName === "function")
        ? Module.findGlobalExportByName("dlopen") : Module.findExportByName(null, "dlopen");
    if (dl) {
        var done = false;
        Interceptor.attach(dl, {
            onEnter: function (a) { this.p = a[0].readCString(); },
            onLeave: function (r) {
                if (done || r.isNull() || !this.p || this.p.indexOf("libsteam_api") === -1) return;
                var i2 = Module.findGlobalExportByName("SteamInternal_SteamAPI_Init");
                if (i2) Interceptor.replace(i2, new NativeCallback(function () { return 2; }, "int", []));
                done = true;
            }
        });
    }
} catch (e) { send({ t: "probe", ok: false, why: "steam bypass: " + e }); }
"""

PROBE_JS = r"""
;(function () {
    // 坑: Module.findGlobalExportByName 查不到 GameAssembly 的导出 → 必须用模块对象
    function gaModule() {
        var mods = Process.enumerateModules();
        for (var i = 0; i < mods.length; i++) if (mods[i].name.indexOf("GameAssembly") >= 0) return mods[i];
        return null;
    }
    var WANT = ["il2cpp_domain_get", "il2cpp_thread_attach", "il2cpp_thread_current", "il2cpp_thread_detach",
                "il2cpp_domain_get_assemblies", "il2cpp_assembly_get_image", "il2cpp_image_get_name",
                "il2cpp_class_from_name", "il2cpp_class_get_method_from_name", "il2cpp_runtime_invoke"];
    var n = 0, dom = null, ex = null, wantAttach = null, attached = false, threadObj = null;
    var detachMode = "", quitFlag = false;

    // jstimer 模式: 退出钩子只置位, 由 **JS 线程自己** 在 100ms 内把它自己摘出去 ——
    // 因为 il2cpp_thread_detach 清的其实是"调用者"的线程注册 (GC 侧 thread-local),
    // 从主线程的钩子里调到不了目的, 反而把主线程摘了 → 0.2s 后主线程空指针崩。
    setInterval(function () {
        if (!quitFlag) return;
        quitFlag = false;
        detachNow(true);
    }, 100);

    // 退出入口钩子: 在这里 detach —— 实测一旦 shutdown 卡住, JS 线程就再也跑不动 JS 了
    // (排队 2 分钟才轮到), 所以"事后救援"没用, 只能在入口这一下动手。
    function installQuitHooks() {
        try {
            var cfn = new NativeFunction(ex["il2cpp_class_from_name"], "pointer", ["pointer", "pointer", "pointer"]);
            var cgm = new NativeFunction(ex["il2cpp_class_get_method_from_name"], "pointer", ["pointer", "pointer", "int"]);
            var dga = new NativeFunction(ex["il2cpp_domain_get_assemblies"], "pointer", ["pointer", "pointer"]);
            var agi = new NativeFunction(ex["il2cpp_assembly_get_image"], "pointer", ["pointer"]);
            var ign = new NativeFunction(ex["il2cpp_image_get_name"], "pointer", ["pointer"]);
            var cnt = Memory.alloc(8), asms = dga(dom, cnt), nAsm = cnt.readPointer().toInt32();
            // 注意: il2cpp_image_get_name 给的是 "UnityEngine.CoreModule.dll" 这种带后缀的名字 → 用子串匹配
            var u3d = null, nvImg = null;
            for (var i = 0; i < nAsm; i++) {
                var img = agi(asms.add(i * 8).readPointer());
                if (img.isNull()) continue;
                var inm = ign(img).readCString() || "";
                if (inm.indexOf("UnityEngine.CoreModule") >= 0) u3d = img;
                else if (inm.indexOf("Naninovel.Runtime") >= 0) nvImg = img;
            }
            function hookIt(cls, name, argc, tag) {
                if (!cls || cls.isNull()) return;
                var mi = cgm(cls, Memory.allocUtf8String(name), argc);
                if (!mi || mi.isNull()) return;
                Interceptor.attach(mi.readPointer(), {
                    onEnter: function () {
                        send({ t: "probe", stage: "quit-hook", hook: tag, why: "hook fired" });
                        if (detachMode === "jstimer") { quitFlag = true; return; }   // 交给 JS 线程的定时器
                        detachNow(detachMode === "hook-js");
                    }
                });
                send({ t: "probe", stage: "quit-hook-installed", hook: tag });
            }
            if (u3d) {
                var appCls = cfn(u3d, Memory.allocUtf8String("UnityEngine"), Memory.allocUtf8String("Application"));
                hookIt(appCls, "Quit", 1, "Application.Quit(int)");
                hookIt(appCls, "Internal_ApplicationWantsToQuit", 0, "Application.Internal_ApplicationWantsToQuit");
            }
            else send({ t: "probe", ok: false, why: "installQuitHooks: 找不到 UnityEngine.CoreModule" });
            if (nvImg) hookIt(cfn(nvImg, Memory.allocUtf8String("Naninovel"), Memory.allocUtf8String("Engine")), "OnApplicationQuit", 0, "Naninovel.Engine.OnApplicationQuit");
            else send({ t: "probe", ok: false, why: "installQuitHooks: 找不到 Naninovel.Runtime" });
        } catch (e) { send({ t: "probe", ok: false, why: "installQuitHooks: " + e }); }
    }

    function attachNow() {
        if (attached || !ex) return;
        attached = true;
        threadObj = new NativeFunction(ex["il2cpp_thread_attach"], "pointer", ["pointer"])(dom);
        send({ t: "probe", stage: "attached", thread: threadObj.toString() });
    }
    // detach 之后 JS 线程就不再属于 IL2CPP 域了 —— 只能当"要退出了"的最后一步, 之后别再调 IL2CPP
    // useStored=true: 用 attach 时记下的 **JS 线程**对象 (从别的线程调用时唯一正确的选择);
    // false: 用 il2cpp_thread_current() —— 它返回**调用线程自己**, 在主线程的钩子里调用就会
    //        把主线程摘掉 → 1ms 后主线程跑托管代码空指针崩 (2026-10-06 踩过)
    function detachNow(useStored) {
        if (!attached || !ex) return;
        var t = null;
        if (!useStored) t = new NativeFunction(ex["il2cpp_thread_current"], "pointer", [])();
        if (!t || t.isNull()) t = threadObj;
        attached = false;
        new NativeFunction(ex["il2cpp_thread_detach"], "void", ["pointer"])(t);
        send({ t: "probe", stage: "detached", thread: t.toString(), via: useStored ? "stored(JS线程)" : "thread_current(调用者)" });
    }
    function maybeAttach() {
        if (wantAttach === null || !dom) return;
        if (wantAttach) attachNow();
        else send({ t: "probe", stage: "attach-skipped" });
    }

    function step() {
        n++;
        var stage = "gaModule";
        try {
            var ga = gaModule();
            ex = {};
            stage = "findExports";
            if (ga) for (var i = 0; i < WANT.length; i++) { var p = ga.findExportByName(WANT[i]); if (p) ex[WANT[i]] = p; }
            var missing = WANT.filter(function (k) { return !ex[k]; });
            if (missing.length) {
                if (n % 20 === 0) send({ t: "probe", stage: "waiting", tries: n, missing: missing });
                if (n < 200) { setTimeout(step, 200); return; }
                send({ t: "probe", ok: false, why: "超时: 缺导出 " + missing.join(",") });
                return;
            }
            stage = "domainGet";
            dom = new NativeFunction(ex["il2cpp_domain_get"], "pointer", [])();
            if (dom.isNull()) {
                if (n < 200) { setTimeout(step, 200); return; }
                send({ t: "probe", ok: false, why: "il2cpp_domain_get() 一直 NULL" });
                return;
            }
            send({ t: "probe", stage: "domain-ready", tries: n });
            maybeAttach();
            if (detachMode !== "") installQuitHooks();
        } catch (e) {
            // GameAssembly 刚出现在模块列表里时还不能调 (实测 il2cpp_domain_get 会
            // "access violation accessing 0x135") —— 当成"还没好", 继续重试
            if (n < 200) {
                if (n % 5 === 1) send({ t: "probe", stage: "retry-after-error", at: stage, err: String(e), tries: n });
                setTimeout(step, 300);
                return;
            }
            send({ t: "probe", ok: false, why: "step@" + stage + ": " + e });
        }
    }

    recv("cfg", function (m) {
        wantAttach = !!m.attach;
        detachMode = m.detach || "";
        send({ t: "probe", stage: "cfg", attach: wantAttach, detach: detachMode });
        maybeAttach();
    });

    recv("detach", function (m) { detachNow(!!(m && m.stored)); });

    recv("quit", function () {
        try {
            attachNow();                                   // invoke 需要先 attach (ATTACH=0 时这一步可能失败)
            var cnt = Memory.alloc(8);
            var dga = new NativeFunction(ex["il2cpp_domain_get_assemblies"], "pointer", ["pointer", "pointer"]);
            var agi = new NativeFunction(ex["il2cpp_assembly_get_image"], "pointer", ["pointer"]);
            var ign = new NativeFunction(ex["il2cpp_image_get_name"], "pointer", ["pointer"]);
            var asms = dga(dom, cnt), nAsm = cnt.readPointer().toInt32();
            var core = null;
            for (var i = 0; i < nAsm; i++) {
                var img = agi(asms.add(i * 8).readPointer());
                if (img.isNull()) continue;
                var nm = ign(img).readCString() || "";
                if (nm.indexOf("UnityEngine.CoreModule") >= 0) { core = img; break; }
            }
            if (!core) { send({ t: "probe", ok: false, why: "找不到 UnityEngine.CoreModule image" }); return; }
            var cfn = new NativeFunction(ex["il2cpp_class_from_name"], "pointer", ["pointer", "pointer", "pointer"]);
            var appCls = cfn(core, Memory.allocUtf8String("UnityEngine"), Memory.allocUtf8String("Application"));
            if (appCls.isNull()) { send({ t: "probe", ok: false, why: "UnityEngine.Application 类未找到" }); return; }
            var cgm = new NativeFunction(ex["il2cpp_class_get_method_from_name"], "pointer", ["pointer", "pointer", "int"]);
            var mi = cgm(appCls, Memory.allocUtf8String("Quit"), 1);
            if (!mi || mi.isNull()) { send({ t: "probe", ok: false, why: "Application.Quit(int) 未找到" }); return; }
            var arg = Memory.alloc(8); arg.writeS32(0);
            var args = Memory.alloc(8); args.writePointer(arg);
            var exc = Memory.alloc(8); exc.writePointer(ptr(0));
            new NativeFunction(ex["il2cpp_runtime_invoke"], "pointer",
                               ["pointer", "pointer", "pointer", "pointer"])(mi, ptr(0), args, exc);
            var e = exc.readPointer();
            send({ t: "probe", stage: "quit-invoked", exc: e.isNull() ? "none" : e.toString() });
        } catch (err) { send({ t: "probe", ok: false, why: "invoke 异常: " + err }); }
    });

    // 等到游戏基本起来再碰 il2cpp: GameAssembly 刚出现在模块列表里时调 il2cpp_domain_get
    // 会间歇性 "access violation accessing 0x135" (实测, 会把这个进程带坏) —— 6s 足够到标题
    setTimeout(step, 6000);
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


def player_log_tail(n=4):
    try:
        with open(PLAYER_LOG, encoding="utf-8", errors="replace") as f:
            return [ln.strip() for ln in f.read().splitlines() if ln.strip()][-n:]
    except Exception as e:
        return ["<读不到 Player.log: %s>" % e]


def main():
    game = os.environ.get("GAME") or GAME_DEFAULT
    attach = (os.environ.get("ATTACH", "1") != "0")
    quit_mode = (os.environ.get("QUIT") or "invoke").lower()
    detach = (os.environ.get("DETACH") or "").lower()          # "" | before | after | hook
    detach_after = float(os.environ.get("DETACH_AFTER") or 3)
    delay = float(os.environ.get("DELAY") or 10)
    wait = float(os.environ.get("WAIT") or 25)
    if quit_mode not in ("invoke", "osascript"):
        print("QUIT 只能是 invoke | osascript")
        return 2
    if not os.path.isfile(game):
        print("找不到游戏二进制: %s" % game)
        return 2

    import frida

    base = helper_pids()
    device = frida.get_local_device()
    pid = None
    session = None
    ready = [False]
    t0 = time.time()

    def on_msg(m, d):
        payload = m.get("payload")
        if isinstance(payload, dict) and payload.get("t") == "probe":
            if payload.get("stage") == "domain-ready":
                ready[0] = True
            print(">>> [%.1fs] %s" % (time.time() - t0, payload))
        else:
            print(">>> 脚本:", payload or m.get("description"))

    try:
        pid = device.spawn([game], env=spawn_env())
        session = device.attach(pid)
        script = session.create_script(STEAM_BYPASS_JS + PROBE_JS, runtime="v8")
        script.on("message", on_msg)
        script.load()
        script.post({"type": "cfg", "attach": attach, "detach": detach})
        device.resume(pid)
        print(">>> attach=%s quit=%s | 已启动 (PID=%d), 等域就绪 ..." % (attach, quit_mode, pid))
        deadline = time.time() + 60
        while not ready[0] and time.time() < deadline:
            time.sleep(0.5)
        if not ready[0]:
            print(">>> 域没就绪, 放弃")
            return 1
        print(">>> 等 %.0fs 让游戏稳定在标题 ..." % delay)
        time.sleep(delay)
        print(">>> 退出前 Player.log 尾部: %s" % player_log_tail(2))
        if detach == "before":
            print(">>> detach (退出前)")
            script.post({"type": "detach"})
            time.sleep(1.0)
        if quit_mode == "invoke":
            script.post({"type": "quit"})
        else:
            r = subprocess.run(["osascript", "-e", 'quit app "manosaba"'], capture_output=True, text=True)
            print(">>> osascript 退出: rc=%d %s" % (r.returncode, (r.stdout + r.stderr).strip()[:160]))
        if detach == "after":
            print(">>> detach (退出后 %.0fs, 救援测试)" % detach_after)
            time.sleep(detach_after)
            script.post({"type": "detach"})
        time.sleep(1.5)
        gone_at = None
        limit = time.time() + wait
        while time.time() < limit:
            try:
                os.kill(pid, 0)
            except OSError:
                gone_at = time.time()
                break
            time.sleep(0.5)
        tag = ("attach" if attach else "noattach") + "-" + quit_mode
        if gone_at:
            print(">>> ✅ 干净退出 (退出动作后 %.1fs 进程消失)" % (gone_at - t0 - delay))
        else:
            print(">>> ❌ 卡死: 退出动作后 %.0fs 进程仍在" % wait)
            out = "/tmp/hang-%s.txt" % tag
            r = subprocess.run(["sample", str(pid), "3", "-file", out], capture_output=True, text=True)
            print(">>> sample → %s" % out)
        print(">>> 退出后 Player.log 尾部: %s" % player_log_tail(4))
    except KeyboardInterrupt:
        print("\n>>> 已停止 (ctrl+c)")
    finally:
        if pid is not None:
            try:
                os.kill(pid, 15)
                time.sleep(2)
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
            frida.shutdown()
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
