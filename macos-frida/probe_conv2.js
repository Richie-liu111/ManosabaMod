// probe_conv2.js — 主线程触发 ScriptLoader.Load + 全链路诊断
// 关键改动: 注入 + Load 都在 TitleUi.Activate onLeave (Unity 主线程) 里做,
//           这样 async UniTask 续体能正确投递到主循环。
// 诊断: hook File.ReadAllBytes / Unity LogError / ScriptLoader.Load
'use strict';

var MOD_ROOT = "/Users/richie/manosaba decompile/manosaba_game_mac/ManosabaMod";
var MOD_KEY = "1919180";
var LOCAL_PATH = "1919180_01/Main_02";

try { var dl = Module.findGlobalExportByName("dlopen"); if (dl) { var h = false; Interceptor.attach(dl, { onEnter: function (a) { this.p = a[0].readCString(); }, onLeave: function (r) { if (h || r.isNull() || !this.p || this.p.indexOf("libsteam_api") === -1) return; var r2 = Module.findGlobalExportByName("SteamAPI_RestartAppIfNecessary"); if (r2) Interceptor.replace(r2, new NativeCallback(function () { return 0; }, 'bool', ['uint32'])); var i2 = Module.findGlobalExportByName("SteamInternal_SteamAPI_Init"); if (i2) Interceptor.replace(i2, new NativeCallback(function () { return 2; }, 'int', [])); h = true; } }); } } catch (e) { }

var A = {}, E = {}, nv = null, cs = null, coreImg = null, allImgs = [];
var slObj = null, done = false, loadTriggered = false, frameCnt = 0;

function readStr(p) {
    if (!p || p.isNull()) return null;
    try {
        var l = p.add(0x10).readS32();
        if (l <= 0 || l > 9999) return null;
        var s = "";
        for (var i = 0; i < l; i++) s += String.fromCharCode(p.add(0x14 + i * 2).readU16());
        return s;
    } catch (e) { return null; }
}
function makeS(v) { return A.sn(Memory.allocUtf8String(v || "")); }
function invokeOk(mi, obj, args) {
    var params = args.length ? Memory.alloc(Process.pointerSize * args.length) : ptr(0);
    for (var i = 0; i < args.length; i++) params.add(i * Process.pointerSize).writePointer(args[i]);
    var exc = Memory.alloc(8); exc.writePointer(ptr(0));
    var ret = A.ri(mi, obj, params, exc);
    var ex = exc.readPointer();
    if (!ex.isNull()) {
        var en = "?"; try { en = A.cgn(A.ogc(ex)).readCString(); } catch (e) {}
        var msg = null; try { msg = readStr(ex.add(0x18).readPointer()); } catch (e) {}
        console.log("[cv] invoke THREW: " + en + " | " + (msg || ""));
        return { ok: false, ret: ptr(0) };
    }
    return { ok: true, ret: ret };
}
function findClassAcrossImages(ns, name) {
    var nsStr = Memory.allocUtf8String(ns), nmStr = Memory.allocUtf8String(name);
    var imgs = [nv, cs].concat(allImgs);
    var seen = {};
    for (var i = 0; i < imgs.length; i++) {
        if (!imgs[i] || imgs[i].isNull()) continue;
        var key = imgs[i].toString();
        if (seen[key]) continue; seen[key] = true;
        var c = A.cfn(imgs[i], nsStr, nmStr);
        if (c && !c.isNull()) return c;
    }
    return ptr(0);
}
function findSvc(name) {
    var el = A.cfn(nv, Memory.allocUtf8String("Naninovel"), Memory.allocUtf8String("Engine"));
    var f = A.gf(el, Memory.allocUtf8String("services"));
    var l = A.sdf(el).add(A.fo(f)).readPointer();
    var its = l.add(0x10).readPointer(); var sz = l.add(0x18).readS32();
    for (var i = 0; i < sz; i++) {
        var ep = its.add(0x20 + i * 8).readPointer(); if (ep.isNull()) continue;
        var cn = A.cgn(A.ogc(ep)).readCString();
        if (cn === name) return ep;
    }
    return null;
}
function getGenericArgClass(instClass, idx) {
    var t = A.cgt(instClass);
    if (!t || t.isNull()) return ptr(0);
    var genCls = t.readPointer();
    if (genCls.isNull()) return ptr(0);
    var classInst = genCls.add(0x8).readPointer();
    if (classInst.isNull()) return ptr(0);
    var argc = classInst.readU32();
    var argv = classInst.add(0x8).readPointer();
    if (idx >= argc) return ptr(0);
    var argType = argv.add(idx * 8).readPointer();
    return A.cft(argType);
}
function makeLRP(root) {
    var cls = findClassAcrossImages("Naninovel", "LocalResourceProvider");
    var o = A.on(cls);
    var ctorMi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 1);
    var r = invokeOk(ctorMi, o, [makeS(root)]);
    if (!r.ok) { console.log("[cv] LRP.ctor 失败"); return ptr(0); }
    return o;
}
function makeConverter() {
    var cls = findClassAcrossImages("Naninovel", "NaniToScriptAssetConverter");
    var o = A.on(cls);
    var ctorMi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 0);
    var r = invokeOk(ctorMi, o, []);
    return r.ok ? o : ptr(0);
}

function populateConverters(lrp) {
    var dict = lrp.add(0x58).readPointer();
    var dictCls = A.ogc(dict);
    var listCls = getGenericArgClass(dictCls, 1);
    if (listCls.isNull()) { console.log("[cv] List 类失败"); return false; }
    var listObj = A.on(listCls);
    var rl = invokeOk(A.cgm(listCls, Memory.allocUtf8String(".ctor"), 0), listObj, []);
    if (!rl.ok) { console.log("[cv] List.ctor 失败"); return false; }
    var conv = makeConverter();
    if (conv.isNull()) { console.log("[cv] Converter 失败"); return false; }
    var ra = invokeOk(A.cgm(listCls, Memory.allocUtf8String("Add"), 1), listObj, [conv]);
    if (!ra.ok) { console.log("[cv] List.Add 失败"); return false; }
    var scriptCls = findClassAcrossImages("Naninovel", "Script");
    var typeObj = A.tgo(A.cgt(scriptCls));
    var rd = invokeOk(A.cgm(dictCls, Memory.allocUtf8String("Add"), 2), dict, [typeObj, listObj]);
    if (!rd.ok) { console.log("[cv] Dict.Add 失败"); return false; }
    console.log("[cv] converters 填充完成, dict _count=" + dict.add(A.fo(A.gf(dictCls, Memory.allocUtf8String("_count")))).readS32());
    return true;
}

function main() {
    console.log("[cv] ==== 主线程注入 ====");
    var sm = findSvc("ScriptManager");
    if (!sm) { console.log("[cv] ScriptManager NOT FOUND"); return; }
    slObj = sm.add(0x28).readPointer();
    if (slObj.isNull()) { console.log("[cv] scriptLoader NULL"); return; }

    var ourLRP = makeLRP(MOD_ROOT);
    if (ourLRP.isNull()) return;
    if (!populateConverters(ourLRP)) return;

    var slCls = A.ogc(slObj);
    var psField = A.gf(slCls, Memory.allocUtf8String("ProvisionSources"));
    var psList = slObj.add(A.fo(psField)).readPointer();
    var psMem = Memory.alloc(16);
    psMem.writePointer(ourLRP);
    psMem.add(8).writePointer(makeS(MOD_KEY + "/Scripts"));
    var idx = Memory.alloc(4); idx.writeS32(0);
    var ri = invokeOk(A.cgm(A.ogc(psList), Memory.allocUtf8String("Insert"), 2), psList, [idx, psMem]);
    console.log("[cv] Insert(0) → " + (ri.ok ? "OK" : "FAIL") + " 条数=" + psList.add(0x18).readS32());

    // 主线程直接触发 Load (async UniTask 续体能投递到主循环)
    console.log("[cv] ==== 触发 ScriptLoader.Load('" + LOCAL_PATH + "') ====");
    var loadMi = A.cgm(slCls, Memory.allocUtf8String("Load"), 2);
    var holder = Memory.alloc(8); holder.writePointer(ptr(0));
    var rl2 = invokeOk(loadMi, slObj, [makeS(LOCAL_PATH), holder]);
    console.log("[cv] Load 返回 → " + (rl2.ok ? "ok (UniTask)" : "fail"));
    loadTriggered = true;
}

(function () {
    var attempts = 0;
    function doInit() {
        attempts++;
        var ga = Process.findModuleByName("GameAssembly.dylib");
        if (!ga) return false;
        Thread.sleep(0.3);
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
        A.cgt = new NativeFunction(E.il2cpp_class_get_type, 'pointer', ['pointer']);
        A.cft = new NativeFunction(E.il2cpp_class_from_type, 'pointer', ['pointer']);
        A.tgo = new NativeFunction(E.il2cpp_type_get_object, 'pointer', ['pointer']);

        var dom = A.dg();
        try { A.ta(dom); console.log("[cv] 线程已 attach"); } catch (e) { console.log("[cv] attach err: " + e); }

        var cp = Memory.alloc(8);
        var asms = A.dga(dom, cp); var cnt = cp.readPointer().toInt32();
        for (var i = 0; i < cnt; i++) {
            var a = asms.add(i * 8).readPointer(); var img = A.agi(a); var nm = A.ign(img).readCString();
            allImgs.push(img);
            if (nm.indexOf("Naninovel.Runtime") >= 0) nv = img;
            else if (nm.indexOf("Assembly-CSharp") >= 0) cs = img;
            else if (nm.indexOf("mscorlib") >= 0 || nm.indexOf("CoreLib") >= 0 || nm.indexOf("System.Runtime") >= 0) coreImg = img;
        }

        // ===== hook File.ReadAllBytes (看 LRP 读什么文件) =====
        try {
            var fileCls = A.cfn(coreImg, Memory.allocUtf8String("System.IO"), Memory.allocUtf8String("File"));
            if (fileCls && !fileCls.isNull()) {
                for (var ac = 1; ac <= 2; ac++) {
                    var m = A.cgm(fileCls, Memory.allocUtf8String("ReadAllBytes"), ac);
                    if (m && !m.isNull()) (function (mc) {
                        Interceptor.attach(m.readPointer(), { onEnter: function (a) {
                            console.log("[cv] >>> File.ReadAllBytes(" + ac + ") path='" + readStr(a[0]) + "'");
                        }});
                    })(ac);
                }
                console.log("[cv] File.ReadAllBytes hooked");
            }
        } catch (e) { console.log("[cv] File hook err: " + e); }

        // ===== hook Unity LogError =====
        try {
            var ueImg = null;
            for (var ui = 0; ui < allImgs.length; ui++) {
                var inm = A.ign(allImgs[ui]).readCString();
                if (inm.indexOf("UnityEngine.CoreModule") >= 0) { ueImg = allImgs[ui]; break; }
            }
            if (ueImg) {
                var dbg = A.cfn(ueImg, Memory.allocUtf8String("UnityEngine"), Memory.allocUtf8String("Debug"));
                ["LogError", "LogWarning", "LogException"].forEach(function (mn) {
                    var m = A.cgm(dbg, Memory.allocUtf8String(mn), 1);
                    if (m && !m.isNull()) Interceptor.attach(m.readPointer(), { onEnter: function (a) {
                        var s = readStr(a[0]);
                        if (s) console.log("[cv] Unity." + mn + ": " + s);
                    }});
                });
                console.log("[cv] Unity Debug hooked");
            }
        } catch (e) { console.log("[cv] Debug hook err: " + e); }

        // ===== ScriptLoader.Load 打点 =====
        try {
            var slCls = A.cfn(nv, Memory.allocUtf8String("Naninovel"), Memory.allocUtf8String("ScriptLoader"));
            var loadMi = A.cgm(slCls, Memory.allocUtf8String("Load"), 2);
            if (loadMi && !loadMi.isNull()) Interceptor.attach(loadMi.readPointer(), { onEnter: function (a) {
                console.log("[cv] >>> ScriptLoader.Load path='" + readStr(a[1]) + "'");
            }});
            var glMi = A.cgm(slCls, Memory.allocUtf8String("GetLoaded"), 1);
            if (glMi && !glMi.isNull()) Interceptor.attach(glMi.readPointer(), { onEnter: function (a) {
                console.log("[cv] >>> GetLoaded path='" + readStr(a[1]) + "'");
            }});
            console.log("[cv] ScriptLoader hooks done");
        } catch (e) {}

        // ===== hook LRP 的 loader/locator 入口 (FSG entry, 只打点) =====
        try {
            var lrpCls2 = findClassAcrossImages("Naninovel", "LocalResourceProvider");
            ["CreateLoadResourceRunner", "CreateLocateResourcesRunner", "CreateLocateFoldersRunner"].forEach(function (mn) {
                for (var pc = 1; pc <= 2; pc++) {
                    var m = A.cgm(lrpCls2, Memory.allocUtf8String(mn), pc);
                    if (m && !m.isNull()) (function (mc) {
                        Interceptor.attach(m.readPointer(), { onEnter: function (a) {
                            console.log("[cv] >>> LRP." + mc + " 触发 this=" + a[0]);
                        }});
                    })(mn + "(" + pc + ")");
                }
            });
            console.log("[cv] LRP runner hooks done");
        } catch (e) { console.log("[cv] LRP hook err: " + e); }

        // ===== 主线程锚点: TitleUi.Activate onLeave → 注入 + Load =====
        var tc = A.cfn(cs, Memory.allocUtf8String("WitchTrials.Views"), Memory.allocUtf8String("TitleUi"));
        if (tc && !tc.isNull()) {
            var actMi = A.cgm(tc, Memory.allocUtf8String("Activate"), 0);
            if (actMi && !actMi.isNull()) {
                Interceptor.attach(actMi.readPointer(), {
                    onLeave: function () {
                        console.log("[cv] TitleUi.Activate 触发 (主线程, 同步注入)");
                        try { main(); } catch (e) { console.log("[cv] main() err: " + e); }
                    }
                });
                console.log("[cv] TitleUi.Activate hooked");
            }
        }

        // ===== 主线程帧 hook: 每帧检查 GetLoaded (代替 setInterval) =====
        var upMi = A.cgm(tc, Memory.allocUtf8String("Update"), 0);
        if (upMi && !upMi.isNull()) {
            Interceptor.attach(upMi.readPointer(), {
                onEnter: function () {
                    if (!loadTriggered || done || !slObj) return;
                    try {
                        var slCls = A.ogc(slObj);
                        var glMi = A.cgm(slCls, Memory.allocUtf8String("GetLoaded"), 1);
                        var r = invokeOk(glMi, slObj, [makeS(LOCAL_PATH)]);
                        if (r.ok && r.ret && !r.ret.isNull()) {
                            done = true;
                            console.log("[cv] ****** GetLoaded HIT! lr=" + r.ret);
                            try {
                                var res = r.ret.add(0x10).readPointer();
                                var obj = res.add(0x18).readPointer();
                                console.log("[cv] Object=" + obj + " class=" + (A.cgn(A.ogc(obj)).readCString() || "?"));
                                var lines = obj.add(0x30).readPointer();
                                if (lines && !lines.isNull()) console.log("[cv] Script lines=" + lines.add(0x18).readS32());
                            } catch (e) { console.log("[cv] dump err: " + e); }
                        } else {
                            // 每 60 帧打一次心跳, 确认帧 hook 活着
                            frameCnt++;
                            if (frameCnt % 60 === 0) console.log("[cv] 帧心跳 " + frameCnt + " (未命中)");
                        }
                    } catch (e) { console.log("[cv] 帧poll err: " + e); }
                }
            });
            console.log("[cv] TitleUi.Update 帧 hook 就绪");
        }
        return true;
    }
    var chk = setInterval(function () {
        try { var ok = doInit(); if (ok) { clearInterval(chk); console.log("[cv] 就绪"); } }
        catch (e) { console.log("[cv] ERR: " + e); }
    }, 200);
})();
