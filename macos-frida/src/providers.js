// ============ provider 管线注册 (镜像 Windows AddModLoader, inflated 泛型版) ============
// 含: 剧本/本地化/voice/audio/背景 provider 注入; 立绘注册在 witchbook/characters.js
import { A, dbg, findClassAcrossImages, findSvc, getGenericArgClass, invoke, invokeOk, makeLocalResourceProvider, makeS, populateConvertersDict, wblog, error, warn } from "./utils.js";
import { addCharacterProviders } from "./witchbook/characters.js";

// 把 provision source 插入 ResourceLoader 的 ProvisionSources
export function insertProvisionSource(rl, lrp, prefix, tag) {
    try {
        var rlKlass = A.ogc(rl);
        var psField = A.gf(rlKlass, Memory.allocUtf8String("ProvisionSources"));
        if (!psField || psField.isNull()) { dbg("[v3] " + tag + ": ProvisionSources 字段 NOT FOUND"); return false; }
        var psList = rl.add(A.fo(psField)).readPointer();
        if (psList.isNull()) { dbg("[v3] " + tag + ": ProvisionSources 为 null"); return false; }
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
        var am = findSvc("AudioManagerExtended");
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
        for (var i = 0; i < backIds.length; i++) {
            try {
                var loader = invoke(galMi, bm, [makeS(backIds[i])]);
                if (!loader || loader.isNull()) { warn("[v3] 背景 loader '" + backIds[i] + "' 为空"); continue; }
                var lrp = makeLocalResourceProvider(root);
                if (lrp.isNull()) { warn("[v3] 背景 LRP 创建失败 ('" + backIds[i] + "')"); continue; }
                if (!populateConvertersDict(lrp, "JpgOrPngToTextureConverter", texFn, "Backgrounds/" + backIds[i])) { warn("[v3] 背景 converters 填充失败 ('" + backIds[i] + "')"); continue; }
                insertProvisionSource(loader, lrp, prefix + "/Backgrounds/" + backIds[i], "Backgrounds/" + backIds[i]);
            } catch (e) { error("[v3] 背景 '" + backIds[i] + "' 注入 err: " + e); }
        }
        wblog("[v3] addBackgroundProviders 完成 (" + backIds.join("/") + ")");
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
