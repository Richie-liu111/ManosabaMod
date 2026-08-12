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

var cutInCls = null;    // 解析好的类表
var cutInData = {
    registry: {},       // id -> {modRoot, id, sprites:{vanillaName:{path}}}
    texCache: {},       // cacheKey -> {tex,w,h} (未加载 undefined)
    spriteCache: {},    // cacheKey -> Sprite (null = 失败防刷屏)
    pendingEntry: null, // SetVariableValue 命中 → SetSpawnParameters 消费
    instCache: {},      // instPtr -> {images,imageNames,renderers,rendererNames,vanillaSpr}
    ready: false
};
var cutInHooksReady = false;

function resolveCutInClasses() {
    var m = {};
    m.texture2d      = findClassAcrossImages("UnityEngine", "Texture2D");
    m.imageConversion = findClassAcrossImages("UnityEngine", "ImageConversion");
    m.image          = findClassAcrossImages("UnityEngine.UI", "Image");
    m.spriteRenderer = findClassAcrossImages("UnityEngine", "SpriteRenderer");
    m.material       = findClassAcrossImages("UnityEngine", "Material");
    m.sprite         = findClassAcrossImages("UnityEngine", "Sprite");
    m.gameObject     = findClassAcrossImages("UnityEngine", "GameObject");
    m.component      = findClassAcrossImages("UnityEngine", "Component");
    m.object         = findClassAcrossImages("UnityEngine", "Object");
    m.customVarMgr   = findClassAcrossImages("Naninovel", "CustomVariableManager");
    m.objectionCutIn = findClassAcrossImages("WitchTrials.Views", "ObjectionCutIn");
    return m;
}
// pngDims 已移到 utils.js (choice.js 共用)
// 读每个 mod info.json 的 CutIns[] (Id/BaseTemplate/Sprites{原版名->相对路径}, ModItem.ModObjectionCutIn)
function loadCutInData() {
    cutInData.registry = {}; cutInData.texCache = {}; cutInData.spriteCache = {};
    if (typeof MOD_ROOT === "undefined" || typeof modList === "undefined" || !modList || !modList.length) return;
    for (var i = 0; i < modList.length; i++) {
        var root = MOD_ROOT + "/" + modList[i].key;
        var inf = readJSONFile(root + "/info.json");   // 注意: 变量名不能叫 info (遮蔽 import 的 info 日志函数)
        if (!inf || !inf.CutIns) continue;
        for (var c = 0; c < inf.CutIns.length; c++) {
            var ci = inf.CutIns[c];
            if (!ci || !ci.Id || !ci.Sprites) continue;
            if (cutInData.registry[ci.Id]) { warn("[v3] CutIn id 冲突, 跳过 '" + ci.Id + "'"); continue; }
            var entry = { modRoot: root, id: ci.Id, sprites: {} };
            for (var k in ci.Sprites) {
                if (ci.Sprites[k]) entry.sprites[k] = { path: root + "/" + ci.Sprites[k] };
            }
            cutInData.registry[ci.Id] = entry;
            dbg("[v3] CutIn 注册 '" + ci.Id + "': " + Object.keys(entry.sprites).length + " 张 sprite");
        }
    }
    cutInData.ready = Object.keys(cutInData.registry).length > 0;
    if (cutInData.ready) info("[v3][CutIn] 共 " + Object.keys(cutInData.registry).length + " 个 mod CutIn");
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
    if (!cutInData.ready) return;
    var name = readStr(a[1]);
    if (name !== "objectionCutInSpawnPath") return;
    var valPtr = a[2];
    if (!valPtr || valPtr.isNull()) return;
    var type = valPtr.readS32();
    if (type !== 0) return;
    var str = readStr(valPtr.add(0x8).readPointer());
    if (!str) { cutInData.pendingEntry = null; return; }
    var kind = extractCutInKind(str);
    if (!kind) return;
    if (cutInData.registry[kind]) {
        cutInData.pendingEntry = cutInData.registry[kind];
        var newVal = str.replace(kind, "Hiro");   // 保留原始前缀结构, 只换 Kind → 原版 spawn 命中 Hiro prefab
        valPtr.add(0x8).writePointer(makeS(newVal));
        dbg("[v3] CutIn 改写 objectionCutInSpawnPath: '" + str + "' -> '" + newVal + "' (id=" + kind + ")");
    } else {
        cutInData.pendingEntry = null;   // 原生模板 (Hiro/Ema/CreatureHiro) 清残留
    }
}
// 读文件 bytes → Texture2D (镜像 loadModTexture, 独立 cache); 返回 {tex,w,h}
function loadCutInTexture(path, cacheKey) {
    if (cutInData.texCache[cacheKey]) return cutInData.texCache[cacheKey];
    try {
        var fb = fileReadBytes(path);
        if (!fb || fb.size <= 0) { warn("[v3] CutIn 读纹理失败 '" + path + "'"); return null; }
        var dims = pngDims(fb);
        if (!dims) { warn("[v3] CutIn PNG 尺寸读取失败 '" + path + "'"); return null; }
        var byteCls = getSystemClass("Byte");
        var barr = A.an(byteCls, fb.size);
        barr.add(0x20).writeByteArray(fb.buf.readByteArray(fb.size));
        var tex = A.on(cutInCls.texture2d);
        var wbuf = Memory.alloc(4); wbuf.writeS32(dims.w);
        var hbuf = Memory.alloc(4); hbuf.writeS32(dims.h);
        var ctorMi = A.cgm(cutInCls.texture2d, Memory.allocUtf8String(".ctor"), 2);
        if (ctorMi && !ctorMi.isNull()) invokeOk(ctorMi, tex, [wbuf, hbuf]);
        var liMi = A.cgm(cutInCls.imageConversion, Memory.allocUtf8String("LoadImage"), 2);
        if (!liMi || liMi.isNull()) { warn("[v3] CutIn ImageConversion.LoadImage NOT FOUND"); return null; }
        var r = invokeOk(liMi, ptr(0), [tex, barr]);
        if (!r.ok) { warn("[v3] CutIn LoadImage 失败 '" + path + "'"); return null; }
        var ent = { tex: tex, w: dims.w, h: dims.h };
        cutInData.texCache[cacheKey] = ent;
        return ent;
    } catch (e) { warn("[v3] CutIn loadCutInTexture err '" + path + "': " + e); return null; }
}
// Sprite.Create(tex, Rect(0,0,w,h), Vector2(pivot), ppu, extrude) — 5 参重载 (4 参 macOS runtime_invoke 崩溃, 探针实测)
function makeModSprite(tex, texW, texH, pivotX, pivotY, ppu) {
    try {
        if (!tex || tex.isNull() || !texW || !texH) { warn("[v3] CutIn Sprite.Create 参数无效, 跳过"); return null; }
        var rect = Memory.alloc(16);
        rect.writeFloat(0); rect.add(4).writeFloat(0); rect.add(8).writeFloat(texW); rect.add(12).writeFloat(texH);
        var pivot = Memory.alloc(8);
        pivot.writeFloat(pivotX); pivot.add(4).writeFloat(pivotY);
        var ppuPtr = Memory.alloc(4); ppuPtr.writeFloat(ppu || 100);
        var createMi = A.cgm(cutInCls.sprite, Memory.allocUtf8String("Create"), 5);
        if (!createMi || createMi.isNull()) { warn("[v3] CutIn Sprite.Create NOT FOUND"); return null; }
        var extrude = Memory.alloc(4); extrude.writeU32(0);
        return invoke(createMi, ptr(0), [tex, rect, pivot, ppuPtr, extrude]);
    } catch (e) { warn("[v3] CutIn makeModSprite err: " + e); return null; }
}
function getObjName(objPtr) {
    try {
        if (!objPtr || objPtr.isNull()) return null;
        var nmMi = A.cgm(cutInCls.object, Memory.allocUtf8String("get_name"), 0);
        if (!nmMi || nmMi.isNull()) return null;
        var s = invoke(nmMi, objPtr, []);
        return readStr(s);
    } catch (e) { return null; }
}
// 收集实例子树的 Image/SpriteRenderer + 各组件当前 sprite 名 (非泛型 GetComponentsInChildren(Type,bool))
function ensureCutInCache(inst) {
    var key = ptr(inst).toString();
    if (cutInData.instCache[key]) return cutInData.instCache[key];
    var cache = { images: [], imageNames: [], renderers: [], rendererNames: [], vanillaSpr: {} };
    try {
        var go = null;
        try {
            var ggMi = A.cgm(cutInCls.component, Memory.allocUtf8String("get_gameObject"), 0);
            if (ggMi && !ggMi.isNull()) go = invoke(ggMi, inst, []);
        } catch (e) {}
        if (go && !go.isNull()) {
            var gicMi = A.cgm(cutInCls.gameObject, Memory.allocUtf8String("GetComponentsInChildren"), 2);
            var getImgSprMi = A.cgm(cutInCls.image, Memory.allocUtf8String("get_sprite"), 0);
            var getSrSprMi = A.cgm(cutInCls.spriteRenderer, Memory.allocUtf8String("get_sprite"), 0);
            if (gicMi && !gicMi.isNull()) {
                var tbool = Memory.alloc(4); tbool.writeS32(1);
                function collect(arr, getSprMi, list, nameList) {
                    if (!arr || arr.isNull()) return;
                    var len = arr.add(0x18).readS32();
                    for (var i = 0; i < len; i++) {
                        var e = arr.add(0x20 + i * 8).readPointer();
                        if (!e || e.isNull()) continue;
                        var sp = (getSprMi && !getSprMi.isNull()) ? invoke(getSprMi, e, []) : ptr(0);
                        var nm = sp && !sp.isNull() ? getObjName(sp) : null;
                        if (nm && !cache.vanillaSpr[nm]) cache.vanillaSpr[nm] = sp;
                        list.push(e); nameList.push(nm || "");
                    }
                }
                collect(invoke(gicMi, go, [A.tgo(A.cgt(cutInCls.image)), tbool]), getImgSprMi, cache.images, cache.imageNames);
                collect(invoke(gicMi, go, [A.tgo(A.cgt(cutInCls.spriteRenderer)), tbool]), getSrSprMi, cache.renderers, cache.rendererNames);
            }
        }
    } catch (e) { warn("[v3] CutIn ensureCutInCache err: " + e); }
    cutInData.instCache[key] = cache;
    dbg("[v3] CutIn 实例缓存: " + cache.images.length + " Image, " + cache.renderers.length + " SpriteRenderer");
    // 2026-08-11 诊断: 全量渲染器名 (StainedGlass/001 缺失排查 — 名字匹配是 swap 的唯一依据)
    if (cache.renderers.length) {
        var names = [];
        for (var i = 0; i < cache.rendererNames.length; i++) names.push(i + "=" + (cache.rendererNames[i] || "(无名)"));
        dbg("[v3] CutIn 渲染器名: " + names.join(" | "));
    }
    return cache;
}
// 延迟创建 Sprite, pivot/ppu 取原版 sprite
function getOrCreateCutInSprite(reg, vanillaName, vanillaSpr) {
    var cacheKey = reg.id + "/" + vanillaName;
    if (cutInData.spriteCache[cacheKey] !== undefined) return cutInData.spriteCache[cacheKey];
    try {
        var ent = loadCutInTexture(reg.sprites[vanillaName].path, cacheKey);
        if (!ent || !ent.tex) { cutInData.spriteCache[cacheKey] = null; return null; }
        var px = 0.5, py = 0.5, ppu = 100, rw = 0, rh = 0;
        if (vanillaSpr && !vanillaSpr.isNull()) {
            try {
                var rectMi = A.cgm(cutInCls.sprite, Memory.allocUtf8String("get_rect"), 0);
                var pivMi = A.cgm(cutInCls.sprite, Memory.allocUtf8String("get_pivot"), 0);
                var ppuMi = A.cgm(cutInCls.sprite, Memory.allocUtf8String("get_pixelsPerUnit"), 0);
                // 2026-08-12 根因修复: ppu 是 float 值类型返回, il2cpp_runtime_invoke 的
                // 缓冲返回垃圾 (实测 1.77e-18) → 必须直调 methodPointer 读 s0。蓝本: ppu>0?ppu:100
                if (ppuMi && !ppuMi.isNull()) {
                    try { var ppuV = directCall(ppuMi, "float", [vanillaSpr]); if (ppuV > 0) ppu = ppuV; } catch (e3) { dbg("[v3] CutIn ppu 直调失败: " + e3); }
                }
                // rect/pivot 是 HFA (16B/8B, s0-s3 返回), 直调不可取 → 走 invoke 缓冲 + 归一化守卫
                if (rectMi && !rectMi.isNull()) {
                    try {
                        var rp = invoke(rectMi, vanillaSpr, []);
                        if (rp && !rp.isNull()) { rw = rp.add(8).readFloat(); rh = rp.add(12).readFloat(); }
                    } catch (e2) {}
                }
                if (pivMi && !pivMi.isNull() && rw > 0.001 && rh > 0.001) {
                    try {
                        var pp = invoke(pivMi, vanillaSpr, []);
                        if (pp && !pp.isNull()) {
                            var pvx = pp.readFloat(), pvy = pp.add(4).readFloat();
                            if (isFinite(pvx) && isFinite(pvy)) { px = pvx / rw; py = pvy / rh; }
                        }
                    } catch (e4) {}
                }
                // 归一化守卫: 缓冲垃圾或 rect 无效 → 回落 0.5 (蓝本 rect 无效时的同款回落)
                if (!(px >= 0 && px <= 1)) px = 0.5;
                if (!(py >= 0 && py <= 1)) py = 0.5;
            } catch (e) {}
        }
        dbg("[v3] CutIn Sprite.Create '" + vanillaName + "' pivot=(" + px.toFixed(3) + "," + py.toFixed(3) + ") ppu=" + ppu + " rect=" + rw.toFixed(1) + "x" + rh.toFixed(1) + " tex=" + ent.w + "x" + ent.h);
        cutInData.spriteCache[cacheKey] = makeModSprite(ent.tex, ent.w, ent.h, px, py, ppu);
        return cutInData.spriteCache[cacheKey];
    } catch (e) { warn("[v3] CutIn getOrCreateCutInSprite err: " + e); cutInData.spriteCache[cacheKey] = null; return null; }
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
                    if (sh && !sh.isNull()) sdr = getObjName(sh) || "?";
                }
            } catch (e) {}
            out.push(i + "='" + (cache.rendererNames[i] || "(无名)") + "' shader=" + sdr);
        }
        dbg("[v3] CutIn 渲染器 shader: " + out.join(" | "));
    } catch (e) { warn("[v3] CutIn dumpShaders err: " + e); }
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
                        if (getSprMi && !getSprMi.isNull()) sp = invoke(getSprMi, cache.renderers[i], []);
                    } catch (e) {}
                    names.push(i + "=" + (sp && !sp.isNull() ? (getObjName(sp) || "?") : "null"));
                }
                dbg("[v3] CutIn " + tag + " 后 sprite: " + names.join(" | "));
            } catch (e) { warn("[v3] CutIn reDump err: " + e); }
        }, 1000);
    } catch (e) { warn("[v3] CutIn scheduleReDump err: " + e); }
}
// 按 sprite 名替换 Image/SpriteRenderer 的 sprite (原版激活逻辑不动)
function swapCutInSprites(inst, reg) {
    var cache = ensureCutInCache(inst);
    var setImgSprMi = A.cgm(cutInCls.image, Memory.allocUtf8String("set_sprite"), 1);
    var setSrSprMi = A.cgm(cutInCls.spriteRenderer, Memory.allocUtf8String("set_sprite"), 1);
    var swapped = 0;
    for (var i = 0; i < cache.images.length; i++) {
        var nm = cache.imageNames[i];
        if (!reg.sprites[nm]) continue;
        var sp = getOrCreateCutInSprite(reg, nm, cache.vanillaSpr[nm]);
        if (!sp) { warn("[v3] CutIn sprite 创建失败 '" + nm + "' -> " + reg.sprites[nm].path); continue; }
        if (setImgSprMi && !setImgSprMi.isNull()) { invoke(setImgSprMi, cache.images[i], [sp]); swapped++; dbg("[v3] CutIn 替换 Image#" + i + " '" + nm + "' -> " + reg.sprites[nm].path); }
    }
    for (var j = 0; j < cache.renderers.length; j++) {
        var rn = cache.rendererNames[j];
        if (!reg.sprites[rn]) continue;
        var sp2 = getOrCreateCutInSprite(reg, rn, cache.vanillaSpr[rn]);
        if (!sp2) { warn("[v3] CutIn sprite 创建失败 '" + rn + "' -> " + reg.sprites[rn].path); continue; }
        if (setSrSprMi && !setSrSprMi.isNull()) { invoke(setSrSprMi, cache.renderers[j], [sp2]); swapped++; dbg("[v3] CutIn 替换 SR#" + j + " '" + rn + "' -> " + reg.sprites[rn].path); }
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
        if (cutInHooksReady) return;
        cutInCls = resolveCutInClasses();
        if (cutInCls.customVarMgr.isNull() || cutInCls.objectionCutIn.isNull() || cutInCls.image.isNull()) {
            warn("[v3] CutIn 类解析失败 (CustomVariableManager/ObjectionCutIn/Image)"); return;
        }
        loadCutInData();
        if (!cutInData.ready) { dbg("[v3] CutIn: 无 mod cut-in, 跳过 hook 装配"); return; }
        // hook1: CustomVariableManager.SetVariableValue(string, CustomVariableValue) — onEnter 改写
        var svvMi = A.cgm(cutInCls.customVarMgr, Memory.allocUtf8String("SetVariableValue"), 2);
        if (svvMi && !svvMi.isNull()) {
            Interceptor.attach(svvMi.readPointer(), {
                onEnter: function (a) { try { onCutInSetVariable(a); } catch (e) { dbg("[v3] CutIn onSetVariable err: " + e); } }
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
                        if (!this._inst || this._inst.isNull()) return;
                        var reg = cutInData.pendingEntry;
                        cutInData.pendingEntry = null;
                        if (reg) swapCutInSprites(this._inst, reg);
                    } catch (e) { warn("[v3] CutIn onSpawnParams err: " + e); }
                }
            });
            dbg("[v3] CutIn SetSpawnParameters hooked");
        }
        cutInHooksReady = true;
        info("[v3][CutIn] hooks 就绪");
    } catch (e) { warn("[v3] CutIn setupCutInHooks err: " + e); }
}
