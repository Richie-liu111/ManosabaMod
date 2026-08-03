📦
28973 /src/entry.js
2556 /src/io.js
15039 /src/menu.js
5211 /src/movie.js
7545 /src/providers.js
14500 /src/utils.js
19304 /src/witchbook/characters.js
13412 /src/witchbook/data.js
10487 /src/witchbook/index.js
10842 /src/witchbook/pages.js
28531 /src/witchbook/session.js
1742 /src/witchbook/state.js
6336 /src/witchbook/textures.js
✄
import { A, allImgs, cs, dbg, findClassAcrossImages, nv, readStr, setGotoModifiedCls, setImageHandles } from "./utils.js";
import { setupMovieHooks } from "./movie.js";
import { addModLoader } from "./providers.js";
import { hookStartGame, registerMenu, registerMenuText } from "./menu.js";
import { resetWitchBookSession } from "./witchbook/session.js";
import { setupWitchBookHooks } from "./witchbook/index.js";
import { registerTexturesInto } from "./witchbook/textures.js";
import { wbCls } from "./witchbook/state.js";
// ============ Steam 绕过 (Phase 1) ============
try {
    var dl = Module.findGlobalExportByName("dlopen");
    if (dl) {
        var h = false;
        Interceptor.attach(dl, { onEnter: function (a) { this.p = a[0].readCString(); }, onLeave: function (r) { if (h || r.isNull() || !this.p || this.p.indexOf("libsteam_api") === -1)
                return; var r2 = Module.findGlobalExportByName("SteamAPI_RestartAppIfNecessary"); if (r2)
                Interceptor.replace(r2, new NativeCallback(function () { return 0; }, 'bool', ['uint32'])); var i2 = Module.findGlobalExportByName("SteamInternal_SteamAPI_Init"); if (i2)
                Interceptor.replace(i2, new NativeCallback(function () { return 2; }, 'int', [])); h = true; } });
    }
}
catch (e) { }
var E = {}, dom = null;
var shouldLogLoadAndPlay = true;
// ============ 初始化 ============
(function () {
    var attempts = 0;
    function doInit() {
        attempts++;
        var ga = Process.findModuleByName("GameAssembly.dylib");
        if (!ga)
            return false;
        Thread.sleep(0.3);
        dbg("[v3] GameAssembly base=" + ga.base);
        var ex = ga.enumerateExports();
        for (var i = 0; i < ex.length; i++)
            E[ex[i].name] = ex[i].address;
        if (!E.il2cpp_domain_get || !E.il2cpp_class_from_name || !E.il2cpp_runtime_invoke || !E.il2cpp_thread_attach)
            return false;
        A.dg = new NativeFunction(E.il2cpp_domain_get, 'pointer', []);
        A.dga = new NativeFunction(E.il2cpp_domain_get_assemblies, 'pointer', ['pointer', 'pointer']);
        A.agi = new NativeFunction(E.il2cpp_assembly_get_image, 'pointer', ['pointer']);
        A.ign = new NativeFunction(E.il2cpp_image_get_name, 'pointer', ['pointer']);
        A.cfn = new NativeFunction(E.il2cpp_class_from_name, 'pointer', ['pointer', 'pointer', 'pointer']);
        A.cgm = new NativeFunction(E.il2cpp_class_get_method_from_name, 'pointer', ['pointer', 'pointer', 'int']);
        A.sn = new NativeFunction(E.il2cpp_string_new, 'pointer', ['pointer']);
        A.ri = new NativeFunction(E.il2cpp_runtime_invoke, 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
        A.ogc = new NativeFunction(E.il2cpp_object_get_class, 'pointer', ['pointer']);
        A.cgn = new NativeFunction(E.il2cpp_class_get_name, 'pointer', ['pointer']);
        A.on = new NativeFunction(E.il2cpp_object_new, 'pointer', ['pointer']);
        A.gf = new NativeFunction(E.il2cpp_class_get_field_from_name, 'pointer', ['pointer', 'pointer']);
        A.fo = new NativeFunction(E.il2cpp_field_get_offset, 'uint32', ['pointer']);
        A.sdf = new NativeFunction(E.il2cpp_class_get_static_field_data, 'pointer', ['pointer']);
        A.ta = new NativeFunction(E.il2cpp_thread_attach, 'pointer', ['pointer']);
        A.ots = E.il2cpp_object_to_string ? new NativeFunction(E.il2cpp_object_to_string, 'pointer', ['pointer']) : null;
        A.cgnt = new NativeFunction(E.il2cpp_class_get_nested_types, 'pointer', ['pointer', 'pointer']);
        A.vb = E.il2cpp_value_box ? new NativeFunction(E.il2cpp_value_box, 'pointer', ['pointer', 'pointer']) : null;
        A.cgt = E.il2cpp_class_get_type ? new NativeFunction(E.il2cpp_class_get_type, 'pointer', ['pointer']) : null;
        A.cft = E.il2cpp_class_from_type ? new NativeFunction(E.il2cpp_class_from_type, 'pointer', ['pointer']) : null;
        A.tgo = E.il2cpp_type_get_object ? new NativeFunction(E.il2cpp_type_get_object, 'pointer', ['pointer']) : null;
        A.an = E.il2cpp_array_new ? new NativeFunction(E.il2cpp_array_new, 'pointer', ['pointer', 'uint64']) : null;
        A.anSpec = E.il2cpp_array_new_specific ? new NativeFunction(E.il2cpp_array_new_specific, 'pointer', ['pointer', 'uint64']) : null;
        if (!A.cgt || !A.cft || !A.tgo)
            dbg("[v3] !! 类型 API 缺失 (cgt/cft/tgo), converters 填充将失败");
        if (!A.an)
            dbg("[v3] !! il2cpp_array_new 缺失, 数组创建将失败");
        dom = A.dg();
        var t = A.ta(dom);
        dbg("[v3] 线程已 attach: " + t);
        var cp = Memory.alloc(8);
        var asms = A.dga(dom, cp);
        var cnt = cp.readPointer().toInt32();
        var nvImg = null, csImg = null, gigaImg = null;
        allImgs.length = 0; // 共享数组重建 (ES modules 绑定不可重新赋值)
        for (var i = 0; i < cnt; i++) {
            var a = asms.add(i * 8).readPointer();
            var img = A.agi(a);
            var nm = A.ign(img).readCString();
            allImgs.push(img);
            if (nm.indexOf("Naninovel.Runtime") >= 0)
                nvImg = img;
            else if (nm.indexOf("Assembly-CSharp") >= 0)
                csImg = img;
            else if (nm.indexOf("GigaCreation") >= 0)
                gigaImg = img;
        }
        setImageHandles(nvImg, csImg, gigaImg);
        dbg("[v3] nv=" + nvImg + " cs=" + csImg + " giga=" + gigaImg + " images=" + cnt);
        // 动态解析 GotoModified (GigaCreation.NaninovelExtender.Common)
        var gmCls = findClassAcrossImages("GigaCreation.NaninovelExtender.Common", "GotoModified");
        if (gmCls.isNull()) {
            dbg("[v3] GotoModified NOT FOUND, 试无命名空间/其他 image...");
            for (var i = 0; i < allImgs.length && gmCls.isNull(); i++) {
                gmCls = A.cfn(allImgs[i], Memory.allocUtf8String("GigaCreation.NaninovelExtender.Common"), Memory.allocUtf8String("GotoModified"));
            }
        }
        if (gmCls.isNull()) {
            dbg("[v3] !! GotoModified 完全找不到, 跳过 goto 相关逻辑");
        }
        else {
            setGotoModifiedCls(gmCls);
            dbg("[v3] GotoModified class = " + gmCls);
        }
        // 动态解析 LoadAndPlay 并 hook (诊断用)
        if (gmCls && !gmCls.isNull()) {
            try {
                var lapMi = A.cgm(gmCls, Memory.allocUtf8String("LoadAndPlay"), 2);
                if (lapMi && !lapMi.isNull()) {
                    var lapPtr = lapMi.readPointer(); // methodPointer +0x00
                    dbg("[v3] LoadAndPlay methodPointer = " + lapPtr);
                    Interceptor.attach(lapPtr, {
                        onEnter: function (args) {
                            if (!shouldLogLoadAndPlay)
                                return;
                            var path = readStr(args[1]);
                            var label = readStr(args[2]);
                            dbg("[v3] >>> LoadAndPlay path='" + path + "' label='" + (label || "") + "'");
                        }
                    });
                    dbg("[v3] LoadAndPlay hooked (dynamic)");
                }
                else {
                    dbg("[v3] LoadAndPlay(2) NOT FOUND");
                }
            }
            catch (e) {
                dbg("[v3] LoadAndPlay hook err: " + e);
            }
        }
        // ===== 诊断: 完整 goto 链路 hook =====
        try {
            // TGSP (Goto.TryGetScriptPathAndLabel) — 解析出的实际路径
            var gotoCls = A.cfn(nv, Memory.allocUtf8String("Naninovel.Commands"), Memory.allocUtf8String("Goto"));
            if (gotoCls && !gotoCls.isNull()) {
                var tgspMi = A.cgm(gotoCls, Memory.allocUtf8String("TryGetScriptPathAndLabel"), 2);
                if (tgspMi && !tgspMi.isNull()) {
                    Interceptor.attach(tgspMi.readPointer(), {
                        onEnter: function (a) { this.p1 = a[1]; this.p2 = a[2]; },
                        onLeave: function (ret) {
                            var p = this.p1 ? readStr(this.p1.readPointer()) : null;
                            var l = this.p2 ? readStr(this.p2.readPointer()) : null;
                            dbg("[v3] TGSP -> path='" + p + "' label='" + (l || "") + "' ret=" + ret);
                        }
                    });
                    dbg("[v3] TGSP hooked");
                }
            }
            // ScriptPlayerExtensions.LoadAndPlay (标准版, 静态)
            var speCls = A.cfn(nv, Memory.allocUtf8String("Naninovel"), Memory.allocUtf8String("ScriptPlayerExtensions"));
            if (speCls && !speCls.isNull()) {
                var spleMi = A.cgm(speCls, Memory.allocUtf8String("LoadAndPlay"), 3);
                if (spleMi && !spleMi.isNull()) {
                    Interceptor.attach(spleMi.readPointer(), { onEnter: function (a) {
                            dbg("[v3] SPE.LoadAndPlay path='" + readStr(a[1]) + "'");
                        } });
                    dbg("[v3] SPE.LoadAndPlay hooked");
                }
            }
            // GotoModified.NavigateOtherScript + Execute + 局部函数
            if (gmCls && !gmCls.isNull()) {
                var navMi = A.cgm(gmCls, Memory.allocUtf8String("NavigateOtherScript"), 2);
                if (navMi && !navMi.isNull()) {
                    var navPtr = navMi.readPointer();
                    dbg("[v3] NavigateOtherScript addr=" + navPtr);
                    Interceptor.attach(navPtr, { onEnter: function (a) {
                            dbg("[v3] NavigateOtherScript path='" + readStr(a[1]) + "' label='" + (readStr(a[2]) || "") + "'");
                        } });
                    dbg("[v3] NavigateOtherScript hooked");
                }
                var execMi = A.cgm(gmCls, Memory.allocUtf8String("Execute"), 1);
                if (execMi && !execMi.isNull()) {
                    dbg("[v3] Execute addr=" + execMi.readPointer());
                    Interceptor.attach(execMi.readPointer(), { onEnter: function () {
                            dbg("[v3] GotoModified.Execute 触发");
                        } });
                    dbg("[v3] Execute hooked");
                }
                // 局部函数 (真正干活的?)
                var lfMi = A.cgm(gmCls, Memory.allocUtf8String("<NavigateOtherScript>g__LoadAndPlay|0"), 0);
                if (lfMi && !lfMi.isNull()) {
                    dbg("[v3] g__LoadAndPlay|0 addr=" + lfMi.readPointer());
                    Interceptor.attach(lfMi.readPointer(), { onEnter: function () {
                            dbg("[v3] >>> 局部函数 g__LoadAndPlay|0 触发");
                        } });
                    dbg("[v3] g__LoadAndPlay|0 hooked");
                }
                else {
                    dbg("[v3] 局部函数 g__LoadAndPlay|0 未找到");
                }
                // 嵌套状态机 <NavigateOtherScript>d__2 的 MoveNext (API: 每次返回一个指针, iter 推进)
                try {
                    var iter = Memory.alloc(8);
                    iter.writePointer(ptr(0));
                    var foundSm = false;
                    for (;;) {
                        var p = A.cgnt(gmCls, iter);
                        if (!p || p.isNull())
                            break;
                        var nc = p.readPointer();
                        if (!nc || nc.isNull())
                            break;
                        var nn = A.cgn(nc).readCString();
                        dbg("[v3] 嵌套类型: " + nn);
                        if (nn && (nn.indexOf("NavigateOtherScript") >= 0 || nn.indexOf("d__2") >= 0)) {
                            var mn2 = A.cgm(nc, Memory.allocUtf8String("MoveNext"), 0);
                            if (mn2 && !mn2.isNull()) {
                                var mnPtr = mn2.readPointer();
                                dbg("[v3] 状态机 " + nn + " MoveNext addr=" + mnPtr);
                                Interceptor.attach(mnPtr, {
                                    onEnter: function () { dbg("[v3] >>> NavigateOtherScript.MoveNext 触发"); }
                                });
                                dbg("[v3] MoveNext hooked");
                                foundSm = true;
                            }
                        }
                    }
                    if (!foundSm)
                        dbg("[v3] 未找到 NavigateOtherScript 状态机");
                }
                catch (e) {
                    dbg("[v3] 状态机查找 err: " + e);
                }
                // System.Exception.ToString() — NRE 的完整堆栈
                try {
                    var coreImg = null;
                    for (var ci = 0; ci < allImgs.length; ci++) {
                        var inm2 = A.ign(allImgs[ci]).readCString();
                        if (inm2.indexOf("mscorlib") >= 0 || inm2.indexOf("CoreLib") >= 0 || inm2.indexOf("System.Runtime") >= 0) {
                            coreImg = allImgs[ci];
                            break;
                        }
                    }
                    if (coreImg) {
                        var excCls = A.cfn(coreImg, Memory.allocUtf8String("System"), Memory.allocUtf8String("Exception"));
                        if (excCls && !excCls.isNull()) {
                            var tsMi = A.cgm(excCls, Memory.allocUtf8String("ToString"), 0);
                            if (tsMi && !tsMi.isNull()) {
                                Interceptor.attach(tsMi.readPointer(), {
                                    onEnter: function (a) {
                                        this.exc = a[0];
                                        try {
                                            var cn0 = a[0] ? readStr(a[0].add(0x10).readPointer()) : null;
                                            if (cn0 && cn0.indexOf("NullReference") >= 0) {
                                                var ga2 = Process.findModuleByName("GameAssembly.dylib");
                                                var bt = null;
                                                try {
                                                    bt = Thread.backtrace(this.context, Backtracer.ACCURATE);
                                                }
                                                catch (e2) {
                                                    dbg("[v3] bt ACCURATE err: " + e2);
                                                    try {
                                                        bt = Thread.backtrace(this.context, Backtracer.FUZZY);
                                                    }
                                                    catch (e3) {
                                                        dbg("[v3] bt FUZZY err: " + e3);
                                                    }
                                                }
                                                if (bt) {
                                                    var rvas = [];
                                                    for (var bi = 0; bi < Math.min(16, bt.length); bi++) {
                                                        try {
                                                            rvas.push("0x" + bt[bi].sub(ga2.base).toString(16));
                                                        }
                                                        catch (e4) {
                                                            rvas.push("?");
                                                        }
                                                    }
                                                    dbg("[v3] ****** NRE 原生栈: " + rvas.join(" "));
                                                }
                                                else {
                                                    dbg("[v3] ****** NRE bt null");
                                                }
                                            }
                                        }
                                        catch (e) {
                                            dbg("[v3] ToString onEnter err: " + e);
                                        }
                                    },
                                    onLeave: function () {
                                        if (!this.exc || this.exc.isNull())
                                            return;
                                        var cn = readStr(this.exc.add(0x10).readPointer());
                                        if (cn && cn.indexOf("NullReference") >= 0) {
                                            var msg = readStr(this.exc.add(0x18).readPointer());
                                            var st = readStr(this.exc.add(0x40).readPointer());
                                            dbg("[v3] ****** NRE: " + cn + (msg ? " | " + msg : ""));
                                            dbg("[v3] ****** 堆栈: " + (st || "<无>"));
                                        }
                                    }
                                });
                                dbg("[v3] Exception.ToString hooked (coreImg=" + coreImg + ")");
                            }
                        }
                    }
                }
                catch (e) {
                    dbg("[v3] Exception hook err: " + e);
                }
                // AsyncUniTaskMethodBuilder.SetException — 原生栈定位抛异常处
                try {
                    var utImg = null;
                    for (var ui = 0; ui < allImgs.length; ui++) {
                        var unin = A.ign(allImgs[ui]).readCString();
                        if (unin.indexOf("UniTask") >= 0) {
                            utImg = allImgs[ui];
                            break;
                        }
                    }
                    if (utImg) {
                        var builderCls = A.cfn(utImg, Memory.allocUtf8String("Cysharp.Threading.Tasks.CompilerServices"), Memory.allocUtf8String("AsyncUniTaskMethodBuilder"));
                        if (builderCls && !builderCls.isNull()) {
                            var setExcMi = A.cgm(builderCls, Memory.allocUtf8String("SetException"), 1);
                            if (setExcMi && !setExcMi.isNull()) {
                                dbg("[v3] AsyncUniTaskMethodBuilder.SetException addr=" + setExcMi.readPointer());
                                Interceptor.attach(setExcMi.readPointer(), {
                                    onEnter: function () {
                                        try {
                                            var ga2 = Process.findModuleByName("GameAssembly.dylib");
                                            var bt = Thread.backtrace(this.context, Backtracer.ACCURATE);
                                            var rvas = [];
                                            for (var bi = 0; bi < Math.min(14, bt.length); bi++) {
                                                var r = bt[bi].sub(ga2.base);
                                                rvas.push("0x" + r.toString(16));
                                            }
                                            dbg("[v3] #### SetException 原生栈: " + rvas.join(" "));
                                        }
                                        catch (e) {
                                            dbg("[v3] backtrace err: " + e);
                                        }
                                    }
                                });
                                dbg("[v3] SetException hooked");
                            }
                            else {
                                dbg("[v3] SetException NOT FOUND");
                            }
                        }
                    }
                }
                catch (e) {
                    dbg("[v3] UniTask hook err: " + e);
                }
            }
            // ScriptLoader 服务的加载入口
            var slCls = A.cfn(nv, Memory.allocUtf8String("Naninovel"), Memory.allocUtf8String("ScriptLoader"));
            if (slCls && !slCls.isNull()) {
                var loadMi2 = A.cgm(slCls, Memory.allocUtf8String("Load"), 2);
                if (loadMi2 && !loadMi2.isNull()) {
                    dbg("[v3] ScriptLoader.Load addr=" + loadMi2.readPointer());
                    Interceptor.attach(loadMi2.readPointer(), { onEnter: function (a) {
                            dbg("[v3] >>> ScriptLoader.Load path='" + readStr(a[1]) + "' startIndex=" + a[2].toInt32());
                        } });
                    dbg("[v3] ScriptLoader.Load hooked");
                }
                var ilMi = A.cgm(slCls, Memory.allocUtf8String("IsLoaded"), 1);
                if (ilMi && !ilMi.isNull()) {
                    Interceptor.attach(ilMi.readPointer(), { onEnter: function (a) {
                            dbg("[v3] ScriptLoader.IsLoaded path='" + readStr(a[1]) + "'");
                        } });
                    dbg("[v3] ScriptLoader.IsLoaded hooked");
                }
                // ResourceLoader<T>.GetLoaded(string) — 缓存直接命中 (ScriptLoader 继承自 ResourceLoader<Script>)
                var glMi = A.cgm(slCls, Memory.allocUtf8String("GetLoaded"), 1);
                if (glMi && !glMi.isNull()) {
                    dbg("[v3] ResourceLoader.GetLoaded addr=" + glMi.readPointer());
                    Interceptor.attach(glMi.readPointer(), { onEnter: function (a) {
                            dbg("[v3] >>> GetLoaded path='" + readStr(a[1]) + "'");
                        } });
                    dbg("[v3] GetLoaded hooked");
                }
                else {
                    dbg("[v3] GetLoaded NOT FOUND");
                }
            }
        }
        catch (e) {
            dbg("[v3] 诊断 hook 失败: " + e);
        }
        // ===== 捕获 Unity 错误日志 =====
        // dumpObj 输出游戏侧错误详情 — 全量保留 (不随 MOD_DEBUG 开关), 是最高优先级信息 (ARCHIVE 教训 2)
        function dumpObj(obj, tag) {
            if (!obj || obj.isNull()) {
                console.log("[v3] " + tag + ": <null>");
                return;
            }
            try {
                var cls = A.ogc(obj);
                var cn = cls ? A.cgn(cls).readCString() : "?";
                console.log("[v3] " + tag + " obj=" + obj + " class=" + cn);
                // hexdump 前 48 字节
                var hex = "";
                for (var i = 0; i < 48; i++) {
                    hex += obj.add(i).readU8().toString(16).padStart(2, "0") + (i % 16 === 15 ? " " : "");
                }
                console.log("[v3] " + tag + " hex: " + hex);
                // 从 +0x14 走 UTF-16 到 null, 取完整字符串 (忽略可疑长度字段)
                try {
                    var full = "";
                    for (var fi = 0; fi < 300; fi++) {
                        var c = obj.add(0x14 + fi * 2).readU16();
                        if (c === 0)
                            break;
                        full += String.fromCharCode(c);
                    }
                    if (full)
                        console.log("[v3] " + tag + " FULL: " + full);
                }
                catch (e) { }
                // 从多个起点走 UTF-16 到 null
                [0x08, 0x10, 0x14, 0x18, 0x0C].forEach(function (so) {
                    try {
                        var s = "";
                        for (var j = 0; j < 200; j++) {
                            var c = obj.add(so + j * 2).readU16();
                            if (c === 0) {
                                console.log("[v3] " + tag + " +0x" + so.toString(16) + " utf16='" + s + "'");
                                return;
                            }
                            s += String.fromCharCode(c);
                        }
                    }
                    catch (e) { }
                });
            }
            catch (e3) {
                console.log("[v3] " + tag + " dump err: " + e3);
            }
        }
        try {
            var ueImg = null;
            for (var i = 0; i < allImgs.length; i++) {
                var inm = A.ign(allImgs[i]).readCString();
                if (inm.indexOf("UnityEngine.CoreModule") >= 0) {
                    ueImg = allImgs[i];
                    break;
                }
            }
            if (ueImg) {
                var dbgCls = A.cfn(ueImg, Memory.allocUtf8String("UnityEngine"), Memory.allocUtf8String("Debug"));
                if (dbgCls && !dbgCls.isNull()) {
                    ["LogError", "LogException", "Log", "LogWarning"].forEach(function (mn) {
                        for (var ac = 1; ac <= 2; ac++) {
                            var m = A.cgm(dbgCls, Memory.allocUtf8String(mn), ac);
                            if (m && !m.isNull()) {
                                (function (mn2, ac2) {
                                    Interceptor.attach(m.readPointer(), {
                                        onEnter: function (a) {
                                            // Debug.LogError 等是静态方法 → 第一个参数在 a[0]
                                            dumpObj(a[0], "Unity." + mn2 + "(" + ac2 + ")");
                                        }
                                    });
                                })(mn, ac);
                            }
                        }
                    });
                    dbg("[v3] Unity Debug hooks 完成");
                }
                else {
                    dbg("[v3] UnityEngine.Debug class NOT FOUND");
                }
            }
            else {
                dbg("[v3] UnityEngine.CoreModule image NOT FOUND");
            }
        }
        catch (e) {
            dbg("[v3] Debug hook err: " + e);
        }
        // Movie 支持钩子 (URL 流式)
        setupMovieHooks();
        // WitchBook 线索支持
        setupWitchBookHooks();
        // Hook TitleUi.Activate → 重定向 + 注册菜单
        var tc = A.cfn(cs, Memory.allocUtf8String("WitchTrials.Views"), Memory.allocUtf8String("TitleUi"));
        if (tc && !tc.isNull()) {
            var actMi = A.cgm(tc, Memory.allocUtf8String("Activate"), 0);
            if (actMi && !actMi.isNull()) {
                Interceptor.attach(actMi.readPointer(), {
                    onEnter: function () { },
                    onLeave: function () {
                        dbg("[v3] TitleUi.Activate 触发");
                        // 回到标题 → 重置 WitchBook 会话 (防止上一 mod 的线索/状态被继承)
                        try {
                            resetWitchBookSession();
                        }
                        catch (e) { }
                        if (typeof modList !== "undefined" && modList && modList.length)
                            registerMenu(modList);
                        else
                            registerMenu([]);
                        registerMenuText();
                        // provider 管线: 为每个 mod 注入 LRP + converters + ProvisionSource
                        try {
                            var root = (typeof MOD_ROOT !== "undefined") ? MOD_ROOT : "";
                            if (typeof modList !== "undefined" && modList && modList.length) {
                                for (var mi = 0; mi < modList.length; mi++) {
                                    dbg("[v3] ==== 为 mod '" + modList[mi].key + "' 注入 provider ====");
                                    addModLoader(root, modList[mi].key);
                                }
                            }
                        }
                        catch (e2) {
                            dbg("[v3] addModLoader 循环 err: " + e2);
                        }
                        // WitchBook 纹理尽早注册 (Title 后场景加载即有)
                        try {
                            if (wbCls)
                                registerTexturesInto(null);
                        }
                        catch (e3) { }
                        // 重定向放到队列, 避免在 hook 回调里做托管调用
                        setTimeout(function () { hookStartGame(); }, 100);
                    }
                });
                dbg("[v3] TitleUi.Activate hooked");
            }
        }
        return true;
    }
    var chk = setInterval(function () {
        try {
            var ok = doInit();
            if (ok) {
                clearInterval(chk);
                dbg("[v3] 全部就绪");
            }
        }
        catch (e) {
            dbg("[v3] ERR: " + e);
        }
    }, 200);
})();

✄
// ============ 原生文件 I/O (Frida 运行时无 File/readFileSync, 用 libc open/read/lseek) ============
import { dbg } from "./utils.js";
var ioApi = null;
export function getIO() {
    if (ioApi)
        return ioApi;
    var mk = function (name, ret, args) {
        var a = Module.findGlobalExportByName(name);
        return a ? new NativeFunction(a, ret, args) : null;
    };
    ioApi = {
        open: mk("open", 'int', ['pointer', 'int']),
        close: mk("close", 'int', ['int']),
        read: mk("read", 'int', ['int', 'pointer', 'uint']),
        lseek: mk("lseek", 'long', ['int', 'long', 'int']),
        access: mk("access", 'int', ['pointer', 'int'])
    };
    return ioApi;
}
export function fileReadString(path) {
    try {
        var io = getIO();
        if (!io.open)
            return null;
        var fd = io.open(Memory.allocUtf8String(path), 0);
        if (fd < 0)
            return null;
        var size = io.lseek(fd, 0, 2);
        io.lseek(fd, 0, 0);
        var buf = Memory.alloc(size > 0 ? size : 1);
        var got = 0, r = 0;
        while (got < size) {
            r = io.read(fd, buf.add(got), size - got);
            if (r <= 0)
                break;
            got += r;
        }
        io.close(fd);
        return buf.readUtf8String(got);
    }
    catch (e) {
        return null;
    }
}
export function fileReadBytes(path) {
    try {
        var io = getIO();
        if (!io.open)
            return null;
        var fd = io.open(Memory.allocUtf8String(path), 0);
        if (fd < 0)
            return null;
        var size = io.lseek(fd, 0, 2);
        io.lseek(fd, 0, 0);
        var buf = Memory.alloc(size > 0 ? size : 1);
        var got = 0, r = 0;
        while (got < size) {
            r = io.read(fd, buf.add(got), size - got);
            if (r <= 0)
                break;
            got += r;
        }
        io.close(fd);
        return { buf: buf, size: got };
    }
    catch (e) {
        return null;
    }
}
export function fileExists(path) {
    try {
        var io = getIO();
        return !!io.access && io.access(Memory.allocUtf8String(path), 0) === 0;
    }
    catch (e) {
        return false;
    }
}
export function readJSONFile(path) {
    try {
        var s = fileReadString(path);
        if (s === null) {
            dbg("readJSONFile 读取失败 '" + path + "'");
            return null;
        }
        return JSON.parse(s);
    }
    catch (e) {
        dbg("readJSONFile 解析失败 '" + path + "': " + e);
        return null;
    }
}

✄
// ============ 菜单域: 菜单文本 (含翻页, 回迁自 16h 版) + 剧本注册 + StartGame @goto 重定向 ============
// 镜像 Windows AddModStartMenu (ModResourceLoader.cs) + HookStartGame
import { A, dbg, findClassAcrossImages, findSvc, findUnityImg, gotoModifiedCls, invoke, invokeOk, makeLocalResourceProvider, makeNamedStringCtor, makeS, makeUnityObject, readStr } from "./utils.js";
var modScriptPrefix = "TaffyModLoader";
var modMenuScript = "TaffyStart";
// ============ 菜单文本 (镜像 Windows AddModStartMenu, 简化) ============
// buildMenuText 采用 16h 版 (含翻页): 每页 perPage 条, # ChoiceList_<页> 标签, 上一页/下一页 + @Stop
// (16h 回迁的唯一功能, 镜像 Windows AddModStartMenu 的 ChoiceList_<页> 方案)
export function buildMenuText(modList) {
    var t = "@ProcessInput false\n@trialMode false\n@HideUI AutoToggle,WitchBookButtonUI AllowToggle:false time:0\n" +
        "@ShowUI ControlPanel time:0\n@back SubId:\"Overlay\" SolidColor tint:\"#000000\" time:0 Lazy:false\n";
    // 值必须带转义引号 (\"...\"), 否则 '/' 被当成除法表达式
    function setline(varName, val) {
        return "    @set \"" + varName + "=\\\"" + val + "\\\"\"\n";
    }
    // 翻页 (镜像 Windows AddModStartMenu: 每页 perPage 条, # ChoiceList_<页> 标签, 上一页/下一页 + @Stop)
    var perPage = 4;
    var page = 0, idx = 0;
    t += "# ChoiceList_" + page + "\n";
    function addChoice(nm, body) {
        return "@choice \"" + nm + "\" Lock:false play:true show:true\n" + body + "    @goto .GoToModScript\n";
    }
    // 原版
    t += addChoice("原版游戏剧情", setline("nextScenario", "Act01_Chapter01/Act01_Chapter01_Adv01") + setline("modKey", "__vanilla__"));
    idx++;
    for (var i = 0; i < modList.length; i++) {
        var m = modList[i];
        var enter = (m.Enter || "Act01_Chapter01/Act01_Chapter01_Adv01").replace(/"/g, '\\"');
        var nm = (m.Name || "Mod" + i).replace(/"/g, '\\"');
        // 页满 → 加导航 + @Stop, 翻页
        if (idx >= perPage) {
            if (page > 0) {
                t += "@choice \"上一页\" Lock:false play:true show:true\n    @goto .ChoiceList_" + (page - 1) + "\n";
            }
            t += "@choice \"下一页\" Lock:false play:true show:true\n    @goto .ChoiceList_" + (page + 1) + "\n";
            t += "@Stop\n";
            page++;
            t += "# ChoiceList_" + page + "\n";
            idx = 0;
        }
        t += addChoice(nm, setline("nextScenario", enter) + setline("modKey", m.key));
        idx++;
    }
    // 结尾: 末页加"上一页" (回到上一页) + @Stop
    if (page > 0) {
        t += "@choice \"上一页\" Lock:false play:true show:true\n    @goto .ChoiceList_" + (page - 1) + "\n";
    }
    t += "@Stop\n" +
        "\n# GoToModScript\n" +
        "@ProcessInput true set:Continue.true,Pause.true,Skip.true,ToggleSkip.true,AutoPlay.true,ToggleUI.true,ShowBacklog.true,Rollback.true\n" +
        "@ClearBacklog\n" +
        "@goto {nextScenario}\n";
    return t;
}
// 注册菜单本地化文档 (镜像 Windows: TextManager.textLoader 上 AddLoadedResource TextAsset)
export function registerMenuText() {
    try {
        var tm = findSvc("TextManager");
        if (!tm) {
            dbg("[v3] TextManager NOT FOUND");
            return;
        }
        var tmKlass = A.ogc(tm);
        var tlField = A.gf(tmKlass, Memory.allocUtf8String("textLoader"));
        var tl = tm.add(A.fo(tlField)).readPointer();
        if (tl.isNull()) {
            dbg("[v3] textLoader NULL");
            return;
        }
        var tlKlass = A.ogc(tl);
        dbg("[v3] textLoader=" + tl);
        // 偷 Resource<TextAsset> + LoadedResource<TextAsset> 类 (放宽: 任意条目)
        var resClass = null, lrClass = null;
        try {
            var ldlField = A.gf(tlKlass, Memory.allocUtf8String("LoadedByLocalPath"));
            if (!ldlField || ldlField.isNull()) {
                dbg("[v3] LoadedByLocalPath 字段 NOT FOUND");
            }
            var dict = tl.add(A.fo(ldlField)).readPointer();
            dbg("[v3] text dict=" + dict + " (field offset 0x" + A.fo(ldlField).toString(16) + ")");
            if (!dict.isNull()) {
                var ents = dict.add(0x18).readPointer();
                var al = ents.add(0x18).readS32();
                dbg("[v3] text dict count=" + al);
                for (var e = 0; e < al && e < 30; e++) {
                    var eb = ents.add(0x20 + e * 24);
                    if (eb.readS32() === -1)
                        continue;
                    var ks = readStr(eb.add(8).readPointer());
                    if (e < 5)
                        dbg("[v3] text dict[" + e + "] key=" + ks);
                    var lr = eb.add(16).readPointer();
                    var sysRes = lr.add(0x10).readPointer();
                    if (sysRes && !sysRes.isNull()) {
                        resClass = sysRes.readPointer();
                        lrClass = lr.readPointer();
                        break;
                    }
                }
            }
        }
        catch (e2) {
            dbg("[v3] text class-steal err: " + e2);
        }
        if (!resClass || !lrClass) {
            dbg("[v3] 无法偷 TextAsset 类");
            return;
        }
        // new TextAsset()
        var ueImg = findUnityImg();
        if (!ueImg) {
            dbg("[v3] UnityEngine.CoreModule NOT FOUND");
            return;
        }
        var taCls = A.cfn(ueImg, Memory.allocUtf8String("UnityEngine"), Memory.allocUtf8String("TextAsset"));
        if (!taCls || taCls.isNull()) {
            dbg("[v3] TextAsset class NOT FOUND");
            return;
        }
        var ta = makeUnityObject(taCls);
        dbg("[v3] TextAsset=" + ta);
        // Resource<TextAsset>
        var textPath = modScriptPrefix + "/Text/Scripts/" + modMenuScript;
        var ourRes = A.on(resClass);
        ourRes.add(0x10).writePointer(makeS(textPath));
        ourRes.add(0x18).writePointer(ta);
        // ProvisionSource + boxed (和 registerMenu 一致)
        var provProvider = makeLocalResourceProvider("");
        var psMem = Memory.alloc(16);
        psMem.writePointer(provProvider);
        psMem.add(8).writePointer(makeS(modScriptPrefix + "/Text"));
        var psCls = findClassAcrossImages("Naninovel", "ProvisionSource");
        var boxed = ptr(0);
        if (A.vb && psCls && !psCls.isNull()) {
            try {
                boxed = A.vb(psCls, psMem);
            }
            catch (e3) { }
        }
        // LoadedResource ctor + AddHolder + AddLoadedResource
        var lrCtor = A.cgm(lrClass, Memory.allocUtf8String(".ctor"), 2);
        var addHolderMi = A.cgm(lrClass, Memory.allocUtf8String("AddHolder"), 1);
        var addMi = A.cgm(tlKlass, Memory.allocUtf8String("AddLoadedResource"), 1);
        if (!lrCtor || lrCtor.isNull() || !addMi || addMi.isNull()) {
            dbg("[v3] 方法解析失败");
            return;
        }
        // 打印偷到的类名, 确认泛型实例正确
        try {
            dbg("[v3] resClass=" + A.cgn(resClass).readCString() + " lrClass=" + A.cgn(lrClass).readCString());
        }
        catch (e4) {
            dbg("[v3] 类名读取失败: " + e4);
        }
        // 多键注册 (覆盖所有可能路径)
        var keys = ["Text/Scripts/" + modMenuScript, "Scripts/" + modMenuScript, modScriptPrefix + "/Text/Scripts/" + modMenuScript, modMenuScript];
        for (var ki = 0; ki < keys.length; ki++) {
            var lr = A.on(lrClass);
            invoke(lrCtor, lr, [ourRes, psMem]);
            lr.add(0x28).writePointer(makeS(keys[ki]));
            if (addHolderMi && !addHolderMi.isNull() && boxed && !boxed.isNull())
                invoke(addHolderMi, lr, [boxed]);
            invoke(addMi, tl, [lr]);
            dbg("[v3] >>> 本地化文档已注册: key=" + keys[ki]);
        }
    }
    catch (e) {
        dbg("[v3] registerMenuText err: " + e);
    }
}
export function registerMenu(modList) {
    // 缓存方案 (镜像 Windows AddModStartMenu): FromText + AddHolder + AddLoadedResource
    try {
        var text = buildMenuText(modList);
        var scriptCls = findClassAcrossImages("Naninovel", "Script");
        if (scriptCls.isNull()) {
            dbg("[v3] Script class NOT FOUND");
            return;
        }
        var ftMi = A.cgm(scriptCls, Memory.allocUtf8String("FromText"), 3);
        if (!ftMi || ftMi.isNull()) {
            dbg("[v3] Script.FromText NOT FOUND");
            return;
        }
        var script = invoke(ftMi, ptr(0), [makeS(modMenuScript), makeS(text), ptr(0)]);
        if (script.isNull()) {
            dbg("[v3] FromText returned null");
            return;
        }
        dbg("[v3] FromText OK, script=" + script);
        var sm = findSvc("ScriptManager");
        if (!sm) {
            dbg("[v3] ScriptManager NOT FOUND");
            return;
        }
        var rl = sm.add(0x28).readPointer();
        if (rl.isNull()) {
            dbg("[v3] scriptLoader NULL");
            return;
        }
        var rlKlass = A.ogc(rl);
        // 偷类指针
        var resClass = null, lrClass = null;
        try {
            var dict = rl.add(0x30).readPointer();
            var ents = dict.add(0x18).readPointer();
            var al = ents.add(0x18).readS32();
            for (var e = 0; e < al; e++) {
                var eb = ents.add(0x20 + e * 24);
                if (eb.readS32() === -1)
                    continue;
                var ks = readStr(eb.add(8).readPointer());
                if (ks && ks.indexOf("System/System_Title") >= 0) {
                    var lr = eb.add(16).readPointer();
                    var sysRes = lr.add(0x10).readPointer();
                    if (sysRes && !sysRes.isNull()) {
                        resClass = sysRes.readPointer();
                        lrClass = lr.readPointer();
                    }
                    break;
                }
            }
        }
        catch (e2) {
            dbg("[v3] class-steal err: " + e2);
        }
        if (!resClass || !lrClass) {
            dbg("[v3] 无法偷类指针");
            return;
        }
        var resPath = modScriptPrefix + "/Scripts/" + modMenuScript;
        var ourRes = A.on(resClass);
        ourRes.add(0x10).writePointer(makeS(resPath));
        ourRes.add(0x18).writePointer(script);
        // ProvisionSource struct
        var provProvider = makeLocalResourceProvider("");
        var psMem = Memory.alloc(16);
        psMem.writePointer(provProvider);
        psMem.add(8).writePointer(makeS(modScriptPrefix + "/Scripts"));
        // LoadedResource 用 ctor
        var lrCtor = A.cgm(lrClass, Memory.allocUtf8String(".ctor"), 2);
        if (!lrCtor || lrCtor.isNull()) {
            dbg("[v3] LoadedResource.ctor NOT FOUND");
            return;
        }
        var addHolderMi = A.cgm(lrClass, Memory.allocUtf8String("AddHolder"), 1);
        var addMi = A.cgm(rlKlass, Memory.allocUtf8String("AddLoadedResource"), 1);
        if (!addMi || addMi.isNull()) {
            dbg("[v3] AddLoadedResource NOT FOUND");
            return;
        }
        // 装箱 ProvisionSource 供 AddHolder
        var boxed = ptr(0);
        if (A.vb && addHolderMi && !addHolderMi.isNull()) {
            var psCls = findClassAcrossImages("Naninovel", "ProvisionSource");
            if (psCls && !psCls.isNull()) {
                try {
                    boxed = A.vb(psCls, psMem);
                }
                catch (e3) {
                    dbg("[v3] value_box err: " + e3);
                }
            }
        }
        dbg("[v3] 包装完成, boxed=" + boxed + " provider=" + provProvider);
        function buildAndAdd(localPath) {
            var lr = A.on(lrClass);
            invoke(lrCtor, lr, [ourRes, psMem]);
            lr.add(0x28).writePointer(makeS(localPath));
            if (addHolderMi && !addHolderMi.isNull() && boxed && !boxed.isNull())
                invoke(addHolderMi, lr, [boxed]);
            invoke(addMi, rl, [lr]);
            dbg("[v3] >>> AddLoadedResource('" + localPath + "') 完成 (含 AddHolder)");
        }
        buildAndAdd(resPath);
        buildAndAdd(modMenuScript);
    }
    catch (e) {
        dbg("[v3] registerMenu err: " + e);
    }
}
// ============ 重定向 StartGame 的 @goto (镜像 Windows HookStartGame) ============
export function hookStartGame() {
    try {
        var sp = findSvc("WitchTrialsScriptPlayer");
        if (!sp)
            sp = findSvc("ScriptPlayer");
        if (!sp) {
            dbg("[v3] ScriptPlayer NOT FOUND");
            return;
        }
        var played = sp.add(0x58).readPointer(); // PlayedScript
        if (played.isNull()) {
            dbg("[v3] PlayedScript NULL");
            return;
        }
        var linesArr = played.add(0x30).readPointer(); // Script.lines
        if (linesArr.isNull()) {
            dbg("[v3] lines NULL");
            return;
        }
        var n = linesArr.add(0x18).readS32();
        var foundLabel = false;
        for (var i = 0; i < n; i++) {
            var lineObj = linesArr.add(0x20 + i * 8).readPointer();
            if (lineObj.isNull())
                continue;
            var cls = A.ogc(lineObj);
            var cn = A.cgn(cls).readCString();
            if (cn === "LabelScriptLine") {
                var lt = readStr(lineObj.add(0x20).readPointer());
                if (lt === "StartGame")
                    foundLabel = true;
            }
            else if (cn === "CommandScriptLine" && foundLabel) {
                var cmd = lineObj.add(0x20).readPointer();
                if (cmd.isNull())
                    continue;
                var cmdCls = A.ogc(cmd);
                if (gotoModifiedCls && !gotoModifiedCls.isNull() && cmdCls.equals(gotoModifiedCls)) {
                    dbg("[v3] 找到 StartGame 下的 GotoModified @ line " + i + ", cmd=" + cmd);
                    // Path.SetValue(NamedString(value="TaffyStart", name=""))
                    var pathObj = cmd.add(0x30).readPointer();
                    var nspCls = A.ogc(pathObj);
                    var svMi = A.cgm(nspCls, Memory.allocUtf8String("SetValue"), 1);
                    if (!svMi || svMi.isNull()) {
                        dbg("[v3] Path.SetValue NOT FOUND");
                        return;
                    }
                    // 重定向到完整路径 (缓存键测试)
                    var fullPath = modScriptPrefix + "/Scripts/" + modMenuScript;
                    var nsObj = makeNamedStringCtor(fullPath, "");
                    invoke(svMi, pathObj, [nsObj]);
                    dbg("[v3] >>> Path.SetValue(\"" + fullPath + "\") 完成 (完整路径)");
                    return;
                }
            }
        }
        dbg("[v3] 未在 StartGame 下找到 GotoModified (lines=" + n + ")");
    }
    catch (e) {
        dbg("[v3] hookStartGame err: " + e);
    }
}

✄
// ============ Movie 支持 (URL 流式, 镜像 Windows ModMovieLoader) ============
// run_mod.sh 注入 movieMap = { 视频名: 绝对路径 }
// 原理: @movie 命令是 IPreloadable, 剧本加载时 ScriptPlaylist.LoadResources
//   → PlayMovie.PreloadResources → MoviePlayer.HoldResources(name) → get_UrlStreaming。
//   get_UrlStreaming 默认 false → 走 videoLoader 加载 VideoClip → 无 provider 即失败,
//   导致整个 goto 中止 (黑屏)。修法: 对 mod 视频强制 UrlStreaming=true (跳过 VideoClip),
//   BuildStreamUrl 返回本地绝对路径, VideoPlayer 直接播放文件。
import { A, dbg, findClassAcrossImages, makeS, readStr } from "./utils.js";
var modMovies = (typeof movieMap !== "undefined" && movieMap) ? movieMap : {};
var pendingMovieName = null;
var playingMovieName = null;
var movieHooksReady = false;
export function isModMovie(nm) { return !!nm && !!modMovies[nm]; }
export function setupMovieHooks() {
    try {
        if (movieHooksReady)
            return;
        if (Object.keys(modMovies).length === 0) {
            dbg("[v3] setupMovieHooks: 无 mod 视频, 跳过");
            return;
        }
        var mpCls = findClassAcrossImages("Naninovel", "MoviePlayer");
        if (!mpCls || mpCls.isNull()) {
            dbg("[v3] setupMovieHooks: MoviePlayer 类未找到");
            return;
        }
        var urlMi = A.cgm(mpCls, Memory.allocUtf8String("get_UrlStreaming"), 0);
        var buildMi = A.cgm(mpCls, Memory.allocUtf8String("BuildStreamUrl"), 1);
        var holdMi = A.cgm(mpCls, Memory.allocUtf8String("HoldResources"), 2);
        if (!urlMi || urlMi.isNull() || !buildMi || buildMi.isNull() || !holdMi || holdMi.isNull()) {
            dbg("[v3] setupMovieHooks: 方法未找到 (get_UrlStreaming/BuildStreamUrl/HoldResources)");
            return;
        }
        var pnField = A.gf(mpCls, Memory.allocUtf8String("playedMovieName"));
        var pnOff = (pnField && !pnField.isNull()) ? A.fo(pnField) : 0x68;
        // 播放阶段: Play(name) 入口捕获名字 (get_UrlStreaming 在 Play 内被调用)
        var playMi = A.cgm(mpCls, Memory.allocUtf8String("Play"), 2);
        if (playMi && !playMi.isNull()) {
            Interceptor.attach(playMi.readPointer(), {
                onEnter: function (a) {
                    try {
                        playingMovieName = null;
                        var nm = readStr(a[1]);
                        dbg("[v3] Movie Play: '" + nm + "' mod=" + isModMovie(nm));
                        if (isModMovie(nm))
                            playingMovieName = nm;
                    }
                    catch (e) { }
                }
            });
        }
        // 预加载阶段: HoldResources(name) 入口捕获名字 → get_UrlStreaming 消费
        Interceptor.attach(holdMi.readPointer(), {
            onEnter: function (a) {
                try {
                    pendingMovieName = null;
                    var nm = readStr(a[1]);
                    if (isModMovie(nm))
                        pendingMovieName = nm;
                }
                catch (e) { }
            }
        });
        // 流式判定: mod 视频强制 true (跳过 VideoClip 加载, 预加载不再失败)
        Interceptor.attach(urlMi.readPointer(), {
            onEnter: function () { this._self = this.context.x0; },
            onLeave: function (ret) {
                try {
                    if (ret && !ret.isNull() && ret.toInt32() === 1)
                        return;
                    if (pendingMovieName) { // 预加载阶段
                        var p = modMovies[pendingMovieName];
                        pendingMovieName = null;
                        if (p) {
                            ret.replace(ptr(1));
                            dbg("[v3] Movie preload override: 流式跳过 VideoClip '" + p + "'");
                        }
                        return;
                    }
                    if (playingMovieName && isModMovie(playingMovieName)) { // 播放阶段 (Play 入口已捕获)
                        ret.replace(ptr(1));
                        return;
                    }
                    // 兜底: 读 playedMovieName 字段
                    var cur = readStr(this._self.add(pnOff));
                    if (isModMovie(cur))
                        ret.replace(ptr(1));
                }
                catch (e) { }
            }
        });
        // BuildStreamUrl: mod 视频 → 本地绝对路径 (VideoPlayer 认绝对路径)
        Interceptor.attach(buildMi.readPointer(), {
            onEnter: function (a) { this._nm = readStr(a[1]); },
            onLeave: function (ret) {
                try {
                    var p = modMovies[this._nm];
                    if (p) {
                        ret.replace(makeS(p));
                        dbg("[v3] Movie URL -> " + p);
                    }
                }
                catch (e) { }
            }
        });
        movieHooksReady = true;
        dbg("[v3] Movie hooks 就绪, mod 视频数=" + Object.keys(modMovies).length);
    }
    catch (e) {
        dbg("[v3] setupMovieHooks err: " + e);
    }
}

✄
// ============ provider 管线注册 (镜像 Windows AddModLoader, inflated 泛型版) ============
// 含: 剧本/本地化/voice/audio/背景 provider 注入; 立绘注册在 witchbook/characters.js
import { A, dbg, findClassAcrossImages, findSvc, getGenericArgClass, invokeOk, makeLocalResourceProvider, makeS, populateConvertersDict } from "./utils.js";
import { addCharacterProviders } from "./witchbook/characters.js";
// 把 provision source 插入 ResourceLoader 的 ProvisionSources
export function insertProvisionSource(rl, lrp, prefix, tag) {
    try {
        var rlKlass = A.ogc(rl);
        var psField = A.gf(rlKlass, Memory.allocUtf8String("ProvisionSources"));
        if (!psField || psField.isNull()) {
            dbg("[v3] " + tag + ": ProvisionSources 字段 NOT FOUND");
            return false;
        }
        var psList = rl.add(A.fo(psField)).readPointer();
        if (psList.isNull()) {
            dbg("[v3] " + tag + ": ProvisionSources 为 null");
            return false;
        }
        var psMem = Memory.alloc(16);
        psMem.writePointer(lrp);
        psMem.add(8).writePointer(makeS(prefix));
        var listKlass = A.ogc(psList);
        var insMi = A.cgm(listKlass, Memory.allocUtf8String("Insert"), 2);
        if (!insMi || insMi.isNull()) {
            dbg("[v3] " + tag + ": List.Insert NOT FOUND");
            return false;
        }
        var idxBuf = Memory.alloc(4);
        idxBuf.writeS32(0);
        var r = invokeOk(insMi, psList, [idxBuf, psMem]);
        dbg("[v3] " + tag + ": Insert(" + prefix + ") → " + (r.ok ? "OK" : "FAIL") + " 条数=" + psList.add(0x18).readS32());
        return r.ok;
    }
    catch (e) {
        dbg("[v3] insertProvisionSource err (" + tag + "): " + e);
        return false;
    }
}
export function addTextLoader(root, prefix) {
    try {
        var tm = findSvc("TextManager");
        if (!tm) {
            dbg("[v3] addTextLoader: TextManager NOT FOUND");
            return;
        }
        var tmKlass = A.ogc(tm);
        var tlField = A.gf(tmKlass, Memory.allocUtf8String("textLoader"));
        var tl = tm.add(A.fo(tlField)).readPointer();
        if (tl.isNull()) {
            dbg("[v3] addTextLoader: textLoader NULL");
            return;
        }
        var lrp = makeLocalResourceProvider(root);
        if (lrp.isNull())
            return;
        var textAssetFn = function () { return findClassAcrossImages("UnityEngine", "TextAsset"); };
        if (!populateConvertersDict(lrp, "TxtToTextAssetConverter", textAssetFn, "Text"))
            return;
        insertProvisionSource(tl, lrp, prefix + "/Text", "addTextLoader");
    }
    catch (e) {
        dbg("[v3] addTextLoader err: " + e);
    }
}
// voice + audio provider: AudioManagerExtended 的 voiceLoader(0x78)/audioLoader(0x70) + WavToAudioClipConverter
export function addAudioProviders(root, prefix) {
    try {
        var am = findSvc("AudioManagerExtended");
        if (!am)
            am = findSvc("AudioManager");
        if (!am) {
            dbg("[v3] addAudioProviders: AudioManager NOT FOUND");
            return;
        }
        var audioClipFn = function () { return findClassAcrossImages("UnityEngine", "AudioClip"); };
        var voiceLoader = am.add(0x78).readPointer();
        if (!voiceLoader.isNull()) {
            var lrpV = makeLocalResourceProvider(root);
            if (!lrpV.isNull() && populateConvertersDict(lrpV, "WavToAudioClipConverter", audioClipFn, "Voice"))
                insertProvisionSource(voiceLoader, lrpV, prefix + "/Voice", "addAudioProviders(Voice)");
        }
        else {
            dbg("[v3] addAudioProviders: voiceLoader NULL");
        }
        var audioLoader = am.add(0x70).readPointer();
        if (!audioLoader.isNull()) {
            var lrpA = makeLocalResourceProvider(root);
            if (!lrpA.isNull() && populateConvertersDict(lrpA, "WavToAudioClipConverter", audioClipFn, "Audio"))
                insertProvisionSource(audioLoader, lrpA, prefix + "/Audio", "addAudioProviders(Audio)");
        }
        else {
            dbg("[v3] addAudioProviders: audioLoader NULL");
        }
    }
    catch (e) {
        dbg("[v3] addAudioProviders err: " + e);
    }
}
// 背景 provider: BackgroundManagerExtended.GetAppearanceLoader("MainBackground"/"Stills"/"Tricks")
//   + JpgOrPngToTextureConverter → ProvisionSource(prefix/Backgrounds/<backId>) (镜像 Windows)
export function addBackgroundProviders(root, prefix) {
    try {
        var bm = findSvc("BackgroundManagerExtended");
        if (!bm) {
            dbg("[v3] addBackgroundProviders: BackgroundManagerExtended NOT FOUND");
            return;
        }
        var galMi = A.cgm(A.ogc(bm), Memory.allocUtf8String("GetAppearanceLoader"), 1);
        if (!galMi || galMi.isNull()) {
            dbg("[v3] addBackgroundProviders: GetAppearanceLoader NOT FOUND");
            return;
        }
        var texFn = function () { return findClassAcrossImages("UnityEngine", "Texture2D"); };
        var backIds = ["MainBackground", "Stills", "Tricks"];
        for (var i = 0; i < backIds.length; i++) {
            try {
                var loader = invoke(galMi, bm, [makeS(backIds[i])]);
                if (!loader || loader.isNull()) {
                    dbg("[v3] 背景 loader '" + backIds[i] + "' 为空");
                    continue;
                }
                var lrp = makeLocalResourceProvider(root);
                if (lrp.isNull())
                    continue;
                if (!populateConvertersDict(lrp, "JpgOrPngToTextureConverter", texFn, "Backgrounds/" + backIds[i]))
                    continue;
                insertProvisionSource(loader, lrp, prefix + "/Backgrounds/" + backIds[i], "Backgrounds/" + backIds[i]);
            }
            catch (e) {
                dbg("[v3] 背景 '" + backIds[i] + "' 注入 err: " + e);
            }
        }
        dbg("[v3] addBackgroundProviders 完成 (" + backIds.join("/") + ")");
    }
    catch (e) {
        dbg("[v3] addBackgroundProviders err: " + e);
    }
}
export function addModLoader(root, prefix) {
    try {
        var sm = findSvc("ScriptManager");
        if (!sm) {
            dbg("[v3] addModLoader: ScriptManager NOT FOUND");
            return;
        }
        var rl = sm.add(0x28).readPointer();
        if (rl.isNull()) {
            dbg("[v3] addModLoader: scriptLoader NULL");
            return;
        }
        // 剧本 provider: LRP(MOD_ROOT) + NaniToScriptAssetConverter + ProvisionSource(prefix/Scripts)
        var lrp = makeLocalResourceProvider(root);
        if (lrp.isNull()) {
            dbg("[v3] addModLoader: LRP 创建失败 (root='" + root + "')");
            return;
        }
        var scriptFn = function () { return findClassAcrossImages("Naninovel", "Script"); };
        if (!populateConvertersDict(lrp, "NaniToScriptAssetConverter", scriptFn, "Script"))
            return;
        insertProvisionSource(rl, lrp, prefix + "/Scripts", "addModLoader(Script)");
        // 本地化 provider: LRP(MOD_ROOT) + TxtToTextAssetConverter + ProvisionSource(prefix/Text)
        addTextLoader(root, prefix);
        // voice + audio provider
        addAudioProviders(root, prefix);
        // 背景 provider (MainBackground/Stills/Tricks)
        addBackgroundProviders(root, prefix);
        // 立绘 provider (Characters/SimpleCharacters → ActorMetadata 注册)
        addCharacterProviders(root, prefix);
    }
    catch (e) {
        dbg("[v3] addModLoader err: " + e);
    }
}

✄
// ============ 基础工具 (镜像 v3 单文件版) ============
// 共享状态: IL2CPP API 表 (entry.js 初始化后填充)、image 句柄、GotoModified 类
// 日志分层 (ARCHIVE 教训 2/3): 机制日志走 dbg (MOD_DEBUG 开关, 默认关);
// 游戏侧 Unity.LogError 全量抓取由 entry.js 的 Debug hooks 负责。
// IL2CPP C API 绑定表 (entry.js 填充; 对象引用共享)
export var A = {};
// image 句柄 (entry.js 初始化)
export var nv = null, cs = null, giga = null;
export var allImgs = [];
// GotoModified 类 (entry.js 解析, menu.js 的 hookStartGame 使用)
export var gotoModifiedCls = null;
// 日志开关: 全局 MOD_DEBUG (run_mod.sh 可注入), 默认关
export var MOD_DEBUG = (typeof globalThis !== "undefined" && globalThis.MOD_DEBUG) ? true : false;
export function dbg() { if (MOD_DEBUG)
    console.log.apply(console, arguments); }
export function wblog(msg) { console.log("[v3][WitchBook] " + msg); }
// setter (ES modules import 绑定只读, 赋值必须在模块内; entry.js 初始化时调用)
export function setImageHandles(nvImg, csImg, gigaImg) { nv = nvImg; cs = csImg; giga = gigaImg; }
export function setGotoModifiedCls(c) { gotoModifiedCls = c; }
// ============ 基础工具 ============
export function readStr(p) {
    if (!p || p.isNull())
        return null;
    try {
        var l = p.add(0x10).readS32();
        if (l <= 0 || l > 9999)
            return null;
        var s = "";
        for (var i = 0; i < l; i++)
            s += String.fromCharCode(p.add(0x14 + i * 2).readU16());
        return s;
    }
    catch (e) {
        return null;
    }
}
export function makeS(v) { return A.sn(Memory.allocUtf8String(v || "")); }
export function invoke(mi, obj, args) {
    var params = args.length ? Memory.alloc(Process.pointerSize * args.length) : ptr(0);
    for (var i = 0; i < args.length; i++)
        params.add(i * Process.pointerSize).writePointer(args[i]);
    var exc = Memory.alloc(8);
    exc.writePointer(ptr(0));
    var ret = A.ri(mi, obj, params, exc);
    var ex = exc.readPointer();
    if (!ex.isNull()) {
        var en = ex ? (A.ogc(ex) ? A.cgn(A.ogc(ex)).readCString() : "?") : "?";
        dbg("[v3] invoke THREW: " + en);
        return ptr(0);
    }
    return ret;
}
// 返回成功与否的 invoke
export function invokeOk(mi, obj, args) {
    var params = args.length ? Memory.alloc(Process.pointerSize * args.length) : ptr(0);
    for (var i = 0; i < args.length; i++)
        params.add(i * Process.pointerSize).writePointer(args[i]);
    var exc = Memory.alloc(8);
    exc.writePointer(ptr(0));
    var ret = A.ri(mi, obj, params, exc);
    var ex = exc.readPointer();
    if (!ex.isNull()) {
        var en = ex ? (A.ogc(ex) ? A.cgn(A.ogc(ex)).readCString() : "?") : "?";
        try {
            var jsstack = new Error().stack.split("\n").slice(1, 4).join(" | ");
            dbg("[v3] invoke THREW: " + en + " <= " + jsstack);
        }
        catch (e2) {
            dbg("[v3] invoke THREW: " + en);
        }
        return { ok: false, ret: ptr(0) };
    }
    return { ok: true, ret: ret };
}
// 0 参构造器调用 (用户已证可行)
var ctorCache = {};
export function tryCtor(cls, obj) {
    var k = ptr(cls).toInt32();
    if (ctorCache[k] === undefined) {
        var mi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 0);
        ctorCache[k] = mi && !mi.isNull() ? new NativeFunction(mi.readPointer(), 'void', ['pointer']) : null;
    }
    var fn = ctorCache[k];
    if (fn)
        fn(obj);
}
export function findClassAcrossImages(ns, name) {
    var nsStr = Memory.allocUtf8String(ns), nmStr = Memory.allocUtf8String(name);
    var imgs = [nv, cs, giga].concat(allImgs);
    var seen = {};
    for (var i = 0; i < imgs.length; i++) {
        if (!imgs[i] || imgs[i].isNull())
            continue;
        var key = imgs[i].toString();
        if (seen[key])
            continue;
        seen[key] = true;
        var c = A.cfn(imgs[i], nsStr, nmStr);
        if (c && !c.isNull())
            return c;
    }
    return ptr(0);
}
// ============ provider 管线注册 (镜像 Windows AddModLoader, inflated 泛型版) ============
// 从实例化泛型类的 type 挖 genericInst 的某个 type 参数 → 类
export function getGenericArgClass(instClass, idx) {
    try {
        var t = A.cgt(instClass);
        if (!t || t.isNull())
            return ptr(0);
        var genCls = t.readPointer(); // data.generic_class
        if (genCls.isNull())
            return ptr(0);
        var classInst = genCls.add(0x8).readPointer(); // context.class_inst
        if (classInst.isNull())
            return ptr(0);
        var argc = classInst.readU32();
        var argv = classInst.add(0x8).readPointer(); // Il2CppType**
        if (idx >= argc)
            return ptr(0);
        return A.cft(argv.add(idx * 8).readPointer());
    }
    catch (e) {
        dbg("[v3] getGenericArgClass err: " + e);
        return ptr(0);
    }
}
// 用 inflated 泛型方法填充 LRP.converters (Dictionary<Type, List<IConverter>>) — 绕开 FSG AddConverter
// convClassName: 转换器类名; targetClsFn: () => 目标类型的 Il2CppClass (Script/TextAsset)
export function populateConvertersDict(lrp, convClassName, targetClsFn, tag) {
    try {
        var dict = lrp.add(0x58).readPointer();
        var dictCls = A.ogc(dict);
        var listCls = getGenericArgClass(dictCls, 1); // List<IConverter>
        if (listCls.isNull()) {
            dbg("[v3] List<IConverter> 类提取失败 (" + tag + ")");
            return false;
        }
        var listObj = A.on(listCls);
        if (!invokeOk(A.cgm(listCls, Memory.allocUtf8String(".ctor"), 0), listObj, []).ok) {
            dbg("[v3] List.ctor 失败 (" + tag + ")");
            return false;
        }
        var convCls = findClassAcrossImages("Naninovel", convClassName);
        if (convCls.isNull()) {
            dbg("[v3] " + convClassName + " NOT FOUND");
            return false;
        }
        var conv = A.on(convCls);
        if (!invokeOk(A.cgm(convCls, Memory.allocUtf8String(".ctor"), 0), conv, []).ok) {
            dbg("[v3] " + convClassName + ".ctor 失败");
            return false;
        }
        if (!invokeOk(A.cgm(listCls, Memory.allocUtf8String("Add"), 1), listObj, [conv]).ok) {
            dbg("[v3] List.Add 失败 (" + tag + ")");
            return false;
        }
        var targetCls = targetClsFn();
        if (targetCls.isNull()) {
            dbg("[v3] 目标类型类 NULL (" + tag + ")");
            return false;
        }
        var typeObj = A.tgo(A.cgt(targetCls)); // typeof(target)
        if (!invokeOk(A.cgm(dictCls, Memory.allocUtf8String("Add"), 2), dict, [typeObj, listObj]).ok) {
            dbg("[v3] Dict.Add 失败 (" + tag + ")");
            return false;
        }
        dbg("[v3] converters 填充 OK (" + convClassName + " → " + tag + ")");
        return true;
    }
    catch (e) {
        dbg("[v3] populateConverters err (" + tag + "): " + e);
        return false;
    }
}
// ============ 服务查找 ============
export function findSvc(name) {
    var el = A.cfn(nv, Memory.allocUtf8String("Naninovel"), Memory.allocUtf8String("Engine"));
    var f = A.gf(el, Memory.allocUtf8String("services"));
    var l = A.sdf(el).add(A.fo(f)).readPointer();
    var its = l.add(0x10).readPointer();
    var sz = l.add(0x18).readS32();
    for (var i = 0; i < sz; i++) {
        var ep = its.add(0x20 + i * 8).readPointer();
        if (ep.isNull())
            continue;
        var cn = A.cgn(A.ogc(ep)).readCString();
        if (cn === name)
            return ep;
    }
    return null;
}
// 找 System 类型 (mscorlib 等)
export function getSystemClass(name) {
    for (var i = 0; i < allImgs.length; i++) {
        var inm = A.ign(allImgs[i]).readCString();
        if (inm.indexOf("mscorlib") >= 0 || inm.indexOf("System.Private") >= 0 || inm.indexOf("CoreLib") >= 0) {
            var c = A.cfn(allImgs[i], Memory.allocUtf8String("System"), Memory.allocUtf8String(name));
            if (c && !c.isNull())
                return c;
        }
    }
    return ptr(0);
}
// 按名称在类的嵌套类型里找 (CluePage.LocalizedTexts 等 private 嵌套类; cgn 可能带前缀, 用后缀匹配)
export function findNestedClass(parentCls, name) {
    try {
        var iter = Memory.alloc(8);
        iter.writePointer(ptr(0));
        for (;;) {
            var p = A.cgnt(parentCls, iter);
            if (!p || p.isNull())
                break;
            var nc = p.readPointer();
            if (!nc || nc.isNull())
                break;
            var nn = A.cgn(nc).readCString() || "";
            if (nn === name || nn.indexOf("." + name) >= 0)
                return nc;
        }
    }
    catch (e) { }
    return ptr(0);
}
// 字段偏移: 动态查 (含基类) + 回退
export function fieldOffset(cls, name, fallback) {
    try {
        var f = A.gf(cls, Memory.allocUtf8String(name));
        if (f && !f.isNull())
            return A.fo(f);
    }
    catch (e) { }
    return fallback;
}
// Object.FindObjectsOfType(Type) → Object[] → 非空实例数组
export function findAllObjectOfType(cls) {
    try {
        var objCls = findClassAcrossImages("UnityEngine", "Object");
        if (!objCls || objCls.isNull())
            return [];
        var typeObj = A.tgo(A.cgt(cls));
        var arr = null;
        // FindObjectsOfType(Type) — 若 1 参无 RVA/invoker, 回退 2 参 (Type, includeInactive:false)
        var mi = A.cgm(objCls, Memory.allocUtf8String("FindObjectsOfType"), 1);
        if (mi && !mi.isNull() && mi.readPointer() && !mi.readPointer().isNull()) {
            arr = invoke(mi, ptr(0), [typeObj]);
        }
        else {
            var mi2 = A.cgm(objCls, Memory.allocUtf8String("FindObjectsOfType"), 2);
            if (!mi2 || mi2.isNull())
                return [];
            var fb = Memory.alloc(4);
            fb.writeS32(0);
            arr = invoke(mi2, ptr(0), [typeObj, fb]);
        }
        if (!arr || arr.isNull() || arr.add(0x18).readS32() === 0) {
            // 纯资产 (CharacterData/AuthorData 等 ScriptableObject) 需 FindObjectsOfTypeAll (镜像 Windows Resources.FindObjectsOfTypeAll)
            try {
                var resCls = findClassAcrossImages("UnityEngine", "Resources");
                var mia = A.cgm(resCls, Memory.allocUtf8String("FindObjectsOfTypeAll"), 1);
                if (mia && !mia.isNull() && mia.readPointer() && !mia.readPointer().isNull())
                    arr = invoke(mia, ptr(0), [typeObj]);
            }
            catch (e) { }
        }
        if (!arr || arr.isNull())
            return [];
        var len = arr.add(0x18).readS32();
        var out = [];
        for (var i = 0; i < len; i++) {
            var e = arr.add(0x20 + i * 8).readPointer();
            if (e && !e.isNull())
                out.push(e);
        }
        return out;
    }
    catch (e) {
        wblog("findAllObjectOfType err: " + e);
        return [];
    }
}
export function findFirstObjectOfType(cls) { var a = findAllObjectOfType(cls); return a.length ? a[0] : null; }
// List<T> 里是否已有 id。List 布局: _items(T[])@+0x10, _size(int)@+0x18, _version@+0x1C
// 数组元素在 arr+0x20 (SZARRAY 数据区)
export function listContainsId(list, id, idOff) {
    try {
        var cnt = list.add(0x18).readS32(), items = list.add(0x10).readPointer();
        for (var i = 0; i < cnt; i++) {
            var e = items.add(0x20 + i * 8).readPointer();
            if (e.isNull())
                continue;
            if (readStr(e.add(idOff).readPointer()) === id)
                return true;
        }
    }
    catch (e) { }
    return false;
}
// 找 UnityEngine.CoreModule image
export function findUnityImg() {
    for (var i = 0; i < allImgs.length; i++) {
        var inm = A.ign(allImgs[i]).readCString();
        if (inm.indexOf("UnityEngine.CoreModule") >= 0)
            return allImgs[i];
    }
    return null;
}
// 创建 Unity 对象: object_new + 0参构造 (runtime_invoke → 直调 fallback)
export function makeUnityObject(cls) {
    var o = A.on(cls);
    var ctorMi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 0);
    if (!ctorMi || ctorMi.isNull())
        return o;
    var r = invokeOk(ctorMi, o, []);
    if (r.ok)
        return o;
    try {
        var mpFn = new NativeFunction(ctorMi.readPointer(), 'void', ['pointer']);
        mpFn(o);
    }
    catch (e) { }
    return o;
}
export function makeNullStr(str) {
    var cls = findClassAcrossImages("Naninovel", "NullableString");
    if (!cls || cls.isNull())
        return ptr(0);
    var o = A.on(cls);
    tryCtor(cls, o);
    o.add(0x10).writePointer(str || ptr(0));
    o.add(0x18).writeS32(str ? 1 : 0);
    return o;
}
// NamedString 用构造器创建, 不猜字段布局: ctor(name, value)
export function makeNamedStringCtor(name, value) {
    var cls = findClassAcrossImages("Naninovel", "NamedString");
    if (!cls || cls.isNull())
        return ptr(0);
    var o = A.on(cls);
    var ctorMi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 2);
    if (!ctorMi || ctorMi.isNull()) {
        dbg("[v3] NamedString.ctor NOT FOUND");
        return ptr(0);
    }
    invoke(ctorMi, o, [makeS(name || ""), makeS(value || "")]);
    return o;
}
// 创建 LocalResourceProvider(rootPath) — runtime_invoke 失败则直调 methodPointer
export function makeLocalResourceProvider(root) {
    var cls = findClassAcrossImages("Naninovel", "LocalResourceProvider");
    if (!cls || cls.isNull()) {
        dbg("[v3] LocalResourceProvider NOT FOUND");
        return ptr(0);
    }
    var o = A.on(cls);
    var ctorMi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 1);
    if (!ctorMi || ctorMi.isNull()) {
        dbg("[v3] LRP.ctor NOT FOUND");
        return ptr(0);
    }
    var strPtr = makeS(root || "");
    var r = invokeOk(ctorMi, o, [strPtr]);
    if (r.ok) {
        return o;
    }
    // 回退: 直接调 methodPointer (纯 .NET 1 参, ABI: x0=this, x1=string)
    try {
        var mp = ctorMi.readPointer();
        dbg("[v3] LRP ctor runtime_invoke 失败, 尝试直调 methodPointer=" + mp + " invoker槽=" + ctorMi.add(0x10).readPointer());
        var mpFn = new NativeFunction(mp, 'void', ['pointer', 'pointer']);
        mpFn(o, strPtr);
        dbg("[v3] LRP ctor 直调成功");
        return o;
    }
    catch (e) {
        dbg("[v3] LRP ctor 直调也失败: " + e);
        return ptr(0);
    }
}

✄
// ============ WitchBook 角色域: 立绘 provider 注册 + CharacterData/AuthorData 注入 + Profile 姓名覆写 ============
// 镜像 Windows AddRichCharacter/AddSimpleCharacter + TryInjectCharacterData + TryInjectAuthorData + ProfilePageRefreshContent_Patch
import { A, dbg, fieldOffset, findClassAcrossImages, findFirstObjectOfType, findSvc, invoke, invokeOk, listContainsId, makeLocalResourceProvider, makeS, populateConvertersDict, readStr, wblog } from "../utils.js";
import { wbCls, wbCurrentMod, wbData } from "./state.js";
import { buildLocalizedTextArray, localeValue, pickLocaleText, resolveLocale, unionLocaleKeys } from "./data.js";
// ===== 立绘 (Characters) 注册 — 镜像 Windows AddRichCharacter/AddSimpleCharacter + providersMap =====
// 从 metaMap.metas[] 偷一个原版 CharacterMetadata 的 Loader.ProviderTypes 类 (List<string>)
function stealListStringClass(metaMap) {
    try {
        var metas = metaMap.add(0x18).readPointer(); // ActorMetadataMap<T>.metas @0x18
        if (metas.isNull())
            return ptr(0);
        var cnt = metas.add(0x18).readS32();
        for (var i = 0; i < cnt; i++) {
            var m = metas.add(0x20 + i * 8).readPointer();
            if (m.isNull())
                continue;
            var loader = m.add(0x18).readPointer(); // ActorMetadata.Loader @0x18
            if (loader.isNull())
                continue;
            var pt = loader.add(0x18).readPointer(); // ResourceLoaderConfiguration.ProviderTypes @0x18
            if (pt.isNull())
                continue;
            return A.ogc(pt);
        }
    }
    catch (e) { }
    return ptr(0);
}
// 立绘 provider: ① providersMap.Add(prefix, LRP(Texture2D)) ② CharacterManagerExtended 注册 ActorMetadata
export function addCharacterProviders(root, prefix) {
    try {
        logSpriteAqn();
        // ① ResourceProviderManager.providersMap.Add(prefix, lrp) — 角色 sprite 提供者
        var rpm = findSvc("ResourceProviderManager");
        if (rpm) {
            var rpmCls = A.ogc(rpm);
            var pm = rpm.add(fieldOffset(rpmCls, "providersMap", 0x20)).readPointer();
            if (!pm.isNull()) {
                var lrp = makeLocalResourceProvider(root);
                var texFn = function () { return findClassAcrossImages("UnityEngine", "Texture2D"); };
                if (!lrp.isNull() && populateConvertersDict(lrp, "JpgOrPngToTextureConverter", texFn, "providersMap/" + prefix)) {
                    var pmCls = A.ogc(pm);
                    // 先查是否已存在 (TitleUi 可能多次触发 → 重复 Add 抛 ArgumentException)
                    var containsMi = A.cgm(pmCls, Memory.allocUtf8String("ContainsKey"), 1);
                    var already = false;
                    if (containsMi && !containsMi.isNull()) {
                        var r = invokeOk(containsMi, pm, [makeS(prefix)]);
                        already = r.ok && r.ret && r.ret.toInt32() === 1;
                    }
                    if (!already) {
                        var addMi = A.cgm(pmCls, Memory.allocUtf8String("Add"), 2);
                        if (addMi && !addMi.isNull() && invokeOk(addMi, pm, [makeS(prefix), lrp]).ok)
                            dbg("[v3] providersMap.Add('" + prefix + "') OK");
                        else
                            dbg("[v3] providersMap.Add('" + prefix + "') 失败/已存在");
                    }
                }
            }
        }
        // ② 注册 ActorMetadata — 用基础 CharacterManager (Configuration=CharactersConfiguration, 有 MetadataMap)
        var cm = findSvc("CharacterManager");
        if (!cm)
            cm = findSvc("CharacterManagerExtended");
        if (!cm) {
            dbg("[v3] addCharacterProviders: CharacterManager NOT FOUND");
            return;
        }
        var cfg = null;
        // 扫描候选 Configuration 偏移 (ActorManager.Configuration 在对象内某处)
        var cfgCands = [0x10, 0x18, 0x20, 0x28, 0x30, 0x38, 0x40, 0x48, 0x50, 0x58, 0x60, 0x68, 0x70, 0x78, 0x80];
        for (var ci = 0; ci < cfgCands.length; ci++) {
            try {
                var cand = cm.add(cfgCands[ci]).readPointer();
                if (cand.isNull())
                    continue;
                var gmm = A.cgm(A.ogc(cand), Memory.allocUtf8String("get_MetadataMap"), 0);
                if (gmm && !gmm.isNull()) {
                    cfg = cand;
                    dbg("[v3] Configuration @0x" + cfgCands[ci].toString(16) + " = " + A.cgn(A.ogc(cand)).readCString());
                    break;
                }
            }
            catch (e) { }
        }
        if (!cfg || cfg.isNull()) {
            dbg("[v3] CharacterManager.Configuration 未找到 (get_MetadataMap)");
            return;
        }
        var gmmMi = A.cgm(A.ogc(cfg), Memory.allocUtf8String("get_MetadataMap"), 0);
        var metaMap = invoke(gmmMi, cfg, []);
        if (metaMap.isNull()) {
            dbg("[v3] MetadataMap 为 null");
            return;
        }
        var addRecMi = A.cgm(A.ogc(metaMap), Memory.allocUtf8String("AddRecord"), 2);
        var containsIdMi = A.cgm(A.ogc(metaMap), Memory.allocUtf8String("ContainsId"), 1);
        var metaCls = findClassAcrossImages("Naninovel", "CharacterMetadata");
        var loaderCls = findClassAcrossImages("Naninovel", "ResourceLoaderConfiguration");
        var listStrCls = stealListStringClass(metaMap);
        if (!addRecMi || addRecMi.isNull() || metaCls.isNull() || loaderCls.isNull() || listStrCls.isNull()) {
            dbg("[v3] 立绘注册类解析失败 (AddRecord/meta/loader/List<string>)");
            return;
        }
        var metaCtor = A.cgm(metaCls, Memory.allocUtf8String(".ctor"), 0);
        var loaderCtor = A.cgm(loaderCls, Memory.allocUtf8String(".ctor"), 0);
        var implStr = "Naninovel.SpriteCharacter, Elringus.Naninovel.Runtime, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null"; // 完整 AQN (IL2CPP Type.GetType 需全名)
        var ids = Object.keys(wbData.characters), added = 0;
        for (var i = 0; i < ids.length; i++) {
            var cc = wbData.characters[ids[i]];
            if (cc.key !== prefix)
                continue;
            // 已注册则跳过 (TitleUi 可能多次触发)
            if (containsIdMi && !containsIdMi.isNull()) {
                var cr = invokeOk(containsIdMi, metaMap, [makeS(ids[i])]);
                if (cr.ok && cr.ret && cr.ret.toInt32() === 1)
                    continue;
            }
            try {
                var meta = A.on(metaCls);
                if (metaCtor && !metaCtor.isNull())
                    invokeOk(metaCtor, meta, []);
                // Loader: ResourceLoaderConfiguration{PathPrefix=prefix/Characters, ProviderTypes=[prefix]}
                var loader = A.on(loaderCls);
                if (loaderCtor && !loaderCtor.isNull())
                    invokeOk(loaderCtor, loader, []);
                loader.add(0x10).writePointer(makeS(prefix + "/Characters")); // PathPrefix
                loader.add(0x18).writePointer(makeListString(listStrCls, [prefix])); // ProviderTypes
                meta.add(0x18).writePointer(loader); // Loader
                meta.add(0x10).writePointer(makeS(implStr)); // Implementation
                meta.add(0x30).writeFloat(0.5);
                meta.add(0x34).writeFloat(0.695); // Pivot
                meta.add(0x38).writeFloat(100); // PixelsPerUnit (0 → 立绘不可见)
                // DisplayName @0x78 ('​' 前缀强制用角色名)
                var disp = cc.simple ? pickLocaleText(cc.displayName) : (pickLocaleText(cc.familyName) + pickLocaleText(cc.name));
                if (!disp)
                    disp = ids[i];
                meta.add(0x78).writePointer(makeS("​" + disp));
                // 颜色 (Characters 完整角色才有)
                if (cc.color && !cc.simple) {
                    var rgba = hexColorFloats(cc.color);
                    meta.add(0x80).writeU8(1); // UseCharacterColor
                    for (var f = 0; f < 4; f++)
                        meta.add(0x84 + f * 4).writeFloat(rgba[f]); // NameColor
                    for (var f2 = 0; f2 < 4; f2++)
                        meta.add(0x94 + f2 * 4).writeFloat(1.0); // MessageColor (white)
                }
                if (invokeOk(addRecMi, metaMap, [makeS(ids[i]), meta]).ok)
                    added++;
            }
            catch (e) {
                dbg("[v3] 角色注册 err '" + ids[i] + "': " + e);
            }
        }
        dbg("[v3] addCharacterProviders: 注册 " + added + " 个角色 (mod '" + prefix + "')");
    }
    catch (e) {
        dbg("[v3] addCharacterProviders err: " + e);
    }
}
// "#ffd1d9" → [r,g,b,a] float (Unity Color 顺序)
function hexColorFloats(hex) {
    var h = (hex || "").replace(/^#/, "");
    if (h.length < 6)
        return [1, 1, 1, 1];
    var r = parseInt(h.substr(0, 2), 16) / 255, g = parseInt(h.substr(2, 2), 16) / 255, b = parseInt(h.substr(4, 2), 16) / 255;
    return [r, g, b, 1];
}
// 立绘 provider: ① providersMap.Add(prefix, LRP(Texture2D)) ② CharacterManager 注册 ActorMetadata
var wbAqnLogged = false;
function logSpriteAqn() {
    if (wbAqnLogged)
        return;
    wbAqnLogged = true;
    try {
        var scCls = findClassAcrossImages("Naninovel", "SpriteCharacter");
        if (!scCls || scCls.isNull()) {
            dbg("[v3] SpriteCharacter 类未找到");
            return;
        }
        var typeObj = A.tgo(A.cgt(scCls));
        var typeCls = A.ogc(typeObj);
        var aqnMi = A.cgm(typeCls, Memory.allocUtf8String("get_AssemblyQualifiedName"), 0);
        if (aqnMi && !aqnMi.isNull()) {
            var s = invoke(aqnMi, typeObj, []);
            dbg("[v3] SpriteCharacter AQN = '" + readStr(s) + "'");
        }
        else {
            dbg("[v3] get_AssemblyQualifiedName NOT FOUND, typeCls=" + A.cgn(typeCls).readCString());
        }
    }
    catch (e) {
        dbg("[v3] logSpriteAqn err: " + e);
    }
}
function makeListString(cls, elems) {
    try {
        if (!cls || cls.isNull())
            return ptr(0);
        var list = A.on(cls);
        var ctorMi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 0);
        if (ctorMi && !ctorMi.isNull())
            invokeOk(ctorMi, list, []);
        var addMi = A.cgm(cls, Memory.allocUtf8String("Add"), 1);
        for (var i = 0; i < elems.length; i++)
            if (addMi && !addMi.isNull())
                invokeOk(addMi, list, [makeS(elems[i])]);
        return list;
    }
    catch (e) {
        return ptr(0);
    }
}
// 1.5) 注入 CharacterData._items (新角色基本数据, 供 Profile 显示角色名; 镜像 Windows TryInjectCharacterData)
export function injectCharacterData() {
    try {
        if (Object.keys(wbData.characters).length === 0)
            return;
        if (!wbCls.characterData || wbCls.characterData.isNull()) {
            wblog("CharacterData 类未解析");
            return;
        }
        var inst = findFirstObjectOfType(wbCls.characterData);
        if (!inst) {
            wblog("CharacterData 实例未找到 (可能未加载)");
            return;
        }
        var items = inst.add(fieldOffset(wbCls.characterData, "_items", 0x18)).readPointer();
        if (items.isNull())
            return;
        var listCls = A.ogc(items);
        var addMi = A.cgm(listCls, Memory.allocUtf8String("Add"), 1);
        if (!addMi || addMi.isNull())
            return;
        var itemCls = wbCls.characterDataItem;
        var ctorMi = A.cgm(itemCls, Memory.allocUtf8String(".ctor"), 6);
        var ids = Object.keys(wbData.characters), added = 0;
        for (var i = 0; i < ids.length; i++) {
            var cc = wbData.characters[ids[i]];
            if (cc.key !== wbCurrentMod)
                continue; // 只注入当前 mod 的角色
            if (listContainsId(items, ids[i], 0x10))
                continue; // CharacterDataItem._id @0x10
            var item = A.on(itemCls);
            var nameArr = buildLocalizedTextArray(cc.name);
            var famArr = buildLocalizedTextArray(cc.familyName);
            if (ctorMi && !ctorMi.isNull()) {
                var r = invokeOk(ctorMi, item, [makeS(ids[i]), nameArr, famArr, makeS(cc.age), makeS(cc.height), makeS(cc.weight)]);
                if (!r.ok) {
                    wblog("CharacterDataItem.ctor 失败 '" + ids[i] + "'");
                    continue;
                }
            }
            else {
                item.add(0x10).writePointer(makeS(ids[i]));
                item.add(0x18).writePointer(nameArr);
                item.add(0x20).writePointer(famArr);
                item.add(0x28).writePointer(makeS(cc.age));
                item.add(0x30).writePointer(makeS(cc.height));
                item.add(0x38).writePointer(makeS(cc.weight));
            }
            if (invokeOk(addMi, items, [item]).ok)
                added++;
        }
        if (added)
            wblog("CharacterData 注入 " + added + " 个角色");
    }
    catch (e) {
        wblog("injectCharacterData err: " + e);
    }
}
// ProfilePage.RefreshPageContent onLeave: 覆写 mod 新角色的姓名标签 (_authorLabel @0xB8)
// 镜像 Windows ProfilePageRefreshContent_Patch: 原版对不在角色系统中的 id 显示 ID,
// 我们直接设置 _authorLabel.text = 格式化富文本 (BuildFullName 同款字号/颜色)
export function hookProfileName() {
    try {
        var cls = wbCls.pages.profile;
        if (!cls || cls.isNull())
            return;
        var mi = A.cgm(cls, Memory.allocUtf8String("RefreshPageContent"), 1);
        if (!mi || mi.isNull()) {
            wblog("ProfilePage.RefreshPageContent NOT FOUND");
            return;
        }
        Interceptor.attach(mi.readPointer(), {
            onEnter: function (a) {
                try {
                    this._self = a[0];
                    var map = a[1];
                    this._pid = map ? readStr(map.add(0x10).readPointer()) : null; // VersionedItem._id
                }
                catch (e) {
                    this._pid = null;
                }
            },
            onLeave: function () {
                try {
                    var id = this._pid;
                    if (!id || !wbData.characters[id])
                        return;
                    var cc = wbData.characters[id];
                    if (cc.key !== wbCurrentMod)
                        return;
                    var label = this._self.add(fieldOffset(wbCls.pages.profile, "_authorLabel", 0xB8)).readPointer();
                    if (label.isNull())
                        return;
                    var labCls = A.ogc(label);
                    var setTxt = A.cgm(labCls, Memory.allocUtf8String("set_text"), 1);
                    if (!setTxt || setTxt.isNull())
                        return;
                    var tpl = buildAuthorTemplate(cc, "zh-Hans");
                    if (!tpl)
                        tpl = buildAuthorTemplate(cc, "ja");
                    if (tpl)
                        invokeOk(setTxt, label, [makeS(tpl)]);
                }
                catch (e) { }
            }
        });
        wblog("ProfilePage 姓名覆写 hook 就绪");
    }
    catch (e) {
        wblog("hookProfileName err: " + e);
    }
}
// 生成 AuthorData 模板 (镜像 Windows AuthorTaggedTextGenerator.BuildFullName: 姓首字大号带色 + 名首字次大号)
export function buildAuthorTemplate(cc, localeTag) {
    try {
        var family = resolveLocale(cc.familyName, localeTag) || "";
        var given = resolveLocale(cc.name, localeTag) || "";
        var color = (cc.color || "#ffffff").replace(/^#/, "");
        function part(text, initialSize, bodySize, withColor) {
            if (!text)
                return "";
            var initial = text.charAt(0);
            var body = text.length > 1 ? text.slice(1) : "";
            var s = "";
            if (withColor && color)
                s += "<color=#" + color + ">";
            s += "<size=" + initialSize + ">" + initial + "</size>";
            if (withColor && color)
                s += "</color>";
            if (body)
                s += "<space=4><voffset=-2><size=" + bodySize + ">" + body + "</size></voffset>";
            return s;
        }
        if (family && given)
            return part(family, 136, 73, true) + "<space=4>" + part(given, 118, 75, false);
        if (family)
            return part(family, 136, 73, true);
        if (given)
            return part(given, 118, 75, true);
        return "";
    }
    catch (e) {
        return "";
    }
}
// 1.6) 注入 AuthorData._items (发言人名模板, 供 Profile 显示角色名; 镜像 Windows TryInjectAuthorData)
export function injectAuthorData() {
    try {
        if (Object.keys(wbData.characters).length === 0)
            return;
        if (!wbCls.authorData || wbCls.authorData.isNull()) {
            wblog("AuthorData 类未解析");
            return;
        }
        var inst = findFirstObjectOfType(wbCls.authorData);
        if (!inst) {
            wblog("AuthorData 实例未找到 (可能未加载)");
            return;
        }
        var items = inst.add(fieldOffset(wbCls.authorData, "_items", 0x18)).readPointer();
        if (items.isNull())
            return;
        var listCls = A.ogc(items);
        var addMi = A.cgm(listCls, Memory.allocUtf8String("Add"), 1);
        if (!addMi || addMi.isNull())
            return;
        var itemCls = wbCls.authorDataItem;
        var ctorMi = A.cgm(itemCls, Memory.allocUtf8String(".ctor"), 2);
        var ltsCtor = A.cgm(wbCls.localizedText, Memory.allocUtf8String(".ctor"), 2);
        var ids = Object.keys(wbData.characters), added = 0;
        for (var i = 0; i < ids.length; i++) {
            var cc = wbData.characters[ids[i]];
            if (cc.key !== wbCurrentMod)
                continue;
            if (listContainsId(items, ids[i], 0x10))
                continue; // AuthorDataItem._id @0x10
            var tags = unionLocaleKeys(cc.name, cc.familyName);
            var arr = A.an(wbCls.localizedText, tags.length);
            for (var t = 0; t < tags.length; t++) {
                var lt = A.on(wbCls.localizedText);
                var lv = Memory.alloc(4);
                lv.writeS32(localeValue(tags[t]));
                if (ltsCtor && !ltsCtor.isNull())
                    invokeOk(ltsCtor, lt, [lv, makeS(buildAuthorTemplate(cc, tags[t]))]);
                arr.add(0x20 + t * 8).writePointer(lt);
            }
            var item = A.on(itemCls);
            if (ctorMi && !ctorMi.isNull()) {
                if (!invokeOk(ctorMi, item, [makeS(ids[i]), arr]).ok) {
                    wblog("AuthorDataItem.ctor 失败 '" + ids[i] + "'");
                    continue;
                }
            }
            else {
                item.add(0x10).writePointer(makeS(ids[i]));
                item.add(0x18).writePointer(arr);
            }
            if (invokeOk(addMi, items, [item]).ok)
                added++;
        }
        if (added)
            wblog("AuthorData 注入 " + added + " 个角色模板");
    }
    catch (e) {
        wblog("injectAuthorData err: " + e);
    }
}

✄
// ============ WitchBook 数据域: 分类表 / 数据加载 / 版本项构建 / 本地化工具 ============
import { A, dbg, fieldOffset, findClassAcrossImages, getGenericArgClass, invokeOk, makeS, wblog } from "../utils.js";
import { fileExists, readJSONFile } from "../io.js";
import { setWbReady, wbData, wbCurrentMod, wbReady, wbCls } from "./state.js";
import { registerLocalizedDict } from "./pages.js";
export var wbCats = {
    clue: { name: "clue", idx: 0, field: "Clues", page: "CluePage", data: "ClueData", item: "ClueDataItem", texDir: "Clues", locOff: 0xD0, locKind: "lts",
        addr: function (id) { return buildClueTextureAddress(id); },
        parseItem: function (it) { return { name: it.Name || {}, desc: it.Description || {} }; } },
    profile: { name: "profile", idx: 1, field: "Profiles", page: "ProfilePage", data: "ProfileData", item: "ProfileDataItem", texDir: "Profiles", locOff: 0xE8, locKind: "str",
        addr: function (id) { return buildProfileTextureAddress(id); },
        parseItem: function (it) { return { desc: it.Description || {} }; } },
    rule: { name: "rule", idx: 3, field: "Rules", page: "RulePage", data: "RuleData", item: "RuleDataItem", texDir: null, locOff: 0xE8, locKind: "lts",
        addr: null,
        parseItem: function (it) { return { numbering: (it.Numbering || ""), subtitle: it.Subtitle || {}, desc: it.Description || {} }; } },
    note: { name: "note", idx: 4, field: "Notes", page: "NotePage", data: "NoteData", item: "NoteDataItem", texDir: null, locOff: 0xC8, locKind: "lts",
        addr: null,
        parseItem: function (it) { return { title: it.Title || {}, desc: it.Description || {} }; } }
};
export function wbCatByIdx(idx) {
    var names = Object.keys(wbCats);
    for (var i = 0; i < names.length; i++)
        if (wbCats[names[i]].idx === idx)
            return wbCats[names[i]];
    return null;
}
export function wbCatByName(nm) { return wbCats[nm]; }
// 当前 mod 某分类的 id 列表 (无 mod 时不注入)
export function currentModIds(cat) {
    if (!wbCurrentMod || wbCurrentMod === "__vanilla__")
        return [];
    var out = [], keys = Object.keys(wbData[cat.name]);
    for (var i = 0; i < keys.length; i++)
        if (wbData[cat.name][keys[i]].key === wbCurrentMod)
            out.push(keys[i]);
    return out;
}
export function isCurrentModItem(cat, id) { return !!wbCurrentMod && wbData[cat.name][id] && wbData[cat.name][id].key === wbCurrentMod; }
export function currentModSet(cat) {
    var cur = currentModIds(cat), set = {};
    cur.forEach(function (id) { set[id] = 1; });
    return set;
}
// 加载所有 mod 的 Clues/Profiles/Rules/Notes + Characters 数据 (info.json) + 纹理路径
export function loadWitchBookData() {
    if (wbReady || typeof modList === "undefined" || !modList)
        return;
    var root = (typeof MOD_ROOT !== "undefined") ? MOD_ROOT : "";
    wblog("MOD_ROOT=" + root + ", modList=" + modList.length + " 个");
    for (var mi = 0; mi < modList.length; mi++) {
        var key = modList[mi].key;
        var info = readJSONFile(root + "/" + key + "/info.json");
        if (!info) {
            wblog("  " + key + ": info.json 读取/解析失败");
            continue;
        }
        // 角色数据 (Profile 关联 + 立绘注册: Characters 完整角色 / SimpleCharacters 简单角色)
        if (info.Characters) {
            for (var ch = 0; ch < info.Characters.length; ch++) {
                var cc = info.Characters[ch];
                if (!cc.Id || wbData.characters[cc.Id])
                    continue;
                wbData.characters[cc.Id] = { key: key, name: cc.Name || {}, familyName: cc.FamilyName || {}, color: cc.Color || "", age: cc.Age || "", height: cc.Height || "", weight: cc.Weight || "" };
            }
        }
        if (info.SimpleCharacters) {
            for (var sc = 0; sc < info.SimpleCharacters.length; sc++) {
                var scc = info.SimpleCharacters[sc];
                if (!scc.Id || wbData.characters[scc.Id])
                    continue;
                wbData.characters[scc.Id] = { key: key, name: {}, familyName: {}, color: "", age: "", height: "", weight: "", simple: true, displayName: scc.DisplayName || {} };
            }
        }
        // 各分类
        var catNames = Object.keys(wbCats);
        for (var cn = 0; cn < catNames.length; cn++) {
            var cat = wbCats[catNames[cn]];
            if (!cat || !cat.name) {
                wblog("  cat 配置异常: key=" + catNames[cn]);
                continue;
            }
            if (!wbData[cat.name]) {
                wblog("  wbData 缺分类 '" + cat.name + "', wbData 键=" + Object.keys(wbData).join(","));
                return;
            }
            var groups = info[cat.field];
            if (!groups)
                continue;
            var texDir = cat.texDir ? (root + "/" + key + "/WitchBook/" + cat.texDir) : null;
            for (var g = 0; g < groups.length; g++) {
                var grp = groups[g];
                if (!grp.Id || !grp.Items || !grp.Items.length)
                    continue;
                if (wbData[cat.name][grp.Id]) {
                    wblog("重复 " + cat.name + " ID '" + grp.Id + "' 跳过 (首个 mod 优先)");
                    continue;
                }
                var rec = { key: key, versions: {}, path: null };
                for (var v = 0; v < grp.Items.length; v++) {
                    var it = grp.Items[v];
                    rec.versions[String(it.Version)] = cat.parseItem(it);
                }
                if (texDir) {
                    var tp = texDir + "/" + grp.Id + ".png";
                    try {
                        if (fileExists(tp))
                            rec.path = tp;
                    }
                    catch (e) { }
                    if (!rec.path) {
                        try {
                            var tp2 = texDir + "/" + grp.Id + ".jpg";
                            if (fileExists(tp2))
                                rec.path = tp2;
                        }
                        catch (e) { }
                    }
                    if (rec.path)
                        wbData.texPaths[grp.Id] = rec.path;
                }
                wbData[cat.name][grp.Id] = rec;
            }
        }
    }
    setWbReady(true);
    var summary = [];
    var cn2 = Object.keys(wbCats);
    for (var i = 0; i < cn2.length; i++)
        summary.push(wbCats[cn2[i]].name + "=" + Object.keys(wbData[wbCats[cn2[i]].name]).length);
    wblog("数据加载: " + summary.join(", ") + ", 角色=" + Object.keys(wbData.characters).length + ", 图片=" + Object.keys(wbData.texPaths).length);
}
// 镜像 WitchBookDataHelper.BuildClueTextureAddress: '1-1' → General/WitchBook/Clue_..._001
export function buildClueTextureAddress(id) {
    var parts = id.split("-"), out = "General/WitchBook/Clue";
    for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        while (p.length < 3)
            p = "0" + p;
        out += "_" + p;
    }
    return out;
}
// 镜像 WitchBookDataHelper.BuildProfileTextureAddress: → General/WitchBook/Profile_<id 原样>
export function buildProfileTextureAddress(id) {
    return "General/WitchBook/Profile_" + id;
}
export function localeValue(tag) {
    switch (tag) {
        case "ja": return 0;
        case "en-US": return 1;
        case "zh-Hans": return 2;
        case "zh-Hant": return 3;
        case "ko": return 4;
        case "fr": return 5;
        case "es": return 6;
    }
    return 2;
}
export function resolveLocale(locObj, tag) { return locObj && locObj[tag] ? locObj[tag] : ""; }
export function unionLocaleKeys(a, b) {
    var seen = {};
    (a ? Object.keys(a) : []).concat(b ? Object.keys(b) : []).forEach(function (k) { seen[k] = 1; });
    return Object.keys(seen);
}
// 取语言对象的最佳文本 (优先 zh-Hans → ja → 任意)
export function pickLocaleText(locObj) {
    if (!locObj)
        return "";
    if (locObj["zh-Hans"])
        return locObj["zh-Hans"];
    if (locObj["ja"])
        return locObj["ja"];
    var keys = Object.keys(locObj);
    return keys.length ? locObj[keys[0]] : "";
}
// 构建 LocalizedText[] (每个语言一条)
export function buildLocalizedTextArray(locObj) {
    try {
        if (!locObj)
            locObj = {};
        var tags = Object.keys(locObj);
        if (!tags.length) {
            locObj = { "zh-Hans": "" };
            tags = ["zh-Hans"];
        }
        var arr = A.an(wbCls.localizedText, tags.length);
        if (!arr || arr.isNull()) {
            wblog("LocalizedText[] 创建失败");
            return ptr(0);
        }
        var ctorMi = A.cgm(wbCls.localizedText, Memory.allocUtf8String(".ctor"), 2);
        for (var i = 0; i < tags.length; i++) {
            var lt = A.on(wbCls.localizedText);
            var lv = Memory.alloc(4);
            lv.writeS32(localeValue(tags[i]));
            var text = (locObj[tags[i]] || "");
            if (ctorMi && !ctorMi.isNull())
                invokeOk(ctorMi, lt, [lv, makeS(text)]);
            arr.add(0x20 + i * Process.pointerSize).writePointer(lt);
        }
        return arr;
    }
    catch (e) {
        wblog("buildLocalizedTextArray err: " + e);
        return ptr(0);
    }
}
// 构建 IdVersionPair (作为 _localizedTextData 的键, 与 VersionedItem._idVersionPair 同一实例)
export function makeIdVersionPair(id, ver) {
    var ivp = A.on(wbCls.idVersionPair);
    var ctorMi = A.cgm(wbCls.idVersionPair, Memory.allocUtf8String(".ctor"), 2);
    var vbuf = Memory.alloc(4);
    vbuf.writeS32(ver);
    if (ctorMi && !ctorMi.isNull())
        invokeOk(ctorMi, ivp, [makeS(id), vbuf]);
    return ivp;
}
// 构建 VersionedItem<TItem> — 按分类构造对应数据项 (object_new + 写字段, 绕开泛型 ctor)
// 返回 { vi, ivp }; ivp 用于 _localizedTextData 键匹配 (get_IdVersionPair 缓存命中)
export function buildVersionedItemFor(cat, vItemCls, id, ver, rec) {
    try {
        var vrec = rec.versions[String(ver)];
        if (!vrec)
            vrec = rec.versions[Object.keys(rec.versions)[0]];
        var itemCls = wbCls.items[cat.name];
        var item = A.on(itemCls);
        if (cat.name === "clue") {
            var nameArr = buildLocalizedTextArray(vrec.name);
            var descArr = buildLocalizedTextArray(vrec.desc);
            var mi = A.cgm(itemCls, Memory.allocUtf8String(".ctor"), 2);
            if (mi && !mi.isNull())
                invokeOk(mi, item, [nameArr, descArr]);
            else {
                item.add(0x10).writePointer(nameArr);
                item.add(0x18).writePointer(descArr);
            }
        }
        else if (cat.name === "profile") {
            var descArr2 = buildLocalizedTextArray(vrec.desc);
            var mi2 = A.cgm(itemCls, Memory.allocUtf8String(".ctor"), 1);
            if (mi2 && !mi2.isNull())
                invokeOk(mi2, item, [descArr2]);
            else
                item.add(0x10).writePointer(descArr2);
        }
        else if (cat.name === "rule") {
            var numS = makeS(vrec.numbering || "");
            var subArr = buildLocalizedTextArray(vrec.subtitle);
            var descArr3 = buildLocalizedTextArray(vrec.desc);
            var mi3 = A.cgm(itemCls, Memory.allocUtf8String(".ctor"), 3);
            if (mi3 && !mi3.isNull())
                invokeOk(mi3, item, [numS, subArr, descArr3]);
            else {
                item.add(0x10).writePointer(numS);
                item.add(0x18).writePointer(subArr);
                item.add(0x20).writePointer(descArr3);
            }
        }
        else if (cat.name === "note") {
            var titleArr = buildLocalizedTextArray(vrec.title);
            var descArr4 = buildLocalizedTextArray(vrec.desc);
            var mi4 = A.cgm(itemCls, Memory.allocUtf8String(".ctor"), 2);
            if (mi4 && !mi4.isNull())
                invokeOk(mi4, item, [titleArr, descArr4]);
            else {
                item.add(0x10).writePointer(titleArr);
                item.add(0x18).writePointer(descArr4);
            }
        }
        var vi = A.on(vItemCls);
        vi.add(fieldOffset(vItemCls, "_id", 0x10)).writePointer(makeS(id));
        vi.add(fieldOffset(vItemCls, "_version", 0x18)).writeS32(ver);
        vi.add(fieldOffset(vItemCls, "_item", 0x20)).writePointer(item);
        var ivp = makeIdVersionPair(id, ver);
        vi.add(fieldOffset(vItemCls, "_idVersionPair", 0x28)).writePointer(ivp);
        return { vi: vi, ivp: ivp, id: id, ver: ver, cat: cat };
    }
    catch (e) {
        wblog("buildVersionedItemFor err '" + id + "': " + e);
        return null;
    }
}
// 向 List<VersionedItem<...>> 注入某分类某条目的所有版本; page 给定则预填 _localizedTextData
export function injectVersions(list, addMi, vItemCls, cat, id, rec, page) {
    var keys = Object.keys(rec.versions), added = 0;
    for (var i = 0; i < keys.length; i++) {
        var b = buildVersionedItemFor(cat, vItemCls, id, parseInt(keys[i], 10), rec);
        if (!b || !b.vi || b.vi.isNull())
            continue;
        if (!invokeOk(addMi, list, [b.vi]).ok) {
            wblog("List.Add 失败 '" + id + " v" + keys[i] + "'");
            continue;
        }
        added++;
        if (page)
            registerLocalizedDict(page, b);
    }
    return added;
}

✄
// ============ WitchBook 组装域: 类解析 / hook 挂载 / 注入编排 ============
// 链路: @update 命令 → IWitchBookUi.UpdateVersion → WitchBookScreen.UpdateVersion → CluePage.UpdateVersion
//   → _state.SetVersion。原版对 _itemIds 之外的 id 不处理, 且 _loadedDataItemMap/_localizedTextData
//   无 mod 数据 → UI 不显示, RefreshPageContent 查 _localizedTextData 还会 KeyNotFoundException。
// 修法 (与 Windows 一致的三板斧):
//   1. 数据注入: 拦截 @update + WitchBook 打开(BeginToPresent/InitializePages) →
//      向 ClueData._items 和 CluePage._loadedDataItemMap 注入 VersionedItem, 向 _itemIds 追加 ID,
//      _state.SetVersion 设状态 (幂等, 按实例指针追踪)。
//   2. 纹理: 加载 WitchBook/Clues/<Id>.png → Texture2D → 注册进 AddressablesManager._loadedAssets,
//      原版 Addressables 加载 (缩略图 + @spawn ClueItem) 直接命中。
//   3. 显示: Interceptor.replace CluePage.RefreshPageContent / SetupItemButton —— mod 线索直接设
//      _subjectLabel/_descriptionLabel/_thumbnail (绕开 _localizedTextData 的 KeyNotFoundException)。
// 数据来源: 运行时读 <MOD_ROOT>/<modKey>/info.json 的 Clues 字段 + 扫 WitchBook/Clues/*.png。
import { A, dbg, fieldOffset, findClassAcrossImages, findNestedClass, invokeOk, makeS, readStr, wblog } from "../utils.js";
import { initCatStateMaps, setWbCls, setWbPrevMod, wbCls, wbCurrentMod, wbData } from "./state.js";
import { isCurrentModItem, loadWitchBookData, wbCatByIdx, wbCats } from "./data.js";
import { clearAllWitchBookPages, clearBookViaVanilla, detectCurrentMod, findAllPages, rebuildAllPages } from "./session.js";
import { injectPage } from "./pages.js";
import { registerTexturesInto } from "./textures.js";
import { hookProfileName } from "./characters.js";
export function resolveWitchBookClasses() {
    var m = {};
    m.pages = {};
    m.datas = {};
    m.items = {};
    m.lts = {};
    var catNames = Object.keys(wbCats);
    for (var i = 0; i < catNames.length; i++) {
        var cat = wbCats[catNames[i]];
        var pageCls = findClassAcrossImages("WitchTrials.Views", cat.page);
        m.pages[cat.name] = pageCls;
        m.datas[cat.name] = findClassAcrossImages("WitchTrials.Models", cat.data);
        m.items[cat.name] = findClassAcrossImages("WitchTrials.Models", cat.item);
        m.lts[cat.name] = (cat.name === "profile") ? ptr(0) : findNestedClass(pageCls, "LocalizedTexts");
    }
    m.idVersionPair = findClassAcrossImages("WitchTrials.Models", "IdVersionPair");
    m.versionedState = findClassAcrossImages("WitchTrials.Models", "VersionedState");
    m.localizedText = findClassAcrossImages("GigaCreation.Essentials.Localization", "LocalizedText");
    m.witchBookScreen = findClassAcrossImages("WitchTrials.Views", "WitchBookScreen");
    m.witchBookUi = findClassAcrossImages("WitchTrials.Views", "WitchBookUi");
    m.witchBookItemThumbnail = findClassAcrossImages("WitchTrials.Views", "WitchBookItemThumbnail");
    m.witchBookItemSubjectLabel = findClassAcrossImages("WitchTrials.Views", "WitchBookItemSubjectLabel");
    m.witchBookItemButton = findClassAcrossImages("WitchTrials.Views", "WitchBookItemButton");
    m.spawnableClue = findClassAcrossImages("WitchTrials.Views", "SpawnableClue");
    m.texture2d = findClassAcrossImages("UnityEngine", "Texture2D");
    m.imageConversion = findClassAcrossImages("UnityEngine", "ImageConversion");
    m.characterData = findClassAcrossImages("WitchTrials.Models", "CharacterData");
    m.characterDataItem = findClassAcrossImages("WitchTrials.Models", "CharacterDataItem");
    m.authorData = findClassAcrossImages("WitchTrials.Models", "AuthorData");
    m.authorDataItem = findClassAcrossImages("WitchTrials.Models", "AuthorDataItem");
    return m;
}
export function setupWitchBookHooks() {
    try {
        loadWitchBookData();
        var total = 0, catNames = Object.keys(wbCats);
        for (var i = 0; i < catNames.length; i++)
            total += Object.keys(wbData[wbCats[catNames[i]].name]).length;
        if (total === 0) {
            wblog("无 mod WitchBook 数据, 跳过");
            return;
        }
        setWbCls(resolveWitchBookClasses());
        if (!wbCls.pages.clue || wbCls.pages.clue.isNull() ||
            !wbCls.witchBookScreen || wbCls.witchBookScreen.isNull() || !wbCls.versionedState || wbCls.versionedState.isNull()) {
            wblog("类解析失败 (pages/screen/versionedState)");
            return;
        }
        // @update 入口
        ["WitchBookUi", "WitchBookScreen"].forEach(function (cn) {
            try {
                var cls = wbCls[cn === "WitchBookUi" ? "witchBookUi" : "witchBookScreen"];
                if (!cls || cls.isNull())
                    return;
                var uvMi = A.cgm(cls, Memory.allocUtf8String("UpdateVersion"), 3);
                if (uvMi && !uvMi.isNull())
                    Interceptor.attach(uvMi.readPointer(), { onEnter: onWitchBookUpdate });
            }
            catch (e) { }
        });
        // Profile 姓名覆写 (mod 新角色显示格式化名字而非 ID)
        hookProfileName();
        // WitchBook 打开/翻页重建 → 强制重注入
        ["BeginToPresent", "InitializePages"].forEach(function (mn) {
            try {
                var mi = A.cgm(wbCls.witchBookScreen, Memory.allocUtf8String(mn), 0);
                if (mi && !mi.isNull())
                    Interceptor.attach(mi.readPointer(), { onEnter: function () {
                            wblog(">>> WitchBook " + mn + " 触发");
                            tryInjectWitchBook(); // 内部处理 mod 切换清理 (状态+面板) + 注入
                        } });
            }
            catch (e) { }
        });
        // @spawn "Clue" → SpawnableClue.SetSpawnParameters 后注册纹理 (spawn 可能早于图鉴打开)
        try {
            var ssMi = A.cgm(wbCls.spawnableClue, Memory.allocUtf8String("SetSpawnParameters"), 2);
            if (ssMi && !ssMi.isNull()) {
                Interceptor.attach(ssMi.readPointer(), {
                    onEnter: function (a) { this._self = a[0]; },
                    onLeave: function () {
                        try {
                            var cid = readStr(this._self.add(0x80).readPointer()); // _clueId @0x80
                            if (cid && wbData.clue[cid]) {
                                wblog(">>> SpawnableClue mod 线索: '" + cid + "', 注册纹理");
                                registerTexturesInto(null); // 用全局 AddressablesManager
                            }
                        }
                        catch (e) { }
                    }
                });
            }
        }
        catch (e) { }
        // 剧本加载 → 识别当前 mod (匹配 Enter 路径), 用于按 mod 注入线索
        try {
            var slCls2 = findClassAcrossImages("Naninovel", "ScriptLoader");
            if (slCls2 && !slCls2.isNull()) {
                var loadMi3 = A.cgm(slCls2, Memory.allocUtf8String("Load"), 2);
                if (loadMi3 && !loadMi3.isNull()) {
                    Interceptor.attach(loadMi3.readPointer(), { onEnter: function (a) {
                            try {
                                detectCurrentMod(readStr(a[1]));
                            }
                            catch (e) { }
                        } });
                }
            }
        }
        catch (e) { }
        wblog("hooks 就绪");
    }
    catch (e) {
        wblog("setupWitchBookHooks err: " + e + " | " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : ""));
    }
}
export function tryInjectWitchBook() {
    try {
        // mod 切换检测: 换剧本/回标题后重新开始 → 整页重建回原版基座 + 重置状态
        if (wbCurrentMod !== wbPrevMod) {
            rebuildAllPages(); // 整页重建: 清 map, 从 Data 重添全部原版条目
            clearBookViaVanilla(); // 重置状态 + 当前选中项 (清残留显示)
            clearAllWitchBookPages(); // 清各页面状态 + 恢复原版默认面板
            wbData.states = {};
            wbData.pendingStates = {};
            initCatStateMaps();
            setWbPrevMod(wbCurrentMod);
            wblog("mod 切换 → 整页重建 + 状态重置, 注入范围: " + (wbCurrentMod ? "'" + wbCurrentMod + "'" : "无"));
        }
        initCatStateMaps();
        // 注入所有分类 (只注入页面, 不注入 Data._items —— Data 是缓存的 ScriptableObject,
        // 注入会跨会话残留: 页面 LoadDataAsync 从 Data 重建 map 时把上次的 mod 条目带回来
        // → listContains=true → 跳过注入 → 无预填 → KeyNotFound。页面注入每次重新做, 自愈。)
        var cn2 = Object.keys(wbCats);
        for (var i = 0; i < cn2.length; i++) {
            injectPage(wbCats[cn2[i]]);
        }
        // 新角色 (Profile 显示名: CharacterData 基本数据 + AuthorData 名称模板)
        // injectCharacterData();   // 临时禁用: 角色档案数据注入可能破坏场景 (5 个 ArgumentException)
        // injectAuthorData();
        // 纹理 (全局 manager + 页面 loader)
        registerTexturesInto(null);
        var pages2 = findAllPages();
        if (pages2.length)
            registerTexturesInto(pages2[0].add(fieldOffset(A.ogc(pages2[0]), "_addressableAssetLoader", 0x50)).readPointer());
    }
    catch (e) {
        wblog("tryInjectWitchBook err: " + e);
    }
}
// @update 拦截: 按 WitchBookCategory 路由 (Clue=0 Profile=1 Map=2 Rule=3 Note=4)
export function onWitchBookUpdate(args) {
    try {
        var idx = args[1].toInt32(), id = readStr(args[2]), ver = args[3].toInt32();
        var cat = wbCatByIdx(idx);
        if (!cat || idx === 2)
            return; // Map 分类暂不处理
        if (!id || !isCurrentModItem(cat, id)) {
            wblog(">>> @update 忽略: category=" + (cat ? cat.name : idx) + " id='" + id + "' (非当前 mod 条目)");
            return;
        }
        if (!wbData.states[cat.name])
            wbData.states[cat.name] = {};
        if (wbData.states[cat.name][id] === ver)
            return;
        wbData.states[cat.name][id] = ver;
        wblog(">>> @update 拦截: category=" + cat.name + " id='" + id + "' version=" + ver);
        tryInjectWitchBook();
    }
    catch (e) {
        wblog("onWitchBookUpdate err: " + e);
    }
}

✄
// ============ WitchBook 页面注入域: 注入 Page._loadedDataItemMap + _itemIds + _state + 本地化字典预填 ============
import { A, fieldOffset, findAllObjectOfType, getGenericArgClass, getSystemClass, invokeOk, listContainsId, makeS, readStr, wblog } from "../utils.js";
import { wbCls, wbData, wbOverrides } from "./state.js";
import { currentModIds, injectVersions, localeValue, resolveLocale, unionLocaleKeys } from "./data.js";
import { clearModItemsFromPage, isVanillaId } from "./session.js";
// 2) 注入 Page._loadedDataItemMap + _itemIds + _state
export function injectPage(cat) {
    try {
        var pageCls = wbCls.pages[cat.name];
        var pages = findAllObjectOfType(pageCls);
        if (!pages.length) {
            var st = Object.keys(wbData.states[cat.name] || {});
            for (var i = 0; i < st.length; i++)
                wbData.pendingStates[cat.name][st[i]] = wbData.states[cat.name][st[i]];
            return false;
        }
        var page = pages[0];
        var mapOff = fieldOffset(pageCls, "_loadedDataItemMap", 0x88);
        var mapList = page.add(mapOff).readPointer();
        if (!mapList.isNull()) {
            var listCls = A.ogc(mapList);
            var vItemCls = getGenericArgClass(listCls, 0);
            var addMi = A.cgm(listCls, Memory.allocUtf8String("Add"), 1);
            if (!vItemCls.isNull() && addMi && !addMi.isNull()) {
                var idOff2 = fieldOffset(vItemCls, "_id", 0x10);
                var ids = currentModIds(cat), added = 0;
                for (var i = 0; i < ids.length; i++) {
                    var id = ids[i];
                    // override: mod 定义的原版同 id → 移除原版条目再注入 mod 版 (镜像 Windows)
                    if (isVanillaId(cat, id)) {
                        var oSet = {};
                        oSet[id] = 1;
                        clearModItemsFromPage(page, pageCls, oSet);
                        wbOverrides[cat.name][id] = true;
                        wblog(cat.name + " override '" + id + "' → 移除原版, 注入 mod 版");
                    }
                    if (listContainsId(mapList, id, idOff2))
                        continue;
                    added += injectVersions(mapList, addMi, vItemCls, cat, id, wbData[cat.name][id], page);
                }
                if (added > 0)
                    wblog(cat.name + "Page._loadedDataItemMap 注入 " + added + " 条 (total=" + mapList.add(0x18).readS32() + ")");
            }
        }
        appendItemIds(page, cat);
        applyStates(page, cat);
        return true;
    }
    catch (e) {
        wblog("injectPage err(" + cat.name + "): " + e);
        return false;
    }
}
// 向 _itemIds (string[]) 追加纯新 mod ID (原版 UpdateVersion 检查 Contains)
export function appendItemIds(page, cat) {
    try {
        var pageCls = wbCls.pages[cat.name];
        var idsField = fieldOffset(pageCls, "_itemIds", 0x98);
        var old = page.add(idsField).readPointer();
        var newIds = [];
        if (!old.isNull()) {
            var oldLen = old.add(0x18).readS32();
            for (var i = 0; i < oldLen; i++) {
                var s = readStr(old.add(0x20 + i * 8).readPointer());
                if (s)
                    newIds.push(s);
            }
        }
        var keys = currentModIds(cat), appended = 0;
        for (var i = 0; i < keys.length; i++) {
            if (newIds.indexOf(keys[i]) === -1) {
                newIds.push(keys[i]);
                appended++;
            }
        }
        if (!appended)
            return;
        var strCls = getSystemClass("String");
        var arr = A.an(strCls, newIds.length);
        for (var i = 0; i < newIds.length; i++)
            arr.add(0x20 + i * 8).writePointer(makeS(newIds[i]));
        page.add(idsField).writePointer(arr);
        wblog(cat.name + "Page._itemIds: +" + appended + " 纯新 ID, 共 " + newIds.length);
    }
    catch (e) {
        wblog("appendItemIds err: " + e);
    }
}
// 3) 状态: _state.SetVersion (各 State 都是 VersionedState 子类, 同步方法可 runtime_invoke)
export function applyStates(page, cat) {
    try {
        var pageCls = wbCls.pages[cat.name];
        var stateOff = fieldOffset(pageCls, "_state", 0x48);
        var state = page.add(stateOff).readPointer();
        if (state.isNull())
            return;
        var setMi = A.cgm(wbCls.versionedState, Memory.allocUtf8String("SetVersion"), 2);
        if (!setMi || setMi.isNull())
            return;
        var stMap = wbData.states[cat.name] || {};
        var ids = Object.keys(stMap), applied = 0;
        for (var i = 0; i < ids.length; i++) {
            var vbuf = Memory.alloc(4);
            vbuf.writeS32(stMap[ids[i]]);
            if (invokeOk(setMi, state, [makeS(ids[i]), vbuf]).ok)
                applied++;
        }
        var pend = wbData.pendingStates[cat.name] || {};
        var pkeys = Object.keys(pend);
        for (var i = 0; i < pkeys.length; i++) {
            var vbuf2 = Memory.alloc(4);
            vbuf2.writeS32(pend[pkeys[i]]);
            if (invokeOk(setMi, state, [makeS(pkeys[i]), vbuf2]).ok) {
                applied++;
                stMap[pkeys[i]] = pend[pkeys[i]];
            }
        }
        wbData.pendingStates[cat.name] = {};
        wblog(cat.name + "Page 状态应用 " + applied + " 条");
    }
    catch (e) {
        wblog("applyStates err: " + e);
    }
}
// 显示层: 预填 CluePage._localizedTextData (IReadOnlyDictionary<IdVersionPair, IReadOnlyDictionary<LocaleKind, LocalizedTexts>>)
// 键用与 VersionedItem._idVersionPair 同一 IdVersionPair 实例 → 原版 RefreshPageContent/SetupItemButton
// 查 _localizedTextData[map.IdVersionPair] 命中, 不再 KeyNotFoundException。
export function getFirstDictValue(dict) {
    try {
        var ents = dict.add(0x18).readPointer();
        if (ents.isNull())
            return null;
        var cnt = ents.add(0x18).readS32();
        for (var i = 0; i < cnt; i++) {
            try {
                var v = ents.add(0x20 + i * 24 + 16).readPointer();
                if (v && !v.isNull())
                    return v;
            }
            catch (e) { }
        }
    }
    catch (e) { }
    return null;
}
export function registerLocalizedDict(page, b) {
    var cat = b.cat;
    var pageCls = wbCls.pages[cat.name];
    try {
        var dictField = fieldOffset(pageCls, "_localizedTextData", cat.locOff);
        var outer = page.add(dictField).readPointer();
        if (outer.isNull()) {
            wblog(cat.name + "._localizedTextData 为 null, 跳过 '" + b.id + "'");
            return;
        }
        var outerCls = A.ogc(outer);
        // 从现有值偷内层字典的具体实现类 (不能用泛型参数: 那是 IReadOnlyDictionary 接口, object_new 会崩)
        var sample = getFirstDictValue(outer);
        if (!sample) {
            wblog(cat.name + "._localizedTextData 无现有值, 跳过 '" + b.id + "'");
            return;
        }
        var innerCls = A.ogc(sample);
        var innerName = A.cgn(innerCls).readCString();
        var addInner = A.cgm(innerCls, Memory.allocUtf8String("Add"), 2);
        if (!addInner || addInner.isNull()) {
            wblog("内层字典无 Add (" + innerName + "), 跳过 '" + b.id + "'");
            return;
        }
        var vrec = wbData[cat.name][b.id].versions[String(b.ver)];
        if (!vrec)
            return;
        var inner = A.on(innerCls);
        if (!invokeOk(A.cgm(innerCls, Memory.allocUtf8String(".ctor"), 0), inner, []).ok) {
            wblog("内层字典 ctor 失败 '" + b.id + "'");
            return;
        }
        if (cat.locKind === "str") {
            // Profile: Dictionary<LocaleKind, string> — 值 = 描述字符串
            var descTags = unionLocaleKeys(vrec.desc);
            for (var t2 = 0; t2 < descTags.length; t2++) {
                var lv2 = Memory.alloc(4);
                lv2.writeS32(localeValue(descTags[t2]));
                invokeOk(addInner, inner, [lv2, makeS(resolveLocale(vrec.desc, descTags[t2]))]);
            }
        }
        else {
            // Clue/Rule/Note: Dictionary<LocaleKind, Xxx.LocalizedTexts> — 值 = 二元组
            var ltsCls = wbCls.lts[cat.name];
            if (!ltsCls || ltsCls.isNull()) {
                try {
                    var ifaceCls = getGenericArgClass(outerCls, 1);
                    if (!ifaceCls.isNull())
                        ltsCls = getGenericArgClass(ifaceCls, 1);
                }
                catch (e) { }
            }
            var ltsCtor = (ltsCls && !ltsCls.isNull()) ? A.cgm(ltsCls, Memory.allocUtf8String(".ctor"), 2) : null;
            if (!ltsCls || ltsCls.isNull() || !ltsCtor || ltsCtor.isNull()) {
                wblog(cat.name + ".LocalizedTexts 类/ctor 未找到, 跳过 '" + b.id + "'");
                return;
            }
            var f1 = null, f2 = null;
            if (cat.name === "clue") {
                f1 = vrec.name;
                f2 = vrec.desc;
            } // (Name, Description)
            else if (cat.name === "rule") {
                f1 = vrec.subtitle;
                f2 = vrec.desc;
            } // (Subtitle, Description)
            else if (cat.name === "note") {
                f1 = vrec.title;
                f2 = vrec.desc;
            } // (Title, Description)
            var tags = unionLocaleKeys(f1, f2);
            for (var t = 0; t < tags.length; t++) {
                var lts = A.on(ltsCls);
                var lv = Memory.alloc(4);
                lv.writeS32(localeValue(tags[t]));
                invokeOk(ltsCtor, lts, [makeS(resolveLocale(f1, tags[t])), makeS(resolveLocale(f2, tags[t]))]);
                invokeOk(addInner, inner, [lv, lts]);
            }
        }
        var addOuter = A.cgm(outerCls, Memory.allocUtf8String("Add"), 2);
        if (addOuter && !addOuter.isNull())
            invokeOk(addOuter, outer, [b.ivp, inner]);
        // Rule 额外: _numberings 字典 (IdVersionPair → string)
        if (cat.name === "rule") {
            try {
                var numField = fieldOffset(pageCls, "_numberings", 0xE0);
                var numDict = page.add(numField).readPointer();
                if (!numDict.isNull()) {
                    var numCls = A.ogc(numDict);
                    var addNum = A.cgm(numCls, Memory.allocUtf8String("Add"), 2);
                    if (addNum && !addNum.isNull())
                        invokeOk(addNum, numDict, [b.ivp, makeS(vrec.numbering || "")]);
                }
            }
            catch (e) { }
        }
        wblog(cat.name + "._localizedTextData 预填 '" + b.id + "' v" + b.ver + " (" + innerName + ")");
    }
    catch (e) {
        wblog("registerLocalizedDict err '" + b.id + "': " + e);
    }
}

✄
// ============ WitchBook 会话隔离域: mod 切换检测 / 整页重建 / 状态清理 / 面板默认值 ============
// 镜像 Windows ModClueLoader + ModWitchBookPatch: mod 切换/回标题时从原版基座重建, 防残留继承
import { A, fieldOffset, findAllObjectOfType, findFirstObjectOfType, findSvc, getGenericArgClass, getSystemClass, invoke, invokeOk, listContainsId, makeS, readStr, wblog } from "../utils.js";
import { wbCats, currentModSet, localeValue, makeIdVersionPair, unionLocaleKeys } from "./data.js";
import { initCatStateMaps, setWbCurrentMod, setWbDefaultsCaptured, setWbPrevMod, wbCls, wbCurrentMod, wbData, wbDefaultsCaptured, wbPageDefaults, wbVanillaMap } from "./state.js";
import { getFirstDictValue } from "./pages.js";
import { tryInjectWitchBook } from "./index.js";
// 从 ScriptLoader.Load 的路径识别当前 mod (匹配 modList 的 Enter; 原版默认路径 → __vanilla__)
// mod 变化时立即清理上一 mod 的残留 (页面若存在) 并注入当前 mod 目录
export function detectCurrentMod(path) {
    if (!path)
        return;
    var next = null;
    if (typeof modList !== "undefined" && modList) {
        for (var i = 0; i < modList.length; i++) {
            if (path === modList[i].Enter) {
                next = modList[i].key;
                break;
            }
        }
    }
    if (!next && path === "Act01_Chapter01/Act01_Chapter01_Adv01")
        next = "__vanilla__";
    if (next === null || next === wbCurrentMod)
        return;
    setWbCurrentMod(next);
    wblog("当前 mod: '" + wbCurrentMod + "' (Enter=" + path + ")");
    try {
        if (wbCls && wbCls.pages)
            tryInjectWitchBook();
    }
    catch (e) { }
}
export function resetWitchBookSession() {
    setWbCurrentMod(null);
    setWbPrevMod(null);
    wbData.states = {};
    wbData.pendingStates = {};
    wbData.texCache = {};
    initCatStateMaps();
    // 整页重建 (回原版基座) + 重置状态/面板 (防止残留继承)
    try {
        if (wbCls && wbCls.pages) {
            rebuildAllPages();
            clearBookViaVanilla();
            clearAllWitchBookPages();
        }
    }
    catch (e) { }
    wblog("会话重置 (回标题)");
}
// ===== Override 处理: mod 定义的原版同 id 条目应覆盖原版显示 (镜像 Windows modXxxOverrideIds) =====
// 检测 id 是否为原版 (存在于 Data._items, 而非仅 mod 注入)
export function isVanillaId(cat, id) {
    try {
        var dataCls = wbCls.datas[cat.name];
        if (!dataCls || dataCls.isNull())
            return false;
        var inst = findFirstObjectOfType(dataCls);
        if (!inst)
            return false;
        var items = inst.add(fieldOffset(dataCls, "_items", 0x18)).readPointer();
        if (items.isNull())
            return false;
        var listCls = A.ogc(items);
        var vItemCls = getGenericArgClass(listCls, 0);
        var idOff = fieldOffset(vItemCls, "_id", 0x10);
        return listContainsId(items, id, idOff);
    }
    catch (e) {
        return false;
    }
}
// 把 vanilla Data 里 id∈ids 的条目恢复到页面 (map + _localizedTextData + _itemIds)
// 重建 _itemIds (string[]) — 从当前 map 内容提取全部 id
export function rebuildItemIdsFromMap(page, pageCls, mapList, vItemCls, idOff) {
    try {
        var ids = [];
        var cnt = mapList.add(0x18).readS32(), arr = mapList.add(0x10).readPointer();
        for (var i = 0; i < cnt; i++) {
            var e = arr.add(0x20 + i * 8).readPointer();
            if (e.isNull())
                continue;
            var id = readStr(e.add(idOff).readPointer());
            if (id && ids.indexOf(id) === -1)
                ids.push(id);
        }
        var strCls = getSystemClass("String");
        var narr = A.an(strCls, ids.length);
        for (var i = 0; i < ids.length; i++)
            narr.add(0x20 + i * 8).writePointer(makeS(ids[i]));
        page.add(fieldOffset(pageCls, "_itemIds", 0x98)).writePointer(narr);
    }
    catch (e) { }
}
// 字典是否已有 (id, version) 条目 (IdVersionPair: Id@0x10, Version@0x18)
export function dictHasIdVer(dict, id, ver) {
    try {
        var ents = dict.add(0x18).readPointer();
        if (ents.isNull())
            return false;
        var cnt = ents.add(0x18).readS32();
        for (var i = 0; i < cnt; i++) {
            try {
                var en = ents.add(0x20 + i * 24);
                var k = en.add(8).readPointer();
                if (k.isNull())
                    continue;
                if (readStr(k.add(0x10).readPointer()) === id && k.add(0x18).readS32() === ver)
                    return true;
            }
            catch (e2) { }
        }
    }
    catch (e) { }
    return false;
}
// 整页重建: 清空页面 _loadedDataItemMap, 从捕获的原版快照重添全部条目,
// 重建 _itemIds, 并为缺 dict 项的条目补建。mod 切换/回标题时调用 → 每次会话从原版基座开始。
export function restorePageFromData(page, pageCls, cat) {
    try {
        var snap = wbVanillaMap[cat.name];
        var ptrs = snap ? snap.items : null;
        if (!ptrs || !ptrs.length) {
            wblog(cat.name + " 整页重建跳过 (快照未捕获)");
            return;
        }
        var mapList = page.add(fieldOffset(pageCls, "_loadedDataItemMap", 0x88)).readPointer();
        if (mapList.isNull())
            return;
        var mapListCls = A.ogc(mapList);
        var clMi = A.cgm(mapListCls, Memory.allocUtf8String("Clear"), 0);
        if (clMi && !clMi.isNull())
            invokeOk(clMi, mapList, []);
        var addMi = A.cgm(mapListCls, Memory.allocUtf8String("Add"), 1);
        var added = 0;
        for (var i = 0; i < ptrs.length; i++) {
            if (addMi && !addMi.isNull()) {
                if (invokeOk(addMi, mapList, [ptrs[i]]).ok)
                    added++;
            }
        }
        // 从 map 的 vItemCls 取字段偏移
        var vItemCls = getGenericArgClass(A.ogc(mapList), 0);
        var idOff = fieldOffset(vItemCls, "_id", 0x10);
        var verOff = fieldOffset(vItemCls, "_version", 0x18);
        rebuildItemIdsFromMap(page, pageCls, mapList, vItemCls, idOff);
        // 补 dict: 检查每个 map 条目是否有 dict 项 (override 移除过的 id 需重建)
        try {
            var outer = page.add(fieldOffset(pageCls, "_localizedTextData", cat.locOff)).readPointer();
            if (!outer.isNull()) {
                var mc = mapList.add(0x18).readS32(), marr = mapList.add(0x10).readPointer();
                for (var j = 0; j < mc; j++) {
                    var mvi = marr.add(0x20 + j * 8).readPointer();
                    if (mvi.isNull())
                        continue;
                    var mid = readStr(mvi.add(idOff).readPointer());
                    if (!mid)
                        continue;
                    if (!dictHasIdVer(outer, mid, mvi.add(verOff).readS32()))
                        restoreVanillaDict(page, pageCls, cat, mvi, vItemCls);
                }
            }
        }
        catch (e2) { }
        wblog(cat.name + " 整页重建: " + added + " 条 (原版基座)");
    }
    catch (e) {
        wblog("restorePageFromData err: " + e);
    }
}
// 对所有分类页面做整页重建 (mod 切换/回标题时调用)
export function rebuildAllPages() {
    try {
        var pages = findAllPages();
        if (!pages.length)
            return;
        var cats = Object.keys(wbCats);
        for (var ci = 0; ci < cats.length; ci++) {
            var cat = wbCats[cats[ci]];
            for (var pi = 0; pi < pages.length; pi++) {
                try {
                    var pc = A.ogc(pages[pi]);
                    if (A.cgn(pc).readCString() !== cat.page)
                        continue;
                    restorePageFromData(pages[pi], pc, cat);
                }
                catch (e) { }
            }
        }
    }
    catch (e) {
        wblog("rebuildAllPages err: " + e);
    }
}
// 为恢复的原版条目构建 _localizedTextData 字典项
export function restoreVanillaDict(page, pageCls, cat, vi, vItemCls) {
    try {
        var id = readStr(vi.add(fieldOffset(vItemCls, "_id", 0x10)).readPointer());
        var ver = vi.add(fieldOffset(vItemCls, "_version", 0x18)).readS32();
        var item = vi.add(fieldOffset(vItemCls, "_item", 0x20)).readPointer();
        var ivp = vi.add(fieldOffset(vItemCls, "_idVersionPair", 0x28)).readPointer();
        if (ivp.isNull())
            ivp = makeIdVersionPair(id, ver);
        var outer = page.add(fieldOffset(pageCls, "_localizedTextData", cat.locOff)).readPointer();
        if (outer.isNull())
            return;
        var outerCls = A.ogc(outer);
        var sample = getFirstDictValue(outer);
        if (!sample)
            return;
        var innerCls = A.ogc(sample);
        var addInner = A.cgm(innerCls, Memory.allocUtf8String("Add"), 2);
        var inner = A.on(innerCls);
        if (!invokeOk(A.cgm(innerCls, Memory.allocUtf8String(".ctor"), 0), inner, []).ok)
            return;
        // 读 DataItem 的 LocalizedText[] 字段
        var lts = readLocalizedArray(item, cat.name === "clue" ? 0x10 : cat.name === "profile" ? 0x10 : cat.name === "rule" ? 0x18 : 0x10);
        if (cat.name === "profile") {
            // Dictionary<LocaleKind, string>
            var keys = Object.keys(lts);
            for (var i = 0; i < keys.length; i++) {
                var lv = Memory.alloc(4);
                lv.writeS32(localeValue(keys[i]));
                invokeOk(addInner, inner, [lv, makeS(lts[keys[i]])]);
            }
        }
        else {
            var lts2 = readLocalizedArray(item, cat.name === "rule" ? 0x20 : 0x18);
            var ltsCls = wbCls.lts[cat.name];
            var ltsCtor = (ltsCls && !ltsCls.isNull()) ? A.cgm(ltsCls, Memory.allocUtf8String(".ctor"), 2) : null;
            var keys2 = unionLocaleKeys(lts, lts2);
            for (var i = 0; i < keys2.length; i++) {
                var lt = A.on(ltsCls);
                var lv2 = Memory.alloc(4);
                lv2.writeS32(localeValue(keys2[i]));
                if (ltsCtor && !ltsCtor.isNull())
                    invokeOk(ltsCtor, lt, [makeS(lts[keys2[i]] || ""), makeS(lts2[keys2[i]] || "")]);
                invokeOk(addInner, inner, [lv2, lt]);
            }
        }
        var addOuter = A.cgm(outerCls, Memory.allocUtf8String("Add"), 2);
        if (addOuter && !addOuter.isNull())
            invokeOk(addOuter, outer, [ivp, inner]);
    }
    catch (e) {
        wblog("restoreVanillaDict err: " + e);
    }
}
// 读 LocalizedText[] (LocalizedText: _locale@0x10 int, _text@0x18 string) → {localeTag: text}
export function readLocalizedArray(arrPtr, off) {
    var out = {};
    try {
        if (!arrPtr || arrPtr.isNull())
            return out;
        var arr = arrPtr.add(off).readPointer();
        if (arr.isNull())
            return out;
        var len = arr.add(0x18).readS32();
        for (var i = 0; i < len; i++) {
            var lt = arr.add(0x20 + i * 8).readPointer();
            if (lt.isNull())
                continue;
            var loc = lt.add(0x10).readS32();
            var text = readStr(lt.add(0x18).readPointer()) || "";
            var tag = "zh-Hans";
            switch (loc) {
                case 0:
                    tag = "ja";
                    break;
                case 1:
                    tag = "en-US";
                    break;
                case 2:
                    tag = "zh-Hans";
                    break;
                case 3:
                    tag = "zh-Hant";
                    break;
                case 4:
                    tag = "ko";
                    break;
                case 5:
                    tag = "fr";
                    break;
                case 6:
                    tag = "es";
                    break;
            }
            out[tag] = text;
        }
    }
    catch (e) { }
    return out;
}
// 从页面结构中移除指定 id 的条目 (mod 切换时清理旧 mod 数据; pageCls 区分各分类页面)
export function clearModItemsFromPage(page, pageCls, idSet) {
    try {
        var removed = 0;
        // 1) _loadedDataItemMap (List): 收集要移除的索引, 倒序 RemoveAt
        var mapOff = fieldOffset(pageCls, "_loadedDataItemMap", 0x88);
        var mapList = page.add(mapOff).readPointer();
        if (!mapList.isNull()) {
            var listCls = A.ogc(mapList);
            var vItemCls = getGenericArgClass(listCls, 0);
            var idOff = fieldOffset(vItemCls, "_id", 0x10);
            var rmMi = A.cgm(listCls, Memory.allocUtf8String("RemoveAt"), 1);
            var cnt = mapList.add(0x18).readS32(), items = mapList.add(0x10).readPointer();
            var idxs = [];
            for (var i = 0; i < cnt; i++) {
                try {
                    var e = items.add(0x20 + i * 8).readPointer();
                    if (e.isNull())
                        continue;
                    if (idSet[readStr(e.add(idOff).readPointer())])
                        idxs.push(i);
                }
                catch (e2) { }
            }
            if (rmMi && !rmMi.isNull()) {
                for (var r = idxs.length - 1; r >= 0; r--) {
                    var ib = Memory.alloc(4);
                    ib.writeS32(idxs[r]);
                    if (invokeOk(rmMi, mapList, [ib]).ok)
                        removed++;
                }
            }
        }
        // 2) _localizedTextData (Dict): 遍历删除 key.Id ∈ idSet
        var dictField = fieldOffset(pageCls, "_localizedTextData", 0xD0);
        var outer = page.add(dictField).readPointer();
        if (!outer.isNull()) {
            var outerCls = A.ogc(outer);
            var rmD = A.cgm(outerCls, Memory.allocUtf8String("Remove"), 1);
            if (rmD && !rmD.isNull()) {
                // 先收集要删的 key (边遍历边 Remove 会 rehash 使数组失效)
                var toDel = [];
                var ents = outer.add(0x18).readPointer();
                var ecnt = ents.isNull() ? 0 : ents.add(0x18).readS32();
                for (var ei = 0; ei < ecnt; ei++) {
                    try {
                        var en = ents.add(0x20 + ei * 24);
                        var k = en.add(8).readPointer();
                        if (k.isNull())
                            continue;
                        var kid = readStr(k);
                        if (kid && idSet[kid])
                            toDel.push(k);
                    }
                    catch (e2) { }
                }
                for (var di = 0; di < toDel.length; di++)
                    invokeOk(rmD, outer, [toDel[di]]);
            }
        }
        // 3) _itemIds (string[]): 重建
        var idsField = fieldOffset(pageCls, "_itemIds", 0x98);
        var old = page.add(idsField).readPointer();
        if (!old.isNull()) {
            var keep = [];
            var olen = old.add(0x18).readS32();
            for (var oi = 0; oi < olen; oi++) {
                var s = readStr(old.add(0x20 + oi * 8).readPointer());
                if (s && !idSet[s])
                    keep.push(s);
            }
            var strCls = getSystemClass("String");
            var narr = A.an(strCls, keep.length);
            for (var ki = 0; ki < keep.length; ki++)
                narr.add(0x20 + ki * 8).writePointer(makeS(keep[ki]));
            page.add(idsField).writePointer(narr);
        }
        // 4) _state._list (List<IdVersionPair>): 移除 Id ∈ idSet
        removeStateEntries(page, pageCls, idSet);
        // 5) 清当前选中项 (_currentItemId) → 上方面板不再残留
        try {
            var curOff = fieldOffset(pageCls, "_currentItemId", 0xA0);
            page.add(curOff).writePointer(makeS(""));
        }
        catch (e) { }
        if (removed > 0)
            wblog("清除旧 mod 条目 " + removed + " 条");
    }
    catch (e) {
        wblog("clearModItemsFromPage err: " + e);
    }
}
// 从 _state._list 移除指定 id 的状态 (IdVersionPair.Id @+0x10)
export function removeStateEntries(page, pageCls, idSet) {
    try {
        var stOff = fieldOffset(pageCls, "_state", 0x48);
        var st = page.add(stOff).readPointer();
        if (st.isNull())
            return;
        var stList = st.add(fieldOffset(wbCls.versionedState, "_list", 0x10)).readPointer();
        if (stList.isNull())
            return;
        var slCls = A.ogc(stList);
        var rmMi = A.cgm(slCls, Memory.allocUtf8String("RemoveAt"), 1);
        if (!rmMi || rmMi.isNull())
            return;
        var scnt = stList.add(0x18).readS32(), sitems = stList.add(0x10).readPointer();
        var sidxs = [];
        for (var si = 0; si < scnt; si++) {
            try {
                var se = sitems.add(0x20 + si * 8).readPointer();
                if (se.isNull())
                    continue;
                var sid = readStr(se.add(0x10).readPointer());
                if (sid && idSet[sid])
                    sidxs.push(si);
            }
            catch (e2) { }
        }
        for (var sr = sidxs.length - 1; sr >= 0; sr--) {
            var sb = Memory.alloc(4);
            sb.writeS32(sidxs[sr]);
            invokeOk(rmMi, stList, [sb]);
        }
    }
    catch (e) {
        wblog("removeStateEntries err: " + e);
    }
}
// 清空页面 _state (仅保留 keepSet; keepSet=null 清空全部)
export function clearPageState(page, keepSet) {
    try {
        var st = page.add(0x48).readPointer();
        if (st.isNull())
            return;
        var stList = st.add(fieldOffset(wbCls.versionedState, "_list", 0x10)).readPointer();
        if (stList.isNull())
            return;
        var slCls = A.ogc(stList);
        var rmMi = A.cgm(slCls, Memory.allocUtf8String("RemoveAt"), 1);
        if (!rmMi || rmMi.isNull())
            return;
        var cnt = stList.add(0x18).readS32(), items = stList.add(0x10).readPointer();
        var idxs = [];
        for (var i = 0; i < cnt; i++) {
            try {
                var e = items.add(0x20 + i * 8).readPointer();
                if (e.isNull())
                    continue;
                var id = readStr(e.add(0x10).readPointer());
                if (!id || (keepSet && !keepSet[id]))
                    idxs.push(i);
            }
            catch (e2) { }
        }
        for (var r = idxs.length - 1; r >= 0; r--) {
            var ib = Memory.alloc(4);
            ib.writeS32(idxs[r]);
            invokeOk(rmMi, stList, [ib]);
        }
        if (idxs.length)
            wblog("清空 " + A.cgn(A.ogc(page)).readCString() + " 状态 " + idxs.length + " 条");
    }
    catch (e) {
        wblog("clearPageState err: " + e);
    }
}
// 面板默认值捕获/恢复: 页面首次出现(未被 mod 触碰)时读取原版默认文本+默认图,
// 清空时恢复 → 空图鉴显示原版默认态 (占位图+默认文字), 而不是纯白空白
export function capturePageDefaults(page) {
    try {
        var cls = A.ogc(page);
        var key = cls.toString();
        if (wbPageDefaults[key])
            return;
        var pageCls = cls, clsName = A.cgn(pageCls).readCString();
        var d = { labels: {}, defaultTex: ptr(0) };
        var labelFields = (clsName === "CluePage") ? ["_subjectLabel", "_descriptionLabel"] :
            (clsName === "ProfilePage") ? ["_authorLabel", "_descriptionLabel"] :
                (clsName === "RulePage") ? ["_titleNumLabel", "_subtitleLabel", "_descriptionLabel"] :
                    (clsName === "NotePage") ? ["_titleLabel", "_descriptionLabel"] : [];
        labelFields.forEach(function (fn) {
            try {
                var f = A.gf(pageCls, Memory.allocUtf8String(fn));
                if (!f || f.isNull())
                    return;
                var lab = page.add(A.fo(f)).readPointer();
                if (lab.isNull())
                    return;
                // WitchBookItemSubjectLabel 内部是 _label (TMP_Text)
                var tmp = lab;
                if (fn === "_subjectLabel") {
                    var lf = A.gf(wbCls.witchBookItemSubjectLabel, Memory.allocUtf8String("_label"));
                    if (lf && !lf.isNull())
                        tmp = lab.add(A.fo(lf)).readPointer();
                    if (tmp.isNull())
                        tmp = lab;
                }
                var labCls = A.ogc(tmp);
                var gt = A.cgm(labCls, Memory.allocUtf8String("get_text"), 0);
                if (gt && !gt.isNull()) {
                    var t = invoke(gt, tmp, []);
                    d.labels[fn] = readStr(t) || "";
                }
            }
            catch (e) { }
        });
        // 缩略图默认纹理 (_defaultTexture)
        try {
            var thf = A.gf(pageCls, Memory.allocUtf8String("_thumbnail"));
            if (thf && !thf.isNull()) {
                var th = page.add(A.fo(thf)).readPointer();
                if (!th.isNull()) {
                    var dtf = A.gf(wbCls.witchBookItemThumbnail, Memory.allocUtf8String("_defaultTexture"));
                    if (dtf && !dtf.isNull())
                        d.defaultTex = th.add(A.fo(dtf)).readPointer();
                }
            }
        }
        catch (e) { }
        wbPageDefaults[key] = d;
        wblog("已捕获 " + clsName + " 面板默认值 (" + Object.keys(d.labels).length + " 标签)");
    }
    catch (e) {
        wblog("capturePageDefaults err: " + e);
    }
}
export function restorePageDefaults(page) {
    try {
        var cls = A.ogc(page);
        var d = wbPageDefaults[cls.toString()];
        if (!d)
            return;
        var pageCls = cls, clsName = A.cgn(pageCls).readCString();
        var labels = Object.keys(d.labels);
        labels.forEach(function (fn) {
            try {
                var f = A.gf(pageCls, Memory.allocUtf8String(fn));
                if (!f || f.isNull())
                    return;
                var lab = page.add(A.fo(f)).readPointer();
                if (lab.isNull())
                    return;
                var tmp = lab;
                if (fn === "_subjectLabel") {
                    var lf = A.gf(wbCls.witchBookItemSubjectLabel, Memory.allocUtf8String("_label"));
                    if (lf && !lf.isNull())
                        tmp = lab.add(A.fo(lf)).readPointer();
                    if (tmp.isNull())
                        tmp = lab;
                }
                var labCls = A.ogc(tmp);
                var mi = A.cgm(labCls, Memory.allocUtf8String("set_text"), 1);
                if (mi && !mi.isNull())
                    invokeOk(mi, tmp, [makeS(d.labels[fn])]);
            }
            catch (e) { }
        });
        try {
            var thf = A.gf(pageCls, Memory.allocUtf8String("_thumbnail"));
            if (thf && !thf.isNull()) {
                var th = page.add(A.fo(thf)).readPointer();
                if (!th.isNull() && d.defaultTex && !d.defaultTex.isNull()) {
                    var raw = th.add(fieldOffset(wbCls.witchBookItemThumbnail, "_rawImage", 0x28)).readPointer();
                    if (!raw.isNull()) {
                        var rc = A.ogc(raw);
                        var mi = A.cgm(rc, Memory.allocUtf8String("set_texture"), 1);
                        if (mi && !mi.isNull())
                            invokeOk(mi, raw, [d.defaultTex]);
                    }
                }
            }
        }
        catch (e) { }
        try {
            page.add(0xA0).writePointer(makeS(""));
        }
        catch (e) { } // _currentItemId 不恢复, 始终清空
        wblog("已恢复 " + clsName + " 面板默认值");
    }
    catch (e) {
        wblog("restorePageDefaults err: " + e);
    }
}
export function findAllPages() {
    // 用具体页面类遍历 (基类 WitchBookPageBase 有泛型/非泛型两个, FindObjectsOfType 不稳定)
    var out = [];
    if (!wbCls || !wbCls.pages)
        return out;
    var pn = Object.keys(wbCls.pages);
    for (var i = 0; i < pn.length; i++) {
        var cls = wbCls.pages[pn[i]];
        if (!cls || cls.isNull())
            continue;
        var pages = findAllObjectOfType(cls);
        for (var j = 0; j < pages.length; j++)
            out.push(pages[j]);
    }
    // 首次见到页面即捕获默认值 + 原版 map 基座 (此时未被 mod 触碰, 处于原版默认态)
    if (!wbDefaultsCaptured && out.length) {
        for (var k = 0; k < out.length; k++) {
            try {
                capturePageDefaults(out[k]);
            }
            catch (e) { }
        }
        setWbDefaultsCaptured(true);
    }
    // 捕获原版 _loadedDataItemMap 快照 (整页重建的基座; 不依赖 Data 加载时机)
    // 按页面实例捕获: 页面重建(新实例)时重新捕获
    for (var c = 0; c < out.length; c++) {
        try {
            var ccls = A.ogc(out[c]);
            var ccn = A.cgn(ccls).readCString();
            for (var cc = 0; cc < Object.keys(wbCats).length; cc++) {
                var ccat = wbCats[Object.keys(wbCats)[cc]];
                if (ccat.page !== ccn)
                    continue;
                if (wbVanillaMap[ccat.name] && wbVanillaMap[ccat.name].page === out[c].toString())
                    break;
                var mlist = out[c].add(fieldOffset(ccls, "_loadedDataItemMap", 0x88)).readPointer();
                if (mlist.isNull())
                    break;
                var mcnt = mlist.add(0x18).readS32(), marr = mlist.add(0x10).readPointer();
                var ptrs = [];
                for (var mi = 0; mi < mcnt; mi++) {
                    var e = marr.add(0x20 + mi * 8).readPointer();
                    if (e && !e.isNull())
                        ptrs.push(e);
                }
                wbVanillaMap[ccat.name] = { page: out[c].toString(), items: ptrs };
                wblog(ccat.name + " 捕获原版基座 " + ptrs.length + " 条");
            }
        }
        catch (e) { }
    }
    return out;
}
// 清状态 + 恢复原版默认面板 — 仅 mod 切换/会话重置时调用
// 各页面按其分类保留当前 mod 的条目; 其余 (原版/他 mod) 清空; 面板恢复原版默认
export function clearAllWitchBookPages() {
    try {
        if (!wbCurrentMod || wbCurrentMod === "__vanilla__")
            return; // 原版剧情不干预
        var pages = findAllPages();
        for (var i = 0; i < pages.length; i++) {
            try {
                var cn = A.cgn(A.ogc(pages[i])).readCString();
                var cat = null;
                var cn2 = Object.keys(wbCats);
                for (var j = 0; j < cn2.length; j++) {
                    if (wbCats[cn2[j]].page === cn) {
                        cat = wbCats[cn2[j]];
                        break;
                    }
                }
                var keep = cat ? currentModSet(cat) : null;
                clearPageState(pages[i], keep);
                restorePageDefaults(pages[i]);
            }
            catch (e) { }
        }
    }
    catch (e) {
        wblog("clearAllWitchBookPages err: " + e);
    }
}
export function findWitchBookUi() {
    try {
        var s = findSvc("WitchBookUi");
        if (s)
            return s;
    }
    catch (e) { }
    try {
        if (wbCls && wbCls.witchBookUi && !wbCls.witchBookUi.isNull()) {
            var arr = findAllObjectOfType(wbCls.witchBookUi);
            if (arr.length)
                return arr[0];
        }
    }
    catch (e) { }
    return null;
}
// 镜像 @clearBook (ClearWitchBook 命令): 调 WitchBookUi.ClearState(category) 全 5 分类
// 重置页面 _state (ResetToDefault) + 当前选中项 → 上方面板不再残留上一剧本的线索
export function clearBookViaVanilla() {
    try {
        var ui = findWitchBookUi();
        if (!ui) {
            wblog("clearBook: WitchBookUi 未找到");
            return;
        }
        var mi = A.cgm(wbCls.witchBookUi, Memory.allocUtf8String("ClearState"), 1);
        if (!mi || mi.isNull()) {
            wblog("clearBook: ClearState NOT FOUND");
            return;
        }
        for (var c = 0; c <= 4; c++) { // Clue=0 Profile=1 Map=2 Rule=3 Note=4
            var cb = Memory.alloc(4);
            cb.writeS32(c);
            invokeOk(mi, ui, [cb]);
        }
        wblog("clearBook: WitchBookUi.ClearState 全部 5 分类已调用");
    }
    catch (e) {
        wblog("clearBook err: " + e);
    }
}

✄
// ============ WitchBook 共享状态 (数据/分类表/会话标记/类表/覆写表) ============
// 分类表 wbCats 在 data.js (其 addr 引用 data.js 的纹理地址构建函数)
import { wbCats } from "./data.js";
export var wbData = {
    clue: {},
    profile: {},
    rule: {},
    note: {},
    characters: {},
    states: {},
    pendingStates: {},
    texCache: {},
    texPaths: {} // id -> path (clue/profile)
};
export var wbCurrentMod = null; // 当前激活的 mod key (经 ScriptLoader.Load 匹配 Enter 得到; null=未知, __vanilla__=原版)
export var wbPrevMod = null; // 上次注入时的 mod key (用于切换检测)
export var wbCls = null; // 解析好的类表 (index.js resolveWitchBookClasses)
export var wbReady = false;
export var wbOverrides = { clue: {}, profile: {}, rule: {}, note: {} }; // 当前 mod 覆写的原版 id
export var wbVanillaMap = {}; // catName -> {page: 页面指针, items: [原版 VersionedItem 指针]} (整页重建基座快照)
export var wbPageDefaults = {}; // pageClass ptr -> {labels:{字段:文本}, defaultTex:ptr}
export var wbDefaultsCaptured = false;
// setter (ES modules import 绑定只读, 赋值必须在模块内)
export function setWbCurrentMod(v) { wbCurrentMod = v; }
export function setWbPrevMod(v) { wbPrevMod = v; }
export function setWbCls(c) { wbCls = c; }
export function setWbReady(r) { wbReady = r; }
export function setWbDefaultsCaptured(v) { wbDefaultsCaptured = v; }
export function initCatStateMaps() {
    var cn = Object.keys(wbCats);
    for (var i = 0; i < cn.length; i++) {
        if (!wbData.states[cn[i]])
            wbData.states[cn[i]] = {};
        if (!wbData.pendingStates[cn[i]])
            wbData.pendingStates[cn[i]] = {};
    }
}

✄
// ============ WitchBook 纹理域: PNG → Texture2D → AddressablesManager._loadedAssets ============
// 缩略图 + @spawn ClueItem 共用; 镜像 Windows ModTextureHelper
import { A, fieldOffset, findAllObjectOfType, findClassAcrossImages, getSystemClass, invokeOk, makeS, nv, readStr, wblog } from "../utils.js";
import { fileReadBytes } from "../io.js";
import { wbCls, wbData } from "./state.js";
import { currentModIds, wbCats } from "./data.js";
// 4) 纹理: 读 PNG → Texture2D → 注册进 AddressablesManager._loadedAssets (缩略图 + @spawn 共用)
export function loadModTexture(id) {
    if (wbData.texCache[id])
        return wbData.texCache[id];
    var path = wbData.texPaths[id];
    if (!path)
        return null;
    try {
        var fb = fileReadBytes(path);
        if (!fb || fb.size <= 0) {
            wblog("读取纹理失败 '" + id + "'");
            return null;
        }
        var byteCls = getSystemClass("Byte");
        var barr = A.an(byteCls, fb.size);
        // byte[] 是值类型数组, 数据从 +0x20 起原始字节
        barr.add(0x20).writeByteArray(fb.buf.readByteArray(fb.size));
        var tex = A.on(wbCls.texture2d);
        var wbuf = Memory.alloc(4);
        wbuf.writeS32(2);
        var hbuf = Memory.alloc(4);
        hbuf.writeS32(2);
        var ctorMi = A.cgm(wbCls.texture2d, Memory.allocUtf8String(".ctor"), 2);
        if (ctorMi && !ctorMi.isNull())
            invokeOk(ctorMi, tex, [wbuf, hbuf]);
        var liMi = A.cgm(wbCls.imageConversion, Memory.allocUtf8String("LoadImage"), 2);
        if (!liMi || liMi.isNull()) {
            wblog("ImageConversion.LoadImage NOT FOUND");
            return null;
        }
        var r = invokeOk(liMi, ptr(0), [tex, barr]); // 静态
        if (!r.ok) {
            wblog("LoadImage 失败 '" + id + "'");
            return null;
        }
        wbData.texCache[id] = tex;
        wblog("纹理加载 '" + id + "' -> " + tex);
        return tex;
    }
    catch (e) {
        wblog("loadModTexture err '" + id + "': " + e);
        return null;
    }
}
export function findAddressablesManager() {
    // 1) 各页面 _addressableAssetLoader (同一 AddressablesManager 单例)
    try {
        if (wbCls && wbCls.pages) {
            var pn = Object.keys(wbCls.pages);
            for (var pi = 0; pi < pn.length; pi++) {
                var pageCls = wbCls.pages[pn[pi]];
                if (!pageCls || pageCls.isNull())
                    continue;
                var pages = findAllObjectOfType(pageCls);
                if (pages.length) {
                    var m = pages[0].add(fieldOffset(pageCls, "_addressableAssetLoader", 0x50)).readPointer();
                    if (m && !m.isNull())
                        return m;
                }
            }
        }
    }
    catch (e) { }
    // 2) 全局服务 (模糊匹配 Addressables 相关类名)
    try {
        var el = A.cfn(nv, "Naninovel", "Engine");
        var f = A.gf(el, "services");
        var l = A.sdf(el).add(A.fo(f)).readPointer();
        var its = l.add(0x10).readPointer(), sz = l.add(0x18).readS32();
        for (var i = 0; i < sz; i++) {
            var ep = its.add(0x20 + i * 8).readPointer();
            if (ep.isNull())
                continue;
            var cn = A.cgn(A.ogc(ep)).readCString();
            if (cn.indexOf("Addressables") >= 0)
                return ep;
        }
    }
    catch (e) { }
    return null;
}
export function registerTexturesInto(managerPtr) {
    try {
        // 未指定时用全局 AddressablesManager 服务 (镜像 Windows ServiceLocator.Get<IAddressablesManager>)
        if (!managerPtr || managerPtr.isNull())
            managerPtr = findAddressablesManager();
        if (!managerPtr || managerPtr.isNull()) {
            wblog("AddressablesManager 未找到");
            return;
        }
        var mgrCls = A.ogc(managerPtr);
        var dict = managerPtr.add(fieldOffset(mgrCls, "_loadedAssets", 0x18)).readPointer();
        if (dict.isNull()) {
            wblog("AddressablesManager._loadedAssets 为 null");
            return;
        }
        var dictCls = A.ogc(dict);
        var addMi = A.cgm(dictCls, Memory.allocUtf8String("Add"), 2);
        if (!addMi || addMi.isNull()) {
            wblog("Dict.Add NOT FOUND");
            return;
        }
        // 收集当前 mod 所有带纹理的条目 (clue/profile)
        var texIds = [], catNames = Object.keys(wbCats);
        for (var ci = 0; ci < catNames.length; ci++) {
            var cat = wbCats[catNames[ci]];
            if (!cat.texDir || !cat.addr)
                continue;
            currentModIds(cat).forEach(function (id) { if (wbData.texPaths[id])
                texIds.push(id); });
        }
        var count = 0;
        for (var i = 0; i < texIds.length; i++) {
            var tex = loadModTexture(texIds[i]);
            if (!tex)
                continue;
            var cat2 = null, id2 = texIds[i];
            for (var ci2 = 0; ci2 < catNames.length; ci2++) {
                var c2 = wbCats[catNames[ci2]];
                if (wbData[c2.name][id2]) {
                    cat2 = c2;
                    break;
                }
            }
            if (!cat2 || !cat2.addr)
                continue;
            var addr = cat2.addr(id2);
            if (dictContainsKey(dict, addr))
                continue;
            if (invokeOk(addMi, dict, [makeS(addr), tex]).ok)
                count++;
        }
        if (count > 0)
            wblog("Addressables 注册 " + count + " 张纹理");
    }
    catch (e) {
        wblog("registerTexturesInto err: " + e);
    }
}
export function dictContainsKey(dict, key) {
    try {
        // .NET Dictionary: _entries(+0x18, Entry[]), _count(+0x20); Entry = hashCode(4)+next(4)+key(8)+value(8)
        var ents = dict.add(0x18).readPointer();
        if (ents.isNull())
            return false;
        var cnt = ents.add(0x18).readS32(); // 数组长度 (容量)
        for (var i = 0; i < cnt; i++) {
            try {
                var e = ents.add(0x20 + i * 24);
                var k = e.add(8).readPointer();
                if (!k.isNull() && readStr(k) === key)
                    return true;
            }
            catch (e2) { }
        }
    }
    catch (e) { }
    return false;
}
