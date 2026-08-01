// probe_conv.js — 用 inflated 泛型方法直接填充 converters 字典, 绕开 FSG AddConverter
// 1. LRP(MOD_ROOT) → +0x58 新鲜空字典 (Dictionary<Type, List<IConverter>>)
// 2. 从字典的 genericInst 挖出 List<IConverter> 类
// 3. object_new + inflated List.ctor → inflated List.Add(NaniToScriptAssetConverter)
// 4. il2cpp_type_get_object(typeof(Script)) → inflated Dict.Add(type, list)
// 5. Insert ProvisionSource → ScriptLoader.Load 验证
'use strict';

var MOD_ROOT = "/Users/richie/manosaba decompile/manosaba_game_mac/ManosabaMod";
var MOD_KEY = "1919180";
var LOCAL_PATH = "1919180_01/Main_02";

try { var dl = Module.findGlobalExportByName("dlopen"); if (dl) { var h = false; Interceptor.attach(dl, { onEnter: function (a) { this.p = a[0].readCString(); }, onLeave: function (r) { if (h || r.isNull() || !this.p || this.p.indexOf("libsteam_api") === -1) return; var r2 = Module.findGlobalExportByName("SteamAPI_RestartAppIfNecessary"); if (r2) Interceptor.replace(r2, new NativeCallback(function () { return 0; }, 'bool', ['uint32'])); var i2 = Module.findGlobalExportByName("SteamInternal_SteamAPI_Init"); if (i2) Interceptor.replace(i2, new NativeCallback(function () { return 2; }, 'int', [])); h = true; } }); } } catch (e) { }

var A = {}, E = {}, nv = null, cs = null, allImgs = [];
var slObj = null;

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
        console.log("[cv] invoke THREW: " + en + " | " + (msg || ""));
        return ptr(0);
    }
    return ret;
}
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
// 从实例化泛型类的 type 里挖 genericInst 的某个 type 参数 → 类
function getGenericArgClass(instClass, idx) {
    var t = A.cgt(instClass);               // Il2CppType*
    if (!t || t.isNull()) { console.log("[cv] get_type NULL"); return ptr(0); }
    var typeByte = t.add(0xC).readU8();      // type 字节在 +0x0C (attrs 是 u32)
    var genCls = t.readPointer();            // data.generic_class (union 首字段)
    console.log("[cv]   type@+0xC=0x" + typeByte.toString(16) + " genCls=" + genCls);
    if (genCls.isNull()) { console.log("[cv] generic_class NULL"); return ptr(0); }
    var classInst = genCls.add(0x8).readPointer();   // context.class_inst
    if (classInst.isNull()) { console.log("[cv] class_inst NULL"); return ptr(0); }
    var argc = classInst.readU32();
    var argv = classInst.add(0x8).readPointer();     // Il2CppType**
    console.log("[cv]   genericInst argc=" + argc + " argv=" + argv);
    if (idx >= argc) { console.log("[cv] idx " + idx + " >= argc " + argc); return ptr(0); }
    var argType = argv.add(idx * 8).readPointer();
    var cls = A.cft(argType);
    if (!cls || cls.isNull()) { console.log("[cv] argType " + argType + " → class_from_type NULL"); return ptr(0); }
    var nm = "?"; try { nm = A.cgn(cls).readCString(); } catch (e) {}
    console.log("[cv]   genericInst[" + idx + "] → 类=" + nm);
    return cls;
}

function makeLRP(root) {
    var cls = findClassAcrossImages("Naninovel", "LocalResourceProvider");
    var o = A.on(cls);
    var ctorMi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 1);
    var r = invokeOk(ctorMi, o, [makeS(root)]);
    if (!r.ok) { console.log("[cv] LRP.ctor 失败"); return ptr(0); }
    console.log("[cv] LRP.ctor OK, obj=" + o);
    return o;
}
function makeConverter() {
    var cls = findClassAcrossImages("Naninovel", "NaniToScriptAssetConverter");
    var o = A.on(cls);
    var ctorMi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 0);
    var r = invokeOk(ctorMi, o, []);
    console.log("[cv] Converter.ctor → " + (r.ok ? "OK" : "FAIL") + " obj=" + o);
    return o;
}

function injectProvisionSource(sl, lrp, prefix) {
    var slCls = A.ogc(sl);
    var psField = A.gf(slCls, Memory.allocUtf8String("ProvisionSources"));
    var psList = sl.add(A.fo(psField)).readPointer();
    var psMem = Memory.alloc(16);
    psMem.writePointer(lrp);
    psMem.add(8).writePointer(makeS(prefix));
    var insMi = A.cgm(A.ogc(psList), Memory.allocUtf8String("Insert"), 2);
    var idx = Memory.alloc(4); idx.writeS32(0);
    var r = invokeOk(insMi, psList, [idx, psMem]);
    console.log("[cv] Insert(0, ps) → " + (r.ok ? "OK" : "FAIL") + " 条数=" + psList.add(0x18).readS32());
}

function testLoad() {
    console.log("[cv] ==== ScriptLoader.Load('" + LOCAL_PATH + "') ====");
    var slCls = A.ogc(slObj);
    var loadMi = A.cgm(slCls, Memory.allocUtf8String("Load"), 2);
    var holder = Memory.alloc(8); holder.writePointer(ptr(0));
    var r = invokeOk(loadMi, slObj, [makeS(LOCAL_PATH), holder]);
    console.log("[cv] Load 返回 → " + (r.ok ? "ok (UniTask)" : "fail"));
}
function pollLoaded() {
    var slCls = A.ogc(slObj);
    var glMi = A.cgm(slCls, Memory.allocUtf8String("GetLoaded"), 1);
    var r = invokeOk(glMi, slObj, [makeS(LOCAL_PATH)]);
    if (r.ok && r.ret && !r.ret.isNull()) {
        console.log("[cv] ****** GetLoaded HIT! lr=" + r.ret);
        try {
            var res = r.ret.add(0x10).readPointer();
            var obj = res.add(0x18).readPointer();
            console.log("[cv] Resource=" + res + " Object=" + obj + " class=" + (A.cgn(A.ogc(obj)).readCString() || "?"));
            var lines = obj.add(0x30).readPointer();
            if (lines && !lines.isNull()) console.log("[cv] Script lines=" + lines.add(0x18).readS32());
        } catch (e) { console.log("[cv] dump err: " + e); }
        return true;
    }
    return false;
}

function main() {
    console.log("[cv] ==== 填充 converters 字典 ====");
    var sm = findSvc("ScriptManager");
    if (!sm) { console.log("[cv] ScriptManager NOT FOUND"); return; }
    slObj = sm.add(0x28).readPointer();

    var ourLRP = makeLRP(MOD_ROOT);
    if (ourLRP.isNull()) return;
    var dict = ourLRP.add(0x58).readPointer();
    var dictCls = A.ogc(dict);
    console.log("[cv] dict=" + dict + " 类=" + A.cgn(dictCls).readCString());

    // 挖 List<IConverter> 类
    var listCls = getGenericArgClass(dictCls, 1);
    if (listCls.isNull()) { console.log("[cv] List<IConverter> 类提取失败"); return; }
    console.log("[cv] genericInst[1] → List 类=" + A.cgn(listCls).readCString());
    var iconvCls = getGenericArgClass(listCls, 0);
    console.log("[cv] List genericInst[0] → " + (iconvCls.isNull() ? "(null)" : A.cgn(iconvCls).readCString()));

    // 构造 List<IConverter> + Add(converter)
    var listObj = A.on(listCls);
    var lCtor = A.cgm(listCls, Memory.allocUtf8String(".ctor"), 0);
    var rl = invokeOk(lCtor, listObj, []);
    console.log("[cv] List.ctor → " + (rl.ok ? "OK" : "FAIL"));
    var conv = makeConverter();
    var lAdd = A.cgm(listCls, Memory.allocUtf8String("Add"), 1);
    var ra = invokeOk(lAdd, listObj, [conv]);
    console.log("[cv] List.Add(converter) → " + (ra.ok ? "OK" : "FAIL") + " size=" + listObj.add(0x18).readS32());

    // typeof(Script) 托管对象
    var scriptCls = findClassAcrossImages("Naninovel", "Script");
    var typeObj = A.tgo(A.cgt(scriptCls));
    console.log("[cv] typeof(Script)=" + typeObj + " 类=" + A.cgn(A.ogc(typeObj)).readCString());

    // Dict.Add(typeof(Script), list)
    var dAdd = A.cgm(dictCls, Memory.allocUtf8String("Add"), 2);
    var rd = invokeOk(dAdd, dict, [typeObj, listObj]);
    console.log("[cv] Dict.Add → " + (rd.ok ? "OK" : "FAIL"));
    // 验证 dict 条数
    var cF = A.gf(dictCls, Memory.allocUtf8String("_count"));
    var dc = dict.add(A.fo(cF)).readS32();
    console.log("[cv] converters dict _count=" + dc);

    injectProvisionSource(slObj, ourLRP, MOD_KEY + "/Scripts");

    setTimeout(function () { testLoad(); }, 3000);
    var tries = 0;
    var iv = setInterval(function () {
        tries++;
        if (pollLoaded()) { clearInterval(iv); console.log("[cv] ****** 加载验证成功!"); }
        else if (tries > 40) { clearInterval(iv); console.log("[cv] 40 次轮询未命中"); }
    }, 500);
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
        }

        // 等 ScriptManager 就绪后跑主流程
        var iv2 = setInterval(function () {
            try {
                if (findSvc("ScriptManager")) { clearInterval(iv2); setTimeout(function () { main(); }, 500); }
            } catch (e) { console.log("[cv] wait err: " + e); }
        }, 1000);
        return true;
    }
    var chk = setInterval(function () {
        try { var ok = doInit(); if (ok) { clearInterval(chk); console.log("[cv] 就绪"); } }
        catch (e) { console.log("[cv] ERR: " + e); }
    }, 200);
})();
