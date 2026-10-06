#!/usr/bin/env python3
"""运行时导出 il2cpp 方法表 (指针 → 命名空间.类::方法), 用来把 `sample` 里的裸地址翻译成人话.

用途: 卡死时 `sample` 给出的栈长这样 ——
    GameAssembly.dylib  load address 0x1335f0000 + 0x3579b8
只有偏移、没有名字。本工具跑一次游戏 (不需要交互), 把所有 MethodInfo 的方法指针连同名字
导成一张表, 之后 `偏移 = 指针 - GameAssembly 基址` 一查就知道是哪个方法。

为什么不用 Il2CppDumper (2026-10-06 试过): 它不认这个 fat Mach-O, 抽出 arm64 切片后仍然卡在
"Select Platform" 交互提示上, 无 tty 时直接抛异常。运行时反查没有这些麻烦, 而且用的就是
游戏自己的 metadata。

用法:
    python3 test-tools/dump_methods.py                 # 默认导到 /tmp/il2cpp_methods.tsv
    OUT=/path/to/out.tsv python3 test-tools/dump_methods.py
    KEEP=1 ...                                          # 导完不杀游戏 (自己看窗口)

输出格式 (TSV, 三列): <偏移hex>  <ptr|vptr|invoker>  <名字>
  同一个方法可能有三行 (methodPointer / virtualMethodPointer / invoker_method),
  因为不同调用路径压栈的指针不同; 查偏移时按第一列匹配即可。
"""
import os
import subprocess
import sys
import time

GAME_DEFAULT = os.path.expanduser(
    "~/Library/Application Support/Steam/steamapps/common/manosaba_game/manosaba.app/Contents/MacOS/manosaba")
OUT_DEFAULT = "/tmp/il2cpp_methods.tsv"

# Steam 处理: appid 由 spawn 的 env 传 (与 run_mod.sh 一致), 这里只抑制 SteamAPI_Init
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
} catch (e) { send({ t: "dump", ok: false, why: "steam bypass: " + e }); }
"""

DUMP_JS = r"""
;(function () {
    // 坑 (2026-10-06 实测): Module.findGlobalExportByName 在本环境下**查不到 GameAssembly 的导出**
    // (libSystem 的 dlopen 能查到, 所以很容易以为是好的) → 必须拿到模块对象再 module.findExportByName。
    // 这也正是 exit_hang_ab.py 的 attach 档一开始"没 attach 成功"的原因。
    function gaModule() {
        var mods = Process.enumerateModules();
        for (var i = 0; i < mods.length; i++) if (mods[i].name.indexOf("GameAssembly") >= 0) return mods[i];
        return null;
    }

    var WANT = ["il2cpp_thread_attach", "il2cpp_domain_get", "il2cpp_domain_get_assemblies",
                "il2cpp_assembly_get_image", "il2cpp_image_get_class_count", "il2cpp_image_get_class",
                "il2cpp_class_get_methods", "il2cpp_method_get_name", "il2cpp_class_get_name",
                "il2cpp_class_get_namespace"];
    var n = 0;
    function step() {
        n++;
        var ga = gaModule();
        var ex = {};
        if (ga) for (var i = 0; i < WANT.length; i++) { var p = ga.findExportByName(WANT[i]); if (p) ex[WANT[i]] = p; }
        var have = Object.keys(ex).length;
        if (have < WANT.length) {
            if (n % 10 === 1) send({ t: "dump", stage: "waiting", have: have, total: WANT.length,
                                     gaLoaded: !!ga, tries: n });
            if (n < 200) { setTimeout(step, 200); return; }
            send({ t: "dump", ok: false, why: "超时: 40s 内只拿到 " + have + "/" + WANT.length
                   + " 个导出 (" + Object.keys(ex).join(",") + "); GameAssembly 已加载=" + !!ga });
            return;
        }
        try { run(ex); } catch (e) { send({ t: "dump", ok: false, why: "枚举异常: " + e }); }
    }

    function run(ex) {
        var dom = new NativeFunction(ex["il2cpp_domain_get"], "pointer", [])();
        if (dom.isNull()) { if (n < 200) { setTimeout(step, 200); return; }
                            send({ t: "dump", ok: false, why: "il2cpp_domain_get() 一直是 NULL" }); return; }
        new NativeFunction(ex["il2cpp_thread_attach"], "pointer", ["pointer"])(dom);

        var mod = null;
        var mods = Process.enumerateModules();
        for (var m = 0; m < mods.length; m++) if (mods[m].name.indexOf("GameAssembly") >= 0) { mod = mods[m]; break; }
        if (!mod) { send({ t: "dump", ok: false, why: "找不到 GameAssembly 模块" }); return; }

        var dga = new NativeFunction(ex["il2cpp_domain_get_assemblies"], "pointer", ["pointer", "pointer"]);
        var agi = new NativeFunction(ex["il2cpp_assembly_get_image"], "pointer", ["pointer"]);
        var igc = new NativeFunction(ex["il2cpp_image_get_class_count"], "int", ["pointer"]);
        var ig = new NativeFunction(ex["il2cpp_image_get_class"], "pointer", ["pointer", "int"]);
        var cgm = new NativeFunction(ex["il2cpp_class_get_methods"], "pointer", ["pointer", "pointer"]);
        var mgn = new NativeFunction(ex["il2cpp_method_get_name"], "pointer", ["pointer"]);
        var cgn = new NativeFunction(ex["il2cpp_class_get_name"], "pointer", ["pointer"]);
        var cgns = new NativeFunction(ex["il2cpp_class_get_namespace"], "pointer", ["pointer"]);

        var cnt = Memory.alloc(8);
        var asms = dga(dom, cnt);
        var nAsm = cnt.readPointer().toInt32();
        send({ t: "dump", stage: "start", base: mod.base.toString(), asms: nAsm });

        var lines = [], nMethods = 0;
        for (var a = 0; a < nAsm; a++) {
            var img = agi(asms.add(a * 8).readPointer());
            if (img.isNull()) continue;
            var cc = igc(img);
            for (var c = 0; c < cc; c++) {
                var k = ig(img, c);
                if (k.isNull()) continue;
                var cn = cgn(k).readCString() || "?";
                var ns = cgns(k).readCString() || "";
                var full = (ns ? ns + "." : "") + cn;
                var it = Memory.alloc(8); it.writePointer(ptr(0));
                for (;;) {
                    var mi = cgm(k, it);
                    if (!mi || mi.isNull()) break;
                    var nm = mgn(mi).readCString() || "?";
                    var mp = mi.readPointer();                     // MethodInfo.methodPointer (偏移 0, 各版本稳定)
                    if (!mp.isNull()) { lines.push(mp.sub(mod.base).toString(16) + "\tptr\t" + full + "::" + nm); nMethods++; }
                    var vp = mi.add(8).readPointer();               // virtualMethodPointer (较新版本才有)
                    if (!vp.isNull()) lines.push(vp.sub(mod.base).toString(16) + "\tvptr\t" + full + "::" + nm);
                    var iv = mi.add(16).readPointer();              // invoker_method
                    if (!iv.isNull()) lines.push(iv.sub(mod.base).toString(16) + "\tinvoker\t" + full + "::" + nm);
                    if (lines.length >= 4000) { send({ t: "methods", chunk: lines }); lines = []; }
                }
            }
        }
        if (lines.length) send({ t: "methods", chunk: lines });
        send({ t: "dump", ok: true, methods: nMethods, base: mod.base.toString() });
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
    game = os.environ.get("GAME") or GAME_DEFAULT
    out_path = os.environ.get("OUT") or OUT_DEFAULT
    keep = os.environ.get("KEEP") == "1"
    if not os.path.isfile(game):
        print("找不到游戏二进制: %s (用 GAME=... 指定)" % game)
        return 2

    import frida

    base = helper_pids()
    device = frida.get_local_device()
    pid = None
    session = None
    rows = []
    done = [False]
    t0 = time.time()

    def on_msg(m, d):
        payload = m.get("payload")
        if not isinstance(payload, dict):
            print(">>> 脚本:", payload or m.get("description"))
            return
        t = payload.get("t")
        if t == "methods":
            rows.extend(payload["chunk"])
        elif t == "dump":
            if payload.get("stage"):
                print(">>> [%.1fs] %s %s" % (time.time() - t0, payload.pop("t"), payload))
            elif payload.get("ok"):
                print(">>> 枚举完成: %d 个方法, GameAssembly 基址 %s" % (payload["methods"], payload.get("base")))
                done[0] = True
            else:
                print(">>> 失败:", payload.get("why"))
                done[0] = True

    try:
        pid = device.spawn([game], env=spawn_env())
        session = device.attach(pid)
        script = session.create_script(STEAM_BYPASS_JS + DUMP_JS, runtime="v8")
        script.on("message", on_msg)
        script.load()
        device.resume(pid)
        print(">>> 游戏已启动 (PID=%d), 等它把 il2cpp 表交出来 ..." % pid)
        limit = time.time() + 90
        while not done[0] and time.time() < limit:
            time.sleep(0.5)
        if not done[0]:
            print(">>> 超时 (90s), 只拿到 %d 行" % len(rows))
        rows.sort(key=lambda s: int(s.split("\t")[0], 16))
        with open(out_path, "w", encoding="utf-8") as f:
            f.write("\n".join(rows) + "\n")
        print(">>> 已写出 %d 行 → %s" % (len(rows), out_path))
    except KeyboardInterrupt:
        print("\n>>> 已停止 (ctrl+c)")
    finally:
        if pid is not None and not keep:
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
