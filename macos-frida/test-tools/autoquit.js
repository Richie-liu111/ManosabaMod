// 自动退出探针: 等游戏到标题后, 用 IL2CPP 调 UnityEngine.Application.Quit(0) —— 等价于玩家在
// 游戏内点"退出"按钮 (不用人动手, 让"退出卡死"这件事可以自动化验证)。
//
// 用法: PROBE=test-tools/autoquit.js ./run_mod.sh
// 依赖 bundle 已经把 JS 线程 attach 进域 (本脚本自己不再 attach)。
// 判读: run_mod.sh 打出 ">>> 游戏进程已退出 ... 自动停止" = 干净退出;
//       打出 ">>> 引擎退出后 Ns 进程仍未退出 (卡在未响应) → 看门狗强制收掉" = 仍然卡死。
;(function () {
    var DELAY_MS = parseInt((typeof MOD_AUTOQUIT_DELAY !== "undefined" ? MOD_AUTOQUIT_DELAY : 0), 10) || 25000;
    function gaModule() {
        var mods = Process.enumerateModules();
        for (var i = 0; i < mods.length; i++) if (mods[i].name.indexOf("GameAssembly") >= 0) return mods[i];
        return null;
    }
    var tries = 0;
    function waitReady() {
        tries++;
        var g = gaModule();
        var pDom = g ? g.findExportByName("il2cpp_domain_get") : null;
        if (!pDom) { if (tries < 200) { setTimeout(waitReady, 200); } return; }
        var dom = null;
        try { dom = new NativeFunction(pDom, "pointer", [])(); } catch (e) {
            if (tries < 200) { setTimeout(waitReady, 300); }
            return;
        }
        if (!dom || dom.isNull()) { if (tries < 200) { setTimeout(waitReady, 300); } return; }
        console.log("[autoquit] 域就绪, " + (DELAY_MS / 1000) + "s 后调用 Application.Quit(0)");
        setTimeout(function () { fire(dom); }, DELAY_MS);
    }
    function fire(dom) {
        try {
            var g = gaModule();
            var ex = {};
            ["il2cpp_domain_get_assemblies", "il2cpp_assembly_get_image", "il2cpp_image_get_name",
             "il2cpp_class_from_name", "il2cpp_class_get_method_from_name", "il2cpp_runtime_invoke"].forEach(function (k) {
                var p = g.findExportByName(k); if (p) ex[k] = p;
            });
            var cnt = Memory.alloc(8);
            var asms = new NativeFunction(ex["il2cpp_domain_get_assemblies"], "pointer", ["pointer", "pointer"])(dom, cnt);
            var nAsm = cnt.readPointer().toInt32();
            var agi = new NativeFunction(ex["il2cpp_assembly_get_image"], "pointer", ["pointer"]);
            var ign = new NativeFunction(ex["il2cpp_image_get_name"], "pointer", ["pointer"]);
            var core = null;
            for (var i = 0; i < nAsm; i++) {
                var img = agi(asms.add(i * 8).readPointer());
                if (img.isNull()) continue;
                if ((ign(img).readCString() || "").indexOf("UnityEngine.CoreModule") >= 0) { core = img; break; }
            }
            var cfn = new NativeFunction(ex["il2cpp_class_from_name"], "pointer", ["pointer", "pointer", "pointer"]);
            var appCls = cfn(core, Memory.allocUtf8String("UnityEngine"), Memory.allocUtf8String("Application"));
            var cgm = new NativeFunction(ex["il2cpp_class_get_method_from_name"], "pointer", ["pointer", "pointer", "int"]);
            var mi = cgm(appCls, Memory.allocUtf8String("Quit"), 1);
            if (!mi || mi.isNull()) { console.log("[autoquit] Application.Quit(int) 未找到"); return; }
            var arg = Memory.alloc(8); arg.writeS32(0);
            var args = Memory.alloc(8); args.writePointer(arg);
            var exc = Memory.alloc(8); exc.writePointer(ptr(0));
            console.log("[autoquit] 调用 Application.Quit(0) (等价游戏内退出按钮)");
            new NativeFunction(ex["il2cpp_runtime_invoke"], "pointer",
                               ["pointer", "pointer", "pointer", "pointer"])(mi, ptr(0), args, exc);
            console.log("[autoquit] 调用返回");
        } catch (e) { console.log("[autoquit] 异常: " + e); }
    }
    // 别从 t=0 就去碰 il2cpp: GameAssembly 是 spawn 后才 dlopen 的, 它的 dlopen 正好卡在
    // il2cpp_init 里 —— 这时候调 il2cpp_domain_get 会和初始化抢, 实测能让游戏在**启动 1 秒后
    // SIGABRT** (abort 栈顶就是 il2cpp_init, 2026-10-06 踩过)。等 6s 再说。
    setTimeout(waitReady, 6000);
})();
