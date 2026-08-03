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
export function dbg() { if (MOD_DEBUG) console.log.apply(console, arguments); }
export function wblog(msg) { console.log("[v3][WitchBook] " + msg); }

// setter (ES modules import 绑定只读, 赋值必须在模块内; entry.js 初始化时调用)
export function setImageHandles(nvImg, csImg, gigaImg) { nv = nvImg; cs = csImg; giga = gigaImg; }
export function setGotoModifiedCls(c) { gotoModifiedCls = c; }

// ============ 基础工具 ============
export function readStr(p) {
    if (!p || p.isNull()) return null;
    try {
        var l = p.add(0x10).readS32();
        if (l <= 0 || l > 9999) return null;
        var s = "";
        for (var i = 0; i < l; i++) s += String.fromCharCode(p.add(0x14 + i * 2).readU16());
        return s;
    } catch (e) { return null; }
}
export function makeS(v) { return A.sn(Memory.allocUtf8String(v || "")); }
export function invoke(mi, obj, args) {
    var params = args.length ? Memory.alloc(Process.pointerSize * args.length) : ptr(0);
    for (var i = 0; i < args.length; i++) params.add(i * Process.pointerSize).writePointer(args[i]);
    var exc = Memory.alloc(8); exc.writePointer(ptr(0));
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
    for (var i = 0; i < args.length; i++) params.add(i * Process.pointerSize).writePointer(args[i]);
    var exc = Memory.alloc(8); exc.writePointer(ptr(0));
    var ret = A.ri(mi, obj, params, exc);
    var ex = exc.readPointer();
    if (!ex.isNull()) {
        var en = ex ? (A.ogc(ex) ? A.cgn(A.ogc(ex)).readCString() : "?") : "?";
        try {
            var jsstack = new Error().stack.split("\n").slice(1, 4).join(" | ");
            dbg("[v3] invoke THREW: " + en + " <= " + jsstack);
        } catch (e2) { dbg("[v3] invoke THREW: " + en); }
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
    var fn = ctorCache[k]; if (fn) fn(obj);
}
export function findClassAcrossImages(ns, name) {
    var nsStr = Memory.allocUtf8String(ns), nmStr = Memory.allocUtf8String(name);
    var imgs = [nv, cs, giga].concat(allImgs);
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

// ============ provider 管线注册 (镜像 Windows AddModLoader, inflated 泛型版) ============
// 从实例化泛型类的 type 挖 genericInst 的某个 type 参数 → 类
export function getGenericArgClass(instClass, idx) {
    try {
        var t = A.cgt(instClass);
        if (!t || t.isNull()) return ptr(0);
        var genCls = t.readPointer();                 // data.generic_class
        if (genCls.isNull()) return ptr(0);
        var classInst = genCls.add(0x8).readPointer(); // context.class_inst
        if (classInst.isNull()) return ptr(0);
        var argc = classInst.readU32();
        var argv = classInst.add(0x8).readPointer();   // Il2CppType**
        if (idx >= argc) return ptr(0);
        return A.cft(argv.add(idx * 8).readPointer());
    } catch (e) { dbg("[v3] getGenericArgClass err: " + e); return ptr(0); }
}

// 用 inflated 泛型方法填充 LRP.converters (Dictionary<Type, List<IConverter>>) — 绕开 FSG AddConverter
// convClassName: 转换器类名; targetClsFn: () => 目标类型的 Il2CppClass (Script/TextAsset)
export function populateConvertersDict(lrp, convClassName, targetClsFn, tag) {
    try {
        var dict = lrp.add(0x58).readPointer();
        var dictCls = A.ogc(dict);
        var listCls = getGenericArgClass(dictCls, 1);          // List<IConverter>
        if (listCls.isNull()) { dbg("[v3] List<IConverter> 类提取失败 (" + tag + ")"); return false; }
        var listObj = A.on(listCls);
        if (!invokeOk(A.cgm(listCls, Memory.allocUtf8String(".ctor"), 0), listObj, []).ok) { dbg("[v3] List.ctor 失败 (" + tag + ")"); return false; }
        var convCls = findClassAcrossImages("Naninovel", convClassName);
        if (convCls.isNull()) { dbg("[v3] " + convClassName + " NOT FOUND"); return false; }
        var conv = A.on(convCls);
        if (!invokeOk(A.cgm(convCls, Memory.allocUtf8String(".ctor"), 0), conv, []).ok) { dbg("[v3] " + convClassName + ".ctor 失败"); return false; }
        if (!invokeOk(A.cgm(listCls, Memory.allocUtf8String("Add"), 1), listObj, [conv]).ok) { dbg("[v3] List.Add 失败 (" + tag + ")"); return false; }
        var targetCls = targetClsFn();
        if (targetCls.isNull()) { dbg("[v3] 目标类型类 NULL (" + tag + ")"); return false; }
        var typeObj = A.tgo(A.cgt(targetCls));               // typeof(target)
        if (!invokeOk(A.cgm(dictCls, Memory.allocUtf8String("Add"), 2), dict, [typeObj, listObj]).ok) { dbg("[v3] Dict.Add 失败 (" + tag + ")"); return false; }
        dbg("[v3] converters 填充 OK (" + convClassName + " → " + tag + ")");
        return true;
    } catch (e) { dbg("[v3] populateConverters err (" + tag + "): " + e); return false; }
}

// ============ 服务查找 ============
export function findSvc(name) {
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

// 找 System 类型 (mscorlib 等)
export function getSystemClass(name) {
    for (var i = 0; i < allImgs.length; i++) {
        var inm = A.ign(allImgs[i]).readCString();
        if (inm.indexOf("mscorlib") >= 0 || inm.indexOf("System.Private") >= 0 || inm.indexOf("CoreLib") >= 0) {
            var c = A.cfn(allImgs[i], Memory.allocUtf8String("System"), Memory.allocUtf8String(name));
            if (c && !c.isNull()) return c;
        }
    }
    return ptr(0);
}
// 按名称在类的嵌套类型里找 (CluePage.LocalizedTexts 等 private 嵌套类; cgn 可能带前缀, 用后缀匹配)
export function findNestedClass(parentCls, name) {
    try {
        var iter = Memory.alloc(8); iter.writePointer(ptr(0));
        for (;;) {
            var p = A.cgnt(parentCls, iter);
            if (!p || p.isNull()) break;
            var nc = p.readPointer();
            if (!nc || nc.isNull()) break;
            var nn = A.cgn(nc).readCString() || "";
            if (nn === name || nn.indexOf("." + name) >= 0) return nc;
        }
    } catch (e) {}
    return ptr(0);
}
// 字段偏移: 动态查 (含基类) + 回退
export function fieldOffset(cls, name, fallback) {
    try {
        var f = A.gf(cls, Memory.allocUtf8String(name));
        if (f && !f.isNull()) return A.fo(f);
    } catch (e) {}
    return fallback;
}
// Object.FindObjectsOfType(Type) → Object[] → 非空实例数组
export function findAllObjectOfType(cls) {
    try {
        var objCls = findClassAcrossImages("UnityEngine", "Object");
        if (!objCls || objCls.isNull()) return [];
        var typeObj = A.tgo(A.cgt(cls));
        var arr = null;
        // FindObjectsOfType(Type) — 若 1 参无 RVA/invoker, 回退 2 参 (Type, includeInactive:false)
        var mi = A.cgm(objCls, Memory.allocUtf8String("FindObjectsOfType"), 1);
        if (mi && !mi.isNull() && mi.readPointer() && !mi.readPointer().isNull()) {
            arr = invoke(mi, ptr(0), [typeObj]);
        } else {
            var mi2 = A.cgm(objCls, Memory.allocUtf8String("FindObjectsOfType"), 2);
            if (!mi2 || mi2.isNull()) return [];
            var fb = Memory.alloc(4); fb.writeS32(0);
            arr = invoke(mi2, ptr(0), [typeObj, fb]);
        }
        if (!arr || arr.isNull() || arr.add(0x18).readS32() === 0) {
            // 纯资产 (CharacterData/AuthorData 等 ScriptableObject) 需 FindObjectsOfTypeAll (镜像 Windows Resources.FindObjectsOfTypeAll)
            try {
                var resCls = findClassAcrossImages("UnityEngine", "Resources");
                var mia = A.cgm(resCls, Memory.allocUtf8String("FindObjectsOfTypeAll"), 1);
                if (mia && !mia.isNull() && mia.readPointer() && !mia.readPointer().isNull()) arr = invoke(mia, ptr(0), [typeObj]);
            } catch (e) {}
        }
        if (!arr || arr.isNull()) return [];
        var len = arr.add(0x18).readS32();
        var out = [];
        for (var i = 0; i < len; i++) {
            var e = arr.add(0x20 + i * 8).readPointer();
            if (e && !e.isNull()) out.push(e);
        }
        return out;
    } catch (e) { wblog("findAllObjectOfType err: " + e); return []; }
}
export function findFirstObjectOfType(cls) { var a = findAllObjectOfType(cls); return a.length ? a[0] : null; }
// List<T> 里是否已有 id。List 布局: _items(T[])@+0x10, _size(int)@+0x18, _version@+0x1C
// 数组元素在 arr+0x20 (SZARRAY 数据区)
export function listContainsId(list, id, idOff) {
    try {
        var cnt = list.add(0x18).readS32(), items = list.add(0x10).readPointer();
        for (var i = 0; i < cnt; i++) {
            var e = items.add(0x20 + i * 8).readPointer();
            if (e.isNull()) continue;
            if (readStr(e.add(idOff).readPointer()) === id) return true;
        }
    } catch (e) {}
    return false;
}

// 找 UnityEngine.CoreModule image
export function findUnityImg() {
    for (var i = 0; i < allImgs.length; i++) {
        var inm = A.ign(allImgs[i]).readCString();
        if (inm.indexOf("UnityEngine.CoreModule") >= 0) return allImgs[i];
    }
    return null;
}
// 创建 Unity 对象: object_new + 0参构造 (runtime_invoke → 直调 fallback)
export function makeUnityObject(cls) {
    var o = A.on(cls);
    var ctorMi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 0);
    if (!ctorMi || ctorMi.isNull()) return o;
    var r = invokeOk(ctorMi, o, []);
    if (r.ok) return o;
    try {
        var mpFn = new NativeFunction(ctorMi.readPointer(), 'void', ['pointer']);
        mpFn(o);
    } catch (e) { }
    return o;
}

export function makeNullStr(str) {
    var cls = findClassAcrossImages("Naninovel", "NullableString");
    if (!cls || cls.isNull()) return ptr(0);
    var o = A.on(cls); tryCtor(cls, o);
    o.add(0x10).writePointer(str || ptr(0)); o.add(0x18).writeS32(str ? 1 : 0);
    return o;
}
// NamedString 用构造器创建, 不猜字段布局: ctor(name, value)
export function makeNamedStringCtor(name, value) {
    var cls = findClassAcrossImages("Naninovel", "NamedString");
    if (!cls || cls.isNull()) return ptr(0);
    var o = A.on(cls);
    var ctorMi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 2);
    if (!ctorMi || ctorMi.isNull()) { dbg("[v3] NamedString.ctor NOT FOUND"); return ptr(0); }
    invoke(ctorMi, o, [makeS(name || ""), makeS(value || "")]);
    return o;
}
// 创建 LocalResourceProvider(rootPath) — runtime_invoke 失败则直调 methodPointer
export function makeLocalResourceProvider(root) {
    var cls = findClassAcrossImages("Naninovel", "LocalResourceProvider");
    if (!cls || cls.isNull()) { dbg("[v3] LocalResourceProvider NOT FOUND"); return ptr(0); }
    var o = A.on(cls);
    var ctorMi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 1);
    if (!ctorMi || ctorMi.isNull()) { dbg("[v3] LRP.ctor NOT FOUND"); return ptr(0); }
    var strPtr = makeS(root || "");
    var r = invokeOk(ctorMi, o, [strPtr]);
    if (r.ok) { return o; }
    // 回退: 直接调 methodPointer (纯 .NET 1 参, ABI: x0=this, x1=string)
    try {
        var mp = ctorMi.readPointer();
        dbg("[v3] LRP ctor runtime_invoke 失败, 尝试直调 methodPointer=" + mp + " invoker槽=" + ctorMi.add(0x10).readPointer());
        var mpFn = new NativeFunction(mp, 'void', ['pointer', 'pointer']);
        mpFn(o, strPtr);
        dbg("[v3] LRP ctor 直调成功");
        return o;
    } catch (e) {
        dbg("[v3] LRP ctor 直调也失败: " + e);
        return ptr(0);
    }
}
