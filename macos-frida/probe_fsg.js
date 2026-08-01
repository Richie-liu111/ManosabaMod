// probe_fsg.js — 决定性实验: FSG 泛型方法能否从 Frida 经 runtime_invoke 调用?
// 核心问题: il2cpp_class_get_method_from_name 返回泛型 DEF (is_generic=true) → "Invalid call"
//           但如果从【实例化后的类】取方法, 是否返回 is_inflated=true 的可用 MethodInfo?
// 测试对象: ScriptLoader.LoadedByLocalPath (Dictionary<string, LoadedResource>) — 引用类型泛型
// 以及: LocalResourceProvider.converters (Dictionary<Type, List<IConverter>>) — 双引用泛型
'use strict';

try { var dl = Module.findGlobalExportByName("dlopen"); if (dl) { var h = false; Interceptor.attach(dl, { onEnter: function (a) { this.p = a[0].readCString(); }, onLeave: function (r) { if (h || r.isNull() || !this.p || this.p.indexOf("libsteam_api") === -1) return; var r2 = Module.findGlobalExportByName("SteamAPI_RestartAppIfNecessary"); if (r2) Interceptor.replace(r2, new NativeCallback(function () { return 0; }, 'bool', ['uint32'])); var i2 = Module.findGlobalExportByName("SteamInternal_SteamAPI_Init"); if (i2) Interceptor.replace(i2, new NativeCallback(function () { return 2; }, 'int', [])); h = true; } }); } } catch (e) { }

var A = {}, E = {}, nv = null, cs = null, allImgs = [];

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
function invoke(mi, obj, args) {
    var params = args.length ? Memory.alloc(Process.pointerSize * args.length) : ptr(0);
    for (var i = 0; i < args.length; i++) params.add(i * Process.pointerSize).writePointer(args[i]);
    var exc = Memory.alloc(8); exc.writePointer(ptr(0));
    var ret = A.ri(mi, obj, params, exc);
    var ex = exc.readPointer();
    if (!ex.isNull()) {
        var en = "?"; try { en = A.cgn(A.ogc(ex)).readCString(); } catch (e) {}
        var msg = null; try { msg = readStr(ex.add(0x18).readPointer()); } catch (e) {}
        return { ok: false, ret: ptr(0), err: en + " | " + msg };
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
function dumpMi(mi, tag) {
    if (!mi || mi.isNull()) { console.log("[fsg] " + tag + ": NULL"); return; }
    var isGen = A.mig ? A.mig(mi) : -1;
    var isInf = A.mii ? A.mii(mi) : -1;
    console.log("[fsg] " + tag + ": mp=" + mi.readPointer() + " invoker=" + mi.add(0x10).readPointer() +
                " is_generic=" + isGen + " is_inflated=" + isInf);
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
        A.mig = E.il2cpp_method_is_generic ? new NativeFunction(E.il2cpp_method_is_generic, 'bool', ['pointer']) : null;
        A.mii = E.il2cpp_method_is_inflated ? new NativeFunction(E.il2cpp_method_is_inflated, 'bool', ['pointer']) : null;

        var dom = A.dg();
        try { A.ta(dom); console.log("[fsg] 线程已 attach"); } catch (e) { console.log("[fsg] attach err: " + e); }

        var cp = Memory.alloc(8);
        var asms = A.dga(dom, cp); var cnt = cp.readPointer().toInt32();
        for (var i = 0; i < cnt; i++) {
            var a = asms.add(i * 8).readPointer(); var img = A.agi(a); var nm = A.ign(img).readCString();
            allImgs.push(img);
            if (nm.indexOf("Naninovel.Runtime") >= 0) nv = img;
            else if (nm.indexOf("Assembly-CSharp") >= 0) cs = img;
        }

        // ===== 等待 ScriptManager 就绪 =====
        function run() {
            var sm = findSvc("ScriptManager");
            if (!sm) { console.log("[fsg] ScriptManager 未就绪, 重试..."); return false; }
            var sl = sm.add(0x28).readPointer();
            var ldlField = A.gf(A.ogc(sl), Memory.allocUtf8String("LoadedByLocalPath"));
            var dict = sl.add(A.fo(ldlField)).readPointer();
            console.log("[fsg] ScriptLoader=" + sl + " LoadedByLocalPath dict=" + dict);
            if (dict.isNull()) return false;

            var dictCls = A.ogc(dict);
            var clsName = A.cgn(dictCls).readCString();
            console.log("[fsg] dict 类 = " + clsName);

            // ===== 实验1: Dictionary<string, LoadedResource> 的 .ctor(0) 是否可调 =====
            var ctorMi = A.cgm(dictCls, Memory.allocUtf8String(".ctor"), 0);
            dumpMi(ctorMi, "Dict.ctor(0)");
            var newDict = A.on(dictCls);
            var r1 = invoke(ctorMi, newDict, []);
            console.log("[fsg] Dict.ctor(0) invoke → " + (r1.ok ? "OK" : "FAIL: " + r1.err));

            // ===== 实验2: Dictionary.Add(string, LoadedResource) — inflated? =====
            var addMi = A.cgm(dictCls, Memory.allocUtf8String("Add"), 2);
            dumpMi(addMi, "Dict.Add(2)");
            // 先取一个现有条目当 value 用 (读 dict 内部 _entries)
            try {
                var eField = A.gf(dictCls, Memory.allocUtf8String("_entries"));
                var eOff = A.fo(eField);
                var entries = dict.add(eOff).readPointer();
                var cntField = A.gf(dictCls, Memory.allocUtf8String("_count"));
                var cnt = dict.add(A.fo(cntField)).readS32();
                console.log("[fsg] dict _count=" + cnt + " _entries=" + entries);
                if (cnt > 0 && !entries.isNull()) {
                    var firstEntry = entries.add(0x18);   // array data (24B entry, 8-align)
                    var firstKey = firstEntry.add(0x8).readPointer();
                    var firstVal = firstEntry.add(0x10).readPointer();
                    console.log("[fsg] 条目0: key='" + readStr(firstKey) + "' val=" + firstVal);
                    var r2 = invoke(addMi, newDict, [makeS("fsg_test_key"), firstVal]);
                    console.log("[fsg] Dict.Add 到新 dict → " + (r2.ok ? "OK" : "FAIL: " + r2.err));
                    if (r2.ok) {
                        var cnt2 = newDict.add(A.fo(cntField)).readS32();
                        console.log("[fsg] 新 dict _count=" + cnt2 + "  ← FSG 通用方法打通!");
                    }
                }
            } catch (e) { console.log("[fsg] dict 读取 err: " + e); }

            // ===== 实验3: LocalResourceProvider.converters 的 List<IConverter> 类 + 构造 =====
            try {
                var lrpCls = findClassAcrossImages("Naninovel", "LocalResourceProvider");
                // 抓游戏构造的 localization LRP
                var gameLRP = null;
                Interceptor.attach(A.cgm(lrpCls, Memory.allocUtf8String(".ctor"), 1).readPointer(), {
                    onEnter: function (a) {
                        var root = readStr(a[1]);
                        if (root && root.indexOf("Localization/Text") >= 0) gameLRP = a[0];
                    }
                });
                // 轮询等待 gameLRP
                var iv = setInterval(function () {
                    if (gameLRP) {
                        clearInterval(iv);
                        console.log("[fsg] localization LRP=" + gameLRP);
                        try {
                            var convDict = gameLRP.add(0x58).readPointer();
                            var convDictCls = A.ogc(convDict);
                            console.log("[fsg] localization converters dict=" + convDict + " 类=" + A.cgn(convDictCls).readCString());
                            var eF = A.gf(convDictCls, Memory.allocUtf8String("_entries"));
                            var cF = A.gf(convDictCls, Memory.allocUtf8String("_count"));
                            var eArr = convDict.add(A.fo(eF)).readPointer();
                            var cN = convDict.add(A.fo(cF)).readS32();
                            console.log("[fsg] converters dict _count=" + cN);
                            for (var ei = 0; ei < cN && ei < 3; ei++) {
                                var en = eArr.add(0x18 + ei * 24);
                                var k = en.add(0x8).readPointer();
                                var v = en.add(0x10).readPointer();
                                var kCls = "?"; try { kCls = A.cgn(A.ogc(k)).readCString(); } catch (e) {}
                                var vCls = "?"; try { vCls = A.cgn(A.ogc(v)).readCString(); } catch (e) {}
                                console.log("[fsg]   conv[" + ei + "] key类=" + kCls + " val=" + v + "(" + vCls + ")");
                                if (!v.isNull()) {
                                    // List<IConverter> 类测试
                                    var listCls = A.ogc(v);
                                    var lCtor = A.cgm(listCls, Memory.allocUtf8String(".ctor"), 0);
                                    dumpMi(lCtor, "List<IConverter>.ctor(0)");
                                    var nl = A.on(listCls);
                                    var rl = invoke(lCtor, nl, []);
                                    console.log("[fsg] List.ctor(0) invoke → " + (rl.ok ? "OK" : "FAIL: " + rl.err));
                                    // List.Add
                                    var laMi = A.cgm(listCls, Memory.allocUtf8String("Add"), 1);
                                    dumpMi(laMi, "List<IConverter>.Add(1)");
                                    if (rl.ok) {
                                        var ra = invoke(laMi, nl, [v]); // 随便塞个对象
                                        console.log("[fsg] List.Add invoke → " + (ra.ok ? "OK" : "FAIL: " + ra.err));
                                    }
                                    break;
                                }
                            }
                        } catch (e) { console.log("[fsg] conv dict 读取 err: " + e); }
                    }
                }, 500);
            } catch (e) { console.log("[fsg] 实验3 err: " + e); }

            return true;
        }
        var iv2 = setInterval(function () { try { if (run()) clearInterval(iv2); } catch (e) { console.log("[fsg] ERR: " + e); } }, 1000);
        return true;
    }
    var chk = setInterval(function () {
        try { var ok = doInit(); if (ok) { clearInterval(chk); console.log("[fsg] 就绪"); } }
        catch (e) { console.log("[fsg] ERR: " + e); }
    }, 200);
})();
