// manosabamod (多文件版) — 入口/初始化
// 镜像 Windows 机制 + il2cpp_thread_attach + 动态解析
// 已验证的前提:
//   * il2cpp_thread_attach 解锁 il2cpp_runtime_invoke (Script.FromText OK, klass=Script)
//   * Windows 版注入靠 ProvisionSources/AddLoadedResource/Path.SetValue, 不靠字典手写
//   * GotoModified 在 GigaCreation.NaninovelExtender.Common, 必须动态解析 (Windows RVA 不跨平台)
// 流程:
//   init: Steam 绕过 + thread_attach + 绑定 API + 找 image
//   TitleUi.Activate: 找 StartGame 下的 GotoModified → Path.SetValue("ModStart") → 注册菜单
//   菜单经 Script.FromText 构建, 经 AddLoadedResource 注册
// 日志分层: 机制日志走 dbg (MOD_DEBUG, 默认关); 游戏侧 Unity.LogError 全量 dump (dumpObj 原样 console.log)
'use strict';

import { A, allImgs, cs, dbg, findClassAcrossImages, nv, readStr, setGotoModifiedCls, setImageHandles, wblog } from "./utils.js";
import { setupMovieHooks } from "./movie.js";
import { addModLoader } from "./providers.js";
import { hookStartGame, registerMenu, registerMenuText } from "./menu.js";
import { resetWitchBookSession } from "./witchbook/session.js";
import { setupWitchBookHooks } from "./witchbook/index.js";
import { registerTexturesInto } from "./witchbook/textures.js";
import { wbCls } from "./witchbook/state.js";
import { initLog, installCrashHandler, logLevel } from "./log.js";
import { printStartupBanner } from "./banner.js";

// ============ 日志系统初始化 (顶层最先: 覆盖整个 init, 含 GameAssembly 加载失败) ============
// MOD_LOG/MOD_NO_COLOR 由 run_mod.sh 的 fragment 注入全局; initLog 早于首个 wblog (doInit)
initLog((typeof MOD_LOG !== "undefined" && MOD_LOG) ? MOD_LOG : null,
        typeof MOD_NO_COLOR !== "undefined" && MOD_NO_COLOR);
installCrashHandler();
// MOD 初始化横幅: 角色 ASCII 艺术 + 项目声明 (打印时文件已开, 终端彩色 / modlog.txt 明文)
printStartupBanner();

// ============ Steam 绕过 (Phase 1) ============
try { var dl = Module.findGlobalExportByName("dlopen"); if (dl) { var h = false; Interceptor.attach(dl, { onEnter: function (a) { this.p = a[0].readCString(); }, onLeave: function (r) { if (h || r.isNull() || !this.p || this.p.indexOf("libsteam_api") === -1) return; var r2 = Module.findGlobalExportByName("SteamAPI_RestartAppIfNecessary"); if (r2) Interceptor.replace(r2, new NativeCallback(function () { return 0; }, 'bool', ['uint32'])); var i2 = Module.findGlobalExportByName("SteamInternal_SteamAPI_Init"); if (i2) Interceptor.replace(i2, new NativeCallback(function () { return 2; }, 'int', [])); h = true; } }); } } catch (e) { }

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
        if (!ga) return false;
        Thread.sleep(0.3);
        dbg("[v3] GameAssembly base=" + ga.base);
        var ex = ga.enumerateExports();
        for (var i = 0; i < ex.length; i++) E[ex[i].name] = ex[i].address;
        if (!E.il2cpp_domain_get || !E.il2cpp_class_from_name || !E.il2cpp_runtime_invoke || !E.il2cpp_thread_attach) return false;

        A.dg  = new NativeFunction(E.il2cpp_domain_get, 'pointer', []);
        A.dga = new NativeFunction(E.il2cpp_domain_get_assemblies, 'pointer', ['pointer', 'pointer']);
        A.agi = new NativeFunction(E.il2cpp_assembly_get_image, 'pointer', ['pointer']);
        A.ign = new NativeFunction(E.il2cpp_image_get_name, 'pointer', ['pointer']);
        A.cfn = new NativeFunction(E.il2cpp_class_from_name, 'pointer', ['pointer', 'pointer', 'pointer']);
        A.cgm = new NativeFunction(E.il2cpp_class_get_method_from_name, 'pointer', ['pointer', 'pointer', 'int']);
        A.sn  = new NativeFunction(E.il2cpp_string_new, 'pointer', ['pointer']);
        A.ri  = new NativeFunction(E.il2cpp_runtime_invoke, 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
        A.ogc = new NativeFunction(E.il2cpp_object_get_class, 'pointer', ['pointer']);
        A.cgn = new NativeFunction(E.il2cpp_class_get_name, 'pointer', ['pointer']);
        A.on  = new NativeFunction(E.il2cpp_object_new, 'pointer', ['pointer']);
        A.gf  = new NativeFunction(E.il2cpp_class_get_field_from_name, 'pointer', ['pointer', 'pointer']);
        A.fo  = new NativeFunction(E.il2cpp_field_get_offset, 'uint32', ['pointer']);
        A.sdf = new NativeFunction(E.il2cpp_class_get_static_field_data, 'pointer', ['pointer']);
        A.ta  = new NativeFunction(E.il2cpp_thread_attach, 'pointer', ['pointer']);
        A.ots = E.il2cpp_object_to_string ? new NativeFunction(E.il2cpp_object_to_string, 'pointer', ['pointer']) : null;
        A.cgnt = new NativeFunction(E.il2cpp_class_get_nested_types, 'pointer', ['pointer', 'pointer']);
        A.vb = E.il2cpp_value_box ? new NativeFunction(E.il2cpp_value_box, 'pointer', ['pointer', 'pointer']) : null;
        A.cgt = E.il2cpp_class_get_type ? new NativeFunction(E.il2cpp_class_get_type, 'pointer', ['pointer']) : null;
        A.cft = E.il2cpp_class_from_type ? new NativeFunction(E.il2cpp_class_from_type, 'pointer', ['pointer']) : null;
        A.tgo = E.il2cpp_type_get_object ? new NativeFunction(E.il2cpp_type_get_object, 'pointer', ['pointer']) : null;
        A.an  = E.il2cpp_array_new ? new NativeFunction(E.il2cpp_array_new, 'pointer', ['pointer', 'uint64']) : null;
        A.anSpec = E.il2cpp_array_new_specific ? new NativeFunction(E.il2cpp_array_new_specific, 'pointer', ['pointer', 'uint64']) : null;
        if (!A.cgt || !A.cft || !A.tgo) dbg("[v3] !! 类型 API 缺失 (cgt/cft/tgo), converters 填充将失败");
        if (!A.an) dbg("[v3] !! il2cpp_array_new 缺失, 数组创建将失败");

        dom = A.dg();
        var t = A.ta(dom);
        dbg("[v3] 线程已 attach: " + t);

        var cp = Memory.alloc(8);
        var asms = A.dga(dom, cp); var cnt = cp.readPointer().toInt32();
        var nvImg = null, csImg = null, gigaImg = null;
        allImgs.length = 0;   // 共享数组重建 (ES modules 绑定不可重新赋值)
        for (var i = 0; i < cnt; i++) {
            var a = asms.add(i * 8).readPointer(); var img = A.agi(a); var nm = A.ign(img).readCString();
            allImgs.push(img);
            if (nm.indexOf("Naninovel.Runtime") >= 0) nvImg = img;
            else if (nm.indexOf("Assembly-CSharp") >= 0) csImg = img;
            else if (nm.indexOf("GigaCreation") >= 0) gigaImg = img;
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
        if (gmCls.isNull()) { dbg("[v3] !! GotoModified 完全找不到, 跳过 goto 相关逻辑"); }
        else { setGotoModifiedCls(gmCls); dbg("[v3] GotoModified class = " + gmCls); }

        // 动态解析 LoadAndPlay 并 hook (诊断用, 仅 MOD_DEBUG)
        if (DIAG && gmCls && !gmCls.isNull()) {
            try {
                var lapMi = A.cgm(gmCls, Memory.allocUtf8String("LoadAndPlay"), 2);
                if (lapMi && !lapMi.isNull()) {
                    var lapPtr = lapMi.readPointer(); // methodPointer +0x00
                    dbg("[v3] LoadAndPlay methodPointer = " + lapPtr);
                    Interceptor.attach(lapPtr, {
                        onEnter: function (args) {
                            if (!shouldLogLoadAndPlay) return;
                            var path = readStr(args[1]);
                            var label = readStr(args[2]);
                            dbg("[v3] >>> LoadAndPlay path='" + path + "' label='" + (label || "") + "'");
                        }
                    });
                    dbg("[v3] LoadAndPlay hooked (dynamic)");
                } else {
                    dbg("[v3] LoadAndPlay(2) NOT FOUND");
                }
            } catch (e) { dbg("[v3] LoadAndPlay hook err: " + e); }
        }

        // ===== 诊断: 完整 goto 链路 hook (仅 MOD_DEBUG, 默认不装) =====
        if (DIAG) try {
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
                    }});
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
                    }});
                    dbg("[v3] NavigateOtherScript hooked");
                }
                var execMi = A.cgm(gmCls, Memory.allocUtf8String("Execute"), 1);
                if (execMi && !execMi.isNull()) {
                    dbg("[v3] Execute addr=" + execMi.readPointer());
                    Interceptor.attach(execMi.readPointer(), { onEnter: function () {
                        dbg("[v3] GotoModified.Execute 触发");
                    }});
                    dbg("[v3] Execute hooked");
                }
                // 局部函数 (真正干活的?)
                var lfMi = A.cgm(gmCls, Memory.allocUtf8String("<NavigateOtherScript>g__LoadAndPlay|0"), 0);
                if (lfMi && !lfMi.isNull()) {
                    dbg("[v3] g__LoadAndPlay|0 addr=" + lfMi.readPointer());
                    Interceptor.attach(lfMi.readPointer(), { onEnter: function () {
                        dbg("[v3] >>> 局部函数 g__LoadAndPlay|0 触发");
                    }});
                    dbg("[v3] g__LoadAndPlay|0 hooked");
                } else {
                    dbg("[v3] 局部函数 g__LoadAndPlay|0 未找到");
                }
                // 嵌套状态机 <NavigateOtherScript>d__2 的 MoveNext (API: 每次返回一个指针, iter 推进)
                try {
                    var iter = Memory.alloc(8); iter.writePointer(ptr(0));
                    var foundSm = false;
                    for (;;) {
                        var p = A.cgnt(gmCls, iter);
                        if (!p || p.isNull()) break;
                        var nc = p.readPointer();
                        if (!nc || nc.isNull()) break;
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
                    if (!foundSm) dbg("[v3] 未找到 NavigateOtherScript 状态机");
                } catch (e) { dbg("[v3] 状态机查找 err: " + e); }
                // System.Exception.ToString() — NRE 的完整堆栈
                try {
                    var coreImg = null;
                    for (var ci = 0; ci < allImgs.length; ci++) {
                        var inm2 = A.ign(allImgs[ci]).readCString();
                        if (inm2.indexOf("mscorlib") >= 0 || inm2.indexOf("CoreLib") >= 0 || inm2.indexOf("System.Runtime") >= 0) { coreImg = allImgs[ci]; break; }
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
                                                try { bt = Thread.backtrace(this.context, Backtracer.ACCURATE); }
                                                catch (e2) {
                                                    dbg("[v3] bt ACCURATE err: " + e2);
                                                    try { bt = Thread.backtrace(this.context, Backtracer.FUZZY); }
                                                    catch (e3) { dbg("[v3] bt FUZZY err: " + e3); }
                                                }
                                                if (bt) {
                                                    var rvas = [];
                                                    for (var bi = 0; bi < Math.min(16, bt.length); bi++) {
                                                        try { rvas.push("0x" + bt[bi].sub(ga2.base).toString(16)); }
                                                        catch (e4) { rvas.push("?"); }
                                                    }
                                                    dbg("[v3] ****** NRE 原生栈: " + rvas.join(" "));
                                                } else {
                                                    dbg("[v3] ****** NRE bt null");
                                                }
                                            }
                                        } catch (e) { dbg("[v3] ToString onEnter err: " + e); }
                                    },
                                    onLeave: function () {
                                        if (!this.exc || this.exc.isNull()) return;
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
                } catch (e) { dbg("[v3] Exception hook err: " + e); }
                // AsyncUniTaskMethodBuilder.SetException — 原生栈定位抛异常处
                try {
                    var utImg = null;
                    for (var ui = 0; ui < allImgs.length; ui++) {
                        var unin = A.ign(allImgs[ui]).readCString();
                        if (unin.indexOf("UniTask") >= 0) { utImg = allImgs[ui]; break; }
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
                                        } catch (e) { dbg("[v3] backtrace err: " + e); }
                                    }
                                });
                                dbg("[v3] SetException hooked");
                            } else {
                                dbg("[v3] SetException NOT FOUND");
                            }
                        }
                    }
                } catch (e) { dbg("[v3] UniTask hook err: " + e); }
            }
            // ScriptLoader 服务的加载入口
            var slCls = A.cfn(nv, Memory.allocUtf8String("Naninovel"), Memory.allocUtf8String("ScriptLoader"));
            if (slCls && !slCls.isNull()) {
                var loadMi2 = A.cgm(slCls, Memory.allocUtf8String("Load"), 2);
                if (loadMi2 && !loadMi2.isNull()) {
                    dbg("[v3] ScriptLoader.Load addr=" + loadMi2.readPointer());
                    Interceptor.attach(loadMi2.readPointer(), { onEnter: function (a) {
                        dbg("[v3] >>> ScriptLoader.Load path='" + readStr(a[1]) + "' startIndex=" + a[2].toInt32());
                    }});
                    dbg("[v3] ScriptLoader.Load hooked");
                }
                var ilMi = A.cgm(slCls, Memory.allocUtf8String("IsLoaded"), 1);
                if (ilMi && !ilMi.isNull()) {
                    Interceptor.attach(ilMi.readPointer(), { onEnter: function (a) {
                        dbg("[v3] ScriptLoader.IsLoaded path='" + readStr(a[1]) + "'");
                    }});
                    dbg("[v3] ScriptLoader.IsLoaded hooked");
                }
                // ResourceLoader<T>.GetLoaded(string) — 缓存直接命中 (ScriptLoader 继承自 ResourceLoader<Script>)
                var glMi = A.cgm(slCls, Memory.allocUtf8String("GetLoaded"), 1);
                if (glMi && !glMi.isNull()) {
                    dbg("[v3] ResourceLoader.GetLoaded addr=" + glMi.readPointer());
                    Interceptor.attach(glMi.readPointer(), { onEnter: function (a) {
                        dbg("[v3] >>> GetLoaded path='" + readStr(a[1]) + "'");
                    }});
                    dbg("[v3] GetLoaded hooked");
                } else {
                    dbg("[v3] GetLoaded NOT FOUND");
                }
            }
        } catch (e) { dbg("[v3] 诊断 hook 失败: " + e); }

        // ===== 捕获 Unity 错误日志 =====
        // dumpObj 输出游戏侧错误详情 — 全量保留 (不随 MOD_DEBUG 开关), 是最高优先级信息 (ARCHIVE 教训 2)
        // 级别路由: LogError/LogException→ERROR(红), LogWarning→WARN(黄), Log→INFO(青); 进终端+文件
        function dumpObj(obj, tag, level) {
            if (level === undefined) level = 0;   // 默认按错误处理
            if (!obj || obj.isNull()) { logLevel(level, "[v3] " + tag + ": <null>"); return; }
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
                        if (c === 0) break;
                        if (c >= 0xD800 && c <= 0xDFFF) continue;   // 孤立代理项直接跳过
                        s += String.fromCharCode(c);
                    }
                    return s;
                }
                try {
                    var full = collectUtf16(0x14, 2000);
                    if (full) logLevel(level, "[v3] " + tag + " FULL: " + full);
                } catch (e) {}
                // 从多个起点走 UTF-16 到 null
                [0x08, 0x10, 0x14, 0x18, 0x0C].forEach(function (so) {
                    try {
                        var s = collectUtf16(so, 2000);
                        if (s) logLevel(level, "[v3] " + tag + " +0x" + so.toString(16) + " utf16='" + s + "'");
                    } catch (e) {}
                });
            } catch (e3) { logLevel(level, "[v3] " + tag + " dump err: " + e3); }
        }
        try {
            var ueImg = null;
            for (var i = 0; i < allImgs.length; i++) {
                var inm = A.ign(allImgs[i]).readCString();
                if (inm.indexOf("UnityEngine.CoreModule") >= 0) { ueImg = allImgs[i]; break; }
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
                } else {
                    dbg("[v3] UnityEngine.Debug class NOT FOUND");
                }
            } else {
                dbg("[v3] UnityEngine.CoreModule image NOT FOUND");
            }
        } catch (e) { dbg("[v3] Debug hook err: " + e); }

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
                    onEnter: function () {},
                    onLeave: function () {
                        dbg("[v3] TitleUi.Activate 触发");
                        // 回到标题 → 重置 WitchBook 会话 (防止上一 mod 的线索/状态被继承)
                        try { resetWitchBookSession(); } catch (e) {}
                        if (typeof modList !== "undefined" && modList && modList.length) registerMenu(modList);
                        else registerMenu([]);
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
                        } catch (e2) { dbg("[v3] addModLoader 循环 err: " + e2); }
                        // WitchBook 纹理尽早注册 (Title 后场景加载即有)
                        try { if (wbCls) registerTexturesInto(null); } catch (e3) {}
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
        try { var ok = doInit(); if (ok) { clearInterval(chk); dbg("[v3] 全部就绪"); } }
        catch (e) { dbg("[v3] ERR: " + e); }
    }, 200);
})();
