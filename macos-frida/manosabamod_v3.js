// manosabamod_v3.js — 镜像 Windows 机制 + il2cpp_thread_attach + 动态解析
// 已验证的前提:
//   * il2cpp_thread_attach 解锁 il2cpp_runtime_invoke (Script.FromText OK, klass=Script)
//   * Windows 版注入靠 ProvisionSources/AddLoadedResource/Path.SetValue, 不靠字典手写
//   * GotoModified 在 GigaCreation.NaninovelExtender.Common, 必须动态解析 (Windows RVA 不跨平台)
// 流程:
//   init: Steam 绕过 + thread_attach + 绑定 API + 找 image
//   TitleUi.Activate: 找 StartGame 下的 GotoModified → Path.SetValue("TaffyStart") → 注册菜单
//   菜单经 Script.FromText 构建, 经 AddLoadedResource 注册
'use strict';

// ============ Steam 绕过 (Phase 1) ============
try { var dl = Module.findGlobalExportByName("dlopen"); if (dl) { var h = false; Interceptor.attach(dl, { onEnter: function (a) { this.p = a[0].readCString(); }, onLeave: function (r) { if (h || r.isNull() || !this.p || this.p.indexOf("libsteam_api") === -1) return; var r2 = Module.findGlobalExportByName("SteamAPI_RestartAppIfNecessary"); if (r2) Interceptor.replace(r2, new NativeCallback(function () { return 0; }, 'bool', ['uint32'])); var i2 = Module.findGlobalExportByName("SteamInternal_SteamAPI_Init"); if (i2) Interceptor.replace(i2, new NativeCallback(function () { return 2; }, 'int', [])); h = true; } }); } } catch (e) { }

var A = {}, E = {}, nv = null, cs = null, giga = null, dom = null;
var allImgs = [];
var gotoModifiedCls = null;
var shouldLogLoadAndPlay = true;

// ============ 基础工具 ============
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
        var en = ex ? (A.ogc(ex) ? A.cgn(A.ogc(ex)).readCString() : "?") : "?";
        console.log("[v3] invoke THREW: " + en);
        return ptr(0);
    }
    return ret;
}
// 返回成功与否的 invoke
function invokeOk(mi, obj, args) {
    var params = args.length ? Memory.alloc(Process.pointerSize * args.length) : ptr(0);
    for (var i = 0; i < args.length; i++) params.add(i * Process.pointerSize).writePointer(args[i]);
    var exc = Memory.alloc(8); exc.writePointer(ptr(0));
    var ret = A.ri(mi, obj, params, exc);
    var ex = exc.readPointer();
    if (!ex.isNull()) {
        var en = ex ? (A.ogc(ex) ? A.cgn(A.ogc(ex)).readCString() : "?") : "?";
        console.log("[v3] invoke THREW: " + en);
        return { ok: false, ret: ptr(0) };
    }
    return { ok: true, ret: ret };
}
// 0 参构造器调用 (用户已证可行)
var ctorCache = {};
function tryCtor(cls, obj) {
    var k = ptr(cls).toInt32();
    if (ctorCache[k] === undefined) {
        var mi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 0);
        ctorCache[k] = mi && !mi.isNull() ? new NativeFunction(mi.readPointer(), 'void', ['pointer']) : null;
    }
    var fn = ctorCache[k]; if (fn) fn(obj);
}
function findClassAcrossImages(ns, name) {
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

// ============ 菜单文本 (镜像 Windows AddModStartMenu, 简化) ============
function buildMenuText(modList) {
    var t = "@ProcessInput false\n@trialMode false\n@HideUI AutoToggle,WitchBookButtonUI AllowToggle:false time:0\n" +
            "@ShowUI ControlPanel time:0\n@back SubId:\"Overlay\" SolidColor tint:\"#000000\" time:0 Lazy:false\n";
    // 值必须带转义引号 (\"...\"), 否则 '/' 被当成除法表达式
    function setline(varName, val) {
        return "    @set \"" + varName + "=\\\"" + val + "\\\"\"\n";
    }
    // 原版
    t += "@choice \"原版游戏剧情\" Lock:false play:true show:true\n" +
         setline("nextScenario", "Act01_Chapter01/Act01_Chapter01_Adv01") +
         setline("modKey", "__vanilla__") +
         "    @goto .GoToModScript\n";
    for (var i = 0; i < modList.length; i++) {
        var m = modList[i];
        var enter = (m.Enter || "Act01_Chapter01/Act01_Chapter01_Adv01").replace(/"/g, '\\"');
        var nm = (m.Name || "Mod" + i).replace(/"/g, '\\"');
        t += "@choice \"" + nm + "\" Lock:false play:true show:true\n" +
             setline("nextScenario", enter) +
             setline("modKey", m.key) +
             "    @goto .GoToModScript\n";
    }
    t += "@Stop\n" +
         "\n# GoToModScript\n" +
         "@ProcessInput true set:Continue.true,Pause.true,Skip.true,ToggleSkip.true,AutoPlay.true,ToggleUI.true,ShowBacklog.true,Rollback.true\n" +
         "@ClearBacklog\n" +
         "@goto {nextScenario}\n";
    return t;
}

// ============ 注册菜单剧本 (FromText + AddLoadedResource) ============
var modScriptPrefix = "TaffyModLoader";
var modMenuScript = "TaffyStart";
// ============ provider 管线注册 (镜像 Windows AddModLoader, inflated 泛型版) ============
// 从实例化泛型类的 type 挖 genericInst 的某个 type 参数 → 类
function getGenericArgClass(instClass, idx) {
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
    } catch (e) { console.log("[v3] getGenericArgClass err: " + e); return ptr(0); }
}
// 用 inflated 泛型方法填充 LRP.converters (Dictionary<Type, List<IConverter>>) — 绕开 FSG AddConverter
// convClassName: 转换器类名; targetClsFn: () => 目标类型的 Il2CppClass (Script/TextAsset)
function populateConvertersDict(lrp, convClassName, targetClsFn, tag) {
    try {
        var dict = lrp.add(0x58).readPointer();
        var dictCls = A.ogc(dict);
        var listCls = getGenericArgClass(dictCls, 1);          // List<IConverter>
        if (listCls.isNull()) { console.log("[v3] List<IConverter> 类提取失败 (" + tag + ")"); return false; }
        var listObj = A.on(listCls);
        if (!invokeOk(A.cgm(listCls, Memory.allocUtf8String(".ctor"), 0), listObj, []).ok) { console.log("[v3] List.ctor 失败 (" + tag + ")"); return false; }
        var convCls = findClassAcrossImages("Naninovel", convClassName);
        if (convCls.isNull()) { console.log("[v3] " + convClassName + " NOT FOUND"); return false; }
        var conv = A.on(convCls);
        if (!invokeOk(A.cgm(convCls, Memory.allocUtf8String(".ctor"), 0), conv, []).ok) { console.log("[v3] " + convClassName + ".ctor 失败"); return false; }
        if (!invokeOk(A.cgm(listCls, Memory.allocUtf8String("Add"), 1), listObj, [conv]).ok) { console.log("[v3] List.Add 失败 (" + tag + ")"); return false; }
        var targetCls = targetClsFn();
        if (targetCls.isNull()) { console.log("[v3] 目标类型类 NULL (" + tag + ")"); return false; }
        var typeObj = A.tgo(A.cgt(targetCls));               // typeof(target)
        if (!invokeOk(A.cgm(dictCls, Memory.allocUtf8String("Add"), 2), dict, [typeObj, listObj]).ok) { console.log("[v3] Dict.Add 失败 (" + tag + ")"); return false; }
        console.log("[v3] converters 填充 OK (" + convClassName + " → " + tag + ")");
        return true;
    } catch (e) { console.log("[v3] populateConverters err (" + tag + "): " + e); return false; }
}
// 把 provision source 插入 ResourceLoader 的 ProvisionSources
function insertProvisionSource(rl, lrp, prefix, tag) {
    try {
        var rlKlass = A.ogc(rl);
        var psField = A.gf(rlKlass, Memory.allocUtf8String("ProvisionSources"));
        if (!psField || psField.isNull()) { console.log("[v3] " + tag + ": ProvisionSources 字段 NOT FOUND"); return false; }
        var psList = rl.add(A.fo(psField)).readPointer();
        if (psList.isNull()) { console.log("[v3] " + tag + ": ProvisionSources 为 null"); return false; }
        var psMem = Memory.alloc(16);
        psMem.writePointer(lrp);
        psMem.add(8).writePointer(makeS(prefix));
        var listKlass = A.ogc(psList);
        var insMi = A.cgm(listKlass, Memory.allocUtf8String("Insert"), 2);
        if (!insMi || insMi.isNull()) { console.log("[v3] " + tag + ": List.Insert NOT FOUND"); return false; }
        var idxBuf = Memory.alloc(4); idxBuf.writeS32(0);
        var r = invokeOk(insMi, psList, [idxBuf, psMem]);
        console.log("[v3] " + tag + ": Insert(" + prefix + ") → " + (r.ok ? "OK" : "FAIL") + " 条数=" + psList.add(0x18).readS32());
        return r.ok;
    } catch (e) { console.log("[v3] insertProvisionSource err (" + tag + "): " + e); return false; }
}
function addTextLoader(root, prefix) {
    try {
        var tm = findSvc("TextManager");
        if (!tm) { console.log("[v3] addTextLoader: TextManager NOT FOUND"); return; }
        var tmKlass = A.ogc(tm);
        var tlField = A.gf(tmKlass, Memory.allocUtf8String("textLoader"));
        var tl = tm.add(A.fo(tlField)).readPointer();
        if (tl.isNull()) { console.log("[v3] addTextLoader: textLoader NULL"); return; }
        var lrp = makeLocalResourceProvider(root);
        if (lrp.isNull()) return;
        var textAssetFn = function () { return findClassAcrossImages("UnityEngine", "TextAsset"); };
        if (!populateConvertersDict(lrp, "TxtToTextAssetConverter", textAssetFn, "Text")) return;
        insertProvisionSource(tl, lrp, prefix + "/Text", "addTextLoader");
    } catch (e) { console.log("[v3] addTextLoader err: " + e); }
}
// voice + audio provider: AudioManagerExtended 的 voiceLoader(0x78)/audioLoader(0x70) + WavToAudioClipConverter
function addAudioProviders(root, prefix) {
    try {
        var am = findSvc("AudioManagerExtended");
        if (!am) am = findSvc("AudioManager");
        if (!am) { console.log("[v3] addAudioProviders: AudioManager NOT FOUND"); return; }
        var audioClipFn = function () { return findClassAcrossImages("UnityEngine", "AudioClip"); };
        var voiceLoader = am.add(0x78).readPointer();
        if (!voiceLoader.isNull()) {
            var lrpV = makeLocalResourceProvider(root);
            if (!lrpV.isNull() && populateConvertersDict(lrpV, "WavToAudioClipConverter", audioClipFn, "Voice"))
                insertProvisionSource(voiceLoader, lrpV, prefix + "/Voice", "addAudioProviders(Voice)");
        } else { console.log("[v3] addAudioProviders: voiceLoader NULL"); }
        var audioLoader = am.add(0x70).readPointer();
        if (!audioLoader.isNull()) {
            var lrpA = makeLocalResourceProvider(root);
            if (!lrpA.isNull() && populateConvertersDict(lrpA, "WavToAudioClipConverter", audioClipFn, "Audio"))
                insertProvisionSource(audioLoader, lrpA, prefix + "/Audio", "addAudioProviders(Audio)");
        } else { console.log("[v3] addAudioProviders: audioLoader NULL"); }
    } catch (e) { console.log("[v3] addAudioProviders err: " + e); }
}

function addModLoader(root, prefix) {
    try {
        var sm = findSvc("ScriptManager");
        if (!sm) { console.log("[v3] addModLoader: ScriptManager NOT FOUND"); return; }
        var rl = sm.add(0x28).readPointer();
        if (rl.isNull()) { console.log("[v3] addModLoader: scriptLoader NULL"); return; }

        // 剧本 provider: LRP(MOD_ROOT) + NaniToScriptAssetConverter + ProvisionSource(prefix/Scripts)
        var lrp = makeLocalResourceProvider(root);
        if (lrp.isNull()) { console.log("[v3] addModLoader: LRP 创建失败 (root='" + root + "')"); return; }
        var scriptFn = function () { return findClassAcrossImages("Naninovel", "Script"); };
        if (!populateConvertersDict(lrp, "NaniToScriptAssetConverter", scriptFn, "Script")) return;
        insertProvisionSource(rl, lrp, prefix + "/Scripts", "addModLoader(Script)");

        // 本地化 provider: LRP(MOD_ROOT) + TxtToTextAssetConverter + ProvisionSource(prefix/Text)
        addTextLoader(root, prefix);

        // voice + audio provider
        addAudioProviders(root, prefix);
    } catch (e) { console.log("[v3] addModLoader err: " + e); }
}

// 找 UnityEngine.CoreModule image
function findUnityImg() {
    for (var i = 0; i < allImgs.length; i++) {
        var inm = A.ign(allImgs[i]).readCString();
        if (inm.indexOf("UnityEngine.CoreModule") >= 0) return allImgs[i];
    }
    return null;
}
// 创建 Unity 对象: object_new + 0参构造 (runtime_invoke → 直调 fallback)
function makeUnityObject(cls) {
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
// 注册菜单本地化文档 (镜像 Windows: TextManager.textLoader 上 AddLoadedResource TextAsset)
function registerMenuText() {
    try {
        var tm = findSvc("TextManager");
        if (!tm) { console.log("[v3] TextManager NOT FOUND"); return; }
        var tmKlass = A.ogc(tm);
        var tlField = A.gf(tmKlass, Memory.allocUtf8String("textLoader"));
        var tl = tm.add(A.fo(tlField)).readPointer();
        if (tl.isNull()) { console.log("[v3] textLoader NULL"); return; }
        var tlKlass = A.ogc(tl);
        console.log("[v3] textLoader=" + tl);

        // 偷 Resource<TextAsset> + LoadedResource<TextAsset> 类 (放宽: 任意条目)
        var resClass = null, lrClass = null;
        try {
            var ldlField = A.gf(tlKlass, Memory.allocUtf8String("LoadedByLocalPath"));
            if (!ldlField || ldlField.isNull()) { console.log("[v3] LoadedByLocalPath 字段 NOT FOUND"); }
            var dict = tl.add(A.fo(ldlField)).readPointer();
            console.log("[v3] text dict=" + dict + " (field offset 0x" + A.fo(ldlField).toString(16) + ")");
            if (!dict.isNull()) {
                var ents = dict.add(0x18).readPointer();
                var al = ents.add(0x18).readS32();
                console.log("[v3] text dict count=" + al);
                for (var e = 0; e < al && e < 30; e++) {
                    var eb = ents.add(0x20 + e * 24);
                    if (eb.readS32() === -1) continue;
                    var ks = readStr(eb.add(8).readPointer());
                    if (e < 5) console.log("[v3] text dict[" + e + "] key=" + ks);
                    var lr = eb.add(16).readPointer();
                    var sysRes = lr.add(0x10).readPointer();
                    if (sysRes && !sysRes.isNull()) {
                        resClass = sysRes.readPointer(); lrClass = lr.readPointer();
                        break;
                    }
                }
            }
        } catch (e2) { console.log("[v3] text class-steal err: " + e2); }
        if (!resClass || !lrClass) { console.log("[v3] 无法偷 TextAsset 类"); return; }

        // new TextAsset()
        var ueImg = findUnityImg();
        if (!ueImg) { console.log("[v3] UnityEngine.CoreModule NOT FOUND"); return; }
        var taCls = A.cfn(ueImg, Memory.allocUtf8String("UnityEngine"), Memory.allocUtf8String("TextAsset"));
        if (!taCls || taCls.isNull()) { console.log("[v3] TextAsset class NOT FOUND"); return; }
        var ta = makeUnityObject(taCls);
        console.log("[v3] TextAsset=" + ta);

        // Resource<TextAsset>
        var textPath = modScriptPrefix + "/Text/Scripts/" + modMenuScript;
        var ourRes = A.on(resClass);
        ourRes.add(0x10).writePointer(makeS(textPath));
        ourRes.add(0x18).writePointer(ta);

        // ProvisionSource + boxed (和 registerMenu 一致)
        var provProvider = makeLocalResourceProvider("");
        var psMem = Memory.alloc(16);
        psMem.writePointer(provProvider);
        psMem.add(8).writePointer(makeS(modScriptPrefix + "/Text"));
        var psCls = findClassAcrossImages("Naninovel", "ProvisionSource");
        var boxed = ptr(0);
        if (A.vb && psCls && !psCls.isNull()) { try { boxed = A.vb(psCls, psMem); } catch (e3) {} }

        // LoadedResource ctor + AddHolder + AddLoadedResource
        var lrCtor = A.cgm(lrClass, Memory.allocUtf8String(".ctor"), 2);
        var addHolderMi = A.cgm(lrClass, Memory.allocUtf8String("AddHolder"), 1);
        var addMi = A.cgm(tlKlass, Memory.allocUtf8String("AddLoadedResource"), 1);
        if (!lrCtor || lrCtor.isNull() || !addMi || addMi.isNull()) { console.log("[v3] 方法解析失败"); return; }
        // 打印偷到的类名, 确认泛型实例正确
        try {
            console.log("[v3] resClass=" + A.cgn(resClass).readCString() + " lrClass=" + A.cgn(lrClass).readCString());
        } catch (e4) { console.log("[v3] 类名读取失败: " + e4); }

        // 多键注册 (覆盖所有可能路径)
        var keys = ["Text/Scripts/" + modMenuScript, "Scripts/" + modMenuScript, modScriptPrefix + "/Text/Scripts/" + modMenuScript, modMenuScript];
        for (var ki = 0; ki < keys.length; ki++) {
            var lr = A.on(lrClass);
            invoke(lrCtor, lr, [ourRes, psMem]);
            lr.add(0x28).writePointer(makeS(keys[ki]));
            if (addHolderMi && !addHolderMi.isNull() && boxed && !boxed.isNull()) invoke(addHolderMi, lr, [boxed]);
            invoke(addMi, tl, [lr]);
            console.log("[v3] >>> 本地化文档已注册: key=" + keys[ki]);
        }
    } catch (e) { console.log("[v3] registerMenuText err: " + e); }
}

function registerMenu(modList) {
    // 缓存方案 (镜像 Windows AddModStartMenu): FromText + AddHolder + AddLoadedResource
    try {
        var text = buildMenuText(modList);
        var scriptCls = findClassAcrossImages("Naninovel", "Script");
        if (scriptCls.isNull()) { console.log("[v3] Script class NOT FOUND"); return; }
        var ftMi = A.cgm(scriptCls, Memory.allocUtf8String("FromText"), 3);
        if (!ftMi || ftMi.isNull()) { console.log("[v3] Script.FromText NOT FOUND"); return; }
        var script = invoke(ftMi, ptr(0), [makeS(modMenuScript), makeS(text), ptr(0)]);
        if (script.isNull()) { console.log("[v3] FromText returned null"); return; }
        console.log("[v3] FromText OK, script=" + script);

        var sm = findSvc("ScriptManager");
        if (!sm) { console.log("[v3] ScriptManager NOT FOUND"); return; }
        var rl = sm.add(0x28).readPointer();
        if (rl.isNull()) { console.log("[v3] scriptLoader NULL"); return; }
        var rlKlass = A.ogc(rl);

        // 偷类指针
        var resClass = null, lrClass = null;
        try {
            var dict = rl.add(0x30).readPointer();
            var ents = dict.add(0x18).readPointer();
            var al = ents.add(0x18).readS32();
            for (var e = 0; e < al; e++) {
                var eb = ents.add(0x20 + e * 24);
                if (eb.readS32() === -1) continue;
                var ks = readStr(eb.add(8).readPointer());
                if (ks && ks.indexOf("System/System_Title") >= 0) {
                    var lr = eb.add(16).readPointer();
                    var sysRes = lr.add(0x10).readPointer();
                    if (sysRes && !sysRes.isNull()) { resClass = sysRes.readPointer(); lrClass = lr.readPointer(); }
                    break;
                }
            }
        } catch (e2) { console.log("[v3] class-steal err: " + e2); }
        if (!resClass || !lrClass) { console.log("[v3] 无法偷类指针"); return; }

        var resPath = modScriptPrefix + "/Scripts/" + modMenuScript;
        var ourRes = A.on(resClass);
        ourRes.add(0x10).writePointer(makeS(resPath));
        ourRes.add(0x18).writePointer(script);

        // ProvisionSource struct
        var provProvider = makeLocalResourceProvider("");
        var psMem = Memory.alloc(16);
        psMem.writePointer(provProvider);
        psMem.add(8).writePointer(makeS(modScriptPrefix + "/Scripts"));

        // LoadedResource 用 ctor
        var lrCtor = A.cgm(lrClass, Memory.allocUtf8String(".ctor"), 2);
        if (!lrCtor || lrCtor.isNull()) { console.log("[v3] LoadedResource.ctor NOT FOUND"); return; }
        var addHolderMi = A.cgm(lrClass, Memory.allocUtf8String("AddHolder"), 1);
        var addMi = A.cgm(rlKlass, Memory.allocUtf8String("AddLoadedResource"), 1);
        if (!addMi || addMi.isNull()) { console.log("[v3] AddLoadedResource NOT FOUND"); return; }

        // 装箱 ProvisionSource 供 AddHolder
        var boxed = ptr(0);
        if (A.vb && addHolderMi && !addHolderMi.isNull()) {
            var psCls = findClassAcrossImages("Naninovel", "ProvisionSource");
            if (psCls && !psCls.isNull()) {
                try { boxed = A.vb(psCls, psMem); } catch (e3) { console.log("[v3] value_box err: " + e3); }
            }
        }
        console.log("[v3] 包装完成, boxed=" + boxed + " provider=" + provProvider);

        function buildAndAdd(localPath) {
            var lr = A.on(lrClass);
            invoke(lrCtor, lr, [ourRes, psMem]);
            lr.add(0x28).writePointer(makeS(localPath));
            if (addHolderMi && !addHolderMi.isNull() && boxed && !boxed.isNull()) invoke(addHolderMi, lr, [boxed]);
            invoke(addMi, rl, [lr]);
            console.log("[v3] >>> AddLoadedResource('" + localPath + "') 完成 (含 AddHolder)");
        }
        buildAndAdd(resPath);
        buildAndAdd(modMenuScript);
    } catch (e) { console.log("[v3] registerMenu err: " + e); }
}

// ============ 重定向 StartGame 的 @goto (镜像 Windows HookStartGame) ============
function hookStartGame() {
    try {
        var sp = findSvc("WitchTrialsScriptPlayer");
        if (!sp) sp = findSvc("ScriptPlayer");
        if (!sp) { console.log("[v3] ScriptPlayer NOT FOUND"); return; }
        var played = sp.add(0x58).readPointer();   // PlayedScript
        if (played.isNull()) { console.log("[v3] PlayedScript NULL"); return; }
        var linesArr = played.add(0x30).readPointer(); // Script.lines
        if (linesArr.isNull()) { console.log("[v3] lines NULL"); return; }
        var n = linesArr.add(0x18).readS32();
        var foundLabel = false;
        for (var i = 0; i < n; i++) {
            var lineObj = linesArr.add(0x20 + i * 8).readPointer();
            if (lineObj.isNull()) continue;
            var cls = A.ogc(lineObj);
            var cn = A.cgn(cls).readCString();
            if (cn === "LabelScriptLine") {
                var lt = readStr(lineObj.add(0x20).readPointer());
                if (lt === "StartGame") foundLabel = true;
            } else if (cn === "CommandScriptLine" && foundLabel) {
                var cmd = lineObj.add(0x20).readPointer();
                if (cmd.isNull()) continue;
                var cmdCls = A.ogc(cmd);
                if (gotoModifiedCls && !gotoModifiedCls.isNull() && cmdCls.equals(gotoModifiedCls)) {
                    console.log("[v3] 找到 StartGame 下的 GotoModified @ line " + i + ", cmd=" + cmd);
                    // Path.SetValue(NamedString(value="TaffyStart", name=""))
                    var pathObj = cmd.add(0x30).readPointer();
                    var nspCls = A.ogc(pathObj);
                    var svMi = A.cgm(nspCls, Memory.allocUtf8String("SetValue"), 1);
                    if (!svMi || svMi.isNull()) { console.log("[v3] Path.SetValue NOT FOUND"); return; }
                    // 重定向到完整路径 (缓存键测试)
                    var fullPath = modScriptPrefix + "/Scripts/" + modMenuScript;
                    var nsObj = makeNamedStringCtor(fullPath, "");
                    invoke(svMi, pathObj, [nsObj]);
                    console.log("[v3] >>> Path.SetValue(\"" + fullPath + "\") 完成 (完整路径)");
                    return;
                }
            }
        }
        console.log("[v3] 未在 StartGame 下找到 GotoModified (lines=" + n + ")");
    } catch (e) { console.log("[v3] hookStartGame err: " + e); }
}

function makeNullStr(str) {
    var cls = findClassAcrossImages("Naninovel", "NullableString");
    if (!cls || cls.isNull()) return ptr(0);
    var o = A.on(cls); tryCtor(cls, o);
    o.add(0x10).writePointer(str || ptr(0)); o.add(0x18).writeS32(str ? 1 : 0);
    return o;
}
// NamedString 用构造器创建, 不猜字段布局: ctor(name, value)
function makeNamedStringCtor(name, value) {
    var cls = findClassAcrossImages("Naninovel", "NamedString");
    if (!cls || cls.isNull()) return ptr(0);
    var o = A.on(cls);
    var ctorMi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 2);
    if (!ctorMi || ctorMi.isNull()) { console.log("[v3] NamedString.ctor NOT FOUND"); return ptr(0); }
    invoke(ctorMi, o, [makeS(name || ""), makeS(value || "")]);
    return o;
}
// 创建 LocalResourceProvider(rootPath) — runtime_invoke 失败则直调 methodPointer
function makeLocalResourceProvider(root) {
    var cls = findClassAcrossImages("Naninovel", "LocalResourceProvider");
    if (!cls || cls.isNull()) { console.log("[v3] LocalResourceProvider NOT FOUND"); return ptr(0); }
    var o = A.on(cls);
    var ctorMi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 1);
    if (!ctorMi || ctorMi.isNull()) { console.log("[v3] LRP.ctor NOT FOUND"); return ptr(0); }
    var strPtr = makeS(root || "");
    var r = invokeOk(ctorMi, o, [strPtr]);
    if (r.ok) { return o; }
    // 回退: 直接调 methodPointer (纯 .NET 1 参, ABI: x0=this, x1=string)
    try {
        var mp = ctorMi.readPointer();
        console.log("[v3] LRP ctor runtime_invoke 失败, 尝试直调 methodPointer=" + mp + " invoker槽=" + ctorMi.add(0x10).readPointer());
        var mpFn = new NativeFunction(mp, 'void', ['pointer', 'pointer']);
        mpFn(o, strPtr);
        console.log("[v3] LRP ctor 直调成功");
        return o;
    } catch (e) {
        console.log("[v3] LRP ctor 直调也失败: " + e);
        return ptr(0);
    }
}

// ============ 服务查找 ============
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

// ============ 初始化 ============
(function () {
    var attempts = 0;
    function doInit() {
        attempts++;
        var ga = Process.findModuleByName("GameAssembly.dylib");
        if (!ga) return false;
        Thread.sleep(0.3);
        console.log("[v3] GameAssembly base=" + ga.base);
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
        A.ots = E.il2cpp_object_to_string ? new NativeFunction(E.il2cpp_object_to_string, 'pointer', ['pointer']) : null;
        A.cgnt = new NativeFunction(E.il2cpp_class_get_nested_types, 'pointer', ['pointer', 'pointer']);
        A.vb = E.il2cpp_value_box ? new NativeFunction(E.il2cpp_value_box, 'pointer', ['pointer', 'pointer']) : null;
        A.cgt = E.il2cpp_class_get_type ? new NativeFunction(E.il2cpp_class_get_type, 'pointer', ['pointer']) : null;
        A.cft = E.il2cpp_class_from_type ? new NativeFunction(E.il2cpp_class_from_type, 'pointer', ['pointer']) : null;
        A.tgo = E.il2cpp_type_get_object ? new NativeFunction(E.il2cpp_type_get_object, 'pointer', ['pointer']) : null;
        if (!A.cgt || !A.cft || !A.tgo) console.log("[v3] !! 类型 API 缺失 (cgt/cft/tgo), converters 填充将失败");

        dom = A.dg();
        var t = A.ta(dom);
        console.log("[v3] 线程已 attach: " + t);

        var cp = Memory.alloc(8);
        var asms = A.dga(dom, cp); var cnt = cp.readPointer().toInt32();
        allImgs = [];
        for (var i = 0; i < cnt; i++) {
            var a = asms.add(i * 8).readPointer(); var img = A.agi(a); var nm = A.ign(img).readCString();
            allImgs.push(img);
            if (nm.indexOf("Naninovel.Runtime") >= 0) nv = img;
            else if (nm.indexOf("Assembly-CSharp") >= 0) cs = img;
            else if (nm.indexOf("GigaCreation") >= 0) giga = img;
        }
        console.log("[v3] nv=" + nv + " cs=" + cs + " giga=" + giga + " images=" + cnt);

        // 动态解析 GotoModified (GigaCreation.NaninovelExtender.Common)
        gotoModifiedCls = findClassAcrossImages("GigaCreation.NaninovelExtender.Common", "GotoModified");
        if (gotoModifiedCls.isNull()) {
            console.log("[v3] GotoModified NOT FOUND, 试无命名空间/其他 image...");
            for (var i = 0; i < allImgs.length && gotoModifiedCls.isNull(); i++) {
                gotoModifiedCls = A.cfn(allImgs[i], Memory.allocUtf8String("GigaCreation.NaninovelExtender.Common"), Memory.allocUtf8String("GotoModified"));
            }
        }
        if (gotoModifiedCls.isNull()) { console.log("[v3] !! GotoModified 完全找不到, 跳过 goto 相关逻辑"); }
        else console.log("[v3] GotoModified class = " + gotoModifiedCls);

        // 动态解析 LoadAndPlay 并 hook (诊断用)
        if (gotoModifiedCls && !gotoModifiedCls.isNull()) {
            try {
                var lapMi = A.cgm(gotoModifiedCls, Memory.allocUtf8String("LoadAndPlay"), 2);
                if (lapMi && !lapMi.isNull()) {
                    var lapPtr = lapMi.readPointer(); // methodPointer +0x00
                    console.log("[v3] LoadAndPlay methodPointer = " + lapPtr);
                    Interceptor.attach(lapPtr, {
                        onEnter: function (args) {
                            if (!shouldLogLoadAndPlay) return;
                            var path = readStr(args[1]);
                            var label = readStr(args[2]);
                            console.log("[v3] >>> LoadAndPlay path='" + path + "' label='" + (label || "") + "'");
                        }
                    });
                    console.log("[v3] LoadAndPlay hooked (dynamic)");
                } else {
                    console.log("[v3] LoadAndPlay(2) NOT FOUND");
                }
            } catch (e) { console.log("[v3] LoadAndPlay hook err: " + e); }
        }

        // ===== 诊断: 完整 goto 链路 hook =====
        try {
            // TGSP (Goto.TryGetScriptPathAndLabel) — 解析出的实际路径
            var gotoCls = A.cfn(nv, Memory.allocUtf8String("Naninovel.Commands"), Memory.allocUtf8String("Goto"));
            if (gotoCls && !gotoCls.isNull()) {
                var tgspMi = A.cgm(gotoCls, Memory.allocUtf8String("TryGetScriptPathAndLabel"), 2);
                if (tgspMi && !tgspMi.isNull()) {
                    Interceptor.attach(tgspMi.readPointer(), {
                        onEnter: function (a) { this.p1 = a[1]; this.p2 = a[2]; },
                        onLeave: function (ret) {
                            var p = this.p1 ? readStr(this.p1.readPointer()) : null;
                            var l = this.p2 ? readStr(this.p2.readPointer()) : null;
                            console.log("[v3] TGSP -> path='" + p + "' label='" + (l || "") + "' ret=" + ret);
                        }
                    });
                    console.log("[v3] TGSP hooked");
                }
            }
            // ScriptPlayerExtensions.LoadAndPlay (标准版, 静态)
            var speCls = A.cfn(nv, Memory.allocUtf8String("Naninovel"), Memory.allocUtf8String("ScriptPlayerExtensions"));
            if (speCls && !speCls.isNull()) {
                var spleMi = A.cgm(speCls, Memory.allocUtf8String("LoadAndPlay"), 3);
                if (spleMi && !spleMi.isNull()) {
                    Interceptor.attach(spleMi.readPointer(), { onEnter: function (a) {
                        console.log("[v3] SPE.LoadAndPlay path='" + readStr(a[1]) + "'");
                    }});
                    console.log("[v3] SPE.LoadAndPlay hooked");
                }
            }
            // GotoModified.NavigateOtherScript + Execute + 局部函数
            if (gotoModifiedCls && !gotoModifiedCls.isNull()) {
                var navMi = A.cgm(gotoModifiedCls, Memory.allocUtf8String("NavigateOtherScript"), 2);
                if (navMi && !navMi.isNull()) {
                    var navPtr = navMi.readPointer();
                    console.log("[v3] NavigateOtherScript addr=" + navPtr);
                    Interceptor.attach(navPtr, { onEnter: function (a) {
                        console.log("[v3] NavigateOtherScript path='" + readStr(a[1]) + "' label='" + (readStr(a[2]) || "") + "'");
                    }});
                    console.log("[v3] NavigateOtherScript hooked");
                }
                var execMi = A.cgm(gotoModifiedCls, Memory.allocUtf8String("Execute"), 1);
                if (execMi && !execMi.isNull()) {
                    console.log("[v3] Execute addr=" + execMi.readPointer());
                    Interceptor.attach(execMi.readPointer(), { onEnter: function () {
                        console.log("[v3] GotoModified.Execute 触发");
                    }});
                    console.log("[v3] Execute hooked");
                }
                // 局部函数 (真正干活的?)
                var lfMi = A.cgm(gotoModifiedCls, Memory.allocUtf8String("<NavigateOtherScript>g__LoadAndPlay|0"), 0);
                if (lfMi && !lfMi.isNull()) {
                    console.log("[v3] g__LoadAndPlay|0 addr=" + lfMi.readPointer());
                    Interceptor.attach(lfMi.readPointer(), { onEnter: function () {
                        console.log("[v3] >>> 局部函数 g__LoadAndPlay|0 触发");
                    }});
                    console.log("[v3] g__LoadAndPlay|0 hooked");
                } else {
                    console.log("[v3] 局部函数 g__LoadAndPlay|0 未找到");
                }
                // 嵌套状态机 <NavigateOtherScript>d__2 的 MoveNext (API: 每次返回一个指针, iter 推进)
                try {
                    var iter = Memory.alloc(8); iter.writePointer(ptr(0));
                    var foundSm = false;
                    for (;;) {
                        var p = A.cgnt(gotoModifiedCls, iter);
                        if (!p || p.isNull()) break;
                        var nc = p.readPointer();
                        if (!nc || nc.isNull()) break;
                        var nn = A.cgn(nc).readCString();
                        console.log("[v3] 嵌套类型: " + nn);
                        if (nn && (nn.indexOf("NavigateOtherScript") >= 0 || nn.indexOf("d__2") >= 0)) {
                            var mn2 = A.cgm(nc, Memory.allocUtf8String("MoveNext"), 0);
                            if (mn2 && !mn2.isNull()) {
                                var mnPtr = mn2.readPointer();
                                console.log("[v3] 状态机 " + nn + " MoveNext addr=" + mnPtr);
                                Interceptor.attach(mnPtr, {
                                    onEnter: function () { console.log("[v3] >>> NavigateOtherScript.MoveNext 触发"); }
                                });
                                console.log("[v3] MoveNext hooked");
                                foundSm = true;
                            }
                        }
                    }
                    if (!foundSm) console.log("[v3] 未找到 NavigateOtherScript 状态机");
                } catch (e) { console.log("[v3] 状态机查找 err: " + e); }
                // System.Exception.ToString() — NRE 的完整堆栈
                try {
                    var coreImg = null;
                    for (var ci = 0; ci < allImgs.length; ci++) {
                        var inm2 = A.ign(allImgs[ci]).readCString();
                        if (inm2.indexOf("mscorlib") >= 0 || inm2.indexOf("CoreLib") >= 0 || inm2.indexOf("System.Runtime") >= 0) { coreImg = allImgs[ci]; break; }
                    }
                    if (coreImg) {
                        var excCls = A.cfn(coreImg, Memory.allocUtf8String("System"), Memory.allocUtf8String("Exception"));
                        if (excCls && !excCls.isNull()) {
                            var tsMi = A.cgm(excCls, Memory.allocUtf8String("ToString"), 0);
                            if (tsMi && !tsMi.isNull()) {
                                Interceptor.attach(tsMi.readPointer(), {
                                    onEnter: function (a) {
                                        this.exc = a[0];
                                        try {
                                            var cn0 = a[0] ? readStr(a[0].add(0x10).readPointer()) : null;
                                            if (cn0 && cn0.indexOf("NullReference") >= 0) {
                                                var ga2 = Process.findModuleByName("GameAssembly.dylib");
                                                var bt = null;
                                                try { bt = Thread.backtrace(this.context, Backtracer.ACCURATE); }
                                                catch (e2) {
                                                    console.log("[v3] bt ACCURATE err: " + e2);
                                                    try { bt = Thread.backtrace(this.context, Backtracer.FUZZY); }
                                                    catch (e3) { console.log("[v3] bt FUZZY err: " + e3); }
                                                }
                                                if (bt) {
                                                    var rvas = [];
                                                    for (var bi = 0; bi < Math.min(16, bt.length); bi++) {
                                                        try { rvas.push("0x" + bt[bi].sub(ga2.base).toString(16)); }
                                                        catch (e4) { rvas.push("?"); }
                                                    }
                                                    console.log("[v3] ****** NRE 原生栈: " + rvas.join(" "));
                                                } else {
                                                    console.log("[v3] ****** NRE bt null");
                                                }
                                            }
                                        } catch (e) { console.log("[v3] ToString onEnter err: " + e); }
                                    },
                                    onLeave: function () {
                                        if (!this.exc || this.exc.isNull()) return;
                                        var cn = readStr(this.exc.add(0x10).readPointer());
                                        if (cn && cn.indexOf("NullReference") >= 0) {
                                            var msg = readStr(this.exc.add(0x18).readPointer());
                                            var st = readStr(this.exc.add(0x40).readPointer());
                                            console.log("[v3] ****** NRE: " + cn + (msg ? " | " + msg : ""));
                                            console.log("[v3] ****** 堆栈: " + (st || "<无>"));
                                        }
                                    }
                                });
                                console.log("[v3] Exception.ToString hooked (coreImg=" + coreImg + ")");
                            }
                        }
                    }
                } catch (e) { console.log("[v3] Exception hook err: " + e); }
                // AsyncUniTaskMethodBuilder.SetException — 原生栈定位抛异常处
                try {
                    var utImg = null;
                    for (var ui = 0; ui < allImgs.length; ui++) {
                        var unin = A.ign(allImgs[ui]).readCString();
                        if (unin.indexOf("UniTask") >= 0) { utImg = allImgs[ui]; break; }
                    }
                    if (utImg) {
                        var builderCls = A.cfn(utImg, Memory.allocUtf8String("Cysharp.Threading.Tasks.CompilerServices"), Memory.allocUtf8String("AsyncUniTaskMethodBuilder"));
                        if (builderCls && !builderCls.isNull()) {
                            var setExcMi = A.cgm(builderCls, Memory.allocUtf8String("SetException"), 1);
                            if (setExcMi && !setExcMi.isNull()) {
                                console.log("[v3] AsyncUniTaskMethodBuilder.SetException addr=" + setExcMi.readPointer());
                                Interceptor.attach(setExcMi.readPointer(), {
                                    onEnter: function () {
                                        try {
                                            var ga2 = Process.findModuleByName("GameAssembly.dylib");
                                            var bt = Thread.backtrace(this.context, Backtracer.ACCURATE);
                                            var rvas = [];
                                            for (var bi = 0; bi < Math.min(14, bt.length); bi++) {
                                                var r = bt[bi].sub(ga2.base);
                                                rvas.push("0x" + r.toString(16));
                                            }
                                            console.log("[v3] #### SetException 原生栈: " + rvas.join(" "));
                                        } catch (e) { console.log("[v3] backtrace err: " + e); }
                                    }
                                });
                                console.log("[v3] SetException hooked");
                            } else {
                                console.log("[v3] SetException NOT FOUND");
                            }
                        }
                    }
                } catch (e) { console.log("[v3] UniTask hook err: " + e); }
            }
            // ScriptLoader 服务的加载入口
            var slCls = A.cfn(nv, Memory.allocUtf8String("Naninovel"), Memory.allocUtf8String("ScriptLoader"));
            if (slCls && !slCls.isNull()) {
                var loadMi2 = A.cgm(slCls, Memory.allocUtf8String("Load"), 2);
                if (loadMi2 && !loadMi2.isNull()) {
                    console.log("[v3] ScriptLoader.Load addr=" + loadMi2.readPointer());
                    Interceptor.attach(loadMi2.readPointer(), { onEnter: function (a) {
                        console.log("[v3] >>> ScriptLoader.Load path='" + readStr(a[1]) + "' startIndex=" + a[2].toInt32());
                    }});
                    console.log("[v3] ScriptLoader.Load hooked");
                }
                var ilMi = A.cgm(slCls, Memory.allocUtf8String("IsLoaded"), 1);
                if (ilMi && !ilMi.isNull()) {
                    Interceptor.attach(ilMi.readPointer(), { onEnter: function (a) {
                        console.log("[v3] ScriptLoader.IsLoaded path='" + readStr(a[1]) + "'");
                    }});
                    console.log("[v3] ScriptLoader.IsLoaded hooked");
                }
                // ResourceLoader<T>.GetLoaded(string) — 缓存直接命中 (ScriptLoader 继承自 ResourceLoader<Script>)
                var glMi = A.cgm(slCls, Memory.allocUtf8String("GetLoaded"), 1);
                if (glMi && !glMi.isNull()) {
                    console.log("[v3] ResourceLoader.GetLoaded addr=" + glMi.readPointer());
                    Interceptor.attach(glMi.readPointer(), { onEnter: function (a) {
                        console.log("[v3] >>> GetLoaded path='" + readStr(a[1]) + "'");
                    }});
                    console.log("[v3] GetLoaded hooked");
                } else {
                    console.log("[v3] GetLoaded NOT FOUND");
                }
            }
        } catch (e) { console.log("[v3] 诊断 hook 失败: " + e); }

        // ===== 捕获 Unity 错误日志 =====
        function dumpObj(obj, tag) {
            if (!obj || obj.isNull()) { console.log("[v3] " + tag + ": <null>"); return; }
            try {
                var cls = A.ogc(obj);
                var cn = cls ? A.cgn(cls).readCString() : "?";
                console.log("[v3] " + tag + " obj=" + obj + " class=" + cn);
                // hexdump 前 48 字节
                var hex = "";
                for (var i = 0; i < 48; i++) {
                    hex += obj.add(i).readU8().toString(16).padStart(2, "0") + (i % 16 === 15 ? " " : "");
                }
                console.log("[v3] " + tag + " hex: " + hex);
                // 从 +0x14 走 UTF-16 到 null, 取完整字符串 (忽略可疑长度字段)
                try {
                    var full = "";
                    for (var fi = 0; fi < 300; fi++) {
                        var c = obj.add(0x14 + fi * 2).readU16();
                        if (c === 0) break;
                        full += String.fromCharCode(c);
                    }
                    if (full) console.log("[v3] " + tag + " FULL: " + full);
                } catch (e) {}
                // 从多个起点走 UTF-16 到 null
                [0x08, 0x10, 0x14, 0x18, 0x0C].forEach(function (so) {
                    try {
                        var s = "";
                        for (var j = 0; j < 200; j++) {
                            var c = obj.add(so + j * 2).readU16();
                            if (c === 0) { console.log("[v3] " + tag + " +0x" + so.toString(16) + " utf16='" + s + "'"); return; }
                            s += String.fromCharCode(c);
                        }
                    } catch (e) {}
                });
            } catch (e3) { console.log("[v3] " + tag + " dump err: " + e3); }
        }
        try {
            var ueImg = null;
            for (var i = 0; i < allImgs.length; i++) {
                var inm = A.ign(allImgs[i]).readCString();
                if (inm.indexOf("UnityEngine.CoreModule") >= 0) { ueImg = allImgs[i]; break; }
            }
            if (ueImg) {
                var dbgCls = A.cfn(ueImg, Memory.allocUtf8String("UnityEngine"), Memory.allocUtf8String("Debug"));
                if (dbgCls && !dbgCls.isNull()) {
                    ["LogError", "LogException", "Log", "LogWarning"].forEach(function (mn) {
                        for (var ac = 1; ac <= 2; ac++) {
                            var m = A.cgm(dbgCls, Memory.allocUtf8String(mn), ac);
                            if (m && !m.isNull()) {
                                (function (mn2, ac2) {
                                    Interceptor.attach(m.readPointer(), {
                                        onEnter: function (a) {
                                            // Debug.LogError 等是静态方法 → 第一个参数在 a[0]
                                            dumpObj(a[0], "Unity." + mn2 + "(" + ac2 + ")");
                                        }
                                    });
                                })(mn, ac);
                            }
                        }
                    });
                    console.log("[v3] Unity Debug hooks 完成");
                } else {
                    console.log("[v3] UnityEngine.Debug class NOT FOUND");
                }
            } else {
                console.log("[v3] UnityEngine.CoreModule image NOT FOUND");
            }
        } catch (e) { console.log("[v3] Debug hook err: " + e); }

        // Hook TitleUi.Activate → 重定向 + 注册菜单
        var tc = A.cfn(cs, Memory.allocUtf8String("WitchTrials.Views"), Memory.allocUtf8String("TitleUi"));
        if (tc && !tc.isNull()) {
            var actMi = A.cgm(tc, Memory.allocUtf8String("Activate"), 0);
            if (actMi && !actMi.isNull()) {
                Interceptor.attach(actMi.readPointer(), {
                    onEnter: function () {},
                    onLeave: function () {
                        console.log("[v3] TitleUi.Activate 触发");
                        if (typeof modList !== "undefined" && modList && modList.length) registerMenu(modList);
                        else registerMenu([]);
                        registerMenuText();
                        // provider 管线: 为每个 mod 注入 LRP + converters + ProvisionSource
                        try {
                            var root = (typeof MOD_ROOT !== "undefined") ? MOD_ROOT : "";
                            if (typeof modList !== "undefined" && modList && modList.length) {
                                for (var mi = 0; mi < modList.length; mi++) {
                                    console.log("[v3] ==== 为 mod '" + modList[mi].key + "' 注入 provider ====");
                                    addModLoader(root, modList[mi].key);
                                }
                            }
                        } catch (e2) { console.log("[v3] addModLoader 循环 err: " + e2); }
                        // 重定向放到队列, 避免在 hook 回调里做托管调用
                        setTimeout(function () { hookStartGame(); }, 100);
                    }
                });
                console.log("[v3] TitleUi.Activate hooked");
            }
        }

        return true;
    }

    var chk = setInterval(function () {
        try { var ok = doInit(); if (ok) { clearInterval(chk); console.log("[v3] 全部就绪"); } }
        catch (e) { console.log("[v3] ERR: " + e); }
    }, 200);
})();
