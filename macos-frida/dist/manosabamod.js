📦
34657 /src/entry.js
1938 /src/banner.js
5796 /src/chapterdisplay.js
83218 /src/choice.js
21467 /src/cutin.js
4554 /src/io.js
9445 /src/log.js
15046 /src/menu.js
5211 /src/movie.js
15229 /src/providers.js
13403 /src/scripttext.js
24372 /src/utils.js
19320 /src/witchbook/characters.js
14658 /src/witchbook/data.js
15032 /src/witchbook/index.js
18383 /src/witchbook/pages.js
31811 /src/witchbook/session.js
1742 /src/witchbook/state.js
6346 /src/witchbook/textures.js
✄
import { A, allImgs, cs, dbg, findClassAcrossImages, nv, readStr, setGotoModifiedCls, setImageHandles, wblog } from "./utils.js";
import { clearCutInCaches, setupCutInHooks } from "./cutin.js";
import { initChoiceHandlers, setupChoiceHandlerHooks } from "./choice.js";
import { setupChapterDisplayHooks } from "./chapterdisplay.js";
import { setupScriptTextHooks } from "./scripttext.js";
import { setupMovieHooks } from "./movie.js";
import { addModLoader, setupLocaleReinjectHooks } from "./providers.js";
import { hookStartGame, registerMenu, registerMenuText } from "./menu.js";
import { resetWitchBookSession } from "./witchbook/session.js";
import { setupWitchBookHooks } from "./witchbook/index.js";
import { registerTexturesInto } from "./witchbook/textures.js";
import { wbCls } from "./witchbook/state.js";
import { initLog, installCrashHandler, logLevel } from "./log.js";
import { printStartupBanner } from "./banner.js";
// ============ 日志系统初始化 (顶层最先: 覆盖整个 init, 含 GameAssembly 加载失败) ============
// MOD_LOG/MOD_NO_COLOR 由 run_mod.sh 的 fragment 注入全局; initLog 早于首个 wblog (doInit)
initLog((typeof MOD_LOG !== "undefined" && MOD_LOG) ? MOD_LOG : null, typeof MOD_NO_COLOR !== "undefined" && MOD_NO_COLOR);
installCrashHandler();
// MOD 初始化横幅: 角色 ASCII 艺术 + 项目声明 (打印时文件已开, 终端彩色 / modlog.txt 明文)
printStartupBanner();
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
// 诊断 hook (goto 链路/加载链/SetException 栈回溯) 仅在 MOD_DEBUG=1 时装, 默认不装
// 教训: SetException hook 对每个 UniTask 异常都做 Thread.backtrace, 审判加载的异常风暴里
//       给引擎的取消/重入竞态加延迟, 与偶发崩溃 (MethodAccessException 未被接住) 相关
var DIAG = typeof MOD_DEBUG !== 'undefined' && MOD_DEBUG;
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
        // 遍历全部方法 (含泛型方法定义; get_method_from_name 不含泛型 → dump/hook 泛型方法必须用它)
        A.cgmAll = E.il2cpp_class_get_methods ? new NativeFunction(E.il2cpp_class_get_methods, 'pointer', ['pointer', 'pointer']) : null;
        // MethodInfo 布局不可靠 → 用官方 API 读名字/参数数 (不猜偏移)
        A.mgn = E.il2cpp_method_get_name ? new NativeFunction(E.il2cpp_method_get_name, 'pointer', ['pointer']) : null;
        A.mpc = E.il2cpp_method_get_param_count ? new NativeFunction(E.il2cpp_method_get_param_count, 'int', ['pointer']) : null;
        A.mig = E.il2cpp_method_is_generic ? new NativeFunction(E.il2cpp_method_is_generic, 'bool', ['pointer']) : null;
        A.mii = E.il2cpp_method_is_inflated ? new NativeFunction(E.il2cpp_method_is_inflated, 'bool', ['pointer']) : null;
        A.cgp = E.il2cpp_class_get_parent ? new NativeFunction(E.il2cpp_class_get_parent, 'pointer', ['pointer']) : null;
        A.sn = new NativeFunction(E.il2cpp_string_new, 'pointer', ['pointer']);
        A.ri = new NativeFunction(E.il2cpp_runtime_invoke, 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
        A.ogc = new NativeFunction(E.il2cpp_object_get_class, 'pointer', ['pointer']);
        A.cgn = new NativeFunction(E.il2cpp_class_get_name, 'pointer', ['pointer']);
        A.on = new NativeFunction(E.il2cpp_object_new, 'pointer', ['pointer']);
        A.gf = new NativeFunction(E.il2cpp_class_get_field_from_name, 'pointer', ['pointer', 'pointer']);
        A.fo = new NativeFunction(E.il2cpp_field_get_offset, 'uint32', ['pointer']);
        A.fgt = E.il2cpp_field_get_type ? new NativeFunction(E.il2cpp_field_get_type, 'pointer', ['pointer']) : null;
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
        wblog("[v3] nv=" + nvImg + " cs=" + csImg + " giga=" + gigaImg + " images=" + cnt);
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
        // 动态解析 LoadAndPlay 并 hook (诊断用, 仅 MOD_DEBUG)
        if (DIAG && gmCls && !gmCls.isNull()) {
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
        // ===== 诊断: 完整 goto 链路 hook (仅 MOD_DEBUG, 默认不装) =====
        if (DIAG)
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
        // 级别路由: LogError/LogException→ERROR(红), LogWarning→WARN(黄), Log→INFO(青); 进终端+文件
        function dumpObj(obj, tag, level) {
            if (level === undefined)
                level = 0; // 默认按错误处理
            if (!obj || obj.isNull()) {
                logLevel(level, "[v3] " + tag + ": <null>");
                return;
            }
            try {
                var cls = A.ogc(obj);
                var cn = cls ? A.cgn(cls).readCString() : "?";
                logLevel(level, "[v3] " + tag + " obj=" + obj + " class=" + cn);
                // hexdump 前 48 字节
                var hex = "";
                for (var i = 0; i < 48; i++) {
                    hex += obj.add(i).readU8().toString(16).padStart(2, "0") + (i % 16 === 15 ? " " : "");
                }
                logLevel(level, "[v3] " + tag + " hex: " + hex);
                // 从 +0x14 走 UTF-16 到 null, 取完整字符串 (忽略可疑长度字段)
                // 长读 2000: 崩溃同款异常的完整 C# 栈 (MethodAccessException 调用方) 会被截断
                // 代理项跳过: 孤立 surrogate 会让 python print 抛 UnicodeEncodeError 打断日志流
                function collectUtf16(baseOff, max) {
                    var s = "";
                    for (var fi = 0; fi < max; fi++) {
                        var c = obj.add(baseOff + fi * 2).readU16();
                        if (c === 0)
                            break;
                        if (c >= 0xD800 && c <= 0xDFFF)
                            continue; // 孤立代理项直接跳过
                        s += String.fromCharCode(c);
                    }
                    return s;
                }
                try {
                    var full = collectUtf16(0x14, 2000);
                    if (full)
                        logLevel(level, "[v3] " + tag + " FULL: " + full);
                }
                catch (e) { }
                // 移除多偏移 UTF-16 尝试 (0x08/0x10/0x18/0x0C): C# 字符串是引用类型,
                // 直接从对象实例内存读 UTF-16 是错的 — 读到的全是垃圾 (如 KeyNotFoundException
                // 日志里的 '歀惠' 是误读, 无意义). 必要信息已在 hex + class + full 中.
            }
            catch (e3) {
                logLevel(level, "[v3] " + tag + " dump err: " + e3);
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
                    // 级别映射: LogError/LogException→ERROR(红), LogWarning→WARN(黄), Log→INFO(青)
                    // → Naninovel 剧本提醒 (缺翻译/解析错等) 自动带级别/颜色/入文件
                    ["LogError", "LogException", "Log", "LogWarning"].forEach(function (mn) {
                        var lv = (mn === "LogError" || mn === "LogException") ? 0
                            : (mn === "LogWarning") ? 1 : 2;
                        for (var ac = 1; ac <= 2; ac++) {
                            var m = A.cgm(dbgCls, Memory.allocUtf8String(mn), ac);
                            if (m && !m.isNull()) {
                                (function (mn2, ac2, lv2) {
                                    Interceptor.attach(m.readPointer(), {
                                        onEnter: function (a) {
                                            // Debug.LogError 等是静态方法 → 第一个参数在 a[0]
                                            dumpObj(a[0], "Unity." + mn2 + "(" + ac2 + ")", lv2);
                                        }
                                    });
                                })(mn, ac, lv);
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
        // CutIn 支持 (异议/伪证切入 sprite 替换, 镜像 Windows ModObjectionCutInLoader 精简版)
        setupCutInHooks();
        // @choice handler 支持 (自定义选项面板, 镜像 Windows ModChoiceHandlerLoader 精简核心)
        setupChoiceHandlerHooks();
        // 语言切换重注入 hook (镜像上游 Windows LocaleWatcherComponent, commit 66e5388b)
        // hook ResourceLoader<T>.HandleLocaleChanged (FSG) → 启动 ~10 帧重注入窗口
        // 覆盖: Scripts/Text/Audio/Voice/Backgrounds/Characters (insertProvisionSource 自带去重)
        setupLocaleReinjectHooks();
        // 存档章节名支持 (镜像 Windows ModChapterDisplay)
        setupChapterDisplayHooks();
        // 剧本 `"文本"|#ID|` 引号修复 (无 C# 蓝本, 自建运行时补丁, 见 scripttext.js 头注释)
        setupScriptTextHooks();
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
                        // 回标题 → 清 CutIn 实例缓存 (旧实例指针可能失效)
                        try {
                            clearCutInCaches();
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
                                    wblog("[v3] ==== 为 mod '" + modList[mi].key + "' 注入 provider ====");
                                    addModLoader(root, modList[mi].key);
                                }
                            }
                        }
                        catch (e2) {
                            dbg("[v3] addModLoader 循环 err: " + e2);
                        }
                        // ChoiceHandler: 预加载立绘 + 触发源面板 (镜像 Windows LoadModData + TryTriggerSourcePanelLoad)
                        try {
                            initChoiceHandlers();
                        }
                        catch (e4) {
                            dbg("[v3] choice handler init err: " + e4);
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
// 启动横幅: 角色 ASCII 画 (内嵌进 bundle, 运行时不读外部文件) + 项目声明
import { logBanner, info } from "./log.js";
export var BANNER_ART = `@@@@@@@@@@@~$@@@@A@~4$F@@@@PF~~~~~~~~~F4@@@@@@@@@@@@@@@@@@@@@@
@@@@@@@@@MFR@4@@@ \`     ~                 ~~R@@@@@@@@@@@@@@@@@
@@@@@@@@@@     ~~                             ~@@@@@@@@@@@@@@@
@@@@@@@@@@@                                     ~@@@@@@@@@@@@@
@@@@@@@@@@Py                                      #@@@@@@@@@@@
@@@@@@$g=a- ~                                      $@@@@@@@@@@
@@@@@@@@F                                          4@@@@@@@@@@
@@@@F~\`                     g                       $@@@@@@@@@
@@@@@@@gg-y-_           _,  $_                      4@@@@@@@@@
@@@@@@@@Rgym^      ,    f' 4@@,.     ,   _          4@@@@@@@@@
@@@@@@WP@$P       :          yB$gg$yy$   ^           @@@@@@@@@
@@@@@$@@F\` _\\- _.i      agggg@@@@@@@@@y_   gw        $@@@@@@@@
@@@@@@$y_  \` ~ g@"9     "@@@@@@@@@@@@@@@@@@$<        M@@@@@@@@
@@@@@@@@@@F    \`         @$@@@@@@@@@@@@@@@P          L@@@@@@@@
@@@@@@@@@@$_             ~@@@@@@@@@@@@@@@P~          l0@@@@@@@
@@@@@@@@@@@@g y            \`~R@@@@@@@PF~              @@@@@@@@
@@@@@@@@@@@@@y@                ~FT~y                  4M@@@@@@
@@@@@@@@@@@@ F              Jgygg@@@ jy             _  '@@@@@@
@@@@@@@@@@@Fy^               0@@@@@@@@@              @y 4@@@@@
@@@@@@@@@@5y^              _g$$@@@@@@@$              \`E$ 9@@@@
@@@@@@@@@y$\`              a@F\`"FTF~~@@$               \`@$"@@@@
@@@@@@@@yF                9\`         4F       Z_       ~$ $@@@
@@@@@@@F_aF      __         qy     g,         F$        \` 4@@@
@@@@@@F,@~       \`WL       J@@     4$_  ^    sy'          4@@@
`;
export function printStartupBanner() {
    logBanner(BANNER_ART);
    info("早期测试版本，本人能力有限，不保证全功能稳定，欢迎提 PR 、issue 共同维护");
    info("https://github.com/Richie-liu111/ManosabaMod");
}

✄
import { A, dbg, directCall, findClassAcrossImages, makeS, readStr, wblog } from "./utils.js";
var chapterMap = null;
var offs = null; // {playbackSpot, scriptPath, subTitleLabel}
var hooked = false;
var hookedAddrs = {}; // methodPointer 去重: 子类未 override 虚方法时两类的 cgm 同指, 只 attach 一次
function resolveOffsets() {
    try {
        var o = {};
        var gsm = findClassAcrossImages("Naninovel", "GameStateMap");
        if (gsm.isNull())
            return null;
        var f = A.gf(gsm, Memory.allocUtf8String("playbackSpot"));
        if (!f || f.isNull())
            return null;
        o.playbackSpot = A.fo(f);
        o.scriptPath = 0; // 见头部注释: 实证固定 0
        // _subTitleLabel 定义在基类 GameStateSlotExtended (实例偏移一致)
        var gsse = findClassAcrossImages("GigaCreation.NaninovelExtender.Ui", "GameStateSlotExtended");
        if (gsse.isNull())
            return null;
        var f3 = A.gf(gsse, Memory.allocUtf8String("_subTitleLabel"));
        if (!f3 || f3.isNull())
            return null;
        o.subTitleLabel = A.fo(f3);
        return o;
    }
    catch (e) {
        dbg("[v3] chapterdisplay resolveOffsets err: " + e);
        return null;
    }
}
// 命中映射则覆写 _subTitleLabel; 未命中/指针非法时静默 (原版路径完全走原版行为)
// logIt=false (onLeave 兜底覆写) 不打日志 — 与 onEnter 同一调用, 重复无信息量
function applyChapterName(slotPtr, statePtr, logIt) {
    if (!statePtr || statePtr.isNull() || !slotPtr || slotPtr.isNull())
        return;
    if (statePtr.toInt32() < 0x10000 || slotPtr.toInt32() < 0x10000)
        return;
    var spot = statePtr.add(offs.playbackSpot);
    var sp = spot.add(offs.scriptPath).readPointer();
    if (sp.isNull() || sp.toInt32() < 0x10000)
        return;
    var path = readStr(sp);
    if (!path)
        return;
    var name = chapterMap[path];
    if (!name)
        return;
    var lab = slotPtr.add(offs.subTitleLabel).readPointer();
    if (lab.isNull() || lab.toInt32() < 0x10000)
        return;
    var labCls = null;
    try {
        labCls = A.ogc(lab);
    }
    catch (e) {
        return;
    }
    if (!labCls || labCls.isNull())
        return;
    var rt = A.cgm(labCls, Memory.allocUtf8String("set_richText"), 1);
    if (rt && !rt.isNull())
        directCall(rt, 'void', [lab, ptr(1)]);
    var st = A.cgm(labCls, Memory.allocUtf8String("set_text"), 1);
    if (st && !st.isNull())
        directCall(st, 'void', [lab, makeS(name)]);
    if (logIt)
        wblog("存档槽章节名: " + path + " → " + name);
}
export function setupChapterDisplayHooks() {
    try {
        if (hooked)
            return;
        hooked = true;
        if (typeof chapterNames === "undefined" || !chapterNames) {
            dbg("[v3] chapterNames 未注入 (无 mod 声明 ChapterNames), 跳过章节名模块");
            return;
        }
        var keys = Object.keys(chapterNames);
        if (!keys.length) {
            dbg("[v3] chapterNames 为空, 跳过章节名模块");
            return;
        }
        chapterMap = chapterNames;
        offs = resolveOffsets();
        if (!offs) {
            dbg("[v3] !! 章节名字段解析失败, 跳过");
            return;
        }
        dbg("[v3] chapter: offsets playbackSpot=" + offs.playbackSpot +
            " scriptPath=" + offs.scriptPath + " subTitleLabel=" + offs.subTitleLabel);
        // 实际实例是 WitchTrialsGameStateSlot (子类), C# 蓝本 patch 基类 → 两个都 hook
        var candidates = [
            ["WitchTrials.Views", "WitchTrialsGameStateSlot"],
            ["GigaCreation.NaninovelExtender.Ui", "GameStateSlotExtended"]
        ];
        var hookCount = 0;
        candidates.forEach(function (c) {
            var cls = findClassAcrossImages(c[0], c[1]);
            if (cls.isNull())
                return;
            var mi = A.cgm(cls, Memory.allocUtf8String("SetNonEmptyState"), 2);
            if (!mi || mi.isNull())
                return;
            var mp = mi.readPointer();
            if (hookedAddrs[mp.toString()]) { // 同一实现 (子类未 override) 只 attach 一次, 避免双日志
                dbg("[v3] chapter: " + c[1] + " 与已 hook 实现同址 (" + mp + "), 跳过重复 attach");
                return;
            }
            hookedAddrs[mp.toString()] = true;
            Interceptor.attach(mp, {
                onEnter: function (a) {
                    // 实例方法: a[0]=this(slot), a[1]=slotNumber(int), a[2]=state(GameStateMap)
                    this.self = a[0];
                    this.state = a[2];
                    try {
                        applyChapterName(a[0], a[2], true);
                    }
                    catch (e) {
                        dbg("[v3] chapter onEnter err: " + e);
                    }
                },
                onLeave: function () {
                    // 兜底覆写: 原版 SetSubTitleText 正常返回把文本改回时再覆写; 静默 (同一调用)
                    try {
                        applyChapterName(this.self, this.state, false);
                    }
                    catch (e) {
                        dbg("[v3] chapter onLeave err: " + e);
                    }
                }
            });
            hookCount++;
            dbg("[v3] chapter: hooked " + c[1] + ".SetNonEmptyState @ " + mp);
        });
        if (!hookCount) {
            dbg("[v3] !! 存档槽 SetNonEmptyState(2) 均未找到, 跳过章节名模块");
            return;
        }
        wblog("章节名模块已装载 (" + keys.length + " 个条目, " + hookCount + " 个 hook)");
    }
    catch (e) {
        dbg("[v3] chapterdisplay init err: " + e);
    }
}

✄
// ============ @choice handler 支持 — 重写 v2 (2026-08-11) ============
// 镜像 C# ModChoiceHandlerLoader.cs (唯一已验证路径)。13 轮 AV 补丁版已归档
// (backup_choice_20260811.js); 本文件不包含: 寄存器钩 / 假对象 / dict 覆盖钩 /
// 手工 actor 构造 / 崩溃 fixer。
//
// 探针 probe_choice_real.js run 8 实证 (macOS 全部可走):
//   R1: VirtualResourceProvider 0参ctor invoke OK, Resources@0x28 = 真空 Dictionary`2
//   R2: Resource`1<GameObject> .ctor(2)[System.String, UnityEngine.GameObject] invoke OK
//       (inflated 类 = 触发 buttonLoader.LoadAsync("ChoiceButtons/Trial/Objection")
//       后从 LocalizableResourceLoader`1.LoadedByFullPath 缓存条目偷取)
//   R3: Resources.Add(path, res) + ContainsKey(path)=true + 物理扫描=true 全通
//       (内容哈希实证: makeS key 与游戏真实 string key 判定同一 key →
//        "makeS 不能当字典 key" 理论物理不成立, 直接 makeS 即可)
//   R4: Metadata.AddRecord(id, meta) + ContainsId=true + providersMap.Add + GetProvider 全通
//   (bool 返回值必须读装箱: il2cpp_runtime_invoke 对值类型返回装箱 Boolean, value@+0x10;
//    run 7 的 ContainsKey=false 是直接 readU8() 读 klass 指针低位的误读)
//
// 流程 (对齐 C# 生命周期):
//   initChoiceHandlers (Title): 读 info.json ChoiceHandlers → 预载立绘
//   triggerSourcePanelLoad: GetOrAddActor("Trial") + 按钮 LoadAsync (fire-and-forget,
//       让源面板 + Resource`1<GameObject> 出现 — 探针实证这俩触发有效)
//   CustomUI.Awake hook → TrialChoiceHandlerPanel: tryFinalizeChoiceHandlers
//   tryFinalizeChoiceHandlers: 找源面板 → 共享 vrp → 逐 handler 克隆+换立绘 →
//       Resource ctor + Resources.Add + ContainsKey 自验证 → AddRecord + ContainsId 验证 →
//       providersMap.Add + GetProvider 验证 → registered
//   之后 actor 由游戏自己构造 (GetOrAddActor → Activator → LoadUIPrefabAsync →
//       provider 链 → 我们的 vrp.Resources); 只读诊断钩子确认游戏走到哪一步。
import { A, dbg, fieldOffset, findAllObjectOfType, findClassAcrossImages, findSvc, getSystemClass, invoke, invokeOk, makeS, pngDims, readStr, warn } from "./utils.js";
import { fileReadBytes, readJSONFile } from "./io.js";
import { info } from "./log.js";
import { startReinjectWindow } from "./providers.js";
var chCls = null; // 解析好的类表
var chData = {
    handlers: [],
    metaMap: null,
    providerKey: "ModChoiceHandlers",
    vrp: null,
    cloned: {},
    registeredIds: {},
    registered: false,
    finalizing: false,
    resGOClass: null, // 偷到的 Resource`1<GameObject> inflated 类
};
var chGOTriggered = false; // 触发只做一次 (探针实证一次性有效)
var chPollTimer = null;
// ============ 类解析 ============
function resolveChoiceHandlerClasses() {
    var m = {};
    m.trialPanel = findClassAcrossImages("WitchTrials.Views", "TrialChoiceHandlerPanel");
    m.customUI = findClassAcrossImages("Naninovel.UI", "CustomUI");
    m.image = findClassAcrossImages("UnityEngine.UI", "Image");
    m.rectTransform = findClassAcrossImages("UnityEngine", "RectTransform");
    m.gameObject = findClassAcrossImages("UnityEngine", "GameObject");
    m.component = findClassAcrossImages("UnityEngine", "Component");
    m.object = findClassAcrossImages("UnityEngine", "Object");
    m.sprite = findClassAcrossImages("UnityEngine", "Sprite");
    m.texture2d = findClassAcrossImages("UnityEngine", "Texture2D");
    m.imageConversion = findClassAcrossImages("UnityEngine", "ImageConversion");
    m.vrp = findClassAcrossImages("Naninovel", "VirtualResourceProvider");
    m.resource = findClassAcrossImages("Naninovel", "Resource"); // base Resource
    m.resourceLoaderConfig = findClassAcrossImages("Naninovel", "ResourceLoaderConfiguration");
    m.choiceHandlerMeta = findClassAcrossImages("Naninovel", "ChoiceHandlerMetadata");
    m.uih = findClassAcrossImages("Naninovel", "UIChoiceHandler");
    return m;
}
// ============ 数据加载 (Title 时调用) ============
function loadChoiceHandlerData() {
    chData.handlers = [];
    if (typeof MOD_ROOT === "undefined" || typeof modList === "undefined" || !modList || !modList.length)
        return;
    for (var i = 0; i < modList.length; i++) {
        var root = MOD_ROOT + "/" + modList[i].key;
        var inf = readJSONFile(root + "/info.json"); // 注意: 变量名不能叫 info (遮蔽 import 的 info 日志函数)
        if (!inf || !inf.ChoiceHandlers)
            continue;
        for (var c = 0; c < inf.ChoiceHandlers.length; c++) {
            var ch = inf.ChoiceHandlers[c];
            if (!ch || !ch.Id || !ch.Portrait)
                continue;
            chData.handlers.push({ id: ch.Id, basePanel: ch.BasePanel || "Trial", portraitPath: root + "/" + ch.Portrait, sprite: null });
            dbg("[Choice] 待注册 handler '" + ch.Id + "' (base=" + (ch.BasePanel || "Trial") + ")");
        }
    }
    if (chData.handlers.length)
        info("[Choice] 共 " + chData.handlers.length + " 个 mod choice handler");
}
// 读立绘 PNG → Texture2D, 返回 {tex,w,h}
function chLoadTexture(path) {
    try {
        var fb = fileReadBytes(path);
        if (!fb || fb.size <= 0) {
            warn("[Choice] 读立绘失败 '" + path + "'");
            return null;
        }
        var dims = pngDims(fb);
        if (!dims) {
            warn("[Choice] PNG 尺寸读取失败 '" + path + "'");
            return null;
        }
        var byteCls = getSystemClass("Byte");
        var barr = A.an(byteCls, fb.size);
        barr.add(0x20).writeByteArray(fb.buf.readByteArray(fb.size));
        var tex = A.on(chCls.texture2d);
        var wbuf = Memory.alloc(4);
        wbuf.writeS32(dims.w);
        var hbuf = Memory.alloc(4);
        hbuf.writeS32(dims.h);
        var ctorMi = A.cgm(chCls.texture2d, Memory.allocUtf8String(".ctor"), 2);
        if (ctorMi && !ctorMi.isNull())
            invokeOk(ctorMi, tex, [wbuf, hbuf]);
        var liMi = A.cgm(chCls.imageConversion, Memory.allocUtf8String("LoadImage"), 2);
        if (!liMi || liMi.isNull()) {
            warn("[Choice] ImageConversion.LoadImage NOT FOUND");
            return null;
        }
        var r = invokeOk(liMi, ptr(0), [tex, barr]);
        if (!r.ok) {
            warn("[Choice] LoadImage 失败 '" + path + "'");
            return null;
        }
        return { tex: tex, w: dims.w, h: dims.h };
    }
    catch (e) {
        warn("[Choice] chLoadTexture err '" + path + "': " + e);
        return null;
    }
}
// Sprite.Create — choice 立绘用原版 ChoicePortrait pivot(0.31,0.5)/ppu100 (5 参重载, 4 参 macOS 崩)
function chMakeSprite(ent) {
    try {
        if (!ent || !ent.tex || ent.tex.isNull() || !ent.w || !ent.h) {
            warn("[Choice] 立绘参数无效, 跳过 Sprite.Create");
            return null;
        }
        var rect = Memory.alloc(16);
        rect.writeFloat(0);
        rect.add(4).writeFloat(0);
        rect.add(8).writeFloat(ent.w);
        rect.add(12).writeFloat(ent.h);
        var pivot = Memory.alloc(8);
        pivot.writeFloat(0.31);
        pivot.add(4).writeFloat(0.5);
        var ppuPtr = Memory.alloc(4);
        ppuPtr.writeFloat(100);
        var createMi = A.cgm(chCls.sprite, Memory.allocUtf8String("Create"), 5);
        if (!createMi || createMi.isNull()) {
            warn("[Choice] Sprite.Create NOT FOUND");
            return null;
        }
        var extrude = Memory.alloc(4);
        extrude.writeU32(0);
        var r = invokeOk(createMi, ptr(0), [ent.tex, rect, pivot, ppuPtr, extrude]);
        if (!r.ok) {
            warn("[Choice] Sprite.Create FAIL");
            return null;
        }
        return r.ret;
    }
    catch (e) {
        warn("[Choice] chMakeSprite err: " + e);
        return null;
    }
}
function registerChoiceHandlers() {
    try {
        if (!chCls || !chCls.texture2d || chCls.texture2d.isNull()) {
            warn("[Choice] 类未解析, 跳过立绘预加载");
            return;
        }
        for (var i = 0; i < chData.handlers.length; i++) {
            var hd = chData.handlers[i];
            if (hd.sprite)
                continue;
            var ent = chLoadTexture(hd.portraitPath);
            if (!ent)
                continue;
            hd.sprite = chMakeSprite(ent);
            if (hd.sprite)
                info("[Choice] 立绘已加载 '" + hd.id + "' (" + ent.w + "x" + ent.h + ")");
        }
    }
    catch (e) {
        warn("[Choice] registerChoiceHandlers err: " + e);
    }
}
function chObjName(p) {
    try {
        if (!p || p.isNull())
            return null;
        var nmMi = A.cgm(chCls.object, Memory.allocUtf8String("get_name"), 0);
        if (!nmMi || nmMi.isNull())
            return null;
        return readStr(invoke(nmMi, p, []));
    }
    catch (e) {
        return null;
    }
}
// 换立绘: 遍历克隆子树 Image, 优先 sprite 名以 "ChoicePortrait_" 开头, 退化选 RectTransform 最高
function chSwapPortrait(clone, sprite) {
    try {
        var go = clone;
        try {
            var ggMi = A.cgm(chCls.component, Memory.allocUtf8String("get_gameObject"), 0);
            if (ggMi && !ggMi.isNull()) {
                var g2 = invoke(ggMi, clone, []);
                if (g2 && !g2.isNull())
                    go = g2;
            }
        }
        catch (e) { }
        var gicMi = A.cgm(chCls.gameObject, Memory.allocUtf8String("GetComponentsInChildren"), 2);
        if (!gicMi || gicMi.isNull()) {
            warn("[Choice] GetComponentsInChildren NOT FOUND");
            return false;
        }
        var typeObj = A.tgo(A.cgt(chCls.image));
        var tbool = Memory.alloc(4);
        tbool.writeS32(1);
        var imgArr = invoke(gicMi, go, [typeObj, tbool]);
        var getSprMi = A.cgm(chCls.image, Memory.allocUtf8String("get_sprite"), 0);
        var best = null, bestScore = -1;
        var len = imgArr ? imgArr.add(0x18).readS32() : 0;
        for (var i = 0; i < len; i++) {
            var img = imgArr.add(0x20 + i * 8).readPointer();
            if (!img || img.isNull())
                continue;
            var sp = (getSprMi && !getSprMi.isNull()) ? invoke(getSprMi, img, []) : ptr(0);
            var spName = sp && !sp.isNull() ? chObjName(sp) : "";
            var score = (spName && spName.indexOf("ChoicePortrait_") === 0) ? 10000 : 0;
            if (score === 0) {
                try {
                    var grtMi = A.cgm(chCls.image, Memory.allocUtf8String("get_rectTransform"), 0);
                    var rtMi = A.cgm(chCls.rectTransform, Memory.allocUtf8String("get_rect"), 0);
                    var rt = (grtMi && !grtMi.isNull() && rtMi && !rtMi.isNull()) ? invoke(rtMi, invoke(grtMi, img, []), []) : null;
                    if (rt && !rt.isNull())
                        score = Math.abs(rt.add(12).readFloat()); // Rect.height
                }
                catch (e2) { }
            }
            if (score > bestScore) {
                bestScore = score;
                best = img;
            }
        }
        if (best) {
            var setSprMi = A.cgm(chCls.image, Memory.allocUtf8String("set_sprite"), 1);
            if (setSprMi && !setSprMi.isNull())
                invoke(setSprMi, best, [sprite]);
            var snsMi = A.cgm(chCls.image, Memory.allocUtf8String("SetNativeSize"), 0);
            if (snsMi && !snsMi.isNull())
                invoke(snsMi, best, []);
            info("[Choice] 立绘替换完成: '" + chObjName(clone) + "'");
            return true;
        }
        warn("[Choice] 未找到 portrait Image (len=" + len + ")");
    }
    catch (e) {
        warn("[Choice] chSwapPortrait err: " + e);
    }
    return false;
}
// ============ Resource`1<GameObject> inflated 类捕获 ============
// (探针实证: def 类 Resource(string,Object) ctor hook 抓不到 inflated 调用 — "泛型类方法不共享";
//  有效路径 = 触发按钮加载后从 LoadedByFullPath 缓存条目偷取)
function chFindResourceLoader() {
    var mgr = findSvc("ChoiceHandlerManager", true);
    if (!mgr)
        mgr = findSvc("WitchTrialsChoiceHandlerManager");
    if (!mgr) {
        dbg("[Choice] steal: mgr NOT FOUND");
        return null;
    }
    var cands = [0x38, 0x40, 0x48, 0x50, 0x58, 0x60, 0x68, 0x70, 0x78, 0x80, 0x88, 0x90];
    for (var i = 0; i < cands.length; i++) {
        try {
            var p = mgr.add(cands[i]).readPointer();
            if (!p || p.isNull())
                continue;
            var cn = A.cgn(A.ogc(p)).readCString();
            if (cn && cn.indexOf("ResourceLoader") >= 0) {
                dbg("[Choice] steal: ResourceLoader @0x" + cands[i].toString(16) + " = " + cn);
                return p;
            }
        }
        catch (e) { }
    }
    return null;
}
function chStealResourceGOClass() {
    try {
        var rl = chFindResourceLoader();
        if (!rl || rl.isNull())
            return null;
        var rlKlass = A.ogc(rl);
        chData.rlKlass = rlKlass; // 供 diag hook: ResourceLoader`1<GameObject> 泛型类 (inflated, 特化体已生成)
        var out = null;
        ["LoadedByFullPath", "LoadedByLocalPath"].forEach(function (fname) {
            if (out)
                return;
            try {
                var f = A.gf(rlKlass, Memory.allocUtf8String(fname));
                if (!f || f.isNull())
                    return;
                var dict = rl.add(A.fo(f)).readPointer();
                if (!dict || dict.isNull())
                    return;
                var ents = dict.add(0x18).readPointer();
                if (!ents || ents.isNull())
                    return;
                var al = ents.add(0x18).readS32();
                for (var e = 0; e < al; e++) {
                    var eb = ents.add(0x20 + e * 24);
                    if (eb.readS32() === -1)
                        continue;
                    var lr = eb.add(16).readPointer();
                    if (lr.isNull())
                        continue;
                    var sysRes = lr.add(0x10).readPointer(); // LoadedResource<T>.Resource
                    if (sysRes && !sysRes.isNull()) {
                        out = sysRes.readPointer();
                        return;
                    }
                }
            }
            catch (e2) { }
        });
        if (out) {
            chData.resGOClass = out;
            dbg("[Choice] 捕获 Resource<GameObject> klass=" + A.cgn(out).readCString() + " (from " + (chData.resGOClass ? "loaded cache" : "cache") + ")");
        }
        return out;
    }
    catch (e) {
        dbg("[Choice] chStealResourceGOClass err: " + e);
        return null;
    }
}
// ============ 触发 (探针实证有效: GetOrAddActor + 按钮 LoadAsync 双触发) ============
function chTriggerGOClass() {
    try {
        if (chGOTriggered)
            return;
        chGOTriggered = true;
        var mgr = findSvc("ChoiceHandlerManager", true);
        if (!mgr)
            mgr = findSvc("WitchTrialsChoiceHandlerManager");
        if (!mgr || mgr.isNull()) {
            chGOTriggered = false;
            return;
        }
        var cfg = null;
        for (var o = 0x10; o <= 0x80 && !cfg; o += 8) {
            try {
                var c = mgr.add(o).readPointer();
                if (c.isNull())
                    continue;
                if (A.cgn(A.ogc(c)).readCString() === "ChoiceHandlersConfiguration")
                    cfg = c;
            }
            catch (e) { }
        }
        var trigId = "Trial";
        if (cfg && !cfg.isNull()) {
            try {
                var dhid = readStr(cfg.add(0x28).readPointer());
                if (dhid)
                    trigId = dhid;
            }
            catch (e) { }
        }
        try {
            var goaMi = A.cgm(A.ogc(mgr), Memory.allocUtf8String("GetOrAddActor"), 1);
            if (goaMi && !goaMi.isNull()) {
                invoke(goaMi, mgr, [makeS("Trial")]);
                if (trigId !== "Trial")
                    invoke(goaMi, mgr, [makeS(trigId)]);
                dbg("[Choice] 触发 GetOrAddActor('Trial')" + (trigId !== "Trial" ? "+'" + trigId + "'" : "") + " (fire-and-forget)");
            }
        }
        catch (e5) {
            dbg("[Choice] 触发 GetOrAddActor err: " + e5);
        }
        try {
            var bl = mgr.add(0x58).readPointer();
            if (bl && !bl.isNull()) {
                var laMi = ptr(0);
                [2, 1].forEach(function (ac) {
                    if (laMi && !laMi.isNull())
                        return;
                    try {
                        laMi = A.cgm(A.ogc(bl), Memory.allocUtf8String("LoadAsync"), ac);
                    }
                    catch (e) { }
                });
                if (!laMi || laMi.isNull()) {
                    try {
                        laMi = A.cgm(A.ogc(bl), Memory.allocUtf8String("Load"), 2);
                    }
                    catch (e) { }
                }
                if (laMi && !laMi.isNull()) {
                    invoke(laMi, bl, [makeS("ChoiceButtons/Trial/Objection"), ptr(0)]);
                    dbg("[Choice] 触发按钮加载 ChoiceButtons/Trial/Objection (fire-and-forget)");
                }
            }
        }
        catch (e4) {
            dbg("[Choice] 按钮加载 err: " + e4);
        }
    }
    catch (e) {
        warn("[Choice] chTriggerGOClass err: " + e);
    }
}
// ============ bool 返回值 (探针 run 7 教训: 值类型返回装箱, 直接 readU8 是 klass 指针低位) ============
function chBool(r) {
    var ret = r && r.ok ? r.ret : null;
    if (!ret || ret.isNull())
        return false;
    try {
        var k = A.cgn(A.ogc(ret)).readCString() || "";
        if (k.indexOf("Boolean") >= 0)
            return ret.add(0x10).readU8() === 1;
    }
    catch (e) { }
    return ret.readU8() === 1;
}
// ============ 托管链 (镜像 C# 四步, 全部 invoke + 自验证) ============
// R1: 共享 VRP 构造 (0参ctor; 探针实证 Resources@0x28 是 ctor 建好的真空 Dictionary`2)
function chEnsureVrp() {
    if (chData.vrp && !chData.vrp.isNull())
        return chData.vrp;
    var vrp = A.on(chCls.vrp);
    var ctor = A.cgm(chCls.vrp, Memory.allocUtf8String(".ctor"), 0);
    var r = ctor && !ctor.isNull() ? invokeOk(ctor, vrp, []) : { ok: false, ex: "无 0参 ctor" };
    if (!r.ok) {
        warn("[Choice] VRP ctor FAIL (invoke 异常, 详见日志)");
        return null;
    }
    var resDict = vrp.add(fieldOffset(chCls.vrp, "Resources", 0x28)).readPointer();
    if (!resDict || resDict.isNull()) {
        warn("[Choice] VRP.Resources 为空 — 地基坏, 中止");
        return null;
    }
    chData.vrp = vrp;
    chData.vrpDict = resDict;
    dbg("[Choice] R1: VRP 构造成功 vrp=" + vrp + " Resources=" + resDict + " (" + A.cgn(A.ogc(resDict)).readCString() + ")");
    return vrp;
}
// R2: 真 Resource`1<GameObject> 构造 (2参ctor invoke; 探针实证读回 path/object 正确)
function chMakeResourceGO(path, obj) {
    var cls = chData.resGOClass;
    if (!cls || cls.isNull()) {
        warn("[Choice] Resource<GameObject> 类未捕获, 先触发");
        chTriggerGOClass();
        return null;
    }
    var res = A.on(cls);
    var ctor2 = A.cgm(cls, Memory.allocUtf8String(".ctor"), 2);
    var r = ctor2 && !ctor2.isNull() ? invokeOk(ctor2, res, [makeS(path), obj]) : { ok: false };
    if (!r.ok) {
        warn("[Choice] Resource ctor FAIL '" + path + "'");
        return null;
    }
    var pback = readStr(res.add(0x10).readPointer());
    if (pback !== path) {
        warn("[Choice] Resource 读回 path 不符 '" + pback + "' vs '" + path + "'");
        return null;
    }
    dbg("[Choice] R2: Resource<GameObject> '" + path + "' 构造成功 res=" + res + " obj=" + res.add(0x18).readPointer());
    return res;
}
// R3: Resources.Add + ContainsKey 自验证 (探针实证全通; 内容哈希 → makeS key 即真实 key)
function chServeResource(path, res) {
    var dict = chData.vrp.add(fieldOffset(chCls.vrp, "Resources", 0x28)).readPointer();
    var dictCls = A.ogc(dict);
    var addMi = A.cgm(dictCls, Memory.allocUtf8String("Add"), 2);
    var ckMi = A.cgm(dictCls, Memory.allocUtf8String("ContainsKey"), 1);
    if (!addMi || addMi.isNull() || !ckMi || ckMi.isNull()) {
        warn("[Choice] Resources.Add/ContainsKey NOT FOUND");
        return false;
    }
    var ar = invokeOk(addMi, dict, [makeS(path), res]);
    if (!ar.ok) {
        warn("[Choice] Resources.Add FAIL '" + path + "'");
        return false;
    }
    var ck = invokeOk(ckMi, dict, [makeS(path)]);
    var ck2 = invokeOk(ckMi, dict, [makeS(path + "__NOPE__")]);
    var ok = chBool(ck) && !chBool(ck2);
    dbg("[Choice] R3: Resources.Add('" + path + "') 成功 ContainsKey=" + chBool(ck) + " 对照组=" + chBool(ck2) + " 结果=" + (ok ? "正常" : "异常"));
    return ok;
}
// R4: meta 构造 + AddRecord + ContainsId 验证 (Implementation 从 vanilla Trial meta 逐字节复制)
function chRegisterMeta(hd) {
    try {
        if (chData.registeredIds[hd.id])
            return true;
        var metaMap = chData.metaMap;
        var meta = A.on(chCls.choiceHandlerMeta);
        var mctor = A.cgm(chCls.choiceHandlerMeta, Memory.allocUtf8String(".ctor"), 0);
        var mr = mctor && !mctor.isNull() ? invokeOk(mctor, meta, []) : { ok: false, ex: "无 0参 ctor" };
        if (!mr.ok) {
            warn("[Choice] meta ctor FAIL (invoke 异常)");
            return false;
        }
        // Implementation: vanilla Trial meta 的真实串 (探针实证可读)
        var implStr = "Naninovel.UIChoiceHandler, Elringus.Naninovel.Runtime, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null";
        try {
            var gmMi = A.cgm(A.ogc(metaMap), Memory.allocUtf8String("GetMetadata"), 1);
            if (gmMi && !gmMi.isNull()) {
                var vm = invokeOk(gmMi, metaMap, [makeS("Trial")]);
                if (vm.ok && vm.ret && !vm.ret.isNull()) {
                    var vs = readStr(vm.ret.add(fieldOffset(chCls.choiceHandlerMeta, "Implementation", 0x10)).readPointer());
                    if (vs)
                        implStr = vs;
                }
            }
        }
        catch (e) { }
        meta.add(fieldOffset(chCls.choiceHandlerMeta, "Implementation", 0x10)).writePointer(makeS(implStr));
        // Loader: 真 ResourceLoaderConfiguration (PathPrefix + ProviderTypes)
        var loader = A.on(chCls.resourceLoaderConfig);
        var lctor = A.cgm(chCls.resourceLoaderConfig, Memory.allocUtf8String(".ctor"), 0);
        var lr = lctor && !lctor.isNull() ? invokeOk(lctor, loader, []) : { ok: false, ex: "无 0参 ctor" };
        if (!lr.ok) {
            warn("[Choice] loader ctor FAIL (invoke 异常)");
            return false;
        }
        loader.add(fieldOffset(chCls.resourceLoaderConfig, "PathPrefix", 0x10)).writePointer(makeS(chData.providerKey));
        // ProviderTypes List<string>: 从 vanilla loader 偷 List<string> 类 (探针实证有效)
        try {
            var gm2 = invokeOk(A.cgm(A.ogc(metaMap), Memory.allocUtf8String("GetMetadata"), 1), metaMap, [makeS("Trial")]);
            if (gm2.ok && gm2.ret && !gm2.ret.isNull()) {
                var vLoader = gm2.ret.add(fieldOffset(chCls.choiceHandlerMeta, "Loader", 0x18)).readPointer();
                var vpt = vLoader.add(fieldOffset(chCls.resourceLoaderConfig, "ProviderTypes", 0x18)).readPointer();
                if (vpt && !vpt.isNull()) {
                    var listCls = A.ogc(vpt);
                    var list = A.on(listCls);
                    var lc = A.cgm(listCls, Memory.allocUtf8String(".ctor"), 0);
                    if (lc && !lc.isNull()) {
                        var lcr = invokeOk(lc, list, []);
                        if (!lcr.ok)
                            warn("[Choice] ProviderTypes List ctor FAIL: " + lcr.ex);
                    }
                    else
                        warn("[Choice] ProviderTypes List ctor NOT FOUND");
                    var laMi = A.cgm(listCls, Memory.allocUtf8String("Add"), 1);
                    if (laMi && !laMi.isNull()) {
                        var lar = invokeOk(laMi, list, [makeS(chData.providerKey)]);
                        if (!lar.ok)
                            warn("[Choice] ProviderTypes List.Add('" + chData.providerKey + "') FAIL: " + lar.ex);
                    }
                    else
                        warn("[Choice] ProviderTypes List.Add NOT FOUND");
                    loader.add(fieldOffset(chCls.resourceLoaderConfig, "ProviderTypes", 0x18)).writePointer(list);
                    // 读回自验证 (2026-08-11 源码对照: GetProviders 遍历 ProviderTypes, 空列表 → 永远无 vrp → Load 直接 Invalid)
                    try {
                        var lsz = list.add(0x18).readS32();
                        var lit = list.add(0x10).readPointer();
                        var l0 = (lsz > 0 && lit && !lit.isNull() && lit.add(0x18).readS32() > 0) ? readStr(lit.add(0x20).readPointer()) : null;
                        dbg("[Choice] ProviderTypes 读回: size=" + lsz + " [0]='" + (l0 || "?") + "'");
                        if (lsz !== 1 || l0 !== chData.providerKey)
                            warn("[Choice] ProviderTypes 内容异常! 游戏 GetProviders 将拿不到 '" + chData.providerKey + "' (疑似根因)");
                    }
                    catch (e) {
                        warn("[Choice] ProviderTypes 读回 err: " + e);
                    }
                }
            }
        }
        catch (e) {
            dbg("[Choice] ProviderTypes 构造 err: " + e);
        }
        meta.add(fieldOffset(chCls.choiceHandlerMeta, "Loader", 0x18)).writePointer(loader);
        try {
            meta.add(fieldOffset(chCls.choiceHandlerMeta, "WaitHideOnChoice", 0x30)).writeU8(0);
        }
        catch (e) { }
        // 读回核对
        var implBack = readStr(meta.add(fieldOffset(chCls.choiceHandlerMeta, "Implementation", 0x10)).readPointer());
        var ldrBack = meta.add(fieldOffset(chCls.choiceHandlerMeta, "Loader", 0x18)).readPointer();
        var pfxBack = readStr(loader.add(fieldOffset(chCls.resourceLoaderConfig, "PathPrefix", 0x10)).readPointer());
        dbg("[Choice] meta 读回: id='" + hd.id + "' Impl='" + (implBack || "") + "' Loader=" + (ldrBack && !ldrBack.isNull() ? "0x" + ldrBack.toString() : "NULL") + " PathPrefix='" + (pfxBack || "") + "'");
        // AddRecord + ContainsId 自验证 (探针实证: 装箱 bool 必须 chBool 读)
        var arMi = A.cgm(A.ogc(metaMap), Memory.allocUtf8String("AddRecord"), 2);
        if (!arMi || arMi.isNull()) {
            warn("[Choice] AddRecord NOT FOUND");
            return false;
        }
        var ar = invokeOk(arMi, metaMap, [makeS(hd.id), meta]);
        if (!ar.ok) {
            warn("[Choice] AddRecord FAIL '" + hd.id + "'");
            return false;
        }
        var hasMi = A.cgm(A.ogc(metaMap), Memory.allocUtf8String("ContainsId"), 1);
        var hv = hasMi && !hasMi.isNull() ? invokeOk(hasMi, metaMap, [makeS(hd.id)]) : { ok: false };
        if (!chBool(hv)) {
            warn("[Choice] AddRecord 后 ContainsId('" + hd.id + "') = false — 未生效");
            return false;
        }
        chData.registeredIds[hd.id] = true;
        dbg("[Choice] R4: AddRecord('" + hd.id + "') + ContainsId 通过");
        return true;
    }
    catch (e) {
        warn("[Choice] chRegisterMeta err: " + e);
        return false;
    }
}
// providersMap.Add + GetProvider 验证 (探针实证 GetProvider 返回我们的 vrp)
function chRegisterProvider() {
    try {
        var rpm = findSvc("ResourceProviderManager");
        if (!rpm) {
            warn("[Choice] ResourceProviderManager NOT FOUND");
            return false;
        }
        var pm = rpm.add(fieldOffset(A.ogc(rpm), "providersMap", 0x20)).readPointer();
        if (!pm || pm.isNull()) {
            warn("[Choice] providersMap NULL");
            return false;
        }
        var addMi = A.cgm(A.ogc(pm), Memory.allocUtf8String("Add"), 2);
        if (addMi && !addMi.isNull()) {
            var ar = invokeOk(addMi, pm, [makeS(chData.providerKey), chData.vrp]);
            if (ar.ok)
                dbg("[Choice] providersMap.Add('" + chData.providerKey + "', vrp) 成功");
            else {
                warn("[Choice] providersMap.Add FAIL (invoke 异常)");
                return false;
            }
        }
        // GetProvider 在 ResourceProviderManager 上 (不在 providersMap 字典上)
        try {
            var gpMi = A.cgm(A.ogc(rpm), Memory.allocUtf8String("GetProvider"), 1);
            if (gpMi && !gpMi.isNull()) {
                var gpr = invokeOk(gpMi, rpm, [makeS(chData.providerKey)]);
                var gret = gpr.ok ? gpr.ret : ptr(0);
                if (gret && !gret.isNull() && gret.equals(chData.vrp))
                    dbg("[Choice] GetProvider('" + chData.providerKey + "') 返回 vrp 一致");
                else {
                    warn("[Choice] GetProvider 返回 " + (gret && !gret.isNull() ? cn(gret) : "null") + " ≠ vrp — providersMap 未生效");
                    return false;
                }
            }
            else
                warn("[Choice] rpm.GetProvider NOT FOUND");
        }
        catch (e) {
            warn("[Choice] GetProvider 验证 err: " + e);
            return false;
        }
        return true;
    }
    catch (e) {
        warn("[Choice] chRegisterProvider err: " + e);
        return false;
    }
}
// ============ 主注册 ============
function tryFinalizeChoiceHandlers() {
    try {
        if (!chCls || !chCls.trialPanel || chCls.trialPanel.isNull() || !chCls.vrp || chCls.vrp.isNull())
            return;
        if (chData.registered || chData.finalizing)
            return;
        if (!chData.handlers.length)
            return;
        chData.finalizing = true;
        try {
            // 1. mgr + metaMap
            var mgr = findSvc("ChoiceHandlerManager", true);
            if (!mgr)
                mgr = findSvc("WitchTrialsChoiceHandlerManager");
            if (!mgr) {
                dbg("[Choice] mgr 未就绪, 稍后重试");
                return;
            }
            var cfg = null, metaMap = null;
            for (var ci = 0x10; ci <= 0x80 && !cfg; ci += 8) {
                try {
                    var cand = mgr.add(ci).readPointer();
                    if (cand.isNull())
                        continue;
                    var gmm = A.cgm(A.ogc(cand), Memory.allocUtf8String("get_MetadataMap"), 0);
                    if (!gmm || gmm.isNull())
                        gmm = A.cgm(A.ogc(cand), Memory.allocUtf8String("get_ActorMetadataMap"), 0);
                    if (gmm && !gmm.isNull()) {
                        var mm = invokeOk(gmm, cand, []);
                        if (mm.ok && mm.ret && !mm.ret.isNull()) {
                            cfg = cand;
                            metaMap = mm.ret;
                            break;
                        }
                    }
                }
                catch (e) { }
            }
            if (!cfg || !metaMap || metaMap.isNull()) {
                dbg("[Choice] Configuration NOT FOUND, 稍后重试");
                return;
            }
            chData.metaMap = metaMap;
            // 2. 源面板
            var srcEma = null, srcHiro = null;
            var panels = findAllObjectOfType(chCls.trialPanel);
            for (var p = 0; p < panels.length; p++) {
                var nm = chObjName(panels[p]);
                if (!nm)
                    continue;
                if (nm.indexOf("@Ema") >= 0 && !srcEma)
                    srcEma = panels[p];
                else if (nm.indexOf("@Hiro") >= 0 && !srcHiro)
                    srcHiro = panels[p];
            }
            if (!srcEma && !srcHiro) {
                dbg("[Choice] 源面板未出现 (TrialChoiceHandlerPanel=" + panels.length + "), 稍后重试");
                return;
            }
            dbg("[Choice] 源面板: Ema=" + (srcEma ? chObjName(srcEma) : "无") + " Hiro=" + (srcHiro ? chObjName(srcHiro) : "无"));
            // 3. Resource<GameObject> 类
            if (!chData.resGOClass || chData.resGOClass.isNull()) {
                chStealResourceGOClass();
                if (!chData.resGOClass || chData.resGOClass.isNull()) {
                    chTriggerGOClass();
                    dbg("[Choice] Resource<GameObject> 类未捕获, 触发后重试");
                    return;
                }
            }
            chHookRl();
            // 4. 共享 vrp (R1)
            if (!chEnsureVrp())
                return;
            // 5. 逐 handler: 克隆 + 换立绘 + serve (R2/R3) + meta (R4)
            var instMi = A.cgm(chCls.object, Memory.allocUtf8String("Instantiate"), 1);
            var setNmMi = A.cgm(chCls.object, Memory.allocUtf8String("set_name"), 1);
            var ddlMi = A.cgm(chCls.object, Memory.allocUtf8String("DontDestroyOnLoad"), 1);
            var allOk = true;
            for (var h = 0; h < chData.handlers.length; h++) {
                var hd = chData.handlers[h];
                try {
                    // serve 双 key (2026-08-11): C# 蓝本 AddResource 用 'ModChoiceHandlers/{id}' (prefix+id);
                    // run3 探针实测按钮加载请求裸 id 'MyMod_EmaHiro'。两条路径可能并存 (按钮 vs UI prefab),
                    // 双 key 各自 Add 无冲突 (不同 key), 覆盖两种请求。
                    var path = hd.id;
                    var pathPrefix = chData.providerKey + "/" + hd.id;
                    if (!chData.cloned[hd.id]) {
                        var src = (hd.basePanel.indexOf("TrialHiro") >= 0) ? srcHiro : srcEma;
                        if (!src || src.isNull()) {
                            warn("[Choice] 源面板缺失 (base=" + hd.basePanel + "), 跳过 '" + hd.id + "'");
                            allOk = false;
                            continue;
                        }
                        var clone = (instMi && !instMi.isNull()) ? invoke(instMi, ptr(0), [src]) : ptr(0);
                        if (!clone || clone.isNull()) {
                            warn("[Choice] Instantiate 失败 '" + hd.id + "'");
                            allOk = false;
                            continue;
                        }
                        if (setNmMi && !setNmMi.isNull())
                            invoke(setNmMi, clone, [makeS("TrialChoicePanel@Mod_" + hd.id)]);
                        // 2026-08-11 根因修复: 源面板捕获的是组件 (TrialChoiceHandlerPanel), Instantiate 返回组件;
                        // ResourceExistsBlocking<T> 检查 Object.GetType()==typeof(GameObject) → 必须传 gameObject!
                        var goMi = A.cgm(A.ogc(clone), Memory.allocUtf8String("get_gameObject"), 0);
                        if (goMi && !goMi.isNull()) {
                            var goR = invokeOk(goMi, clone, []);
                            if (goR.ok && goR.ret && !goR.ret.isNull()) {
                                dbg("[Choice] clone 组件 → gameObject: " + clone + " → " + goR.ret);
                                clone = goR.ret;
                            }
                        }
                        if (ddlMi && !ddlMi.isNull())
                            invoke(ddlMi, ptr(0), [clone]);
                        if (hd.sprite && !hd.sprite.isNull())
                            chSwapPortrait(clone, hd.sprite);
                        chData.cloned[hd.id] = clone;
                    }
                    // R2+R3: Resource ctor + Resources.Add + ContainsKey 自验证
                    // 2026-08-11 根因2: Resource.path 必须 = prefix 版 (C# 蓝本 AddResource("ModChoiceHandlers/{Id}"))
                    // → LoadedResource.ctor 的 BuildLocalPath(prefix, resource.Path) 需要 fullPath 含 prefix!
                    var res = chMakeResourceGO(pathPrefix, chData.cloned[hd.id]);
                    if (!res) {
                        allOk = false;
                        continue;
                    }
                    var servedBare = chServeResource(path, res);
                    var servedPref = chServeResource(pathPrefix, res); // 双 key (prefix 版镜像 C# 蓝本)
                    if (!servedBare && !servedPref) {
                        allOk = false;
                        continue;
                    }
                    // R4: AddRecord + ContainsId
                    if (!chRegisterMeta(hd)) {
                        allOk = false;
                        continue;
                    }
                }
                catch (e) {
                    warn("[Choice] handler '" + hd.id + "' 注册 err: " + e);
                    allOk = false;
                }
            }
            // 6. providersMap.Add + GetProvider 验证
            if (allOk) {
                if (!chRegisterProvider())
                    allOk = false;
            }
            if (allOk) {
                chData.registered = true;
                info("[Choice] choice handler 注册完成: " + chData.handlers.length + " 个");
                chDumpMethods(chCls.vrp, "VRP");
                if (chData.rlKlass && !chData.rlKlass.isNull())
                    chDumpMethods(chData.rlKlass, "RL");
                chHookDictTryGetValue();
                var rpB2 = findClassAcrossImages("Naninovel", "ResourceProvider");
                if (rpB2 && !rpB2.isNull())
                    chDumpMethods(rpB2, "base");
                // UIChoiceHandler 方法表 hook (run14: RL-P.Load 内部调用全盲区 → 从调用者侧观察)
                var uic = findClassAcrossImages("Naninovel", "UIChoiceHandler");
                if (uic && !uic.isNull()) {
                    chHookClassMethods(uic, "UIC");
                    chDumpMethods(uic, "UIC");
                }
            }
            else {
                dbg("[Choice] finalize 部分失败, 待重试");
            }
        }
        finally {
            chData.finalizing = false;
        }
    }
    catch (e) {
        warn("[Choice] tryFinalizeChoiceHandlers err: " + e);
        chData.finalizing = false;
    }
}
// ============ Dictionary`2.TryGetValue 过滤 hook (run13: 游戏拿到 vrp 后零 provider 调用即抛错;
// 特化体 vs 共享体未定 — TryGetValue 无论走哪条都在我们 Add 过的 dict 上 → 过滤自证) ============
function chHookDictTryGetValue() {
    try {
        if (!chData.vrpDict || chData.vrpDict.isNull())
            return;
        var dictCls = A.ogc(chData.vrpDict);
        if (!dictCls || dictCls.isNull())
            return;
        var iter = Memory.alloc(Process.pointerSize);
        iter.writePointer(ptr(0));
        var mi = A.cgmAll(dictCls, iter);
        var n = 0;
        while (mi && !mi.isNull() && n < 100) {
            n++;
            var nm = "";
            try {
                var np = A.mgn(mi);
                if (np && !np.isNull())
                    nm = np.readCString();
            }
            catch (e) { }
            var mp = mi.readPointer();
            if ((nm === "TryGetValue" || nm === "ContainsKey" || nm === "get_Item") && mp && !mp.isNull()) {
                var mnm2 = nm;
                Interceptor.attach(mp, {
                    onEnter: function (a) {
                        try {
                            var self = a[0];
                            var key = "";
                            try {
                                key = readStr(a[1]);
                            }
                            catch (e) { }
                            // run16: 全不过滤 — 验证特化体理论: 游戏加载 MyMod 时查了哪些 dict/key
                            // (风暴抑制: 只在 key 与 MyMod/ModChoice 相关时打印; 否则打 1 字符标记)
                            if (key.indexOf("MyMod") >= 0 || key.indexOf("ModChoice") >= 0 ||
                                (chData.vrpDict && self.equals(chData.vrpDict))) {
                                var selfCls = "";
                                try {
                                    selfCls = A.cgn(A.ogc(self)).readCString();
                                }
                                catch (e) { }
                                dbg("[Choice] " + mnm2 + " self=" + self + " (" + selfCls + ") key='" + key + "'" +
                                    (chData.vrpDict && self.equals(chData.vrpDict) ? " ←我们的 dict" : ""));
                            }
                        }
                        catch (e) { }
                    }
                });
                dbg("[Choice] Dict.TryGetValue hooked (过滤我们的 vrp dict) @" + mp);
                return;
            }
            mi = A.cgmAll(dictCls, iter);
        }
    }
    catch (e) {
        dbg("[Choice] chHookDictTryGetValue err: " + e);
    }
}
// ============ 方法表 hook (run11: 泛型共享体指针在方法表里; get_method_from_name 指针不在调用路径) ============
// 方法表里多个泛型方法共享同一代码体指针 → 去重 attach, 一次命中全捕获。
// 通用: 对任意类 attach 名字匹配的加载方法 (共享体 = 游戏真实调用路径)。
function chHookClassMethods(cls, tag, all) {
    var hooked = 0;
    try {
        if (!A.cgmAll || !A.mgn) {
            dbg("[Choice] cgmAll/mgn 不可用 (" + tag + ")");
            return hooked;
        }
        var iter = Memory.alloc(Process.pointerSize);
        iter.writePointer(ptr(0));
        var seen = {};
        // 高频方法节流: GetLoadedResourceOrNull/GetLoaded/ResourceExists/LoadResource 等每次资源查询都触发, modlog 噪音主要来源
        // 前 N 条全打, 之后每 step 条打一条, 防日志爆炸
        var noisyMethods = { GetLoadedResourceOrNull: 1, GetLoaded: 1, ResourceExists: 1, ResourceExistsBlocking: 1, LoadResource: 1, Load: 1 };
        var logCount = {}; // mnm → 已打条数
        var NOISY_LIMIT = 5;
        var NOISY_STEP = 100;
        // HandleLocaleChanged 一次切语言会被多个 ResourceLoader<T> 实例触发 (FSG), 同 locale 只打第一次
        var lastLocale = null;
        var localeHits = 0;
        var mi = A.cgmAll(cls, iter);
        var n = 0;
        while (mi && !mi.isNull() && n < 300) {
            n++;
            var mp = mi.readPointer();
            var nm = "";
            try {
                var np = A.mgn(mi);
                if (np && !np.isNull())
                    nm = np.readCString();
            }
            catch (e) { }
            if (mp && !mp.isNull() && !seen[mp.toString()] &&
                (all || /^(Load|Locate|ResourceExists|SupportsType|GetLoaded|AddResource|SetResource|RemoveResource|Run|Create|Handle|InitializeProvisionSources|Cancel|IsLocationCached|LocateCached)/.test(nm))) {
                seen[mp.toString()] = true;
                (function (addr, mnm) {
                    Interceptor.attach(addr, {
                        onEnter: function (a) {
                            try {
                                var self = a[0];
                                var tag2 = (chData.vrp && self && self.equals(chData.vrp)) ? " [我们的 vrp]" : "";
                                var path = "";
                                try {
                                    path = readStr(a[1]);
                                }
                                catch (e) { }
                                if (mnm === "InitializeProvisionSources")
                                    path = ""; // 无 path 参数, 抑制 a[1] 误读
                                // 节流: 高频方法只打前 NOISY_LIMIT 条 + 之后每 NOISY_STEP 条一条
                                // HandleLocaleChanged: 同 locale 多次触发 (FSG 多实例) 只 dbg 第一次
                                var shouldLog = true;
                                if (noisyMethods[mnm]) {
                                    logCount[mnm] = (logCount[mnm] || 0) + 1;
                                    var c = logCount[mnm];
                                    if (c > NOISY_LIMIT) {
                                        if (c % NOISY_STEP !== 0)
                                            shouldLog = false;
                                        else {
                                            dbg("[Choice] " + tag + "." + mnm + " (节流, 已触发 " + c + " 次)");
                                            shouldLog = false;
                                        }
                                    }
                                }
                                else if (mnm === "HandleLocaleChanged" && path) {
                                    this._locale = path; // onLeave 通过 this 闭包拿
                                    if (lastLocale === path) {
                                        localeHits++;
                                        if (localeHits > 1 && localeHits % 20 !== 0)
                                            shouldLog = false;
                                        else if (localeHits > 1) {
                                            dbg("[Choice] HandleLocaleChanged('" + path + "') 同 locale 第 " + localeHits + " 次触发 (FSG 多实例)");
                                            shouldLog = false;
                                        }
                                    }
                                    else {
                                        lastLocale = path;
                                        localeHits = 1;
                                    }
                                }
                                if (shouldLog)
                                    dbg("[Choice] " + tag + "." + mnm + "('" + path + "')" + tag2);
                                // RL-P.Load ProvisionSources 诊断 + backtrace: 已完成诊断, 暂时静默减少噪音
                                // (历史定位: 7181 / 11259 行噪音来自这两段, 一帧多次 Sfx/Bgm 加载触发)
                            }
                            catch (e) { }
                        },
                        onLeave: function (retval) {
                            // InitializeProvisionSources onLeave: wipe 点本身. 诊断观察时机 —
                            // 若在 HandleLocaleChanged onLeave 之后仍频繁出现, 说明有延迟二次重建, 需补 trigger.
                            if (mnm === "InitializeProvisionSources") {
                                dbg("[Choice] " + tag + ".InitializeProvisionSources onLeave — ProvisionSources 已重建");
                            }
                            // HandleLocaleChanged 方法体已执行完 (InitializeProvisionSources 已清空+重建 list)
                            // 此时 ProvisionSources 只剩游戏默认 provider — 立刻补回 mod provider
                            // 后续异步 ReloadIfLocalized 才能用到 mod provider (修 "Failed to hold" 错误)
                            if (mnm === "HandleLocaleChanged" && this._locale) {
                                try {
                                    startReinjectWindow("HandleLocaleChanged('" + this._locale + "') [onLeave]");
                                    this._locale = null;
                                }
                                catch (e4) {
                                    dbg("[Choice] startReinjectWindow (onLeave) err: " + e4);
                                }
                            }
                        }
                    });
                })(mp, nm);
                hooked++;
                dbg("[Choice] " + tag + "-table hook: " + nm + "@" + mp);
            }
            mi = A.cgmAll(cls, iter);
        }
    }
    catch (e) {
        dbg("[Choice] chHookClassMethods(" + tag + ") err: " + e);
    }
    return hooked;
}
function chHookVrpMethods() { chHookClassMethods(chCls.vrp, "VRP", false); } // run26 教训: all=true 风暴 (高频方法) — 只 hook 名称匹配的低频加载方法
// ============ stub 解析 + 真体 BL hook (run18: methodPointer = LDR X16/BR X16 stub, 真体=动态生成代码) ============
var chExecRanges = null;
function chIsExec(addr) {
    try {
        if (!chExecRanges)
            chExecRanges = Process.enumerateRanges('r-x');
        for (var i = 0; i < chExecRanges.length; i++) {
            if (addr.compare(chExecRanges[i].base) >= 0 && addr.compare(chExecRanges[i].base.add(chExecRanges[i].size)) < 0)
                return true;
        }
    }
    catch (e) { }
    return false;
}
function chStubResolve(addr) {
    try {
        var w0 = addr.readU32();
        if ((w0 & 0xFF000000) === 0x58000000) {
            // LDR Xt literal: label = PC + signext(imm19)*4; run20 实证 imm19=2 → 地址池在 stub+16
            var imm19 = (w0 >> 5) & 0x7FFFF;
            if (imm19 & 0x40000)
                imm19 -= 0x80000;
            // label = PC + imm19*4 (PC = LDR 指令地址 addr 本身)
            var lab = addr.add(imm19 * 4);
            var target = lab.readPointer();
            // 动态代码区可能不被 enumerateRanges 覆盖 → 不做可执行校验, 直接信任地址池
            return target;
        }
    }
    catch (e) { }
    return null;
}
// stub 链解析: 外层 LDR/BR stub → 内层 stub (LDR+解引用+BR)。
// run24 教训: 在 stub2 的 BR 指令上 attach = frida 跳板改写尾调用指令, 与 IL2CPP 懒解析
// 竞态 → 游戏崩 (SIGSEGV @stub2+0x10, ips 20:45:52)。改为纯只读: 从 stub2+0x28 读 slot
// (run24 实证 slot = 最终真体地址, 如 0x104858000), 不做任何 attach。
function chHookStubBody(stub, tag) {
    try {
        var body = chStubResolve(stub);
        if (!body || body.isNull()) {
            dbg("[Choice] " + tag + " 不是 stub 或解析失败 @" + stub);
            return;
        }
        dbg("[Choice] " + tag + " stub@" + stub + " → stub2@" + body);
        var hexs2 = [];
        try {
            for (var hh2 = 0; hh2 < 48; hh2++)
                hexs2.push(body.add(hh2).readU8().toString(16).padStart(2, "0"));
        }
        catch (e) { }
        dbg("[Choice] " + tag + " stub2 开头96B: " + hexs2.join(" "));
        // 只读: slotB @stub2+0x28 (run24 实证 = 最终真体)
        var slot = body.add(0x28).readPointer();
        if (!slot || slot.isNull()) {
            dbg("[Choice] " + tag + " slot@0x28 为空 (懒解析未完成)");
            return;
        }
        dbg("[Choice] " + tag + " 最终真体(只读 slot)@" + slot);
        var hexs = [];
        try {
            for (var hh = 0; hh < 16; hh++)
                hexs.push(slot.add(hh).readU8().toString(16).padStart(2, "0"));
        }
        catch (e) { }
        dbg("[Choice] " + tag + " 最终真体开头32B: " + hexs.join(" "));
        // 只读 dump BL 目标 (不 attach — run24 实证真体 0 BL 目标, 泛型调用全间接)
        var tgts = chDumpBlTargets(slot, 0x800, tag);
        if (tgts.length)
            dbg("[Choice] " + tag + " BL 目标 (" + tgts.length + "): " + tgts.join(", "));
    }
    catch (e) {
        dbg("[Choice] chHookStubBody(" + tag + ") err: " + e);
    }
}
// ============ 代码段 BL 目标 dump (run16: RL-P.Load 内部调用全盲区 → 反汇编直接调用) ============
// ARM64 BL 立即数解码: 0x94000000 掩码; 目标 = addr + signext(imm26)*4
function chDumpBlTargets(addr, len) {
    var out = [];
    try {
        for (var i = 0; i < len; i += 4) {
            var insn = addr.add(i).readU32();
            if ((insn & 0xFC000000) === 0x94000000) {
                var imm = insn & 0x03FFFFFF;
                if (imm & 0x02000000)
                    imm -= 0x04000000;
                var tgt = addr.add(i + imm * 4);
                var ga3 = null;
                try {
                    ga3 = Process.getModuleByName("GameAssembly_arm64.dylib");
                }
                catch (e) { }
                var b3 = ga3 ? ga3.base : ptr(0);
                var off = "";
                if (b3 && tgt.compare(b3) >= 0 && tgt.compare(b3.add(0x7000000)) < 0)
                    off = "GA+" + tgt.sub(b3).toString(16);
                out.push(tgt.toString() + (off ? "(" + off + ")" : ""));
            }
        }
    }
    catch (e) {
        dbg("[Choice] chDumpBlTargets err: " + e);
    }
    return out;
}
function chHookBlTargets(addr, len, tag) {
    try {
        var tgts = chDumpBlTargets(addr, len);
        var uniq = {};
        var ga4 = null;
        try {
            ga4 = Process.getModuleByName("GameAssembly_arm64.dylib");
        }
        catch (e) { }
        var b4 = ga4 ? ga4.base : ptr(0);
        var count = 0;
        tgts.forEach(function (t) {
            if (!t || uniq[t])
                return;
            uniq[t] = true;
            count++;
            var off = "";
            try {
                if (b4 && ptr(t).compare(b4) >= 0 && ptr(t).compare(b4.add(0x7000000)) < 0)
                    off = " GA+" + ptr(t).sub(b4).toString(16);
            }
            catch (e) { }
            Interceptor.attach(ptr(t), {
                onEnter: function () {
                    try {
                        dbg("[Choice] BL:" + tag + " 目标 @" + ptr(t) + off);
                    }
                    catch (e) { }
                }
            });
        });
        dbg("[Choice] BL:" + tag + " 共 " + count + " 个目标: " + tgts.join(", "));
    }
    catch (e) {
        dbg("[Choice] chHookBlTargets err: " + e);
    }
}
// ============ 方法表 dump (诊断: 泛型方法 get_method_from_name 找不到, 遍历看真实形态) ============
// 名字/参数数/泛型标志用官方 API 读 (MethodInfo 布局不可靠, 不猜偏移)
function chDumpMethods(cls, tag) {
    try {
        if (!A.cgmAll || !A.mgn) {
            dbg("[Choice] cgmAll/mgn 不可用");
            return;
        }
        var iter = Memory.alloc(Process.pointerSize);
        iter.writePointer(ptr(0));
        var rows = [];
        var mi = A.cgmAll(cls, iter);
        var n = 0;
        while (mi && !mi.isNull() && n < 300) {
            n++;
            var mp = mi.readPointer();
            var nm = "";
            try {
                var np = A.mgn(mi);
                if (np && !np.isNull())
                    nm = np.readCString();
            }
            catch (e) { }
            var pc = -1, isG = false, isI = false;
            try {
                pc = A.mpc ? A.mpc(mi) : -1;
            }
            catch (e) { }
            try {
                isG = A.mig ? !!A.mig(mi) : false;
            }
            catch (e) { }
            try {
                isI = A.mii ? !!A.mii(mi) : false;
            }
            catch (e) { }
            rows.push(nm + "/" + pc + (isG ? "G" : "-") + (isI ? "I" : "-") + "@" + mp);
            mi = A.cgmAll(cls, iter);
        }
        dbg("[Choice] " + tag + " 方法表 (" + n + "): " + rows.join(" | "));
    }
    catch (e) {
        dbg("[Choice] chDumpMethods err: " + e);
    }
}
// ============ RL 泛型类 hook (rlKlass 捕获后装; 幂等) ============
// ResourceLoader`1<GameObject> (inflated) — 按钮加载已跑过 → 特化体已生成;
// hook 这里 = 抓所有该泛参的加载调用 (含 handler UI prefab 加载)
function chHookRl() {
    try {
        if (chData.rlHooked)
            return;
        var rlk = chData.rlKlass;
        if (!rlk || rlk.isNull())
            return;
        chData.rlHooked = true;
        dbg("[Choice] rlKlass=" + A.cgn(rlk).readCString());
        // run12: 加载方法在父类 (ResourceLoader`1<GameObject>) 方法表 — 遍历 hook + dump
        chHookClassMethods(rlk, "RL");
        chDumpMethods(rlk, "RL");
        if (A.cgp) {
            var par = A.cgp(rlk);
            if (par && !par.isNull()) {
                var pn = "";
                try {
                    pn = A.cgn(par).readCString();
                }
                catch (e) { }
                dbg("[Choice] RL 父类=" + pn);
                chHookClassMethods(par, "RL-P");
                chDumpMethods(par, "RL-P");
                // RL-P.Load 代码段 BL 目标 hook (run16: RL-P.Load 内部调用全盲区 → 反汇编抓直接调用)
                if (A.cgmAll && A.mgn) {
                    var iter2 = Memory.alloc(Process.pointerSize);
                    iter2.writePointer(ptr(0));
                    var mi2 = A.cgmAll(par, iter2);
                    var nn = 0;
                    while (mi2 && !mi2.isNull() && nn < 300) {
                        nn++;
                        var nm2 = "";
                        try {
                            var np2 = A.mgn(mi2);
                            if (np2 && !np2.isNull())
                                nm2 = np2.readCString();
                        }
                        catch (e) { }
                        if (nm2 === "Load" || nm2 === "LoadAll") {
                            var mp2 = mi2.readPointer();
                            if (mp2 && !mp2.isNull()) {
                                dbg("[Choice] RL-P." + nm2 + " 代码段 @" + mp2 + " — BL 目标 hook");
                                var hexs = [];
                                try {
                                    for (var hh = 0; hh < 32; hh++)
                                        hexs.push(mp2.add(hh).readU8().toString(16).padStart(2, "0"));
                                }
                                catch (e) { }
                                dbg("[Choice] RL-P." + nm2 + "@" + mp2 + " 开头64B: " + hexs.join(" "));
                                chHookStubBody(mp2, "RL-P-" + nm2);
                            }
                        }
                        // RL-P.Load 只读诊断 (2026-08-11 清空假设): onEnter 复刻游戏查询, onLeave 对比 dict
                        if (nm2 === "Load") {
                            var mpL = mi2.readPointer();
                            if (mpL && !mpL.isNull() && !chData.rlLoadDiagHooked) {
                                chData.rlLoadDiagHooked = true;
                                Interceptor.attach(mpL, {
                                    onEnter: function (a) {
                                        try {
                                            if (!chData.vrpDict || chData.vrpDict.isNull())
                                                return;
                                            var path = readStr(a[1]) || "";
                                            if (path.indexOf("MyMod") < 0)
                                                return;
                                            var full = chData.providerKey + "/" + path;
                                            var ckMi = A.cgm(A.ogc(chData.vrpDict), Memory.allocUtf8String("ContainsKey"), 1);
                                            var ckr = ckMi && !ckMi.isNull() ? invokeOk(ckMi, chData.vrpDict, [makeS(full)]) : { ok: false };
                                            var ck = ckr.ok ? chBool(ckr) : "?";
                                            dbg("[Choice] 自验证 vrp.Resources.ContainsKey('" + full + "') = " + ck + " (游戏 Load 即将查询的 fullPath)");
                                            this._pre = chDictPhysCount(chData.vrpDict);
                                            var ks = chDictPhysKeys(chData.vrpDict);
                                            dbg("[Choice] vrp.Resources 物理 count=" + this._pre + " keys(" + ks.length + "): " + ks.slice(0, 8).join(", ") + (ks.length > 8 ? " ..." : ""));
                                            if (ck !== true && this._pre > 0) {
                                                // dict 有内容但 ContainsKey=false → key 内容不匹配 (prefix 拼错?)
                                                var miss = chData.providerKey + "/" + path;
                                                for (var i2 = 0; i2 < ks.length; i2++) {
                                                    if (ks[i2] === path || ks[i2] === miss)
                                                        dbg("[Choice]   找到候选 key '" + ks[i2] + "' (内容匹配)");
                                                }
                                            }
                                            // ===== 决定性实验 (2026-08-11): 游戏版 ResourceExists<T> 双条件 =====
                                            // 源码 (DoomsGuardians/Project-Cannon-and-Candle):
                                            //   ResourceExistsBlocking<T> = Resources.ContainsKey(path) && Resources[path].Object.GetType() == typeof(T)
                                            // 条件1 ContainsKey 已验证 true; 现在验证条件2: Object 的 klass 是否 == GameObject
                                            try {
                                                var gItem = A.cgm(A.ogc(chData.vrpDict), Memory.allocUtf8String("get_Item"), 1);
                                                if (gItem && !gItem.isNull()) {
                                                    var ri = invokeOk(gItem, chData.vrpDict, [makeS(full)]);
                                                    if (ri.ok && ri.ret && !ri.ret.isNull()) {
                                                        var objPtr = ri.ret.add(0x18).readPointer();
                                                        var objCls = objPtr && !objPtr.isNull() ? A.ogc(objPtr) : ptr(0);
                                                        var objName = objCls && !objCls.isNull() ? A.cgn(objCls).readCString() : "NULL";
                                                        // GameObject 的 klass 对照
                                                        var goCls = ptr(0);
                                                        try {
                                                            goCls = findClassAcrossImages("UnityEngine", "GameObject");
                                                        }
                                                        catch (e2) { }
                                                        var goName = goCls && !goCls.isNull() ? A.cgn(goCls).readCString() : "?";
                                                        dbg("[Choice] Resource.Object klass=" + objName + " vs GameObject klass=" + goName + (objCls.equals(goCls) ? " — 匹配" : " — 不匹配"));
                                                    }
                                                }
                                            }
                                            catch (e2) {
                                                dbg("[Choice] Object klass 检查 err: " + e2);
                                            }
                                            // 泛型定义 invoke 实验: IL2CPP 无 JIT, VRP.ResourceExists<T> 的 <GameObject> 特化
                                            // 未生成 (方法表 mp=0x0) → 游戏调用失败. 试 invoke 泛型定义, 观察结果/异常.
                                            try {
                                                var reB = A.cgm(chCls.vrp, Memory.allocUtf8String("ResourceExistsBlocking"), 1);
                                                var reR = A.cgm(chCls.vrp, Memory.allocUtf8String("ResourceExists"), 1);
                                                if (reB && !reB.isNull()) {
                                                    var rB = invokeOk(reB, chData.vrp, [makeS(full)]);
                                                    dbg("[Choice] invoke ResourceExistsBlocking(泛型定义): ok=" + rB.ok + (rB.ok ? " ret=" + chBool(rB) : " ex=" + rB.ex));
                                                }
                                                else
                                                    dbg("[Choice] ResourceExistsBlocking 方法未找到!");
                                                if (reR && !reR.isNull()) {
                                                    var rR = invokeOk(reR, chData.vrp, [makeS(full)]);
                                                    dbg("[Choice] invoke ResourceExists(泛型定义): ok=" + rR.ok + (rR.ok ? " ret=" + chBool(rR) : " ex=" + rR.ex));
                                                }
                                                else
                                                    dbg("[Choice] ResourceExists 方法未找到!");
                                            }
                                            catch (e2) {
                                                dbg("[Choice] 泛型 invoke 实验 err: " + e2);
                                            }
                                        }
                                        catch (e) {
                                            dbg("[Choice] RL-P.Load 诊断 onEnter err: " + e);
                                        }
                                    },
                                    onLeave: function () {
                                        try {
                                            if (!chData.vrpDict || chData.vrpDict.isNull())
                                                return;
                                            var post = chDictPhysCount(chData.vrpDict);
                                            // 高频诊断日志 (1859 行噪音): 仅在 count 变化或被清空时才打
                                            if (this._pre > 0 && post < this._pre) {
                                                dbg("[Choice] RL-P.Load 后 vrp.Resources count=" + post + " (onEnter 时 " + this._pre + ") — 被清空了!");
                                            }
                                            // VRP 方法表 ResourceExists 的 mp 是否被解析 (特化体发现)
                                            if (A.cgmAll && chCls.vrp) {
                                                var iter3 = Memory.alloc(Process.pointerSize);
                                                iter3.writePointer(ptr(0));
                                                var mi3 = A.cgmAll(chCls.vrp, iter3);
                                                var nn3 = 0;
                                                while (mi3 && !mi3.isNull() && nn3 < 40) {
                                                    nn3++;
                                                    var nm3 = "";
                                                    try {
                                                        var np3 = A.mgn(mi3);
                                                        if (np3 && !np3.isNull())
                                                            nm3 = np3.readCString();
                                                    }
                                                    catch (e) { }
                                                    if (nm3.indexOf("ResourceExists") >= 0 || nm3 === "LoadResource") {
                                                        dbg("[Choice] VRP." + nm3 + " mp=0x" + mi3.readPointer().toString(16));
                                                    }
                                                    mi3 = A.cgmAll(chCls.vrp, iter3);
                                                }
                                            }
                                        }
                                        catch (e) {
                                            dbg("[Choice] RL-P.Load 诊断 onLeave err: " + e);
                                        }
                                    }
                                });
                                dbg("[Choice] RL-P.Load 诊断 attach (onEnter+onLeave)");
                            }
                        }
                        mi2 = A.cgmAll(par, iter2);
                    }
                }
            }
        }
    }
    catch (e3) {
        dbg("[Choice] chHookRl err: " + e3);
    }
}
// ============ 只读诊断: vrp.Resources 物理扫描 + RL-P.Load 前后对比 (2026-08-11 清空假设) ============
// 镜像 ResourceProviderManager.DestroyService: foreach (providersMap.Values) provider?.UnloadResources()
// → 我们注册进 providersMap 的 vrp 在场景重建时可能被游戏 RemoveAllResources() 清空!
// 验证: RL-P.Load onEnter 复刻游戏查询 (ContainsKey) + onLeave 对比 dict count。
function chDictPhysKeys(dict) {
    var out = [];
    try {
        var cnt = dict.add(0x20).readS32();
        if (cnt <= 0)
            return out;
        var ents = dict.add(0x18).readPointer();
        if (!ents || ents.isNull())
            return out;
        var al = ents.add(0x18).readS32();
        for (var e = 0; e < al; e++) {
            var eb = ents.add(0x20 + e * 24);
            if (eb.readS32() === -1)
                continue;
            var kp = eb.add(8).readPointer();
            if (!kp || kp.isNull())
                continue;
            var ks = readStr(kp);
            if (ks)
                out.push(ks);
        }
    }
    catch (e) { }
    return out;
}
function chDictPhysCount(dict) {
    try {
        return dict.add(0x20).readS32();
    }
    catch (e) {
        return -1;
    }
}
// ============ 只读诊断: RL-P.Load 入口读游戏实际 ProvisionSources (2026-08-11 源码对照) ============
// 游戏版 ResourceLoader`1.Load(path, holder) 遍历 ProvisionSources → Provider.ResourceExists;
// 诊断 run16 铁证: vrp 方法 0 调用 → ProvisionSources 没有 vrp。这里直接读出来看 (计划保留的只读日志项)。
// ProvisionSource struct = { IResourceProvider Provider; string PathPrefix } (16B)
function chReadProvisionSources(self) {
    var out = { cnt: 0, desc: "", hasVrp: false };
    try {
        var par = A.cgp(A.ogc(self));
        var off = fieldOffset(par, "ProvisionSources", 0x20);
        var list = self.add(off).readPointer();
        var sz = list.add(0x18).readS32();
        if (sz < 0 || sz > 64) {
            out.desc = "(List size=" + sz + " @off=" + off + " 可疑, 偏移可能不对)";
            return out;
        }
        out.cnt = sz;
        var items = list.add(0x10).readPointer();
        var parts = [];
        for (var i = 0; i < sz; i++) {
            var ps = items.add(0x20 + i * 16);
            var prov = ps.readPointer();
            var pfx = readStr(ps.add(8).readPointer());
            var pn = (prov && !prov.isNull()) ? A.cgn(A.ogc(prov)).readCString() : "null";
            var ours = chData.vrp && prov && !prov.isNull() && prov.equals(chData.vrp);
            if (ours)
                out.hasVrp = true;
            parts.push(pn + (pfx ? "('" + pfx + "')" : "()") + (ours ? " ★=vrp" : ""));
        }
        out.desc = parts.join(", ");
    }
    catch (e) {
        out.desc = "(err " + e + ")";
    }
    return out;
}
// ============ 保活 (providersMap 可能被场景重建; GC 未禁时 vrp 靠 providersMap 持有) ============
function chDictPhysHasKey(dict, keyStr) {
    try {
        var cnt = dict.add(0x20).readS32();
        if (cnt <= 0)
            return false;
        var buckets = dict.add(0x10).readPointer();
        var ents = dict.add(0x18).readPointer();
        if (!buckets || buckets.isNull() || !ents || ents.isNull())
            return false;
        var al = ents.add(0x18).readS32();
        for (var e = 0; e < al; e++) {
            var eb = ents.add(0x20 + e * 24);
            if (eb.readS32() === -1)
                continue;
            var kp = eb.add(8).readPointer();
            if (!kp || kp.isNull())
                continue;
            if (readStr(kp) === keyStr)
                return true;
        }
    }
    catch (e) { }
    return false;
}
function chKeepAlive() {
    try {
        if (!chData.vrp || chData.vrp.isNull())
            return;
        var rpm = findSvc("ResourceProviderManager");
        if (!rpm)
            return;
        var pm = rpm.add(fieldOffset(A.ogc(rpm), "providersMap", 0x20)).readPointer();
        if (!pm || pm.isNull())
            return;
        if (!chDictPhysHasKey(pm, chData.providerKey)) {
            var addMi = A.cgm(A.ogc(pm), Memory.allocUtf8String("Add"), 2);
            if (addMi && !addMi.isNull()) {
                var ar = invokeOk(addMi, pm, [makeS(chData.providerKey), chData.vrp]);
                info("[Choice] 检测到 providersMap 缺失 '" + chData.providerKey + "', 已重新注册 " + (ar.ok ? "成功" : "失败(可能已存在/异常)"));
            }
        }
    }
    catch (e) {
        dbg("[Choice] chKeepAlive err: " + e);
    }
}
// ============ 只读诊断钩子 (确认游戏走 provider 链到哪一步; 不覆盖任何行为) ============
var chDiagHooked = false;
function installDiagHooks() {
    try {
        if (chDiagHooked)
            return;
        chDiagHooked = true;
        // UIChoiceHandler.Initialize → 游戏对 handler 构造尝试的入口
        if (chCls.uih && !chCls.uih.isNull()) {
            var iniMi = A.cgm(chCls.uih, Memory.allocUtf8String("Initialize"), 1);
            if (!iniMi || iniMi.isNull())
                iniMi = A.cgm(chCls.uih, Memory.allocUtf8String("InitializeAsync"), 1);
            if (iniMi && !iniMi.isNull()) {
                Interceptor.attach(iniMi.readPointer(), {
                    onEnter: function (a) {
                        try {
                            var self = a[0];
                            var id = "";
                            try {
                                var idMi = A.cgm(A.ogc(self), Memory.allocUtf8String("get_Id"), 0);
                                if (idMi && !idMi.isNull())
                                    id = readStr(invoke(idMi, self, []));
                            }
                            catch (e) { }
                            if (id && id.indexOf("Trial") !== 0)
                                dbg("[Choice] 游戏构造 UIChoiceHandler '" + id + "' (Initialize)");
                        }
                        catch (e) { }
                    }
                });
                dbg("[Choice] UIChoiceHandler.Initialize hooked (诊断)");
            }
        }
        // GetOrAddActor 对我们 id 的调用 (mgr 可能尚未出现 — 单独重试, 不阻塞后续 hook)
        (function hookGOA() {
            try {
                var mgr = findSvc("ChoiceHandlerManager", true);
                if (!mgr)
                    mgr = findSvc("WitchTrialsChoiceHandlerManager");
                if (!mgr) {
                    setTimeout(hookGOA, 1000);
                    return;
                }
                var goaMi = A.cgm(A.ogc(mgr), Memory.allocUtf8String("GetOrAddActor"), 1);
                if (goaMi && !goaMi.isNull()) {
                    Interceptor.attach(goaMi.readPointer(), {
                        onEnter: function (a) {
                            try {
                                var id = readStr(a[1]);
                                if (id && id.indexOf("Trial") !== 0)
                                    dbg("[Choice] 游戏 GetOrAddActor('" + id + "')");
                            }
                            catch (e) { }
                        }
                    });
                    dbg("[Choice] GetOrAddActor hooked (诊断)");
                }
            }
            catch (e) { }
        })();
        // ResourceProviderManager.GetProvider 运行时路由 (回答游戏加载时 ProviderTypes 解析到哪)
        try {
            var rpmCls = findClassAcrossImages("Naninovel", "ResourceProviderManager");
            if (rpmCls && !rpmCls.isNull()) {
                var gp2Mi = A.cgm(rpmCls, Memory.allocUtf8String("GetProvider"), 1);
                if (gp2Mi && !gp2Mi.isNull()) {
                    Interceptor.attach(gp2Mi.readPointer(), {
                        onEnter: function (a) {
                            this._key = readStr(a[1]) || "";
                            if (this._key === chData.providerKey) {
                                try {
                                    var bt = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 10);
                                    var ga = null;
                                    try {
                                        ga = Process.getModuleByName("GameAssembly_arm64.dylib");
                                    }
                                    catch (e) { }
                                    var base = ga ? ga.base : ptr(0);
                                    var names = bt.map(function (ad) {
                                        try {
                                            if (base && ad.compare(base) >= 0 && ad.compare(base.add(0x7000000)) < 0)
                                                return "0x" + ad.sub(base).toString(16);
                                            var s = DebugSymbol.fromAddress(ad);
                                            return s && s.name ? s.name : ad.toString();
                                        }
                                        catch (e) {
                                            return ad.toString();
                                        }
                                    });
                                    dbg("[Choice] GetProvider backtrace: " + names.join(" <- "));
                                }
                                catch (e2) {
                                    dbg("[Choice] backtrace err: " + e2);
                                }
                            }
                        },
                        onLeave: function (ret) {
                            try {
                                var k = this._key || "";
                                // ret 本身就是 Il2CppObject* (runtime_invoke 返回值), 不要 readPointer
                                var rp = ret && !ret.isNull() ? ret : ptr(0);
                                var rc = (rp && !rp.isNull()) ? A.cgn(A.ogc(rp)).readCString() : "null";
                                var ours = chData.vrp && rp && !rp.isNull() && rp.equals(chData.vrp);
                                if (k === chData.providerKey)
                                    dbg("[Choice] 游戏 GetProvider('" + k + "') → " + rc + (ours ? " 是 vrp" : " 不是/丢失"));
                            }
                            catch (e) { }
                        }
                    });
                    dbg("[Choice] rpm.GetProvider hooked (诊断)");
                }
            }
        }
        catch (e) { }
        // VRP 全部加载入口 — 方法表遍历 attach 真实指针 (run11: get_method_from_name 对泛型方法
        // 返回的指针 ≠ 游戏 vtable 调用路径; 泛型方法共享体指针在方法表里, 直接 attach)
        // run25: 全量 attach 不按名字过滤 (旧 forEach 段已删, 避免重复 attach 同一指针)
        try {
            if (chCls.vrp && !chCls.vrp.isNull()) {
                chHookVrpMethods();
            }
        }
        catch (e) { }
        // ResourceProvider 基类泛型方法 (run12: get_method_from_name 对泛型返回的指针不在调用路径
        // → 方法表遍历 attach 共享体; 游戏加载若走基类方法此处命中)
        try {
            var rpBase = findClassAcrossImages("Naninovel", "ResourceProvider");
            if (!rpBase || rpBase.isNull()) {
                dbg("[Choice] ResourceProvider 基类未找到 (rpBase=null)");
            }
            else
                chHookClassMethods(rpBase, "base", false); // run26 教训: all=true 风暴 — 只 hook 名称匹配的低频方法
        }
        catch (e) { }
    }
    catch (e) {
        warn("[Choice] installDiagHooks err: " + e);
    }
}
// ============ 装配 ============
export function setupChoiceHandlerHooks() {
    try {
        chCls = resolveChoiceHandlerClasses();
        if (chCls.customUI.isNull() || chCls.trialPanel.isNull()) {
            warn("[Choice] 类解析失败 (CustomUI/TrialChoiceHandlerPanel)");
            return;
        }
        // hook CustomUI.Awake → TrialChoiceHandlerPanel Awake → finalize
        var awMi = A.cgm(chCls.customUI, Memory.allocUtf8String("Awake"), 0);
        if (awMi && !awMi.isNull()) {
            Interceptor.attach(awMi.readPointer(), {
                onEnter: function (a) { this._self = a[0]; },
                onLeave: function () {
                    try {
                        if (!this._self || this._self.isNull())
                            return;
                        var cn = A.cgn(A.ogc(this._self)).readCString();
                        if (cn === "TrialChoiceHandlerPanel")
                            tryFinalizeChoiceHandlers();
                    }
                    catch (e) { }
                }
            });
            info("[Choice] CustomUI.Awake hooked");
        }
        installDiagHooks();
        info("[Choice] hooks 就绪");
    }
    catch (e) {
        warn("[Choice] setupChoiceHandlerHooks err: " + e);
    }
}
// Title 时: 读数据 → 预载立绘 → 触发源面板 (镜像 Windows LoadModData + TryTriggerSourcePanelLoad)
export function initChoiceHandlers() {
    try {
        loadChoiceHandlerData();
        registerChoiceHandlers();
        if (!chData.handlers.length)
            return;
        setTimeout(function () {
            chTriggerGOClass();
            tryFinalizeChoiceHandlers();
        }, 150);
        // 兜底轮询: finalize 需要源面板 + Resource<GameObject> 类齐 (探针实证双触发后 ~秒级出现)
        if (chPollTimer)
            return;
        var tries = 0;
        chPollTimer = setInterval(function () {
            tries++;
            try {
                if (chData.registered) {
                    // 注册后转保活模式: 每 5 秒检查 providersMap 物理存在 (场景切换可能重建)
                    if (tries % 10 === 0)
                        chKeepAlive();
                    if (tries > 7200) {
                        clearInterval(chPollTimer);
                        chPollTimer = null;
                    } // 1h 上限
                    return;
                }
                chTriggerGOClass();
                tryFinalizeChoiceHandlers();
                if (tries > 120) {
                    clearInterval(chPollTimer);
                    chPollTimer = null;
                    warn("[Choice] 注册超时(60s), 停轮询");
                }
            }
            catch (e) {
                dbg("[Choice] 轮询 err: " + e);
            }
        }, 500);
    }
    catch (e) {
        warn("[Choice] initChoiceHandlers err: " + e);
    }
}

✄
// ============ CutIn 支持 (镜像 Windows ModObjectionCutInLoader 精简版, 仅 sprite 替换) ============
// 链路: @gosubCutIn "<Id>" Index:N → GosubToObjectionCutIn.Execute (UniTask, 不 patch)
//   → 写变量 objectionCutInSpawnPath=<Kind 或 ObjectionCutIn_<Kind>> → 我们改写成 Hiro 模板
//   → MultipliableSpawn.Spawn("ObjectionCutIn_Hiro") → ObjectionCutIn.SetSpawnParameters
//   → 我们按 sprite 名替换 Image/SpriteRenderer 的 sprite (原版激活逻辑不动)。
// 移植自 v3.js 16h (仅 sprite 替换, 无 shader 覆盖 — Windows Shaders 配置未支持);
// 日志分级 (ARCHIVE 教训 2/3): hooks 就绪/注册数 = info, 机制证据 = dbg, 失败 = warn/error。
import { A, dbg, directCall, error, findClassAcrossImages, getSystemClass, invoke, invokeOk, makeS, pngDims, readStr, warn } from "./utils.js";
import { fileReadBytes, readJSONFile } from "./io.js";
import { info } from "./log.js";
var cutInCls = null; // 解析好的类表
var cutInData = {
    registry: {},
    texCache: {},
    spriteCache: {},
    pendingEntry: null,
    instCache: {},
    ready: false
};
var cutInHooksReady = false;
function resolveCutInClasses() {
    var m = {};
    m.texture2d = findClassAcrossImages("UnityEngine", "Texture2D");
    m.imageConversion = findClassAcrossImages("UnityEngine", "ImageConversion");
    m.image = findClassAcrossImages("UnityEngine.UI", "Image");
    m.spriteRenderer = findClassAcrossImages("UnityEngine", "SpriteRenderer");
    m.material = findClassAcrossImages("UnityEngine", "Material");
    m.sprite = findClassAcrossImages("UnityEngine", "Sprite");
    m.gameObject = findClassAcrossImages("UnityEngine", "GameObject");
    m.component = findClassAcrossImages("UnityEngine", "Component");
    m.object = findClassAcrossImages("UnityEngine", "Object");
    m.customVarMgr = findClassAcrossImages("Naninovel", "CustomVariableManager");
    m.objectionCutIn = findClassAcrossImages("WitchTrials.Views", "ObjectionCutIn");
    return m;
}
// pngDims 已移到 utils.js (choice.js 共用)
// 读每个 mod info.json 的 CutIns[] (Id/BaseTemplate/Sprites{原版名->相对路径}, ModItem.ModObjectionCutIn)
function loadCutInData() {
    cutInData.registry = {};
    cutInData.texCache = {};
    cutInData.spriteCache = {};
    if (typeof MOD_ROOT === "undefined" || typeof modList === "undefined" || !modList || !modList.length)
        return;
    for (var i = 0; i < modList.length; i++) {
        var root = MOD_ROOT + "/" + modList[i].key;
        var inf = readJSONFile(root + "/info.json"); // 注意: 变量名不能叫 info (遮蔽 import 的 info 日志函数)
        if (!inf || !inf.CutIns)
            continue;
        for (var c = 0; c < inf.CutIns.length; c++) {
            var ci = inf.CutIns[c];
            if (!ci || !ci.Id || !ci.Sprites)
                continue;
            if (cutInData.registry[ci.Id]) {
                warn("[v3] CutIn id 冲突, 跳过 '" + ci.Id + "'");
                continue;
            }
            var entry = { modRoot: root, id: ci.Id, sprites: {} };
            for (var k in ci.Sprites) {
                if (ci.Sprites[k])
                    entry.sprites[k] = { path: root + "/" + ci.Sprites[k] };
            }
            cutInData.registry[ci.Id] = entry;
            dbg("[v3] CutIn 注册 '" + ci.Id + "': " + Object.keys(entry.sprites).length + " 张 sprite");
        }
    }
    cutInData.ready = Object.keys(cutInData.registry).length > 0;
    if (cutInData.ready)
        info("[v3][CutIn] 共 " + Object.keys(cutInData.registry).length + " 个 mod CutIn");
}
// 兼容三种 spawnPath 格式: "<Kind>" / "ObjectionCutIn_<Kind>" / "CutIn/ObjectionCutIn_<Kind>"
function extractCutInKind(val) {
    var idx = val.indexOf("ObjectionCutIn_");
    if (idx >= 0) {
        var rest = val.substring(idx + 15);
        var slash = rest.indexOf("/");
        return slash >= 0 ? rest.substring(0, slash) : rest;
    }
    var slash2 = val.indexOf("/");
    return slash2 >= 0 ? val.substring(0, slash2) : val;
}
// hook CustomVariableManager.SetVariableValue onEnter: 改写 objectionCutInSpawnPath
// CustomVariableValue struct: type@0x0 (String=0), stringValue@0x8, numeric@0x10, bool@0x14
// 直接改写 struct 里的 string 指针 → callee 读到即改后值 (makeS 字符串作为参数安全, 仅字典 key 不可用)
function onCutInSetVariable(a) {
    if (!cutInData.ready)
        return;
    var name = readStr(a[1]);
    if (name !== "objectionCutInSpawnPath")
        return;
    var valPtr = a[2];
    if (!valPtr || valPtr.isNull())
        return;
    var type = valPtr.readS32();
    if (type !== 0)
        return;
    var str = readStr(valPtr.add(0x8).readPointer());
    if (!str) {
        cutInData.pendingEntry = null;
        return;
    }
    var kind = extractCutInKind(str);
    if (!kind)
        return;
    if (cutInData.registry[kind]) {
        cutInData.pendingEntry = cutInData.registry[kind];
        var newVal = str.replace(kind, "Hiro"); // 保留原始前缀结构, 只换 Kind → 原版 spawn 命中 Hiro prefab
        valPtr.add(0x8).writePointer(makeS(newVal));
        dbg("[v3] CutIn 改写 objectionCutInSpawnPath: '" + str + "' -> '" + newVal + "' (id=" + kind + ")");
    }
    else {
        cutInData.pendingEntry = null; // 原生模板 (Hiro/Ema/CreatureHiro) 清残留
    }
}
// 读文件 bytes → Texture2D (镜像 loadModTexture, 独立 cache); 返回 {tex,w,h}
function loadCutInTexture(path, cacheKey) {
    if (cutInData.texCache[cacheKey])
        return cutInData.texCache[cacheKey];
    try {
        var fb = fileReadBytes(path);
        if (!fb || fb.size <= 0) {
            warn("[v3] CutIn 读纹理失败 '" + path + "'");
            return null;
        }
        var dims = pngDims(fb);
        if (!dims) {
            warn("[v3] CutIn PNG 尺寸读取失败 '" + path + "'");
            return null;
        }
        var byteCls = getSystemClass("Byte");
        var barr = A.an(byteCls, fb.size);
        barr.add(0x20).writeByteArray(fb.buf.readByteArray(fb.size));
        var tex = A.on(cutInCls.texture2d);
        var wbuf = Memory.alloc(4);
        wbuf.writeS32(dims.w);
        var hbuf = Memory.alloc(4);
        hbuf.writeS32(dims.h);
        var ctorMi = A.cgm(cutInCls.texture2d, Memory.allocUtf8String(".ctor"), 2);
        if (ctorMi && !ctorMi.isNull())
            invokeOk(ctorMi, tex, [wbuf, hbuf]);
        var liMi = A.cgm(cutInCls.imageConversion, Memory.allocUtf8String("LoadImage"), 2);
        if (!liMi || liMi.isNull()) {
            warn("[v3] CutIn ImageConversion.LoadImage NOT FOUND");
            return null;
        }
        var r = invokeOk(liMi, ptr(0), [tex, barr]);
        if (!r.ok) {
            warn("[v3] CutIn LoadImage 失败 '" + path + "'");
            return null;
        }
        var ent = { tex: tex, w: dims.w, h: dims.h };
        cutInData.texCache[cacheKey] = ent;
        return ent;
    }
    catch (e) {
        warn("[v3] CutIn loadCutInTexture err '" + path + "': " + e);
        return null;
    }
}
// Sprite.Create(tex, Rect(0,0,w,h), Vector2(pivot), ppu, extrude) — 5 参重载 (4 参 macOS runtime_invoke 崩溃, 探针实测)
function makeModSprite(tex, texW, texH, pivotX, pivotY, ppu) {
    try {
        if (!tex || tex.isNull() || !texW || !texH) {
            warn("[v3] CutIn Sprite.Create 参数无效, 跳过");
            return null;
        }
        var rect = Memory.alloc(16);
        rect.writeFloat(0);
        rect.add(4).writeFloat(0);
        rect.add(8).writeFloat(texW);
        rect.add(12).writeFloat(texH);
        var pivot = Memory.alloc(8);
        pivot.writeFloat(pivotX);
        pivot.add(4).writeFloat(pivotY);
        var ppuPtr = Memory.alloc(4);
        ppuPtr.writeFloat(ppu || 100);
        var createMi = A.cgm(cutInCls.sprite, Memory.allocUtf8String("Create"), 5);
        if (!createMi || createMi.isNull()) {
            warn("[v3] CutIn Sprite.Create NOT FOUND");
            return null;
        }
        var extrude = Memory.alloc(4);
        extrude.writeU32(0);
        return invoke(createMi, ptr(0), [tex, rect, pivot, ppuPtr, extrude]);
    }
    catch (e) {
        warn("[v3] CutIn makeModSprite err: " + e);
        return null;
    }
}
function getObjName(objPtr) {
    try {
        if (!objPtr || objPtr.isNull())
            return null;
        var nmMi = A.cgm(cutInCls.object, Memory.allocUtf8String("get_name"), 0);
        if (!nmMi || nmMi.isNull())
            return null;
        var s = invoke(nmMi, objPtr, []);
        return readStr(s);
    }
    catch (e) {
        return null;
    }
}
// 收集实例子树的 Image/SpriteRenderer + 各组件当前 sprite 名 (非泛型 GetComponentsInChildren(Type,bool))
function ensureCutInCache(inst) {
    var key = ptr(inst).toString();
    if (cutInData.instCache[key])
        return cutInData.instCache[key];
    var cache = { images: [], imageNames: [], renderers: [], rendererNames: [], vanillaSpr: {} };
    try {
        var go = null;
        try {
            var ggMi = A.cgm(cutInCls.component, Memory.allocUtf8String("get_gameObject"), 0);
            if (ggMi && !ggMi.isNull())
                go = invoke(ggMi, inst, []);
        }
        catch (e) { }
        if (go && !go.isNull()) {
            var gicMi = A.cgm(cutInCls.gameObject, Memory.allocUtf8String("GetComponentsInChildren"), 2);
            var getImgSprMi = A.cgm(cutInCls.image, Memory.allocUtf8String("get_sprite"), 0);
            var getSrSprMi = A.cgm(cutInCls.spriteRenderer, Memory.allocUtf8String("get_sprite"), 0);
            if (gicMi && !gicMi.isNull()) {
                var tbool = Memory.alloc(4);
                tbool.writeS32(1);
                function collect(arr, getSprMi, list, nameList) {
                    if (!arr || arr.isNull())
                        return;
                    var len = arr.add(0x18).readS32();
                    for (var i = 0; i < len; i++) {
                        var e = arr.add(0x20 + i * 8).readPointer();
                        if (!e || e.isNull())
                            continue;
                        var sp = (getSprMi && !getSprMi.isNull()) ? invoke(getSprMi, e, []) : ptr(0);
                        var nm = sp && !sp.isNull() ? getObjName(sp) : null;
                        if (nm && !cache.vanillaSpr[nm])
                            cache.vanillaSpr[nm] = sp;
                        list.push(e);
                        nameList.push(nm || "");
                    }
                }
                collect(invoke(gicMi, go, [A.tgo(A.cgt(cutInCls.image)), tbool]), getImgSprMi, cache.images, cache.imageNames);
                collect(invoke(gicMi, go, [A.tgo(A.cgt(cutInCls.spriteRenderer)), tbool]), getSrSprMi, cache.renderers, cache.rendererNames);
            }
        }
    }
    catch (e) {
        warn("[v3] CutIn ensureCutInCache err: " + e);
    }
    cutInData.instCache[key] = cache;
    dbg("[v3] CutIn 实例缓存: " + cache.images.length + " Image, " + cache.renderers.length + " SpriteRenderer");
    // 2026-08-11 诊断: 全量渲染器名 (StainedGlass/001 缺失排查 — 名字匹配是 swap 的唯一依据)
    if (cache.renderers.length) {
        var names = [];
        for (var i = 0; i < cache.rendererNames.length; i++)
            names.push(i + "=" + (cache.rendererNames[i] || "(无名)"));
        dbg("[v3] CutIn 渲染器名: " + names.join(" | "));
    }
    return cache;
}
// 延迟创建 Sprite, pivot/ppu 取原版 sprite
function getOrCreateCutInSprite(reg, vanillaName, vanillaSpr) {
    var cacheKey = reg.id + "/" + vanillaName;
    if (cutInData.spriteCache[cacheKey] !== undefined)
        return cutInData.spriteCache[cacheKey];
    try {
        var ent = loadCutInTexture(reg.sprites[vanillaName].path, cacheKey);
        if (!ent || !ent.tex) {
            cutInData.spriteCache[cacheKey] = null;
            return null;
        }
        var px = 0.5, py = 0.5, ppu = 100, rw = 0, rh = 0;
        if (vanillaSpr && !vanillaSpr.isNull()) {
            try {
                var rectMi = A.cgm(cutInCls.sprite, Memory.allocUtf8String("get_rect"), 0);
                var pivMi = A.cgm(cutInCls.sprite, Memory.allocUtf8String("get_pivot"), 0);
                var ppuMi = A.cgm(cutInCls.sprite, Memory.allocUtf8String("get_pixelsPerUnit"), 0);
                // 2026-08-12 根因修复: ppu 是 float 值类型返回, il2cpp_runtime_invoke 的
                // 缓冲返回垃圾 (实测 1.77e-18) → 必须直调 methodPointer 读 s0。蓝本: ppu>0?ppu:100
                if (ppuMi && !ppuMi.isNull()) {
                    try {
                        var ppuV = directCall(ppuMi, "float", [vanillaSpr]);
                        if (ppuV > 0)
                            ppu = ppuV;
                    }
                    catch (e3) {
                        dbg("[v3] CutIn ppu 直调失败: " + e3);
                    }
                }
                // rect/pivot 是 HFA (16B/8B, s0-s3 返回), 直调不可取 → 走 invoke 缓冲 + 归一化守卫
                if (rectMi && !rectMi.isNull()) {
                    try {
                        var rp = invoke(rectMi, vanillaSpr, []);
                        if (rp && !rp.isNull()) {
                            rw = rp.add(8).readFloat();
                            rh = rp.add(12).readFloat();
                        }
                    }
                    catch (e2) { }
                }
                if (pivMi && !pivMi.isNull() && rw > 0.001 && rh > 0.001) {
                    try {
                        var pp = invoke(pivMi, vanillaSpr, []);
                        if (pp && !pp.isNull()) {
                            var pvx = pp.readFloat(), pvy = pp.add(4).readFloat();
                            if (isFinite(pvx) && isFinite(pvy)) {
                                px = pvx / rw;
                                py = pvy / rh;
                            }
                        }
                    }
                    catch (e4) { }
                }
                // 归一化守卫: 缓冲垃圾或 rect 无效 → 回落 0.5 (蓝本 rect 无效时的同款回落)
                if (!(px >= 0 && px <= 1))
                    px = 0.5;
                if (!(py >= 0 && py <= 1))
                    py = 0.5;
            }
            catch (e) { }
        }
        dbg("[v3] CutIn Sprite.Create '" + vanillaName + "' pivot=(" + px.toFixed(3) + "," + py.toFixed(3) + ") ppu=" + ppu + " rect=" + rw.toFixed(1) + "x" + rh.toFixed(1) + " tex=" + ent.w + "x" + ent.h);
        cutInData.spriteCache[cacheKey] = makeModSprite(ent.tex, ent.w, ent.h, px, py, ppu);
        return cutInData.spriteCache[cacheKey];
    }
    catch (e) {
        warn("[v3] CutIn getOrCreateCutInSprite err: " + e);
        cutInData.spriteCache[cacheKey] = null;
        return null;
    }
}
// 2026-08-12 诊断 v2: shader 名 + 替换后延迟 re-dump sprite 名 (检测游戏动画覆盖)
// 蓝本有 RoleForShaderName (5 角色: Background_0Fix/Glasses_0Fix/Iuminescence_dezolve_0Fix/Shadow_Fix/Iuminescence_Silhouette_0Fix)
function dumpCutInShaders(cache) {
    try {
        var matMi = A.cgm(cutInCls.spriteRenderer, Memory.allocUtf8String("get_sharedMaterial"), 0);
        var sdrMi = A.cgm(cutInCls.material, Memory.allocUtf8String("get_shader"), 0);
        var out = [];
        for (var i = 0; i < cache.renderers.length; i++) {
            var sdr = "?";
            try {
                var mat = matMi && !matMi.isNull() ? invoke(matMi, cache.renderers[i], []) : null;
                if (mat && !mat.isNull()) {
                    var sh = sdrMi && !sdrMi.isNull() ? invoke(sdrMi, mat, []) : null;
                    if (sh && !sh.isNull())
                        sdr = getObjName(sh) || "?";
                }
            }
            catch (e) { }
            out.push(i + "='" + (cache.rendererNames[i] || "(无名)") + "' shader=" + sdr);
        }
        dbg("[v3] CutIn 渲染器 shader: " + out.join(" | "));
    }
    catch (e) {
        warn("[v3] CutIn dumpShaders err: " + e);
    }
}
// 替换后延迟 re-dump 当前 sprite 名 — 若游戏动画/代码把 sprite 覆盖回原版, 会在这里暴露
function scheduleSpriteReDump(cache, reg, tag) {
    try {
        setTimeout(function () {
            try {
                var names = [];
                for (var i = 0; i < cache.renderers.length; i++) {
                    var sp = null;
                    try {
                        var getSprMi = A.cgm(cutInCls.spriteRenderer, Memory.allocUtf8String("get_sprite"), 0);
                        if (getSprMi && !getSprMi.isNull())
                            sp = invoke(getSprMi, cache.renderers[i], []);
                    }
                    catch (e) { }
                    names.push(i + "=" + (sp && !sp.isNull() ? (getObjName(sp) || "?") : "null"));
                }
                dbg("[v3] CutIn " + tag + " 后 sprite: " + names.join(" | "));
            }
            catch (e) {
                warn("[v3] CutIn reDump err: " + e);
            }
        }, 1000);
    }
    catch (e) {
        warn("[v3] CutIn scheduleReDump err: " + e);
    }
}
// 按 sprite 名替换 Image/SpriteRenderer 的 sprite (原版激活逻辑不动)
function swapCutInSprites(inst, reg) {
    var cache = ensureCutInCache(inst);
    var setImgSprMi = A.cgm(cutInCls.image, Memory.allocUtf8String("set_sprite"), 1);
    var setSrSprMi = A.cgm(cutInCls.spriteRenderer, Memory.allocUtf8String("set_sprite"), 1);
    var swapped = 0;
    for (var i = 0; i < cache.images.length; i++) {
        var nm = cache.imageNames[i];
        if (!reg.sprites[nm])
            continue;
        var sp = getOrCreateCutInSprite(reg, nm, cache.vanillaSpr[nm]);
        if (!sp) {
            warn("[v3] CutIn sprite 创建失败 '" + nm + "' -> " + reg.sprites[nm].path);
            continue;
        }
        if (setImgSprMi && !setImgSprMi.isNull()) {
            invoke(setImgSprMi, cache.images[i], [sp]);
            swapped++;
            dbg("[v3] CutIn 替换 Image#" + i + " '" + nm + "' -> " + reg.sprites[nm].path);
        }
    }
    for (var j = 0; j < cache.renderers.length; j++) {
        var rn = cache.rendererNames[j];
        if (!reg.sprites[rn])
            continue;
        var sp2 = getOrCreateCutInSprite(reg, rn, cache.vanillaSpr[rn]);
        if (!sp2) {
            warn("[v3] CutIn sprite 创建失败 '" + rn + "' -> " + reg.sprites[rn].path);
            continue;
        }
        if (setSrSprMi && !setSrSprMi.isNull()) {
            invoke(setSrSprMi, cache.renderers[j], [sp2]);
            swapped++;
            dbg("[v3] CutIn 替换 SR#" + j + " '" + rn + "' -> " + reg.sprites[rn].path);
        }
    }
    info("[v3][CutIn] '" + reg.id + "' 替换 " + swapped + " 个组件" + (swapped ? "" : " (0 命中, sprite 名未匹配)"));
    dumpCutInShaders(cache);
    scheduleSpriteReDump(cache, reg, "替换后1s");
}
// 回标题清实例缓存 (旧实例指针可能失效) — TitleUi.Activate 时调用
export function clearCutInCaches() {
    cutInData.instCache = {};
    cutInData.pendingEntry = null;
}
export function setupCutInHooks() {
    try {
        if (cutInHooksReady)
            return;
        cutInCls = resolveCutInClasses();
        if (cutInCls.customVarMgr.isNull() || cutInCls.objectionCutIn.isNull() || cutInCls.image.isNull()) {
            warn("[v3] CutIn 类解析失败 (CustomVariableManager/ObjectionCutIn/Image)");
            return;
        }
        loadCutInData();
        if (!cutInData.ready) {
            dbg("[v3] CutIn: 无 mod cut-in, 跳过 hook 装配");
            return;
        }
        // hook1: CustomVariableManager.SetVariableValue(string, CustomVariableValue) — onEnter 改写
        var svvMi = A.cgm(cutInCls.customVarMgr, Memory.allocUtf8String("SetVariableValue"), 2);
        if (svvMi && !svvMi.isNull()) {
            Interceptor.attach(svvMi.readPointer(), {
                onEnter: function (a) { try {
                    onCutInSetVariable(a);
                }
                catch (e) {
                    dbg("[v3] CutIn onSetVariable err: " + e);
                } }
            });
            dbg("[v3] CutIn SetVariableValue hooked");
        }
        // hook2: ObjectionCutIn.SetSpawnParameters(IReadOnlyList<string>, bool) — onLeave 换 sprite
        var sspMi = A.cgm(cutInCls.objectionCutIn, Memory.allocUtf8String("SetSpawnParameters"), 2);
        if (sspMi && !sspMi.isNull()) {
            Interceptor.attach(sspMi.readPointer(), {
                onEnter: function (a) { this._inst = a[0]; },
                onLeave: function () {
                    try {
                        if (!this._inst || this._inst.isNull())
                            return;
                        var reg = cutInData.pendingEntry;
                        cutInData.pendingEntry = null;
                        if (reg)
                            swapCutInSprites(this._inst, reg);
                    }
                    catch (e) {
                        warn("[v3] CutIn onSpawnParams err: " + e);
                    }
                }
            });
            dbg("[v3] CutIn SetSpawnParameters hooked");
        }
        cutInHooksReady = true;
        info("[v3][CutIn] hooks 就绪");
    }
    catch (e) {
        warn("[v3] CutIn setupCutInHooks err: " + e);
    }
}

✄
// ============ 原生文件 I/O (Frida 运行时无 File/readFileSync, 用 libc open/read/lseek/write) ============
// 读: fileReadString/fileReadBytes/fileExists/readJSONFile
// 写: openForWrite/writeString/fileSync (日志系统 log.js 使用)
// 注: io.js 不再 import utils.js (避免 utils→log→io→utils 环); 本地 iodbg 等价 (MOD_DEBUG 启动时定死)。
var ioApi = null;
function iodbg() { if (typeof globalThis !== "undefined" && globalThis.MOD_DEBUG)
    console.log.apply(console, arguments); }
export function getIO() {
    if (ioApi)
        return ioApi;
    var mk = function (name, ret, args) {
        var a = Module.findGlobalExportByName(name);
        return a ? new NativeFunction(a, ret, args) : null;
    };
    ioApi = {
        open: mk("open", 'int', ['pointer', 'int', 'int']),
        close: mk("close", 'int', ['int']),
        read: mk("read", 'int', ['int', 'pointer', 'uint']),
        write: mk("write", 'long', ['int', 'pointer', 'uint']),
        lseek: mk("lseek", 'long', ['int', 'long', 'int']),
        access: mk("access", 'int', ['pointer', 'int']),
        fsync: mk("fsync", 'int', ['int'])
    };
    return ioApi;
}
export function fileReadString(path) {
    try {
        var io = getIO();
        if (!io.open)
            return null;
        var fd = io.open(Memory.allocUtf8String(path), 0, 0);
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
        var fd = io.open(Memory.allocUtf8String(path), 0, 0);
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
            iodbg("readJSONFile 读取失败 '" + path + "'");
            return null;
        }
        var parsed = JSON.parse(s);
        // 诊断: 检测多字节 locale (ja) 是否在解析后被丢失
        // 若 fileReadString 截断或 JSON.parse 静默失败, ja keys 会消失
        var sHasJa = s.indexOf('"ja"') >= 0;
        if (sHasJa) {
            iodbg("readJSONFile '" + path + "' len=" + s.length + " 含'\"ja\"' 但需验证解析后是否保留");
        }
        return parsed;
    }
    catch (e) {
        iodbg("readJSONFile 解析失败 '" + path + "': " + e);
        return null;
    }
}
// ===== 写入路径 (日志系统) =====
export function openForWrite(path) {
    try {
        var io = getIO();
        if (!io.open)
            return -1;
        // Darwin fcntl: O_WRONLY=0x0001 O_CREAT=0x0200 O_TRUNC=0x0400
        return io.open(Memory.allocUtf8String(path), 0x0001 | 0x0200 | 0x0400, 0o644);
    }
    catch (e) {
        return -1;
    }
}
export function writeString(fd, s) {
    try {
        var io = getIO();
        if (!io.write || fd < 0)
            return -1;
        var buf = Memory.allocUtf8String(s);
        var len = 0;
        while (buf.add(len).readU8() !== 0)
            len++; // UTF-8 字节长 (扫 NUL, 免编码坑)
        var off = 0;
        while (off < len) {
            var r = io.write(fd, buf.add(off), len - off); // 部分写入循环, r<=0 兜底
            if (r <= 0)
                break;
            off += r;
        }
        return off;
    }
    catch (e) {
        return -1;
    }
}
export function fileSync(fd) {
    try {
        var io = getIO();
        if (io.fsync && fd >= 0)
            return io.fsync(fd);
    }
    catch (e) { }
    return -1;
}

✄
// ============ 日志系统: 级别 / 颜色 / 时间戳 / 文件写入 / 崩溃前 flush ============
// 机制: bundle 内所有日志 (wblog/dbg/Unity dumpObj) 经此模块统一输出。
//   console 彩色 (ERROR红/WARN黄/INFO青/DEBUG灰), 文件明文逐行同步写 (崩溃不丢已写行)。
//   文件路径: MOD_LOG fragment (run_mod.sh 注入) 或可执行文件上溯到游戏根; 每运行截断重开。
// 约束: 所有日志调用在 initLog 之后 (entry.js 顶层先 initLog 再装 crash handler)。
import { openForWrite, writeString, fileSync } from "./io.js";
export var LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
var LEVEL_TAG = ["ERROR", "WARN", "INFO", "DEBUG"];
var LEVEL_COLOR = ["31", "33", "36", "90"]; // 红 / 黄 / 青 / 灰
var _fd = -1, _path = null, _noColor = false, _initDone = false, _handlerFired = false;
function isDbg() { return typeof MOD_DEBUG !== "undefined" && MOD_DEBUG; }
function ts() {
    var d = new Date();
    var p2 = function (n) { return (n < 10 ? "0" : "") + n; };
    var p3 = function (n) { n = Math.floor(n); return (n < 100 ? "0" : "") + (n < 10 ? "0" : "") + n; };
    return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()) + "." + p3(d.getMilliseconds());
}
function isoDate() {
    var d = new Date();
    var p2 = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
}
// 兜底路径 (未走 run_mod.sh, 如 REPL): 从主模块可执行路径上溯 4 级到游戏根
function defaultLogPath() {
    try {
        var p = Process.mainModule ? Process.mainModule.path : "";
        if (p) {
            var ps = p.split("/");
            if (ps.length > 4)
                return ps.slice(0, ps.length - 4).join("/") + "/modlog.txt";
        }
    }
    catch (e) { }
    return null;
}
export function initLog(path, noColor) {
    if (_initDone)
        return;
    _initDone = true;
    _noColor = !!noColor;
    var p = path || defaultLogPath();
    if (p) {
        _fd = openForWrite(p);
        if (_fd >= 0)
            _path = p;
    }
    if (_fd < 0) {
        try {
            console.log("[v3][log] modlog 文件不可用: " + (p || "<未指定>") + " (仅终端)");
        }
        catch (e) { }
        return;
    }
    // 会话头 (文件明文首段, 自描述)
    var hdr = "[v3][" + isoDate() + " " + ts() + "][session] ==== manosabamod 运行开始 ====\n" +
        "[v3][session] modlog=" + p + " MOD_DEBUG=" + isDbg() + " noColor=" + _noColor + "\n";
    writeString(_fd, hdr);
}
function emit(level, args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
        var v = args[i];
        parts.push(v === undefined ? "undefined" : v === null ? "null" : String(v));
    }
    var msg = parts.join(" ");
    var line = "[v3][" + ts() + "][" + LEVEL_TAG[level] + "] " + msg;
    if (_noColor)
        console.log(line);
    else
        console.log("\x1b[" + LEVEL_COLOR[level] + "m" + line + "\x1b[0m");
    if (_fd >= 0) {
        // 文件明文: 无 ANSI; 消息内换行 → 续行缩进 4 格 (每条逻辑记录从列 0 开始, 好 grep)
        var rec = line.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\n    ");
        writeString(_fd, rec + "\n");
    }
}
export function error() { emit(LEVELS.ERROR, arguments); }
export function warn() { emit(LEVELS.WARN, arguments); }
export function info() { emit(LEVELS.INFO, arguments); }
export function debug() { if (isDbg())
    emit(LEVELS.DEBUG, arguments); }
// dumpObj 等按级别路由的入口: logLevel(lv, ...args)
export function logLevel(level) { emit(level, Array.prototype.slice.call(arguments, 1)); }
// ASCII 横幅 (MOD 初始化阶段): 整块原样输出保持对齐, 不带逐行 [v3][ts][LEVEL] 前缀;
// 终端青色 (36, 与 INFO 同系), 文件明文原样。约束同 emit (initLog 之后调用)。
export function logBanner(art) {
    if (!art)
        return;
    var lines = String(art).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (_noColor)
            console.log(ln);
        else
            console.log("\x1b[36m" + ln + "\x1b[0m");
        if (_fd >= 0)
            writeString(_fd, ln + "\n");
    }
}
// ===== 崩溃前 flush =====
// 进程将崩溃时 (SIGSEGV/SIGABRT 等) 追加一条尾部标记到文件。回调运行在异常上下文,
// 禁 console/RPC (死锁风险), 只做同步文件 write + fsync; 返回 false 放行 → 游戏崩溃行为不变。
// 若 Frida 提供了 CPU 上下文 (details.context), 顺带写原生回溯 — 定位 invoke 内访问违例的决定性手段。
function crashLine(details) {
    if (_fd < 0)
        return;
    try {
        var type = details && details.type, addr = details && details.address;
        var line = "[v3][" + ts() + "][FATAL] !!! CRASH signal=" + (type || "?") + " address=" + (addr ? addr.toString() : "0x0") + "\n";
        writeString(_fd, line);
        if (details && details.context) {
            try {
                // 寄存器转储 — macOS .ips 不生成时 (异常被 handler 接过) 也能拿到崩溃上下文
                var c = details.context;
                var regs = [];
                for (var ri = 0; ri <= 28; ri++) {
                    try {
                        var rn = c["x" + ri];
                        regs.push("x" + ri + "=0x" + rn.toString(16));
                    }
                    catch (e) { }
                }
                try {
                    regs.push("fp=0x" + c.fp.toString(16));
                }
                catch (e) { }
                try {
                    regs.push("lr=0x" + c.lr.toString(16));
                }
                catch (e) { }
                try {
                    regs.push("sp=0x" + c.sp.toString(16));
                }
                catch (e) { }
                try {
                    regs.push("pc=0x" + c.pc.toString(16));
                }
                catch (e) { }
                writeString(_fd, "    regs: " + regs.join(" ") + "\n");
            }
            catch (e) { }
            try {
                var frames = Thread.backtrace(details.context, Backtracer.ACCURATE).slice(0, 24);
                for (var i = 0; i < frames.length; i++) {
                    var sym = "";
                    try {
                        var d = DebugSymbol.fromAddress(frames[i]);
                        sym = d ? d.name : "";
                    }
                    catch (e) { }
                    writeString(_fd, "    #" + i + " 0x" + frames[i].toString(16) + (sym ? "  " + sym : "") + "\n");
                }
            }
            catch (e) { }
        }
        fileSync(_fd);
    }
    catch (e) { }
}
// 通用崩溃兜底: 模块可注册一个 fixer, 在异常上下文中先尝试修复再决定放行/恢复。
// fixer(details) 返回 true = 已处理 (已改 details.context, 让 Frida return true 恢复执行);
// 返回 false/undefined = 未处理 → 照常写 CRASH 行 + 放行崩溃。
// 约束: fixer 运行在异常上下文, 禁 console/RPC/分配 — 只读预缓存 + 改 context 寄存器。
var _crashFixer = null;
export function setCrashFixer(fn) { _crashFixer = fn; }
export function installCrashHandler() {
    if (typeof Process === "undefined" || !Process.setExceptionHandler) {
        installCrashHandlerFallback();
        return;
    }
    try {
        Process.setExceptionHandler(function (details) {
            // 落盘标记 (capture-once, 文件直写不走 console — 异常上下文安全) — 判断 handler 是否真正触发
            try {
                if (!_handlerFired) {
                    _handlerFired = true;
                    var _fa = (details && details.address) ? details.address.toString() : "?";
                    writeString(_fd, "[v3][FATAL][handler] setExceptionHandler FIRED address=" + _fa + "\n");
                }
            }
            catch (e) { }
            if (_crashFixer) {
                try {
                    if (_crashFixer(details)) {
                        try {
                            writeString(_fd, "[v3][FATAL][handler] fixer HANDLED address=" + ((details && details.address) ? details.address.toString() : "?") + "\n");
                        }
                        catch (e) { }
                        return true;
                    }
                }
                catch (e) { }
            }
            try {
                crashLine(details);
            }
            catch (e) { }
            return false; // 不链式转发 (返回语义未承诺), 直接放行崩溃
        });
    }
    catch (e) {
        installCrashHandlerFallback();
    }
}
function installCrashHandlerFallback() {
    // setExceptionHandler 不可用备选: 钩 abort / __pthread_kill(SIGABRT=6)
    try {
        var a = Module.findGlobalExportByName("abort");
        if (a)
            Interceptor.attach(a, { onEnter: function () { crashLine("abort", ptr(0)); } });
        var k = Module.findGlobalExportByName("__pthread_kill");
        if (k)
            Interceptor.attach(k, { onEnter: function (ar) { try {
                    if (ar[1] && ar[1].toInt32() === 6)
                        crashLine("SIGABRT", ptr(0));
                }
                catch (e) { } } });
    }
    catch (e) { }
}

✄
// ============ 菜单域: 菜单文本 (含翻页, 回迁自 16h 版) + 剧本注册 + StartGame @goto 重定向 ============
// 镜像 Windows AddModStartMenu (ModResourceLoader.cs) + HookStartGame
import { A, dbg, findClassAcrossImages, findSvc, findUnityImg, gotoModifiedCls, invoke, invokeOk, makeLocalResourceProvider, makeNamedStringCtor, makeS, makeUnityObject, readStr } from "./utils.js";
var modScriptPrefix = "ModLoader";
var modMenuScript = "ModStart";
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
            dbg("[v3] 无法获取 TextAsset 类");
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
        dbg("[v3] FromText 成功, script=" + script);
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
            dbg("[v3] 无法获取类指针");
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
        var sp = findSvc("WitchTrialsScriptPlayer", true);
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
                    // Path.SetValue(NamedString(value="ModStart", name=""))
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
import { A, dbg, findClassAcrossImages, findSvc, getGenericArgClass, invoke, invokeOk, makeLocalResourceProvider, makeS, populateConvertersDict, readStr, wblog, error, warn } from "./utils.js";
import { addCharacterProviders } from "./witchbook/characters.js";
// 扫描 ResourceLoader.ProvisionSources (List<ProvisionSource>) 现有条目, 返回 {cnt, has, items}
// ProvisionSource struct = { IResourceProvider Provider @+0; string PathPrefix @+8 } (16B)
// 字段查找与 insertProvisionSource 同路径: A.gf 沿继承链找 (ProvisionSources 在父类 ResourceLoader`1)
function _scanProvisionSources(rl, prefix) {
    var out = { cnt: 0, has: false, items: null, listPtr: null };
    try {
        var rlKlass = A.ogc(rl);
        var psField = A.gf(rlKlass, Memory.allocUtf8String("ProvisionSources"));
        if (!psField || psField.isNull())
            return out;
        var list = rl.add(A.fo(psField)).readPointer();
        if (!list || list.isNull())
            return out;
        out.listPtr = list;
        var sz = list.add(0x18).readS32();
        if (sz < 0 || sz > 1024)
            return out;
        out.cnt = sz;
        if (sz === 0)
            return out;
        var itemsArr = list.add(0x10).readPointer();
        if (!itemsArr || itemsArr.isNull())
            return out;
        out.items = itemsArr;
        for (var i = 0; i < sz; i++) {
            try {
                var ps = itemsArr.add(0x20 + i * 16);
                var pfxPtr = ps.add(8).readPointer();
                if (pfxPtr && !pfxPtr.isNull()) {
                    var ex = readStr(pfxPtr);
                    if (ex === prefix) {
                        out.has = true;
                        break;
                    }
                }
            }
            catch (e) { }
        }
    }
    catch (e) { }
    return out;
}
// 把 provision source 插入 ResourceLoader 的 ProvisionSources
// 去重: 扫描现有条目, 若同 prefix 已存在则跳过 (防 TitleUi.Activate 多次触发 + 重注入窗口累积)
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
        // 去重: 同 prefix 已在列表则视为成功 (幂等). 静默: 重注入帧每帧 16×5 行噪音.
        var scan = _scanProvisionSources(rl, prefix);
        if (scan.has)
            return true;
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
        dbg("[v3] " + tag + ": Insert(" + prefix + ") → " + (r.ok ? "成功" : "失败") + " 条数=" + psList.add(0x18).readS32());
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
        var am = findSvc("AudioManagerExtended", true);
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
            warn("[v3] addBackgroundProviders: BackgroundManagerExtended NOT FOUND");
            return;
        }
        var galMi = A.cgm(A.ogc(bm), Memory.allocUtf8String("GetAppearanceLoader"), 1);
        if (!galMi || galMi.isNull()) {
            warn("[v3] addBackgroundProviders: GetAppearanceLoader NOT FOUND");
            return;
        }
        var texFn = function () { return findClassAcrossImages("UnityEngine", "Texture2D"); };
        var backIds = ["MainBackground", "Stills", "Tricks"];
        var addedNames = [];
        for (var i = 0; i < backIds.length; i++) {
            try {
                var loader = invoke(galMi, bm, [makeS(backIds[i])]);
                if (!loader || loader.isNull()) {
                    warn("[v3] 背景 loader '" + backIds[i] + "' 为空");
                    continue;
                }
                var scan = _scanProvisionSources(loader, prefix + "/Backgrounds/" + backIds[i]);
                if (scan.has)
                    continue; // 重注入 no-op: 已在列表, 静默
                var lrp = makeLocalResourceProvider(root);
                if (lrp.isNull()) {
                    warn("[v3] 背景 LRP 创建失败 ('" + backIds[i] + "')");
                    continue;
                }
                if (!populateConvertersDict(lrp, "JpgOrPngToTextureConverter", texFn, "Backgrounds/" + backIds[i])) {
                    warn("[v3] 背景 converters 填充失败 ('" + backIds[i] + "')");
                    continue;
                }
                if (insertProvisionSource(loader, lrp, prefix + "/Backgrounds/" + backIds[i], "Backgrounds/" + backIds[i]))
                    addedNames.push(backIds[i]);
            }
            catch (e) {
                error("[v3] 背景 '" + backIds[i] + "' 注入 err: " + e);
            }
        }
        // 只在真正新增时记 wblog, 且每 burst 只记首条 (一次切语言 FSG ×几十次重注入,
        // 每波都真重插某个 loader → 只让第一条可见); 重注入 no-op 静默。
        if (addedNames.length > 0) {
            if (!_localeReinject.bgLoggedThisBurst) {
                wblog("[v3] addBackgroundProviders 完成: 新增 [" + addedNames.join(",") + "] (" + backIds.join("/") + ")");
                _localeReinject.bgLoggedThisBurst = true;
            }
            else {
                dbg("[v3] addBackgroundProviders 新增 [" + addedNames.join(",") + "] (burst 内重复)");
            }
        }
        else {
            dbg("[v3] addBackgroundProviders 完成 (已在列表, 重注入 no-op)");
        }
    }
    catch (e) {
        error("[v3] addBackgroundProviders err: " + e);
    }
}
export function addModLoader(root, prefix) {
    try {
        var sm = findSvc("ScriptManager");
        if (!sm) {
            error("[v3] addModLoader: ScriptManager NOT FOUND (prefix='" + prefix + "')");
            return;
        }
        var rl = sm.add(0x28).readPointer();
        if (rl.isNull()) {
            error("[v3] addModLoader: scriptLoader NULL (prefix='" + prefix + "')");
            return;
        }
        // 剧本 provider: LRP(MOD_ROOT) + NaniToScriptAssetConverter + ProvisionSource(prefix/Scripts)
        var lrp = makeLocalResourceProvider(root);
        if (lrp.isNull()) {
            error("[v3] addModLoader: LRP 创建失败 (root='" + root + "')");
            return;
        }
        var scriptFn = function () { return findClassAcrossImages("Naninovel", "Script"); };
        if (!populateConvertersDict(lrp, "NaniToScriptAssetConverter", scriptFn, "Script")) {
            error("[v3] addModLoader: Script converters 失败 ('" + prefix + "')");
            return;
        }
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
        error("[v3] addModLoader err: " + e);
    }
}
// ============ 语言切换重注入 (镜像上游 Windows LocaleWatcherComponent, commit 66e5388b) ============
// 根因: Naninovel 切语言会对每个 LocalizableResourceLoader<T>.InitializeProvisionSources() 重建
//       ProvisionSources 列表, mod 注入的 provider 全被抹掉 → 剧本卡死/标题黑屏.
// 修法 (2026-08-18 修订): hook ResourceLoader<T>.HandleLocaleChanged (FSG 共享泛型代码体 —
//       一次覆盖所有 T 实例化), 检测到切语言后 onLeave 同步重注入.
// 移除 setTimeout 帧链 (旧版): Frida 的 JS timer 跑在脚本线程而非 Unity 主线程,
//       与主线程异步 reload (UniTask 续体) 竞争 → 2026-08-18 多次 SIGBUS/SIGSEGV 崩溃候选根因.
//       改为纯主线程同步重注入 (与上游 MonoBehaviour.Update 主线程语义对齐).
// macOS 特化点 (相对上游): ① 覆盖面含 Backgrounds (标题黑屏根因); ② insertProvisionSource 已带去重.
var _localeReinject = {
    inProgress: false,
    totalReinjects: 0,
    lastReason: "",
    bgLoggedThisBurst: false // addBackgroundProviders 的"新增"日志: 每 burst 只记首条 (首次加载也算一 burst)
};
// 同步重注入 (主线程, hook onLeave 上下文内执行).
// 对每个 mod 重跑 addModLoader — insertProvisionSource 自带去重 (同 prefix 已在列表则跳过),
// 幂等可反复调用. 每次切语言 HandleLocaleChanged 会被每个 loader 实例触发 (FSG ×几十),
// 每次触发都同步重注入一次, 覆盖各 loader 各自的 wipe+reload 窗口 (漏一次就丢 provider).
// 重注入不能合并 (各 loader 各自 wipe 的时序), 但日志要合并: 同 reason (同一次切语言) 只打首条.
export function startReinjectWindow(reason) {
    if (_localeReinject.inProgress)
        return; // 重入合并: 注入中再触发直接忽略
    _localeReinject.inProgress = true;
    try {
        _localeReinject.totalReinjects++;
        var sameBurst = (reason === _localeReinject.lastReason);
        _localeReinject.lastReason = reason;
        if (!sameBurst)
            _localeReinject.bgLoggedThisBurst = false; // 新 burst: 允许下一条"新增"记 wblog
        if (sameBurst) {
            dbg("[v3] 语言切换重注入 #" + _localeReinject.totalReinjects + " (" + reason + ") 同 burst 第 N 次 (FSG 多实例), 已注入");
        }
        else {
            wblog("[v3] ==== 语言切换重注入 #" + _localeReinject.totalReinjects + " (" + reason + ") ====");
        }
        _reinjectAll();
    }
    catch (e) {
        dbg("[v3] 重注入 err: " + e);
    }
    _localeReinject.inProgress = false;
}
// 单次全量重注入: 遍历 modList 重跑 addModLoader; 记录 scriptLoader ProvisionSources 前后条数做诊断
function _reinjectAll() {
    if (typeof modList === "undefined" || !modList || !modList.length) {
        dbg("[v3] modList 为空, 重注入跳过");
        return;
    }
    var root = (typeof MOD_ROOT !== "undefined") ? MOD_ROOT : "";
    var errors = 0, beforeCnt = -1, afterCnt = -1;
    var scriptLoader = null;
    try {
        var sm = findSvc("ScriptManager");
        if (sm && !sm.isNull()) {
            var sl = sm.add(0x28).readPointer();
            if (!sl.isNull()) {
                scriptLoader = sl;
                beforeCnt = _scanProvisionSources(sl, "").cnt;
            }
        }
    }
    catch (e) { }
    for (var mi = 0; mi < modList.length; mi++) {
        try {
            addModLoader(root, modList[mi].key);
        }
        catch (e) {
            errors++;
            if (errors <= 3)
                dbg("[v3] 重注入 addModLoader('" + modList[mi].key + "') err: " + e);
        }
    }
    if (scriptLoader) {
        try {
            afterCnt = _scanProvisionSources(scriptLoader, "").cnt;
        }
        catch (e) { }
        dbg("[v3] 重注入后 scriptLoader ProvisionSources: " + beforeCnt + " → " + afterCnt + " (addModLoader 错误 " + errors + ")");
    }
}
// 挂载钩子说明: 实际 hook 在 choice.js 的 chHookClassMethods (HandleLocaleChanged @ FSG 共享体,
// 一次覆盖所有 ResourceLoader<T>). 此处仅做初始化日志, 不重复 attach (会叠加 onEnter 调用).
export function setupLocaleReinjectHooks() {
    wblog("[v3] 语言切换重注入就绪 (HandleLocaleChanged onLeave → 主线程同步重注入, 无 JS timer)");
}

✄
import { A, dbg, findClassAcrossImages, makeS, readStr, wblog } from "./utils.js";
var hooked = false;
var cnt = { append: 0, fmt: 0, gto: 0, getText: 0, display: 0, tostr: 0 };
function isWrapped(s) {
    return s.length >= 3 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"';
}
// 整串只含首尾一对引号 (单段包裹; "a""b" 多段拼接不剥)
function isSingleWrapped(s) {
    if (!isWrapped(s))
        return false;
    for (var i = 1; i < s.length - 1; i++)
        if (s.charAt(i) === '"')
            return false;
    return true;
}
// 指针级快速判定: 串是否整串 `"…"` 包裹? (只读长度 + 首/尾字符, 不整串解码)
function isWrappedPtr(p) {
    if (!p || p.isNull())
        return false;
    try {
        var l = p.add(0x10).readS32();
        if (l < 3 || l > 9999)
            return false;
        var base = p.add(0x14);
        if (base.readU16() !== 0x22)
            return false; // 首 != '"'
        return base.add((l - 1) * 2).readU16() === 0x22; // 尾 == '"'
    }
    catch (e) {
        return false;
    }
}
function logStrip(tag, s, inner, n) {
    if (n === 1)
        wblog("剧本引号修复: 首个剥引号 [" + tag + "] \"" + s + "\" → \"" + inner + "\"");
    else
        dbg("[v3] scripttext: 剥引号 [" + tag + "] \"" + s + "\" → \"" + inner + "\" (累计 " + n + ")");
}
// 判定指针是 LocalizableTextPart[] 数组 (LocalizableText 结构体可能按值/按指针传参, 双重形态都验)
function looksLikePartArray(p) {
    if (!p || p.isNull())
        return false;
    try {
        var c = A.ogc(p);
        if (c.isNull())
            return false;
        var n = A.cgn(c).readCString() || "";
        if (n.indexOf("LocalizableTextPart") < 0)
            return false;
        var ml = p.add(0x18).readS32();
        return ml >= 0 && ml <= 64;
    }
    catch (e) {
        return false;
    }
}
function whoAmI(self) { try {
    return A.cgn(A.ogc(self)).readCString() || "?";
}
catch (e) {
    return "?";
} }
var firstSeen = {};
function noteCaller(tag, self) {
    if (firstSeen[tag])
        return;
    firstSeen[tag] = 1;
    wblog("剧本引号修复: 首触 [" + tag + "] 实例类=" + whoAmI(self));
}
// ---------- parts 剥引号: 给定已验证 LocalizableTextPart[] 指针 ----------
function stripPartsArray(arr, tag) {
    var maxLen = arr.add(0x18).readS32();
    var data = arr.add(0x20); // 元素 0x20: id@0x0 spot@0x8 text@0x18
    for (var i = 0; i < maxLen; i++) {
        var part = data.add(i * 0x20);
        var txtPtr = part.add(0x18).readPointer();
        if (!isWrappedPtr(txtPtr))
            continue;
        var s = readStr(txtPtr);
        if (!isSingleWrapped(s))
            continue;
        var inner = s.substring(1, s.length - 1);
        part.add(0x18).writePointer(makeS(inner));
        cnt.append++;
        logStrip(tag, s, inner, cnt.append);
    }
}
// 诊断: dump ChoiceState 的 summary parts 结构 (id + 每 part id/text), 只打一次
var _choiceDumped = {};
function dumpChoiceState(cs, tag) {
    try {
        var id = readStr(cs.add(0x0).readPointer());
        var arr = cs.add(0x20).readPointer();
        var info = tag + " 诊断 id='" + (id || "") + "' summary";
        if (!arr || arr.isNull()) {
            info += "=null";
        }
        else {
            var cn = A.cgn(A.ogc(arr)).readCString() || "?";
            var ml = arr.add(0x18).readS32();
            info += "=" + cn + " len=" + ml;
            var data = arr.add(0x20);
            for (var i = 0; i < Math.min(ml, 4); i++) {
                var part = data.add(i * 0x20);
                var pid = readStr(part.readPointer());
                var ptxt = readStr(part.add(0x18).readPointer());
                info += " [" + i + "] " + (pid || "") + "='" + (ptxt || "") + "'";
            }
        }
        wblog("剧本引号修复: " + info);
    }
    catch (e) {
        dbg("[v3] scripttext dumpChoiceState err: " + e);
    }
}
// 从参数 idx 解析 LocalizableText → parts 数组并剥 (兼容按值/按指针两种传参形态)
function stripPartsFromArg(args, idx, tag) {
    var arr = args[idx];
    if (!looksLikePartArray(arr)) {
        var alt = arr.readPointer(); // 值类型按指针传时: 8B struct → parts 数组指针
        if (!looksLikePartArray(alt))
            return;
        arr = alt;
    }
    stripPartsArray(arr, tag);
}
// ---------- 输入侧 hook: 剥 parts ----------
function makeAppendEnter(tag) {
    return function (args) {
        try {
            noteCaller(tag, args[0]);
            stripPartsFromArg(args, 1, tag);
        }
        catch (e) {
            dbg("[v3] scripttext " + tag + " err: " + e);
        }
    };
}
// ChoiceHandlerButton.Initialize(ChoiceState): summary(LocalizableText)@0x20
function onChoiceInitEnter(args) {
    try {
        noteCaller("ChoiceInit", args[0]);
        var cs = args[1];
        if (!cs || cs.isNull())
            return;
        dumpChoiceState(cs, "ChoiceInit");
        var arr = cs.add(0x20).readPointer(); // ChoiceState.summary → parts 数组
        if (!looksLikePartArray(arr))
            return;
        stripPartsArray(arr, "ChoiceSummary");
    }
    catch (e) {
        dbg("[v3] scripttext ChoiceInit err: " + e);
    }
}
// AdvChoiceHandlerButton.Initialize(ChoiceState) override (Gapless 真实按钮):
// override 内部调 base → 基类 hook 也触发; 这里直接挂在 override 上, 尽早看到 summary 结构。
function onAdvChoiceInitEnter(args) {
    try {
        noteCaller("AdvChoiceInit", args[0]);
        var cs = args[1];
        if (!cs || cs.isNull())
            return;
        dumpChoiceState(cs, "AdvChoiceInit");
        var arr = cs.add(0x20).readPointer();
        if (!looksLikePartArray(arr)) {
            var alt = arr.readPointer(); // 值类型按指针传时 8B struct → parts 指针
            if (!looksLikePartArray(alt))
                return;
            arr = alt;
        }
        stripPartsArray(arr, "AdvChoiceSummary");
    }
    catch (e) {
        dbg("[v3] scripttext AdvChoiceInit err: " + e);
    }
}
// LocalizableText.ToString(): args[0] = struct 指针 (parts 数组指针@0x0)
function onLTToStringEnter(args) {
    try {
        var arr = args[0];
        if (!looksLikePartArray(arr)) {
            var alt = arr.readPointer();
            if (!looksLikePartArray(alt))
                return;
            arr = alt;
        }
        stripPartsArray(arr, "LT.ToString");
    }
    catch (e) {
        dbg("[v3] scripttext LT.ToString err: " + e);
    }
}
// ---------- 落点 hook: 直接替换入参 ----------
function makeArgStripEnter(tag) {
    return function (args) {
        try {
            noteCaller(tag, args[0]);
            var p = args[1];
            if (!isWrappedPtr(p))
                return;
            var s = readStr(p);
            if (!isSingleWrapped(s))
                return;
            var inner = s.substring(1, s.length - 1);
            args[1] = makeS(inner);
            cnt.display++;
            logStrip(tag, s, inner, cnt.display);
        }
        catch (e) {
            dbg("[v3] scripttext " + tag + " err: " + e);
        }
    };
}
// ---------- 返回串剥引号 (兜底) ----------
function makeFmtOnLeave(tag) {
    return function (ret) {
        try {
            if (!ret || !isWrappedPtr(ret))
                return;
            var s = readStr(ret);
            if (!isSingleWrapped(s))
                return;
            var inner = s.substring(1, s.length - 1);
            this.returnValue = makeS(inner);
            cnt.fmt++;
            logStrip(tag, s, inner, cnt.fmt);
        }
        catch (e) {
            dbg("[v3] scripttext " + tag + " err: " + e);
        }
    };
}
function onGetTextLeave(ret) {
    try {
        if (!ret || !isWrappedPtr(ret))
            return;
        var s = readStr(ret);
        if (!isSingleWrapped(s))
            return;
        var inner = s.substring(1, s.length - 1);
        this.returnValue = makeS(inner);
        cnt.getText++;
        logStrip("get_Text", s, inner, cnt.getText);
    }
    catch (e) { }
}
function onGetTextOrNullLeave(ret) {
    try {
        if (!ret || !isWrappedPtr(ret))
            return;
        var s = readStr(ret);
        if (!isSingleWrapped(s))
            return;
        var inner = s.substring(1, s.length - 1);
        this.returnValue = makeS(inner);
        cnt.gto++;
        logStrip("GetTextOrNull", s, inner, cnt.gto);
    }
    catch (e) { }
}
function attachIf(mi, onEnter, onLeave) {
    if (!mi || mi.isNull())
        return 0;
    var h = {};
    if (onEnter)
        h.onEnter = onEnter;
    if (onLeave)
        h.onLeave = onLeave;
    Interceptor.attach(mi.readPointer(), h);
    return 1;
}
export function setupScriptTextHooks() {
    try {
        if (hooked)
            return;
        var ok = 0;
        // ---- 显示输入侧: 剥 parts ----
        // 真实/标准 print 面板
        var debate = findClassAcrossImages("WitchTrials.Views", "DebateTextPrinterPanel");
        if (debate && !debate.isNull()) {
            ok += attachIf(A.cgm(debate, Memory.allocUtf8String("AppendText"), 1), makeAppendEnter("DebateAppendText"));
            ok += attachIf(A.cgm(debate, Memory.allocUtf8String("SetText"), 1), makeArgStripEnter("SetText"));
            ok += attachIf(A.cgm(debate, Memory.allocUtf8String("AddText"), 1), makeArgStripEnter("AddText"));
        }
        var re = findClassAcrossImages("Naninovel.UI", "RevealableTextPrinterPanel");
        if (re && !re.isNull()) {
            ok += attachIf(A.cgm(re, Memory.allocUtf8String("AppendText"), 1), makeAppendEnter("RevealAppendText"));
            ok += attachIf(A.cgm(re, Memory.allocUtf8String("FormatMessage"), 2), null, makeFmtOnLeave("FormatMessage"));
        }
        // toast
        var tui = findClassAcrossImages("Naninovel.UI", "ToastUI");
        if (tui && !tui.isNull()) {
            ok += attachIf(A.cgm(tui, Memory.allocUtf8String("Show"), 3), makeAppendEnter("ToastShow"));
        }
        // choice: ChoiceHandlerButton.Initialize(ChoiceState) → summary@0x20
        var cbtn = findClassAcrossImages("Naninovel.UI", "ChoiceHandlerButton");
        if (cbtn && !cbtn.isNull()) {
            ok += attachIf(A.cgm(cbtn, Memory.allocUtf8String("Initialize"), 1), onChoiceInitEnter);
        }
        // choice(Gapless): AdvChoiceHandlerButton.Initialize override (WitchTrials.Views)
        var acbtn = findClassAcrossImages("WitchTrials.Views", "AdvChoiceHandlerButton");
        if (acbtn && !acbtn.isNull()) {
            ok += attachIf(A.cgm(acbtn, Memory.allocUtf8String("Initialize"), 1), onAdvChoiceInitEnter);
        }
        // 通用转换: LocalizableText.ToString() (toast/choice/backlog 拼串源头)
        var lt = findClassAcrossImages("Naninovel", "LocalizableText");
        if (lt && !lt.isNull()) {
            ok += attachIf(A.cgm(lt, Memory.allocUtf8String("ToString"), 0), onLTToStringEnter);
        }
        // ---- 显示落点: 替换入参 ----
        var rt = findClassAcrossImages("Naninovel.UI", "RevealableText");
        if (rt && !rt.isNull()) {
            ok += attachIf(A.cgm(rt, Memory.allocUtf8String("set_Text"), 1), makeArgStripEnter("RevealableText.set_Text"));
        }
        var toast = findClassAcrossImages("Naninovel.UI", "ToastAppearance");
        if (toast && !toast.isNull()) {
            ok += attachIf(A.cgm(toast, Memory.allocUtf8String("SetText"), 1), makeArgStripEnter("ToastSetText"));
        }
        // 兜底: 所有 Naninovel 文本组件的最终 text 赋值 (print/toast/choice 标签都可能走)
        var ntt = findClassAcrossImages("", "NaninovelTMProText");
        if (ntt && !ntt.isNull()) {
            ok += attachIf(A.cgm(ntt, Memory.allocUtf8String("set_text"), 1), makeArgStripEnter("TMProText.set_text"));
        }
        // 兜底2: 普通 TMP_Text.set_text 基类 (choice 标签非 NaninovelTMProText, v4 无首触 →
        //        走 TMPro 基类实现; TextMeshProUGUI 不重写 set_text, 全都会被这里截住)
        var tmpText = findClassAcrossImages("TMPro", "TMP_Text");
        if (tmpText && !tmpText.isNull()) {
            ok += attachIf(A.cgm(tmpText, Memory.allocUtf8String("set_text"), 1), makeArgStripEnter("TMP.set_text"));
        }
        // ---- 返回串剥引号 (兜底) ----
        var ui = findClassAcrossImages("Naninovel.UI", "UITextPrinterPanel");
        if (ui && !ui.isNull()) {
            ok += attachIf(A.cgm(ui, Memory.allocUtf8String("FormatMessage"), 1), null, makeFmtOnLeave("FmtBase"));
        }
        var pt = findClassAcrossImages("Naninovel", "LocalizableTextPart");
        if (pt && !pt.isNull()) {
            ok += attachIf(A.cgm(pt, Memory.allocUtf8String("get_Text"), 0), null, onGetTextLeave);
        }
        var map = findClassAcrossImages("Naninovel", "ScriptTextMap");
        if (map && !map.isNull()) {
            ok += attachIf(A.cgm(map, Memory.allocUtf8String("GetTextOrNull"), 1), null, onGetTextOrNullLeave);
        }
        if (!ok) {
            dbg("[v3] scripttext: 全部目标类未找到, 跳过");
            return;
        }
        hooked = true;
        wblog("剧本引号修复模块已装载 (" + ok + " 个 hook: 显示输入侧+落点+源头)");
    }
    catch (e) {
        dbg("[v3] scripttext init err: " + e);
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
// 日志输出统一走 log.js: console 彩色 (ERROR红/WARN黄/INFO青/DEBUG灰) + 文件明文 modlog.txt
// wblog=INFO 默认显示; dbg=DEBUG 归 MOD_DEBUG (默认关)。导出名/签名不变 → 调用点零改动。
import { debug as logDebug, info as logInfo, warn as logWarn, error as logError } from "./log.js";
// 日志开关: 全局 MOD_DEBUG (run_mod.sh 可注入), 默认关
export var MOD_DEBUG = (typeof globalThis !== "undefined" && globalThis.MOD_DEBUG) ? true : false;
export function dbg() { if (MOD_DEBUG)
    logDebug.apply(null, arguments); }
export function wblog(msg) { logInfo("[WitchBook] " + msg); }
export function warn() { logWarn.apply(null, arguments); }
export function error() { logError.apply(null, arguments); }
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
// 从 PNG 文件字节读宽高 (IHDR 16-23 字节大端) — 绕开 Texture2D get_width/get_height 的 runtime_invoke 问题
// 供 cutin.js / choice.js 共用 (原 v3 单文件内各有一份)
export function pngDims(fb) {
    try {
        if (!fb || fb.size < 24)
            return null;
        var b = fb.buf;
        if (b.readU8() !== 0x89 || b.add(1).readU8() !== 0x50)
            return null;
        var w = (b.add(16).readU8() << 24) | (b.add(17).readU8() << 16) | (b.add(18).readU8() << 8) | b.add(19).readU8();
        var h = (b.add(20).readU8() << 24) | (b.add(21).readU8() << 16) | (b.add(22).readU8() << 8) | b.add(23).readU8();
        return (w > 0 && h > 0) ? { w: w, h: h } : null;
    }
    catch (e) {
        return null;
    }
}
// ============ 值类型返回值直调 (2026-08-12) ============
// 根因: invoke() 经 il2cpp_runtime_invoke 对 ≤8B 值类型返回值 (float/bool) 的
// 返回缓冲会被复用/失效 → 读到垃圾 (实测 ppu=1.77e-18 而非 100 → Sprite.Create
// 以近零 ppu 创建 → sprite 无限放大不可见 = cutin 替换成功但看不见的根因)。
// 修复: 直调 MethodInfo 首字段 methodPointer (offset 0), 用正确返回类型 NativeFunction。
// 适用范围: float/bool/int 等单寄存器返回 (s0/x0)。Vector2/Rect 是 HFA (s0-s3) 不走
// 此法 → 仍走 invoke 缓冲 + 调用点归一化守卫。
var dcCache = {};
export function directCall(mi, retType, args) {
    if (!mi || mi.isNull())
        throw new Error("directCall: null MethodInfo");
    var mp = mi.readPointer();
    if (mp.isNull())
        throw new Error("directCall: null methodPointer");
    var key = mp.toString() + "|" + retType;
    var fn = dcCache[key];
    if (!fn) {
        var argTypes = [];
        for (var i = 0; i < args.length; i++)
            argTypes.push("pointer");
        fn = new NativeFunction(mp, retType, argTypes);
        dcCache[key] = fn;
    }
    return fn.apply(null, args);
}
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
// 读取 IL2CPP invoke 返回的 boxed bool 值.
// il2cpp_runtime_invoke 对 bool 返回方法返回的是 boxed Boolean 对象指针,
// 该指针无论 bool 是 true 还是 false 都非空, 必须读 0x10 偏移处的 1 字节字段.
// 之前的 `!ckr.ret.isNull()` 永远为 true, ContainsKey 判断错误.
export function invokeBool(mi, obj, args) {
    var r = invokeOk(mi, obj, args);
    if (!r.ok)
        return false;
    var ret = r.ret;
    if (!ret || ret.isNull())
        return false;
    try {
        var k = A.cgn(A.ogc(ret)).readCString() || "";
        if (k.indexOf("Boolean") >= 0)
            return ret.add(0x10).readU8() === 1;
    }
    catch (e) { }
    return ret.readU8() === 1;
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
        // 静默成功: 每次重注入 16 mod × 5 类 = 80 行/帧, 日志爆炸. 仅失败时 warn.
        return true;
    }
    catch (e) {
        dbg("[v3] populateConverters err (" + tag + "): " + e);
        return false;
    }
}
// ============ 服务查找 ============
// quiet=true: 未找到只打 dbg (探针回退场景, 如 CharacterManager→CharacterManagerExtended,
// 每次场景加载都探一次, WARN 太吵); 默认 false 保持原 WARN 行为。
export function findSvc(name, quiet) {
    try {
        var el = A.cfn(nv, Memory.allocUtf8String("Naninovel"), Memory.allocUtf8String("Engine"));
        if (!el || el.isNull()) {
            warn("[v3] findSvc('" + name + "') FAIL: Engine class NOT FOUND (nv=" + nv + ", allImgs=" + allImgs.length + ")");
            return null;
        }
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
        var msg = "[v3] findSvc('" + name + "') NOT FOUND in " + sz + " services (nv=" + nv + ")";
        if (quiet)
            dbg(msg);
        else
            warn(msg);
        return null;
    }
    catch (e) {
        error("[v3] findSvc('" + name + "') err: " + e + " (nv=" + nv + ", allImgs=" + allImgs.length + ")");
        return null;
    }
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
// macOS IL2CPP 泛型共享守卫: WitchBookPageBase._itemIds 在 CluePage 实例化为 Graphic[]、
// NotePage 为 Canvas[] (Windows 是 string[]) → 写 string[] 进去 = 内存破坏 → 写入前必须验证
export function fieldIsStringArray(obj, cls, name) {
    try {
        var f = A.gf(cls, Memory.allocUtf8String(name));
        if (!f || f.isNull())
            return false;
        var v = obj.add(A.fo(f)).readPointer();
        if (!v || v.isNull())
            return false;
        var cn = A.cgn(A.ogc(v)).readCString();
        return cn.indexOf("String[") >= 0;
    }
    catch (e) {
        return false;
    }
}
// macOS 泛型共享修复 (原版 macOS bug 的根治):
// 游戏自身 WitchBookPageBase.UpdateVersion 里 _itemIds.Contains(id) 的共享体把数组强转
// IEnumerable<string> → CluePage._itemIds=Graphic[]/NotePage=Canvas[] 时必抛 MethodAccessException
// → 有时被 Unity 吞掉 (黑屏), 有时未捕获 → SIGABRT (崩溃; 4 份 crash 栈同 RVA 0x3404d4 实证)。
// 修法: 执行游戏逻辑前把字段换回 string[], 内容取自 _loadedDataItemMap (与 Windows 的 id 集合一致)
// → 游戏原逻辑 (Contains 门 + SetVersion) 完整工作, 崩溃与黑屏同时消失。
// 返回 true = 字段已是/已修复为 string[]; false = 未处理 (字段缺失/null/无法提取)。
export function ensureItemIdsString(page, cls) {
    try {
        var f = A.gf(cls, Memory.allocUtf8String("_itemIds"));
        if (!f || f.isNull()) {
            warn(A.cgn(cls).readCString() + "._itemIds 字段未找到");
            return false;
        }
        var off = A.fo(f);
        var arr = page.add(off).readPointer();
        // 防御: arr 可能不是合法对象 (页面重建后字段偏移读到字符串数据), A.ogc 会原生访问违例。
        // 用 isReadable 预检 + try 包裹, 拿到真实类型/实例类用于诊断。
        var cn = "null";
        if (arr && !arr.isNull()) {
            try {
                cn = A.cgn(A.ogc(arr)).readCString();
            }
            catch (e0) {
                cn = "?不可读@0x" + arr;
            }
        }
        var instCls = "";
        try {
            instCls = A.cgn(A.ogc(page)).readCString();
        }
        catch (e1) {
            instCls = "?";
        }
        // 仅在异常情况下记录 (cn 不含 String[): 正常 String[] 情况静默, 减少 DEBUG 噪音
        if (cn.indexOf("String[") < 0) {
            dbg(A.cgn(cls).readCString() + "._itemIds off=0x" + off.toString(16) + " val=" + arr + " type=" + cn + " 实例=" + instCls + " → 需修复");
        }
        if (cn.indexOf("String[") >= 0)
            return true; // 已是 string[], 无需换
        // off=0x98 经各页面交叉验证是对的; val 悬空/垃圾正是要修的 → 一律用合法 String[] 覆盖
        var ids = [];
        // 首选: _loadedDataItemMap 的 id 集合 (游戏 Windows 语义: 已知条目集合)
        try {
            var mf = A.gf(cls, Memory.allocUtf8String("_loadedDataItemMap"));
            if (mf && !mf.isNull()) {
                var mapList = page.add(A.fo(mf)).readPointer();
                if (!mapList.isNull()) {
                    var mc = mapList.add(0x18).readS32();
                    var mitems = mapList.add(0x10).readPointer();
                    if (!mitems.isNull() && mc > 0 && mc < 100000) {
                        var mvCls = getGenericArgClass(A.ogc(mapList), 0);
                        var midOff = fieldOffset(mvCls, "_id", 0x10);
                        for (var i = 0; i < mc; i++) {
                            var me = mitems.add(0x20 + i * 8).readPointer();
                            var ms = (!me.isNull()) ? readStr(me.add(midOff).readPointer()) : null;
                            ids.push(ms || "");
                        }
                    }
                }
            }
        }
        catch (e1) {
            ids = [];
        }
        // 回退: 从数组元素提取 (string 元素直接读; 对象元素读 _id 字段) — 仅当数组可读时
        if (!ids.length && arr && !arr.isNull() && Memory.isReadable(arr)) {
            var len = arr.add(0x18).readS32();
            if (len > 0 && len < 100000) {
                var elemCls = ptr(0), elemIsStr = false, idOff = 0x10;
                for (var i = 0; i < len; i++) {
                    var e2 = arr.add(0x20 + i * 8).readPointer();
                    var s2 = null;
                    if (!e2.isNull()) {
                        if (elemCls.isNull()) {
                            elemCls = A.ogc(e2);
                            elemIsStr = (A.cgn(elemCls).readCString() === "System.String");
                            if (!elemIsStr)
                                idOff = fieldOffset(elemCls, "_id", 0x10);
                        }
                        s2 = elemIsStr ? readStr(e2) : readStr(e2.add(idOff).readPointer());
                    }
                    ids.push(s2 || "");
                }
            }
        }
        // 兜底: map/数组都取不到也写合法 String[] (可能为空) — 空数组同样让游戏 Contains 安全返回 false,
        // 不会再在 null/Graphic[] 上崩 (宁可空数组不显示, 也不留崩溃窗口)
        var strCls = getSystemClass("String");
        if (!strCls || strCls.isNull()) {
            error(A.cgn(cls).readCString() + "._itemIds String 类未找到");
            return false;
        }
        var na = A.an(strCls, ids.length);
        for (var i = 0; i < ids.length; i++)
            na.add(0x20 + i * 8).writePointer(makeS(ids[i]));
        page.add(off).writePointer(na);
        wblog(A.cgn(cls).readCString() + "._itemIds " + cn + " → String[] 重建 (" + ids.length + " 条)");
        return true;
    }
    catch (e) {
        error("ensureItemIdsString err(" + A.cgn(cls).readCString() + "): " + e);
        return false;
    }
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
        error("findAllObjectOfType err: " + e);
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
import { A, dbg, fieldOffset, findClassAcrossImages, findFirstObjectOfType, findSvc, invoke, invokeOk, listContainsId, makeLocalResourceProvider, makeS, populateConvertersDict, readStr, wblog, error, warn } from "../utils.js";
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
                            dbg("[v3] providersMap.Add('" + prefix + "') 成功");
                        else
                            dbg("[v3] providersMap.Add('" + prefix + "') 失败/已存在");
                    }
                }
            }
        }
        // ② 注册 ActorMetadata — 用基础 CharacterManager (Configuration=CharactersConfiguration, 有 MetadataMap)
        var cm = findSvc("CharacterManager", true);
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
            warn("CharacterData 类未解析");
            return;
        }
        var inst = findFirstObjectOfType(wbCls.characterData);
        if (!inst) {
            warn("CharacterData 实例未找到 (可能未加载)");
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
                    warn("CharacterDataItem.ctor 失败 '" + ids[i] + "'");
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
        error("injectCharacterData err: " + e);
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
            warn("ProfilePage.RefreshPageContent NOT FOUND");
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
        error("hookProfileName err: " + e);
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
            warn("AuthorData 类未解析");
            return;
        }
        var inst = findFirstObjectOfType(wbCls.authorData);
        if (!inst) {
            warn("AuthorData 实例未找到 (可能未加载)");
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
                    warn("AuthorDataItem.ctor 失败 '" + ids[i] + "'");
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
        error("injectAuthorData err: " + e);
    }
}

✄
// ============ WitchBook 数据域: 分类表 / 数据加载 / 版本项构建 / 本地化工具 ============
import { A, dbg, fieldOffset, findClassAcrossImages, getGenericArgClass, invokeOk, makeS, wblog, error, warn } from "../utils.js";
import { fileExists, readJSONFile } from "../io.js";
import { setWbReady, wbData, wbCurrentMod, wbReady, wbCls } from "./state.js";
import { registerLocalizedDict } from "./pages.js";
export var wbCats = {
    clue: { name: "clue", idx: 0, field: "Clues", page: "CluePage", data: "ClueData", item: "ClueDataItem", texDir: "Clues", locOff: 0xD0, locKind: "lts",
        addr: function (id) { return buildClueTextureAddress(id); },
        parseItem: function (it) {
            var n = it.Name || {}, d = it.Description || {};
            var nK = Object.keys(n), dK = Object.keys(d);
            if (nK.length < 2 || dK.length < 2) {
                // 详细诊断: dump it.Name 的 JSON 看实际值
                var dump = "";
                try {
                    dump = JSON.stringify(n).substr(0, 200);
                }
                catch (e) {
                    dump = "stringify失败: " + e;
                }
                dbg("[WitchBook] parseItem 警告 id=" + (it.Id || "??") + " Name keys=[" + nK.join(",") + "] Desc keys=[" + dK.join(",") + "] Name(dump)=" + dump);
            }
            return { name: n, desc: d };
        } },
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
            warn("  " + key + ": info.json 读取/解析失败");
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
                warn("  cat 配置异常: key=" + catNames[cn]);
                continue;
            }
            if (!wbData[cat.name]) {
                warn("  wbData 缺分类 '" + cat.name + "', wbData 键=" + Object.keys(wbData).join(","));
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
                    warn("重复 " + cat.name + " ID '" + grp.Id + "' 跳过 (首个 mod 优先)");
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
// 游戏全部语言 (localeValue 枚举全集). 预填字典时用: 保证游戏按当前语言查询 inner[locale]
// 永不 KeyNotFoundException, 缺的语言回退到已有文本 (见 pickLocaleText).
export var ALL_LOCALES = ["ja", "en-US", "zh-Hans", "zh-Hant", "ko", "fr", "es"];
// 预填字典的语言全集 = vrec 已有语言 ∪ 游戏全部语言 (缺的用回退文本填充)
export function fullLocaleTags(a, b) {
    var seen = {};
    (a ? Object.keys(a) : []).concat(b ? Object.keys(b) : []).concat(ALL_LOCALES).forEach(function (k) { seen[k] = 1; });
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
            warn("LocalizedText[] 创建失败");
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
        error("buildLocalizedTextArray err: " + e);
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
        error("buildVersionedItemFor err '" + id + "': " + e);
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
            warn("List.Add 失败 '" + id + " v" + keys[i] + "'");
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
import { A, dbg, ensureItemIdsString, fieldOffset, findClassAcrossImages, findNestedClass, invokeOk, makeS, readStr, wblog, error, warn } from "../utils.js";
import { initCatStateMaps, setWbCls, setWbPrevMod, wbCls, wbCurrentMod, wbData, wbPrevMod } from "./state.js";
import { isCurrentModItem, loadWitchBookData, wbCatByIdx, wbCats } from "./data.js";
import { clearAllWitchBookPages, clearBookViaVanilla, detectCurrentMod, findAllPages, hookClearState, rebuildAllPages } from "./session.js";
import { injectPage, hookRefreshLocalized } from "./pages.js";
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
            warn("无 mod WitchBook 数据, 跳过");
            return;
        }
        setWbCls(resolveWitchBookClasses());
        if (!wbCls.pages.clue || wbCls.pages.clue.isNull() ||
            !wbCls.witchBookScreen || wbCls.witchBookScreen.isNull() || !wbCls.versionedState || wbCls.versionedState.isNull()) {
            error("类解析失败 (pages/screen/versionedState)");
            return;
        }
        // @update 入口
        ["WitchBookUi", "WitchBookScreen"].forEach(function (cn) {
            try {
                var cls = wbCls[cn === "WitchBookUi" ? "witchBookUi" : "witchBookScreen"];
                if (!cls || cls.isNull())
                    return;
                var uvMi = A.cgm(cls, Memory.allocUtf8String("UpdateVersion"), 3);
                // NO_UPDATE_HOOK=1 (A/B 隔离): 跳过 @update hook — 审判加载时逐事件 hook 延迟是崩溃竞态嫌疑
                if (uvMi && !uvMi.isNull() && typeof NO_UPDATE_HOOK === 'undefined')
                    Interceptor.attach(uvMi.readPointer(), { onEnter: onWitchBookUpdate });
            }
            catch (e) { }
        });
        // macOS 泛型共享根治: 游戏自身 WitchBookPageBase.UpdateVersion 里 _itemIds.Contains(id)
        // 在 Graphic[]/Canvas[] 上抛 MAE → 崩/黑屏 (原版 macOS bug, 加载器写入只是放大器)。
        // onEnter 先把字段换回 String[] → 游戏原逻辑 (Contains 门 + SetVersion) 正常工作。
        try {
            var uvCands = [];
            var uvBase = findClassAcrossImages("WitchTrials.Views", "WitchBookPageBase");
            if (uvBase && !uvBase.isNull())
                uvCands.push(uvBase);
            var uvKeys = Object.keys(wbCls.pages);
            for (var uvi = 0; uvi < uvKeys.length; uvi++)
                uvCands.push(wbCls.pages[uvKeys[uvi]]);
            var uvSeen = {};
            for (var uvi2 = 0; uvi2 < uvCands.length; uvi2++) {
                try {
                    var uvc = uvCands[uvi2];
                    if (!uvc || uvc.isNull())
                        continue;
                    for (var uvn = 1; uvn <= 3; uvn++) {
                        var uvMi2 = A.cgm(uvc, Memory.allocUtf8String("UpdateVersion"), uvn);
                        if (!uvMi2 || uvMi2.isNull())
                            continue;
                        var uvP = uvMi2.readPointer();
                        if (!uvP || uvP.isNull() || uvSeen[uvP.toString()])
                            continue;
                        uvSeen[uvP.toString()] = 1;
                        Interceptor.attach(uvP, { onEnter: function (a) { try {
                                ensureItemIdsString(a[0], A.ogc(a[0]));
                            }
                            catch (e) { } } });
                        wblog("page UpdateVersion hook (" + A.cgn(uvc).readCString() + " " + uvn + " 参) @" + uvP);
                    }
                }
                catch (e) { }
            }
        }
        catch (e) {
            error("page UpdateVersion hook err: " + e);
        }
        // Profile 姓名覆写 (mod 新角色显示格式化名字而非 ID)
        hookProfileName();
        // @clearBook (ClearWitchBook 命令) → ClearState: 清 wbData.states + 复位面板
        // 修: 剧本内 @clearBook 后自定义证物无法清除 (applyStates 复活) + 上方面板冻结残留
        hookClearState();
        // RefreshPageContent onEnter: 重新预填 _localizedTextData
        // 修 InitializePages→LoadDataAsync 异步重建 map 时清掉注入导致 KeyNotFoundException
        hookRefreshLocalized();
        // WitchBook 打开/翻页重建 → 强制重注入
        ["BeginToPresent", "InitializePages"].forEach(function (mn) {
            try {
                var mi = A.cgm(wbCls.witchBookScreen, Memory.allocUtf8String(mn), 0);
                if (mi && !mi.isNull())
                    Interceptor.attach(mi.readPointer(), { onEnter: function () {
                            dbg(">>> WitchBook " + mn + " 触发");
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
                                dbg(">>> SpawnableClue mod 线索: '" + cid + "', 注册纹理");
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
        error("setupWitchBookHooks err: " + e + " | " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : ""));
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
        wblog("tryInjectWitchBook 完成");
    }
    catch (e) {
        error("tryInjectWitchBook err: " + e);
    }
}
// MAE 诊断: 打印页面关键字段的运行时类型 (仅第一次 @update 时; 原版基座污染检查)
// 背景: 崩溃 = WitchBookPageBase.UpdateVersion 内 Enumerable.Contains(source=Graphic[], value=string)
//       → 需确认 _itemIds 等字段在 @update 时刻的运行时类型
var _pageTypesDumped = false;
function dumpPageFieldTypes() {
    if (_pageTypesDumped)
        return;
    _pageTypesDumped = true;
    try {
        var pages = findAllPages();
        var fields = ["_itemIds", "_loadedDataItemMap", "_items", "_localizedTextData"];
        for (var i = 0; i < pages.length; i++) {
            try {
                var pc = A.ogc(pages[i]);
                var pcn = A.cgn(pc).readCString();
                var parts = [];
                for (var fi = 0; fi < fields.length; fi++) {
                    try {
                        var f = A.gf(pc, Memory.allocUtf8String(fields[fi]));
                        if (!f || f.isNull()) {
                            parts.push(fields[fi] + "=未找到");
                            continue;
                        }
                        var off = A.fo(f);
                        var v = pages[i].add(off).readPointer();
                        var vcn = (!v || v.isNull()) ? "null" : A.cgn(A.ogc(v)).readCString();
                        parts.push(fields[fi] + "@0x" + off.toString(16) + "=" + vcn);
                    }
                    catch (e2) {
                        parts.push(fields[fi] + "=err");
                    }
                }
                dbg("  [页面] " + pcn + " " + parts.join(" "));
            }
            catch (e3) { }
        }
    }
    catch (e) {
        error("dumpPageFieldTypes err: " + e);
    }
}
// @update 拦截: 按 WitchBookCategory 路由 (Clue=0 Profile=1 Map=2 Rule=3 Note=4)
export function onWitchBookUpdate(args) {
    try {
        var idx = args[1].toInt32(), id = readStr(args[2]), ver = args[3].toInt32();
        var cat = wbCatByIdx(idx);
        if (!cat || idx === 2)
            return; // Map 分类暂不处理
        dumpPageFieldTypes(); // MAE 诊断: @update 时刻页面字段类型
        if (!id || !isCurrentModItem(cat, id)) {
            dbg(">>> @update 忽略: category=" + (cat ? cat.name : idx) + " id='" + id + "' (非当前 mod 条目)");
            return;
        }
        if (!wbData.states[cat.name])
            wbData.states[cat.name] = {};
        if (wbData.states[cat.name][id] === ver)
            return;
        wbData.states[cat.name][id] = ver;
        wblog(">>> @update 拦截: category=" + cat.name + " id='" + id + "' version=" + ver);
        tryInjectWitchBook();
        dbg(">>> onWitchBookUpdate 返回");
    }
    catch (e) {
        error("onWitchBookUpdate err: " + e);
    }
}

✄
// ============ WitchBook 页面注入域: 注入 Page._loadedDataItemMap + _itemIds + _state + 本地化字典预填 ============
import { A, ensureItemIdsString, fieldIsStringArray, fieldOffset, findAllObjectOfType, getGenericArgClass, getSystemClass, invokeBool, invokeOk, listContainsId, makeS, readStr, wblog, dbg, error, warn } from "../utils.js";
import { wbCls, wbData, wbOverrides } from "./state.js";
import { currentModIds, fullLocaleTags, injectVersions, isCurrentModItem, localeValue, pickLocaleText, resolveLocale, wbCats } from "./data.js";
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
                var ids = currentModIds(cat), added = 0, overrideIds = [];
                for (var i = 0; i < ids.length; i++) {
                    var id = ids[i];
                    // override: mod 定义的原版同 id → 移除原版条目再注入 mod 版 (镜像 Windows)
                    if (isVanillaId(cat, id)) {
                        var oSet = {};
                        oSet[id] = 1;
                        clearModItemsFromPage(page, pageCls, oSet);
                        wbOverrides[cat.name][id] = true;
                        overrideIds.push(id);
                    }
                    if (listContainsId(mapList, id, idOff2))
                        continue;
                    added += injectVersions(mapList, addMi, vItemCls, cat, id, wbData[cat.name][id], page);
                }
                // 聚合日志 (替代每条 override 一行): 仅 1 条 INFO 覆盖整页 override 情况
                if (overrideIds.length)
                    wblog(cat.name + " override " + overrideIds.length + " 条: " + overrideIds.join(","));
                if (added > 0)
                    wblog(cat.name + "Page._loadedDataItemMap 注入 " + added + " 条 (total=" + mapList.add(0x18).readS32() + ")");
            }
        }
        ensureItemIdsString(page, pageCls); // macOS: Graphic[]/Canvas[] → String[] (游戏 Contains 才不炸)
        appendItemIds(page, cat);
        applyStates(page, cat);
        return true;
    }
    catch (e) {
        error("injectPage err(" + cat.name + "): " + e);
        return false;
    }
}
// 向 _itemIds (string[]) 追加纯新 mod ID (原版 UpdateVersion 检查 Contains)
export function appendItemIds(page, cat) {
    try {
        var pageCls = wbCls.pages[cat.name];
        // macOS 守卫: _itemIds 运行时可能是 Graphic[]/Canvas[] (泛型共享实例化差异), 非 String[] 绝不写入
        if (!fieldIsStringArray(page, pageCls, "_itemIds")) {
            warn(cat.name + "Page._itemIds 非 String[] (macOS 泛型共享), 跳过追加");
            return;
        }
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
        error("appendItemIds err: " + e);
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
        error("applyStates err: " + e);
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
            warn(cat.name + "._localizedTextData 为 null, 跳过 '" + b.id + "'");
            return;
        }
        var outerCls = A.ogc(outer);
        // 诊断: 打字典大小 + 类名, 验证 ivp 字段值
        try {
            // Dictionary 在 0x20 偏移处直接有 count 字段, 绕过 get_Count 的 boxed Int32 调用
            var cnt = -1;
            try {
                cnt = outer.add(0x20).readS32();
            }
            catch (e) { }
            var ivpId = "?", ivpVer = -1;
            try {
                ivpId = readStr(b.ivp.add(0x10).readPointer());
            }
            catch (e) { }
            try {
                ivpVer = b.ivp.add(0x18).readS32();
            }
            catch (e) { }
            var outerClsName = A.cgn(outerCls).readCString();
            dbg("[WitchBook] " + cat.name + " registerDict '" + b.id + "' 进入: dict size=" + cnt + " cls=" + outerClsName + " ivp.Id='" + ivpId + "' ivp.Ver=" + ivpVer);
        }
        catch (e) { }
        // 重要: 切语言后 RefreshPageContent 会重复触发, 但游戏只会重新读取 _localizedTextData[ivp][locale]
        // 如果只是 ContainsKey=true 就跳过, inner dict 里仍是旧 locale 集 (如只有 zh-Hans),
        // 切到日文后游戏查 inner[ja] → KeyNotFoundException.
        // 解决: 用 indexer set_Item (Add-or-Replace) 替换整个 inner dict, 保证 inner 包含所有 locale.
        var existedOuter = false;
        var ckOuter = A.cgm(outerCls, Memory.allocUtf8String("ContainsKey"), 1);
        if (ckOuter && !ckOuter.isNull()) {
            existedOuter = invokeBool(ckOuter, outer, [b.ivp]);
        }
        dbg("[WitchBook] " + cat.name + " registerDict '" + b.id + "' ContainsKey=" + existedOuter + (existedOuter ? " → 将用 set_Item 替换 inner" : " → 将用 Add 新增"));
        // 从现有值偷内层字典的具体实现类 (不能用泛型参数: 那是 IReadOnlyDictionary 接口, object_new 会崩)
        var sample = getFirstDictValue(outer);
        if (!sample) {
            warn(cat.name + "._localizedTextData 无现有值, 跳过 '" + b.id + "'");
            return;
        }
        var innerCls = A.ogc(sample);
        var innerName = A.cgn(innerCls).readCString();
        var addInner = A.cgm(innerCls, Memory.allocUtf8String("Add"), 2);
        if (!addInner || addInner.isNull()) {
            warn("内层字典无 Add (" + innerName + "), 跳过 '" + b.id + "'");
            return;
        }
        var vrec = wbData[cat.name][b.id].versions[String(b.ver)];
        if (!vrec)
            return;
        var inner = A.on(innerCls);
        if (!invokeOk(A.cgm(innerCls, Memory.allocUtf8String(".ctor"), 0), inner, []).ok) {
            warn("内层字典 ctor 失败 '" + b.id + "'");
            return;
        }
        if (cat.locKind === "str") {
            // Profile: Dictionary<LocaleKind, string> — 值 = 描述字符串
            // 补全全部游戏语言: 缺的语言回退到已有文本 (pickLocaleText), 防游戏按当前语言查询时 KeyNotFoundException
            var descTags = fullLocaleTags(vrec.desc);
            for (var t2 = 0; t2 < descTags.length; t2++) {
                var lv2 = Memory.alloc(4);
                lv2.writeS32(localeValue(descTags[t2]));
                invokeOk(addInner, inner, [lv2, makeS(resolveLocale(vrec.desc, descTags[t2]) || pickLocaleText(vrec.desc))]);
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
                warn(cat.name + ".LocalizedTexts 类/ctor 未找到, 跳过 '" + b.id + "'");
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
            // 诊断: 看 vrec 里 name/desc 实际包含的 locale keys
            var f1Keys = f1 ? Object.keys(f1) : [];
            var f2Keys = f2 ? Object.keys(f2) : [];
            dbg("[WitchBook] " + cat.name + " registerDict '" + b.id + "' vrec.name keys=[" + f1Keys.join(",") + "] vrec.desc keys=[" + f2Keys.join(",") + "]");
            // 补全全部游戏语言: vrec 缺的语言用已有文本回退 (pickLocaleText), 防游戏按当前语言查询 KeyNotFoundException
            var tags = fullLocaleTags(f1, f2);
            for (var t = 0; t < tags.length; t++) {
                var lts = A.on(ltsCls);
                var lv = Memory.alloc(4);
                lv.writeS32(localeValue(tags[t]));
                invokeOk(ltsCtor, lts, [makeS(resolveLocale(f1, tags[t]) || pickLocaleText(f1)), makeS(resolveLocale(f2, tags[t]) || pickLocaleText(f2))]);
                invokeOk(addInner, inner, [lv, lts]);
            }
            dbg("[WitchBook] " + cat.name + " registerDict '" + b.id + "' inner 填 " + tags.length + " locales: " + tags.join(","));
        }
        // 用 indexer set_Item (Add-or-Replace) 替换 inner dict, 保证 inner 包含所有 locale
        // 修: 切语言后 ContainsKey=true 但 inner 仍只有旧 locale 集 → 游戏查新 locale 时 KeyNotFoundException
        var setOuter = A.cgm(outerCls, Memory.allocUtf8String("set_Item"), 2);
        if (setOuter && !setOuter.isNull()) {
            var setR = invokeOk(setOuter, outer, [b.ivp, inner]);
            if (!setR.ok) {
                dbg("[WitchBook] " + cat.name + " registerDict '" + b.id + "' set_Item 失败: " + setR.ex);
            }
        }
        else {
            // fallback: 不存在则 Add, 已存在则先 Remove 再 Add
            if (existedOuter) {
                var rmOuter = A.cgm(outerCls, Memory.allocUtf8String("Remove"), 1);
                if (rmOuter && !rmOuter.isNull())
                    invokeOk(rmOuter, outer, [b.ivp]);
            }
            var addOuter = A.cgm(outerCls, Memory.allocUtf8String("Add"), 2);
            if (addOuter && !addOuter.isNull()) {
                var addR = invokeOk(addOuter, outer, [b.ivp, inner]);
                if (!addR.ok) {
                    dbg("[WitchBook] " + cat.name + " registerDict '" + b.id + "' Add 外层失败: " + addR.ex);
                }
            }
            else {
                dbg("[WitchBook] " + cat.name + " registerDict '" + b.id + "' set_Item/Add 外层方法均未找到");
            }
        }
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
        dbg(cat.name + "._localizedTextData 预填 '" + b.id + "' v" + b.ver + " (" + innerName + ")");
    }
    catch (e) {
        error("registerLocalizedDict err '" + b.id + "': " + e);
    }
}
// Hook RefreshPageContent onEnter: 在游戏读 _localizedTextData[map.IdVersionPair] 之前
// 重新预填该 mod 条目. 修 InitializePages→LoadDataAsync 异步重建 map 时清掉注入的问题
// (日志实证: InitializePages onEnter 注入后 800ms 才出现 KeyNotFoundException).
// 仅对当前 mod 的条目执行 (其他条目原版字典已有数据, 不动).
var _refreshHookedPages = {};
export function hookRefreshLocalized() {
    try {
        var catNames = ["clue", "rule", "note"]; // 这三类用 LocalizedTexts dict
        for (var i = 0; i < catNames.length; i++) {
            var cat = wbCats[catNames[i]];
            var pageCls = wbCls.pages[cat.name];
            if (!pageCls || pageCls.isNull())
                continue;
            if (_refreshHookedPages[cat.name])
                continue;
            var mi = A.cgm(pageCls, Memory.allocUtf8String("RefreshPageContent"), 1);
            if (!mi || mi.isNull()) {
                warn(cat.name + ".RefreshPageContent 未找到");
                continue;
            }
            _refreshHookedPages[cat.name] = 1;
            (function (catN) {
                Interceptor.attach(mi.readPointer(), {
                    onEnter: function (a) {
                        try {
                            var map = a[1];
                            if (!map || map.isNull())
                                return;
                            var id = readStr(map.add(0x10).readPointer()); // VersionedItem._id
                            if (!id) {
                                dbg("[WitchBook] " + catN + ".RefreshPageContent: map._id 为空");
                                return;
                            }
                            var isMod = isCurrentModItem(wbCats[catN], id);
                            dbg("[WitchBook] " + catN + ".RefreshPageContent onEnter id='" + id + "' isMod=" + isMod);
                            if (!isMod)
                                return;
                            var ver = map.add(0x18).readS32(); // VersionedItem._version
                            var ivp = map.add(0x28).readPointer(); // VersionedItem._idVersionPair
                            if (ivp.isNull()) {
                                dbg("[WitchBook] " + catN + ".RefreshPageContent: ivp=null, id=" + id);
                                return;
                            }
                            var b = { cat: wbCats[catN], id: id, ver: ver, ivp: ivp };
                            registerLocalizedDict(a[0], b);
                        }
                        catch (e) {
                            dbg("[WitchBook] RefreshPageContent refill err: " + e);
                        }
                    }
                });
            })(cat.name);
            wblog("hook " + cat.name + ".RefreshPageContent onEnter (refill _localizedTextData)");
        }
    }
    catch (e) {
        error("hookRefreshLocalized err: " + e);
    }
}

✄
// ============ WitchBook 会话隔离域: mod 切换检测 / 整页重建 / 状态清理 / 面板默认值 ============
// 镜像 Windows ModClueLoader + ModWitchBookPatch: mod 切换/回标题时从原版基座重建, 防残留继承
import { A, ensureItemIdsString, fieldIsStringArray, fieldOffset, findAllObjectOfType, findFirstObjectOfType, findSvc, getGenericArgClass, getSystemClass, invoke, invokeOk, listContainsId, makeS, readStr, wblog, error, warn } from "../utils.js";
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
        // macOS 守卫: 先修复泛型共享实例化差异 (Graphic[]/Canvas[] → String[]), 再写
        ensureItemIdsString(page, pageCls);
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
            warn(cat.name + " 整页重建跳过 (快照未捕获)");
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
        error("restorePageFromData err: " + e);
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
        error("rebuildAllPages err: " + e);
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
        error("restoreVanillaDict err: " + e);
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
        // 3) _itemIds: 重建 (先修复泛型共享实例化差异, 再按 idSet 过滤)
        if (ensureItemIdsString(page, pageCls)) {
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
        error("clearModItemsFromPage err: " + e);
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
        error("removeStateEntries err: " + e);
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
        error("clearPageState err: " + e);
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
        error("capturePageDefaults err: " + e);
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
        error("restorePageDefaults err: " + e);
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
        error("clearAllWitchBookPages err: " + e);
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
            warn("clearBook: WitchBookUi 未找到");
            return;
        }
        var mi = A.cgm(wbCls.witchBookUi, Memory.allocUtf8String("ClearState"), 1);
        if (!mi || mi.isNull()) {
            warn("clearBook: ClearState NOT FOUND");
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
        error("clearBook err: " + e);
    }
}
// 挂钩游戏 @clearBook (ClearWitchBook 命令) 的完整语义:
// 游戏侧 ClearState 只重置页面 _state (已获得版本), mod 的 wbData.states 不清 → 图鉴下次打开
// applyStates (tryInjectWitchBook → injectPage) 会把自定义条目重新 SetVersion 点亮 → 清不掉。
// 佐证: 原版 10-1 (同在 map) 能清掉 → 列表受 _state 门控, 自定义条目是"被 mod 复活"才残留。
// 挂钩 WitchBookUi/WitchBookScreen.ClearState(category) onLeave:
//   ① 清 wbData.states/pendingStates[分类] → applyStates 无可复活
//   ② restorePageDefaults 复位该页面原版默认面板 (标签/缩略图/_currentItemId) → 上方面板不再冻结旧文本
// 幂等 (WitchBookUi 内部会调 WitchBookScreen, 双 hook 各触发一次无害)。
var _clearStateHooked = false;
export function hookClearState() {
    try {
        if (_clearStateHooked)
            return;
        _clearStateHooked = true;
        var idxName = { 0: "clue", 1: "profile", 3: "rule", 4: "note" };
        var handle = function (catIdx) {
            try {
                var catName = idxName[catIdx];
                if (!catName)
                    return;
                if (wbData.states[catName])
                    wbData.states[catName] = {};
                if (wbData.pendingStates[catName])
                    wbData.pendingStates[catName] = {};
                var cat = wbCats[catName];
                var pages = findAllPages();
                for (var i = 0; i < pages.length; i++) {
                    try {
                        var pc = A.ogc(pages[i]);
                        if (A.cgn(pc).readCString() !== cat.page)
                            continue;
                        restorePageDefaults(pages[i]);
                    }
                    catch (e2) { }
                }
                wblog("ClearState 挂钩: '" + catName + "' 状态已清 + 面板复位");
            }
            catch (e) {
                error("clearStateHook err: " + e);
            }
        };
        ["witchBookUi", "witchBookScreen"].forEach(function (field) {
            try {
                var cls = wbCls[field];
                if (!cls || cls.isNull())
                    return;
                var mi = A.cgm(cls, Memory.allocUtf8String("ClearState"), 1);
                if (!mi || mi.isNull())
                    return;
                Interceptor.attach(mi.readPointer(), {
                    onEnter: function (args) { this._cat = args[1].toInt32(); },
                    onLeave: function () { try {
                        handle(this._cat);
                    }
                    catch (e) { } }
                });
                wblog("hook " + A.cgn(cls).readCString() + ".ClearState(category)");
            }
            catch (e) { }
        });
    }
    catch (e) {
        error("hookClearState err: " + e);
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
import { A, fieldOffset, findAllObjectOfType, findClassAcrossImages, getSystemClass, invokeOk, makeS, nv, readStr, wblog, dbg, error, warn } from "../utils.js";
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
            warn("读取纹理失败 '" + id + "'");
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
            warn("ImageConversion.LoadImage NOT FOUND");
            return null;
        }
        var r = invokeOk(liMi, ptr(0), [tex, barr]); // 静态
        if (!r.ok) {
            warn("LoadImage 失败 '" + id + "'");
            return null;
        }
        wbData.texCache[id] = tex;
        dbg("纹理加载 '" + id + "' -> " + tex);
        return tex;
    }
    catch (e) {
        error("loadModTexture err '" + id + "': " + e);
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
            warn("AddressablesManager 未找到");
            return;
        }
        var mgrCls = A.ogc(managerPtr);
        var dict = managerPtr.add(fieldOffset(mgrCls, "_loadedAssets", 0x18)).readPointer();
        if (dict.isNull()) {
            warn("AddressablesManager._loadedAssets 为 null");
            return;
        }
        var dictCls = A.ogc(dict);
        var addMi = A.cgm(dictCls, Memory.allocUtf8String("Add"), 2);
        if (!addMi || addMi.isNull()) {
            warn("Dict.Add NOT FOUND");
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
        error("registerTexturesInto err: " + e);
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
