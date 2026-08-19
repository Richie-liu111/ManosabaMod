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
        if (!psField || psField.isNull()) return out;
        var list = rl.add(A.fo(psField)).readPointer();
        if (!list || list.isNull()) return out;
        out.listPtr = list;
        var sz = list.add(0x18).readS32();
        if (sz < 0 || sz > 1024) return out;
        out.cnt = sz;
        if (sz === 0) return out;
        var itemsArr = list.add(0x10).readPointer();
        if (!itemsArr || itemsArr.isNull()) return out;
        out.items = itemsArr;
        for (var i = 0; i < sz; i++) {
            try {
                var ps = itemsArr.add(0x20 + i * 16);
                var pfxPtr = ps.add(8).readPointer();
                if (pfxPtr && !pfxPtr.isNull()) {
                    var ex = readStr(pfxPtr);
                    if (ex === prefix) { out.has = true; break; }
                }
            } catch (e) {}
        }
    } catch (e) {}
    return out;
}

// 把 provision source 插入 ResourceLoader 的 ProvisionSources
// 去重: 扫描现有条目, 若同 prefix 已存在则跳过 (防 TitleUi.Activate 多次触发 + 重注入窗口累积)
export function insertProvisionSource(rl, lrp, prefix, tag) {
    try {
        var rlKlass = A.ogc(rl);
        var psField = A.gf(rlKlass, Memory.allocUtf8String("ProvisionSources"));
        if (!psField || psField.isNull()) { dbg("[v3] " + tag + ": ProvisionSources 字段 NOT FOUND"); return false; }
        var psList = rl.add(A.fo(psField)).readPointer();
        if (psList.isNull()) { dbg("[v3] " + tag + ": ProvisionSources 为 null"); return false; }
        // 去重: 同 prefix 已在列表则视为成功 (幂等). 静默: 重注入帧每帧 16×5 行噪音.
        var scan = _scanProvisionSources(rl, prefix);
        if (scan.has) return true;
        var psMem = Memory.alloc(16);
        psMem.writePointer(lrp);
        psMem.add(8).writePointer(makeS(prefix));
        var listKlass = A.ogc(psList);
        var insMi = A.cgm(listKlass, Memory.allocUtf8String("Insert"), 2);
        if (!insMi || insMi.isNull()) { dbg("[v3] " + tag + ": List.Insert NOT FOUND"); return false; }
        var idxBuf = Memory.alloc(4); idxBuf.writeS32(0);
        var r = invokeOk(insMi, psList, [idxBuf, psMem]);
        dbg("[v3] " + tag + ": Insert(" + prefix + ") → " + (r.ok ? "成功" : "失败") + " 条数=" + psList.add(0x18).readS32());
        return r.ok;
    } catch (e) { dbg("[v3] insertProvisionSource err (" + tag + "): " + e); return false; }
}
export function addTextLoader(root, prefix) {
    try {
        var tm = findSvc("TextManager");
        if (!tm) { dbg("[v3] addTextLoader: TextManager NOT FOUND"); return; }
        var tmKlass = A.ogc(tm);
        var tlField = A.gf(tmKlass, Memory.allocUtf8String("textLoader"));
        var tl = tm.add(A.fo(tlField)).readPointer();
        if (tl.isNull()) { dbg("[v3] addTextLoader: textLoader NULL"); return; }
        var lrp = makeLocalResourceProvider(root);
        if (lrp.isNull()) return;
        var textAssetFn = function () { return findClassAcrossImages("UnityEngine", "TextAsset"); };
        if (!populateConvertersDict(lrp, "TxtToTextAssetConverter", textAssetFn, "Text")) return;
        insertProvisionSource(tl, lrp, prefix + "/Text", "addTextLoader");
    } catch (e) { dbg("[v3] addTextLoader err: " + e); }
}
// voice + audio provider: AudioManagerExtended 的 voiceLoader(0x78)/audioLoader(0x70) + WavToAudioClipConverter
export function addAudioProviders(root, prefix) {
    try {
        var am = findSvc("AudioManagerExtended", true);
        if (!am) am = findSvc("AudioManager");
        if (!am) { dbg("[v3] addAudioProviders: AudioManager NOT FOUND"); return; }
        var audioClipFn = function () { return findClassAcrossImages("UnityEngine", "AudioClip"); };
        var voiceLoader = am.add(0x78).readPointer();
        if (!voiceLoader.isNull()) {
            var lrpV = makeLocalResourceProvider(root);
            if (!lrpV.isNull() && populateConvertersDict(lrpV, "WavToAudioClipConverter", audioClipFn, "Voice"))
                insertProvisionSource(voiceLoader, lrpV, prefix + "/Voice", "addAudioProviders(Voice)");
        } else { dbg("[v3] addAudioProviders: voiceLoader NULL"); }
        var audioLoader = am.add(0x70).readPointer();
        if (!audioLoader.isNull()) {
            var lrpA = makeLocalResourceProvider(root);
            if (!lrpA.isNull() && populateConvertersDict(lrpA, "WavToAudioClipConverter", audioClipFn, "Audio"))
                insertProvisionSource(audioLoader, lrpA, prefix + "/Audio", "addAudioProviders(Audio)");
        } else { dbg("[v3] addAudioProviders: audioLoader NULL"); }
    } catch (e) { dbg("[v3] addAudioProviders err: " + e); }
}

// 背景 provider: BackgroundManagerExtended.GetAppearanceLoader("MainBackground"/"Stills"/"Tricks")
//   + JpgOrPngToTextureConverter → ProvisionSource(prefix/Backgrounds/<backId>) (镜像 Windows)
export function addBackgroundProviders(root, prefix) {
    try {
        var bm = findSvc("BackgroundManagerExtended");
        if (!bm) { warn("[v3] addBackgroundProviders: BackgroundManagerExtended NOT FOUND"); return; }
        var galMi = A.cgm(A.ogc(bm), Memory.allocUtf8String("GetAppearanceLoader"), 1);
        if (!galMi || galMi.isNull()) { warn("[v3] addBackgroundProviders: GetAppearanceLoader NOT FOUND"); return; }
        var texFn = function () { return findClassAcrossImages("UnityEngine", "Texture2D"); };
        var backIds = ["MainBackground", "Stills", "Tricks"];
        var addedNames = [];
        for (var i = 0; i < backIds.length; i++) {
            try {
                var loader = invoke(galMi, bm, [makeS(backIds[i])]);
                if (!loader || loader.isNull()) { warn("[v3] 背景 loader '" + backIds[i] + "' 为空"); continue; }
                var scan = _scanProvisionSources(loader, prefix + "/Backgrounds/" + backIds[i]);
                if (scan.has) continue;   // 重注入 no-op: 已在列表, 静默
                var lrp = makeLocalResourceProvider(root);
                if (lrp.isNull()) { warn("[v3] 背景 LRP 创建失败 ('" + backIds[i] + "')"); continue; }
                if (!populateConvertersDict(lrp, "JpgOrPngToTextureConverter", texFn, "Backgrounds/" + backIds[i])) { warn("[v3] 背景 converters 填充失败 ('" + backIds[i] + "')"); continue; }
                if (insertProvisionSource(loader, lrp, prefix + "/Backgrounds/" + backIds[i], "Backgrounds/" + backIds[i])) addedNames.push(backIds[i]);
            } catch (e) { error("[v3] 背景 '" + backIds[i] + "' 注入 err: " + e); }
        }
        // 只在真正新增时记 wblog, 且每 burst 只记首条 (一次切语言 FSG ×几十次重注入,
        // 每波都真重插某个 loader → 只让第一条可见); 重注入 no-op 静默。
        if (addedNames.length > 0) {
            if (!_localeReinject.bgLoggedThisBurst) {
                wblog("[v3] addBackgroundProviders 完成: 新增 [" + addedNames.join(",") + "] (" + backIds.join("/") + ")");
                _localeReinject.bgLoggedThisBurst = true;
            } else {
                dbg("[v3] addBackgroundProviders 新增 [" + addedNames.join(",") + "] (burst 内重复)");
            }
        } else {
            dbg("[v3] addBackgroundProviders 完成 (已在列表, 重注入 no-op)");
        }
    } catch (e) { error("[v3] addBackgroundProviders err: " + e); }
}
export function addModLoader(root, prefix) {
    try {
        var sm = findSvc("ScriptManager");
        if (!sm) { error("[v3] addModLoader: ScriptManager NOT FOUND (prefix='" + prefix + "')"); return; }
        var rl = sm.add(0x28).readPointer();
        if (rl.isNull()) { error("[v3] addModLoader: scriptLoader NULL (prefix='" + prefix + "')"); return; }

        // 剧本 provider: LRP(MOD_ROOT) + NaniToScriptAssetConverter + ProvisionSource(prefix/Scripts)
        var lrp = makeLocalResourceProvider(root);
        if (lrp.isNull()) { error("[v3] addModLoader: LRP 创建失败 (root='" + root + "')"); return; }
        var scriptFn = function () { return findClassAcrossImages("Naninovel", "Script"); };
        if (!populateConvertersDict(lrp, "NaniToScriptAssetConverter", scriptFn, "Script")) { error("[v3] addModLoader: Script converters 失败 ('" + prefix + "')"); return; }
        insertProvisionSource(rl, lrp, prefix + "/Scripts", "addModLoader(Script)");

        // 本地化 provider: LRP(MOD_ROOT) + TxtToTextAssetConverter + ProvisionSource(prefix/Text)
        addTextLoader(root, prefix);

        // voice + audio provider
        addAudioProviders(root, prefix);

        // 背景 provider (MainBackground/Stills/Tricks)
        addBackgroundProviders(root, prefix);

        // 立绘 provider (Characters/SimpleCharacters → ActorMetadata 注册)
        addCharacterProviders(root, prefix);
    } catch (e) { error("[v3] addModLoader err: " + e); }
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
    inProgress: false,   // 重入守卫: HandleLocaleChanged 多 T 实例化密集触发时合并
    totalReinjects: 0,
    lastReason: "",      // 同 burst 日志去重: 一次切语言 FSG ×几十次触发, 只记首条
    bgLoggedThisBurst: false  // addBackgroundProviders 的"新增"日志: 每 burst 只记首条 (首次加载也算一 burst)
};

// 同步重注入 (主线程, hook onLeave 上下文内执行).
// 对每个 mod 重跑 addModLoader — insertProvisionSource 自带去重 (同 prefix 已在列表则跳过),
// 幂等可反复调用. 每次切语言 HandleLocaleChanged 会被每个 loader 实例触发 (FSG ×几十),
// 每次触发都同步重注入一次, 覆盖各 loader 各自的 wipe+reload 窗口 (漏一次就丢 provider).
// 重注入不能合并 (各 loader 各自 wipe 的时序), 但日志要合并: 同 reason (同一次切语言) 只打首条.
export function startReinjectWindow(reason) {
    if (_localeReinject.inProgress) return;   // 重入合并: 注入中再触发直接忽略
    _localeReinject.inProgress = true;
    try {
        _localeReinject.totalReinjects++;
        var sameBurst = (reason === _localeReinject.lastReason);
        _localeReinject.lastReason = reason;
        if (!sameBurst) _localeReinject.bgLoggedThisBurst = false;   // 新 burst: 允许下一条"新增"记 wblog
        if (sameBurst) {
            dbg("[v3] 语言切换重注入 #" + _localeReinject.totalReinjects + " (" + reason + ") 同 burst 第 N 次 (FSG 多实例), 已注入");
        } else {
            wblog("[v3] ==== 语言切换重注入 #" + _localeReinject.totalReinjects + " (" + reason + ") ====");
        }
        _reinjectAll();
    } catch (e) {
        dbg("[v3] 重注入 err: " + e);
    }
    _localeReinject.inProgress = false;
}

// 单次全量重注入: 遍历 modList 重跑 addModLoader; 记录 scriptLoader ProvisionSources 前后条数做诊断
function _reinjectAll() {
    if (typeof modList === "undefined" || !modList || !modList.length) { dbg("[v3] modList 为空, 重注入跳过"); return; }
    var root = (typeof MOD_ROOT !== "undefined") ? MOD_ROOT : "";
    var errors = 0, beforeCnt = -1, afterCnt = -1;
    var scriptLoader = null;
    try {
        var sm = findSvc("ScriptManager");
        if (sm && !sm.isNull()) {
            var sl = sm.add(0x28).readPointer();
            if (!sl.isNull()) { scriptLoader = sl; beforeCnt = _scanProvisionSources(sl, "").cnt; }
        }
    } catch (e) {}
    for (var mi = 0; mi < modList.length; mi++) {
        try { addModLoader(root, modList[mi].key); }
        catch (e) {
            errors++;
            if (errors <= 3) dbg("[v3] 重注入 addModLoader('" + modList[mi].key + "') err: " + e);
        }
    }
    if (scriptLoader) {
        try { afterCnt = _scanProvisionSources(scriptLoader, "").cnt; } catch (e) {}
        dbg("[v3] 重注入后 scriptLoader ProvisionSources: " + beforeCnt + " → " + afterCnt + " (addModLoader 错误 " + errors + ")");
    }
}

// 挂载钩子说明: 实际 hook 在 choice.js 的 chHookClassMethods (HandleLocaleChanged @ FSG 共享体,
// 一次覆盖所有 ResourceLoader<T>). 此处仅做初始化日志, 不重复 attach (会叠加 onEnter 调用).
export function setupLocaleReinjectHooks() {
    wblog("[v3] 语言切换重注入就绪 (HandleLocaleChanged onLeave → 主线程同步重注入, 无 JS timer)");
}