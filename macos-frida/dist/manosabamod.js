📦
36048 /src/entry.js
1938 /src/banner.js
5796 /src/chapterdisplay.js
83411 /src/choice.js
206106 /src/credit.js
22709 /src/cutin.js
4554 /src/io.js
5858 /src/locale.js
9445 /src/log.js
15046 /src/menu.js
5211 /src/movie.js
15229 /src/providers.js
13453 /src/scripttext.js
25191 /src/utils.js
21084 /src/witchbook/characters.js
14658 /src/witchbook/data.js
18944 /src/witchbook/index.js
19689 /src/witchbook/pages.js
35785 /src/witchbook/session.js
1843 /src/witchbook/state.js
6346 /src/witchbook/textures.js
✄
import { A, allImgs, cs, dbg, findClassAcrossImages, nv, readStr, setGotoModifiedCls, setImageHandles, wblog } from "./utils.js";
import { clearCutInCaches, preloadCutInTextures, setupCutInHooks } from "./cutin.js";
import { clearCreditCaches, setupCreditHooks } from "./credit.js";
import { initChoiceHandlers, setupChoiceHandlerHooks } from "./choice.js";
import { setupChapterDisplayHooks } from "./chapterdisplay.js";
import { setupScriptTextHooks } from "./scripttext.js";
import { setupMovieHooks } from "./movie.js";
import { addModLoader, setupLocaleReinjectHooks } from "./providers.js";
import { hookLocaleAccessors } from "./locale.js";
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
        A.mgp = E.il2cpp_method_get_param ? new NativeFunction(E.il2cpp_method_get_param, 'pointer', ['pointer', 'uint32']) : null;
        A.csyst = E.il2cpp_class_from_system_type ? new NativeFunction(E.il2cpp_class_from_system_type, 'pointer', ['pointer']) : null;
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
        // 自定义致谢演出控制器 (用户 nani 触发, 100% 内容可控; 蓝本 probe_credit.js v4, P1-P5 裁决)
        setupCreditHooks();
        // 语言切换重注入 hook (镜像上游 Windows LocaleWatcherComponent, commit 66e5388b)
        // hook ResourceLoader<T>.HandleLocaleChanged (FSG) → 启动 ~10 帧重注入窗口
        // 覆盖: Scripts/Text/Audio/Voice/Backgrounds/Characters (insertProvisionSource 自带去重)
        setupLocaleReinjectHooks();
        // LocalizationManager 语言 hook (spawn 注入早于引擎初始化): 启动即目标语言也能同步
        // (HandleLocaleChanged 只在语言改变时触发, 启动初始化不触发 → 图鉴姓名启动即日语时仍显简中)
        hookLocaleAccessors();
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
                        // 首次进标题 → 预加载全部 CutIn 纹理 (把审判触发的解码卡顿挪到菜单空闲期)
                        try {
                            preloadCutInTextures();
                        }
                        catch (e) { }
                        // 回标题 → 清 Credit 演出状态 (disarm + 还原残留祖先; comp 指针保留, 字段探针复核)
                        try {
                            clearCreditCaches();
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
import { setCurrentLocale } from "./locale.js";
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
                                    setCurrentLocale(path); // 全局跟踪当前语言 (locale.js), 供 WitchBook Profile 姓名双语等使用
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
// ============ 自定义致谢演出控制器 (PLAN.md 实现阶段; 蓝本 probe_credit.js v4, 探针 P1-P5 全裁决) ============
// 协议: 用户的 nani 用 @set 触发 (转义双引号写法), 本控制器在 SetVariableValue hook (主线程) 里
//   调用原版组件方法 fire-and-forget, 动画由原版组件状态机在 PlayerLoop 自己跑, nani @Wait 编排节奏:
//   @set "g_modCreditRoll = \"data.json\""   → trigger: 读 json 缓存 + arm
//   @set "g_modCreditRollPhase = 1"          → staff:  文本/布局/归零 → 写 g_staffDuration → ScrollAsync
//   @set "g_modCreditRollPhase = 2"          → thanks: dict/order → 写 g_thanksDuration → ShowAsync
//   @set "g_modCreditRollPhase = 3"          → end:    SpecialThanks.Clear + DisableCanvas + 还原祖先 + disarm
// 探针裁决落点 (2026-08-20 run-4):
//   * F1 根治: 只启用 roll 自身不够, 必须沿 Transform 链激活 inactive 祖先 (ensureHierarchy) —
//     run-4 实证 canvas 0→1, 我方 ScrollAsync 完美线性动画 (0.990→0.000 @98.4s)
//   * 多标签: staff content 里多个 TMP 标签 (ContentSizeFitter[]), 原版残留文本在非当前语种标签上
//     主导高度 (29513.1px 恒定实证) → 必须枚举全部标签: active 填文本, inactive 清空, 再强制布局
//   * 数组类免偷: string[] = il2cpp_array_new(System.String); string[][] = array_new(string[] 类)
//   * 时长公式: staff = height/speed (json), g_staffDuration = 滚动+endPause;
//     thanks 墙钟实测 8 组 = 13.47s → 1.68s/组 (fade=0.4/display=2.0 硬编码) → 1.68*nG + 2.4
//   * 指针生命周期: run-3 实证跨回标题存活 (同地址), 每次使用前字段探针复核, 失效则惰性重抓
// 实现阶段首跑实测修正 (2026-08-20, 全黑屏无演出):
//   * utils.invoke 返回裸指针 (探针 invoke 返回 {ok,ret,ex}) — 本文件原按探针契约查 .ok → 恒假,
//     FindObjectsOfType 兜底从未执行 → 一律改用 invokeOk (成功语义)
//   * 全新会话无原版 credit → rolls/dictCls 均不可得 (实锤): dict 类改 metadata 自解析
//     (CreditsDirectorAct2._specialThanksCredits = Dictionary<LocaleKind,string[][]> dump.cs:481224,
//     field_get_type + class_from_type 开机可得零依赖); rolls 用 UIManager.GetUI(CreditsUI)
//     懒加载工厂自建 + GCI 子树扫描 + 全程分阶段日志
// 原则 (项目惯例): 只做加法+自清理, 不改任何游戏现有对象; 全程 try/catch 不崩。
//   错误路径一律写安全默认时长 → nani @Wait 永不悬挂 (R4)。
import { A, dbg, directCall, findClassAcrossImages, findSvc, findAllObjectOfType, getSystemClass, invoke, invokeOk, makeS, nv, pngDims, readStr, warn, error } from "./utils.js";
import { getIO } from "./io.js"; // run-24-2: 写文件走 io.js 绑定 (Module.findExportByName 在 bundle 内不可用, io.js 的 findGlobalExportByName 实证可用)
import { readJSONFile, openForWrite, writeString, fileSync, fileReadBytes } from "./io.js";
import { info } from "./log.js";
import { getCurrentLocale } from "./locale.js";
import { wbCurrentMod } from "./witchbook/state.js";
// ============ 状态 ============
var creditHooksReady = false;
var comp = {
    creditsUI: null,
    director: null,
    rollScroll: null, rollThanks: null,
    scrollRect: null, canvas: null, content: null,
    sArrCls: null, gArrCls: null,
    dictCls: null,
    labels: [],
    stills: null, stillTimer: null,
    // run-31: stills 条目扩展 {comp, go, name, cg, img, vanillaSpr} — img=Image 组件, vanillaSpr=原版 sprite (immutable, 恢复总从它)
    stillIdx: 0, stillState: "idle", stillStepStart: 0,
    stillT: { delay: 2000, fade: 2000, display: 26000 },
    timing: null,
    thanksTiming: null,
    thanksPaging: null // run-28: 共犯自翻页状态机 (不调原版 ShowAsync, 防 level 数组越界)
};
var creditState = {
    armed: false,
    phase: 0,
    json: null,
    jsonPath: null,
    original: false,
    extract: false,
    pendingProduction: false,
    stillsConf: null // run-31: 自定义 stills 播放列表 (data.json j.stills, 校验后; null=原版 9 张)
};
// run-31: stills 自定义图缓存 — texCache/sprCache key=resolved path (同文件多槽位共享一次解码);
//   sprCache null = 加载失败 (不重试); doEnd/abortCredit 清空置 null (Unity GC 回收纹理)
var stillsTexCache = {}, stillsSprCache = {};
var mgr = null; // CustomVariableManager 实例 (首个 SetVariableValue 缓存, 写回变量用 — F13)
var activatedAncestors = []; // phase=1 激活的祖先 GO (phase=3/中止 还原)
var deactivatedLabels = []; // run-11: 单标签模式停用的非当前语种标签 GO (结束还原)
var cls = {}; // 类表
// ============ 基础工具 (与探针一致) ============
function cn(p) { try {
    return (p && !p.isNull()) ? (A.cgn(A.ogc(p)).readCString() || "?") : "null";
}
catch (e) {
    return "?unreadable";
} }
function clsName(c) { try {
    return (c && !c.isNull()) ? (A.cgn(c).readCString() || "?") : "null";
}
catch (e) {
    return "?unreadable";
} }
function cgmChain(c, name, argc) {
    var cur = c;
    // run-24-4: A.gn 不能在模块顶层修 (A 表由 entry.js 在加载完成后填充, 顶层时 A.cgp 还是 undefined);
    //   必须运行时取 — 找不到父类函数就直接放弃回退 (避免 TypeError)
    var gn = (typeof A.gn === "function") ? A.gn : (typeof A.cgp === "function" ? A.cgp : null);
    for (var d = 0; cur && !cur.isNull() && d < 8; d++) {
        var mi = A.cgm(cur, Memory.allocUtf8String(name), argc);
        if (mi && !mi.isNull())
            return mi;
        if (!gn)
            break;
        cur = gn(cur);
    }
    return ptr(0);
}
function dcFloat(mi, inst) { try {
    if (!mi || mi.isNull())
        return NaN;
    return new NativeFunction(mi.readPointer(), 'float', ['pointer'])(inst);
}
catch (e) {
    return NaN;
} }
function dcBool(mi, inst) { try {
    if (!mi || mi.isNull())
        return false;
    return new NativeFunction(mi.readPointer(), 'bool', ['pointer'])(inst);
}
catch (e) {
    return false;
} }
function dcInt(mi, inst) { try {
    if (!mi || mi.isNull())
        return -1;
    return new NativeFunction(mi.readPointer(), 'int', ['pointer'])(inst);
}
catch (e) {
    return -1;
} }
function fPtr(v) { var p = Memory.alloc(4); p.writeFloat(v); return p; }
function iPtr(v) { var p = Memory.alloc(4); p.writeS32(v); return p; }
function boolPtr(v) { var p = Memory.alloc(4); p.writeS32(v ? 1 : 0); return p; }
function zeroCT() { var p = Memory.alloc(16); p.writeU64(0); p.add(8).writeU64(0); return p; }
// il2cpp_field_get_type / il2cpp_method_get_param — 导出在 GameAssembly.dylib (entry.js E 表同源)。
// run-6 实证 findExportByName(null) 只搜主程序 → 绑定失败 → 一律用 A.fgt/A.mgp (entry.js 已绑) + dylib 兜底
var fgt = null, mgp = null;
try {
    fgt = A.fgt;
}
catch (e) { }
try {
    mgp = A.mgp;
}
catch (e) { }
// run-12 修复: A.gn 从未在 entry.js 绑定 (只有 A.cgp=class_get_parent) — cgmChain 继承链回退必崩
try {
    if (!A.gn && A.cgp)
        A.gn = A.cgp;
}
catch (e) { }
if (!fgt || !mgp) {
    try {
        var gaMod = Process.findModuleByName("GameAssembly.dylib");
        if (gaMod) {
            if (!fgt) {
                var fE = gaMod.findExportByName("il2cpp_field_get_type");
                if (fE)
                    fgt = new NativeFunction(fE, 'pointer', ['pointer']);
            }
            if (!mgp) {
                var mE = gaMod.findExportByName("il2cpp_method_get_param");
                if (mE)
                    mgp = new NativeFunction(mE, 'pointer', ['pointer', 'uint32']);
            }
        }
    }
    catch (e) { }
}
// ============ 类解析 ============
function resolveCreditClasses() {
    var defs = [
        ["customVarMgr", "Naninovel", "CustomVariableManager"],
        ["uiMgr", "Naninovel", "UIManager"],
        ["canvasGroup", "UnityEngine", "CanvasGroup"],
        ["creditRoll", "WitchTrials.Views", "CreditRoll"],
        ["rollScroll", "WitchTrials.Views", "CreditRollVerticalScroll"],
        ["rollThanks", "WitchTrials.Views", "CreditRollSpecialThanks"],
        ["director", "WitchTrials.Views", "CreditsDirectorAct2"],
        ["endingStill", "WitchTrials.Views", "EndingStill"],
        ["creditsUI", "WitchTrials.Views", "CreditsUI"],
        ["scrollRect", "UnityEngine.UI", "ScrollRect"],
        ["canvas", "UnityEngine", "Canvas"],
        ["gameObject", "UnityEngine", "GameObject"],
        ["tmpText", "TMPro", "TMP_Text"],
        ["tmpFontAsset", "TMPro", "TMP_FontAsset"],
        ["layoutRebuilder", "UnityEngine.UI", "LayoutRebuilder"],
        ["localeKind", "GigaCreation.Essentials.Localization", "LocaleKind"],
        ["scriptLoader", "Naninovel", "ScriptLoader"],
        ["image", "UnityEngine.UI", "Image"],
        ["imageConversion", "UnityEngine", "ImageConversion"],
        ["sprite", "UnityEngine", "Sprite"],
        ["texture2D", "UnityEngine", "Texture2D"],
        ["renderTexture", "UnityEngine", "RenderTexture"],
        ["graphics", "UnityEngine", "Graphics"]
    ];
    var all = true;
    for (var i = 0; i < defs.length; i++) {
        var c = findClassAcrossImages(defs[i][1], defs[i][2]);
        cls[defs[i][0]] = c;
        if (!c || c.isNull()) {
            warn("[v3][Credit] 类未找到: " + defs[i][1] + "." + defs[i][2]);
            all = false;
        }
    }
    return all;
}
// ============ 字段探针类型识别 (类名通道优先, 字段探针兜底 — run-7 教训) ============
// rollThanks._labels@0x70 在 ShowAsync 前是 null → 纯字段探针会把有效实例判成"不可得" (phase=2 跳过根因)
// rollScroll 独有 _scrollRect@0x30→ScrollRect; rollThanks 独有 _labels@0x70→Dictionary
function isScrollRoll(inst) {
    try {
        if (!inst || inst.isNull())
            return false;
        var k = clsName(A.ogc(inst));
        if (k === "CreditRollVerticalScroll")
            return true;
        return cn(inst.add(0x30).readPointer()).indexOf("ScrollRect") >= 0;
    }
    catch (e) {
        return false;
    }
}
function isThanksRoll(inst) {
    try {
        if (!inst || inst.isNull())
            return false;
        var k = clsName(A.ogc(inst));
        if (k === "CreditRollSpecialThanks")
            return true;
        return cn(inst.add(0x70).readPointer()).indexOf("Dictionary") >= 0;
    }
    catch (e) {
        return false;
    }
}
// ============ 组件抓取 (多路: GetUI 自建 / UI 子树 / 全场景扫 / 原版钩子) ============
function getFontName(tmp) {
    try {
        var f = invokeOk(cgmChain(A.ogc(tmp), "get_font", 0), tmp, []);
        if (f.ok && f.ret && !f.ret.isNull()) {
            var nm = invokeOk(cgmChain(A.ogc(f.ret), "get_name", 0), f.ret, []);
            if (nm.ok && nm.ret && !nm.ret.isNull())
                return readStr(nm.ret) || "?";
        }
    }
    catch (e) { }
    return "?";
}
// 枚举 staff content 下全部 TMP 标签 (含 inactive — GetComponentsInChildren(Type,bool))
// run-26: Label 名后缀 → key 段 (与 build_credit_data.py label_suffix 同一规则)
function labelSuffix(nm) {
    if (nm === "Label")
        return "";
    if (nm && nm.indexOf("Label") === 0)
        return nm.slice(5); // Label_1 → "_1"
    return nm || "";
}
function enumerateLabels() {
    try {
        comp.labels = [];
        if (!comp.content || comp.content.isNull())
            return 0;
        var go = invokeOk(cgmChain(A.ogc(comp.content), "get_gameObject", 0), comp.content, []);
        if (!go.ok || go.ret.isNull())
            return 0;
        var typeObj = A.tgo(A.cgt(cls.tmpText));
        var arr = invokeOk(cgmChain(A.ogc(go.ret), "GetComponentsInChildren", 2), go.ret, [typeObj, boolPtr(true)]);
        if (!arr.ok || !arr.ret || arr.ret.isNull()) {
            warn("[v3][Credit] staff TMP 枚举失败 (content 下无 TMP?)");
            return 0;
        }
        var len = arr.ret.add(0x18).readS32();
        for (var i = 0; i < len; i++) {
            var e = arr.ret.add(0x20 + i * 8).readPointer();
            if (!e || e.isNull())
                continue;
            var eGo = null;
            try {
                var gg = invokeOk(cgmChain(A.ogc(e), "get_gameObject", 0), e, []);
                if (gg.ok)
                    eGo = gg.ret;
            }
            catch (e2) { }
            var active = eGo ? dcBool(cgmChain(A.ogc(eGo), "get_activeSelf", 0), eGo) : false;
            var nm = eGo ? getGoName(eGo) : "?";
            // run-12: 标签自身名全叫 "Label", 语种标识可能在父包装节点 (thanks 侧就是 Label_Ja/Label_ZhHans 风格)
            var pn = "?", gn = "?";
            if (eGo) {
                try {
                    var t2 = invokeOk(cgmChain(A.ogc(eGo), "get_transform", 0), eGo, []);
                    if (t2.ok && t2.ret) {
                        var p2 = invokeOk(cgmChain(A.ogc(t2.ret), "get_parent", 0), t2.ret, []);
                        if (p2.ok && p2.ret) {
                            var pgo = invokeOk(cgmChain(A.ogc(p2.ret), "get_gameObject", 0), p2.ret, []);
                            if (pgo.ok && pgo.ret)
                                pn = getGoName(pgo.ret);
                            // run-26: 再上一级 = grand (Content 直接子级: TopSpace/Full/Separator/Left/BottomSpace)
                            var p3 = invokeOk(cgmChain(A.ogc(p2.ret), "get_parent", 0), p2.ret, []);
                            if (p3.ok && p3.ret) {
                                var pgo2 = invokeOk(cgmChain(A.ogc(p3.ret), "get_gameObject", 0), p3.ret, []);
                                if (pgo2.ok && pgo2.ret)
                                    gn = getGoName(pgo2.ret);
                            }
                        }
                    }
                }
                catch (e3) { }
            }
            comp.labels.push({ tmp: e, go: eGo, name: nm, parent: pn, grand: gn, active: active, font: getFontName(e) });
        }
        var parts = [];
        for (var j = 0; j < comp.labels.length; j++)
            parts.push("#" + j + ":" + (comp.labels[j].name || "?") + "(" + (comp.labels[j].parent || "?") + ")" + (comp.labels[j].active ? "活" : "隐") + ":" + (comp.labels[j].font || "?"));
        dbg("[v3][Credit] staff TMP 标签 " + comp.labels.length + " 个: " + parts.join(" | "));
        return comp.labels.length;
    }
    catch (e) {
        warn("[v3][Credit] enumerateLabels err: " + e);
        return 0;
    }
}
// run-11: thanks 语种→标签映射 (dump.cs:11229 LabelByLocale{_localeKind@0x10,_label@0x18}, _labelsByLocale@0x38)
//   序列化数组开机即有 (不依赖 ShowAsync); zh 标签的 TMP 字体 = 游戏官方简中字体 (staff 换装来源)
function enumerateThanksLabels() {
    try {
        comp.thanksByLocale = {};
        if (!comp.rollThanks || comp.rollThanks.isNull()) {
            warn("[v3][Credit] thanks 标签枚举: rollThanks 未捕获");
            return 0;
        }
        var arr = comp.rollThanks.add(0x38).readPointer();
        if (!arr || arr.isNull()) {
            warn("[v3][Credit] thanks _labelsByLocale@0x38 为空");
            return 0;
        }
        var len = arr.add(0x18).readS32();
        if (len < 1 || len > 16) {
            warn("[v3][Credit] thanks _labelsByLocale 长度异常 " + len);
            return 0;
        }
        var n = 0;
        for (var i = 0; i < len; i++) {
            var entry = arr.add(0x20 + i * 8).readPointer();
            if (!entry || entry.isNull())
                continue;
            var lk = entry.add(0x10).readS32();
            var lbl = entry.add(0x18).readPointer();
            if (!lbl || lbl.isNull())
                continue;
            var tmp = lbl.add(0x30).readPointer();
            if (!tmp || tmp.isNull())
                continue;
            var cg = lbl.add(0x28).readPointer(); // run-28: SpecialThanksLabel._canvasGroup@0x28 (翻页 fade 用)
            comp.thanksByLocale[lk] = { label: lbl, tmp: tmp, cg: cg, name: getGoName(lbl), font: getFontName(tmp) };
            info("[v3][Credit] thanks 标签 localeKind=" + lk + " name=" + comp.thanksByLocale[lk].name + " font=" + comp.thanksByLocale[lk].font);
            n++;
        }
        return n;
    }
    catch (e) {
        warn("[v3][Credit] enumerateThanksLabels err: " + e);
        return 0;
    }
}
function grabScrollDetails() {
    try {
        if (!comp.rollScroll || comp.rollScroll.isNull())
            return;
        comp.scrollRect = comp.rollScroll.add(0x30).readPointer(); // _scrollRect@0x30
        comp.canvas = comp.rollScroll.add(0x28).readPointer(); // _canvas@0x28
        var rr = invokeOk(A.cgm(cls.scrollRect, Memory.allocUtf8String("get_content"), 0), comp.scrollRect, []);
        comp.content = rr.ok ? rr.ret : null;
        enumerateLabels();
        dbg("[v3][Credit] 组件链: scrollRect=" + comp.scrollRect + " canvas=" + comp.canvas + " content=" + comp.content);
    }
    catch (e) {
        warn("[v3][Credit] grabScrollDetails err: " + e);
    }
}
// 双通道捕获 (类名 / 字段探针); rollThanks 在导演入口 _labels 可能尚 null (ShowAsync 才填) — 类名通道覆盖
function captureRolls(roll, tag) {
    try {
        if (!roll || roll.isNull())
            return;
        var k = clsName(A.ogc(roll));
        var sr = roll.add(0x30).readPointer();
        var lbl = roll.add(0x70).readPointer();
        if (k === "CreditRollVerticalScroll" || cn(sr).indexOf("ScrollRect") >= 0) {
            if (!comp.rollScroll || comp.rollScroll.isNull()) {
                comp.rollScroll = roll;
                info("[v3][Credit] rollScroll 已捕获 (" + (k === "CreditRollVerticalScroll" ? "类名" : "字段探针") + ", " + (tag || "?") + ") = " + roll);
                grabScrollDetails();
            }
        }
        else if (k === "CreditRollSpecialThanks" || cn(lbl).indexOf("Dictionary") >= 0) {
            if (!comp.rollThanks || comp.rollThanks.isNull()) {
                comp.rollThanks = roll;
                info("[v3][Credit] rollThanks 已捕获 (" + (k === "CreditRollSpecialThanks" ? "类名" : "字段探针") + ", " + (tag || "?") + ") = " + roll);
            }
        }
    }
    catch (e) {
        warn("[v3][Credit] captureRolls err: " + e);
    }
}
// 在 CreditsUI 实例子树里扫 roll 组件 (GCI includeInactive — 只拿真实实例, 不会误抓 prefab 模板)
function scanUiRolls(uiComp, tag) {
    try {
        if (!uiComp || uiComp.isNull())
            return false;
        var go = invokeOk(cgmChain(A.ogc(uiComp), "get_gameObject", 0), uiComp, []);
        if (!go.ok || go.ret.isNull())
            return false;
        var got = false;
        if (!comp.rollScroll || !isScrollRoll(comp.rollScroll)) {
            var arr = invokeOk(cgmChain(A.ogc(go.ret), "GetComponentsInChildren", 2), go.ret, [A.tgo(A.cgt(cls.rollScroll)), boolPtr(true)]);
            if (arr.ok && arr.ret && !arr.ret.isNull()) {
                var len = arr.ret.add(0x18).readS32();
                for (var i = 0; i < len && !comp.rollScroll; i++) {
                    var e = arr.ret.add(0x20 + i * 8).readPointer();
                    if (e && !e.isNull() && isScrollRoll(e))
                        captureRolls(e, tag + ".GCI");
                }
            }
            got = !!comp.rollScroll;
        }
        if (!comp.rollThanks || !isThanksRoll(comp.rollThanks)) {
            var arr2 = invokeOk(cgmChain(A.ogc(go.ret), "GetComponentsInChildren", 2), go.ret, [A.tgo(A.cgt(cls.rollThanks)), boolPtr(true)]);
            if (arr2.ok && arr2.ret && !arr2.ret.isNull()) {
                var len2 = arr2.ret.add(0x18).readS32();
                for (var i2 = 0; i2 < len2 && !comp.rollThanks; i2++) {
                    var e2 = arr2.ret.add(0x20 + i2 * 8).readPointer();
                    if (e2 && !e2.isNull() && isThanksRoll(e2))
                        captureRolls(e2, tag + ".GCI");
                }
            }
            got = got || !!comp.rollThanks;
        }
        return got;
    }
    catch (e) {
        warn("[v3][Credit] scanUiRolls err: " + e);
        return false;
    }
}
// 服务表全量 dump (UIManager 找不到时的裁决日志 — run-7: 服务表 23 个但按名匹配无果)
function dumpServices() {
    try {
        var el = A.cfn(nv, Memory.allocUtf8String("Naninovel"), Memory.allocUtf8String("Engine"));
        if (!el || el.isNull()) {
            warn("[v3][Credit] dumpServices: Naninovel.Engine 类不可得");
            return;
        }
        var f = A.gf(el, Memory.allocUtf8String("services"));
        if (!f || f.isNull()) {
            warn("[v3][Credit] dumpServices: services 字段不可得");
            return;
        }
        var l = A.sdf(el).add(A.fo(f)).readPointer();
        var its = l.add(0x10).readPointer();
        var sz = l.add(0x18).readS32();
        var parts = [];
        for (var i = 0; i < sz && i < 40; i++) {
            var ep = its.add(0x20 + i * 8).readPointer();
            if (!ep || ep.isNull())
                continue;
            parts.push(A.cgn(A.ogc(ep)).readCString() || "?");
        }
        warn("[v3][Credit] 服务表 " + sz + " 个: " + parts.join(", "));
    }
    catch (e) {
        warn("[v3][Credit] dumpServices err: " + e);
    }
}
// UIManager.GetUI(CreditsUI) — Naninovel 懒加载工厂 (原版 @credit 也走这里); 自建 UI 供无原版 credit 的全新会话
function spawnCreditsUI() {
    try {
        if (comp.creditsUI && !comp.creditsUI.isNull()) {
            scanUiRolls(comp.creditsUI, "已有UI");
            return comp.creditsUI;
        }
        // run-16 修复: 服务类被覆盖为 UiManagerExtended — findSvc("Naninovel.UIManager") 后缀匹配不上
        //   ("UIManager" ≠ "UiManagerExtended"; 服务表 23 个实类名, 日志实证 UiManagerExtended 在表里)
        var uiMgr = findSvc("UiManagerExtended", true);
        if (!uiMgr)
            uiMgr = findSvc("UIManager", true);
        if (!uiMgr) {
            // 服务表兜底: 引擎已初始化时 UIManager MonoBehaviour 必在场景 — 直接场景扫
            var mgrs = findAllObjectOfType(cls.uiMgr);
            if (mgrs.length)
                uiMgr = mgrs[0];
        }
        if (!uiMgr) {
            // run-16: 场景直接扫 CreditsUI 本身 (rollScroll 全场景扫实证可得 — CreditsUI 是它的祖先必在场景)
            var uis = findAllObjectOfType(cls.creditsUI);
            if (uis.length) {
                comp.creditsUI = uis[0];
                info("[v3][Credit] CreditsUI 已捕获 (场景直扫): " + uis[0] + " (" + clsName(A.ogc(uis[0])) + ")");
                scanUiRolls(uis[0], "场景直扫");
                return uis[0];
            }
            warn("[v3][Credit] UIManager 不可得 (服务表+场景扫均无) — 无法自建 CreditsUI");
            dumpServices(); // 裁决: UIManager 是否在服务表里 (类名 vs 预期)
            return null;
        }
        var mi = A.cgm(A.ogc(uiMgr), Memory.allocUtf8String("GetUI"), 1);
        if (!mi || mi.isNull()) {
            warn("[v3][Credit] UIManager.GetUI(Type/String) NOT FOUND");
            return null;
        }
        // GetUI(Type) 与 GetUI(string) 同为 1 参 — 用参数类型反查确定重载
        var isTypeArg = true;
        try {
            var pt = mgp(mi, 0);
            var pcls = pt.add(0x8).readPointer();
            var ptn = (pcls && !pcls.isNull()) ? A.cgn(pcls).readCString() : "?";
            isTypeArg = (ptn === "System.Type");
            dbg("[v3][Credit] GetUI 参数类型: " + ptn + " → " + (isTypeArg ? "Type 重载" : "string 重载"));
        }
        catch (e) { }
        var r = invokeOk(mi, uiMgr, isTypeArg ? [A.tgo(A.cgt(cls.creditsUI))] : [makeS("CreditsUI")]);
        if (r.ok && r.ret && !r.ret.isNull()) {
            var rn = clsName(A.ogc(r.ret));
            if (rn.indexOf("CreditsUI") >= 0) {
                comp.creditsUI = r.ret;
                info("[v3][Credit] UIManager.GetUI → CreditsUI 已创建: " + r.ret + " (" + rn + ")");
                scanUiRolls(r.ret, "GetUI");
                return r.ret;
            }
            warn("[v3][Credit] GetUI 返回 " + rn + " (非 CreditsUI) — 重载匹配异常");
        }
        else {
            warn("[v3][Credit] UIManager.GetUI 未返回 CreditsUI (异步创建中?) — 首次跑若失败, 再次触发即命中缓存");
        }
        return null;
    }
    catch (e) {
        warn("[v3][Credit] spawnCreditsUI err: " + e);
        return null;
    }
}
// 分阶段类型扫描: stage 1 = FindObjectsOfType(active) → stage 2 = FindObjectsOfType(includeInactive=true)
// → stage 3 = FindObjectsOfTypeAll (含资产/prefab)。返回 {stage, objs}。
// 语义 (run-7 实证): 阶段1/2 只返回 LIVE 场景对象; 阶段3 才含资产 — 资产上跑动画不可见
// (run-7 实锤: "3 填 / 0 清" 全 active 标签 = prefab 序列化默认, 滚动无显示)。
// 阶段日志用 info (MOD_DEBUG=false 时 dbg 不可见, run-7 的 LIVE/资产判定无从看起)。
function findRollsStaged(targetCls, tag) {
    try {
        var objCls = findClassAcrossImages("UnityEngine", "Object");
        if (!objCls || objCls.isNull())
            return { stage: 0, objs: [] };
        var typeObj = A.tgo(A.cgt(targetCls));
        function collect(arr) {
            if (!arr || arr.isNull())
                return [];
            var len = arr.add(0x18).readS32(), out = [];
            for (var i = 0; i < len; i++) {
                var e = arr.add(0x20 + i * 8).readPointer();
                if (e && !e.isNull())
                    out.push(e);
            }
            return out;
        }
        var mi = A.cgm(objCls, Memory.allocUtf8String("FindObjectsOfType"), 1);
        if (mi && !mi.isNull() && mi.readPointer() && !mi.readPointer().isNull()) {
            var a1 = collect(invoke(mi, ptr(0), [typeObj]));
            if (a1.length) {
                info("[v3][Credit] " + tag + " 命中: FindObjectsOfType(active) " + a1.length + " 个 (LIVE)");
                return { stage: 1, objs: a1 };
            }
        }
        var mi2 = A.cgm(objCls, Memory.allocUtf8String("FindObjectsOfType"), 2);
        if (mi2 && !mi2.isNull()) {
            var fb = Memory.alloc(4);
            fb.writeS32(1); // includeInactive=true — 区别 utils 链 (漏 inactive live)
            var a2 = collect(invoke(mi2, ptr(0), [typeObj, fb]));
            if (a2.length) {
                info("[v3][Credit] " + tag + " 命中: FindObjectsOfType(includeInactive) " + a2.length + " 个 (LIVE 含隐藏)");
                return { stage: 2, objs: a2 };
            }
        }
        var resCls = findClassAcrossImages("UnityEngine", "Resources");
        var mia = A.cgm(resCls, Memory.allocUtf8String("FindObjectsOfTypeAll"), 1);
        if (mia && !mia.isNull() && mia.readPointer() && !mia.readPointer().isNull()) {
            var a3 = collect(invoke(mia, ptr(0), [typeObj]));
            if (a3.length) {
                info("[v3][Credit] " + tag + " 命中: FindObjectsOfTypeAll " + a3.length + " 个 (资产/prefab — 需实例化才可见)");
                return { stage: 3, objs: a3 };
            }
        }
        return { stage: 0, objs: [] };
    }
    catch (e) {
        warn("[v3][Credit] findRollsStaged err: " + e);
        return { stage: 0, objs: [] };
    }
}
// ---- 资产 → 场景实例化 (run-7 核心修复: 全新会话无 live CreditsUI, 资产动画不可见) ----
function getGoName(go) { try {
    var n = invokeOk(cgmChain(A.ogc(go), "get_name", 0), go, []);
    return n.ok && n.ret ? (readStr(n.ret) || "?") : "?";
}
catch (e) {
    return "?";
} }
// 组件 → 所在 GO → Transform 链走到根 → 根 GO (prefab 根)
function rootGoOf(comp) {
    try {
        var g = invokeOk(cgmChain(A.ogc(comp), "get_gameObject", 0), comp, []);
        if (!g.ok || !g.ret || g.ret.isNull())
            return null;
        var t = invokeOk(cgmChain(A.ogc(g.ret), "get_transform", 0), g.ret, []);
        var cur = t.ok ? t.ret : null, steps = 0;
        while (cur && !cur.isNull() && steps++ < 32) {
            var p = invokeOk(cgmChain(A.ogc(cur), "get_parent", 0), cur, []);
            if (!p.ok || p.ret.isNull())
                break;
            cur = p.ret;
        }
        if (!cur || cur.isNull())
            return null;
        var rg = invokeOk(cgmChain(A.ogc(cur), "get_gameObject", 0), cur, []);
        return rg.ok && !rg.ret.isNull() ? rg.ret : null;
    }
    catch (e) {
        warn("[v3][Credit] rootGoOf err: " + e);
        return null;
    }
}
// 在 GO 子树里收集目标 roll 并捕获 (GetComponentsInChildren includeInactive)
function collectAndCapture(go, targetCls, checkFn, tag) {
    try {
        var arr = invokeOk(cgmChain(A.ogc(go), "GetComponentsInChildren", 2), go, [A.tgo(A.cgt(targetCls)), boolPtr(true)]);
        if (!arr.ok || !arr.ret || arr.ret.isNull())
            return false;
        var len = arr.ret.add(0x18).readS32(), got = false;
        for (var i = 0; i < len; i++) {
            var e = arr.ret.add(0x20 + i * 8).readPointer();
            if (!e || e.isNull())
                continue;
            if (checkFn(e)) {
                captureRolls(e, tag);
                got = true;
            }
        }
        return got;
    }
    catch (e) {
        warn("[v3][Credit] collectAndCapture err: " + e);
        return false;
    }
}
// 资产 roll → 先扫已有副本 (跨阶段复用, staff/thanks 同 prefab 时只实例化一次) → 否则
// Object.Instantiate(prefab 根) 造 live 副本 → 从副本捕获
function ensureRollFromAsset(assetComp, targetCls, checkFn, tag) {
    try {
        if (comp.liveRoot && !comp.liveRoot.isNull()) {
            if (collectAndCapture(comp.liveRoot, targetCls, checkFn, tag + ".已有副本"))
                return true;
        }
        var root = rootGoOf(assetComp);
        if (!root || root.isNull()) {
            warn("[v3][Credit] " + tag + ": prefab 根 GO 不可得");
            return false;
        }
        var objCls = findClassAcrossImages("UnityEngine", "Object");
        var mi = A.cgm(objCls, Memory.allocUtf8String("Instantiate"), 1);
        if (!mi || mi.isNull() || !mi.readPointer() || mi.readPointer().isNull()) {
            warn("[v3][Credit] Object.Instantiate NOT FOUND");
            return false;
        }
        var cp = invokeOk(mi, ptr(0), [root]);
        if (!cp.ok || !cp.ret || cp.ret.isNull()) {
            warn("[v3][Credit] Instantiate FAIL (" + tag + ", 根='" + getGoName(root) + "')");
            return false;
        }
        if (!comp.liveRoot || comp.liveRoot.isNull())
            comp.liveRoot = cp.ret;
        info("[v3][Credit] prefab 资产 → 场景实例化副本 = " + cp.ret + " (根='" + getGoName(root) + "', " + tag + ")");
        return collectAndCapture(cp.ret, targetCls, checkFn, tag + ".副本");
    }
    catch (e) {
        warn("[v3][Credit] ensureRollFromAsset err: " + e);
        return false;
    }
}
// 分门控捕获 (run-6 教训: 共用一个全量门会把 staff/thanks 一起拖死 — rollScroll 已捕获却因
// rollThanks 缺失整体跳过)。顺序: UI 子树 → GetUI 自建 → 全场景扫殿后 (明确标记 LIVE/资产)
function ensureScroll() {
    try {
        if (comp.rollScroll && isScrollRoll(comp.rollScroll))
            return true;
        if (comp.creditsUI && !comp.creditsUI.isNull())
            scanUiRolls(comp.creditsUI, "已有UI");
        if (!comp.rollScroll)
            spawnCreditsUI();
        if (!comp.rollScroll) {
            var r = findRollsStaged(cls.rollScroll, "rollScroll");
            if (r.stage === 1 || r.stage === 2) {
                for (var i = 0; i < r.objs.length && !comp.rollScroll; i++)
                    captureRolls(r.objs[i], "全场景扫");
            }
            else if (r.stage === 3) {
                if (r.objs.length)
                    ensureRollFromAsset(r.objs[0], cls.rollScroll, isScrollRoll, "scroll");
                else
                    warn("[v3][Credit] rollScroll: 场景与资产均无");
            }
        }
        if (!comp.rollScroll || !isScrollRoll(comp.rollScroll)) {
            warn("[v3][Credit] rollScroll 不可得 (UI=" + (comp.creditsUI ? "有但无 roll 子树" : "无") + ") — director 由原版 PlayAsync 初始化, 全新会话首次需先跑一次原版 @credit (之后本会话常驻)");
            return false;
        }
        return true;
    }
    catch (e) {
        warn("[v3][Credit] ensureScroll err: " + e);
        return false;
    }
}
function ensureThanks() {
    try {
        if (comp.rollThanks && isThanksRoll(comp.rollThanks))
            return true;
        if (comp.creditsUI && !comp.creditsUI.isNull())
            scanUiRolls(comp.creditsUI, "已有UI");
        if (!comp.rollThanks && !comp.creditsUI)
            spawnCreditsUI();
        if (!comp.rollThanks) {
            var r = findRollsStaged(cls.rollThanks, "rollThanks");
            if (r.stage === 1 || r.stage === 2) {
                for (var j = 0; j < r.objs.length && !comp.rollThanks; j++)
                    captureRolls(r.objs[j], "全场景扫");
            }
            else if (r.stage === 3) {
                if (r.objs.length)
                    ensureRollFromAsset(r.objs[0], cls.rollThanks, isThanksRoll, "thanks");
                else
                    warn("[v3][Credit] rollThanks: 场景与资产均无");
            }
        }
        if (!comp.rollThanks || !isThanksRoll(comp.rollThanks)) {
            warn("[v3][Credit] rollThanks 不可得 (UI=" + (comp.creditsUI ? "有但无 roll 子树" : "无") + ") — director 由原版 PlayAsync 初始化, 全新会话首次需先跑一次原版 @credit (之后本会话常驻)");
            return false;
        }
        return true;
    }
    catch (e) {
        warn("[v3][Credit] ensureThanks err: " + e);
        return false;
    }
}
function captureFromDirector(dir, tag) {
    try {
        if (!dir || dir.isNull())
            return;
        var rolls = dir.add(0x60).readPointer(); // _creditRolls@0x60 (prefab 序列化, Awake 已填)
        if (!rolls || rolls.isNull())
            return;
        var rl = rolls.add(0x18).readS32();
        if (rl < 1 || rl > 16)
            return;
        for (var j = 0; j < rl; j++) {
            var r = rolls.add(0x20 + j * 8).readPointer();
            if (r.isNull())
                continue;
            captureRolls(r, tag);
        }
    }
    catch (e) {
        warn("[v3][Credit] captureFromDirector err: " + e);
    }
}
// ============ dict 类: metadata 自解析 (实现阶段修正 — 全新会话无原版 ShowAsync 可偷) ============
// CreditsDirectorAct2._specialThanksCredits = Dictionary<LocaleKind, string[][]> (dump.cs:481224 实锤)
// field_get_type → 泛型实例化 Il2CppType → class_from_type → Il2CppClass — 开机可得, 零依赖
// run-8 修正: il2cpp_field_get_type / il2cpp_method_get_param 不在 GameAssembly.dylib 导出表
//   (nm/strings 双证, A 表里也没有) → 路径B 改托管反射 (MakeGenericType → TypeHandle → class_from_type)
// 托管反射: typeof(Dictionary<,>).MakeGenericType([LocaleKind, string[][]]) → RuntimeTypeHandle.value
//   (= Il2CppType*) → A.cft — 全程只用已绑定的导出 (class_get_type/type_get_object/array_new/invoke/directCall)
function dictClsViaReflection() {
    try {
        // run-10: 每步日志二分 — 崩溃在哨兵前, 嫌疑 A.tgo(开放泛型)/A.an(Type)
        var typeCls = getSystemClass("Type");
        if (!typeCls || typeCls.isNull()) {
            warn("[v3][Credit] 反射 1/8 System.Type 未找到");
            return null;
        }
        info("[v3][Credit] 反射 1/8 System.Type ok");
        var gtMi = A.cgm(typeCls, Memory.allocUtf8String("GetType"), 1);
        if (!gtMi || gtMi.isNull()) {
            warn("[v3][Credit] 反射 2/8 Type.GetType NOT FOUND");
            return null;
        }
        // run-14: 2a — GetType(closed 泛型全名) 一步拿 Dictionary<LocaleKind,string[][]> 具体 Type,
        //   绕过 MakeGenericType/typeArr (run-13 崩在 3/8-4/8 构造区)。
        //   LocaleKind assembly 定位: dump.cs Image 74 = GigaCreation.Essentials.Localization
        //   (TypeDefIndex 17606-17630, LocaleKind=17615)。嵌套泛型名语法: `2[[T1,Asm1],[T2,Asm2]]。
        //   run-12 修复: 静态方法实例传 ptr(0) 而非 JS null — Frida NativeFunction 指针参数不接受 null
        var closedName = "System.Collections.Generic.Dictionary`2[[GigaCreation.Essentials.Localization.LocaleKind, GigaCreation.Essentials.Localization],[System.String[][], mscorlib]]";
        var cg = invokeOk(gtMi, ptr(0), [makeS(closedName)]);
        if (cg.ok && cg.ret && !cg.ret.isNull()) {
            info("[v3][Credit] 反射 2a/8 GetType(closed) ok");
            var closed = cg.ret;
            if (A.csyst) {
                var c0 = A.csyst(closed);
                if (c0 && !c0.isNull()) {
                    info("[v3][Credit] 反射 2b/8 dict 类 = " + clsName(c0));
                    return c0;
                }
                warn("[v3][Credit] 反射 2b/8 csyst 失败 — 走 TypeHandle");
            }
            var thMi = cgmChain(A.ogc(closed), "get_TypeHandle", 0);
            if (!thMi || thMi.isNull()) {
                warn("[v3][Credit] 反射 2c/8 closed get_TypeHandle NOT FOUND");
                return null;
            }
            var it2 = directCall(thMi, 'pointer', [closed]);
            if (it2 && !it2.isNull()) {
                var c2 = A.cft(it2);
                if (c2 && !c2.isNull()) {
                    info("[v3][Credit] 反射 2d/8 dict 类 (closed TypeHandle) = " + clsName(c2));
                    return c2;
                }
            }
            warn("[v3][Credit] 反射 2c/8 closed TypeHandle 失败 — 走开放泛型路径");
        }
        else {
            info("[v3][Credit] 反射 2a/8 GetType(closed) 失败 (类型名错误/未加载?) — 走开放泛型 MakeGenericType 路径");
        }
        // ---- 开放泛型路径 (原 2/8-8/8) ----
        var openType = null;
        var gt = invokeOk(gtMi, ptr(0), [makeS("System.Collections.Generic.Dictionary`2")]);
        if (gt.ok && gt.ret && !gt.ret.isNull()) {
            openType = gt.ret;
            info("[v3][Credit] 反射 3/8 Type.GetType(开放) ok");
        }
        if (!openType || openType.isNull()) {
            var openCls = findClassAcrossImages("System.Collections.Generic", "Dictionary`2");
            if (!openCls || openCls.isNull()) {
                warn("[v3][Credit] 反射 3/8 Dictionary`2 类未找到 (GetType 也失败)");
                return null;
            }
            openType = A.tgo(A.cgt(openCls)); // typeof(Dictionary<,>) — run-10 崩溃嫌疑点, 兜底路径
            info("[v3][Credit] 反射 3/8 tgo(开放泛型) ok (GetType 失败, 兜底)");
        }
        // run-14: 4a/4b/4c/4d 细分 — run-13 崩在 3/8-4/8 之间, 哨兵精确到每步定位
        var sArrCls = stringArrayCls();
        if (!sArrCls || sArrCls.isNull()) {
            warn("[v3][Credit] 反射 4a/8 string[] 类未找到");
            return null;
        }
        info("[v3][Credit] 反射 4a/8 string[] 类 ok");
        if (!comp.gArrCls || comp.gArrCls.isNull()) {
            var t = A.an(sArrCls, 1);
            if (!t || t.isNull()) {
                warn("[v3][Credit] 反射 4b/8 gArrCls 实例失败");
                return null;
            }
            comp.gArrCls = A.ogc(t);
            info("[v3][Credit] 反射 4b/8 gArrCls (string[][]) ok");
        }
        // Type[] 参数 (array_new 元素类 = System.Type; IL2CPP 64 位布局: 数据从 0x20 起)
        var typeArr = A.an(A.cgt(typeCls), 2);
        if (!typeArr || typeArr.isNull()) {
            warn("[v3][Credit] 反射 4c/8 Type[] array_new 失败");
            return null;
        }
        info("[v3][Credit] 反射 4c/8 Type[] array_new ok");
        typeArr.add(0x20).writePointer(A.tgo(A.cgt(cls.localeKind)));
        typeArr.add(0x28).writePointer(A.tgo(A.cgt(comp.gArrCls)));
        info("[v3][Credit] 反射 4d/8 Type[] 写入 ok");
        // run-9 修复: MakeGenericType/get_TypeHandle 在 System.Type 上是抽象方法, methodPointer 是 thunk
        //   directCall → 垃圾指针 → access violation (启动卡死根因)。必须 cgmChain 在具体类
        //   (RuntimeType) 上找实现 — invokeOk 对虚方法经 vtable 分派可接受, directCall 不行
        var mgtMi = cgmChain(A.ogc(openType), "MakeGenericType", 1);
        if (!mgtMi || mgtMi.isNull()) {
            warn("[v3][Credit] 反射 5/8 Type.MakeGenericType NOT FOUND");
            return null;
        }
        info("[v3][Credit] 反射 5/8 MakeGenericType 方法 ok — 若此后无日志则是此处卡住");
        var closed = invokeOk(mgtMi, openType, [typeArr]);
        if (!closed.ok || !closed.ret || closed.ret.isNull()) {
            warn("[v3][Credit] 反射 5/8 MakeGenericType FAIL");
            return null;
        }
        info("[v3][Credit] 反射 6/8 MakeGenericType 调用 ok");
        // 首选: il2cpp_class_from_system_type (entry.js A.csyst) — Type 对象 → Il2CppClass 直读
        if (A.csyst) {
            var c0 = A.csyst(closed.ret);
            if (c0 && !c0.isNull()) {
                info("[v3][Credit] dict 类 metadata 自解析 (csyst) = " + clsName(c0));
                return c0;
            }
        }
        // TypeHandle 是 8B 结构体返回 — invoke 缓冲失效, 必须 directCall (utils 实证规矩);
        // get_TypeHandle 同样在具体类上找 (cgmChain), 抽象类 thunk 会读到垃圾指针
        var thMi = cgmChain(A.ogc(closed.ret), "get_TypeHandle", 0);
        if (!thMi || thMi.isNull()) {
            warn("[v3][Credit] 反射 7/8 Type.get_TypeHandle NOT FOUND");
            return null;
        }
        var il2cppType = directCall(thMi, 'pointer', [closed.ret]); // RuntimeTypeHandle.value = Il2CppType*
        if (!il2cppType || il2cppType.isNull()) {
            warn("[v3][Credit] 反射 7/8 TypeHandle 直调失败");
            return null;
        }
        var c = A.cft(il2cppType);
        if (c && !c.isNull()) {
            info("[v3][Credit] 反射 8/8 class_from_type ok");
            return c;
        }
        warn("[v3][Credit] 反射 8/8 class_from_type(TypeHandle) 失败");
        return null;
    }
    catch (e) {
        warn("[v3][Credit] dictClsViaReflection err: " + e);
        return null;
    }
}
function resolveDictCls() {
    try {
        if (comp.dictCls && !comp.dictCls.isNull())
            return comp.dictCls;
        // 路径A: 字段类型 (metadata 自解析, 首选) — director._specialThanksCredits@0xA0 = Dictionary<LocaleKind,string[][]>
        if (fgt) {
            var f = A.gf(cls.director, Memory.allocUtf8String("_specialThanksCredits"));
            if (f && !f.isNull()) {
                var ft = fgt(f);
                if (ft && !ft.isNull()) {
                    var c = A.cft(ft);
                    if (c && !c.isNull()) {
                        comp.dictCls = c;
                        info("[v3][Credit] dict 类 metadata 自解析 (字段) = " + clsName(c));
                        return c;
                    }
                }
            }
        }
        // 路径B: ShowAsync 参数0 类型 (闭式泛型参数, mgp 反查同效)
        if (mgp) {
            var mi = A.cgm(cls.rollThanks, Memory.allocUtf8String("ShowAsync"), 5);
            if (mi && !mi.isNull()) {
                var pt = mgp(mi, 0);
                if (pt && !pt.isNull()) {
                    var c2 = A.cft(pt);
                    if (c2 && !c2.isNull()) {
                        comp.dictCls = c2;
                        info("[v3][Credit] dict 类 metadata 自解析 (ShowAsync 参数) = " + clsName(c2));
                        return c2;
                    }
                }
            }
        }
        // 路径C: 托管反射 (run-8 主路径 — fgt/mgp 不在导出表)
        var c3 = dictClsViaReflection();
        if (c3 && !c3.isNull()) {
            comp.dictCls = c3;
            info("[v3][Credit] dict 类 metadata 自解析 (MakeGenericType) = " + clsName(c3));
            return c3;
        }
        warn("[v3][Credit] dict 类 metadata 自解析失败 (fgt=" + !!fgt + " mgp=" + !!mgp + " 反射=" + !!c3 + ") — 走偷取回退");
        return null;
    }
    catch (e) {
        warn("[v3][Credit] resolveDictCls err: " + e);
        return null;
    }
}
// ============ F1 根治: 祖先链激活 (探针 run-4 实证 canvas 0→1, 动画恢复) ============
// run-8 升级: CanvasGroup alpha=1 — Naninovel 用 CanvasGroup 控制 UI 显隐 (隐藏态 alpha=0);
//   只激活 GO 链不够, 原版 PlayAsync 的 fade 才置 1 — LIVE roll + canvas active 仍不可见的头号嫌疑
function setCanvasGroupAlpha(go, alpha) {
    try {
        var mi = cgmChain(A.ogc(go), "GetComponent", 1); // GetComponent 属于 GO 类, 非 CanvasGroup
        var cg = invokeOk(mi, go, [A.tgo(A.cgt(cls.canvasGroup))]);
        if (!cg.ok || !cg.ret || cg.ret.isNull())
            return false;
        var a = dcFloat(cgmChain(A.ogc(cg.ret), "get_alpha", 0), cg.ret);
        if (a !== alpha) {
            invoke(cgmChain(A.ogc(cg.ret), "set_alpha", 1), cg.ret, [fPtr(alpha)]);
            dbg("[v3][Credit] CanvasGroup alpha " + a + " → " + alpha + " (" + getGoName(go) + ")");
        }
        return true;
    }
    catch (e) {
        return false;
    }
}
function ensureHierarchy() {
    try {
        var anchor = (!comp.rollScroll || comp.rollScroll.isNull()) ? comp.rollThanks : comp.rollScroll;
        var go = anchor.add(0x20).readPointer(); // CreditRoll._gameObject@0x20
        if (!go || go.isNull()) {
            warn("[v3][Credit] roll _gameObject@0x20 为空");
            return false;
        }
        var gt = invokeOk(cgmChain(A.ogc(go), "get_transform", 0), go, []);
        var chain = [];
        var cur = gt.ok ? gt.ret : null;
        while (cur && !cur.isNull()) {
            chain.push(cur);
            var p = invokeOk(cgmChain(A.ogc(cur), "get_parent", 0), cur, []);
            if (!p.ok || p.ret.isNull())
                break;
            cur = p.ret;
        }
        var n = 0, cgN = 0, cgParts = [];
        for (var i = chain.length - 1; i >= 0; i--) { // 从最上层祖先往下激活
            var t = chain[i];
            var g = invokeOk(cgmChain(A.ogc(t), "get_gameObject", 0), t, []);
            if (!g.ok || g.ret.isNull())
                continue;
            var as = dcBool(cgmChain(A.ogc(g.ret), "get_activeSelf", 0), g.ret);
            if (!as) {
                invoke(cgmChain(A.ogc(g.ret), "SetActive", 1), g.ret, [boolPtr(true)]);
                activatedAncestors.push(g.ret);
                n++;
            }
            if (setCanvasGroupAlpha(g.ret, 1.0)) {
                cgN++;
                cgParts.push(getGoName(g.ret));
            }
        }
        info("[v3][Credit] 祖先链激活 " + n + " 个 GO / CanvasGroup 置 1 共 " + cgN + " 个 (" + cgParts.join(", ") + ") (链深 " + chain.length + ")");
        return n > 0 || cgN > 0;
    }
    catch (e) {
        warn("[v3][Credit] ensureHierarchy err: " + e);
        return false;
    }
}
// run-10 修复: 渲染栈 — alpha=1 后仍不可见 → sortingOrder/renderMode 嫌疑
//   (Naninovel UIManager 显示 UI 时会注册排序; 开机自建实例未走注册, sortingOrder 可能压在别的 canvas 下面;
//   ScreenSpaceCamera + 相机为空 = Unity 必不渲染的组合)
function ensureCanvasRenderable() {
    try {
        var anchor = (!comp.rollScroll || comp.rollScroll.isNull()) ? comp.rollThanks : comp.rollScroll;
        var go = anchor.add(0x20).readPointer(); // CreditRoll._gameObject@0x20
        if (!go || go.isNull()) {
            warn("[v3][Credit] 渲染修复: roll _gameObject@0x20 为空");
            return false;
        }
        var gt = invokeOk(cgmChain(A.ogc(go), "get_transform", 0), go, []);
        var cur = gt.ok ? gt.ret : null;
        var canvases = [], rootCanvas = null;
        while (cur && !cur.isNull()) {
            var g = invokeOk(cgmChain(A.ogc(cur), "get_gameObject", 0), cur, []);
            if (g.ok && g.ret) {
                var cv = invokeOk(cgmChain(A.ogc(g.ret), "GetComponent", 1), g.ret, [A.tgo(A.cgt(cls.canvas))]);
                if (cv.ok && cv.ret && !cv.ret.isNull()) {
                    canvases.push(cv.ret);
                    rootCanvas = cv.ret;
                }
            }
            var p = invokeOk(cgmChain(A.ogc(cur), "get_parent", 0), cur, []);
            if (!p.ok || p.ret.isNull())
                break;
            cur = p.ret;
        }
        if (!canvases.length) {
            warn("[v3][Credit] 渲染修复: 链上无 Canvas 组件");
            return false;
        }
        for (var i = 0; i < canvases.length; i++) {
            var c = canvases[i];
            var rm = dcInt(cgmChain(A.ogc(c), "get_renderMode", 0), c);
            var so = dcInt(cgmChain(A.ogc(c), "get_sortingOrder", 0), c);
            if (!dcBool(cgmChain(A.ogc(c), "get_isActiveAndEnabled", 0), c))
                invoke(cgmChain(A.ogc(c), "set_enabled", 1), c, [boolPtr(true)]);
            invoke(A.cgm(cls.canvas, Memory.allocUtf8String("set_sortingOrder"), 1), c, [iPtr(10000)]);
            var lay = -1;
            var ggo = invokeOk(cgmChain(A.ogc(c), "get_gameObject", 0), c, []);
            if (ggo.ok && ggo.ret)
                lay = dcInt(cgmChain(A.ogc(ggo.ret), "get_layer", 0), ggo.ret);
            info("[v3][Credit] canvas[" + i + "] " + getGoName(c) + ": renderMode=" + rm + " sortingOrder " + so + "→10000 enabled=1 layer=" + lay);
        }
        if (rootCanvas) {
            var rm2 = dcInt(cgmChain(A.ogc(rootCanvas), "get_renderMode", 0), rootCanvas);
            if (rm2 === 1) {
                var cam = invokeOk(cgmChain(A.ogc(rootCanvas), "get_camera", 0), rootCanvas, []);
                if (!cam.ok || cam.ret.isNull()) {
                    warn("[v3][Credit] 根 canvas 为 ScreenSpaceCamera 且相机为空 → 改 ScreenSpaceOverlay");
                    invoke(A.cgm(cls.canvas, Memory.allocUtf8String("set_renderMode"), 1), rootCanvas, [iPtr(0)]);
                }
                else {
                    info("[v3][Credit] 根 canvas: ScreenSpaceCamera, 相机=" + getGoName(cam.ret));
                }
            }
        }
        return true;
    }
    catch (e) {
        warn("[v3][Credit] ensureCanvasRenderable err: " + e);
        return false;
    }
}
function restoreAncestors() {
    for (var i = 0; i < activatedAncestors.length; i++) {
        try {
            invoke(cgmChain(A.ogc(activatedAncestors[i]), "SetActive", 1), activatedAncestors[i], [boolPtr(false)]);
        }
        catch (e) { }
    }
    activatedAncestors = [];
}
// ============ 写回变量 (F13: 缓存 manager 实例; 与触发同一 SetVariableValue 机制) ============
function writeVar(name, num) {
    try {
        if (!mgr || mgr.isNull()) {
            warn("[v3][Credit] writeVar(" + name + ") FAIL: 无 CustomVariableManager 实例");
            return false;
        }
        var mi = A.cgm(cls.customVarMgr, Memory.allocUtf8String("SetVariableValue"), 2);
        var v = Memory.alloc(0x18);
        v.writeS32(1); // type: Numeric
        v.add(0x8).writePointer(ptr(0));
        v.add(0x10).writeFloat(num);
        v.add(0x14).writeS32(0);
        var r = invokeOk(mi, mgr, [makeS(name), v]);
        if (!r.ok)
            warn("[v3][Credit] writeVar(" + name + ") FAIL");
        return r.ok;
    }
    catch (e) {
        warn("[v3][Credit] writeVar err: " + e);
        return false;
    }
}
// ============ run-30: 原版致谢完整数据探针 (trigger "probe-thanks") ============
// 背景: staff-samples.json 的 42 条 = 运行时轮询采样窗口的不完整快照 (采样抓 Text 属性,
//   轮询间隔错过大量行) → mod 名单远少于原版 (SpecialThanksData asset 实证:
//   4544 ja + 420 zh 赞助者, 课程分档)。完全还原 = 原版实际显示的每行富文本 + 时序。
// 数据源:
//   ① director._specialThanksCredits@0xA0 = Dictionary<LocaleKind,string[][]> (PlayAsync 前已构建)
//      → 每语种 页[] (页 = 行[]), 行 = 富文本 (格式实证: <size=1.7em>名</size><space=80>...)
//   ② hook SpecialThanksLabel.set_Text → 实际播放序列 (行 + 时间戳) — 时序/顺序验证
// 输出: TestCredit/Assets/special-credits.json (①全量) + thanks-rows.json (②序列)
var thanksProbe = { attached: false, rows: [], flushTimer: null, t0: 0 };
function thanksProbeRoot() {
    return (typeof MOD_ROOT !== "undefined" && MOD_ROOT) ? MOD_ROOT + "/TestCredit/Assets" : "/tmp";
}
function thanksProbeWrite(obj, fname) {
    try {
        var path = thanksProbeRoot() + "/" + fname;
        var fd = openForWrite(path);
        if (fd < 0) {
            warn("[v3][Credit] 探针: 写文件失败 " + path);
            return;
        }
        // 用 io.js writeString (Memory.allocUtf8String + 扫 NUL 计长, 日志系统实证) —
        //   Frida writeUtf8String 返回值不可靠 (实测写出 800KB 全零)
        var wrote = writeString(fd, JSON.stringify(obj, null, 1));
        fileSync(fd);
        try {
            var ch = Module.findGlobalExportByName("chmod");
            if (ch)
                new NativeFunction(ch, "int", ["pointer", "int"])(Memory.allocUtf8String(path), 0o644);
        }
        catch (e2) { }
        info("[v3][Credit] 探针: 已写出 " + fname + " (" + (wrote / 1024).toFixed(0) + "KB)");
    }
    catch (e) {
        warn("[v3][Credit] 探针写盘 err: " + e);
    }
}
// ① 完整页/行数据 — director._specialThanksCredits@0xA0 (Dictionary<LocaleKind,string[][]>,
//   IL2CPP 字典布局: m_entries@0x18, Entry stride 24, 空槽 hashCode==-1 — choice.js 实证)
function thanksProbeDict() {
    try {
        var d = comp.director;
        if (!d || d.isNull()) {
            warn("[v3][Credit] 探针: 无 director");
            return;
        }
        var dict = d.add(0xA0).readPointer();
        if (!dict || dict.isNull()) {
            warn("[v3][Credit] 探针: _specialThanksCredits=null");
            return;
        }
        var ents = dict.add(0x18).readPointer();
        if (!ents || ents.isNull()) {
            warn("[v3][Credit] 探针: m_entries 不可得");
            return;
        }
        var al = ents.add(0x18).readS32();
        if (al < 0 || al > 32) {
            warn("[v3][Credit] 探针: entries 数量异常 " + al);
            return;
        }
        var names = ["ja", "en-US", "zh-Hans", "zh-Hant", "ko", "fr", "es"];
        var out = { localeKeys: [] };
        for (var e = 0; e < al; e++) {
            var eb = ents.add(0x20 + e * 24);
            if (eb.readS32() === -1)
                continue; // 空槽
            var key = eb.add(8).readS32(); // LocaleKind
            if (key < 0 || key > 6)
                continue;
            var val = eb.add(0x10).readPointer(); // string[][]
            if (!val || val.isNull())
                continue;
            var glen = val.add(0x18).readS32();
            if (glen < 0 || glen > 2000) {
                warn("[v3][Credit] 探针: '" + names[key] + "' 页数异常 " + glen);
                continue;
            }
            var pages = [];
            for (var g = 0; g < glen; g++) {
                var arr = val.add(0x20 + g * 8).readPointer();
                if (!arr || arr.isNull())
                    continue;
                var alen = arr.add(0x18).readS32();
                if (alen < 0 || alen > 2000)
                    continue;
                var lines = [];
                for (var l = 0; l < alen; l++) {
                    var s = arr.add(0x20 + l * 8).readPointer();
                    if (s && !s.isNull())
                        lines.push(readStr(s));
                }
                pages.push(lines);
            }
            var nr = 0;
            for (var g2 = 0; g2 < pages.length; g2++)
                nr += pages[g2].length;
            out[names[key]] = { pages: pages, nRows: nr };
            out.localeKeys.push(names[key]);
            info("[v3][Credit] 探针: 语种 '" + names[key] + "' " + pages.length + " 页 " + nr + " 行");
        }
        thanksProbeWrite(out, "special-credits.json");
    }
    catch (e) {
        warn("[v3][Credit] thanksProbeDict err: " + e);
    }
}
// ② 实际播放序列 — SpecialThanksLabel.set_Text/Clear (行 + 时间戳)
function installThanksProbe() {
    try {
        if (thanksProbe.attached)
            return;
        // run-30c: TMP 级全局 hook (set_text/SetText) — 共犯页显示路径不一定是 SpecialThanksLabel.set_Text
        //   (16:52 实证: 共犯页播了但包装 set_Text 零触发)。全量收集 + 时间戳, 事后按内容区分
        //   (共犯行 = 富文本 <size=/<br>, staff 滚动 = 纯文本; 顺序即演出顺序)。
        var tmpCls = findClassAcrossImages("TMPro", "TextMeshProUGUI");
        if (!tmpCls || tmpCls.isNull()) {
            warn("[v3][Credit] 探针: TextMeshProUGUI 类 NOT FOUND");
            return;
        }
        var tmpSet = A.cgm(tmpCls, Memory.allocUtf8String("set_text"), 1);
        var tmpSetTxt = A.cgm(tmpCls, Memory.allocUtf8String("SetText"), 1);
        thanksProbe.t0 = Date.now();
        var tmpEnter = function (a) {
            try {
                var s = readStr(a[1]);
                if (!s || s.length < 2 || s.length > 20000)
                    return;
                var last = thanksProbe.rows[thanksProbe.rows.length - 1];
                var now = Date.now() - thanksProbe.t0;
                if (last && last.k === 1 && last.text === s && now - last.t < 80) {
                    last.t = now;
                    return;
                }
                thanksProbe.rows.push({ k: 1, t: now, text: s });
            }
            catch (e2) { }
        };
        var attached = 0;
        if (tmpSet && !tmpSet.isNull() && !tmpSet.readPointer().isNull()) {
            Interceptor.attach(tmpSet.readPointer(), { onEnter: tmpEnter });
            attached++;
        }
        if (tmpSetTxt && !tmpSetTxt.isNull() && !tmpSetTxt.readPointer().isNull()) {
            Interceptor.attach(tmpSetTxt.readPointer(), { onEnter: tmpEnter });
            attached++;
        }
        // 对照: SpecialThanksLabel.set_Text (16:52 零触发 — 保留以确认路径)
        var cl = findClassAcrossImages("WitchTrials.Views", "SpecialThanksLabel");
        if (cl && !cl.isNull()) {
            var mi = A.cgm(cl, Memory.allocUtf8String("set_Text"), 1);
            if (mi && !mi.isNull() && !mi.readPointer().isNull()) {
                Interceptor.attach(mi.readPointer(), { onEnter: function (a) { try {
                        var s = readStr(a[1]);
                        if (s && s.length > 1)
                            info("[v3][Credit] 探针[set_Text]: " + s.slice(0, 60));
                    }
                    catch (e2) { } } });
                attached++;
            }
        }
        var miClear = A.cgm(cl, Memory.allocUtf8String("Clear"), 0);
        if (miClear && !miClear.isNull() && !miClear.readPointer().isNull()) {
            Interceptor.attach(miClear.readPointer(), { onEnter: function () { try {
                    thanksProbe.rows.push({ k: 0, t: Date.now() - thanksProbe.t0 });
                }
                catch (e2) { } } });
        }
        // run-30b: hook CreditRollSpecialThanks.ShowAsync — 共犯页在 PlayAsync 链路哪一环触发 (调用时机)
        try {
            var clsRoll = findClassAcrossImages("WitchTrials.Views", "CreditRollSpecialThanks");
            if (clsRoll && !clsRoll.isNull()) {
                var miSA = A.cgm(clsRoll, Memory.allocUtf8String("ShowAsync"), 5);
                if (miSA && !miSA.isNull() && !miSA.readPointer().isNull()) {
                    Interceptor.attach(miSA.readPointer(), {
                        onEnter: function () {
                            info("[v3][Credit] 探针: ShowAsync 被调用 @" + ((Date.now() - thanksProbe.t0) / 1000).toFixed(0) + "s (共犯页开始)");
                        }
                    });
                }
            }
        }
        catch (e3) {
            warn("[v3][Credit] 探针 ShowAsync hook err: " + e3);
        }
        thanksProbe.attached = true;
        info("[v3][Credit] 探针已挂 (SpecialThanksLabel.set_Text + Clear + ShowAsync — 逐行富文本 + 时序)");
        if (!thanksProbe.flushTimer)
            thanksProbe.flushTimer = setInterval(function () { try {
                thanksProbeFlush();
            }
            catch (e4) { } }, 3000);
    }
    catch (e) {
        warn("[v3][Credit] installThanksProbe err: " + e);
    }
}
function thanksProbeFlush() {
    try {
        if (!thanksProbe.rows.length)
            return;
        thanksProbeWrite({ n: thanksProbe.rows.length, rows: thanksProbe.rows }, "thanks-rows.json");
    }
    catch (e) { }
}
// ============ 数据 json ============
function loadCreditData(path) {
    creditState.json = null;
    creditState.stillsConf = null; // run-31: 每次 trigger 重置 (original 分支提前 return, 不清会残留上次自定义列表)
    creditState.original = false;
    // run-15: 原版复刻模式 — 值 "original" 不读 json, 直接调原版 CreditsUI.PlayAsync(2)
    //   (= nani @credit 2 命令全流程: stills + staff 滚动 + SpecialThanks, 内容/语种/时序全原版)
    // run-30: "probe-thanks" = 原版全流程 + 共犯完整数据探针 (字典全量 + set_Text 逐行时序)
    if (path === "original" || path === "extract" || path === "probe-thanks") {
        creditState.original = true;
        creditState.extract = (path === "extract" || path === "probe-thanks"); // run-30: probe-thanks 复用 extract 分支挂探针
        writeVar("g_creditDone", 0); // run-19: trigger 即重置 — CustomVariableManager 变量持久化, 防上次会话残留 1
        if (creditState.extract) {
            writeVar("g_extractDone", 0);
        }
        info("[v3][Credit] trigger '" + path + "' → 原版复刻模式已武装 (phase=2 将调 CreditsUI.PlayAsync(2)" + (creditState.extract ? (path === "probe-thanks" ? " + 共犯完整数据探针" : " + 演出素材提取") : "") + ")");
        return true;
    }
    if (typeof MOD_ROOT === "undefined" || !MOD_ROOT) {
        warn("[v3][Credit] MOD_ROOT 未定义");
        return false;
    }
    var modKey = wbCurrentMod;
    var p = modKey ? (MOD_ROOT + "/" + modKey + "/" + path) : (MOD_ROOT + "/" + path);
    var j = readJSONFile(p);
    if (!j) {
        warn("[v3][Credit] json 读取失败 '" + p + "'" + (modKey ? "" : " (当前 mod 未知, 回退 mod 根)"));
        return false;
    }
    creditState.json = j;
    // run-30c: thanks 数据覆盖 — Assets/thanks-pages.json (原版运行捕获的 36 屏全量:
    //   zh 420 + ja 4544 合并名单, 页内行富文本原样) 优先于 data.json 的旧 42 行采样
    try {
        var tp = modKey ? (MOD_ROOT + "/" + modKey + "/Assets/thanks-pages.json") : (MOD_ROOT + "/Assets/thanks-pages.json");
        var tpj = readJSONFile(tp);
        // 兼容两种结构: {thanks:{...}} 包裹 或 直接 {order, "<locale>": {...}}
        var src = (tpj && tpj.thanks) ? tpj.thanks : (tpj && tpj.order ? tpj : null);
        if (src) {
            var nP = 0;
            for (var k3 in src) {
                if (k3 !== "order" && src[k3] && src[k3].pages)
                    nP += src[k3].pages.length;
            }
            if (nP > 0) {
                j.thanks = src;
                info("[v3][Credit] thanks 数据已覆盖: " + tp + " (" + nP + " 页全量)");
            }
        }
        else {
            dbg("[v3][Credit] thanks-pages.json 无 thanks 字段或缺失 — 用 data.json 旧数据");
        }
    }
    catch (eC) {
        warn("[v3][Credit] thanks 覆盖 err: " + eC);
    }
    creditState.jsonPath = p;
    // run-31: 自定义 stills 播放列表 — 数组序 = 播放序; 缺 file 条目占位 null (该位显示原版 sprite, 列表不错位);
    //   非数组/空数组 → warn + 原版 9 张。时长字段全部可选, 缺省回落原版换算 (stillTick 分相取)
    creditState.stillsConf = null;
    if (j.stills !== undefined) {
        if (Array.isArray(j.stills) && j.stills.length) {
            var conf = [], nBad = 0;
            for (var si = 0; si < j.stills.length; si++) {
                var it = j.stills[si];
                if (!it || typeof it.file !== "string" || !it.file) {
                    nBad++;
                    continue;
                } // 占位 null → 原版
                var e = { file: it.file };
                // 0 是有效值 (display 0 = 展示完立即淡出; fade 0 → clamp 200ms 防除零); 负数视为缺省回落原版
                if (typeof it.display === "number" && it.display >= 0)
                    e.displayMs = it.display * 1000;
                if (typeof it.fadeIn === "number" && it.fadeIn >= 0)
                    e.fadeInMs = Math.max(200, it.fadeIn * 1000);
                if (typeof it.fadeOut === "number" && it.fadeOut >= 0)
                    e.fadeOutMs = Math.max(200, it.fadeOut * 1000);
                conf[si] = e;
            }
            creditState.stillsConf = conf;
            info("[v3][Credit] stills 播放列表: " + j.stills.length + " 项 (无效 " + nBad + " 项走原版) — 图片仅 PNG, 路径相对 mod 根");
        }
        else {
            warn("[v3][Credit] stills 段非数组或空 — 用原版 9 张");
        }
    }
    // 校验: staff 至少一个语种有内容; thanks 至少一个语种有 groups
    var staffOk = false, thanksOk = false;
    if (j.staff && typeof j.staff === "object") {
        for (var k in j.staff) {
            if (k !== "speed" && k !== "endPause" && Array.isArray(j.staff[k]) && j.staff[k].length)
                staffOk = true;
        }
    }
    if (j.thanks && typeof j.thanks === "object") {
        for (var k2 in j.thanks) {
            if (k2 !== "order" && j.thanks[k2] && Array.isArray(j.thanks[k2].pages) && j.thanks[k2].pages.length)
                thanksOk = true;
        } // run-29: pages
    }
    var stats = [];
    if (staffOk)
        stats.push("staff 有内容");
    if (thanksOk)
        stats.push("thanks 有内容");
    info("[v3][Credit] json 加载 '" + p + "' (" + (stats.join(", ") || "空!") + ")");
    return staffOk || thanksOk; // 至少一部分可用才 arm; 否则 phase 走安全默认时长
}
// staff 行: 当前语种 → ja 回退 → zh-Hans 回退
function staffLinesForLocale() {
    var j = creditState.json;
    if (!j || !j.staff)
        return [];
    var loc = getCurrentLocale();
    if (Array.isArray(j.staff[loc]) && j.staff[loc].length)
        return j.staff[loc];
    if (loc !== "ja" && Array.isArray(j.staff.ja) && j.staff.ja.length)
        return j.staff.ja;
    if (loc !== "zh-Hans" && Array.isArray(j.staff["zh-Hans"]) && j.staff["zh-Hans"].length)
        return j.staff["zh-Hans"];
    for (var k in j.staff) {
        if (k !== "speed" && k !== "endPause" && Array.isArray(j.staff[k]) && j.staff[k].length)
            return j.staff[k];
    }
    return [];
}
// ============ 免偷数组构建 (string[] = array_new(String); string[][] = array_new(string[] 类)) ============
function stringArrayCls() {
    if (!comp.sArrCls || comp.sArrCls.isNull()) {
        var strCls = getSystemClass("String");
        if (!strCls || strCls.isNull()) {
            warn("[v3][Credit] System.String 类未找到");
            return ptr(0);
        }
        var arr = A.an(strCls, 1);
        if (!arr || arr.isNull()) {
            warn("[v3][Credit] string[] 创建失败");
            return ptr(0);
        }
        comp.sArrCls = A.ogc(arr);
    }
    return comp.sArrCls;
}
function makeGroups(groups) {
    try {
        var sArrCls = stringArrayCls();
        if (!sArrCls || sArrCls.isNull())
            return null;
        if (!comp.gArrCls || comp.gArrCls.isNull()) {
            var t = A.an(sArrCls, 1);
            if (!t || t.isNull()) {
                warn("[v3][Credit] string[][] 创建失败");
                return null;
            }
            comp.gArrCls = A.ogc(t);
        }
        var gArr = A.an(comp.gArrCls, groups.length);
        for (var i = 0; i < groups.length; i++) {
            var g = groups[i];
            var sArr = A.an(sArrCls, g.length);
            for (var j = 0; j < g.length; j++)
                sArr.add(0x20 + j * 8).writePointer(makeS(g[j]));
            gArr.add(0x20 + i * 8).writePointer(sArr);
        }
        return gArr;
    }
    catch (e) {
        warn("[v3][Credit] makeGroups err: " + e);
        return null;
    }
}
// LocaleKind 枚举 (dump.cs 实证: Ja=0, ZhHans=2); 未知语种 warn+跳过
var LOCALE_KIND = { "ja": 0, "zh-Hans": 2 };
function localeKindValue(loc) {
    if (LOCALE_KIND[loc] !== undefined)
        return LOCALE_KIND[loc];
    warn("[v3][Credit] 未知语种 '" + loc + "' (已知: ja/zh-Hans), 跳过");
    return null;
}
function localeName(lv) {
    for (var k in LOCALE_KIND) {
        if (LOCALE_KIND[k] === lv)
            return k;
    }
    return null;
}
function lineEm(text) {
    try {
        var m = /<size=([\d.]+)em>/.exec(text);
        return m ? parseFloat(m[1]) : null;
    }
    catch (e) {
        return null;
    }
}
// ============ run-26/27: still 图片显示 (复刻模式右侧画面) ============
// 原版 Act2: ShowStillsAsync 依次 Present/Dismiss 9 张 EndingStill (Still_1..9 = prefab 静态,
// CanvasGroup+Image; sprite 随 prefab 依赖加载)。复刻: 时序由 run-27 动态决定 —
//   delay   = キャスト 条目滚到屏上的时间 (castLeadOffsetPx/speed; 原版: 名单先滚, キャスト 段图才出现)
//   fade/display = 原版 director units × 60/bpm 换算 (bpm 可得时), 否则 fallback 2s/26s
// 9 张依次 fade (张间无 delay, 逐张 fadeout 切换 — run-28), 播完 fadeout 收尾。phase2 入口 fade 收尾。
function setStillAlpha(st, a) {
    try {
        if (st && st.cg && !st.cg.isNull())
            invoke(cgmChain(A.ogc(st.cg), "set_alpha", 1), st.cg, [fPtr(a)]);
    }
    catch (e) { }
}
function findStills() {
    try {
        comp.stills = [];
        if (!cls.endingStill || cls.endingStill.isNull())
            cls.endingStill = findClassAcrossImages("WitchTrials.Views", "EndingStill");
        if (!cls.endingStill || cls.endingStill.isNull()) {
            warn("[v3][Credit] still: EndingStill 类未找到");
            return 0;
        }
        var all = findAllObjectOfType(cls.endingStill);
        if (!all || !all.length) {
            warn("[v3][Credit] still: 场景无 EndingStill 组件");
            return 0;
        }
        // run-27: 顺序 — 优先 director._stills@0x58 数组序 (prefab 序列化顺序 = 原版显示顺序),
        //   兜底场景扫 + 名字数字序 (旧: 名字序导致 9→1, 与原版顺序不符)
        var d = (comp.director && !comp.director.isNull()) ? comp.director : null;
        if (!d) {
            var dR = findRollsStaged(cls.director, "CreditsDirectorAct2");
            for (var i = 0; i < (dR.objs || []).length && !d; i++) {
                if (dR.objs[i] && !dR.objs[i].isNull())
                    d = dR.objs[i];
            }
        }
        var order = null;
        if (d && !d.isNull()) {
            try {
                var stillsArr = d.add(0x58).readPointer();
                if (stillsArr && !stillsArr.isNull()) {
                    var n = stillsArr.add(0x18).readS32();
                    if (n >= 1 && n <= 50) {
                        order = [];
                        for (var ai = 0; ai < n; ai++) {
                            var es2 = stillsArr.add(0x20 + ai * 8).readPointer();
                            if (es2 && !es2.isNull())
                                order.push(es2);
                        }
                        info("[v3][Credit] still: _stills@0x58 数组 " + order.length + " 个 (原版顺序)");
                    }
                }
            }
            catch (e4) { }
        }
        function collectOne(es, arr, idx) {
            var go = null;
            try {
                var gg = invokeOk(cgmChain(A.ogc(es), "get_gameObject", 0), es, []);
                if (gg.ok)
                    go = gg.ret;
            }
            catch (e2) { }
            var nm = go ? getGoName(go) : "?";
            var cg = es.add(0x20).readPointer(); // EndingStill._canvasGroup@0x20
            var sp = "?", act = "?", imgRef = null, vanillaSpr = null;
            try {
                if (go)
                    act = dcBool(cgmChain(A.ogc(go), "get_activeSelf", 0), go) ? "活" : "隐";
                var comps = invokeOk(cgmChain(A.ogc(go), "GetComponentsInChildren", 2), go, [A.tgo(A.cgt(cls.image)), boolPtr(true)]);
                if (comps.ok && comps.ret) {
                    var clen = comps.ret.add(0x18).readS32();
                    for (var ci = 0; ci < clen; ci++) {
                        var img = comps.ret.add(0x20 + ci * 8).readPointer();
                        if (!img || img.isNull())
                            continue;
                        if (!imgRef)
                            imgRef = img; // run-31: 首个 Image 引用 (自定义图 set_sprite 目标)
                        var spR = invokeOk(cgmChain(A.ogc(img), "get_sprite", 0), img, []);
                        if (spR.ok && spR.ret && !spR.ret.isNull()) {
                            if (!vanillaSpr)
                                vanillaSpr = spR.ret; // run-31: 原版 sprite (immutable, 恢复用)
                            if (sp === "?") {
                                var nmR = invokeOk(cgmChain(A.ogc(spR.ret), "get_name", 0), spR.ret, []);
                                sp = (nmR.ok && nmR.ret) ? (readStr(nmR.ret) || "?") : "?";
                            }
                        }
                    }
                }
            }
            catch (e3) { }
            arr.push({ comp: es, go: go, name: nm, cg: cg, img: imgRef, vanillaSpr: vanillaSpr });
            info("[v3][Credit] still #" + (idx + 1) + ": " + nm + " active=" + act + " cg=" + (cg && !cg.isNull() ? cg : "null") + " sprite=" + sp + (vanillaSpr ? " (img 已存)" : " (无 Image!)"));
        }
        var arr = [];
        if (order) {
            // 数组序: 去重 (场景同组件可能重复), 按原版顺序
            var seen = {};
            for (var oi = 0; oi < order.length; oi++) {
                var key = order[oi].toString();
                if (seen[key])
                    continue;
                seen[key] = 1;
                collectOne(order[oi], arr, arr.length);
            }
            if (arr.length) {
                comp.stills = arr;
                return arr.length;
            }
            warn("[v3][Credit] still: _stills 数组元素不可用 — 兜底场景扫+名字序");
        }
        for (var si = 0; si < all.length; si++)
            collectOne(all[si], arr, arr.length);
        arr.sort(function (a, b) {
            var na = parseInt((a.name || "").replace(/\D/g, ""), 10) || 0;
            var nb = parseInt((b.name || "").replace(/\D/g, ""), 10) || 0;
            return na - nb;
        });
        comp.stills = arr;
        return arr.length;
    }
    catch (e) {
        warn("[v3][Credit] findStills err: " + e);
        return 0;
    }
}
// ============ run-31: 自定义 stills 播放列表 (换图 + 每张时长) ============
// 时机: 纹理/Sprite 在 showStills 内 (主线程, phase1 hook) 一次性预建; 播放期 stillTick
//   (定时器线程) 只做轻量 set_sprite (与 setStillAlpha 同级 — 重量级 API 定时器线程会 int3)
function stillCfgFor(idx) {
    var conf = creditState.stillsConf;
    if (!conf || idx >= conf.length)
        return null;
    return conf[idx];
}
// Sprite.Create 5 参 (4 参 macOS 崩 — cutin 实证); pivot/ppu 继承槽位原版 sprite (失败回落 0.5/100)
function makeStillSprite(tex, texW, texH, px, py, ppu) {
    try {
        if (!tex || tex.isNull() || !texW || !texH)
            return null;
        var rect = Memory.alloc(16);
        rect.writeFloat(0);
        rect.add(4).writeFloat(0);
        rect.add(8).writeFloat(texW);
        rect.add(12).writeFloat(texH);
        var pivot = Memory.alloc(8);
        pivot.writeFloat(px);
        pivot.add(4).writeFloat(py);
        var ppuPtr = Memory.alloc(4);
        ppuPtr.writeFloat(ppu || 100);
        var createMi = A.cgm(cls.sprite, Memory.allocUtf8String("Create"), 5);
        if (!createMi || createMi.isNull()) {
            warn("[v3][Credit] still: Sprite.Create NOT FOUND");
            return null;
        }
        var extrude = Memory.alloc(4);
        extrude.writeU32(0);
        return invoke(createMi, ptr(0), [tex, rect, pivot, ppuPtr, extrude]);
    }
    catch (e) {
        warn("[v3][Credit] still makeStillSprite err: " + e);
        return null;
    }
}
// 单个文件 → Sprite (缓存 key=resolved path; null=失败不重试)。主线程调用 (引擎 API)
function loadStillSprite(path, vanillaSpr) {
    if (stillsSprCache[path] !== undefined)
        return stillsSprCache[path];
    try {
        var fb = fileReadBytes(path);
        if (!fb || fb.size <= 0) {
            warn("[v3][Credit] still 读图失败 '" + path + "' (该位原版)");
            stillsSprCache[path] = null;
            return null;
        }
        var dims = pngDims(fb);
        if (!dims) {
            warn("[v3][Credit] still PNG 尺寸读取失败 '" + path + "' (仅支持 PNG, 该位原版)");
            stillsSprCache[path] = null;
            return null;
        }
        var ent = stillsTexCache[path];
        if (!ent) {
            var byteCls = getSystemClass("Byte");
            var barr = A.an(byteCls, fb.size);
            barr.add(0x20).writeByteArray(fb.buf.readByteArray(fb.size));
            var tex = A.on(cls.texture2D); // 注意: defs 键是 texture2D (大写 D) — 小写 undefined 会 "expected a pointer"
            var wbuf = Memory.alloc(4);
            wbuf.writeS32(dims.w);
            var hbuf = Memory.alloc(4);
            hbuf.writeS32(dims.h);
            var ctorMi = A.cgm(cls.texture2D, Memory.allocUtf8String(".ctor"), 2);
            if (ctorMi && !ctorMi.isNull())
                invokeOk(ctorMi, tex, [wbuf, hbuf]);
            var liMi = A.cgm(cls.imageConversion, Memory.allocUtf8String("LoadImage"), 2);
            if (!liMi || liMi.isNull()) {
                warn("[v3][Credit] still: ImageConversion.LoadImage NOT FOUND");
                stillsSprCache[path] = null;
                return null;
            }
            var r = invokeOk(liMi, ptr(0), [tex, barr]);
            if (!r.ok) {
                warn("[v3][Credit] still LoadImage 失败 '" + path + "' (该位原版)");
                stillsSprCache[path] = null;
                return null;
            }
            ent = { tex: tex, w: dims.w, h: dims.h };
            stillsTexCache[path] = ent;
        }
        var px = 0.5, py = 0.5, ppu = 100, rw = 0, rh = 0;
        if (vanillaSpr && !vanillaSpr.isNull()) {
            try {
                var ppuMi = A.cgm(cls.sprite, Memory.allocUtf8String("get_pixelsPerUnit"), 0);
                if (ppuMi && !ppuMi.isNull()) {
                    try {
                        var ppuV = directCall(ppuMi, "float", [vanillaSpr]);
                        if (ppuV > 0)
                            ppu = ppuV;
                    }
                    catch (e3) { }
                }
                var rectMi = A.cgm(cls.sprite, Memory.allocUtf8String("get_rect"), 0);
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
                var pivMi = A.cgm(cls.sprite, Memory.allocUtf8String("get_pivot"), 0);
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
                if (!(px >= 0 && px <= 1))
                    px = 0.5;
                if (!(py >= 0 && py <= 1))
                    py = 0.5;
            }
            catch (e5) { }
        }
        var spr = makeStillSprite(ent.tex, ent.w, ent.h, px, py, ppu);
        if (!spr) {
            warn("[v3][Credit] still Sprite.Create 失败 '" + path + "' (该位原版)");
            stillsSprCache[path] = null;
            return null;
        }
        stillsSprCache[path] = spr;
        return spr;
    }
    catch (e) {
        warn("[v3][Credit] still loadStillSprite err '" + path + "': " + e);
        stillsSprCache[path] = null;
        return null;
    }
}
// 主线程预建全部自定义 sprite (showStills 内, 阻塞一次性; 12 张 ≈ 数百 ms 可接受)
function buildCustomStills() {
    var conf = creditState.stillsConf;
    if (!conf || !comp.stills || !comp.stills.length)
        return;
    var okN = 0, failN = 0;
    for (var i = 0; i < conf.length; i++) {
        var c = conf[i];
        if (!c)
            continue;
        var slot = comp.stills[i % comp.stills.length];
        var p = MOD_ROOT + "/" + wbCurrentMod + "/" + c.file;
        var spr = loadStillSprite(p, slot && slot.vanillaSpr);
        c.sprite = spr; // null → 播放期该位恢复原版 sprite
        if (spr)
            okN++;
        else
            failN++;
    }
    info("[v3][Credit] stills 预建: " + okN + " 张成功 / " + failN + " 张失败走原版 (配置 " + conf.length + " 项)");
}
// 播放期 (定时器线程, 该张 fadeIn 前) — 轻量 set_sprite (spike 验证点: 若 int3/闪烁 → 回退主线程全换+限 9)
function applyStillSprite(idx) {
    var cfg = stillCfgFor(idx);
    if (!cfg || !cfg.sprite)
        return;
    var slot = comp.stills[idx % comp.stills.length];
    if (!slot || !slot.img || slot.img.isNull())
        return;
    try {
        var setSprMi = A.cgm(cls.image, Memory.allocUtf8String("set_sprite"), 1);
        if (setSprMi && !setSprMi.isNull())
            invoke(setSprMi, slot.img, [cfg.sprite]);
        if (!cfg._applied) {
            cfg._applied = 1;
            info("[v3][Credit] still 自定义图: 第" + (idx + 1) + "张 ← " + cfg.file);
        }
    }
    catch (e) {
        warn("[v3][Credit] still set_sprite err #" + idx + ": " + e);
    }
}
// 换图后 1s re-dump 槽位 sprite 名 — 检测游戏动画覆盖回原版 (镜像 cutin scheduleSpriteReDump)
function scheduleStillReDump() {
    if (!creditState.stillsConf)
        return;
    setTimeout(function () {
        try {
            var out = [];
            for (var i = 0; i < (comp.stills || []).length; i++) {
                var st = comp.stills[i];
                var nm2 = "?";
                if (st && st.img && !st.img.isNull()) {
                    try {
                        var spR = invokeOk(cgmChain(A.ogc(st.img), "get_sprite", 0), st.img, []);
                        if (spR.ok && spR.ret && !spR.ret.isNull()) {
                            var nmR2 = invokeOk(cgmChain(A.ogc(spR.ret), "get_name", 0), spR.ret, []);
                            nm2 = (nmR2.ok && nmR2.ret) ? (readStr(nmR2.ret) || "?") : "?";
                        }
                    }
                    catch (e2) { }
                }
                out.push(i + "=" + nm2);
            }
            dbg("[v3][Credit] still 替换后1s sprite: " + out.join(" | "));
        }
        catch (e) {
            warn("[v3][Credit] still reDump err: " + e);
        }
    }, 1000);
}
function stillTick() {
    try {
        // run-31: 槽位取模 (自定义列表可超 9 张循环复用); 播放长度 = 配置长度(有 conf 时)或槽位数
        var totalN = creditState.stillsConf ? creditState.stillsConf.length : comp.stills.length;
        var st = comp.stills[comp.stillIdx % comp.stills.length];
        if (!st)
            return;
        var cfg = stillCfgFor(comp.stillIdx);
        var now = Date.now();
        var el = now - comp.stillStepStart;
        if (comp.stillState === "delay") {
            if (el >= comp.stillT.delay) {
                applyStillSprite(comp.stillIdx);
                comp.stillState = "fade";
                comp.stillStepStart = now;
                el = 0;
            }
        }
        if (comp.stillState === "fade") {
            // run-31: fade 时长分相 — 每张 fadeIn 独立 (缺省回落原版), clamp ≥ 200ms (loadCreditData 已钳)
            var fadeInMs = (cfg && cfg.fadeInMs != null) ? cfg.fadeInMs : comp.stillT.fade;
            var a = Math.min(1, el / fadeInMs);
            setStillAlpha(st, a);
            if (el >= fadeInMs) {
                comp.stillState = "display";
                comp.stillStepStart = now;
                setStillAlpha(st, 1);
            }
        }
        else if (comp.stillState === "display") {
            var dispMs = (cfg && cfg.displayMs != null) ? cfg.displayMs : comp.stillT.display;
            if (el >= dispMs) {
                // run-28: 张间不再回 delay — 原版 delay(18拍) 只对齐首张キャスト出现; 逐张 fadeout 后切换
                //   (旧: 每张都等 12.3s delay → 9×22.2=200s > phase1 119s → 后几张没播)
                comp.stillState = "fadeout";
                comp.stillStepStart = now;
            }
        }
        else if (comp.stillState === "fadeout") {
            var fadeOutMs = (cfg && cfg.fadeOutMs != null) ? cfg.fadeOutMs : comp.stillT.fade;
            var a2 = Math.max(0, 1 - el / fadeOutMs);
            setStillAlpha(st, a2);
            if (el >= fadeOutMs) {
                setStillAlpha(st, 0);
                comp.stillIdx++;
                if (comp.stillIdx >= totalN) {
                    info("[v3][Credit] still: " + comp.stillIdx + " 张播完 (末张 fadeout 收尾)");
                    comp.stillState = "done";
                    if (comp.stillTimer) {
                        clearInterval(comp.stillTimer);
                        comp.stillTimer = null;
                    }
                    return;
                }
                comp.stillT.delay = 0; // 首张后才置 0 — 张间无 delay (下轮 showStills 参数重设)
                comp.stillState = "delay";
                comp.stillStepStart = now;
            }
        }
    }
    catch (e) {
        warn("[v3][Credit] stillTick err: " + e);
        stopStills();
    }
}
function showStills(delayMs, fadeMs, displayMs) {
    try {
        if (comp.stillTimer) {
            clearInterval(comp.stillTimer);
            comp.stillTimer = null;
        }
        // run-31: 有效性检查 — 场景重载后旧指针可能失效, 失效重跑 findStills (Codex R1 #9)
        var stale = false;
        if (comp.stills && comp.stills.length) {
            for (var ci2 = 0; ci2 < comp.stills.length; ci2++) {
                if (!comp.stills[ci2].img || comp.stills[ci2].img.isNull()) {
                    stale = true;
                    break;
                }
            }
            if (stale) {
                comp.stills = [];
                dbg("[v3][Credit] still: 槽位指针失效, 重扫");
            }
        }
        if (!comp.stills || !comp.stills.length) {
            if (!findStills()) {
                warn("[v3][Credit] still: 无 EndingStill 组件 — 右侧画面跳过");
                return;
            }
        }
        // run-31: 重置 (重放防泄漏 — Codex R1 #12) + 主线程预建自定义 sprite
        comp.stillIdx = 0;
        comp.stillState = "idle";
        comp.stillStepStart = Date.now();
        buildCustomStills();
        if (delayMs !== undefined && delayMs >= 0)
            comp.stillT.delay = delayMs;
        if (fadeMs !== undefined && fadeMs > 0)
            comp.stillT.fade = fadeMs;
        if (displayMs !== undefined && displayMs > 0)
            comp.stillT.display = displayMs;
        comp.stillState = "delay";
        comp.stillStepStart = Date.now();
        comp.stillTimer = setInterval(stillTick, 50);
        var playN = creditState.stillsConf ? creditState.stillsConf.length : comp.stills.length;
        scheduleStillReDump();
        info("[v3][Credit] still: 开始播放 " + playN + " 张 (delay " + comp.stillT.delay / 1000
            + "s + fade " + comp.stillT.fade / 1000 + "s + display " + comp.stillT.display / 1000 + "s/张"
            + (creditState.stillsConf ? ", 自定义播放列表" : "") + ")");
    }
    catch (e) {
        warn("[v3][Credit] showStills err: " + e);
    }
}
// run-27: 原版时序参数 — 场景扫 CreditsDirectorAct2 (CreditsUI prefab 自带组件) 读序列化字段:
//   _scrollSpeed@0x68 float, _stillDelayUnits@0x6C, _stillFadeUnits@0x70, _stillDisplayUnits@0x74 (拍数),
//   _bgmBpm@0x30 float (CreditsDirectorBase) — 拍→秒 = units × 60/bpm
function readDirectorTiming() {
    try {
        if (comp.timing)
            return comp.timing;
        var d = (comp.director && !comp.director.isNull()) ? comp.director : null;
        if (!d) {
            var dR = findRollsStaged(cls.director, "CreditsDirectorAct2");
            for (var i = 0; i < (dR.objs || []).length && !d; i++) {
                if (dR.objs[i] && !dR.objs[i].isNull())
                    d = dR.objs[i];
            }
        }
        if (!d) {
            warn("[v3][Credit] 原版时序: 场景无 CreditsDirectorAct2 实例 — 用固定值 (speed=" + (creditState.json && creditState.json.staff ? creditState.json.staff.speed : "?") + ", fade/display fallback)");
            comp.timing = { speed: 0, delayUnits: -1, fadeUnits: -1, displayUnits: -1, bpm: 0 };
            return comp.timing;
        }
        var t = {
            speed: d.add(0x68).readFloat(),
            delayUnits: d.add(0x6C).readFloat(),
            fadeUnits: d.add(0x70).readFloat(),
            displayUnits: d.add(0x74).readFloat(),
            bpm: d.add(0x30).readFloat()
        };
        comp.timing = t;
        info("[v3][Credit] 原版时序: scrollSpeed=" + t.speed.toFixed(2) + " stillUnits(delay/fade/display)="
            + t.delayUnits.toFixed(2) + "/" + t.fadeUnits.toFixed(2) + "/" + t.displayUnits.toFixed(2) + " bpm=" + t.bpm.toFixed(2));
        return t;
    }
    catch (e) {
        warn("[v3][Credit] readDirectorTiming err: " + e);
        comp.timing = { speed: 0, delayUnits: -1, fadeUnits: -1, displayUnits: -1, bpm: 0 };
        return comp.timing;
    }
}
// run-27: キャスト 条目 (Left 首个 Roll_6) 距 Content 顶部的滚动距离 px — 布局后读 Left 容器
//   anchoredPosition.y (Label GO → transform → parent(Roll_6) → parent(Left 容器), Transform==RectTransform 同一对象)
function castLeadOffsetPx() {
    try {
        var hit = null;
        for (var i = 0; i < comp.labels.length && !hit; i++) {
            if (comp.labels[i].grand === "Left" && comp.labels[i].parent === "Roll_6")
                hit = comp.labels[i];
        }
        if (!hit || !hit.go || hit.go.isNull())
            return null;
        var tR = invokeOk(cgmChain(A.ogc(hit.go), "get_transform", 0), hit.go, []);
        if (!tR.ok || !tR.ret || tR.ret.isNull())
            return null;
        var pR = invokeOk(cgmChain(A.ogc(tR.ret), "get_parent", 0), tR.ret, []);
        if (!pR.ok || !pR.ret || pR.ret.isNull())
            return null;
        var pR2 = invokeOk(cgmChain(A.ogc(pR.ret), "get_parent", 0), pR.ret, []);
        if (!pR2.ok || !pR2.ret || pR2.ret.isNull())
            return null;
        var apR = invokeOk(cgmChain(A.ogc(pR2.ret), "get_anchoredPosition", 0), pR2.ret, []);
        if (!apR.ok || !apR.ret || apR.ret.isNull())
            return null;
        var y = apR.ret.add(4).readFloat();
        info("[v3][Credit] キャスト Left 容器 anchoredPosition y=" + y.toFixed(0) + " → 滚动距离 " + (-y).toFixed(0) + "px");
        return -y;
    }
    catch (e) {
        warn("[v3][Credit] castLeadOffsetPx err: " + e);
        return null;
    }
}
// run-31: 恢复每槽位原版 sprite (只做加法+自清理 — Codex R1 #5); set_sprite 轻量, 与 setStillAlpha 同级
function restoreStillSprites() {
    for (var i = 0; i < (comp.stills || []).length; i++) {
        var st = comp.stills[i];
        if (!st || !st.img || st.img.isNull() || !st.vanillaSpr || st.vanillaSpr.isNull())
            continue;
        try {
            var setSprMi = A.cgm(cls.image, Memory.allocUtf8String("set_sprite"), 1);
            if (setSprMi && !setSprMi.isNull())
                invoke(setSprMi, st.img, [st.vanillaSpr]);
        }
        catch (e) { }
    }
}
// run-31: 清自定义 sprite/纹理缓存 (置空 JS 引用 → Unity GC 回收纹理) — 仅 doEnd/abortCredit 调
function clearStillCaches() {
    stillsSprCache = {};
    stillsTexCache = {};
}
function stopStills() {
    try {
        if (comp.stillTimer) {
            clearInterval(comp.stillTimer);
            comp.stillTimer = null;
        }
        for (var i = 0; i < (comp.stills || []).length; i++)
            setStillAlpha(comp.stills[i], 0);
        restoreStillSprites();
        comp.stillState = "idle";
    }
    catch (e) { }
}
// ============ phase=1: staff 滚动 ============
function doStaff() {
    try {
        if (!creditState.armed) {
            writeVar("g_staffDuration", 3);
            return;
        } // 未 arm (存档回放防御): 安全时长跳过
        if (!ensureScroll()) {
            warn("[v3][Credit] phase=1 跳过: rollScroll 未捕获/失效 (见上方捕获诊断)");
            writeVar("g_staffDuration", 3);
            return;
        }
        var lines = staffLinesForLocale();
        var hasItems = !!(creditState.json && creditState.json.staff && Array.isArray(creditState.json.staff.items) && creditState.json.staff.items.length);
        if (!lines.length && !hasItems) {
            warn("[v3][Credit] phase=1 跳过: json.staff 无可用语种内容");
            writeVar("g_staffDuration", 3);
            return;
        }
        // run-27: 速度优先用原版 director._scrollSpeed (序列化配置), 无则 data.json speed, 再兜底 60
        var timing = readDirectorTiming();
        var speed = (timing && timing.speed > 0) ? timing.speed
            : ((creditState.json.staff && creditState.json.staff.speed > 0) ? creditState.json.staff.speed : 60);
        var endPause = (creditState.json.staff && creditState.json.staff.endPause >= 0) ? creditState.json.staff.endPause : 2;
        var ks = A.ogc(comp.rollScroll);
        // 1. 启用 (F1): roll 自身 + 祖先链
        invoke(cgmChain(ks, "SetGameObjectActive", 1), comp.rollScroll, [boolPtr(true)]);
        invoke(cgmChain(ks, "SetCanvasEnabled", 1), comp.rollScroll, [boolPtr(true)]);
        ensureHierarchy();
        ensureCanvasRenderable(); // run-10: sortingOrder 抬高 + 相机兜底 (alpha=1 后仍不可见的嫌疑)
        var cb = dcBool(cgmChain(A.ogc(comp.canvas), "get_isActiveAndEnabled", 0), comp.canvas);
        // 2. 标签填充 (run-11 重写): zh-Hans 时按标签名识别当前语种标签 → 只填它, 其余停用+清空
        //   (run-10 实证: prefab 默认 3 标签全 active → 全填 = 3 份文本叠印/错位 = "字的位置有问题"根因;
        //   原版只激活当前语种标签)。识别失败回退全填 (保持原行为)。
        if (!comp.labels.length)
            enumerateLabels();
        if (!comp.labels.length) {
            warn("[v3][Credit] phase=1 跳过: content 下无 TMP 标签");
            writeVar("g_staffDuration", 3);
            return;
        }
        var text = lines.join("\n");
        var isZh = getCurrentLocale() === "zh-Hans";
        // run-26: 逐条目复刻 — data.json staff.items [{key,text}] → 按 key 匹配填充各条目标签
        //   (原版演出 = Content 下 222 个条目标签各填各的静态文本, 整体滚动 — 不再整段全填叠印。
        //   key = "{grand}|{entry}|{suffix}": grand=Content 直接子级, entry=条目容器, suffix=Label 名后缀
        //   (Label→'', Label_1→'_1') — 与 build_credit_data.py label_suffix 同一规则)
        var itemMap = null;
        if (creditState.json && creditState.json.staff && Array.isArray(creditState.json.staff.items) && creditState.json.staff.items.length) {
            itemMap = {};
            for (var mi = 0; mi < creditState.json.staff.items.length; mi++) {
                var it = creditState.json.staff.items[mi];
                if (it && it.key !== undefined)
                    itemMap[it.key] = it.text;
            }
            info("[v3][Credit] staff 逐条目模式: " + creditState.json.staff.items.length + " 条 key 映射");
        }
        else {
            warn("[v3][Credit] staff 非 items 格式 — 回退旧单标签模式 (需 fillIdx)");
        }
        var fillIdx = -1;
        if (!itemMap && isZh) {
            for (var i = 0; i < comp.labels.length; i++) {
                var ln = ((comp.labels[i].name || "") + "|" + (comp.labels[i].parent || "")).toLowerCase();
                if (ln.indexOf("zh") >= 0 || ln.indexOf("han") >= 0 || ln.indexOf("chinese") >= 0 || ln.indexOf("简") >= 0 || ln.indexOf("中") >= 0) {
                    fillIdx = i;
                    break;
                }
            }
            if (fillIdx < 0) {
                // run-14: 名字/父名均无语种标识 (run-13 实证 Label/Roll_49,Label/Name_50,Label/Name_34) —
                // 不再回退全填 (3 份叠印根因), 顺序假设 prefab 标签槽 = [Ja, ZhHans, En] → zh=index 1。
                // 风险: 槽顺序未知 — 同时打颜色/位置诊断 (见下), 若假设错按诊断校准。
                if (comp.labels.length === 3) {
                    fillIdx = 1;
                    warn("[v3][Credit] zh-Hans staff 标签顺序假设 [Ja,ZhHans,En] → 只填 #1 (run-13: 名字/父名无语种标识; 诊断见下)");
                }
                else {
                    warn("[v3][Credit] zh-Hans 但 staff 标签名无法识别语种 且标签数=" + comp.labels.length + " ≠3 — 回退全填 (标签名+父: " + comp.labels.map(function (l) { return (l.name || "?") + "/" + (l.parent || "?"); }).join(",") + ")");
                }
            }
        }
        // run-14: 语种/位置诊断 — 每个标签 TMP get_color (HFA 16B, invoke 缓冲直读) + RectTransform anchoredPosition
        //   用途: 校准顺序假设 + 复刻原版排版 (颜色差异=prefab 槽配置 [A,B,B])
        {
            var colorInfo = [], posInfo = [];
            for (var di = 0; di < comp.labels.length; di++) {
                try {
                    var tmpD = comp.labels[di].tmp;
                    var colMi = cgmChain(A.ogc(tmpD), "get_color", 0);
                    var colR = invokeOk(colMi, tmpD, []);
                    if (colR.ok && colR.ret && !colR.ret.isNull()) {
                        colorInfo.push("#" + di + "=(" + colR.ret.readFloat().toFixed(2) + "," + colR.ret.add(4).readFloat().toFixed(2) + "," + colR.ret.add(8).readFloat().toFixed(2) + "," + colR.ret.add(12).readFloat().toFixed(2) + ")");
                    }
                    else
                        colorInfo.push("#" + di + "=?");
                    var rtMi = cgmChain(A.ogc(tmpD), "get_rectTransform", 0);
                    var rtR = invokeOk(rtMi, tmpD, []);
                    if (rtR.ok && rtR.ret && !rtR.ret.isNull()) {
                        var apMi = cgmChain(A.ogc(rtR.ret), "get_anchoredPosition", 0);
                        var apR = invokeOk(apMi, rtR.ret, []);
                        if (apR.ok && apR.ret && !apR.ret.isNull()) {
                            posInfo.push("#" + di + "=(" + apR.ret.readFloat().toFixed(1) + "," + apR.ret.add(4).readFloat().toFixed(1) + ")");
                        }
                        else
                            posInfo.push("#" + di + "=?");
                    }
                }
                catch (e) { }
            }
            dbg("[v3][Credit] staff 标签诊断 color[" + colorInfo.join(" | ") + "] pos[" + posInfo.join(" | ") + "]");
        }
        // run-14: 字体换装来源改"完整简中动态字体" — run-13 实证 SpecialThanks_ZhHans 是静态子集字体
        //   (只含原版 zh 致谢文本字符 → "自动化"→"自化"、剧本全没、魔女裁判 MOD 制作→魔女 MOD; 缺字空白不渲染);
        //   TsukushiMincho 是动态字体但无简中字形 (缺字 □)。遍历全部 TMP_FontAsset 资产,
        //   名字启发式: 排除 tsukushi/specialthanks, 命中 noto|source.?han|heiti|songti|pingfang|hiragino|思源|黑体|宋体|简 选第一个。
        var zhFont = null;
        if (isZh) {
            if (!cls.tmpFontAsset || cls.tmpFontAsset.isNull())
                cls.tmpFontAsset = findClassAcrossImages("TMPro", "TMP_FontAsset");
            if (cls.tmpFontAsset && !cls.tmpFontAsset.isNull()) {
                try {
                    var allF = findAllObjectOfType(cls.tmpFontAsset);
                    var namesF = [], pickedF = null, pickedNameF = null;
                    for (var fi = 0; fi < allF.length; fi++) {
                        var fnR = invokeOk(cgmChain(A.ogc(allF[fi]), "get_name", 0), allF[fi], []);
                        var fnm = (fnR.ok && fnR.ret && !fnR.ret.isNull()) ? (readStr(fnR.ret) || "?") : "?";
                        namesF.push(fnm);
                        var low = fnm.toLowerCase();
                        if (low.indexOf("tsukushi") >= 0 || low.indexOf("specialthanks") >= 0)
                            continue;
                        if (/(noto|source.?han|heiti|songti|pingfang|hiragino|思源|黑体|宋体|简)/.test(low) && !pickedF) {
                            pickedF = allF[fi];
                            pickedNameF = fnm;
                        }
                    }
                    info("[v3][Credit] TMP_FontAsset 资产 " + allF.length + " 个: " + namesF.join(", "));
                    if (pickedF) {
                        zhFont = pickedF;
                        info("[v3][Credit] zh 字体选中: " + pickedNameF);
                    }
                    else
                        warn("[v3][Credit] 完整简中字体未找到 (名单见上) — 回退 thanks zh 标签字体");
                }
                catch (e) {
                    warn("[v3][Credit] 字体资产枚举 err: " + e);
                }
            }
            if (!zhFont) {
                // 兜底: thanks zh 标签的字体 (静态子集, 可能缺字 — 但比 TsukushiMincho 强)
                if (!comp.thanksByLocale || !Object.keys(comp.thanksByLocale).length) {
                    ensureThanks();
                    enumerateThanksLabels();
                }
                var zl = comp.thanksByLocale ? comp.thanksByLocale[2] : null;
                if (zl && zl.tmp) {
                    var zf = invokeOk(cgmChain(A.ogc(zl.tmp), "get_font", 0), zl.tmp, []);
                    if (zf.ok && zf.ret && !zf.ret.isNull())
                        zhFont = zf.ret;
                }
                if (zhFont)
                    warn("[v3][Credit] zh 字体回退: SpecialThanks_ZhHans (静态子集, 可能缺字)");
                else
                    warn("[v3][Credit] zh 字体偷取失败 (thanks zh 标签不可得) — staff 保持原字体");
            }
        }
        var setT = cgmChain(A.ogc(comp.labels[0].tmp), "set_text", 1);
        var setF = isZh ? cgmChain(A.ogc(comp.labels[0].tmp), "set_font", 1) : null;
        var filled = 0, cleared = 0, matchedCount = 0, swappedCount = 0;
        deactivatedLabels = [];
        for (var i = 0; i < comp.labels.length; i++) {
            var lb = comp.labels[i];
            var fillText = null;
            if (itemMap) {
                // run-26: 逐条目 key 匹配 (grand|entry|suffix) — 命中填该条目标签的静态文本, 未命中清空+停用
                var key = (lb.grand || "") + "|" + (lb.parent || "") + "|" + labelSuffix(lb.name);
                if (itemMap[key] !== undefined) {
                    fillText = itemMap[key];
                    matchedCount++;
                }
            }
            else {
                // 回退: 旧单标签模式
                if (fillIdx >= 0 ? (i === fillIdx) : lb.active)
                    fillText = text;
            }
            var r = invokeOk(setT, lb.tmp, [makeS(fillText !== null ? fillText : "")]);
            if (fillText !== null) {
                filled++;
                if (zhFont && setF) {
                    var fr = invokeOk(setF, lb.tmp, [zhFont]);
                    if (!fr.ok)
                        warn("[v3][Credit] set_font #" + i + " FAIL");
                    else
                        swappedCount++; // 逐条换装不再打日志 (222 条刷屏) — 循环后汇总
                }
                else if (isZh && lb.font && lb.font.indexOf("Tsukushi") >= 0) {
                    warn("[v3][Credit] zh-Hans 文本写入标签 #" + i + " 但字体=" + lb.font + " (TsukushiMincho 无简中字形 → 可能显示 □)");
                }
                if (lb.go && !lb.active) {
                    invoke(cgmChain(A.ogc(lb.go), "SetActive", 1), lb.go, [boolPtr(true)]);
                }
            }
            else {
                cleared++;
                if (lb.go && lb.active) {
                    invoke(cgmChain(A.ogc(lb.go), "SetActive", 1), lb.go, [boolPtr(false)]);
                    deactivatedLabels.push(lb.go);
                }
            }
            if (!r.ok)
                warn("[v3][Credit] set_text #" + i + " FAIL");
        }
        info("[v3][Credit] staff 文本写入: " + filled + " 填 / " + cleared + " 清 (items 匹配 " + matchedCount + "/" + (itemMap ? Object.keys(itemMap).length : 0) + ", 标签 " + comp.labels.length + " 个, 字体换装 " + swappedCount + " 个, speed=" + speed + ", canvas active=" + cb + ")");
        // 3. 同步强制布局 (N1): set_text 只标记 MarkLayoutForRebuild
        invoke(cgmChain(cls.layoutRebuilder, "ForceRebuildLayoutImmediate", 1), ptr(0), [comp.content]);
        invoke(cgmChain(cls.canvas, "ForceUpdateCanvases", 0), ptr(0), []);
        // 4. 位置归零 (R2/N2): 优先 setter
        invoke(A.cgm(cls.scrollRect, Memory.allocUtf8String("set_verticalNormalizedPosition"), 1), comp.scrollRect, [fPtr(1.0)]);
        // run-27: still 时序 — 布局强制后 (anchoredPosition 才有效)。原版锚点 = 硬编码 delayUnits 拍数
        //   (实读: delay=18拍 → 18×60/88 ≈ 12.3s — 正是 Full 大条目滚完、キャスト 出现的时间);
        //   キャスト 偏移 (Left 容器 y/speed) 作校验日志, 取 max 兜底 (キャスト 未出现前不显示图)
        var castOff = castLeadOffsetPx();
        var castDelayMs = (castOff && castOff > 0) ? (castOff / speed * 1000) : 0;
        var fadeMs = 2000, dispMs = 26000, unitsDelayMs = 0;
        if (timing && timing.bpm > 0) {
            var beat = 60 / timing.bpm;
            if (timing.delayUnits >= 0)
                unitsDelayMs = timing.delayUnits * beat * 1000;
            if (timing.fadeUnits >= 0)
                fadeMs = Math.max(200, timing.fadeUnits * beat * 1000);
            if (timing.displayUnits >= 0)
                dispMs = Math.max(1000, timing.displayUnits * beat * 1000);
        }
        var stillDelayMs = Math.max(unitsDelayMs, castDelayMs, 1000);
        info("[v3][Credit] still 时序: units delay=" + (unitsDelayMs / 1000).toFixed(1) + "s キャスト="
            + (castDelayMs / 1000).toFixed(1) + "s → 取 " + (stillDelayMs / 1000).toFixed(1)
            + "s, fade " + (fadeMs / 1000).toFixed(1) + "s display " + (dispMs / 1000).toFixed(1)
            + "s (bpm=" + (timing && timing.bpm ? timing.bpm.toFixed(1) : "?") + ")");
        showStills(stillDelayMs, fadeMs, dispMs);
        // 5. 高度断言 (N1)
        var h = dcFloat(cgmChain(ks, "get_ContentHeight", 0), comp.rollScroll);
        if (!(h > 0)) {
            warn("[v3][Credit] phase=1 跳过: content 高度=" + h + " (布局未生效?)");
            writeVar("g_staffDuration", 3);
            return;
        }
        if (h > 60000)
            warn("[v3][Credit] content 高度异常大 (" + h.toFixed(0) + "px) — 远超原版规格 ~29.5k, 可能残留叠印文本");
        // 6. 时长单一来源 (F2/R3): duration=高度/speed; g_staffDuration=滚动+endPause
        var dur = h / speed;
        var total = dur + endPause;
        writeVar("g_staffDuration", total);
        info("[v3][Credit] staff: 高度=" + h.toFixed(0) + "px duration=" + dur.toFixed(1) + "s g_staffDuration=" + total.toFixed(1) + "s");
        // 7. ScrollAsync fire-and-forget (F8: default token, UniTask 丢弃)
        var saMi = A.cgm(ks, Memory.allocUtf8String("ScrollAsync"), 2);
        var sr = invokeOk(saMi, comp.rollScroll, [fPtr(dur), zeroCT()]);
        if (!sr.ok)
            warn("[v3][Credit] ScrollAsync FAIL");
        else
            info("[v3][Credit] ScrollAsync invoke OK");
    }
    catch (e) {
        error("[v3][Credit] doStaff err: " + e);
        writeVar("g_staffDuration", 3);
    }
}
// ============ phase=2 (原版复刻模式): 直接调原版 CreditsUI.PlayAsync(2) ============
// run-15: 原版 @credit 2 全链路复刻 (dump.cs 实证):
//   nani "@credit 2" → ShowCreditsUi{ActNumber=2, Wait} (CommandAlias("credit"), dump.cs:477868)
//     → Execute → CreditsUI.PlayAsync(act=2, AsyncToken) (dump.cs:481423 Slot 96)
//     → _creditsDirectors[2] (CreditsDirectorAct2) → 遍历 _creditRolls 逐个 ScrollAsync/ShowAsync
//     → 播完 goto EndLabelName (# EndCredits2) — NaniScriptPlayer
//   AsyncToken = {CancellationToken@0x0, CancellationToken@0x8} (32B 结构体, dump.cs:142681);
//   全零 = CancellationToken.None ×2 (永不取消) — 与 op_Implicit(CancellationToken.None) 语义一致
// run-23: 主线程 PlayAsync 泵 — pendingPlay 由 doOriginal 设置 (Preload 后挂起),
//   onSVV (g_creditTick) 在主线程同步 hook 里检查资产填充 → doPlayAsyncInvoke 完成 PlayAsync
// ============ 素材提取 (run-24): 原版致谢素材 → mod 文件夹 (TestCredit/Assets/) ============
//   trigger "extract" → doOriginal 全流程 (Preload+Play) → doPlayAsyncInvoke 成功后 extractStep()
//   (PlayAsync 后仍在主线程同步 hook 内, 所有 invoke 安全) → 写出:
//     Assets/stills/still{i}.png   原版 EndingStill 图片 (Sprite → Texture2D → GetPixels32 → PNG)
//     Assets/credit-assets.json    specialthanks 名单 + staff 当前屏快照 + stills 时序参数
//     Assets/staff.json            staff 完整滚动文本 (hook TMP set_text 全演出期收集 — run-24-4:
//                                  滚动块每屏复用 TMP, 任意时刻只能抓到当前屏, 必须全程收集)
//[run-25-废弃] var staffHookAttached = false;
//[run-25-废弃] var collectedStaff = [];
//[run-25-废弃] var staffSeen = {};
//[run-25-废弃] var fullTexCache = {};   // run-24-5: atlas 全图缓存 (tex指针 → {w,h,rgba}) — 多张 still 共享纹理, 只读一次
//[run-25-废弃] var staffPollTimer = null;   // run-24-6: 轮询兜底 — 文本无论如何设置 (set_text/SetText/字段直写),
//[run-25-废弃] var staffPollTmps = [];      //   滚动块 TMP 的 m_text@0xE0 字段最终必然有值 → 采样收集兜底
//[run-25-废弃] var staffPolling = false;
//[run-25-废弃] function installStaffHook() {
//[run-25-废弃]     try {
//[run-25-废弃]         if (staffHookAttached) return;
//[run-25-废弃]         // run-24-6: 双 hook — set_text (property setter, virtual) + SetText(string) (非 virtual 直调)。
//[run-25-废弃]         //   上一轮 set_text 零捕获 → 滚动块文本可能直接走 SetText(string); 去重由 staffSeen 保证。
//[run-25-废弃]         var hookFns = [];
//[run-25-废弃]         var mi = null;
//[run-25-废弃]         if (cls.tmpText && !cls.tmpText.isNull()) mi = A.cgm(cls.tmpText, Memory.allocUtf8String("set_text"), 1);
//[run-25-废弃]         if (!mi || mi.isNull()) {
//[run-25-废弃]             try {
//[run-25-废弃]                 var uguiCls = findClassAcrossImages("TMPro", "TextMeshProUGUI");
//[run-25-废弃]                 if (uguiCls && !uguiCls.isNull()) mi = A.cgm(uguiCls, Memory.allocUtf8String("set_text"), 1);
//[run-25-废弃]             } catch (e) {}
//[run-25-废弃]         }
//[run-25-废弃]         var mi2 = null;
//[run-25-废弃]         if (cls.tmpText && !cls.tmpText.isNull()) mi2 = A.cgm(cls.tmpText, Memory.allocUtf8String("SetText"), 1);
//[run-25-废弃]         if (!mi2 || mi2.isNull()) {
//[run-25-废弃]             try {
//[run-25-废弃]                 var ugui2 = findClassAcrossImages("TMPro", "TextMeshProUGUI");
//[run-25-废弃]                 if (ugui2 && !ugui2.isNull()) mi2 = A.cgm(ugui2, Memory.allocUtf8String("SetText"), 1);
//[run-25-废弃]             } catch (e) {}
//[run-25-废弃]         }
//[run-25-废弃]         var onEnterFn = function (a) {
//[run-25-废弃]             try {
//[run-25-废弃]                 var s = readStr(a[1]);   // a[0]=this TMP, a[1]=string*
//[run-25-废弃]                 if (!s || s.length < 2 || s.length > 500) return;
//[run-25-废弃]                 var key = a[0].toString() + "|" + s;   // 按组件+文本去重 (滚动复用同一 TMP 多屏文本都收)
//[run-25-废弃]                 if (staffSeen[key]) return;
//[run-25-废弃]                 staffSeen[key] = true;
//[run-25-废弃]                 collectedStaff.push({ go: a[0].toString(), text: s });
//[run-25-废弃]             } catch (e2) {}
//[run-25-废弃]         };
//[run-25-废弃]         if (mi && !mi.isNull() && !mi.readPointer().isNull()) {
//[run-25-废弃]             Interceptor.attach(mi.readPointer(), { onEnter: onEnterFn });
//[run-25-废弃]             hookFns.push("set_text");
//[run-25-废弃]         }
//[run-25-废弃]         if (mi2 && !mi2.isNull() && !mi2.readPointer().isNull()) {
//[run-25-废弃]             Interceptor.attach(mi2.readPointer(), { onEnter: onEnterFn });
//[run-25-废弃]             hookFns.push("SetText");
//[run-25-废弃]         }
//[run-25-废弃]         if (!hookFns.length) { warn("[v3][Credit] staff hook: TMP set_text/SetText 均 NOT FOUND"); return; }
//[run-25-废弃]         staffHookAttached = true;
//[run-25-废弃]         info("[v3][Credit] staff hook 已挂 (TMP " + hookFns.join("+") + " 全演出期收集)");
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] installStaffHook err: " + e); }
//[run-25-废弃] }
//[run-25-废弃] function flushStaffJson() {
//[run-25-废弃]     try {
//[run-25-废弃]         if (!creditState.extract || !creditState.original) return;
//[run-25-废弃]         if (staffPollTimer) { clearInterval(staffPollTimer); staffPollTimer = null; }   // run-24-6: 停轮询再落盘
//[run-25-废弃]         if (!collectedStaff.length) { warn("[v3][Credit] staff 收集为空 — hook 零捕获且轮询零采样 (或演出异常)"); return; }
//[run-25-废弃]         writeFileBytes(extractOutRoot() + "/staff.json", new Uint8Array(utf8Bytes(JSON.stringify(collectedStaff, null, 1))));
//[run-25-废弃]         info("[v3][Credit] staff.json 已写出 (" + collectedStaff.length + " 条文本)");
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] flushStaffJson err: " + e); }
//[run-25-废弃] }
//[run-25-废弃] // run-24-6: staff 轮询兜底 — 主线程 (extractStep 内) 缓存滚动块全部 TMP 组件指针,
//[run-25-废弃] //   JS 线程 300ms 采样 m_text@0xE0 (TMP_Text 受保护字段, dump.cs 实证) — 纯内存读零 Unity API,
//[run-25-废弃] //   任何设置路径 (set_text/SetText/字段直写) 最终都体现在 m_text 字段 → 采样必得。
//[run-25-废弃] //   组件被回收/销毁 → 读崩 → try/catch 跳过 (不崩游戏)。
//[run-25-废弃] function installStaffPoll() {
//[run-25-废弃]     try {
//[run-25-废弃]         if (staffPolling || !comp.director || comp.director.isNull()) return;
//[run-25-废弃]         var d = comp.director;
//[run-25-废弃]         var rolls = d.add(0x60).readPointer();
//[run-25-废弃]         if (!rolls || rolls.isNull()) return;
//[run-25-废弃]         var n = rolls.add(0x18).readS32();
//[run-25-废弃]         if (n < 1 || n > 50) return;
//[run-25-废弃]         var list = [];
//[run-25-废弃]         for (var i = 0; i < n; i++) {
//[run-25-废弃]             var roll = rolls.add(0x20 + i * 8).readPointer();
//[run-25-废弃]             if (!roll || roll.isNull()) continue;
//[run-25-废弃]             var goR = invokeOk(cgmChain(A.ogc(roll), "get_gameObject", 0), roll, []);
//[run-25-废弃]             if (!goR.ok || !goR.ret || goR.ret.isNull()) continue;
//[run-25-废弃]             var comps = invokeOk(cgmChain(A.ogc(goR.ret), "GetComponentsInChildren", 2), goR.ret, [A.tgo(A.cgt(cls.tmpText)), boolPtr(true)]);
//[run-25-废弃]             if (!comps.ok || !comps.ret || comps.ret.isNull()) continue;
//[run-25-废弃]             var clen = comps.ret.add(0x18).readS32();
//[run-25-废弃]             for (var ci = 0; ci < clen && ci < 64; ci++) {
//[run-25-废弃]                 var t = comps.ret.add(0x20 + ci * 8).readPointer();
//[run-25-废弃]                 if (t && !t.isNull()) list.push(t);
//[run-25-废弃]             }
//[run-25-废弃]         }
//[run-25-废弃]         if (!list.length) { warn("[v3][Credit] staffPoll: 未找到滚动 TMP 组件"); return; }
//[run-25-废弃]         staffPollTmps = list;
//[run-25-废弃]         staffPolling = true;
//[run-25-废弃]         info("[v3][Credit] staffPoll 已启动 (" + list.length + " 个 TMP 组件, 300ms 采样 m_text)");
//[run-25-废弃]         staffPollTimer = setInterval(function () {
//[run-25-废弃]             try {
//[run-25-废弃]                 for (var i = 0; i < staffPollTmps.length; i++) {
//[run-25-废弃]                     var t = staffPollTmps[i];
//[run-25-废弃]                     if (!t || t.isNull()) continue;
//[run-25-废弃]                     var s = readStr(t.add(0xE0).readPointer());
//[run-25-废弃]                     if (!s || s.length < 2 || s.length > 500) continue;
//[run-25-废弃]                     var key = t.toString() + "|" + s;
//[run-25-废弃]                     if (staffSeen[key]) continue;
//[run-25-废弃]                     staffSeen[key] = true;
//[run-25-废弃]                     collectedStaff.push({ go: t.toString(), text: s });
//[run-25-废弃]                 }
//[run-25-废弃]             } catch (e) {}
//[run-25-废弃]         }, 300);
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] installStaffPoll err: " + e); }
//[run-25-废弃] }
//[run-25-废弃] function extractOutRoot() {
//[run-25-废弃]     try {
//[run-25-废弃]         var root = (typeof MOD_ROOT !== "undefined" && MOD_ROOT) ? MOD_ROOT : null;
//[run-25-废弃]         if (root) return root + "/TestCredit/Assets";
//[run-25-废弃]         var p = Process.mainModule.path;   // 兜底: 从二进制路径推导 Steam 游戏目录
//[run-25-废弃]         return p.replace(/\/manosaba\.app.*$/, "").replace(/\/[^\/]+$/, "") + "/ManosabaMod/TestCredit/Assets";
//[run-25-废弃]     } catch (e) { return "/tmp/manosaba-credit-extract"; }
//[run-25-废弃] }
//[run-25-废弃] function mkdirs(path) {
//[run-25-废弃]     try {
//[run-25-废弃]         // run-24-2: 用 findGlobalExportByName (io.js 实证可用; findExportByName 在 bundle 内被遮蔽报 TypeError)
//[run-25-废弃]         var mk = new NativeFunction(Module.findGlobalExportByName("mkdir"), "int", ["pointer", "int"]);
//[run-25-废弃]         var parts = path.split("/");
//[run-25-废弃]         var cur = path[0] === "/" ? "/" : "";
//[run-25-废弃]         for (var i = 0; i < parts.length; i++) {
//[run-25-废弃]             if (!parts[i]) continue;
//[run-25-废弃]             cur += parts[i];
//[run-25-废弃]             mk(Memory.allocUtf8String(cur), 0x1ED);   // 0755; 已存在 EEXIST 无害
//[run-25-废弃]             cur += "/";
//[run-25-废弃]         }
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] mkdirs err: " + e); }
//[run-25-废弃] }
//[run-25-废弃] function writeFileBytes(path, u8) {
//[run-25-废弃]     try {
//[run-25-废弃]         // run-24-2: 裸字节写走 io.js getIO (open/write/close 系统调用绑定, Darwin flags 同 openForWrite)
//[run-25-废弃]         var io = getIO();
//[run-25-废弃]         if (!io || !io.open || !io.write || !io.close) { warn("[v3][Credit] writeFileBytes: io 不可用"); return false; }
//[run-25-废弃]         var fd = io.open(Memory.allocUtf8String(path), 0x0001 | 0x0200 | 0x0400, 0o644);   // O_WRONLY|O_CREAT|O_TRUNC
//[run-25-废弃]         if (fd < 0) { warn("[v3][Credit] 写入失败 (open): " + path); return false; }
//[run-25-废弃]         var buf = Memory.alloc(u8.length);
//[run-25-废弃]         buf.writeByteArray(u8);
//[run-25-废弃]         var got = 0, r = 0;
//[run-25-废弃]         while (got < u8.length) {
//[run-25-废弃]             r = io.write(fd, buf.add(got), u8.length - got);   // 部分写入循环, r<=0 兜底
//[run-25-废弃]             if (r <= 0) break;
//[run-25-废弃]             got += r;
//[run-25-废弃]         }
//[run-25-废弃]         io.close(fd);
//[run-25-废弃]         // run-24-7: 实测 open mode 参数落盘权限异常 (0o644 → 0o350, 连 owner 都不可读) —
//[run-25-废弃]         //   chmod 硬补 0644, 保证 IDE/用户可读 (staff.json NoPermissions 根因)
//[run-25-废弃]         try {
//[run-25-废弃]             var ch = Module.findGlobalExportByName("chmod");
//[run-25-废弃]             if (ch) new NativeFunction(ch, "int", ["pointer", "int"])(Memory.allocUtf8String(path), 0o644);
//[run-25-废弃]         } catch (e2) { warn("[v3][Credit] chmod err: " + e2); }
//[run-25-废弃]         info("[v3][Credit] 已写出: " + path + " (" + got + "/" + u8.length + "B)");
//[run-25-废弃]         return got >= u8.length;
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] writeFileBytes err: " + e); return false; }
//[run-25-废弃] }
//[run-25-废弃] function utf8Bytes(s) {
//[run-25-废弃]     var out = [];
//[run-25-废弃]     for (var i = 0; i < s.length; i++) {
//[run-25-废弃]         var c = s.charCodeAt(i);
//[run-25-废弃]         if (c < 0x80) out.push(c);
//[run-25-废弃]         else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
//[run-25-废弃]         else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF) {
//[run-25-废弃]             var cp = 0x10000 + ((c - 0xD800) << 10) + (s.charCodeAt(i + 1) - 0xDC00);
//[run-25-废弃]             out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F)); i++;
//[run-25-废弃]         } else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
//[run-25-废弃]     }
//[run-25-废弃]     return out;
//[run-25-废弃] }
//[run-25-废弃] // PNG 编码 (RGBA8 → stored-deflate zlib, 无依赖纯 JS) — 返回 Uint8Array
//[run-25-废弃] function pngEncodeRGBA(w, h, rgba) {
//[run-25-废弃]     var crcT = new Int32Array(256);
//[run-25-废弃]     for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); crcT[n] = c; }
//[run-25-废弃]     function crc32(b, off, len) { var c = 0xFFFFFFFF; for (var i = 0; i < len; i++) c = crcT[(c ^ b[off + i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
//[run-25-废弃]     function adler32(b, off, len) { var a = 1, d = 0; for (var i = 0; i < len; i++) { a = (a + b[off + i]) % 65521; d = (d + a) % 65521; } return ((d << 16) | a) >>> 0; }
//[run-25-废弃]     // 行过滤字节 + 垂直翻转 (GetPixels32 底部行优先 → PNG 顶部行优先)
//[run-25-废弃]     var stride = 1 + w * 4;
//[run-25-废弃]     var raw = new Uint8Array(stride * h);
//[run-25-废弃]     for (var y = 0; y < h; y++) {
//[run-25-废弃]         var src = (h - 1 - y) * w * 4, rOff = y * stride;
//[run-25-废弃]         raw[rOff] = 0;
//[run-25-废弃]         raw.set(rgba.subarray(src, src + w * 4), rOff + 1);
//[run-25-废弃]     }
//[run-25-废弃]     // stored deflate (0x78 0x01): 64KB 分块, 每块 5B 头
//[run-25-废弃]     var chunks = Math.ceil(raw.length / 65535);
//[run-25-废弃]     var idat = new Uint8Array(2 + chunks * 5 + raw.length + 4);
//[run-25-废弃]     idat[0] = 0x78; idat[1] = 0x01;
//[run-25-废弃]     var o = 2, pos = 0;
//[run-25-废弃]     for (var c = 0; c < chunks; c++) {
//[run-25-废弃]         var ln = Math.min(65535, raw.length - pos);
//[run-25-废弃]         var fin = (pos + ln >= raw.length) ? 1 : 0;
//[run-25-废弃]         idat[o++] = fin; idat[o++] = ln & 0xFF; idat[o++] = (ln >> 8) & 0xFF;
//[run-25-废弃]         idat[o++] = (~ln) & 0xFF; idat[o++] = ((~ln) >> 8) & 0xFF;
//[run-25-废弃]         idat.set(raw.subarray(pos, pos + ln), o); o += ln; pos += ln;
//[run-25-废弃]     }
//[run-25-废弃]     var ad = adler32(raw, 0, raw.length);
//[run-25-废弃]     idat[o++] = (ad >> 24) & 0xFF; idat[o++] = (ad >> 16) & 0xFF; idat[o++] = (ad >> 8) & 0xFF; idat[o] = ad & 0xFF;
//[run-25-废弃]     function chunk(type, data) {
//[run-25-废弃]         var b = new Uint8Array(12 + data.length);
//[run-25-废弃]         b[0] = (data.length >> 24) & 0xFF; b[1] = (data.length >> 16) & 0xFF; b[2] = (data.length >> 8) & 0xFF; b[3] = data.length & 0xFF;
//[run-25-废弃]         b[4] = type.charCodeAt(0); b[5] = type.charCodeAt(1); b[6] = type.charCodeAt(2); b[7] = type.charCodeAt(3);
//[run-25-废弃]         b.set(data, 8);
//[run-25-废弃]         var cb = new Uint8Array(4 + data.length);
//[run-25-废弃]         cb.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 0);
//[run-25-废弃]         cb.set(data, 4);
//[run-25-废弃]         var crc = crc32(cb, 0, cb.length);
//[run-25-废弃]         b[8 + data.length] = (crc >> 24) & 0xFF; b[9 + data.length] = (crc >> 16) & 0xFF;
//[run-25-废弃]         b[10 + data.length] = (crc >> 8) & 0xFF; b[11 + data.length] = crc & 0xFF;
//[run-25-废弃]         return b;
//[run-25-废弃]     }
//[run-25-废弃]     var ihdr = new Uint8Array([(w >> 24) & 0xFF, (w >> 16) & 0xFF, (w >> 8) & 0xFF, w & 0xFF, (h >> 24) & 0xFF, (h >> 16) & 0xFF, (h >> 8) & 0xFF, h & 0xFF, 8, 6, 0, 0, 0]);
//[run-25-废弃]     var sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
//[run-25-废弃]     var ih = chunk("IHDR", ihdr), id = chunk("IDAT", idat), ie = chunk("IEND", new Uint8Array(0));
//[run-25-废弃]     var png = new Uint8Array(sig.length + ih.length + id.length + ie.length);
//[run-25-废弃]     png.set(sig, 0); png.set(ih, 8); png.set(id, 8 + ih.length); png.set(ie, 8 + ih.length + id.length);
//[run-25-废弃]     return png;
//[run-25-废弃] }
//[run-25-废弃] // SpecialThanks 名单: _specialThanksCredits@0xA0 = Dictionary<LocaleKind, string[][]>
//[run-25-废弃] //   (IL2CPP 字典布局实锤 choice.js: m_entries@0x18, Entry stride 24, 空槽 hashCode==-1)
//[run-25-废弃] function extractDictSpecialThanks() {
//[run-25-废弃]     try {
//[run-25-废弃]         var d = comp.director;
//[run-25-废弃]         if (!d || d.isNull()) { warn("[v3][Credit] extract: 无 director"); return null; }
//[run-25-废弃]         var dict = d.add(0xA0).readPointer();
//[run-25-废弃]         if (!dict || dict.isNull()) { warn("[v3][Credit] extract: _specialThanksCredits=null"); return null; }
//[run-25-废弃]         var ents = dict.add(0x18).readPointer();
//[run-25-废弃]         if (!ents || ents.isNull()) { warn("[v3][Credit] extract: m_entries 不可得"); return null; }
//[run-25-废弃]         var al = ents.add(0x18).readS32();
//[run-25-废弃]         if (al < 0 || al > 64) { warn("[v3][Credit] extract: entries 数量异常 " + al); return null; }
//[run-25-废弃]         var names = ["ja", "en-US", "zh-Hans", "zh-Hant", "ko", "fr", "es"];
//[run-25-废弃]         var out = { order: [] };
//[run-25-废弃]         for (var e = 0; e < al; e++) {
//[run-25-废弃]             var eb = ents.add(0x20 + e * 24);
//[run-25-废弃]             if (eb.readS32() === -1) continue;          // 空槽
//[run-25-废弃]             var key = eb.add(8).readS32();              // LocaleKind
//[run-25-废弃]             if (key < 0 || key > 6) continue;
//[run-25-废弃]             var val = eb.add(0x10).readPointer();       // string[][]
//[run-25-废弃]             if (!val || val.isNull()) continue;
//[run-25-废弃]             var glen = val.add(0x18).readS32();
//[run-25-废弃]             if (glen < 0 || glen > 500) { warn("[v3][Credit] extract: 语种 '" + names[key] + "' groups 异常 " + glen); continue; }
//[run-25-废弃]             var groups = [];
//[run-25-废弃]             for (var g = 0; g < glen; g++) {
//[run-25-废弃]                 var arr = val.add(0x20 + g * 8).readPointer();
//[run-25-废弃]                 if (!arr || arr.isNull()) continue;
//[run-25-废弃]                 var alen = arr.add(0x18).readS32();
//[run-25-废弃]                 if (alen < 0 || alen > 200) continue;
//[run-25-废弃]                 var lines = [];
//[run-25-废弃]                 for (var l = 0; l < alen; l++) {
//[run-25-废弃]                     var s = arr.add(0x20 + l * 8).readPointer();
//[run-25-废弃]                     if (s && !s.isNull()) lines.push(readStr(s));
//[run-25-废弃]                 }
//[run-25-废弃]                 groups.push(lines);
//[run-25-废弃]             }
//[run-25-废弃]             out[names[key]] = { label: "原版 SpecialThanks (" + names[key] + ")", groups: groups };
//[run-25-废弃]             out.order.push(names[key]);
//[run-25-废弃]             info("[v3][Credit] extract: 语种 '" + names[key] + "' 提取 " + glen + " 组名单");
//[run-25-废弃]         }
//[run-25-废弃]         return out;
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] extractDictSpecialThanks err: " + e); return null; }
//[run-25-废弃] }
//[run-25-废弃] // stills 图片: _stills@0x58 = EndingStill[] → GameObject → GetComponentsInChildren(Image) → sprite → texture → PNG
//[run-25-废弃] function extractStillsToPng() {
//[run-25-废弃]     try {
//[run-25-废弃]         var d = comp.director;
//[run-25-废弃]         var stills = d.add(0x58).readPointer();
//[run-25-废弃]         if (!stills || stills.isNull()) { warn("[v3][Credit] extract: _stills=null"); return []; }
//[run-25-废弃]         var n = stills.add(0x18).readS32();
//[run-25-废弃]         if (n < 1 || n > 50) { warn("[v3][Credit] extract: _stills 数量异常 " + n); return []; }
//[run-25-废弃]         mkdirs(extractOutRoot() + "/stills");
//[run-25-废弃]         var meta = [];
//[run-25-废弃]         for (var i = 0; i < n; i++) {
//[run-25-废弃]             var st = stills.add(0x20 + i * 8).readPointer();
//[run-25-废弃]             if (!st || st.isNull()) { meta.push({ index: i, sprite: "null-instance" }); continue; }
//[run-25-废弃]             var goR = invokeOk(cgmChain(A.ogc(st), "get_gameObject", 0), st, []);
//[run-25-废弃]             if (!goR.ok || !goR.ret || goR.ret.isNull()) { warn("[v3][Credit] extract still#" + i + ": get_gameObject FAIL"); meta.push({ index: i, sprite: "no-go" }); continue; }
//[run-25-废弃]             var comps = invokeOk(cgmChain(A.ogc(goR.ret), "GetComponentsInChildren", 2), goR.ret, [A.tgo(A.cgt(cls.image)), boolPtr(true)]);
//[run-25-废弃]             var sprite = null;
//[run-25-废弃]             if (comps.ok && comps.ret && !comps.ret.isNull()) {
//[run-25-废弃]                 var clen = comps.ret.add(0x18).readS32();
//[run-25-废弃]                 for (var ci = 0; ci < clen && !sprite; ci++) {
//[run-25-废弃]                     var img = comps.ret.add(0x20 + ci * 8).readPointer();
//[run-25-废弃]                     if (!img || img.isNull()) continue;
//[run-25-废弃]                     var spR = invokeOk(cgmChain(A.ogc(img), "get_sprite", 0), img, []);
//[run-25-废弃]                     if (spR.ok && spR.ret && !spR.ret.isNull()) sprite = spR.ret;
//[run-25-废弃]                 }
//[run-25-废弃]             }
//[run-25-废弃]             if (!sprite) { warn("[v3][Credit] extract still#" + i + ": 无 Image/Sprite (sprite 可能尚未赋值)"); meta.push({ index: i, sprite: "none" }); continue; }
//[run-25-废弃]             var texR = invokeOk(cgmChain(A.ogc(sprite), "get_texture", 0), sprite, []);
//[run-25-废弃]             if (!texR.ok || !texR.ret || texR.ret.isNull()) { warn("[v3][Credit] extract still#" + i + ": get_texture FAIL"); meta.push({ index: i, sprite: "no-tex" }); continue; }
//[run-25-废弃]             var tex = texR.ret;
//[run-25-废弃]             var wMi = cgmChain(A.ogc(tex), "get_width", 0), hMi = cgmChain(A.ogc(tex), "get_height", 0);
//[run-25-废弃]             // get_width/get_height 返回 int — invoke 对 ≤8B 值类型返回缓冲失效 (utils 实证) → directCall
//[run-25-废弃]             var w = (wMi && !wMi.isNull()) ? directCall(wMi, "int", [tex]) : 0;
//[run-25-废弃]             var h = (hMi && !hMi.isNull()) ? directCall(hMi, "int", [tex]) : 0;
//[run-25-废弃]             if (w < 1 || h < 1 || w * h > 4096 * 4096) { warn("[v3][Credit] extract still#" + i + ": 纹理尺寸异常 " + w + "x" + h); meta.push({ index: i, size: w + "x" + h, sprite: "bad-size" }); continue; }
//[run-25-废弃]             // run-24-3: still 图片打包在 sprite atlas 里 (纹理 4096x4096) —
//[run-25-废弃]             //   get_textureRect 返回 Rect (16B HFA) invoke 缓冲不可靠 (实测读到垃圾被守卫拒绝);
//[run-25-废弃]             //   改用 sprite.get_uv (Vector2[] 引用类型, invoke 安全) 对角 UV 换算纹理像素 region。
//[run-25-废弃]             //   UV 归一化 [0,1] 原点=纹理左下, 与 GetPixels32(x,y,w,h) 坐标一致。
//[run-25-废弃]             var rx = 0, ry = 0, rw = w, rh = h;
//[run-25-废弃]             var rotMi = cgmChain(A.ogc(sprite), "GetPackingRotation", 0);   // internal int — directCall
//[run-25-废弃]             var rot = (rotMi && !rotMi.isNull()) ? directCall(rotMi, "int", [sprite]) : 0;
//[run-25-废弃]             if (rot !== 0) { warn("[v3][Credit] extract still#" + i + ": sprite 旋转打包 rotation=" + rot + " — 跳过"); meta.push({ index: i, sprite: "rotated" }); continue; }
//[run-25-废弃]             var uvR = invokeOk(cgmChain(A.ogc(sprite), "get_uv", 0), sprite, []);
//[run-25-废弃]             if (uvR.ok && uvR.ret && !uvR.ret.isNull()) {
//[run-25-废弃]                 var uvn = uvR.ret.add(0x18).readS32();
//[run-25-废弃]                 if (uvn >= 2) {
//[run-25-废弃]                     // run-24-5: tight-packed sprite 顶点序任意 (实测 uv[0]/uv[2] 相邻 → region 1x4) —
//[run-25-废弃]                     //   遍历全部 uv 顶点取包围盒 min/max (tight 和 simple 都适用)
//[run-25-废弃]                     var u0 = uvR.ret.add(0x20);
//[run-25-废弃]                     var minU = 1, minV = 1, maxU = 0, maxV = 0;
//[run-25-废弃]                     for (var k = 0; k < uvn && k < 64; k++) {
//[run-25-废弃]                         var uu = u0.add(k * 8).readFloat(), vv = u0.add(k * 8 + 4).readFloat();
//[run-25-废弃]                         if (uu < minU) minU = uu; if (uu > maxU) maxU = uu;
//[run-25-废弃]                         if (vv < minV) minV = vv; if (vv > maxV) maxV = vv;
//[run-25-废弃]                     }
//[run-25-废弃]                     if (maxU > minU && maxV > minV) {
//[run-25-废弃]                         var px0 = Math.round(minU * w), py0 = Math.round(minV * h);
//[run-25-废弃]                         var px1 = Math.round(maxU * w), py1 = Math.round(maxV * h);
//[run-25-废弃]                         if (px1 > px0 && py1 > py0 && (px1 - px0) <= 4096 && (py1 - py0) <= 4096) {
//[run-25-废弃]                             rx = px0; ry = py0; rw = px1 - px0; rh = py1 - py0;
//[run-25-废弃]                             info("[v3][Credit] extract still#" + i + ": 纹理 " + w + "x" + h + " → sprite region " + rw + "x" + rh + "@(" + rx + "," + ry + ") (uv bbox " + uvn + " 顶点)");
//[run-25-废弃]                         }
//[run-25-废弃]                     }
//[run-25-废弃]                 }
//[run-25-废弃]             }
//[run-25-废弃]             if (rw < 1 || rh < 1 || rw * rh > 2400 * 2400) { warn("[v3][Credit] extract still#" + i + ": region 尺寸异常 " + rw + "x" + rh); meta.push({ index: i, size: rw + "x" + rh, sprite: "bad-region" }); continue; }
//[run-25-废弃]             var rgba = null;
//[run-25-废弃]             // run-24-5: GetPixels32 只有 0/1 参重载 (dump.cs 实证) — 4 参不存在 (mi=0 invoke 崩 access violation 0x4c);
//[run-25-废弃]             //   必须全图 0 参 + JS 裁剪; 多张 still 共享同一 atlas 纹理 → 全图按 tex 指针缓存只读一次
//[run-25-废弃]             var ck = tex.toString();
//[run-25-废弃]             if (!fullTexCache[ck]) {
//[run-25-废弃]                 var fmi = cgmChain(A.ogc(tex), "GetPixels32", 0);
//[run-25-废弃]                 if (!fmi || fmi.isNull()) { warn("[v3][Credit] extract still#" + i + ": GetPixels32() NOT FOUND"); meta.push({ index: i, sprite: "no-pixels" }); continue; }
//[run-25-废弃]                 var fullR = invokeOk(fmi, tex, []);
//[run-25-废弃]                 if (!fullR.ok || !fullR.ret || fullR.ret.isNull() || fullR.ret.add(0x18).readS32() !== w * h) {
//[run-25-废弃]                     // run-24-6: 细化失败原因 + 不可读纹理兜底 (ReadPixels 链) — 最常见根因:
//[run-25-废弃]                     //   atlas 纹理 m_IsReadable=false → GetPixels32 抛 "not readable" (invoke 异常 → ok=false)
//[run-25-废弃]                     var why = "unknown";
//[run-25-废弃]                     try {
//[run-25-废弃]                         var rdMi2 = cgmChain(A.ogc(tex), "get_isReadable", 0);
//[run-25-废弃]                         var rd2 = (rdMi2 && !rdMi2.isNull()) ? directCall(rdMi2, "bool", [tex]) : "?";
//[run-25-废弃]                         if (!fullR.ok) {
//[run-25-废弃]                             var exc = Memory.alloc(8); exc.writePointer(ptr(0));
//[run-25-废弃]                             A.ri(fmi, tex, ptr(0), exc);   // 重调拿异常详情 (参数忽略, 只为读 exc)
//[run-25-废弃]                             var ex = exc.readPointer();
//[run-25-废弃]                             why = (!ex.isNull()) ? ("throw:" + clsName(A.ogc(ex))) : ("ok-but-invalid readable=" + rd2);
//[run-25-废弃]                         } else if (fullR.ret.isNull()) why = "null-array readable=" + rd2;
//[run-25-废弃]                         else why = "len-mismatch(" + fullR.ret.add(0x18).readS32() + "!=" + (w * h) + ") readable=" + rd2;
//[run-25-废弃]                     } catch (e3) { why = "diag-err:" + e3; }
//[run-25-废弃]                     warn("[v3][Credit] extract still#" + i + ": GetPixels32() FAIL (" + why + ") — 试 ReadPixels 兜底");
//[run-25-废弃]                     var fb = readPixelsFallback(tex, w, h);
//[run-25-废弃]                     if (!fb) {
//[run-25-废弃]                         // run-24-7: 像素不可读 (atlas Crunch 纹理实锤) — region 已拿到, 不丢:
//[run-25-废弃]                         //   图片像素由开发机 AssetRipper 解包的 atlas PNG 提供 (extract_stills.py 按 region 裁图)
//[run-25-废弃]                         warn("[v3][Credit] extract still#" + i + ": 像素提取不可行 — region " + rw + "x" + rh + "@(" + rx + "," + ry + ") 已记录 (图片=AssetRipper atlas)");
//[run-25-废弃]                         meta.push({ index: i, size: rw + "x" + rh, region: [rx, ry], sprite: "assetripper-atlas" });
//[run-25-废弃]                         continue;
//[run-25-废弃]                     }
//[run-25-废弃]                     fullTexCache[ck] = fb;
//[run-25-废弃]                     info("[v3][Credit] extract still#" + i + ": ReadPixels 兜底成功 " + fb.w + "x" + fb.h);
//[run-25-废弃]                 }
//[run-25-废弃]                 fullTexCache[ck] = { w: w, h: h, rgba: new Uint8Array(fullR.ret.add(0x20).readByteArray(w * h * 4)) };
//[run-25-废弃]                 info("[v3][Credit] extract still#" + i + ": 全图已缓存 " + w + "x" + h + " (atlas 共享)");
//[run-25-废弃]             }
//[run-25-废弃]             var full = fullTexCache[ck];
//[run-25-废弃]             rgba = new Uint8Array(rw * rh * 4);
//[run-25-废弃]             for (var yy = 0; yy < rh; yy++) {
//[run-25-废弃]                 var srcOff = ((Math.round(ry) + yy) * full.w + Math.round(rx)) * 4;
//[run-25-废弃]                 rgba.set(full.rgba.subarray(srcOff, srcOff + rw * 4), yy * rw * 4);
//[run-25-废弃]             }
//[run-25-废弃]             var png = pngEncodeRGBA(rw, rh, rgba);
//[run-25-废弃]             var ok = writeFileBytes(extractOutRoot() + "/stills/still" + i + ".png", png);
//[run-25-废弃]             meta.push({ index: i, png: "stills/still" + i + ".png", size: rw + "x" + rh, region: [rx, ry], ok: ok });
//[run-25-废弃]         }
//[run-25-废弃]         return meta;
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] extractStillsToPng err: " + e); return []; }
//[run-25-废弃] }
// run-24-6: 不可读纹理兜底 — atlas 纹理 m_IsReadable=false 时 GetPixels32 抛异常 (实测 FAIL),
//   改走 GPU 拷贝链: GetTemporary RT → Graphics.Blit → active → Texture2D(新, 默认可读).ReadPixels →
//   ReleaseTemporary → dst.GetPixels32 (ReadPixels 已填充 CPU 侧, readable=true 必成)。
//   注意: il2cpp_runtime_invoke 的 8B 参数槽只支持指针/≤8B 值 (Rect 16B 塞不进) →
//   GetTemporary 的 (int,int) 本地写 s32 槽, ReadPixels 的 Rect 用 NativeFunction 'rect' 直调
//   (darwin 平台 CGRect 与 UnityEngine.Rect 同构); 全程 try/catch, 任何一步失败返回 null。
//[run-25-废弃] function readPixelsFallback(tex, w, h) {
//[run-25-废弃]     try {
//[run-25-废弃]         if (!cls.renderTexture || cls.renderTexture.isNull() || !cls.graphics || cls.graphics.isNull()
//[run-25-废弃]             || !cls.texture2D || cls.texture2D.isNull()) {
//[run-25-废弃]             warn("[v3][Credit] readPixelsFallback: RenderTexture/Graphics/Texture2D 类不可得");
//[run-25-废弃]             return null;
//[run-25-废弃]         }
//[run-25-废弃]         var excBuf = function () { var e = Memory.alloc(8); e.writePointer(ptr(0)); return e; };
//[run-25-废弃]         // 1. rt = RenderTexture.GetTemporary(w, h) — static, int,int → 本地 s32 槽
//[run-25-废弃]         var rtMi = A.cgm(cls.renderTexture, Memory.allocUtf8String("GetTemporary"), 2);
//[run-25-废弃]         if (!rtMi || rtMi.isNull()) { warn("[v3][Credit] readPixelsFallback: GetTemporary(2) NOT FOUND"); return null; }
//[run-25-废弃]         var p2 = Memory.alloc(16); p2.writeS32(w); p2.add(8).writeS32(h);
//[run-25-废弃]         var e1 = excBuf();
//[run-25-废弃]         var rt = A.ri(rtMi, null, p2, e1);
//[run-25-废弃]         if (!e1.readPointer().isNull() || !rt || rt.isNull()) { warn("[v3][Credit] readPixelsFallback: GetTemporary FAIL"); return null; }
//[run-25-废弃]         var rtStr = rt.toString();
//[run-25-废弃]         // 2. Graphics.Blit(tex, rt) — static, 2 pointer
//[run-25-废弃]         var blitMi = A.cgm(cls.graphics, Memory.allocUtf8String("Blit"), 2);
//[run-25-废弃]         if (blitMi && !blitMi.isNull()) {
//[run-25-废弃]             var bargs = Memory.alloc(16); bargs.writePointer(tex); bargs.add(8).writePointer(rt);
//[run-25-废弃]             var e2 = excBuf();
//[run-25-废弃]             A.ri(blitMi, null, bargs, e2);
//[run-25-废弃]             if (!e2.readPointer().isNull()) warn("[v3][Credit] readPixelsFallback: Blit 抛异常 (忽略继续)");
//[run-25-废弃]         } else warn("[v3][Credit] readPixelsFallback: Blit(2) NOT FOUND (忽略)");
//[run-25-废弃]         // 3. RenderTexture.set_active(rt) — static, 1 pointer
//[run-25-废弃]         var actMi = A.cgm(cls.renderTexture, Memory.allocUtf8String("set_active"), 1);
//[run-25-废弃]         if (actMi && !actMi.isNull()) {
//[run-25-废弃]             var aargs = Memory.alloc(8); aargs.writePointer(rt);
//[run-25-废弃]             var e3 = excBuf();
//[run-25-废弃]             A.ri(actMi, null, aargs, e3);
//[run-25-废弃]             if (!e3.readPointer().isNull()) warn("[v3][Credit] readPixelsFallback: set_active 抛异常 (忽略继续)");
//[run-25-废弃]         }
//[run-25-废弃]         // 4. dst = new Texture2D(w, h, DefaultFormat.LDR=0, TextureCreationFlags.None=0) — 4 参 ctor 直调
//[run-25-废弃]         var dst = A.on(cls.texture2D);
//[run-25-废弃]         var ctorMi = A.cgm(cls.texture2D, Memory.allocUtf8String(".ctor"), 4);
//[run-25-废弃]         if (!ctorMi || ctorMi.isNull() || ctorMi.readPointer().isNull()) {
//[run-25-废弃]             warn("[v3][Credit] readPixelsFallback: Texture2D.ctor(4) NOT FOUND"); A.ri(actMi, null, aargs, excBuf()); return null;
//[run-25-废弃]         }
//[run-25-废弃]         new NativeFunction(ctorMi.readPointer(), "void", ["pointer", "int", "int", "int", "int"])(dst, w, h, 0, 0);
//[run-25-废弃]         // 5. dst.ReadPixels(rect(0,0,w,h), 0, 0) — Rect 16B → NativeFunction 'rect' 直调
//[run-25-废弃]         var rpMi = A.cgm(cls.texture2D, Memory.allocUtf8String("ReadPixels"), 3);
//[run-25-废弃]         if (!rpMi || rpMi.isNull() || rpMi.readPointer().isNull()) {
//[run-25-废弃]             warn("[v3][Credit] readPixelsFallback: ReadPixels(3) NOT FOUND"); A.ri(actMi, null, aargs, excBuf()); return null;
//[run-25-废弃]         }
//[run-25-废弃]         var rpFn = new NativeFunction(rpMi.readPointer(), "void", ["pointer", "rect", "int", "int"]);
//[run-25-废弃]         var rc = Memory.alloc(16);
//[run-25-废弃]         rc.writeFloat(0); rc.add(4).writeFloat(0); rc.add(8).writeFloat(w); rc.add(12).writeFloat(h);
//[run-25-废弃]         rpFn(dst, rc, 0, 0);
//[run-25-废弃]         // 6. 清理: active 复位 + ReleaseTemporary
//[run-25-废弃]         if (actMi && !actMi.isNull()) A.ri(actMi, null, aargs, excBuf());
//[run-25-废弃]         var relMi = A.cgm(cls.renderTexture, Memory.allocUtf8String("ReleaseTemporary"), 1);
//[run-25-废弃]         if (relMi && !relMi.isNull()) {
//[run-25-废弃]             var rargs = Memory.alloc(8); rargs.writePointer(rt);
//[run-25-废弃]             A.ri(relMi, null, rargs, excBuf());
//[run-25-废弃]         }
//[run-25-废弃]         // 7. dst.GetPixels32() — 0 参, 返回 Color32[] (引用类型 invoke 安全)
//[run-25-废弃]         var g32 = cgmChain(A.ogc(dst), "GetPixels32", 0);
//[run-25-废弃]         if (!g32 || g32.isNull()) { warn("[v3][Credit] readPixelsFallback: dst.GetPixels32 NOT FOUND"); return null; }
//[run-25-废弃]         var r2 = invokeOk(g32, dst, []);
//[run-25-废弃]         if (!r2.ok || !r2.ret || r2.ret.isNull() || r2.ret.add(0x18).readS32() !== w * h) {
//[run-25-废弃]             var ln = (r2.ret && !r2.ret.isNull()) ? r2.ret.add(0x18).readS32() : "null";
//[run-25-废弃]             warn("[v3][Credit] readPixelsFallback: dst.GetPixels32 FAIL (len=" + ln + ") rt=" + rtStr);
//[run-25-废弃]             return null;
//[run-25-废弃]         }
//[run-25-废弃]         return { w: w, h: h, rgba: new Uint8Array(r2.ret.add(0x20).readByteArray(w * h * 4)) };
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] readPixelsFallback err: " + e); return null; }
//[run-25-废弃] }
//[run-25-废弃] // staff 滚动名单: _creditRolls@0x60 = CreditRoll[] → GameObject → GetComponentsInChildren(TMP_Text) 文本
//[run-25-废弃] function extractStaffTexts() {
//[run-25-废弃]     try {
//[run-25-废弃]         var d = comp.director;
//[run-25-废弃]         var rolls = d.add(0x60).readPointer();
//[run-25-废弃]         if (!rolls || rolls.isNull()) { warn("[v3][Credit] extract: _creditRolls=null"); return null; }
//[run-25-废弃]         var n = rolls.add(0x18).readS32();
//[run-25-废弃]         if (n < 1 || n > 50) { warn("[v3][Credit] extract: _creditRolls 数量异常 " + n); return null; }
//[run-25-废弃]         var out = [];
//[run-25-废弃]         for (var i = 0; i < n; i++) {
//[run-25-废弃]             var roll = rolls.add(0x20 + i * 8).readPointer();
//[run-25-废弃]             if (!roll || roll.isNull()) continue;
//[run-25-废弃]             var goR = invokeOk(cgmChain(A.ogc(roll), "get_gameObject", 0), roll, []);
//[run-25-废弃]             if (!goR.ok || !goR.ret || goR.ret.isNull()) continue;
//[run-25-废弃]             var comps = invokeOk(cgmChain(A.ogc(goR.ret), "GetComponentsInChildren", 2), goR.ret, [A.tgo(A.cgt(cls.tmpText)), boolPtr(true)]);
//[run-25-废弃]             var texts = [];
//[run-25-废弃]             if (comps.ok && comps.ret && !comps.ret.isNull()) {
//[run-25-废弃]                 var clen = comps.ret.add(0x18).readS32();
//[run-25-废弃]                 for (var ci = 0; ci < clen && ci < 8; ci++) {
//[run-25-废弃]                     var t = comps.ret.add(0x20 + ci * 8).readPointer();
//[run-25-废弃]                     if (!t || t.isNull()) continue;
//[run-25-废弃]                     var txR = invokeOk(cgmChain(A.ogc(t), "get_text", 0), t, []);
//[run-25-废弃]                     if (txR.ok && txR.ret && !txR.ret.isNull()) texts.push(readStr(txR.ret));
//[run-25-废弃]                 }
//[run-25-废弃]             }
//[run-25-废弃]             out.push({ roll: i, texts: texts });
//[run-25-废弃]         }
//[run-25-废弃]         return out;
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] extractStaffTexts err: " + e); return null; }
//[run-25-废弃] }
//[run-25-废弃] // 主入口: doPlayAsyncInvoke (PlayAsync 成功, 仍处主线程同步 hook) 后调用
//[run-25-废弃] function extractStep() {
//[run-25-废弃]     try {
//[run-25-废弃]         info("[v3][Credit] 素材提取开始 (stills PNG + SpecialThanks 名单 + staff 文本 + 时序)");
//[run-25-废弃]         var d = comp.director;
//[run-25-废弃]         if (!d || d.isNull()) { warn("[v3][Credit] extract: director 不可得"); writeVar("g_extractDone", 1); return; }
//[run-25-废弃]         mkdirs(extractOutRoot());
//[run-25-废弃]         var stMeta = extractStillsToPng();
//[run-25-废弃]         var stJson = extractDictSpecialThanks();
//[run-25-废弃]         var staffJson = extractStaffTexts();
//[run-25-废弃]         // run-24-8: 轮询首采有启动延迟 → 滚动开头 1-2 屏 (企画/Acacia/プロデューサー...) 可能漏 —
//[run-25-废弃]         //   当前屏快照 (extractStaffTexts) 与 collectedStaff 去重合并, 开头屏不丢
//[run-25-废弃]         try {
//[run-25-废弃]             if (staffJson) {
//[run-25-废弃]                 for (var si = 0; si < staffJson.length; si++) {
//[run-25-废弃]                     var rollTxts = staffJson[si].texts || [];
//[run-25-废弃]                     for (var tj = 0; tj < rollTxts.length; tj++) {
//[run-25-废弃]                         var tv = rollTxts[tj];
//[run-25-废弃]                         var key2 = "snap|" + si + "|" + tv;
//[run-25-废弃]                         if (staffSeen[key2] || !tv || tv.length < 2) continue;
//[run-25-废弃]                         staffSeen[key2] = true;
//[run-25-废弃]                         collectedStaff.push({ go: "snap-roll" + si, text: tv });
//[run-25-废弃]                     }
//[run-25-废弃]                 }
//[run-25-废弃]             }
//[run-25-废弃]         } catch (e4) { warn("[v3][Credit] extractStep 快照合并 err: " + e4); }
//[run-25-废弃]         installStaffPoll();   // run-24-6: staff 轮询兜底 (主线程缓存组件 → JS 线程采样 m_text)
//[run-25-废弃]         var out = {
//[run-25-废弃]             stills: stMeta,
//[run-25-废弃]             specialthanks: stJson,
//[run-25-废弃]             staff: staffJson,
//[run-25-废弃]             timing: {
//[run-25-废弃]                 scrollSpeed: d.add(0x68).readFloat(),
//[run-25-废弃]                 stillDelayUnits: d.add(0x6C).readFloat(),
//[run-25-废弃]                 stillFadeUnits: d.add(0x70).readFloat(),
//[run-25-废弃]                 stillDisplayUnits: d.add(0x74).readFloat(),
//[run-25-废弃]                 specialThanksFadeUnits: d.add(0x78).readFloat(),
//[run-25-废弃]                 specialThanksDisplayUnits: d.add(0x7C).readFloat()
//[run-25-废弃]             }
//[run-25-废弃]         };
//[run-25-废弃]         writeFileBytes(extractOutRoot() + "/credit-assets.json", new Uint8Array(utf8Bytes(JSON.stringify(out, null, 2))));
//[run-25-废弃]         writeVar("g_extractDone", 1);
//[run-25-废弃]         info("[v3][Credit] 素材提取完成 — g_extractDone=1");
//[run-25-废弃]     } catch (e) { error("[v3][Credit] extractStep err: " + e); writeVar("g_extractDone", 1); }
//[run-25-废弃] }
var pendingPlay = null;
var creditT0 = 0;
function doPlayAsyncInvoke() {
    try {
        if (!pendingPlay) {
            dbg("[v3][Credit] doPlayAsyncInvoke: 无 pendingPlay (幂等跳过)");
            return;
        }
        var ui = pendingPlay.ui || comp.creditsUI;
        var tok = pendingPlay.tok;
        var d = comp.director;
        var stc = d ? d.add(0xA0).readPointer() : null;
        if (!(stc && !stc.isNull()) && (Date.now() - pendingPlay.t0) < 8000) {
            dbg("[v3][Credit] 泵: _specialThanksCredits 未填充, 下个泵再试");
            return; // 资产未就绪且未超时 — 等下一个 tick
        }
        // run-30: probe-thanks — PlayAsync 触发前挂探针 + 提取完整页/行字典 (此时 _specialThanksCredits 已填充)
        if (creditState.extract) {
            try {
                installThanksProbe();
            }
            catch (e3) {
                warn("[v3][Credit] 探针安装 err: " + e3);
            }
            try {
                thanksProbeDict();
            }
            catch (e4) {
                warn("[v3][Credit] 字典提取 err: " + e4);
            }
        }
        var mi = A.cgm(cls.creditsUI, Memory.allocUtf8String("PlayAsync"), 2);
        if (!mi || mi.isNull()) {
            warn("[v3][Credit] 原版复刻: CreditsUI.PlayAsync(act,AsyncToken) NOT FOUND");
            writeVar("g_creditDone", 1);
            writeVar("g_thanksDuration", 5);
            pendingPlay = null;
            return;
        }
        var r = invokeOk(mi, ui, [iPtr(2), tok]);
        if (!r.ok) {
            warn("[v3][Credit] 原版复刻: PlayAsync(2) invoke FAIL — 见上方异常");
            writeVar("g_creditDone", 1);
            writeVar("g_thanksDuration", 5);
            pendingPlay = null;
            return;
        }
        pendingPlay = null;
        info("[v3][Credit] 原版复刻: CreditsUI.PlayAsync(2) 已触发 (主线程, _specialThanksCredits=" + (stc && !stc.isNull() ? "填充" : "null") + ") — 原版全流程运行中 (stills+staff+thanks)");
        //[run-25-废弃]         if (creditState.extract) {
        //[run-25-废弃]             try { extractStep(); } catch (e2) { error("[v3][Credit] extractStep err: " + e2); writeVar("g_extractDone", 1); }
        //[run-25-废弃]         }
        startCompletionPoll();
    }
    catch (e) {
        error("[v3][Credit] doPlayAsyncInvoke err: " + e);
        writeVar("g_creditDone", 1);
        pendingPlay = null;
    }
}
// 完成信号轮询 (run-23 模块级): canvas disabled → g_creditDone=1; 360s 超时兜底 (run-24: 片尾 5 分钟)
var startCompletionPoll = function () {
    try {
        var ui = comp.creditsUI;
        if (!ui || ui.isNull()) {
            warn("[v3][Credit] startCompletionPoll: comp.creditsUI 不可得");
            return;
        }
        var t0 = creditT0;
        var polled = 0, lastState = -1;
        var timeoutGuard = setTimeout(function () {
            if (creditState.armed && creditState.original) {
                warn("[v3][Credit] 原版演出 360s 超时兜底 — g_creditDone=1 (演出可能异常未播完)");
                //[run-25-废弃]                 flushStaffJson();   // run-24-4: 超时兜底也落盘 (收集到的即全部滚动期文本)
                try {
                    if (creditState.extract)
                        thanksProbeFlush();
                }
                catch (e5) { }
                writeVar("g_creditDone", 1);
            }
        }, (creditState.extract ? 2400000 : 360000)); // run-30: 探针模式原版全流程(共犯 459+420 人拼行)可超 10 分钟; 普通原版 360s (run-24 bloom 片尾)
        var pollFn = function () {
            try {
                if (!creditState.armed || !creditState.original) {
                    clearTimeout(timeoutGuard);
                    return;
                }
                polled++;
                var d = comp.director;
                if (!d || d.isNull()) {
                    // director 未捕获 (数组空?) — 改查 CreditsUI canvas 自身
                    var cv0 = ui.add(0x28).readPointer();
                    if (!cv0 || cv0.isNull()) {
                        setTimeout(pollFn, 500);
                        return;
                    }
                    d = { canvas: cv0 };
                }
                var cv = d.canvas ? d.canvas : d.add(0x28).readPointer(); // director._canvas@0x28
                var on = cv ? dcBool(cgmChain(A.ogc(cv), "get_enabled", 0), cv) : false;
                var stc2 = (comp.director && !comp.director.isNull()) ? comp.director.add(0xA0).readPointer() : null;
                if (polled === 2 || polled % 10 === 0 || (on !== lastState)) {
                    info("[v3][Credit] 原版轮询 #" + polled + " (+" + ((Date.now() - t0) / 1000).toFixed(0) + "s): canvas=" + (on ? "on" : "OFF") + " _specialThanksCredits=" + (stc2 && !stc2.isNull() ? "填充" : "null"));
                    lastState = on;
                }
                if (!on) {
                    clearTimeout(timeoutGuard);
                    var elapsed = (Date.now() - t0) / 1000;
                    //[run-25-废弃]                     flushStaffJson();   // run-24-4: 演出自然完, staff 收集完整
                    try {
                        if (creditState.extract)
                            thanksProbeFlush();
                    }
                    catch (e5) { }
                    writeVar("g_creditDone", 1);
                    writeVar("g_thanksDuration", elapsed + 3);
                    info("[v3][Credit] 原版演出完成 (canvas disabled) +" + elapsed.toFixed(0) + "s — g_creditDone=1, g_thanksDuration=" + (elapsed + 3).toFixed(0));
                    return;
                }
            }
            catch (e) {
                if (polled % 10 === 0)
                    warn("[v3][Credit] 原版轮询 err: " + e);
            }
            setTimeout(pollFn, 500);
        };
        setTimeout(pollFn, 500); // 500ms 后开始轮询
    }
    catch (e) {
        error("[v3][Credit] startCompletionPoll err: " + e);
    }
};
function doOriginal() {
    try {
        if (!creditState.armed) {
            writeVar("g_thanksDuration", 5);
            return;
        }
        writeVar("g_creditDone", 0); // run-19: 入口即重置完成信号 — nani @if 轮询读到的是本轮 0 (防上次会话残留 1)
        // run-17 重构: 场景扫 CreditsUI (含 inactive) + 场景/资产扫 CreditsDirectorAct2 —
        //   GetUI 壳实例的 _creditsDirectors@0xE0 可能为 null (prefab 序列化引用场景对象 → 实例化后引用失效)
        //   若 director 实例存在 → 手动组装进壳数组 (原版 @credit 2 的前提)
        var ui = null;
        var dInst = null; // 场景/资产的 CreditsDirectorAct2 实例
        try {
            // ① 场景 CreditsUI (stage2 includeInactive; stage3 资产 prefab 实例化后引用失效, 仅诊断)
            var uiR = findRollsStaged(cls.creditsUI, "CreditsUI");
            if (uiR.stage >= 1 && uiR.stage <= 2) {
                for (var ui_i = 0; ui_i < uiR.objs.length; ui_i++) {
                    var uiGo = uiR.objs[ui_i];
                    var arrD = uiGo.add(0xE0).readPointer();
                    var hasD = arrD && !arrD.isNull();
                    info("[v3][Credit] 场景 CreditsUI#" + ui_i + " = " + uiGo + " (" + getGoName(uiGo) + ") _creditsDirectors=" + (hasD ? "有" : "null"));
                    if (!ui && hasD) {
                        ui = uiGo;
                        info("[v3][Credit] 原版复刻: 用场景 CreditsUI " + uiGo + " (有 director 数组)");
                    }
                }
            }
            else if (uiR.stage === 3) {
                warn("[v3][Credit] CreditsUI 只有资产 prefab (" + uiR.objs.length + " 个) — 实例化后 director 引用失效, 需手动组装; 先扫 director 实例");
            }
            else {
                dbg("[v3][Credit] 场景无 CreditsUI 实例 — 依赖 GetUI 壳 + 手动组装");
            }
            // ② 场景/资产扫 CreditsDirectorAct2 实例
            var dR = findRollsStaged(cls.director, "CreditsDirectorAct2");
            if (dR.stage >= 1 && dR.stage <= 2) {
                for (var di = 0; di < dR.objs.length; di++) {
                    var dp = dR.objs[di];
                    var dGoName = getGoName(dp);
                    var stc0 = dp.add(0xA0).readPointer();
                    info("[v3][Credit] 场景 CreditsDirectorAct2#" + di + " = " + dp + " (" + dGoName + ") _specialThanksCredits=" + (stc0 && !stc0.isNull() ? "有" : "null"));
                    if (!dInst)
                        dInst = dp;
                }
            }
            else if (dR.stage === 3) {
                warn("[v3][Credit] CreditsDirectorAct2 只有资产 prefab (" + dR.objs.length + " 个) — 无场景实例, 无法复刻原版");
            }
        }
        catch (e) {
            warn("[v3][Credit] 原版复刻: 场景组件扫描 err: " + e);
        }
        if (!ui)
            ui = spawnCreditsUI();
        if (!ui || ui.isNull()) {
            warn("[v3][Credit] 原版复刻: CreditsUI 不可得 (场景扫+spawnCreditsUI 均失败)");
            writeVar("g_creditDone", 1);
            writeVar("g_thanksDuration", 5);
            return;
        }
        // ③ director 数组组装: 壳实例 director=null 且场景有 director 实例 → 手动写入
        var arr = ui.add(0xE0).readPointer();
        if ((!arr || arr.isNull()) && dInst) {
            try {
                var dArr = A.an(A.ogc(dInst), 4); // 元素类 = director 实例类 (Act2)
                dArr.add(0x20 + 2 * 8).writePointer(dInst); // act=2 槽位
                ui.add(0xE0).writePointer(dArr);
                comp.director = dInst;
                info("[v3][Credit] 原版复刻: 手动组装 _creditsDirectors[2]=" + dInst + " (" + getGoName(dInst) + ") — 壳实例 + 场景 director");
            }
            catch (e) {
                warn("[v3][Credit] 原版复刻: 手动组装 director 数组 err: " + e);
            }
        }
        // 诊断: _creditsDirectors@0xE0 数组 → act=2 导演实例 + 数据填充状态
        try {
            arr = ui.add(0xE0).readPointer();
            if (!arr || arr.isNull()) {
                warn("[v3][Credit] 原版 director 诊断: _creditsDirectors@0xE0 = null (场景无 director 实例, 无法复刻原版)");
            }
            else {
                var len = arr.add(0x18).readS32();
                if (len < 1 || len > 16) {
                    warn("[v3][Credit] 原版 director 诊断: _creditsDirectors 长度异常 " + len);
                }
                else {
                    var parts = [];
                    for (var i = 0; i < len; i++) {
                        var p = arr.add(0x20 + i * 8).readPointer();
                        parts.push("#" + i + ":" + (p && !p.isNull() ? clsName(A.ogc(p)) : "null"));
                        if (i === 2 && p && !p.isNull()) {
                            comp.director = p;
                            var stc = p.add(0xA0).readPointer(); // _specialThanksCredits@0xA0
                            var sto = p.add(0x98).readPointer(); // _specialThanksOrders@0x98
                            info("[v3][Credit] 原版 director[2] 数据: _specialThanksCredits@0xA0=" + (stc && !stc.isNull() ? stc : "null") + " _specialThanksOrders@0x98=" + (sto && !sto.isNull() ? sto : "null"));
                        }
                    }
                    info("[v3][Credit] 原版 _creditsDirectors[" + len + "] = " + parts.join(" | "));
                }
            }
        }
        catch (e) {
            warn("[v3][Credit] 原版 director 诊断 err: " + e);
        }
        // 触发原版演出 (run-23): 原版 @credit = Preload → Play, 但 invoke 必须在主线程 —
        //   JS 线程 (setTimeout 回调) 调 Unity API 会 breakpoint triggered; 用 nani 轮询 @set
        //   g_creditTick 作泵, 在 onSVV (主线程同步 hook) 里完成 PlayAsync。
        //   Preload 同步触发 (run-22 已验证: 300ms 内 _specialThanksCredits 填充)。
        writeVar("g_creditDone", 0);
        creditT0 = Date.now();
        var tok = Memory.alloc(32);
        tok.writeU64(0);
        tok.add(8).writeU64(0);
        tok.add(16).writeU64(0);
        tok.add(24).writeU64(0);
        pendingPlay = { ui: ui, tok: tok, t0: creditT0 };
        var preMi = A.cgm(cls.creditsUI, Memory.allocUtf8String("PreloadResourcesAsync"), 2);
        if (preMi && !preMi.isNull()) {
            var rp = invokeOk(preMi, ui, [iPtr(2), tok]);
            if (!rp.ok)
                warn("[v3][Credit] PreloadResourcesAsync(2) invoke FAIL — SpecialThanks 可能空白");
            else
                info("[v3][Credit] 原版复刻: PreloadResourcesAsync(2) 已触发 (stills/SpecialThanks 资产加载中) — 等 nani 泵触发 PlayAsync(主线程)");
        }
        else {
            warn("[v3][Credit] 原版复刻: PreloadResourcesAsync NOT FOUND — 跳过 Preload 直接等泵");
        }
        writeVar("g_thanksDuration", 240); // 兜底参考值 (完成信号才是主协议)
    }
    catch (e) {
        error("[v3][Credit] doOriginal err: " + e);
        writeVar("g_thanksDuration", 5);
    }
}
// ============ phase=2: special thanks ============
function thanksLocales() {
    var j = creditState.json;
    if (!j || !j.thanks)
        return [];
    var out = [];
    for (var k in j.thanks) {
        if (k !== "order" && j.thanks[k] && Array.isArray(j.thanks[k].pages) && j.thanks[k].pages.length)
            out.push(k);
    } // run-29: pages (页=富文本行[])
    return out;
}
// run-29: 共犯翻页原版参数 (场景实例即 prefab 克隆, 字段直读):
//   rollThanks._delayBeforeCreditsCoefficient@0x60 — 标题"共犯者"展示时长 (单位=拍)
//   director._specialThanksFadeUnits@0x78 / _specialThanksDisplayUnits@0x7C — 翻页 fade/display (拍)
//   director._specialThanksOrderData@0x80 — 每语种播放顺序 (SpecialThanksOrderData{_localeKind@0x10,_order@0x18 LocaleKind[]})
//   拍→秒 = units × 60/bpm (_bgmBpm@0x30)
function readThanksTiming() {
    try {
        if (comp.thanksTiming)
            return comp.thanksTiming;
        var t = { delayCoef: -1, fadeUnits: -1, displayUnits: -1, bpm: 0, orders: null };
        var d = (comp.director && !comp.director.isNull()) ? comp.director : null;
        if (!d) {
            var dR = findRollsStaged(cls.director, "CreditsDirectorAct2");
            for (var i = 0; i < (dR.objs || []).length && !d; i++) {
                if (dR.objs[i] && !dR.objs[i].isNull())
                    d = dR.objs[i];
            }
        }
        if (d) {
            t.fadeUnits = d.add(0x78).readFloat();
            t.displayUnits = d.add(0x7C).readFloat();
            t.bpm = d.add(0x30).readFloat();
            // _specialThanksOrderData@0x80: 每语种 {_localeKind, _order: LocaleKind[]}
            try {
                var arr = d.add(0x80).readPointer();
                if (arr && !arr.isNull()) {
                    var len = arr.add(0x18).readS32();
                    if (len > 0 && len < 8) {
                        t.orders = {};
                        for (var i2 = 0; i2 < len; i2++) {
                            var e = arr.add(0x20 + i2 * 8).readPointer();
                            if (!e || e.isNull())
                                continue;
                            var lv = e.add(0x10).readS32();
                            var oarr = e.add(0x18).readPointer();
                            if (!oarr || oarr.isNull())
                                continue;
                            var olen = oarr.add(0x18).readS32();
                            var seq = [];
                            for (var j = 0; j < olen && j < 8; j++)
                                seq.push(oarr.add(0x20 + j * 4).readS32());
                            t.orders[lv] = seq;
                        }
                    }
                }
            }
            catch (e2) {
                warn("[v3][Credit] order 读取 err: " + e2);
            }
        }
        if (comp.rollThanks && !comp.rollThanks.isNull()) {
            t.delayCoef = comp.rollThanks.add(0x60).readFloat();
            // _lineSpacingsByLevel@0x50 float[] (行距, 静态实证 [-25,10,100])
            try {
                var larr = comp.rollThanks.add(0x50).readPointer();
                if (larr && !larr.isNull()) {
                    var llen = larr.add(0x18).readS32();
                    if (llen > 0 && llen < 16) {
                        t.lineSpacings = [];
                        for (var li = 0; li < llen; li++)
                            t.lineSpacings.push(larr.add(0x20 + li * 4).readFloat());
                    }
                }
            }
            catch (eL) {
                warn("[v3][Credit] lineSpacings 读取 err: " + eL);
            }
        }
        comp.thanksTiming = t;
        var orderStr = "?";
        if (t.orders) {
            var ps = [];
            for (var lk in t.orders)
                ps.push(lk + "→[" + t.orders[lk].join(",") + "]");
            orderStr = ps.join(" ");
        }
        info("[v3][Credit] 共犯原版参数: thanksUnits(fade/display)=" + t.fadeUnits.toFixed(2) + "/" + t.displayUnits.toFixed(2)
            + " bpm=" + t.bpm.toFixed(2) + " delayCoef=" + t.delayCoef.toFixed(2)
            + " lineSpacings=[" + (t.lineSpacings ? t.lineSpacings.join(",") : "?") + "] orders=" + orderStr);
        return t;
    }
    catch (e) {
        warn("[v3][Credit] readThanksTiming err: " + e);
        comp.thanksTiming = { delayCoef: -1, fadeUnits: -1, displayUnits: -1, bpm: 0, orders: null };
        return comp.thanksTiming;
    }
}
// run-29: 共犯翻页自实现 (不调原版 ShowAsync) — 原版 ShowAsync 内部按课程档位索引
//   _maxLabelSizesByLevel@0x40 等数组 (dump.cs:11233 CreditRollSpecialThanks), mod 页数 (72) 远超
//   原版档位数 → 播几页后 IndexOutOfRangeException → 演出中断 (共犯者消失/无名单, 14:58:58 实证);
//   且原版只操作当前语种标签, prefab 两语种标签默认全 active → 双 Special Thanks 叠印。
// 自翻页 (run-29 按原版实证重构):
//   标题时序: _startLabel@0x30 (共犯者) fade in → display (delayCoef 拍) → fade out → 才开始翻页
//   (用户实测: 标题展示完成后即消失, 非全程常驻);
//   名单呈现 = 逐行累积追加 (运行时采样 42 条 = 42 行实证): 每行 = 完整富文本
//   (<size=1.7em>名字</size><space=80>... 同行多名字, <br> 换行), 行内排版由富文本原样复刻;
//   只激活当前语种标签 (防叠印)。节奏 = 原版拍数换算 (fadeUnits/displayUnits × 拍长)。
function activateThanksLocale(lv) {
    try {
        for (var lk in comp.thanksByLocale) {
            var entry = comp.thanksByLocale[lk];
            if (!entry || !entry.label || entry.label.isNull())
                continue;
            var on = (parseInt(lk, 10) === lv);
            var goR = invokeOk(cgmChain(A.ogc(entry.label), "get_gameObject", 0), entry.label, []);
            if (goR.ok && goR.ret && !goR.ret.isNull()) {
                invoke(cgmChain(A.ogc(goR.ret), "SetActive", 1), goR.ret, [boolPtr(on)]);
                if (!on) {
                    if (deactivatedLabels.indexOf(goR.ret) < 0)
                        deactivatedLabels.push(goR.ret);
                } // 结束还原
            }
        }
    }
    catch (e) {
        warn("[v3][Credit] activateThanksLocale err: " + e);
    }
}
function thanksTick() {
    try {
        var p = comp.thanksPaging;
        if (!p)
            return;
        var now = Date.now();
        var el = now - p.stepStart;
        if (p.state === "title_fadein") { // 共犯者标题 fade in
            if (!p.cg || p.cg.isNull()) {
                p.state = "title_display";
                p.stepStart = now;
                return;
            }
            invoke(cgmChain(A.ogc(p.cg), "set_alpha", 1), p.cg, [fPtr(Math.min(1, el / p.fadeMs))]);
            if (el >= p.fadeMs) {
                p.state = "title_display";
                p.stepStart = now;
            }
        }
        else if (p.state === "title_display") { // 标题展示 (delayCoef 拍)
            if (el >= p.titleMs) {
                p.state = "title_fadeout";
                p.stepStart = now;
            }
        }
        else if (p.state === "title_fadeout") { // 标题 fade out → 开始翻页
            invoke(cgmChain(A.ogc(p.cg), "set_alpha", 1), p.cg, [fPtr(Math.max(0, 1 - el / p.fadeMs))]);
            if (el >= p.fadeMs) {
                p.idx = 0;
                thanksEnterPage(p);
                p.state = "page_fadein";
                p.stepStart = now;
            }
        }
        else if (p.state === "page_fadein") { // run-30c: 整页 fade in (文本已 set)
            if (!p.cg || p.cg.isNull()) {
                p.state = "page_display";
                p.stepStart = now;
                return;
            }
            invoke(cgmChain(A.ogc(p.cg), "set_alpha", 1), p.cg, [fPtr(Math.min(1, el / p.fadeMs))]);
            if (el >= p.fadeMs) {
                p.state = "page_display";
                p.stepStart = now;
            }
        }
        else if (p.state === "page_display") { // 整页展示 → fade out
            if (el >= p.displayMs) {
                p.state = "page_fadeout";
                p.stepStart = now;
            }
        }
        else if (p.state === "page_fadeout") { // 整页 fade out → 下一页
            invoke(cgmChain(A.ogc(p.cg), "set_alpha", 1), p.cg, [fPtr(Math.max(0, 1 - el / p.fadeMs))]);
            if (el >= p.fadeMs) {
                p.idx++;
                if (p.idx >= p.pages.length) {
                    info("[v3][Credit] 共犯翻页完成 " + p.nPages + " 页 (zh+ja 合并完整名单)");
                    stopThanks();
                    // run-30f: Production 段改主线程泵 — thanksTick 是 JS 定时器线程, 直接调
                    //   get_ContentHeight/ScrollAsync = "breakpoint triggered" (run-23 同款实证:
                    //   引擎级 Unity API 必须在 onSVV 主线程同步 hook 执行); 置标志, 下一轮
                    //   nani 轮询 @set g_creditTick 时由 onSVV 泵执行 doProduction (完成后写 g_creditDone)
                    creditState.pendingProduction = true;
                    return;
                }
                thanksEnterPage(p);
                p.state = "page_fadein";
                p.stepStart = now;
            }
        }
    }
    catch (e) {
        warn("[v3][Credit] thanksTick err: " + e);
        stopThanks();
    }
}
// run-30c: 进入整页 — 整页文本 (页内行 join '<br>') 一次 set + 切语种换标签 + 档位行距
function thanksEnterPage(p) {
    try {
        var nx = p.pages[p.idx];
        if (p.idx > 0 && nx.lv !== p.pages[p.idx - 1].lv)
            activateThanksLocale(nx.lv); // 切语种 → 换标签
        try {
            thanksSetLineSpacing(nx.label, nx.firstLine, p.lineSpacings);
            invoke(cgmChain(A.ogc(nx.label), "set_Text", 1), nx.label, [makeS(nx.text)]);
        }
        catch (e) {
            warn("[v3][Credit] thanks set_Text err: " + e);
        }
        p.label = nx.label;
        p.tmp = nx.tmp;
        p.cg = nx.cg;
        if (p.cg && !p.cg.isNull()) {
            try {
                invoke(cgmChain(A.ogc(p.cg), "set_alpha", 1), p.cg, [fPtr(0)]);
            }
            catch (e) { }
        }
    }
    catch (e) {
        warn("[v3][Credit] thanksEnterPage err: " + e);
    }
}
// run-30e: Production 段 (製作・販売/Acacia/© 2024) — 共犯 36 屏之后的最后一段滚动。
//   原版 PlayAsync 遍历 _creditRolls@0x60 (CreditRoll[]): Staffs/Production 都是
//   CreditRollVerticalScroll, 依次 ScrollAsync(ContentHeight/_scrollSpeed)。
//   Production 的 3 条文本 = prefab 静态默认 (credits-tree 实证: Roll_49/Name_50/Name_34),
//   不需要运行时填充 — 只激活 + 滚动。
function findProductionRoll() {
    try {
        var ui = comp.creditsUI;
        if (!ui || ui.isNull()) {
            warn("[v3][Credit] findProductionRoll: creditsUI 不可得");
            return null;
        }
        var goR = invokeOk(cgmChain(A.ogc(ui), "get_gameObject", 0), ui, []);
        if (!goR.ok || goR.ret.isNull()) {
            warn("[v3][Credit] findProductionRoll: GO 不可得");
            return null;
        }
        var arr = invokeOk(cgmChain(A.ogc(goR.ret), "GetComponentsInChildren", 2), goR.ret, [A.tgo(A.cgt(cls.rollScroll)), boolPtr(true)]);
        if (!arr.ok || !arr.ret || arr.ret.isNull()) {
            warn("[v3][Credit] findProductionRoll: GCI 失败");
            return null;
        }
        var len = arr.ret.add(0x18).readS32();
        var names = [];
        for (var i = 0; i < len; i++) {
            var e = arr.ret.add(0x20 + i * 8).readPointer();
            if (!e || e.isNull())
                continue;
            var go = invokeOk(cgmChain(A.ogc(e), "get_gameObject", 0), e, []);
            var nm = (go.ok && !go.ret.isNull()) ? getGoName(go.ret) : "?";
            names.push(nm);
            if (nm === "Production") {
                info("[v3][Credit] Production roll 找到: " + e + " (ScrollRect 全部: " + names.join(",") + ")");
                return e;
            }
        }
        warn("[v3][Credit] findProductionRoll: 未找到 Production GO, ScrollRect 组件 GO 名: " + names.join(","));
        return null;
    }
    catch (e) {
        warn("[v3][Credit] findProductionRoll err: " + e);
        return null;
    }
}
function doProduction() {
    try {
        if (!creditState.armed) {
            writeVar("g_creditDone", 1);
            return;
        }
        var prod = findProductionRoll();
        if (!prod || prod.isNull()) {
            warn("[v3][Credit] Production 段跳过 (组件未找到) — 直接完成");
            writeVar("g_creditDone", 1);
            return;
        }
        var ks = A.ogc(prod);
        info("[v3][Credit] Production 组件=" + prod + " 类=" + clsName(ks) + " (主线程泵执行)");
        invoke(cgmChain(ks, "SetGameObjectActive", 1), prod, [boolPtr(true)]);
        invoke(cgmChain(ks, "SetCanvasEnabled", 1), prod, [boolPtr(true)]);
        try {
            ensureHierarchy();
            ensureCanvasRenderable();
        }
        catch (e2) { }
        var h = dcFloat(cgmChain(ks, "get_ContentHeight", 0), prod);
        var timing = readDirectorTiming();
        var speed = (timing && timing.speed > 0) ? timing.speed
            : ((creditState.json && creditState.json.staff && creditState.json.staff.speed > 0) ? creditState.json.staff.speed : 248);
        var dur = (h > 0) ? h / speed : 3;
        var saMi = A.cgm(ks, Memory.allocUtf8String("ScrollAsync"), 2);
        var sr = invokeOk(saMi, prod, [fPtr(dur), zeroCT()]);
        info("[v3][Credit] Production 段: 高度=" + h.toFixed(0) + "px duration=" + dur.toFixed(1) + "s speed=" + speed.toFixed(0) + " ScrollAsync=" + (sr.ok ? "OK" : "FAIL"));
        // 完成后写 phase=2 完成信号 (滚动 + 2s 缓冲)
        setTimeout(function () {
            try {
                writeVar("g_creditDone", 1);
                info("[v3][Credit] Production 段完成 — g_creditDone=1");
            }
            catch (e3) {
                warn("[v3][Credit] Production 完成信号 err: " + e3);
            }
        }, (dur + 0.5) * 1000); // run-30g: 缓冲 2→0.5s (对齐原版连续节奏)
    }
    catch (e) {
        error("[v3][Credit] doProduction err: " + e);
        writeVar("g_creditDone", 1);
    }
}
// run-29: 行距按档位 — 行富文本 <size=Xem> → 档 (1.7em→2/1.3em→1/1em→0) → _lineSpacingsByLevel
//   (原版每页 SetLineSpacing(档位行距); 富文本里没有行距, 不设则默认行距)
function thanksSetLineSpacing(label, text, lineSpacings) {
    try {
        if (!label || label.isNull() || !lineSpacings || !lineSpacings.length)
            return;
        var em = lineEm(text);
        if (em === null)
            return;
        var lvl = em >= 1.6 ? 2 : (em >= 1.2 ? 1 : 0);
        if (lineSpacings[lvl] === undefined)
            return;
        invoke(cgmChain(A.ogc(label), "SetLineSpacing", 1), label, [fPtr(lineSpacings[lvl])]);
    }
    catch (e) {
        warn("[v3][Credit] SetLineSpacing err: " + e);
    }
}
function stopThanks() {
    try {
        if (comp.thanksPaging && comp.thanksPaging.timer) {
            clearInterval(comp.thanksPaging.timer);
        }
        comp.thanksPaging = null;
    }
    catch (e) { }
}
function doThanks() {
    try {
        if (!creditState.armed) {
            writeVar("g_thanksDuration", 5);
            return;
        }
        stopStills(); // run-26: phase1 滚动结束 → still 收尾 (fade 0 + 停定时器)
        if (!ensureThanks()) {
            warn("[v3][Credit] phase=2 跳过: rollThanks 未捕获/失效 (见上方捕获诊断)");
            writeVar("g_thanksDuration", 5);
            return;
        }
        ensureCanvasRenderable(); // 与 phase=1 共享同一 canvas, 幂等
        var jt = creditState.json.thanks;
        var locales = thanksLocales();
        if (!locales.length) {
            warn("[v3][Credit] phase=2 跳过: json.thanks 无可用语种");
            writeVar("g_thanksDuration", 5);
            return;
        }
        // run-29: order — 优先原版 _specialThanksOrderData (每语种一序, 当前语种优先), 兜底 json.order, 再回退当前语言
        var tt = readThanksTiming();
        var orderList = [];
        var curLoc = getCurrentLocale();
        var curLv = localeKindValue(curLoc);
        if (tt && tt.orders && curLv !== null && tt.orders[curLv]) {
            for (var oi0 = 0; oi0 < tt.orders[curLv].length; oi0++) {
                var ln = localeName(tt.orders[curLv][oi0]);
                if (ln && locales.indexOf(ln) >= 0 && orderList.indexOf(ln) < 0)
                    orderList.push(ln);
            }
            if (orderList.length)
                info("[v3][Credit] order=原版(当前语种 " + curLoc + " 优先): " + orderList.join("→"));
        }
        if (!orderList.length && Array.isArray(jt.order)) {
            for (var i = 0; i < jt.order.length; i++) {
                if (locales.indexOf(jt.order[i]) >= 0 && orderList.indexOf(jt.order[i]) < 0)
                    orderList.push(jt.order[i]);
            }
        }
        if (!orderList.length) {
            orderList = locales.indexOf(curLoc) >= 0 ? [curLoc] : [locales[0]];
            dbg("[v3][Credit] order 回退当前语言: " + orderList.join(","));
        }
        // 语种标签 — _labelsByLocale@0x38 序列化数组开机即有 (不依赖 ShowAsync)
        if (!comp.thanksByLocale || !Object.keys(comp.thanksByLocale).length)
            enumerateThanksLabels();
        // run-30c: 组装页序列 pages [{lv,label,tmp,cg,text,firstLine}] — 页级显示 (原版实证):
        //   每页 = 整屏, 页内行 1-2ms 瞬时构建 (逐条 set_text), 页间 ~3.3s (REPL→REPL 实测 3298-3332ms)。
        //   整页文本 = 页内行 join '<br>' 一次 set — 原版富文本排版原样还原。
        //   缺标签的语种跳过 (枚举日志见上)
        var pages = [], labelInfo = [], nPages = 0;
        for (var oi = 0; oi < orderList.length; oi++) {
            var loc = orderList[oi];
            var lv = localeKindValue(loc);
            if (lv === null)
                continue;
            var entry = comp.thanksByLocale ? comp.thanksByLocale[lv] : null;
            if (!entry || !entry.label || entry.label.isNull()) {
                warn("[v3][Credit] 语种标签缺失 localeKind=" + lv + " (见上枚举日志) — 该语种跳过");
                continue;
            }
            var pgList = (jt[loc] && Array.isArray(jt[loc].pages)) ? jt[loc].pages : null;
            if (!pgList) {
                warn("[v3][Credit] 语种 " + loc + " 无 pages (需 run-29 格式)");
                continue;
            }
            nPages += pgList.length;
            for (var pi = 0; pi < pgList.length; pi++) {
                var pg = pgList[pi];
                if (!Array.isArray(pg))
                    pg = [String(pg)];
                pages.push({ lv: lv, label: entry.label, tmp: entry.tmp, cg: entry.cg,
                    text: pg.join("<br>"), firstLine: String(pg[0]) });
            }
            if (jt[loc].label)
                labelInfo.push(loc + "='" + jt[loc].label + "'");
        }
        if (!pages.length) {
            warn("[v3][Credit] phase=2 跳过: 翻页序列为空");
            writeVar("g_thanksDuration", 5);
            return;
        }
        // run-29: 原版参数 — fade/display 拍数 + 标题"共犯者"延迟系数 (拍), 异常回退固定值
        var beat = (tt && tt.bpm > 0) ? 60 / tt.bpm : 0.68;
        var fadeMs = 400, displayMs = 1280, titleMs = 4000;
        if (tt && tt.fadeUnits >= 0 && tt.bpm > 0)
            fadeMs = Math.max(200, tt.fadeUnits * beat * 1000);
        if (tt && tt.displayUnits >= 0 && tt.bpm > 0)
            displayMs = Math.max(500, tt.displayUnits * beat * 1000);
        if (tt && tt.delayCoef > 0 && tt.bpm > 0)
            titleMs = tt.delayCoef * beat * 1000;
        titleMs = Math.min(Math.max(titleMs, 1500), 10000);
        var kts = A.ogc(comp.rollThanks);
        invoke(cgmChain(kts, "SetGameObjectActive", 1), comp.rollThanks, [boolPtr(true)]);
        invoke(cgmChain(kts, "SetCanvasEnabled", 1), comp.rollThanks, [boolPtr(true)]);
        ensureHierarchy();
        // run-28: 只激活当前语种标签 (防叠印 — 原版 prefab 两语种全 active)
        activateThanksLocale(pages[0].lv);
        // 标题"共犯者" (_startLabel@0x30 SpecialThanksLabel) — run-29: fade in → display → fade out → 翻页
        var startLbl = comp.rollThanks.add(0x30).readPointer();
        var startCg = (startLbl && !startLbl.isNull()) ? startLbl.add(0x28).readPointer() : null;
        // 诊断: 当前语种翻页标签 rect 尺寸 (对照原版 _maxLabelSizesByLevel 1920-2320 宽)
        try {
            var rtr = invokeOk(cgmChain(A.ogc(pages[0].tmp), "get_rectTransform", 0), pages[0].tmp, []);
            if (rtr.ok && rtr.ret && !rtr.ret.isNull()) {
                var sdr = invokeOk(cgmChain(A.ogc(rtr.ret), "get_sizeDelta", 0), rtr.ret, []);
                if (sdr.ok && sdr.ret && !sdr.ret.isNull()) {
                    info("[v3][Credit] 翻页标签 sizeDelta=" + sdr.ret.add(0).readFloat().toFixed(0) + "x" + sdr.ret.add(4).readFloat().toFixed(0) + " (原版 _maxLabelSizesByLevel 1920-2320 宽)");
                }
            }
        }
        catch (eR) {
            warn("[v3][Credit] rect 诊断 err: " + eR);
        }
        // run-30c: 翻页状态机 (标题阶段 + 页级: 整页一次 set, fade in → display → fade out, ~3.3s/页)
        stopThanks(); // 幂等: 上一轮残留清理
        comp.thanksPaging = { pages: pages, nPages: nPages, idx: -1, acc: "",
            state: "title_fadein", stepStart: Date.now(),
            fadeMs: fadeMs, displayMs: displayMs, titleMs: titleMs,
            lineSpacings: (tt && tt.lineSpacings) ? tt.lineSpacings : null,
            label: startLbl, cg: startCg, timer: null };
        try {
            if (startCg && !startCg.isNull())
                invoke(cgmChain(A.ogc(startCg), "set_alpha", 1), startCg, [fPtr(0)]);
            if (pages[0].cg && !pages[0].cg.isNull())
                invoke(cgmChain(A.ogc(pages[0].cg), "set_alpha", 1), pages[0].cg, [fPtr(0)]);
        }
        catch (e) {
            warn("[v3][Credit] 标题/首页 alpha 置零 err: " + e);
        }
        comp.thanksPaging.timer = setInterval(thanksTick, 25); // run-30g: 50→25ms 粒度 (每屏 tick 误差 ~0.1s→~0.05s)
        var dur = titleMs / 1000 + nPages * (fadeMs + displayMs + fadeMs) / 1000 + 0.5; // run-30g: 缓冲 2.4→0.5s (对齐原版总长)
        writeVar("g_thanksDuration", dur);
        info("[v3][Credit] 共犯翻页 (自实现, " + orderList.length + " 语种, " + nPages
            + " 页, order=" + orderList.join("→") + (labelInfo.length ? ", label " + labelInfo.join(" ") : "")
            + ", 标题=" + (titleMs / 1000).toFixed(1) + "s, 页间=" + ((fadeMs + displayMs + fadeMs) / 1000).toFixed(2) + "s, fade=" + (fadeMs / 1000).toFixed(2) + "s, display=" + (displayMs / 1000).toFixed(2) + "s)"
            + " 首页='" + pages[0].text.slice(0, 40) + "' g_thanksDuration=" + dur.toFixed(1) + "s");
        dumpThanksTMPs(kts);
    }
    catch (e) {
        error("[v3][Credit] doThanks err: " + e);
        stopThanks();
        writeVar("g_thanksDuration", 5);
    }
}
// 诊断: rollThanks 子树 TMP (原版 label/标题结构 — v1 不写 label 字段, 结构留待后续版本)
function dumpThanksTMPs(kt) {
    try {
        var go = invokeOk(cgmChain(kt, "get_gameObject", 0), comp.rollThanks, []);
        if (!go.ok || go.ret.isNull())
            return;
        var arr = invokeOk(cgmChain(A.ogc(go.ret), "GetComponentsInChildren", 2), go.ret, [A.tgo(A.cgt(cls.tmpText)), boolPtr(true)]);
        if (!arr.ok || !arr.ret || arr.ret.isNull())
            return;
        var len = arr.ret.add(0x18).readS32();
        var parts = [];
        for (var i = 0; i < len && i < 8; i++) {
            var e = arr.ret.add(0x20 + i * 8).readPointer();
            if (!e || e.isNull())
                continue;
            var tx = invokeOk(cgmChain(A.ogc(e), "get_text", 0), e, []);
            var s = tx.ok ? readStr(tx.ret) : null;
            parts.push("#" + i + "='" + (s || "") + "'/" + getFontName(e));
        }
        dbg("[v3][Credit] thanks TMP 子树 (" + len + "): " + parts.join(" | "));
    }
    catch (e) { }
}
// ============ phase=3: end 清理 ============
function doEnd() {
    try {
        if (!creditState.armed)
            return; // 未 arm 无事可清 (存档回放防御)
        if (creditState.original) {
            // run-15: 原版复刻模式 — 原版 PlayAsync 自清理 (ChangeActivity/Stop), 我们什么都没动;
            //   只调原版 CreditsUI.Stop() 兜底 (防演出未播完被脚本切走) + disarm
            if (comp.creditsUI && !comp.creditsUI.isNull()) {
                var stMi = A.cgm(cls.creditsUI, Memory.allocUtf8String("Stop"), 0);
                if (stMi && !stMi.isNull())
                    invoke(stMi, comp.creditsUI, []);
            }
            //[run-25-废弃]             flushStaffJson();   // run-24-5: EndCredits2 标签接管收尾路径也落盘 (Resume 打断轮询循环后走这里)
            creditState.armed = false;
            creditState.phase = 0;
            info("[v3][Credit] end (原版模式): CreditsUI.Stop 兜底 + disarm");
            return;
        }
        if (isThanksRoll(comp.rollThanks)) {
            var lbl = comp.rollThanks.add(0x70).readPointer();
            if (!lbl || lbl.isNull()) {
                dbg("[v3][Credit] end: _labels 未初始化, 跳过 Clear (run-8: null 时 Clear 抛异常)");
            }
            else {
                var kt = A.ogc(comp.rollThanks);
                var cr = invokeOk(cgmChain(kt, "Clear", 0), comp.rollThanks, []);
                if (!cr.ok)
                    warn("[v3][Credit] SpecialThanks.Clear FAIL");
            }
        }
        var roll = (!comp.rollScroll || comp.rollScroll.isNull()) ? comp.rollThanks : comp.rollScroll;
        if (roll && !roll.isNull()) {
            invoke(cgmChain(A.ogc(roll), "DisableCanvas", 0), roll, []);
        }
        // run-11: 还原单标签模式停用的非当前语种标签
        for (var i = 0; i < deactivatedLabels.length; i++) {
            try {
                invoke(cgmChain(A.ogc(deactivatedLabels[i]), "SetActive", 1), deactivatedLabels[i], [boolPtr(true)]);
            }
            catch (e) { }
        }
        deactivatedLabels = [];
        stopStills(); // run-26: still 定时器/alpha 收尾 + run-31: 恢复原版 sprite
        clearStillCaches(); // run-31: 清自定义 sprite/纹理缓存 (Unity GC 回收)
        stopThanks(); // run-28: 共犯翻页定时器收尾
        restoreAncestors();
        creditState.armed = false;
        creditState.phase = 0;
        info("[v3][Credit] end: 清理完成 (Clear/DisableCanvas/还原祖先, 已 disarm)");
    }
    catch (e) {
        error("[v3][Credit] doEnd err: " + e);
    }
}
// 剧本切换/回标题 → 演出中止 (F3): 清残留 + disarm
function abortCredit(reason) {
    warn("[v3][Credit] 演出中止: " + reason);
    if (creditState.original) {
        // run-15: 原版模式 — 原版演出还在跑, 用原版 CreditsUI.Stop() 中止
        try {
            if (comp.creditsUI && !comp.creditsUI.isNull()) {
                var stMi = A.cgm(cls.creditsUI, Memory.allocUtf8String("Stop"), 0);
                if (stMi && !stMi.isNull())
                    invoke(stMi, comp.creditsUI, []);
            }
        }
        catch (e) { }
        creditState.armed = false;
        creditState.phase = 0;
        return;
    }
    try {
        if (isThanksRoll(comp.rollThanks)) {
            var lbl2 = comp.rollThanks.add(0x70).readPointer();
            if (lbl2 && !lbl2.isNull())
                invoke(cgmChain(A.ogc(comp.rollThanks), "Clear", 0), comp.rollThanks, []);
        }
    }
    catch (e) { }
    try {
        var roll = (!comp.rollScroll || comp.rollScroll.isNull()) ? comp.rollThanks : comp.rollScroll;
        if (roll && !roll.isNull())
            invoke(cgmChain(A.ogc(roll), "DisableCanvas", 0), roll, []);
    }
    catch (e) { }
    stopStills(); // run-26: still 定时器/alpha 收尾 + run-31: 恢复原版 sprite
    clearStillCaches(); // run-31: 清自定义 sprite/纹理缓存
    stopThanks(); // run-28: 共犯翻页定时器收尾
    restoreAncestors();
    creditState.armed = false;
    creditState.phase = 0;
}
// ============ SetVariableValue hook (独立 attach, 与 CutIn/其他 handler 分离 — F13) ============
function onSVV(a) {
    try {
        var name = readStr(a[1]);
        if (!name)
            return;
        if (!mgr || mgr.isNull())
            mgr = a[0];
        var vp = a[2];
        var type = vp ? vp.readS32() : -1;
        if (name === "g_modCreditRoll") {
            var str = type === 0 ? readStr(vp.add(0x8).readPointer()) : null;
            if (!str) {
                warn("[v3][Credit] trigger: g_modCreditRoll 值非字符串, 忽略");
                return;
            }
            var ok = loadCreditData(str);
            creditState.armed = ok; // json 无效 → 不 arm, phase 走安全时长
            info("[v3][Credit] trigger '" + str + "' → " + (ok ? "已武装" : "json 无效 (时间线将走安全默认时长)") +
                " | 捕获状态: scroll=" + (comp.rollScroll ? "有" : "无") + " thanks=" + (comp.rollThanks ? "有" : "无") +
                " dict=" + (comp.dictCls ? "有" : "无") + " ui=" + (comp.creditsUI ? "有" : "无"));
        }
        else if (name === "g_modCreditRollPhase") {
            var phase = type === 1 ? vp.add(0x10).readFloat() : NaN;
            if (phase !== 1 && phase !== 2 && phase !== 3)
                return;
            if (!creditState.armed) {
                // 未 arm (json 失败/存档回放/中止后): 仍写安全时长, nani @Wait 永不悬挂 (R4)
                if (phase === 1)
                    writeVar("g_staffDuration", 3);
                else if (phase === 2)
                    writeVar("g_thanksDuration", 5);
                dbg("[v3][Credit] phase=" + phase + " 忽略 (未 arm — 存档回放/json 失败防御)");
                return;
            }
            creditState.phase = phase;
            dbg("[v3][Credit] phase=" + phase + " @" + (Date.now() % 100000) + "ms");
            if (phase === 1) {
                // run-30: 原版模式 phase=1 无自定义 staff — 滚动由 PlayAsync 全流程驱动, 立即进入 phase=2
                if (creditState.original) {
                    writeVar("g_staffDuration", 0);
                    dbg("[v3][Credit] 原版模式 phase=1: PlayAsync 驱动滚动, g_staffDuration=0");
                }
                else
                    doStaff();
            }
            else if (phase === 2) {
                if (creditState.original)
                    doOriginal();
                else
                    doThanks();
            }
            else if (phase === 3)
                doEnd();
        }
        else if (name === "g_creditTick") {
            // run-23: 主线程泵 — nani 轮询每轮 @set g_creditTick, 在同步 hook 里完成 PlayAsync
            if (creditState.original && pendingPlay)
                doPlayAsyncInvoke();
            // run-30f: Production 段 — 共犯完成置 pendingProduction 后, 主线程执行 doProduction
            //   (JS 线程调 get_ContentHeight/ScrollAsync = breakpoint triggered)
            if (creditState.pendingProduction) {
                creditState.pendingProduction = false;
                doProduction();
            }
        }
    }
    catch (e) {
        error("[v3][Credit] onSVV err: " + e);
    }
}
// ============ 捕获钩子 ============
function onDirectorPlay(a) { try {
    captureFromDirector(a[0], "director.PlayAsync");
}
catch (e) { } }
function onDirectorAwake(a) { try {
    captureFromDirector(a[0], "director.Awake");
}
catch (e) { } }
function onCreditsUIPlayEnter(a) {
    try {
        if (!comp.creditsUI || comp.creditsUI.isNull()) {
            comp.creditsUI = a[0];
            info("[v3][Credit] CreditsUI 实例已捕获 (PlayAsync): " + a[0]);
        }
    }
    catch (e) { }
}
function onCreditsUIPlayLeave() {
    try {
        scanUiRolls(comp.creditsUI, "PlayAsync后");
    }
    catch (e) { }
}
function onScrollAsync(a) {
    try {
        if (creditState.phase === 1)
            return; // 我方 phase=1 的调用
        captureRolls(a[0], "原版 ScrollAsync");
    }
    catch (e) { }
}
function onShowAsync(a) {
    try {
        // dict 类兜底偷取 (任何 ShowAsync, 含我方 — 我方首次调用也偷得到, 后续 run 自愈)
        if (!comp.dictCls) {
            var d = a[1];
            if (d && !d.isNull()) {
                var dk = A.ogc(d);
                if (clsName(dk).indexOf("ReadOnlyDictionary") >= 0) {
                    var inner = d.add(0x18).readPointer();
                    if (inner && !inner.isNull())
                        dk = A.ogc(inner);
                }
                comp.dictCls = dk;
                info("[v3][Credit] 偷 dict 类 = " + clsName(dk));
            }
        }
        if (creditState.phase === 2)
            return; // 我方 phase=2 的调用
        captureRolls(a[0], "原版 ShowAsync");
    }
    catch (e) {
        warn("[v3][Credit] onShowAsync err: " + e);
    }
}
// ScriptLoader.Load → 剧本切换 (goto/读档回放) = 演出中止 (F3; 存档回放变量如经 SetVariableValue
// 重放, 恢复顺序在 load 前后都会在此被拦 — 探针未实测回放路径, 首次实机验证)
function onScriptLoad(a) {
    try {
        if (creditState.armed)
            abortCredit("剧本切换 '" + (readStr(a[1]) || "?") + "'");
    }
    catch (e) { }
}
// ============ 入口 ============
export function setupCreditHooks() {
    try {
        if (creditHooksReady)
            return;
        if (!resolveCreditClasses())
            return;
        // run-9 修复: 不再在启动期解析 dict 类 — dictClsViaReflection 开机执行时 access violation
        //   (访问违规被 catch, 但已损坏 IL2CPP 元数据状态 → 引擎初始化死锁 → 程序未响应)。
        //   dict 类延迟到 doThanks (phase=2, 引擎完全启动后) 首次 resolveDictCls 才解析。
        // P1: SetVariableValue (独立 attach — F13)
        var svvMi = A.cgm(cls.customVarMgr, Memory.allocUtf8String("SetVariableValue"), 2);
        if (svvMi && !svvMi.isNull()) {
            Interceptor.attach(svvMi.readPointer(), { onEnter: function (a) { try {
                    onSVV(a);
                }
                catch (e) {
                    warn("[v3][Credit] svv hook err: " + e);
                } } });
        }
        else
            warn("[v3][Credit] SetVariableValue NOT FOUND");
        // 捕获: CreditsUI.PlayAsync (实例+onLeave 子树) + director Awake/PlayAsync + 类级 ScrollAsync/ShowAsync
        var upMi = A.cgm(cls.creditsUI, Memory.allocUtf8String("PlayAsync"), 2);
        if (upMi && !upMi.isNull())
            Interceptor.attach(upMi.readPointer(), { onEnter: onCreditsUIPlayEnter, onLeave: onCreditsUIPlayLeave });
        var dpMi = A.cgm(cls.director, Memory.allocUtf8String("PlayAsync"), 1);
        if (dpMi && !dpMi.isNull())
            Interceptor.attach(dpMi.readPointer(), { onEnter: onDirectorPlay });
        var awMi = A.cgm(cls.director, Memory.allocUtf8String("Awake"), 0);
        if (awMi && !awMi.isNull())
            Interceptor.attach(awMi.readPointer(), { onEnter: onDirectorAwake });
        var scMi = A.cgm(cls.rollScroll, Memory.allocUtf8String("ScrollAsync"), 2);
        if (scMi && !scMi.isNull())
            Interceptor.attach(scMi.readPointer(), { onEnter: onScrollAsync });
        var saMi = A.cgm(cls.rollThanks, Memory.allocUtf8String("ShowAsync"), 5);
        if (saMi && !saMi.isNull())
            Interceptor.attach(saMi.readPointer(), { onEnter: onShowAsync });
        // ScriptLoader.Load → 中止 (F3)
        var slMi = A.cgm(cls.scriptLoader, Memory.allocUtf8String("Load"), 2);
        if (slMi && !slMi.isNull())
            Interceptor.attach(slMi.readPointer(), { onEnter: onScriptLoad });
        creditHooksReady = true;
        info("[v3][Credit] 演出控制器 hooks 就绪 (触发: @set g_modCreditRoll = \"data.json\")");
    }
    catch (e) {
        warn("[v3][Credit] setupCreditHooks err: " + e);
    }
}
// 回标题清状态 (entry.js TitleUi.Activate 调用): disarm + 还原残留祖先; comp 指针保留 —
// 探针 run-3 实证跨回标题存活 (同地址), 每次使用前字段探针复核, 失效则 ensureScroll/ensureThanks 重抓
export function clearCreditCaches() {
    try {
        if (creditState.armed)
            abortCredit("回标题");
        creditState.armed = false;
        creditState.phase = 0;
        for (var i = 0; i < deactivatedLabels.length; i++) {
            try {
                invoke(cgmChain(A.ogc(deactivatedLabels[i]), "SetActive", 1), deactivatedLabels[i], [boolPtr(true)]);
            }
            catch (e) { }
        }
        deactivatedLabels = [];
        restoreAncestors();
    }
    catch (e) {
        warn("[v3][Credit] clearCreditCaches err: " + e);
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
        // texCache 按 resolved path 缓存 (同文件多 CutIn/多槽共用一份解码; 旧 cacheKey=id/vanillaName 导致同文件重复解码 6 次, 300-900ms stall)
        var ent = loadCutInTexture(reg.sprites[vanillaName].path, reg.sprites[vanillaName].path);
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
// 菜单预加载: 首次进标题时把所有 CutIn 纹理按文件去重解码进 texCache (主线程同步 hook 内调,
// 避免审判触发时 300-900ms 解码卡顿)。spriteCache 需原版 sprite 的 pivot/ppu 实例, 无法预建,
// 触发时仅剩 Sprite.Create 一次调用 (毫秒级)。
var cutInPreloadDone = false;
export function preloadCutInTextures() {
    if (cutInPreloadDone || !cutInData.ready)
        return;
    cutInPreloadDone = true;
    var paths = [];
    for (var id in cutInData.registry) {
        var reg = cutInData.registry[id];
        for (var k in reg.sprites) {
            var p = reg.sprites[k].path;
            if (paths.indexOf(p) < 0)
                paths.push(p);
        }
    }
    if (!paths.length)
        return;
    info("[v3][CutIn] 菜单预加载 " + paths.length + " 张纹理 ...");
    var ok = 0;
    for (var i = 0; i < paths.length; i++) {
        if (loadCutInTexture(paths[i], paths[i]))
            ok++;
    }
    info("[v3][CutIn] 预加载完成: " + ok + "/" + paths.length);
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
// ============ 当前游戏语言跟踪 ============
// 以 Naninovel ResourceLoader<T>.HandleLocaleChanged(locale) 的实参为准:
// 引擎切语言和启动初始化都会触发 (modlog 实证 'ja'/'zh-Hans'), 与 mod 的
// @print/@toast/@choice 双语 (追加式 |#ID|) 共用同一套语言判定。
// 2026-08-19: 试过 findSvc("LocalizationManager") + get_SelectedLocale 静默失败
// (回退 zh-Hans), 该方案被 HandleLocaleChanged 跟踪取代。
import { A, dbg, fieldOffset, findClassAcrossImages, invokeOk, readStr, wblog, warn } from "./utils.js";
var _locale = "zh-Hans";
export function setCurrentLocale(l) { if (l)
    _locale = l; }
export function getCurrentLocale() { return _locale || "zh-Hans"; }
// ============ 引擎级语言同步 (LocalizationManager 自身) ============
// 背景: HandleLocaleChanged 只在"语言实际改变"时触发 (modlog 实证) —
// 以日语启动 (从未切语言) 时引擎启动初始化不触发它, _locale 停在 zh-Hans,
// 图鉴姓名在"启动即日语"场景下仍显示中文注册名 (用户实测)。
// 修复: spawn 注入早于引擎初始化 → hook LocalizationManager 自身方法,
//   引擎初始化/读语言/切语言任一路径都会同步 _locale:
//   get_SelectedLocale onLeave — 任何读语言 (启动加载本地化资源必经) → 读返回 String
//   set_SelectedLocale / SelectLocale onEnter — 任何设语言 (切语言入口) → 读参数字符串
//   InitializeService onEnter — 拿实例, 供 syncLocaleFromEngine 主动 invoke 兜底
// (Windows C# 版镜像: Engine.GetService<ILocalizationManager>().SelectedLocale;
//  类结构 Windows dump 实证: <SelectedLocale>k__BackingField @0x20, 方法均存在)
var _lmInst = null;
var _lmHooked = false;
var _synced = false;
export function hookLocaleAccessors() {
    try {
        if (_lmHooked)
            return;
        var cls = findClassAcrossImages("Naninovel", "LocalizationManager");
        if (!cls || cls.isNull()) {
            warn("[locale] LocalizationManager class NOT FOUND");
            return;
        }
        var found = { get: false, set: false, sel: false, init: false };
        var getMi = A.cgm(cls, Memory.allocUtf8String("get_SelectedLocale"), 0);
        if (getMi && !getMi.isNull() && getMi.readPointer() && !getMi.readPointer().isNull()) {
            Interceptor.attach(getMi.readPointer(), {
                onLeave: function (ret) {
                    try {
                        if (ret && !ret.isNull())
                            setCurrentLocale(readStr(ret));
                    }
                    catch (e) { }
                }
            });
            found.get = true;
        }
        var setMi = A.cgm(cls, Memory.allocUtf8String("set_SelectedLocale"), 1);
        if (setMi && !setMi.isNull() && setMi.readPointer() && !setMi.readPointer().isNull()) {
            Interceptor.attach(setMi.readPointer(), {
                onEnter: function (a) { try {
                    setCurrentLocale(readStr(a[1]));
                }
                catch (e) { } }
            });
            found.set = true;
        }
        var selMi = A.cgm(cls, Memory.allocUtf8String("SelectLocale"), 1);
        if (selMi && !selMi.isNull() && selMi.readPointer() && !selMi.readPointer().isNull()) {
            Interceptor.attach(selMi.readPointer(), {
                onEnter: function (a) { try {
                    setCurrentLocale(readStr(a[1]));
                }
                catch (e) { } }
            });
            found.sel = true;
        }
        var initMi = A.cgm(cls, Memory.allocUtf8String("InitializeService"), 0);
        if (initMi && !initMi.isNull() && initMi.readPointer() && !initMi.readPointer().isNull()) {
            Interceptor.attach(initMi.readPointer(), {
                onEnter: function (a) { _lmInst = a[0]; }
            });
            found.init = true;
        }
        _lmHooked = found.get || found.set || found.sel;
        if (_lmHooked)
            wblog("[locale] LocalizationManager hooks 就绪: get=" + found.get + " set=" + found.set + " sel=" + found.sel + " init=" + found.init);
        else
            warn("[locale] LocalizationManager hooks NONE 找到 (class=" + A.cgn(cls).readCString() + ")");
    }
    catch (e) {
        warn("[locale] hookLocaleAccessors err: " + e);
    }
}
// 兜底: 图鉴渲染姓名前用实例主动查询一次 (幂等)。优先 invoke getter, 失败读 backing field。
export function syncLocaleFromEngine() {
    if (_synced)
        return _locale;
    if (!_lmInst || _lmInst.isNull())
        return _locale;
    try {
        var cls = A.ogc(_lmInst);
        var getMi = A.cgm(cls, Memory.allocUtf8String("get_SelectedLocale"), 0);
        if (getMi && !getMi.isNull()) {
            var r = invokeOk(getMi, _lmInst, []);
            if (r.ok && r.ret && !r.ret.isNull()) {
                var loc = readStr(r.ret);
                if (loc) {
                    setCurrentLocale(loc);
                    _synced = true;
                    dbg("[locale] syncLocaleFromEngine → '" + loc + "'");
                    return loc;
                }
            }
        }
        // invoke 失败 (调用链坑) → 直接读 backing field (动态查偏移, 回退 Windows dump 实证 0x20)
        var fo = fieldOffset(cls, "<SelectedLocale>k__BackingField", 0x20);
        var p = _lmInst.add(fo).readPointer();
        if (p && !p.isNull()) {
            var loc2 = readStr(p);
            if (loc2) {
                setCurrentLocale(loc2);
                _synced = true;
                dbg("[locale] syncLocaleFromEngine(字段@" + fo.toString(16) + ") → '" + loc2 + "'");
                return loc2;
            }
        }
    }
    catch (e) {
        warn("[locale] syncLocaleFromEngine err: " + e);
    }
    return _locale;
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
        dbg("[v3] 剧本引号修复: " + info); // 每个选项都打 → 降 dbg (2026-09-25)
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
            // 服务类名是短名 ("UIManager"), 调用方可能传全名 ("Naninovel.UIManager") — 后缀匹配
            if (cn === name || (cn && cn.indexOf(".") >= 0 && cn.endsWith("." + name)) || (name && name.indexOf(".") >= 0 && name.endsWith("." + cn)))
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
                var cnp = A.cgn(A.ogc(arr));
                var cnStr = (cnp && !cnp.isNull()) ? cnp.readCString() : null;
                cn = cnStr || ("?类名@0x" + arr); // 类名指针有效但读不出/返回 null → 视为需修复, 避免后续 indexOf 崩
            }
            catch (e0) {
                cn = "?不可读@0x" + arr;
            }
        }
        var instCls = "?";
        try {
            var instP = A.cgn(A.ogc(page));
            var instS = (instP && !instP.isNull()) ? instP.readCString() : null;
            instCls = instS || "?";
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
                            try {
                                var eP = A.cgn(elemCls);
                                elemIsStr = (eP && !eP.isNull()) && (eP.readCString() === "System.String");
                            }
                            catch (e3) {
                                elemIsStr = false;
                            }
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
import { A, dbg, fieldOffset, findClassAcrossImages, findFirstObjectOfType, findSvc, invoke, invokeBool, invokeOk, listContainsId, makeLocalResourceProvider, makeS, populateConvertersDict, readStr, wblog, error, warn } from "../utils.js";
import { wbCls, wbCurrentMod, wbData } from "./state.js";
import { buildLocalizedTextArray, localeValue, pickLocaleText, resolveLocale, unionLocaleKeys } from "./data.js";
import { getCurrentLocale, syncLocaleFromEngine } from "../locale.js";
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
                        // ContainsKey 返回 bool → il2cpp_runtime_invoke 返回的是装箱 Boolean 对象指针,
                        // 值在 +0x10。旧写法 r.ret.toInt32() === 1 永远不成立 → 守卫失效 → 重复 Add 抛
                        // ArgumentException (modlog2 实证: characters.js:53)。
                        already = invokeBool(containsMi, pm, [makeS(prefix)]);
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
        var ids = Object.keys(wbData.characters), added = 0, skipped = 0;
        for (var i = 0; i < ids.length; i++) {
            var cc = wbData.characters[ids[i]];
            if (cc.key !== prefix)
                continue;
            // 已存在则跳过 — 两层含义: ① TitleUi 可能多次触发 ② 该 ID 已被原版或其它 mod 占用。
            //   ② 是上游 ModResourceLoader.AddRichCharacter 的核心守卫: 声明原版角色 ID 的 mod
            //   (如 Twilight_TestMod005 声明 Hiro/Warden/... 想改名) 必须整体跳过, 否则 AddRecord
            //   会把原版 LayeredCharacter 记录换成 SpriteCharacter + PathPrefix=<mod>/Characters,
            //   之后原版剧本 @char Hiro.<组合外观> 全部 "Failed to load" (2026-09-25 实证)。
            // ContainsId 返回 bool → 走装箱读取, 不能用 r.ret.toInt32() (永远 ≠ 1, 守卫失效)。
            if (containsIdMi && !containsIdMi.isNull() && invokeBool(containsIdMi, metaMap, [makeS(ids[i])])) {
                skipped++;
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
        var summary = "addCharacterProviders: mod '" + prefix + "' 新注册 " + added + " 个角色" +
            (skipped ? ", 跳过 " + skipped + " 个已存在 ID (原版/其它 mod 占用, 改名无效)" : "");
        if (skipped)
            wblog(summary);
        else
            dbg("[v3] " + summary); // 无冲突时保持静默 (原为 dbg)
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
// 语言: 用 locale.js 跟踪的当前语言 (HandleLocaleChanged 实参, 实证可靠),
// 不再硬编码 zh-Hans → 切日语后 Profile 姓名应随语言切换 (朝尘→AsaChiri 等)。
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
                    try {
                        syncLocaleFromEngine();
                    }
                    catch (e) { } // 兜底: 主动查一次 LocalizationManager (启动即目标语言)
                    var loc = getCurrentLocale(); // 跟随当前语言 (ja → AsaChiri/IrisuM 等)
                    var tpl = buildAuthorTemplate(cc, loc);
                    if (!tpl)
                        tpl = buildAuthorTemplate(cc, "zh-Hans");
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
import { A, dbg, ensureItemIdsString, fieldOffset, findAllObjectOfType, findClassAcrossImages, findNestedClass, invokeOk, makeS, readStr, wblog, error, warn } from "../utils.js";
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
        wbDirtyCats = {}; // 全量注入已覆盖全部分类 → 清空 ① 的合帧待办
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
// ===== ①② @update 合帧去抖 + 按分类收敛 (2026-09-25) =====
// 背景: Twilight_TestMod005/Scripts/Twilight_TestMod005/Main 第 2 行起 28 条 @update 连排,
//   旧实现每条都跑一次全量 tryInjectWitchBook (5 分类全页 remove/add + 纹理注册),
//   实测 28 × 55~80 ms ≈ 2.12 s 主线程冻结 (modlog 2026-09-25 13:01:16.338→18.460)。
// 现改为:
//   ① 同一"突发"内的多条 @update 合并成一次补注入 —— 突发 = 与上一条 @update 间隔 < WB_BURST_GAP_MS。
//      用 JS 时钟判定而不用 Time.frameCount: 项目里 directCall 的先例全是实例方法, 静态 extern
//      属性走直调风险不划算; 窗口法零额外 FFI, 失败模式也只是提前/推迟一次注入, 不改变结果。
//   ② 只重注入被 @update 触及的分类 (旧实现无论哪一类都重注入全部 5 类)。
// 不变式 (见文件头): 游戏自身 UpdateVersion 对 _itemIds 之外的 id 不处理, 而且本次调用立刻要用到,
//   所以"本帧新引入的 id"必须当场就位 → isItemIdInPage 为假时仍立即注入该分类; 已在页面里的
//   (含原版同 id 覆写: 原版条目本就在 _itemIds 内) 则把换血/状态补写推迟到合帧注入。
// 兜底: 图鉴打开 (BeginToPresent/InitializePages) 仍走全量 tryInjectWitchBook, 所以即使某次突发
//   之后再也没有 @update, 显示也不会停在旧状态。
var WB_BURST_GAP_MS = 100;
var wbDirtyCats = {}; // 分类名 → true, 待合帧补注入
var wbLastUpdateAt = 0; // 上一条 @update 的 JS 时刻
// id 是否已在"本分类页面"的 _itemIds 内 (游戏 UpdateVersion 的处理门槛)
function isItemIdInPage(cat, id) {
    try {
        var pageCls = wbCls.pages[cat.name];
        var pages = findAllObjectOfType(pageCls);
        if (!pages.length)
            return false;
        var arr = pages[0].add(fieldOffset(pageCls, "_itemIds", 0x98)).readPointer();
        if (arr.isNull())
            return false;
        var n = arr.add(0x18).readS32();
        if (n < 0 || n > 100000)
            return false;
        for (var i = 0; i < n; i++)
            if (readStr(arr.add(0x20 + i * 8).readPointer()) === id)
                return true;
    }
    catch (e) { }
    return false;
}
// 合帧补注入: 只重注入脏分类 + 补一次纹理 (对比 tryInjectWitchBook: 全分类 + mod 切换处理)
export function flushWitchBookDirty(reason) {
    var names = Object.keys(wbDirtyCats);
    if (!names.length)
        return;
    wbDirtyCats = {};
    try {
        for (var i = 0; i < names.length; i++)
            if (wbCats[names[i]])
                injectPage(wbCats[names[i]]);
        registerTexturesInto(null);
        var ps = findAllPages();
        if (ps.length)
            registerTexturesInto(ps[0].add(fieldOffset(A.ogc(ps[0]), "_addressableAssetLoader", 0x50)).readPointer());
        dbg("[v3][WitchBook] 合帧补注入 (" + reason + "): " + names.join(","));
    }
    catch (e) {
        error("flushWitchBookDirty err: " + e);
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
        // ① 新突发 (与上一条 @update 间隔超阈值) → 上一批已结束, 先把攒下的补上;
        //    ①b 同突发内切到别的分类 ⇒ 前一批该分类已完成 → 也立刻补上 (延迟收紧到"分类边界")
        var now = Date.now();
        if (now - wbLastUpdateAt > WB_BURST_GAP_MS)
            flushWitchBookDirty("突发结束");
        else if (Object.keys(wbDirtyCats).length && !wbDirtyCats[cat.name])
            flushWitchBookDirty("分类切换");
        wbLastUpdateAt = now;
        // 本次调用立刻需要该 id 在位 → 缺则就地注入本分类; 已在则推迟到合帧
        if (!isItemIdInPage(cat, id))
            injectPage(cat);
        wbDirtyCats[cat.name] = true; // ② 只标这一条分类
        dbg(">>> onWitchBookUpdate 返回");
    }
    catch (e) {
        error("onWitchBookUpdate err: " + e);
    }
}

✄
// ============ WitchBook 页面注入域: 注入 Page._loadedDataItemMap + _itemIds + _state + 本地化字典预填 ============
import { A, ensureItemIdsString, fieldIsStringArray, fieldOffset, findAllObjectOfType, getGenericArgClass, getSystemClass, invokeBool, invokeOk, listContainsId, makeS, readStr, wblog, dbg, error, warn } from "../utils.js";
import { fileExists } from "../io.js";
import { wbCls, wbData, wbOverrides } from "./state.js";
import { currentModIds, fullLocaleTags, injectVersions, isCurrentModItem, localeValue, pickLocaleText, resolveLocale, wbCats } from "./data.js";
import { clearModItemsFromPage, isVanillaId } from "./session.js";
// 旗标文件 <MOD_ROOT>/.wb_no_override 存在 → 跳过"原版同 id 覆写" (= 上游 AddRichCharacter 语义)。
// 用于 A/B 定位覆写机制是否与崩溃相关; 缓存在首次调用时读一次 (旗标只在启动前有意义)。
var _wbNoOverride = null;
function wbNoOverride() {
    if (_wbNoOverride === null) {
        try {
            _wbNoOverride = (typeof MOD_ROOT !== "undefined" && MOD_ROOT) ? fileExists(MOD_ROOT + "/.wb_no_override") : false;
        }
        catch (e) {
            _wbNoOverride = false;
        }
        if (_wbNoOverride)
            wblog("WB_NO_OVERRIDE 生效: 跳过原版同 id 覆写 (改名失效)");
    }
    return _wbNoOverride;
}
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
                        // WB_NO_OVERRIDE (旗标文件 <MOD_ROOT>/.wb_no_override): 跳过覆写, 等价上游
                        // ModResourceLoader.AddRichCharacter 的 ContainsId→return (mod 的改名失效, 原版数据不动)。
                        // 用途: A/B 判断覆写机制是否为崩溃触发点; 也是可发布的规避方案。
                        if (wbNoOverride()) {
                            dbg("[WitchBook] WB_NO_OVERRIDE: 跳过原版同 id 覆写 '" + id + "'");
                            continue;
                        }
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
// 用快照值新建 VersionedItem<TItem> 包装对象。
// 不复用旧指针 —— VersionedItem 是页面加载期由游戏创建的托管对象, 游戏重建页面/GC 之后旧指针悬空,
// 直接 Add 回去会让容器里出现"内存已被复用(往往是复用成字符串)的伪条目" → 渲染时按字典键比较即崩
// (2026-09-25 定位: 崩溃地址 = 一个 String 的 length+chars 被当 IdVersionPair 用)。
function buildVanillaItem(vItemCls, rec) {
    var vi = A.on(vItemCls);
    vi.add(fieldOffset(vItemCls, "_id", 0x10)).writePointer(makeS(rec.id));
    vi.add(fieldOffset(vItemCls, "_version", 0x18)).writeS32(rec.ver | 0);
    vi.add(fieldOffset(vItemCls, "_item", 0x20)).writePointer(rec.item && !rec.item.isNull() ? rec.item : ptr(0));
    vi.add(fieldOffset(vItemCls, "_idVersionPair", 0x28)).writePointer(makeIdVersionPair(rec.id, rec.ver | 0));
    return vi;
}
// 整页重建: 清空页面 _loadedDataItemMap, 从捕获的原版快照重添全部条目,
// 重建 _itemIds, 并为缺 dict 项的条目补建。mod 切换/回标题时调用 → 每次会话从原版基座开始。
export function restorePageFromData(page, pageCls, cat) {
    try {
        var snap = wbVanillaMap[cat.name];
        var recs = snap ? snap.items : null;
        if (!recs || !recs.length) {
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
        // 从 map 的 vItemCls 取字段偏移
        var vItemCls = getGenericArgClass(A.ogc(mapList), 0);
        var expectItemCls = wbCls.items[cat.name]; // item 指针的类校验基准 (悬空则类名对不上)
        var added = 0, bad = 0;
        for (var i = 0; i < recs.length; i++) {
            var rc = recs[i];
            if (!rc || !rc.id) {
                bad++;
                continue;
            }
            // item 由 Data 资产持有 (长命), 但仍校验类: 指针悬空时它读出来的 klass 会对不上 → 丢弃该条
            if (rc.item && !rc.item.isNull() && expectItemCls && !expectItemCls.isNull()) {
                var okCls = false;
                try {
                    okCls = (A.ogc(rc.item).toString() === expectItemCls.toString());
                }
                catch (e4) { }
                if (!okCls) {
                    bad++;
                    continue;
                }
            }
            var vi = buildVanillaItem(vItemCls, rc);
            if (vi && !vi.isNull() && addMi && !addMi.isNull() && invokeOk(addMi, mapList, [vi]).ok)
                added++;
        }
        if (bad)
            warn(cat.name + " 整页重建: 丢弃无效快照 " + bad + " 条 (item 指针类不匹配)");
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
                var toDel = [], alien = 0;
                var idPairCls = wbCls.idVersionPair;
                var ents = outer.add(0x18).readPointer();
                var ecnt = ents.isNull() ? 0 : ents.add(0x18).readS32();
                for (var ei = 0; ei < ecnt; ei++) {
                    try {
                        var en = ents.add(0x20 + ei * 24);
                        var k = en.add(8).readPointer();
                        if (k.isNull())
                            continue;
                        // 键是 IdVersionPair (Id@0x10 / Version@0x18)。2026-09-25 修:
                        // 旧代码写成 readStr(k) —— 把 pair 当字符串读, readStr 的长度守卫让它静默返回 null,
                        // 于是这段"清理旧词条"从未生效 (覆写过的 id 残留旧 dict 项)。
                        // 顺带按类过滤: 若键不是 IdVersionPair (容器被污染过), 跳过而不是去解引用它。
                        if (idPairCls && !idPairCls.isNull()) {
                            var kcls = null;
                            try {
                                kcls = A.ogc(k);
                            }
                            catch (e3) { }
                            if (!kcls || kcls.toString() !== idPairCls.toString()) {
                                alien++;
                                continue;
                            }
                        }
                        var kid = readStr(k.add(0x10).readPointer());
                        if (kid && idSet[kid])
                            toDel.push(k);
                    }
                    catch (e2) { }
                }
                if (alien)
                    warn("clearModItemsFromPage: " + alien + " 个非 IdVersionPair 字典键已跳过 (容器曾被污染?)");
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
                // 只快照"值"(id/version/item), 不存 VersionedItem 裸指针 —— 那些包装对象在游戏重建页面/GC
                // 后悬空, 重建时 Add 回去会制造"伪条目"→ 渲染期崩溃 (2026-09-25 根因)。
                var cvi = null;
                try {
                    cvi = getGenericArgClass(A.ogc(mlist), 0);
                }
                catch (e5) { }
                var cIdOff = (cvi && !cvi.isNull()) ? fieldOffset(cvi, "_id", 0x10) : 0x10;
                var cVerOff = (cvi && !cvi.isNull()) ? fieldOffset(cvi, "_version", 0x18) : 0x18;
                var cItemOff = (cvi && !cvi.isNull()) ? fieldOffset(cvi, "_item", 0x20) : 0x20;
                var recs = [];
                for (var mi = 0; mi < mcnt; mi++) {
                    var e = marr.add(0x20 + mi * 8).readPointer();
                    if (e.isNull())
                        continue;
                    var rid = readStr(e.add(cIdOff).readPointer());
                    if (!rid)
                        continue;
                    recs.push({ id: rid, ver: e.add(cVerOff).readS32(), item: e.add(cItemOff).readPointer() });
                }
                wbVanillaMap[ccat.name] = { page: out[c].toString(), items: recs };
                wblog(ccat.name + " 捕获原版基座 " + recs.length + " 条");
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
export var wbVanillaMap = {}; // catName -> {page: 页面指针, items: [{id, ver, item}]} (整页重建基座快照)
// items 只存值, 不存 VersionedItem 包装对象指针 (悬空会导致重建出"伪条目"→渲染崩溃)
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
