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

var chCls = null;            // 解析好的类表
var chData = {
    handlers: [],            // {id, basePanel, portraitPath, sprite}
    metaMap: null,
    providerKey: "ModChoiceHandlers",
    vrp: null,               // 共享 VirtualResourceProvider (providersMap.Add 一个 key 一个 vrp)
    cloned: {},              // id -> 克隆面板
    registeredIds: {},       // id -> true (AddRecord 幂等)
    registered: false,
    finalizing: false,
    resGOClass: null,        // 偷到的 Resource`1<GameObject> inflated 类
};
var chGOTriggered = false;   // 触发只做一次 (探针实证一次性有效)
var chPollTimer = null;

// ============ 类解析 ============
function resolveChoiceHandlerClasses() {
    var m = {};
    m.trialPanel   = findClassAcrossImages("WitchTrials.Views", "TrialChoiceHandlerPanel");
    m.customUI     = findClassAcrossImages("Naninovel.UI", "CustomUI");
    m.image        = findClassAcrossImages("UnityEngine.UI", "Image");
    m.rectTransform = findClassAcrossImages("UnityEngine", "RectTransform");
    m.gameObject   = findClassAcrossImages("UnityEngine", "GameObject");
    m.component    = findClassAcrossImages("UnityEngine", "Component");
    m.object       = findClassAcrossImages("UnityEngine", "Object");
    m.sprite       = findClassAcrossImages("UnityEngine", "Sprite");
    m.texture2d    = findClassAcrossImages("UnityEngine", "Texture2D");
    m.imageConversion = findClassAcrossImages("UnityEngine", "ImageConversion");
    m.vrp          = findClassAcrossImages("Naninovel", "VirtualResourceProvider");
    m.resource     = findClassAcrossImages("Naninovel", "Resource");          // base Resource
    m.resourceLoaderConfig = findClassAcrossImages("Naninovel", "ResourceLoaderConfiguration");
    m.choiceHandlerMeta = findClassAcrossImages("Naninovel", "ChoiceHandlerMetadata");
    m.uih          = findClassAcrossImages("Naninovel", "UIChoiceHandler");
    return m;
}

// ============ 数据加载 (Title 时调用) ============
function loadChoiceHandlerData() {
    chData.handlers = [];
    if (typeof MOD_ROOT === "undefined" || typeof modList === "undefined" || !modList || !modList.length) return;
    for (var i = 0; i < modList.length; i++) {
        var root = MOD_ROOT + "/" + modList[i].key;
        var inf = readJSONFile(root + "/info.json");   // 注意: 变量名不能叫 info (遮蔽 import 的 info 日志函数)
        if (!inf || !inf.ChoiceHandlers) continue;
        for (var c = 0; c < inf.ChoiceHandlers.length; c++) {
            var ch = inf.ChoiceHandlers[c];
            if (!ch || !ch.Id || !ch.Portrait) continue;
            chData.handlers.push({ id: ch.Id, basePanel: ch.BasePanel || "Trial", portraitPath: root + "/" + ch.Portrait, sprite: null });
            dbg("[Choice] 待注册 handler '" + ch.Id + "' (base=" + (ch.BasePanel || "Trial") + ")");
        }
    }
    if (chData.handlers.length) info("[Choice] 共 " + chData.handlers.length + " 个 mod choice handler");
}
// 读立绘 PNG → Texture2D, 返回 {tex,w,h}
function chLoadTexture(path) {
    try {
        var fb = fileReadBytes(path);
        if (!fb || fb.size <= 0) { warn("[Choice] 读立绘失败 '" + path + "'"); return null; }
        var dims = pngDims(fb);
        if (!dims) { warn("[Choice] PNG 尺寸读取失败 '" + path + "'"); return null; }
        var byteCls = getSystemClass("Byte");
        var barr = A.an(byteCls, fb.size);
        barr.add(0x20).writeByteArray(fb.buf.readByteArray(fb.size));
        var tex = A.on(chCls.texture2d);
        var wbuf = Memory.alloc(4); wbuf.writeS32(dims.w);
        var hbuf = Memory.alloc(4); hbuf.writeS32(dims.h);
        var ctorMi = A.cgm(chCls.texture2d, Memory.allocUtf8String(".ctor"), 2);
        if (ctorMi && !ctorMi.isNull()) invokeOk(ctorMi, tex, [wbuf, hbuf]);
        var liMi = A.cgm(chCls.imageConversion, Memory.allocUtf8String("LoadImage"), 2);
        if (!liMi || liMi.isNull()) { warn("[Choice] ImageConversion.LoadImage NOT FOUND"); return null; }
        var r = invokeOk(liMi, ptr(0), [tex, barr]);
        if (!r.ok) { warn("[Choice] LoadImage 失败 '" + path + "'"); return null; }
        return { tex: tex, w: dims.w, h: dims.h };
    } catch (e) { warn("[Choice] chLoadTexture err '" + path + "': " + e); return null; }
}
// Sprite.Create — choice 立绘用原版 ChoicePortrait pivot(0.31,0.5)/ppu100 (5 参重载, 4 参 macOS 崩)
function chMakeSprite(ent) {
    try {
        if (!ent || !ent.tex || ent.tex.isNull() || !ent.w || !ent.h) { warn("[Choice] 立绘参数无效, 跳过 Sprite.Create"); return null; }
        var rect = Memory.alloc(16);
        rect.writeFloat(0); rect.add(4).writeFloat(0); rect.add(8).writeFloat(ent.w); rect.add(12).writeFloat(ent.h);
        var pivot = Memory.alloc(8);
        pivot.writeFloat(0.31); pivot.add(4).writeFloat(0.5);
        var ppuPtr = Memory.alloc(4); ppuPtr.writeFloat(100);
        var createMi = A.cgm(chCls.sprite, Memory.allocUtf8String("Create"), 5);
        if (!createMi || createMi.isNull()) { warn("[Choice] Sprite.Create NOT FOUND"); return null; }
        var extrude = Memory.alloc(4); extrude.writeU32(0);
        var r = invokeOk(createMi, ptr(0), [ent.tex, rect, pivot, ppuPtr, extrude]);
        if (!r.ok) { warn("[Choice] Sprite.Create FAIL"); return null; }
        return r.ret;
    } catch (e) { warn("[Choice] chMakeSprite err: " + e); return null; }
}
function registerChoiceHandlers() {
    try {
        if (!chCls || !chCls.texture2d || chCls.texture2d.isNull()) { warn("[Choice] 类未解析, 跳过立绘预加载"); return; }
        for (var i = 0; i < chData.handlers.length; i++) {
            var hd = chData.handlers[i];
            if (hd.sprite) continue;
            var ent = chLoadTexture(hd.portraitPath);
            if (!ent) continue;
            hd.sprite = chMakeSprite(ent);
            if (hd.sprite) info("[Choice] 立绘已加载 '" + hd.id + "' (" + ent.w + "x" + ent.h + ")");
        }
    } catch (e) { warn("[Choice] registerChoiceHandlers err: " + e); }
}
function chObjName(p) {
    try {
        if (!p || p.isNull()) return null;
        var nmMi = A.cgm(chCls.object, Memory.allocUtf8String("get_name"), 0);
        if (!nmMi || nmMi.isNull()) return null;
        return readStr(invoke(nmMi, p, []));
    } catch (e) { return null; }
}
// 换立绘: 遍历克隆子树 Image, 优先 sprite 名以 "ChoicePortrait_" 开头, 退化选 RectTransform 最高
function chSwapPortrait(clone, sprite) {
    try {
        var go = clone;
        try {
            var ggMi = A.cgm(chCls.component, Memory.allocUtf8String("get_gameObject"), 0);
            if (ggMi && !ggMi.isNull()) { var g2 = invoke(ggMi, clone, []); if (g2 && !g2.isNull()) go = g2; }
        } catch (e) {}
        var gicMi = A.cgm(chCls.gameObject, Memory.allocUtf8String("GetComponentsInChildren"), 2);
        if (!gicMi || gicMi.isNull()) { warn("[Choice] GetComponentsInChildren NOT FOUND"); return false; }
        var typeObj = A.tgo(A.cgt(chCls.image));
        var tbool = Memory.alloc(4); tbool.writeS32(1);
        var imgArr = invoke(gicMi, go, [typeObj, tbool]);
        var getSprMi = A.cgm(chCls.image, Memory.allocUtf8String("get_sprite"), 0);
        var best = null, bestScore = -1;
        var len = imgArr ? imgArr.add(0x18).readS32() : 0;
        for (var i = 0; i < len; i++) {
            var img = imgArr.add(0x20 + i * 8).readPointer();
            if (!img || img.isNull()) continue;
            var sp = (getSprMi && !getSprMi.isNull()) ? invoke(getSprMi, img, []) : ptr(0);
            var spName = sp && !sp.isNull() ? chObjName(sp) : "";
            var score = (spName && spName.indexOf("ChoicePortrait_") === 0) ? 10000 : 0;
            if (score === 0) {
                try {
                    var grtMi = A.cgm(chCls.image, Memory.allocUtf8String("get_rectTransform"), 0);
                    var rtMi = A.cgm(chCls.rectTransform, Memory.allocUtf8String("get_rect"), 0);
                    var rt = (grtMi && !grtMi.isNull() && rtMi && !rtMi.isNull()) ? invoke(rtMi, invoke(grtMi, img, []), []) : null;
                    if (rt && !rt.isNull()) score = Math.abs(rt.add(12).readFloat());   // Rect.height
                } catch (e2) {}
            }
            if (score > bestScore) { bestScore = score; best = img; }
        }
        if (best) {
            var setSprMi = A.cgm(chCls.image, Memory.allocUtf8String("set_sprite"), 1);
            if (setSprMi && !setSprMi.isNull()) invoke(setSprMi, best, [sprite]);
            var snsMi = A.cgm(chCls.image, Memory.allocUtf8String("SetNativeSize"), 0);
            if (snsMi && !snsMi.isNull()) invoke(snsMi, best, []);
            info("[Choice] 换立绘 OK '" + chObjName(clone) + "' (score=" + bestScore + ")");
            return true;
        }
        warn("[Choice] 未找到 portrait Image (len=" + len + ")");
    } catch (e) { warn("[Choice] chSwapPortrait err: " + e); }
    return false;
}

// ============ Resource`1<GameObject> inflated 类捕获 ============
// (探针实证: def 类 Resource(string,Object) ctor hook 抓不到 inflated 调用 — "泛型类方法不共享";
//  有效路径 = 触发按钮加载后从 LoadedByFullPath 缓存条目偷取)
function chFindResourceLoader() {
    var mgr = findSvc("ChoiceHandlerManager");
    if (!mgr) mgr = findSvc("WitchTrialsChoiceHandlerManager");
    if (!mgr) { dbg("[Choice] steal: mgr NOT FOUND"); return null; }
    var cands = [0x38, 0x40, 0x48, 0x50, 0x58, 0x60, 0x68, 0x70, 0x78, 0x80, 0x88, 0x90];
    for (var i = 0; i < cands.length; i++) {
        try {
            var p = mgr.add(cands[i]).readPointer();
            if (!p || p.isNull()) continue;
            var cn = A.cgn(A.ogc(p)).readCString();
            if (cn && cn.indexOf("ResourceLoader") >= 0) { dbg("[Choice] steal: ResourceLoader @0x" + cands[i].toString(16) + " = " + cn); return p; }
        } catch (e) {}
    }
    return null;
}
function chStealResourceGOClass() {
    try {
        var rl = chFindResourceLoader();
        if (!rl || rl.isNull()) return null;
        var rlKlass = A.ogc(rl);
        chData.rlKlass = rlKlass;   // 供 diag hook: ResourceLoader`1<GameObject> 泛型类 (inflated, 特化体已生成)
        var out = null;
        ["LoadedByFullPath", "LoadedByLocalPath"].forEach(function (fname) {
            if (out) return;
            try {
                var f = A.gf(rlKlass, Memory.allocUtf8String(fname));
                if (!f || f.isNull()) return;
                var dict = rl.add(A.fo(f)).readPointer();
                if (!dict || dict.isNull()) return;
                var ents = dict.add(0x18).readPointer();
                if (!ents || ents.isNull()) return;
                var al = ents.add(0x18).readS32();
                for (var e = 0; e < al; e++) {
                    var eb = ents.add(0x20 + e * 24);
                    if (eb.readS32() === -1) continue;
                    var lr = eb.add(16).readPointer();
                    if (lr.isNull()) continue;
                    var sysRes = lr.add(0x10).readPointer();   // LoadedResource<T>.Resource
                    if (sysRes && !sysRes.isNull()) { out = sysRes.readPointer(); return; }
                }
            } catch (e2) {}
        });
        if (out) { chData.resGOClass = out; info("[Choice] 偷到 Resource<GameObject> klass=" + A.cgn(out).readCString() + " (from " + (chData.resGOClass ? "loaded cache" : "cache") + ")"); }
        return out;
    } catch (e) { dbg("[Choice] chStealResourceGOClass err: " + e); return null; }
}

// ============ 触发 (探针实证有效: GetOrAddActor + 按钮 LoadAsync 双触发) ============
function chTriggerGOClass() {
    try {
        if (chGOTriggered) return;
        chGOTriggered = true;
        var mgr = findSvc("ChoiceHandlerManager");
        if (!mgr) mgr = findSvc("WitchTrialsChoiceHandlerManager");
        if (!mgr || mgr.isNull()) { chGOTriggered = false; return; }
        var cfg = null;
        for (var o = 0x10; o <= 0x80 && !cfg; o += 8) {
            try {
                var c = mgr.add(o).readPointer();
                if (c.isNull()) continue;
                if (A.cgn(A.ogc(c)).readCString() === "ChoiceHandlersConfiguration") cfg = c;
            } catch (e) {}
        }
        var trigId = "Trial";
        if (cfg && !cfg.isNull()) { try { var dhid = readStr(cfg.add(0x28).readPointer()); if (dhid) trigId = dhid; } catch (e) {} }
        try {
            var goaMi = A.cgm(A.ogc(mgr), Memory.allocUtf8String("GetOrAddActor"), 1);
            if (goaMi && !goaMi.isNull()) {
                invoke(goaMi, mgr, [makeS("Trial")]);
                if (trigId !== "Trial") invoke(goaMi, mgr, [makeS(trigId)]);
                dbg("[Choice] 触发 GetOrAddActor('Trial')" + (trigId !== "Trial" ? "+'" + trigId + "'" : "") + " (fire-and-forget)");
            }
        } catch (e5) { dbg("[Choice] 触发 GetOrAddActor err: " + e5); }
        try {
            var bl = mgr.add(0x58).readPointer();
            if (bl && !bl.isNull()) {
                var laMi = ptr(0);
                [2, 1].forEach(function (ac) {
                    if (laMi && !laMi.isNull()) return;
                    try { laMi = A.cgm(A.ogc(bl), Memory.allocUtf8String("LoadAsync"), ac); } catch (e) {}
                });
                if (!laMi || laMi.isNull()) { try { laMi = A.cgm(A.ogc(bl), Memory.allocUtf8String("Load"), 2); } catch (e) {} }
                if (laMi && !laMi.isNull()) {
                    invoke(laMi, bl, [makeS("ChoiceButtons/Trial/Objection"), ptr(0)]);
                    dbg("[Choice] 触发按钮加载 ChoiceButtons/Trial/Objection (fire-and-forget)");
                }
            }
        } catch (e4) { dbg("[Choice] 按钮加载 err: " + e4); }
    } catch (e) { warn("[Choice] chTriggerGOClass err: " + e); }
}

// ============ bool 返回值 (探针 run 7 教训: 值类型返回装箱, 直接 readU8 是 klass 指针低位) ============
function chBool(r) {
    var ret = r && r.ok ? r.ret : null;
    if (!ret || ret.isNull()) return false;
    try {
        var k = A.cgn(A.ogc(ret)).readCString() || "";
        if (k.indexOf("Boolean") >= 0) return ret.add(0x10).readU8() === 1;
    } catch (e) {}
    return ret.readU8() === 1;
}

// ============ 托管链 (镜像 C# 四步, 全部 invoke + 自验证) ============
// R1: 共享 VRP 构造 (0参ctor; 探针实证 Resources@0x28 是 ctor 建好的真空 Dictionary`2)
function chEnsureVrp() {
    if (chData.vrp && !chData.vrp.isNull()) return chData.vrp;
    var vrp = A.on(chCls.vrp);
    var ctor = A.cgm(chCls.vrp, Memory.allocUtf8String(".ctor"), 0);
    var r = ctor && !ctor.isNull() ? invokeOk(ctor, vrp, []) : { ok: false, ex: "无 0参 ctor" };
    if (!r.ok) { warn("[Choice] VRP ctor FAIL (invoke 异常, 详见日志)"); return null; }
    var resDict = vrp.add(fieldOffset(chCls.vrp, "Resources", 0x28)).readPointer();
    if (!resDict || resDict.isNull()) { warn("[Choice] VRP.Resources 为空 — 地基坏, 中止"); return null; }
    chData.vrp = vrp;
    chData.vrpDict = resDict;
    info("[Choice] R1: VRP 构造 OK vrp=" + vrp + " Resources=" + resDict + " (" + A.cgn(A.ogc(resDict)).readCString() + ")");
    return vrp;
}
// R2: 真 Resource`1<GameObject> 构造 (2参ctor invoke; 探针实证读回 path/object 正确)
function chMakeResourceGO(path, obj) {
    var cls = chData.resGOClass;
    if (!cls || cls.isNull()) { warn("[Choice] Resource<GameObject> 类未捕获, 先触发"); chTriggerGOClass(); return null; }
    var res = A.on(cls);
    var ctor2 = A.cgm(cls, Memory.allocUtf8String(".ctor"), 2);
    var r = ctor2 && !ctor2.isNull() ? invokeOk(ctor2, res, [makeS(path), obj]) : { ok: false };
    if (!r.ok) { warn("[Choice] Resource ctor FAIL '" + path + "'"); return null; }
    var pback = readStr(res.add(0x10).readPointer());
    if (pback !== path) { warn("[Choice] Resource 读回 path 不符 '" + pback + "' vs '" + path + "'"); return null; }
    dbg("[Choice] R2: Resource<GameObject> '" + path + "' 构造 OK res=" + res + " obj=" + res.add(0x18).readPointer());
    return res;
}
// R3: Resources.Add + ContainsKey 自验证 (探针实证全通; 内容哈希 → makeS key 即真实 key)
function chServeResource(path, res) {
    var dict = chData.vrp.add(fieldOffset(chCls.vrp, "Resources", 0x28)).readPointer();
    var dictCls = A.ogc(dict);
    var addMi = A.cgm(dictCls, Memory.allocUtf8String("Add"), 2);
    var ckMi = A.cgm(dictCls, Memory.allocUtf8String("ContainsKey"), 1);
    if (!addMi || addMi.isNull() || !ckMi || ckMi.isNull()) { warn("[Choice] Resources.Add/ContainsKey NOT FOUND"); return false; }
    var ar = invokeOk(addMi, dict, [makeS(path), res]);
    if (!ar.ok) { warn("[Choice] Resources.Add FAIL '" + path + "'"); return false; }
    var ck = invokeOk(ckMi, dict, [makeS(path)]);
    var ck2 = invokeOk(ckMi, dict, [makeS(path + "__NOPE__")]);
    var ok = chBool(ck) && !chBool(ck2);
    info("[Choice] R3: Resources.Add('" + path + "') OK ContainsKey=" + chBool(ck) + " 对照组=" + chBool(ck2) + " → " + (ok ? "✓" : "✗"));
    return ok;
}
// R4: meta 构造 + AddRecord + ContainsId 验证 (Implementation 从 vanilla Trial meta 逐字节复制)
function chRegisterMeta(hd) {
    try {
        if (chData.registeredIds[hd.id]) return true;
        var metaMap = chData.metaMap;
        var meta = A.on(chCls.choiceHandlerMeta);
        var mctor = A.cgm(chCls.choiceHandlerMeta, Memory.allocUtf8String(".ctor"), 0);
        var mr = mctor && !mctor.isNull() ? invokeOk(mctor, meta, []) : { ok: false, ex: "无 0参 ctor" };
        if (!mr.ok) { warn("[Choice] meta ctor FAIL (invoke 异常)"); return false; }
        // Implementation: vanilla Trial meta 的真实串 (探针实证可读)
        var implStr = "Naninovel.UIChoiceHandler, Elringus.Naninovel.Runtime, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null";
        try {
            var gmMi = A.cgm(A.ogc(metaMap), Memory.allocUtf8String("GetMetadata"), 1);
            if (gmMi && !gmMi.isNull()) {
                var vm = invokeOk(gmMi, metaMap, [makeS("Trial")]);
                if (vm.ok && vm.ret && !vm.ret.isNull()) {
                    var vs = readStr(vm.ret.add(fieldOffset(chCls.choiceHandlerMeta, "Implementation", 0x10)).readPointer());
                    if (vs) implStr = vs;
                }
            }
        } catch (e) {}
        meta.add(fieldOffset(chCls.choiceHandlerMeta, "Implementation", 0x10)).writePointer(makeS(implStr));
        // Loader: 真 ResourceLoaderConfiguration (PathPrefix + ProviderTypes)
        var loader = A.on(chCls.resourceLoaderConfig);
        var lctor = A.cgm(chCls.resourceLoaderConfig, Memory.allocUtf8String(".ctor"), 0);
        var lr = lctor && !lctor.isNull() ? invokeOk(lctor, loader, []) : { ok: false, ex: "无 0参 ctor" };
        if (!lr.ok) { warn("[Choice] loader ctor FAIL (invoke 异常)"); return false; }
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
                        if (!lcr.ok) warn("[Choice] ProviderTypes List ctor FAIL: " + lcr.ex);
                    } else warn("[Choice] ProviderTypes List ctor NOT FOUND");
                    var laMi = A.cgm(listCls, Memory.allocUtf8String("Add"), 1);
                    if (laMi && !laMi.isNull()) {
                        var lar = invokeOk(laMi, list, [makeS(chData.providerKey)]);
                        if (!lar.ok) warn("[Choice] ProviderTypes List.Add('" + chData.providerKey + "') FAIL: " + lar.ex);
                    } else warn("[Choice] ProviderTypes List.Add NOT FOUND");
                    loader.add(fieldOffset(chCls.resourceLoaderConfig, "ProviderTypes", 0x18)).writePointer(list);
                    // 读回自验证 (2026-08-11 源码对照: GetProviders 遍历 ProviderTypes, 空列表 → 永远无 vrp → Load 直接 Invalid)
                    try {
                        var lsz = list.add(0x18).readS32();
                        var lit = list.add(0x10).readPointer();
                        var l0 = (lsz > 0 && lit && !lit.isNull() && lit.add(0x18).readS32() > 0) ? readStr(lit.add(0x20).readPointer()) : null;
                        info("[Choice] ProviderTypes 读回: size=" + lsz + " [0]='" + (l0 || "?") + "'");
                        if (lsz !== 1 || l0 !== chData.providerKey)
                            warn("[Choice] ProviderTypes 内容异常! 游戏 GetProviders 将拿不到 '" + chData.providerKey + "' (疑似根因)");
                    } catch (e) { warn("[Choice] ProviderTypes 读回 err: " + e); }
                }
            }
        } catch (e) { dbg("[Choice] ProviderTypes 构造 err: " + e); }
        meta.add(fieldOffset(chCls.choiceHandlerMeta, "Loader", 0x18)).writePointer(loader);
        try { meta.add(fieldOffset(chCls.choiceHandlerMeta, "WaitHideOnChoice", 0x30)).writeU8(0); } catch (e) {}
        // 读回核对
        var implBack = readStr(meta.add(fieldOffset(chCls.choiceHandlerMeta, "Implementation", 0x10)).readPointer());
        var ldrBack = meta.add(fieldOffset(chCls.choiceHandlerMeta, "Loader", 0x18)).readPointer();
        var pfxBack = readStr(loader.add(fieldOffset(chCls.resourceLoaderConfig, "PathPrefix", 0x10)).readPointer());
        info("[Choice] meta 读回: id='" + hd.id + "' Impl='" + (implBack || "") + "' Loader=" + (ldrBack && !ldrBack.isNull() ? "0x" + ldrBack.toString() : "NULL") + " PathPrefix='" + (pfxBack || "") + "'");
        // AddRecord + ContainsId 自验证 (探针实证: 装箱 bool 必须 chBool 读)
        var arMi = A.cgm(A.ogc(metaMap), Memory.allocUtf8String("AddRecord"), 2);
        if (!arMi || arMi.isNull()) { warn("[Choice] AddRecord NOT FOUND"); return false; }
        var ar = invokeOk(arMi, metaMap, [makeS(hd.id), meta]);
        if (!ar.ok) { warn("[Choice] AddRecord FAIL '" + hd.id + "'"); return false; }
        var hasMi = A.cgm(A.ogc(metaMap), Memory.allocUtf8String("ContainsId"), 1);
        var hv = hasMi && !hasMi.isNull() ? invokeOk(hasMi, metaMap, [makeS(hd.id)]) : { ok: false };
        if (!chBool(hv)) { warn("[Choice] AddRecord 后 ContainsId('" + hd.id + "') = false — 未生效"); return false; }
        chData.registeredIds[hd.id] = true;
        info("[Choice] R4: AddRecord('" + hd.id + "') + ContainsId ✓");
        return true;
    } catch (e) { warn("[Choice] chRegisterMeta err: " + e); return false; }
}
// providersMap.Add + GetProvider 验证 (探针实证 GetProvider 返回我们的 vrp)
function chRegisterProvider() {
    try {
        var rpm = findSvc("ResourceProviderManager");
        if (!rpm) { warn("[Choice] ResourceProviderManager NOT FOUND"); return false; }
        var pm = rpm.add(fieldOffset(A.ogc(rpm), "providersMap", 0x20)).readPointer();
        if (!pm || pm.isNull()) { warn("[Choice] providersMap NULL"); return false; }
        var addMi = A.cgm(A.ogc(pm), Memory.allocUtf8String("Add"), 2);
        if (addMi && !addMi.isNull()) {
            var ar = invokeOk(addMi, pm, [makeS(chData.providerKey), chData.vrp]);
            if (ar.ok) info("[Choice] providersMap.Add('" + chData.providerKey + "', vrp) OK");
            else { warn("[Choice] providersMap.Add FAIL (invoke 异常)"); return false; }
        }
        // GetProvider 在 ResourceProviderManager 上 (不在 providersMap 字典上)
        try {
            var gpMi = A.cgm(A.ogc(rpm), Memory.allocUtf8String("GetProvider"), 1);
            if (gpMi && !gpMi.isNull()) {
                var gpr = invokeOk(gpMi, rpm, [makeS(chData.providerKey)]);
                var gret = gpr.ok ? gpr.ret : ptr(0);
                if (gret && !gret.isNull() && gret.equals(chData.vrp)) info("[Choice] GetProvider('" + chData.providerKey + "') ✓ 就是我们的 vrp");
                else { warn("[Choice] GetProvider 返回 " + (gret && !gret.isNull() ? cn(gret) : "null") + " ≠ vrp — providersMap 未生效"); return false; }
            } else warn("[Choice] rpm.GetProvider NOT FOUND");
        } catch (e) { warn("[Choice] GetProvider 验证 err: " + e); return false; }
        return true;
    } catch (e) { warn("[Choice] chRegisterProvider err: " + e); return false; }
}

// ============ 主注册 ============
function tryFinalizeChoiceHandlers() {
    try {
        if (!chCls || !chCls.trialPanel || chCls.trialPanel.isNull() || !chCls.vrp || chCls.vrp.isNull()) return;
        if (chData.registered || chData.finalizing) return;
        if (!chData.handlers.length) return;
        chData.finalizing = true;
        try {
            // 1. mgr + metaMap
            var mgr = findSvc("ChoiceHandlerManager");
            if (!mgr) mgr = findSvc("WitchTrialsChoiceHandlerManager");
            if (!mgr) { dbg("[Choice] mgr 未就绪, 稍后重试"); return; }
            var cfg = null, metaMap = null;
            for (var ci = 0x10; ci <= 0x80 && !cfg; ci += 8) {
                try {
                    var cand = mgr.add(ci).readPointer();
                    if (cand.isNull()) continue;
                    var gmm = A.cgm(A.ogc(cand), Memory.allocUtf8String("get_MetadataMap"), 0);
                    if (!gmm || gmm.isNull()) gmm = A.cgm(A.ogc(cand), Memory.allocUtf8String("get_ActorMetadataMap"), 0);
                    if (gmm && !gmm.isNull()) {
                        var mm = invokeOk(gmm, cand, []);
                        if (mm.ok && mm.ret && !mm.ret.isNull()) { cfg = cand; metaMap = mm.ret; break; }
                    }
                } catch (e) {}
            }
            if (!cfg || !metaMap || metaMap.isNull()) { dbg("[Choice] Configuration NOT FOUND, 稍后重试"); return; }
            chData.metaMap = metaMap;
            // 2. 源面板
            var srcEma = null, srcHiro = null;
            var panels = findAllObjectOfType(chCls.trialPanel);
            for (var p = 0; p < panels.length; p++) {
                var nm = chObjName(panels[p]);
                if (!nm) continue;
                if (nm.indexOf("@Ema") >= 0 && !srcEma) srcEma = panels[p];
                else if (nm.indexOf("@Hiro") >= 0 && !srcHiro) srcHiro = panels[p];
            }
            if (!srcEma && !srcHiro) { dbg("[Choice] 源面板未出现 (TrialChoiceHandlerPanel=" + panels.length + "), 稍后重试"); return; }
            info("[Choice] 源面板: Ema=" + (srcEma ? chObjName(srcEma) : "无") + " Hiro=" + (srcHiro ? chObjName(srcHiro) : "无"));
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
            if (!chEnsureVrp()) return;
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
                        if (!src || src.isNull()) { warn("[Choice] 源面板缺失 (base=" + hd.basePanel + "), 跳过 '" + hd.id + "'"); allOk = false; continue; }
                        var clone = (instMi && !instMi.isNull()) ? invoke(instMi, ptr(0), [src]) : ptr(0);
                        if (!clone || clone.isNull()) { warn("[Choice] Instantiate 失败 '" + hd.id + "'"); allOk = false; continue; }
                        if (setNmMi && !setNmMi.isNull()) invoke(setNmMi, clone, [makeS("TrialChoicePanel@Mod_" + hd.id)]);
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
                        if (ddlMi && !ddlMi.isNull()) invoke(ddlMi, ptr(0), [clone]);
                        if (hd.sprite && !hd.sprite.isNull()) chSwapPortrait(clone, hd.sprite);
                        chData.cloned[hd.id] = clone;
                    }
                    // R2+R3: Resource ctor + Resources.Add + ContainsKey 自验证
                    // 2026-08-11 根因2: Resource.path 必须 = prefix 版 (C# 蓝本 AddResource("ModChoiceHandlers/{Id}"))
                    // → LoadedResource.ctor 的 BuildLocalPath(prefix, resource.Path) 需要 fullPath 含 prefix!
                    var res = chMakeResourceGO(pathPrefix, chData.cloned[hd.id]);
                    if (!res) { allOk = false; continue; }
                    var servedBare = chServeResource(path, res);
                    var servedPref = chServeResource(pathPrefix, res);   // 双 key (prefix 版镜像 C# 蓝本)
                    if (!servedBare && !servedPref) { allOk = false; continue; }
                    // R4: AddRecord + ContainsId
                    if (!chRegisterMeta(hd)) { allOk = false; continue; }
                } catch (e) { warn("[Choice] handler '" + hd.id + "' 注册 err: " + e); allOk = false; }
            }
            // 6. providersMap.Add + GetProvider 验证
            if (allOk) {
                if (!chRegisterProvider()) allOk = false;
            }
            if (allOk) {
                chData.registered = true;
                info("[Choice] ===== 注册完成: " + chData.handlers.length + " 个 handler, vrp=" + chData.vrp + " =====");
                chDumpMethods(chCls.vrp, "VRP");
                if (chData.rlKlass && !chData.rlKlass.isNull()) chDumpMethods(chData.rlKlass, "RL");
                chHookDictTryGetValue();
                var rpB2 = findClassAcrossImages("Naninovel", "ResourceProvider");
                if (rpB2 && !rpB2.isNull()) chDumpMethods(rpB2, "base");
                // UIChoiceHandler 方法表 hook (run14: RL-P.Load 内部调用全盲区 → 从调用者侧观察)
                var uic = findClassAcrossImages("Naninovel", "UIChoiceHandler");
                if (uic && !uic.isNull()) { chHookClassMethods(uic, "UIC"); chDumpMethods(uic, "UIC"); }
            } else {
                dbg("[Choice] finalize 部分失败, 待重试");
            }
        } finally { chData.finalizing = false; }
    } catch (e) { warn("[Choice] tryFinalizeChoiceHandlers err: " + e); chData.finalizing = false; }
}

// ============ Dictionary`2.TryGetValue 过滤 hook (run13: 游戏拿到 vrp 后零 provider 调用即抛错;
// 特化体 vs 共享体未定 — TryGetValue 无论走哪条都在我们 Add 过的 dict 上 → 过滤自证) ============
function chHookDictTryGetValue() {
    try {
        if (!chData.vrpDict || chData.vrpDict.isNull()) return;
        var dictCls = A.ogc(chData.vrpDict);
        if (!dictCls || dictCls.isNull()) return;
        var iter = Memory.alloc(Process.pointerSize);
        iter.writePointer(ptr(0));
        var mi = A.cgmAll(dictCls, iter);
        var n = 0;
        while (mi && !mi.isNull() && n < 100) {
            n++;
            var nm = "";
            try {
                var np = A.mgn(mi);
                if (np && !np.isNull()) nm = np.readCString();
            } catch (e) {}
            var mp = mi.readPointer();
            if ((nm === "TryGetValue" || nm === "ContainsKey" || nm === "get_Item") && mp && !mp.isNull()) {
                var mnm2 = nm;
                Interceptor.attach(mp, {
                    onEnter: function (a) {
                        try {
                            var self = a[0];
                            var key = "";
                            try { key = readStr(a[1]); } catch (e) {}
                            // run16: 全不过滤 — 验证特化体理论: 游戏加载 MyMod 时查了哪些 dict/key
                            // (风暴抑制: 只在 key 与 MyMod/ModChoice 相关时打印; 否则打 1 字符标记)
                            if (key.indexOf("MyMod") >= 0 || key.indexOf("ModChoice") >= 0 ||
                                (chData.vrpDict && self.equals(chData.vrpDict))) {
                                var selfCls = "";
                                try { selfCls = A.cgn(A.ogc(self)).readCString(); } catch (e) {}
                                info("[Choice] " + mnm2 + " self=" + self + " (" + selfCls + ") key='" + key + "'" +
                                    (chData.vrpDict && self.equals(chData.vrpDict) ? " ←我们的 dict" : ""));
                            }
                        } catch (e) {}
                    }
                });
                dbg("[Choice] Dict.TryGetValue hooked (过滤我们的 vrp dict) @" + mp);
                return;
            }
            mi = A.cgmAll(dictCls, iter);
        }
    } catch (e) { dbg("[Choice] chHookDictTryGetValue err: " + e); }
}

// ============ 方法表 hook (run11: 泛型共享体指针在方法表里; get_method_from_name 指针不在调用路径) ============
// 方法表里多个泛型方法共享同一代码体指针 → 去重 attach, 一次命中全捕获。
// 通用: 对任意类 attach 名字匹配的加载方法 (共享体 = 游戏真实调用路径)。
function chHookClassMethods(cls, tag, all) {
    var hooked = 0;
    try {
        if (!A.cgmAll || !A.mgn) { dbg("[Choice] cgmAll/mgn 不可用 (" + tag + ")"); return hooked; }
        var iter = Memory.alloc(Process.pointerSize);
        iter.writePointer(ptr(0));
        var seen = {};
        var mi = A.cgmAll(cls, iter);
        var n = 0;
        while (mi && !mi.isNull() && n < 300) {
            n++;
            var mp = mi.readPointer();
            var nm = "";
            try {
                var np = A.mgn(mi);
                if (np && !np.isNull()) nm = np.readCString();
            } catch (e) {}
            if (mp && !mp.isNull() && !seen[mp.toString()] &&
                (all || /^(Load|Locate|ResourceExists|SupportsType|GetLoaded|AddResource|SetResource|RemoveResource|Run|Create|Handle|Cancel|IsLocationCached|LocateCached)/.test(nm))) {
                seen[mp.toString()] = true;
                (function (addr, mnm) {
                    Interceptor.attach(addr, {
                        onEnter: function (a) {
                            try {
                                var self = a[0];
                                var tag2 = (chData.vrp && self && self.equals(chData.vrp)) ? " [我们的 vrp]" : "";
                                var path = "";
                                try { path = readStr(a[1]); } catch (e) {}
                                dbg("[Choice] " + tag + "." + mnm + "('" + path + "')" + tag2);
                                // RL-P.Load 只读诊断 (2026-08-11 源码对照): 游戏实际 ProvisionSources 内容
                                if (mnm === "Load" && tag === "RL-P") {
                                    try {
                                        var ps = chReadProvisionSources(self);
                                        dbg("[Choice] RL-P.Load ProvisionSources(" + ps.cnt + "): " + ps.desc + (ps.hasVrp ? " ✓ 含我们的 vrp" : " ✗ 无 vrp — 游戏从不调我们的 provider"));
                                    } catch (e3) { dbg("[Choice] ProvisionSources 诊断 err: " + e3); }
                                }
                                // RL-P.Load 的加载入口 backtrace (run14: 游戏拿到 vrp 后内部调用全盲区)
                                if (mnm === "Load" && tag === "RL-P" && path.indexOf("MyMod") >= 0) {
                                    try {
                                        var bt = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 12);
                                        var ga2 = null;
                                        try { ga2 = Process.getModuleByName("GameAssembly_arm64.dylib"); } catch (e) {}
                                        var b2 = ga2 ? ga2.base : ptr(0);
                                        var names = bt.map(function (ad) {
                                            try {
                                                if (b2 && ad.compare(b2) >= 0 && ad.compare(b2.add(0x7000000)) < 0) return "0x" + ad.sub(b2).toString(16);
                                                var s = DebugSymbol.fromAddress(ad);
                                                return s && s.name ? s.name : ad.toString();
                                            } catch (e) { return ad.toString(); }
                                        });
                                        dbg("[Choice] RL-P.Load backtrace: " + names.join(" <- "));
                                    } catch (e2) {}
                                }
                            } catch (e) {}
                        }
                    });
                })(mp, nm);
                hooked++;
                dbg("[Choice] " + tag + "-table hook: " + nm + "@" + mp);
            }
            mi = A.cgmAll(cls, iter);
        }
    } catch (e) { dbg("[Choice] chHookClassMethods(" + tag + ") err: " + e); }
    return hooked;
}
function chHookVrpMethods() { chHookClassMethods(chCls.vrp, "VRP", false); }   // run26 教训: all=true 风暴 (高频方法) — 只 hook 名称匹配的低频加载方法

// ============ stub 解析 + 真体 BL hook (run18: methodPointer = LDR X16/BR X16 stub, 真体=动态生成代码) ============
var chExecRanges = null;
function chIsExec(addr) {
    try {
        if (!chExecRanges) chExecRanges = Process.enumerateRanges('r-x');
        for (var i = 0; i < chExecRanges.length; i++) {
            if (addr.compare(chExecRanges[i].base) >= 0 && addr.compare(chExecRanges[i].base.add(chExecRanges[i].size)) < 0) return true;
        }
    } catch (e) {}
    return false;
}
function chStubResolve(addr) {
    try {
        var w0 = addr.readU32();
        if ((w0 & 0xFF000000) === 0x58000000) {
            // LDR Xt literal: label = PC + signext(imm19)*4; run20 实证 imm19=2 → 地址池在 stub+16
            var imm19 = (w0 >> 5) & 0x7FFFF;
            if (imm19 & 0x40000) imm19 -= 0x80000;
            // label = PC + imm19*4 (PC = LDR 指令地址 addr 本身)
            var lab = addr.add(imm19 * 4);
            var target = lab.readPointer();
            // 动态代码区可能不被 enumerateRanges 覆盖 → 不做可执行校验, 直接信任地址池
            return target;
        }
    } catch (e) {}
    return null;
}
// stub 链解析: 外层 LDR/BR stub → 内层 stub (LDR+解引用+BR)。
// run24 教训: 在 stub2 的 BR 指令上 attach = frida 跳板改写尾调用指令, 与 IL2CPP 懒解析
// 竞态 → 游戏崩 (SIGSEGV @stub2+0x10, ips 20:45:52)。改为纯只读: 从 stub2+0x28 读 slot
// (run24 实证 slot = 最终真体地址, 如 0x104858000), 不做任何 attach。
function chHookStubBody(stub, tag) {
    try {
        var body = chStubResolve(stub);
        if (!body || body.isNull()) { dbg("[Choice] " + tag + " 不是 stub 或解析失败 @" + stub); return; }
        dbg("[Choice] " + tag + " stub@" + stub + " → stub2@" + body);
        var hexs2 = [];
        try { for (var hh2 = 0; hh2 < 48; hh2++) hexs2.push(body.add(hh2).readU8().toString(16).padStart(2, "0")); } catch (e) {}
        dbg("[Choice] " + tag + " stub2 开头96B: " + hexs2.join(" "));
        // 只读: slotB @stub2+0x28 (run24 实证 = 最终真体)
        var slot = body.add(0x28).readPointer();
        if (!slot || slot.isNull()) { dbg("[Choice] " + tag + " slot@0x28 为空 (懒解析未完成)"); return; }
        dbg("[Choice] " + tag + " 最终真体(只读 slot)@" + slot);
        var hexs = [];
        try { for (var hh = 0; hh < 16; hh++) hexs.push(slot.add(hh).readU8().toString(16).padStart(2, "0")); } catch (e) {}
        dbg("[Choice] " + tag + " 最终真体开头32B: " + hexs.join(" "));
        // 只读 dump BL 目标 (不 attach — run24 实证真体 0 BL 目标, 泛型调用全间接)
        var tgts = chDumpBlTargets(slot, 0x800, tag);
        if (tgts.length) dbg("[Choice] " + tag + " BL 目标 (" + tgts.length + "): " + tgts.join(", "));
    } catch (e) { dbg("[Choice] chHookStubBody(" + tag + ") err: " + e); }
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
                if (imm & 0x02000000) imm -= 0x04000000;
                var tgt = addr.add(i + imm * 4);
                var ga3 = null;
                try { ga3 = Process.getModuleByName("GameAssembly_arm64.dylib"); } catch (e) {}
                var b3 = ga3 ? ga3.base : ptr(0);
                var off = "";
                if (b3 && tgt.compare(b3) >= 0 && tgt.compare(b3.add(0x7000000)) < 0) off = "GA+" + tgt.sub(b3).toString(16);
                out.push(tgt.toString() + (off ? "(" + off + ")" : ""));
            }
        }
    } catch (e) { dbg("[Choice] chDumpBlTargets err: " + e); }
    return out;
}
function chHookBlTargets(addr, len, tag) {
    try {
        var tgts = chDumpBlTargets(addr, len);
        var uniq = {};
        var ga4 = null;
        try { ga4 = Process.getModuleByName("GameAssembly_arm64.dylib"); } catch (e) {}
        var b4 = ga4 ? ga4.base : ptr(0);
        var count = 0;
        tgts.forEach(function (t) {
            if (!t || uniq[t]) return;
            uniq[t] = true;
            count++;
            var off = "";
            try { if (b4 && ptr(t).compare(b4) >= 0 && ptr(t).compare(b4.add(0x7000000)) < 0) off = " GA+" + ptr(t).sub(b4).toString(16); } catch (e) {}
            Interceptor.attach(ptr(t), {
                onEnter: function () {
                    try { dbg("[Choice] BL:" + tag + " 目标 @" + ptr(t) + off); } catch (e) {}
                }
            });
        });
        dbg("[Choice] BL:" + tag + " 共 " + count + " 个目标: " + tgts.join(", "));
    } catch (e) { dbg("[Choice] chHookBlTargets err: " + e); }
}

// ============ 方法表 dump (诊断: 泛型方法 get_method_from_name 找不到, 遍历看真实形态) ============
// 名字/参数数/泛型标志用官方 API 读 (MethodInfo 布局不可靠, 不猜偏移)
function chDumpMethods(cls, tag) {
    try {
        if (!A.cgmAll || !A.mgn) { dbg("[Choice] cgmAll/mgn 不可用"); return; }
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
                if (np && !np.isNull()) nm = np.readCString();
            } catch (e) {}
            var pc = -1, isG = false, isI = false;
            try { pc = A.mpc ? A.mpc(mi) : -1; } catch (e) {}
            try { isG = A.mig ? !!A.mig(mi) : false; } catch (e) {}
            try { isI = A.mii ? !!A.mii(mi) : false; } catch (e) {}
            rows.push(nm + "/" + pc + (isG ? "G" : "-") + (isI ? "I" : "-") + "@" + mp);
            mi = A.cgmAll(cls, iter);
        }
        dbg("[Choice] " + tag + " 方法表 (" + n + "): " + rows.join(" | "));
    } catch (e) { dbg("[Choice] chDumpMethods err: " + e); }
}

// ============ RL 泛型类 hook (rlKlass 捕获后装; 幂等) ============
// ResourceLoader`1<GameObject> (inflated) — 按钮加载已跑过 → 特化体已生成;
// hook 这里 = 抓所有该泛参的加载调用 (含 handler UI prefab 加载)
function chHookRl() {
    try {
        if (chData.rlHooked) return;
        var rlk = chData.rlKlass;
        if (!rlk || rlk.isNull()) return;
        chData.rlHooked = true;
        dbg("[Choice] rlKlass=" + A.cgn(rlk).readCString());
        // run12: 加载方法在父类 (ResourceLoader`1<GameObject>) 方法表 — 遍历 hook + dump
        chHookClassMethods(rlk, "RL");
        chDumpMethods(rlk, "RL");
        if (A.cgp) {
            var par = A.cgp(rlk);
            if (par && !par.isNull()) {
                var pn = "";
                try { pn = A.cgn(par).readCString(); } catch (e) {}
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
                            if (np2 && !np2.isNull()) nm2 = np2.readCString();
                        } catch (e) {}
                        if (nm2 === "Load" || nm2 === "LoadAll") {
                            var mp2 = mi2.readPointer();
                            if (mp2 && !mp2.isNull()) {
                                dbg("[Choice] RL-P." + nm2 + " 代码段 @" + mp2 + " — BL 目标 hook");
                                var hexs = [];
                                try { for (var hh = 0; hh < 32; hh++) hexs.push(mp2.add(hh).readU8().toString(16).padStart(2, "0")); } catch (e) {}
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
                                            if (!chData.vrpDict || chData.vrpDict.isNull()) return;
                                            var path = readStr(a[1]) || "";
                                            if (path.indexOf("MyMod") < 0) return;
                                            var full = chData.providerKey + "/" + path;
                                            var ckMi = A.cgm(A.ogc(chData.vrpDict), Memory.allocUtf8String("ContainsKey"), 1);
                                            var ckr = ckMi && !ckMi.isNull() ? invokeOk(ckMi, chData.vrpDict, [makeS(full)]) : { ok: false };
                                            var ck = ckr.ok ? chBool(ckr) : "?";
                                            info("[Choice] 自验证 vrp.Resources.ContainsKey('" + full + "') = " + ck + " (游戏 Load 即将查询的 fullPath)");
                                            this._pre = chDictPhysCount(chData.vrpDict);
                                            var ks = chDictPhysKeys(chData.vrpDict);
                                            dbg("[Choice] vrp.Resources 物理 count=" + this._pre + " keys(" + ks.length + "): " + ks.slice(0, 8).join(", ") + (ks.length > 8 ? " ..." : ""));
                                            if (ck !== true && this._pre > 0) {
                                                // dict 有内容但 ContainsKey=false → key 内容不匹配 (prefix 拼错?)
                                                var miss = chData.providerKey + "/" + path;
                                                for (var i2 = 0; i2 < ks.length; i2++) {
                                                    if (ks[i2] === path || ks[i2] === miss) dbg("[Choice]   找到候选 key '" + ks[i2] + "' (内容匹配)");
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
                                                        try { goCls = findClassAcrossImages("UnityEngine", "GameObject"); } catch (e2) {}
                                                        var goName = goCls && !goCls.isNull() ? A.cgn(goCls).readCString() : "?";
                                                        dbg("[Choice] Resource.Object klass=" + objName + " vs GameObject klass=" + goName + (objCls.equals(goCls) ? " — 匹配 ✓" : " — 不匹配!!"));
                                                    }
                                                }
                                            } catch (e2) { dbg("[Choice] Object klass 检查 err: " + e2); }
                                            // 泛型定义 invoke 实验: IL2CPP 无 JIT, VRP.ResourceExists<T> 的 <GameObject> 特化
                                            // 未生成 (方法表 mp=0x0) → 游戏调用失败. 试 invoke 泛型定义, 观察结果/异常.
                                            try {
                                                var reB = A.cgm(chCls.vrp, Memory.allocUtf8String("ResourceExistsBlocking"), 1);
                                                var reR = A.cgm(chCls.vrp, Memory.allocUtf8String("ResourceExists"), 1);
                                                if (reB && !reB.isNull()) {
                                                    var rB = invokeOk(reB, chData.vrp, [makeS(full)]);
                                                    dbg("[Choice] invoke ResourceExistsBlocking(泛型定义): ok=" + rB.ok + (rB.ok ? " ret=" + chBool(rB) : " ex=" + rB.ex));
                                                } else dbg("[Choice] ResourceExistsBlocking 方法未找到!");
                                                if (reR && !reR.isNull()) {
                                                    var rR = invokeOk(reR, chData.vrp, [makeS(full)]);
                                                    dbg("[Choice] invoke ResourceExists(泛型定义): ok=" + rR.ok + (rR.ok ? " ret=" + chBool(rR) : " ex=" + rR.ex));
                                                } else dbg("[Choice] ResourceExists 方法未找到!");
                                            } catch (e2) { dbg("[Choice] 泛型 invoke 实验 err: " + e2); }
                                        } catch (e) { dbg("[Choice] RL-P.Load 诊断 onEnter err: " + e); }
                                    },
                                    onLeave: function () {
                                        try {
                                            if (!chData.vrpDict || chData.vrpDict.isNull()) return;
                                            var post = chDictPhysCount(chData.vrpDict);
                                            dbg("[Choice] RL-P.Load 后 vrp.Resources count=" + post + " (onEnter 时 " + this._pre + ")" + (this._pre > 0 && post < this._pre ? " — 被清空了!" : ""));
                                            // VRP 方法表 ResourceExists 的 mp 是否被解析 (特化体发现)
                                            if (A.cgmAll && chCls.vrp) {
                                                var iter3 = Memory.alloc(Process.pointerSize);
                                                iter3.writePointer(ptr(0));
                                                var mi3 = A.cgmAll(chCls.vrp, iter3);
                                                var nn3 = 0;
                                                while (mi3 && !mi3.isNull() && nn3 < 40) {
                                                    nn3++;
                                                    var nm3 = "";
                                                    try { var np3 = A.mgn(mi3); if (np3 && !np3.isNull()) nm3 = np3.readCString(); } catch (e) {}
                                                    if (nm3.indexOf("ResourceExists") >= 0 || nm3 === "LoadResource") {
                                                        dbg("[Choice] VRP." + nm3 + " mp=0x" + mi3.readPointer().toString(16));
                                                    }
                                                    mi3 = A.cgmAll(chCls.vrp, iter3);
                                                }
                                            }
                                        } catch (e) { dbg("[Choice] RL-P.Load 诊断 onLeave err: " + e); }
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
    } catch (e3) { dbg("[Choice] chHookRl err: " + e3); }
}

// ============ 只读诊断: vrp.Resources 物理扫描 + RL-P.Load 前后对比 (2026-08-11 清空假设) ============
// 镜像 ResourceProviderManager.DestroyService: foreach (providersMap.Values) provider?.UnloadResources()
// → 我们注册进 providersMap 的 vrp 在场景重建时可能被游戏 RemoveAllResources() 清空!
// 验证: RL-P.Load onEnter 复刻游戏查询 (ContainsKey) + onLeave 对比 dict count。
function chDictPhysKeys(dict) {
    var out = [];
    try {
        var cnt = dict.add(0x20).readS32();
        if (cnt <= 0) return out;
        var ents = dict.add(0x18).readPointer();
        if (!ents || ents.isNull()) return out;
        var al = ents.add(0x18).readS32();
        for (var e = 0; e < al; e++) {
            var eb = ents.add(0x20 + e * 24);
            if (eb.readS32() === -1) continue;
            var kp = eb.add(8).readPointer();
            if (!kp || kp.isNull()) continue;
            var ks = readStr(kp);
            if (ks) out.push(ks);
        }
    } catch (e) {}
    return out;
}
function chDictPhysCount(dict) {
    try { return dict.add(0x20).readS32(); } catch (e) { return -1; }
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
        if (sz < 0 || sz > 64) { out.desc = "(List size=" + sz + " @off=" + off + " 可疑, 偏移可能不对)"; return out; }
        out.cnt = sz;
        var items = list.add(0x10).readPointer();
        var parts = [];
        for (var i = 0; i < sz; i++) {
            var ps = items.add(0x20 + i * 16);
            var prov = ps.readPointer();
            var pfx = readStr(ps.add(8).readPointer());
            var pn = (prov && !prov.isNull()) ? A.cgn(A.ogc(prov)).readCString() : "null";
            var ours = chData.vrp && prov && !prov.isNull() && prov.equals(chData.vrp);
            if (ours) out.hasVrp = true;
            parts.push(pn + (pfx ? "('" + pfx + "')" : "()") + (ours ? " ★=vrp" : ""));
        }
        out.desc = parts.join(", ");
    } catch (e) { out.desc = "(err " + e + ")"; }
    return out;
}

// ============ 保活 (providersMap 可能被场景重建; GC 未禁时 vrp 靠 providersMap 持有) ============
function chDictPhysHasKey(dict, keyStr) {
    try {
        var cnt = dict.add(0x20).readS32();
        if (cnt <= 0) return false;
        var buckets = dict.add(0x10).readPointer();
        var ents = dict.add(0x18).readPointer();
        if (!buckets || buckets.isNull() || !ents || ents.isNull()) return false;
        var al = ents.add(0x18).readS32();
        for (var e = 0; e < al; e++) {
            var eb = ents.add(0x20 + e * 24);
            if (eb.readS32() === -1) continue;
            var kp = eb.add(8).readPointer();
            if (!kp || kp.isNull()) continue;
            if (readStr(kp) === keyStr) return true;
        }
    } catch (e) {}
    return false;
}
function chKeepAlive() {
    try {
        if (!chData.vrp || chData.vrp.isNull()) return;
        var rpm = findSvc("ResourceProviderManager");
        if (!rpm) return;
        var pm = rpm.add(fieldOffset(A.ogc(rpm), "providersMap", 0x20)).readPointer();
        if (!pm || pm.isNull()) return;
        if (!chDictPhysHasKey(pm, chData.providerKey)) {
            var addMi = A.cgm(A.ogc(pm), Memory.allocUtf8String("Add"), 2);
            if (addMi && !addMi.isNull()) {
                var ar = invokeOk(addMi, pm, [makeS(chData.providerKey), chData.vrp]);
                info("[Choice] 保活: providersMap 丢失 '" + chData.providerKey + "', 重新 Add " + (ar.ok ? "OK" : "FAIL(可能已存在/异常)"));
            }
        }
    } catch (e) { dbg("[Choice] chKeepAlive err: " + e); }
}

// ============ 只读诊断钩子 (确认游戏走 provider 链到哪一步; 不覆盖任何行为) ============
var chDiagHooked = false;
function installDiagHooks() {
    try {
        if (chDiagHooked) return;
        chDiagHooked = true;
        // UIChoiceHandler.Initialize → 游戏对 handler 构造尝试的入口
        if (chCls.uih && !chCls.uih.isNull()) {
            var iniMi = A.cgm(chCls.uih, Memory.allocUtf8String("Initialize"), 1);
            if (!iniMi || iniMi.isNull()) iniMi = A.cgm(chCls.uih, Memory.allocUtf8String("InitializeAsync"), 1);
            if (iniMi && !iniMi.isNull()) {
                Interceptor.attach(iniMi.readPointer(), {
                    onEnter: function (a) {
                        try {
                            var self = a[0];
                            var id = "";
                            try { var idMi = A.cgm(A.ogc(self), Memory.allocUtf8String("get_Id"), 0); if (idMi && !idMi.isNull()) id = readStr(invoke(idMi, self, [])); } catch (e) {}
                            if (id && id.indexOf("Trial") !== 0) info("[Choice] 游戏构造 UIChoiceHandler '" + id + "' (Initialize)");
                        } catch (e) {}
                    }
                });
                dbg("[Choice] UIChoiceHandler.Initialize hooked (诊断)");
            }
        }
        // GetOrAddActor 对我们 id 的调用 (mgr 可能尚未出现 — 单独重试, 不阻塞后续 hook)
        (function hookGOA() {
            try {
                var mgr = findSvc("ChoiceHandlerManager");
                if (!mgr) mgr = findSvc("WitchTrialsChoiceHandlerManager");
                if (!mgr) { setTimeout(hookGOA, 1000); return; }
                var goaMi = A.cgm(A.ogc(mgr), Memory.allocUtf8String("GetOrAddActor"), 1);
                if (goaMi && !goaMi.isNull()) {
                    Interceptor.attach(goaMi.readPointer(), {
                        onEnter: function (a) {
                            try {
                                var id = readStr(a[1]);
                                if (id && id.indexOf("Trial") !== 0) info("[Choice] 游戏 GetOrAddActor('" + id + "')");
                            } catch (e) {}
                        }
                    });
                    dbg("[Choice] GetOrAddActor hooked (诊断)");
                }
            } catch (e) {}
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
                                    try { ga = Process.getModuleByName("GameAssembly_arm64.dylib"); } catch (e) {}
                                    var base = ga ? ga.base : ptr(0);
                                    var names = bt.map(function (ad) {
                                        try {
                                            if (base && ad.compare(base) >= 0 && ad.compare(base.add(0x7000000)) < 0) return "0x" + ad.sub(base).toString(16);
                                            var s = DebugSymbol.fromAddress(ad);
                                            return s && s.name ? s.name : ad.toString();
                                        } catch (e) { return ad.toString(); }
                                    });
                                    dbg("[Choice] GetProvider backtrace: " + names.join(" <- "));
                                } catch (e2) { dbg("[Choice] backtrace err: " + e2); }
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
                                    dbg("[Choice] 游戏 GetProvider('" + k + "') → " + rc + (ours ? " ✓ 我们的 vrp" : " ✗ 不是/丢失"));
                            } catch (e) {}
                        }
                    });
                    dbg("[Choice] rpm.GetProvider hooked (诊断)");
                }
            }
        } catch (e) {}
        // VRP 全部加载入口 — 方法表遍历 attach 真实指针 (run11: get_method_from_name 对泛型方法
        // 返回的指针 ≠ 游戏 vtable 调用路径; 泛型方法共享体指针在方法表里, 直接 attach)
        // run25: 全量 attach 不按名字过滤 (旧 forEach 段已删, 避免重复 attach 同一指针)
        try {
            if (chCls.vrp && !chCls.vrp.isNull()) {
                chHookVrpMethods();
            }
        } catch (e) {}
        // ResourceProvider 基类泛型方法 (run12: get_method_from_name 对泛型返回的指针不在调用路径
        // → 方法表遍历 attach 共享体; 游戏加载若走基类方法此处命中)
        try {
            var rpBase = findClassAcrossImages("Naninovel", "ResourceProvider");
            if (!rpBase || rpBase.isNull()) { dbg("[Choice] ResourceProvider 基类未找到 (rpBase=null)"); }
            else chHookClassMethods(rpBase, "base", false);   // run26 教训: all=true 风暴 — 只 hook 名称匹配的低频方法
        } catch (e) {}
    } catch (e) { warn("[Choice] installDiagHooks err: " + e); }
}

// ============ 装配 ============
export function setupChoiceHandlerHooks() {
    try {
        chCls = resolveChoiceHandlerClasses();
        if (chCls.customUI.isNull() || chCls.trialPanel.isNull()) { warn("[Choice] 类解析失败 (CustomUI/TrialChoiceHandlerPanel)"); return; }
        // hook CustomUI.Awake → TrialChoiceHandlerPanel Awake → finalize
        var awMi = A.cgm(chCls.customUI, Memory.allocUtf8String("Awake"), 0);
        if (awMi && !awMi.isNull()) {
            Interceptor.attach(awMi.readPointer(), {
                onEnter: function (a) { this._self = a[0]; },
                onLeave: function () {
                    try {
                        if (!this._self || this._self.isNull()) return;
                        var cn = A.cgn(A.ogc(this._self)).readCString();
                        if (cn === "TrialChoiceHandlerPanel") tryFinalizeChoiceHandlers();
                    } catch (e) {}
                }
            });
            info("[Choice] CustomUI.Awake hooked");
        }
        installDiagHooks();
        info("[Choice] hooks 就绪");
    } catch (e) { warn("[Choice] setupChoiceHandlerHooks err: " + e); }
}

// Title 时: 读数据 → 预载立绘 → 触发源面板 (镜像 Windows LoadModData + TryTriggerSourcePanelLoad)
export function initChoiceHandlers() {
    try {
        loadChoiceHandlerData();
        registerChoiceHandlers();
        if (!chData.handlers.length) return;
        setTimeout(function () {
            chTriggerGOClass();
            tryFinalizeChoiceHandlers();
        }, 150);
        // 兜底轮询: finalize 需要源面板 + Resource<GameObject> 类齐 (探针实证双触发后 ~秒级出现)
        if (chPollTimer) return;
        var tries = 0;
        chPollTimer = setInterval(function () {
            tries++;
            try {
                if (chData.registered) {
                    // 注册后转保活模式: 每 5 秒检查 providersMap 物理存在 (场景切换可能重建)
                    if (tries % 10 === 0) chKeepAlive();
                    if (tries > 7200) { clearInterval(chPollTimer); chPollTimer = null; }   // 1h 上限
                    return;
                }
                chTriggerGOClass();
                tryFinalizeChoiceHandlers();
                if (tries > 120) { clearInterval(chPollTimer); chPollTimer = null; warn("[Choice] 注册超时(60s), 停轮询"); }
            } catch (e) { dbg("[Choice] 轮询 err: " + e); }
        }, 500);
    } catch (e) { warn("[Choice] initChoiceHandlers err: " + e); }
}
