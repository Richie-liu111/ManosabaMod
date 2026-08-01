// probe_reps.js — 读 NaniToScriptAssetConverter.Representations 确认扩展名映射
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
function invokeOk(mi, obj, args) {
    var params = args.length ? Memory.alloc(Process.pointerSize * args.length) : ptr(0);
    for (var i = 0; i < args.length; i++) params.add(i * Process.pointerSize).writePointer(args[i]);
    var exc = Memory.alloc(8); exc.writePointer(ptr(0));
    var ret = A.ri(mi, obj, params, exc);
    var ex = exc.readPointer();
    if (!ex.isNull()) { return { ok: false, ret: ptr(0) }; }
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
        A.ta  = new NativeFunction(E.il2cpp_thread_attach, 'pointer', ['pointer']);
        var dom = A.dg();
        try { A.ta(dom); } catch (e) {}
        var cp = Memory.alloc(8);
        var asms = A.dga(dom, cp); var cnt = cp.readPointer().toInt32();
        for (var i = 0; i < cnt; i++) {
            var a = asms.add(i * 8).readPointer(); var img = A.agi(a); var nm = A.ign(img).readCString();
            allImgs.push(img);
            if (nm.indexOf("Naninovel.Runtime") >= 0) nv = img;
            else if (nm.indexOf("Assembly-CSharp") >= 0) cs = img;
        }
        var cls = findClassAcrossImages("Naninovel", "NaniToScriptAssetConverter");
        var o = A.on(cls);
        var rc = invokeOk(A.cgm(cls, Memory.allocUtf8String(".ctor"), 0), o, []);
        console.log("[reps] ctor → " + (rc.ok ? "OK" : "FAIL"));
        var arr = o.add(0x10).readPointer();   // Representations 字段
        if (arr.isNull()) { console.log("[reps] Representations 为 null"); return true; }
        var len = arr.add(0x18).readS32();     // max_length 在 +0x18
        console.log("[reps] Representations 数组 len=" + len + " (data@+0x20)");
        for (var i = 0; i < len && i < 8; i++) {
            var elem = arr.add(0x20 + i * 16);
            var ext = readStr(elem.readPointer());
            var mime = readStr(elem.add(8).readPointer());
            console.log("[reps]   [" + i + "] ext='" + ext + "' mime='" + mime + "'");
        }
        return true;
    }
    var chk = setInterval(function () {
        try { var ok = doInit(); if (ok) { clearInterval(chk); console.log("[reps] done"); } }
        catch (e) { console.log("[reps] ERR: " + e); }
    }, 200);
})();
