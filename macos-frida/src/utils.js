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
export function dbg() { if (MOD_DEBUG) logDebug.apply(null, arguments); }
export function wblog(msg) { logInfo("[WitchBook] " + msg); }
export function warn() { logWarn.apply(null, arguments); }
export function error() { logError.apply(null, arguments); }

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
// 从 PNG 文件字节读宽高 (IHDR 16-23 字节大端) — 绕开 Texture2D get_width/get_height 的 runtime_invoke 问题
// 供 cutin.js / choice.js 共用 (原 v3 单文件内各有一份)
export function pngDims(fb) {
    try {
        if (!fb || fb.size < 24) return null;
        var b = fb.buf;
        if (b.readU8() !== 0x89 || b.add(1).readU8() !== 0x50) return null;
        var w = (b.add(16).readU8() << 24) | (b.add(17).readU8() << 16) | (b.add(18).readU8() << 8) | b.add(19).readU8();
        var h = (b.add(20).readU8() << 24) | (b.add(21).readU8() << 16) | (b.add(22).readU8() << 8) | b.add(23).readU8();
        return (w > 0 && h > 0) ? { w: w, h: h } : null;
    } catch (e) { return null; }
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
    if (!mi || mi.isNull()) throw new Error("directCall: null MethodInfo");
    var mp = mi.readPointer();
    if (mp.isNull()) throw new Error("directCall: null methodPointer");
    var key = mp.toString() + "|" + retType;
    var fn = dcCache[key];
    if (!fn) {
        var argTypes = [];
        for (var i = 0; i < args.length; i++) argTypes.push("pointer");
        fn = new NativeFunction(mp, retType, argTypes);
        dcCache[key] = fn;
    }
    return fn.apply(null, args);
}
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

// 读取 IL2CPP invoke 返回的 boxed bool 值.
// il2cpp_runtime_invoke 对 bool 返回方法返回的是 boxed Boolean 对象指针,
// 该指针无论 bool 是 true 还是 false 都非空, 必须读 0x10 偏移处的 1 字节字段.
// 之前的 `!ckr.ret.isNull()` 永远为 true, ContainsKey 判断错误.
export function invokeBool(mi, obj, args) {
    var r = invokeOk(mi, obj, args);
    if (!r.ok) return false;
    var ret = r.ret;
    if (!ret || ret.isNull()) return false;
    try {
        var k = A.cgn(A.ogc(ret)).readCString() || "";
        if (k.indexOf("Boolean") >= 0) return ret.add(0x10).readU8() === 1;
    } catch (e) {}
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
        // 静默成功: 每次重注入 16 mod × 5 类 = 80 行/帧, 日志爆炸. 仅失败时 warn.
        return true;
    } catch (e) { dbg("[v3] populateConverters err (" + tag + "): " + e); return false; }
}

// ============ 服务查找 ============
export function findSvc(name) {
    try {
        var el = A.cfn(nv, Memory.allocUtf8String("Naninovel"), Memory.allocUtf8String("Engine"));
        if (!el || el.isNull()) { warn("[v3] findSvc('" + name + "') FAIL: Engine class NOT FOUND (nv=" + nv + ", allImgs=" + allImgs.length + ")"); return null; }
        var f = A.gf(el, Memory.allocUtf8String("services"));
        var l = A.sdf(el).add(A.fo(f)).readPointer();
        var its = l.add(0x10).readPointer(); var sz = l.add(0x18).readS32();
        for (var i = 0; i < sz; i++) {
            var ep = its.add(0x20 + i * 8).readPointer(); if (ep.isNull()) continue;
            var cn = A.cgn(A.ogc(ep)).readCString();
            if (cn === name) return ep;
        }
        warn("[v3] findSvc('" + name + "') NOT FOUND in " + sz + " services (nv=" + nv + ")");
        return null;
    } catch (e) { error("[v3] findSvc('" + name + "') err: " + e + " (nv=" + nv + ", allImgs=" + allImgs.length + ")"); return null; }
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
// macOS IL2CPP 泛型共享守卫: WitchBookPageBase._itemIds 在 CluePage 实例化为 Graphic[]、
// NotePage 为 Canvas[] (Windows 是 string[]) → 写 string[] 进去 = 内存破坏 → 写入前必须验证
export function fieldIsStringArray(obj, cls, name) {
    try {
        var f = A.gf(cls, Memory.allocUtf8String(name));
        if (!f || f.isNull()) return false;
        var v = obj.add(A.fo(f)).readPointer();
        if (!v || v.isNull()) return false;
        var cn = A.cgn(A.ogc(v)).readCString();
        return cn.indexOf("String[") >= 0;
    } catch (e) { return false; }
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
        if (!f || f.isNull()) { warn(A.cgn(cls).readCString() + "._itemIds 字段未找到"); return false; }
        var off = A.fo(f);
        var arr = page.add(off).readPointer();
        // 防御: arr 可能不是合法对象 (页面重建后字段偏移读到字符串数据), A.ogc 会原生访问违例。
        // 用 isReadable 预检 + try 包裹, 拿到真实类型/实例类用于诊断。
        var cn = "null";
        if (arr && !arr.isNull()) {
            try { cn = A.cgn(A.ogc(arr)).readCString(); }
            catch (e0) { cn = "?不可读@0x" + arr; }
        }
        var instCls = "";
        try { instCls = A.cgn(A.ogc(page)).readCString(); } catch (e1) { instCls = "?"; }
        // 仅在异常情况下记录 (cn 不含 String[): 正常 String[] 情况静默, 减少 DEBUG 噪音
        if (cn.indexOf("String[") < 0) {
            dbg(A.cgn(cls).readCString() + "._itemIds off=0x" + off.toString(16) + " val=" + arr + " type=" + cn + " 实例=" + instCls + " → 需修复");
        }
        if (cn.indexOf("String[") >= 0) return true;   // 已是 string[], 无需换
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
        } catch (e1) { ids = []; }
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
                            if (!elemIsStr) idOff = fieldOffset(elemCls, "_id", 0x10);
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
        if (!strCls || strCls.isNull()) { error(A.cgn(cls).readCString() + "._itemIds String 类未找到"); return false; }
        var na = A.an(strCls, ids.length);
        for (var i = 0; i < ids.length; i++) na.add(0x20 + i * 8).writePointer(makeS(ids[i]));
        page.add(off).writePointer(na);
        wblog(A.cgn(cls).readCString() + "._itemIds " + cn + " → String[] 重建 (" + ids.length + " 条)");
        return true;
    } catch (e) { error("ensureItemIdsString err(" + A.cgn(cls).readCString() + "): " + e); return false; }
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
    } catch (e) { error("findAllObjectOfType err: " + e); return []; }
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