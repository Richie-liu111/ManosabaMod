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

// ============ Movie 支持 (URL 流式, 镜像 Windows ModMovieLoader) ============
// run_mod.sh 注入 movieMap = { 视频名: 绝对路径 }
// 原理: @movie 命令是 IPreloadable, 剧本加载时 ScriptPlaylist.LoadResources
//   → PlayMovie.PreloadResources → MoviePlayer.HoldResources(name) → get_UrlStreaming。
//   get_UrlStreaming 默认 false → 走 videoLoader 加载 VideoClip → 无 provider 即失败,
//   导致整个 goto 中止 (黑屏)。修法: 对 mod 视频强制 UrlStreaming=true (跳过 VideoClip),
//   BuildStreamUrl 返回本地绝对路径, VideoPlayer 直接播放文件。
var modMovies = (typeof movieMap !== "undefined" && movieMap) ? movieMap : {};
var pendingMovieName = null;
var playingMovieName = null;
var movieHooksReady = false;
function isModMovie(nm) { return !!nm && !!modMovies[nm]; }
function setupMovieHooks() {
    try {
        if (movieHooksReady) return;
        if (Object.keys(modMovies).length === 0) { console.log("[v3] setupMovieHooks: 无 mod 视频, 跳过"); return; }
        var mpCls = findClassAcrossImages("Naninovel", "MoviePlayer");
        if (!mpCls || mpCls.isNull()) { console.log("[v3] setupMovieHooks: MoviePlayer 类未找到"); return; }
        var urlMi = A.cgm(mpCls, Memory.allocUtf8String("get_UrlStreaming"), 0);
        var buildMi = A.cgm(mpCls, Memory.allocUtf8String("BuildStreamUrl"), 1);
        var holdMi = A.cgm(mpCls, Memory.allocUtf8String("HoldResources"), 2);
        if (!urlMi || urlMi.isNull() || !buildMi || buildMi.isNull() || !holdMi || holdMi.isNull()) {
            console.log("[v3] setupMovieHooks: 方法未找到 (get_UrlStreaming/BuildStreamUrl/HoldResources)"); return;
        }
        var pnField = A.gf(mpCls, Memory.allocUtf8String("playedMovieName"));
        var pnOff = (pnField && !pnField.isNull()) ? A.fo(pnField) : 0x68;

        // 播放阶段: Play(name) 入口捕获名字 (get_UrlStreaming 在 Play 内被调用)
        var playMi = A.cgm(mpCls, Memory.allocUtf8String("Play"), 2);
        if (playMi && !playMi.isNull()) {
            Interceptor.attach(playMi.readPointer(), {
                onEnter: function (a) {
                    try {
                        playingMovieName = null;
                        var nm = readStr(a[1]);
                        console.log("[v3] Movie Play: '" + nm + "' mod=" + isModMovie(nm));
                        if (isModMovie(nm)) playingMovieName = nm;
                    } catch (e) {}
                }
            });
        }
        // 预加载阶段: HoldResources(name) 入口捕获名字 → get_UrlStreaming 消费
        Interceptor.attach(holdMi.readPointer(), {
            onEnter: function (a) {
                try {
                    pendingMovieName = null;
                    var nm = readStr(a[1]);
                    if (isModMovie(nm)) pendingMovieName = nm;
                } catch (e) {}
            }
        });
        // 流式判定: mod 视频强制 true (跳过 VideoClip 加载, 预加载不再失败)
        Interceptor.attach(urlMi.readPointer(), {
            onEnter: function () { this._self = this.context.x0; },
            onLeave: function (ret) {
                try {
                    if (ret && !ret.isNull() && ret.toInt32() === 1) return;
                    if (pendingMovieName) { // 预加载阶段
                        var p = modMovies[pendingMovieName];
                        pendingMovieName = null;
                        if (p) { ret.replace(ptr(1)); console.log("[v3] Movie preload override: 流式跳过 VideoClip '" + p + "'"); }
                        return;
                    }
                    if (playingMovieName && isModMovie(playingMovieName)) { // 播放阶段 (Play 入口已捕获)
                        ret.replace(ptr(1)); return;
                    }
                    // 兜底: 读 playedMovieName 字段
                    var cur = readStr(this._self.add(pnOff));
                    if (isModMovie(cur)) ret.replace(ptr(1));
                } catch (e) {}
            }
        });
        // BuildStreamUrl: mod 视频 → 本地绝对路径 (VideoPlayer 认绝对路径)
        Interceptor.attach(buildMi.readPointer(), {
            onEnter: function (a) { this._nm = readStr(a[1]); },
            onLeave: function (ret) {
                try {
                    var p = modMovies[this._nm];
                    if (p) { ret.replace(makeS(p)); console.log("[v3] Movie URL -> " + p); }
                } catch (e) {}
            }
        });
        movieHooksReady = true;
        console.log("[v3] Movie hooks 就绪, mod 视频数=" + Object.keys(modMovies).length);
    } catch (e) { console.log("[v3] setupMovieHooks err: " + e); }
}

// ============ WitchBook 线索支持 (镜像 Windows ModClueLoader + ModWitchBookPatch + ModTextureHelper) ============
// 链路: @update 命令 → IWitchBookUi.UpdateVersion → WitchBookScreen.UpdateVersion → CluePage.UpdateVersion
//   → _state.SetVersion。原版对 _itemIds 之外的 id 不处理, 且 _loadedDataItemMap/_localizedTextData
//   无 mod 数据 → UI 不显示, RefreshPageContent 查 _localizedTextData 还会 KeyNotFoundException。
// 修法 (与 Windows 一致的三板斧):
//   1. 数据注入: 拦截 @update + WitchBook 打开(BeginToPresent/InitializePages) →
//      向 ClueData._items 和 CluePage._loadedDataItemMap 注入 VersionedItem, 向 _itemIds 追加 ID,
//      _state.SetVersion 设状态 (幂等, 按实例指针追踪)。
//   2. 纹理: 加载 WitchBook/Clues/<Id>.png → Texture2D → 注册进 AddressablesManager._loadedAssets,
//      原版 Addressables 加载 (缩略图 + @spawn ClueItem) 直接命中。
//   3. 显示: Interceptor.replace CluePage.RefreshPageContent / SetupItemButton —— mod 线索直接设
//      _subjectLabel/_descriptionLabel/_thumbnail (绕开 _localizedTextData 的 KeyNotFoundException)。
// 数据来源: 运行时读 <MOD_ROOT>/<modKey>/info.json 的 Clues 字段 + 扫 WitchBook/Clues/*.png。
var wbData = { clues: {}, states: {}, addressToId: {}, pendingStates: {}, texCache: {}, texPaths: {} };
var wbCurrentMod = null;   // 当前激活的 mod key (经 ScriptLoader.Load 匹配 Enter 得到; null=未知, __vanilla__=原版)
var wbPrevMod = null;      // 上次注入时的 mod key (用于切换检测)
// 当前 mod 的线索 id 列表 (无 mod 时不注入)
function currentModClueIds() {
    if (!wbCurrentMod || wbCurrentMod === "__vanilla__") return [];
    var out = [], keys = Object.keys(wbData.clues);
    for (var i = 0; i < keys.length; i++) if (wbData.clues[keys[i]].key === wbCurrentMod) out.push(keys[i]);
    return out;
}
function isCurrentModClue(id) { return !!wbCurrentMod && wbData.clues[id] && wbData.clues[id].key === wbCurrentMod; }
// 从 ScriptLoader.Load 的路径识别当前 mod (匹配 modList 的 Enter; 原版默认路径 → __vanilla__)
// mod 变化时立即清理上一 mod 的残留 (页面若存在) 并注入当前 mod 目录
function detectCurrentMod(path) {
    if (!path) return;
    var next = null;
    if (typeof modList !== "undefined" && modList) {
        for (var i = 0; i < modList.length; i++) {
            if (path === modList[i].Enter) { next = modList[i].key; break; }
        }
    }
    if (!next && path === "Act01_Chapter01/Act01_Chapter01_Adv01") next = "__vanilla__";
    if (next === null || next === wbCurrentMod) return;
    wbCurrentMod = next;
    wblog("当前 mod: '" + wbCurrentMod + "' (Enter=" + path + ")");
    try { if (wbCls && wbCls.cluePage && !wbCls.cluePage.isNull()) tryInjectWitchBook(); } catch (e) {}
}
function resetWitchBookSession() {
    wbCurrentMod = null; wbPrevMod = null;
    wbData.states = {}; wbData.pendingStates = {}; wbData.texCache = {};
    wbInjectedClueData = {}; wbInjectedPages = {};
    // 若页面仍存活, 直接清掉其中已注入的 mod 线索 (防止残留继承)
    try {
        if (wbCls && wbCls.cluePage && !wbCls.cluePage.isNull()) {
            var allIds = Object.keys(wbData.clues);
            if (allIds.length) {
                var idSet = {};
                allIds.forEach(function (id) { idSet[id] = 1; });
                var pages = findAllObjectOfType(wbCls.cluePage);
                if (pages.length) {
                    clearBookViaVanilla();
                    clearModCluesFromPage(pages[0], idSet);
                    clearAllWitchBookPages();
                }
            }
        }
    } catch (e) {}
    wblog("会话重置 (回标题)");
}
var wbCls = null;          // 解析好的类表
var wbReady = false;
var wbInjectedClueData = {};  // ClueData 实例 ptr -> true (幂等)
var wbInjectedPages = {};     // CluePage 实例 ptr -> true
var wbRpc = null;             // 原版 RefreshPageContent 函数指针 (replace 前保存)
var wbSib = null;             // 原版 SetupItemButton 函数指针

function wblog(msg) { console.log("[v3][WitchBook] " + msg); }
// ===== 原生文件 I/O (Frida 运行时无 File/readFileSync, 用 libc open/read/lseek) =====
var ioApi = null;
function getIO() {
    if (ioApi) return ioApi;
    var mk = function (name, ret, args) {
        var a = Module.findGlobalExportByName(name);
        return a ? new NativeFunction(a, ret, args) : null;
    };
    ioApi = {
        open:   mk("open", 'int', ['pointer', 'int']),
        close:  mk("close", 'int', ['int']),
        read:   mk("read", 'int', ['int', 'pointer', 'uint']),
        lseek:  mk("lseek", 'long', ['int', 'long', 'int']),
        access: mk("access", 'int', ['pointer', 'int'])
    };
    return ioApi;
}
function fileReadString(path) {
    try {
        var io = getIO();
        if (!io.open) return null;
        var fd = io.open(Memory.allocUtf8String(path), 0);
        if (fd < 0) return null;
        var size = io.lseek(fd, 0, 2);
        io.lseek(fd, 0, 0);
        var buf = Memory.alloc(size > 0 ? size : 1);
        var got = 0, r = 0;
        while (got < size) {
            r = io.read(fd, buf.add(got), size - got);
            if (r <= 0) break;
            got += r;
        }
        io.close(fd);
        return buf.readUtf8String(got);
    } catch (e) { return null; }
}
function fileReadBytes(path) {
    try {
        var io = getIO();
        if (!io.open) return null;
        var fd = io.open(Memory.allocUtf8String(path), 0);
        if (fd < 0) return null;
        var size = io.lseek(fd, 0, 2);
        io.lseek(fd, 0, 0);
        var buf = Memory.alloc(size > 0 ? size : 1);
        var got = 0, r = 0;
        while (got < size) {
            r = io.read(fd, buf.add(got), size - got);
            if (r <= 0) break;
            got += r;
        }
        io.close(fd);
        return { buf: buf, size: got };
    } catch (e) { return null; }
}
function fileExists(path) {
    try { var io = getIO(); return !!io.access && io.access(Memory.allocUtf8String(path), 0) === 0; } catch (e) { return false; }
}
function readJSONFile(path) {
    try {
        var s = fileReadString(path);
        if (s === null) { wblog("readJSONFile 读取失败 '" + path + "'"); return null; }
        return JSON.parse(s);
    } catch (e) { wblog("readJSONFile 解析失败 '" + path + "': " + e); return null; }
}
// 加载所有 mod 的 Clues 数据 (info.json) + 纹理路径
function loadWitchBookData() {
    if (wbReady || typeof modList === "undefined" || !modList) return;
    var root = (typeof MOD_ROOT !== "undefined") ? MOD_ROOT : "";
    wblog("MOD_ROOT=" + root + ", modList=" + modList.length + " 个");
    for (var mi = 0; mi < modList.length; mi++) {
        var key = modList[mi].key;
        var ip = root + "/" + key + "/info.json";
        var info = readJSONFile(ip);
        if (!info) { wblog("  " + key + ": info.json 读取/解析失败"); continue; }
        if (!info.Clues) { wblog("  " + key + ": 无 Clues 字段"); continue; }
        var clueDir = root + "/" + key + "/WitchBook/Clues";
        for (var c = 0; c < info.Clues.length; c++) {
            var grp = info.Clues[c];
            if (!grp.Id || !grp.Items || !grp.Items.length) continue;
            if (wbData.clues[grp.Id]) { wblog("重复线索 ID '" + grp.Id + "' 跳过 (首个 mod 优先)"); continue; }
            var rec = { key: key, versions: {}, path: null };
            for (var v = 0; v < grp.Items.length; v++) {
                var it = grp.Items[v];
                rec.versions[String(it.Version)] = { name: it.Name || {}, desc: it.Description || {} };
            }
            var tp = clueDir + "/" + grp.Id + ".png";
            try { if (fileExists(tp)) rec.path = tp; } catch (e) {}
            if (!rec.path) { try { var tp2 = clueDir + "/" + grp.Id + ".jpg"; if (fileExists(tp2)) rec.path = tp2; } catch (e) {} }
            wbData.clues[grp.Id] = rec;
            if (rec.path) wbData.texPaths[grp.Id] = rec.path;
            wbData.addressToId[buildClueTextureAddress(grp.Id)] = grp.Id;
        }
    }
    wbReady = true;
    wblog("数据加载: " + Object.keys(wbData.clues).length + " 条线索, " + Object.keys(wbData.texPaths).length + " 张图片");
}
// 镜像 WitchBookDataHelper.BuildClueTextureAddress: '1-1' → General/WitchBook/Clue_..._001
function buildClueTextureAddress(id) {
    var parts = id.split("-"), out = "General/WitchBook/Clue";
    for (var i = 0; i < parts.length; i++) {
        var p = parts[i]; while (p.length < 3) p = "0" + p;
        out += "_" + p;
    }
    return out;
}
function localeValue(tag) { // ja=0 en-US=1 zh-Hans=2 zh-Hant=3 ko=4 fr=5 es=6
    switch (tag) {
        case "ja": return 0; case "en-US": return 1; case "zh-Hans": return 2;
        case "zh-Hant": return 3; case "ko": return 4; case "fr": return 5; case "es": return 6;
    } return 2;
}
function resolveLocale(locObj, tag) { return locObj && locObj[tag] ? locObj[tag] : ""; }
// 找 System 类型 (mscorlib 等)
function getSystemClass(name) {
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
function findNestedClass(parentCls, name) {
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
function fieldOffset(cls, name, fallback) {
    try {
        var f = A.gf(cls, Memory.allocUtf8String(name));
        if (f && !f.isNull()) return A.fo(f);
    } catch (e) {}
    return fallback;
}
// Object.FindObjectsOfType(Type) → Object[] → 非空实例数组
function findAllObjectOfType(cls) {
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
function findFirstObjectOfType(cls) { var a = findAllObjectOfType(cls); return a.length ? a[0] : null; }
// List<T> 里是否已有 id。List 布局: _items(T[])@+0x10, _size(int)@+0x18, _version@+0x1C
// 数组元素在 arr+0x20 (SZARRAY 数据区)
function listContainsId(list, id, idOff) {
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
// 构建 LocalizedText[] (每个语言一条)
function buildLocalizedTextArray(locObj) {
    try {
        if (!locObj) locObj = {};
        var tags = Object.keys(locObj);
        if (!tags.length) { locObj = { "zh-Hans": "" }; tags = ["zh-Hans"]; }
        var arr = A.an(wbCls.localizedText, tags.length);
        if (!arr || arr.isNull()) { wblog("LocalizedText[] 创建失败"); return ptr(0); }
        var ctorMi = A.cgm(wbCls.localizedText, Memory.allocUtf8String(".ctor"), 2);
        for (var i = 0; i < tags.length; i++) {
            var lt = A.on(wbCls.localizedText);
            var lv = Memory.alloc(4); lv.writeS32(localeValue(tags[i]));
            var text = (locObj[tags[i]] || "");
            if (ctorMi && !ctorMi.isNull()) invokeOk(ctorMi, lt, [lv, makeS(text)]);
            arr.add(0x20 + i * Process.pointerSize).writePointer(lt);
        }
        return arr;
    } catch (e) { wblog("buildLocalizedTextArray err: " + e); return ptr(0); }
}
// 构建 IdVersionPair (作为 _localizedTextData 的键, 与 VersionedItem._idVersionPair 同一实例)
function makeIdVersionPair(id, ver) {
    var ivp = A.on(wbCls.idVersionPair);
    var ctorMi = A.cgm(wbCls.idVersionPair, Memory.allocUtf8String(".ctor"), 2);
    var vbuf = Memory.alloc(4); vbuf.writeS32(ver);
    if (ctorMi && !ctorMi.isNull()) invokeOk(ctorMi, ivp, [makeS(id), vbuf]);
    return ivp;
}
function unionLocaleKeys(a, b) {
    var seen = {};
    (a ? Object.keys(a) : []).concat(b ? Object.keys(b) : []).forEach(function (k) { seen[k] = 1; });
    return Object.keys(seen);
}
// 构建 VersionedItem<ClueDataItem> (直接 object_new + 写字段, 绕开泛型 ctor)
// 返回 { vi, ivp }; ivp 用于 _localizedTextData 键匹配 (get_IdVersionPair 缓存命中)
function buildVersionedItem(vItemCls, id, ver, rec) {
    try {
        var vrec = rec.versions[String(ver)];
        if (!vrec) vrec = rec.versions[Object.keys(rec.versions)[0]];
        var nameArr = buildLocalizedTextArray(vrec.name);
        var descArr = buildLocalizedTextArray(vrec.desc);
        var item = A.on(wbCls.clueDataItem);
        var ctorMi = A.cgm(wbCls.clueDataItem, Memory.allocUtf8String(".ctor"), 2);
        if (ctorMi && !ctorMi.isNull()) invokeOk(ctorMi, item, [nameArr, descArr]);
        else {
            item.add(fieldOffset(wbCls.clueDataItem, "_name", 0x10)).writePointer(nameArr);
            item.add(fieldOffset(wbCls.clueDataItem, "_description", 0x18)).writePointer(descArr);
        }
        var vi = A.on(vItemCls);
        vi.add(fieldOffset(vItemCls, "_id", 0x10)).writePointer(makeS(id));
        vi.add(fieldOffset(vItemCls, "_version", 0x18)).writeS32(ver);
        vi.add(fieldOffset(vItemCls, "_item", 0x20)).writePointer(item);
        var ivp = makeIdVersionPair(id, ver);
        vi.add(fieldOffset(vItemCls, "_idVersionPair", 0x28)).writePointer(ivp);
        return { vi: vi, ivp: ivp, id: id, ver: ver };
    } catch (e) { wblog("buildVersionedItem err '" + id + "': " + e); return null; }
}
// 向 List<VersionedItem<...>> 注入某个线索的所有版本; page 给定则同时预填 _localizedTextData
function injectClueVersions(list, addMi, vItemCls, id, rec, page) {
    var keys = Object.keys(rec.versions), added = 0;
    for (var i = 0; i < keys.length; i++) {
        var b = buildVersionedItem(vItemCls, id, parseInt(keys[i], 10), rec);
        if (!b || !b.vi || b.vi.isNull()) continue;
        if (!invokeOk(addMi, list, [b.vi]).ok) { wblog("List.Add 失败 '" + id + " v" + keys[i] + "'"); continue; }
        added++;
        if (page) registerLocalizedDict(page, b);
    }
    return added;
}
// 1) 注入 ClueData._items (ScriptableObject, 供原版 LoadDataAsync 重建时包含 mod)
function injectClueData() {
    try {
        var inst = findFirstObjectOfType(wbCls.clueData);
        if (!inst) { wblog("ClueData 实例未找到 (可能尚未加载)"); return false; }
        var key = inst.toString();
        if (wbInjectedClueData[key]) return true;
        var items = inst.add(fieldOffset(wbCls.clueData, "_items", 0x18)).readPointer();
        if (items.isNull()) { wblog("ClueData._items 为 null"); return false; }
        var listCls = A.ogc(items);
        var vItemCls = getGenericArgClass(listCls, 0);
        var addMi = A.cgm(listCls, Memory.allocUtf8String("Add"), 1);
        if (vItemCls.isNull() || !addMi || addMi.isNull()) { wblog("VersionedItem<ClueDataItem>/Add 解析失败"); return false; }
        var idOff = fieldOffset(vItemCls, "_id", 0x10);
        var ids = currentModClueIds(), added = 0;
        for (var i = 0; i < ids.length; i++) {
            if (listContainsId(items, ids[i], idOff)) continue;
            added += injectClueVersions(items, addMi, vItemCls, ids[i], wbData.clues[ids[i]]);
        }
        wbInjectedClueData[key] = true;
        wblog("ClueData 注入 " + added + " 条 (total=" + items.add(0x18).readS32() + ")");
        return true;
    } catch (e) { wblog("injectClueData err: " + e); return false; }
}
// 2) 注入 CluePage._loadedDataItemMap + _itemIds + _state
function injectCluePage() {
    try {
        var pages = findAllObjectOfType(wbCls.cluePage);
        if (!pages.length) {
            var st = Object.keys(wbData.states);
            for (var i = 0; i < st.length; i++) wbData.pendingStates[st[i]] = wbData.states[st[i]];
            wblog("CluePage 未找到, " + st.length + " 个状态暂存");
            return false;
        }
        var page = pages[0], key = page.toString();
        var mapOff = fieldOffset(wbCls.cluePage, "_loadedDataItemMap", 0x88);
        var mapList = page.add(mapOff).readPointer();
        if (!mapList.isNull()) {
            var listCls = A.ogc(mapList);
            var vItemCls = getGenericArgClass(listCls, 0);
            var addMi = A.cgm(listCls, Memory.allocUtf8String("Add"), 1);
            if (!vItemCls.isNull() && addMi && !addMi.isNull()) {
                var idOff2 = fieldOffset(vItemCls, "_id", 0x10);
                var ids = currentModClueIds(), added = 0;
                for (var i = 0; i < ids.length; i++) {
                    if (listContainsId(mapList, ids[i], idOff2)) continue;
                    added += injectClueVersions(mapList, addMi, vItemCls, ids[i], wbData.clues[ids[i]], page);
                }
                if (added > 0) wblog("CluePage._loadedDataItemMap 注入 " + added + " 条 (total=" + mapList.add(0x18).readS32() + ")");
            }
        }
        appendItemIds(page);
        applyStates(page);
        wbInjectedPages[key] = true;
        return true;
    } catch (e) { wblog("injectCluePage err: " + e); return false; }
}
// 向 _itemIds (string[]) 追加纯新 mod ID (原版 UpdateVersion 检查 Contains)
function appendItemIds(page) {
    try {
        var idsField = fieldOffset(wbCls.cluePage, "_itemIds", 0x98);
        var old = page.add(idsField).readPointer();
        var newIds = [];
        if (!old.isNull()) {
            var oldLen = old.add(0x18).readS32();
            for (var i = 0; i < oldLen; i++) {
                var s = readStr(old.add(0x20 + i * 8).readPointer());
                if (s) newIds.push(s);
            }
        }
        var keys = currentModClueIds(), appended = 0;
        for (var i = 0; i < keys.length; i++) {
            if (newIds.indexOf(keys[i]) === -1) { newIds.push(keys[i]); appended++; }
        }
        if (!appended) return;
        var strCls = getSystemClass("String");
        var arr = A.an(strCls, newIds.length);
        for (var i = 0; i < newIds.length; i++) arr.add(0x20 + i * 8).writePointer(makeS(newIds[i]));
        page.add(idsField).writePointer(arr);
        wblog("_itemIds: +" + appended + " 纯新 ID, 共 " + newIds.length);
    } catch (e) { wblog("appendItemIds err: " + e); }
}
// 3) 状态: _state.SetVersion (ClueState : VersionedState, 同步方法可 runtime_invoke)
function applyStates(page) {
    try {
        var stateOff = fieldOffset(wbCls.cluePage, "_state", 0x48);
        var state = page.add(stateOff).readPointer();
        if (state.isNull()) { wblog("CluePage._state 为 null"); return; }
        var setMi = A.cgm(wbCls.versionedState, Memory.allocUtf8String("SetVersion"), 2);
        if (!setMi || setMi.isNull()) { wblog("VersionedState.SetVersion NOT FOUND"); return; }
        var ids = Object.keys(wbData.states), applied = 0;
        for (var i = 0; i < ids.length; i++) {
            var vbuf = Memory.alloc(4); vbuf.writeS32(wbData.states[ids[i]]);
            if (invokeOk(setMi, state, [makeS(ids[i]), vbuf]).ok) applied++;
        }
        var pend = Object.keys(wbData.pendingStates);
        for (var i = 0; i < pend.length; i++) {
            var vbuf2 = Memory.alloc(4); vbuf2.writeS32(wbData.pendingStates[pend[i]]);
            if (invokeOk(setMi, state, [makeS(pend[i]), vbuf2]).ok) { applied++; wbData.states[pend[i]] = wbData.pendingStates[pend[i]]; }
        }
        wbData.pendingStates = {};
        wblog("状态应用 " + applied + " 条");
    } catch (e) { wblog("applyStates err: " + e); }
}
// 4) 纹理: 读 PNG → Texture2D → 注册进 AddressablesManager._loadedAssets (缩略图 + @spawn 共用)
function loadClueTexture(id) {
    if (wbData.texCache[id]) return wbData.texCache[id];
    var path = wbData.texPaths[id];
    if (!path) return null;
    try {
        var fb = fileReadBytes(path);
        if (!fb || fb.size <= 0) { wblog("读取纹理失败 '" + id + "'"); return null; }
        var byteCls = getSystemClass("Byte");
        var barr = A.an(byteCls, fb.size);
        // byte[] 是值类型数组, 数据从 +0x20 起原始字节
        barr.add(0x20).writeByteArray(fb.buf.readByteArray(fb.size));
        var tex = A.on(wbCls.texture2d);
        var wbuf = Memory.alloc(4); wbuf.writeS32(2);
        var hbuf = Memory.alloc(4); hbuf.writeS32(2);
        var ctorMi = A.cgm(wbCls.texture2d, Memory.allocUtf8String(".ctor"), 2);
        if (ctorMi && !ctorMi.isNull()) invokeOk(ctorMi, tex, [wbuf, hbuf]);
        var liMi = A.cgm(wbCls.imageConversion, Memory.allocUtf8String("LoadImage"), 2);
        if (!liMi || liMi.isNull()) { wblog("ImageConversion.LoadImage NOT FOUND"); return null; }
        var r = invokeOk(liMi, ptr(0), [tex, barr]);   // 静态
        if (!r.ok) { wblog("LoadImage 失败 '" + id + "'"); return null; }
        wbData.texCache[id] = tex;
        wblog("纹理加载 '" + id + "' -> " + tex);
        return tex;
    } catch (e) { wblog("loadClueTexture err '" + id + "': " + e); return null; }
}
function findAddressablesManager() {
    // 1) CluePage._addressableAssetLoader (已验证可靠, 是同一个 AddressablesManager 单例)
    try {
        if (wbCls && wbCls.cluePage && !wbCls.cluePage.isNull()) {
            var pages = findAllObjectOfType(wbCls.cluePage);
            if (pages.length) {
                var m = pages[0].add(fieldOffset(wbCls.cluePage, "_addressableAssetLoader", 0x50)).readPointer();
                if (m && !m.isNull()) return m;
            }
        }
    } catch (e) {}
    // 2) 全局服务 (模糊匹配 Addressables 相关类名)
    try {
        var el = A.cfn(nv, "Naninovel", "Engine");
        var f = A.gf(el, "services");
        var l = A.sdf(el).add(A.fo(f)).readPointer();
        var its = l.add(0x10).readPointer(), sz = l.add(0x18).readS32();
        for (var i = 0; i < sz; i++) {
            var ep = its.add(0x20 + i * 8).readPointer(); if (ep.isNull()) continue;
            var cn = A.cgn(A.ogc(ep)).readCString();
            if (cn.indexOf("Addressables") >= 0) return ep;
        }
    } catch (e) {}
    return null;
}
function registerTexturesInto(managerPtr) {
    try {
        // 未指定时用全局 AddressablesManager 服务 (镜像 Windows ServiceLocator.Get<IAddressablesManager>)
        if (!managerPtr || managerPtr.isNull()) managerPtr = findAddressablesManager();
        if (!managerPtr || managerPtr.isNull()) { wblog("AddressablesManager 未找到"); return; }
        var mgrCls = A.ogc(managerPtr);
        var dict = managerPtr.add(fieldOffset(mgrCls, "_loadedAssets", 0x18)).readPointer();
        if (dict.isNull()) { wblog("AddressablesManager._loadedAssets 为 null"); return; }
        var dictCls = A.ogc(dict);
        var addMi = A.cgm(dictCls, Memory.allocUtf8String("Add"), 2);
        if (!addMi || addMi.isNull()) { wblog("Dict.Add NOT FOUND"); return; }
        var ids = currentModClueIds().filter(function (id) { return !!wbData.texPaths[id]; }), count = 0;
        for (var i = 0; i < ids.length; i++) {
            var tex = loadClueTexture(ids[i]);
            if (!tex) continue;
            var addr = buildClueTextureAddress(ids[i]);
            if (dictContainsKey(dict, addr)) continue;
            if (invokeOk(addMi, dict, [makeS(addr), tex]).ok) count++;
        }
        if (count > 0) wblog("Addressables 注册 " + count + " 张纹理");
    } catch (e) { wblog("registerTexturesInto err: " + e); }
}
function dictContainsKey(dict, key) {
    try {
        // .NET Dictionary: _entries(+0x18, Entry[]), _count(+0x20); Entry = hashCode(4)+next(4)+key(8)+value(8)
        var ents = dict.add(0x18).readPointer();
        if (ents.isNull()) return false;
        var cnt = ents.add(0x18).readS32();   // 数组长度 (容量)
        for (var i = 0; i < cnt; i++) {
            try {
                var e = ents.add(0x20 + i * 24);
                var k = e.add(8).readPointer();
                if (!k.isNull() && readStr(k) === key) return true;
            } catch (e2) {}
        }
    } catch (e) {}
    return false;
}
// 从 CluePage 结构中移除指定 id 的线索 (mod 切换时清理旧 mod 数据)
function clearModCluesFromPage(page, idSet) {
    try {
        var removed = 0;
        // 1) _loadedDataItemMap (List): 收集要移除的索引, 倒序 RemoveAt
        var mapOff = fieldOffset(wbCls.cluePage, "_loadedDataItemMap", 0x88);
        var mapList = page.add(mapOff).readPointer();
        if (!mapList.isNull()) {
            var listCls = A.ogc(mapList);
            var vItemCls = getGenericArgClass(listCls, 0);
            var idOff = fieldOffset(vItemCls, "_id", 0x10);
            var rmMi = A.cgm(listCls, Memory.allocUtf8String("RemoveAt"), 1);
            var cnt = mapList.add(0x18).readS32(), items = mapList.add(0x10).readPointer();
            var idxs = [];
            for (var i = 0; i < cnt; i++) {
                try {
                    var e = items.add(0x20 + i * 8).readPointer();
                    if (e.isNull()) continue;
                    if (idSet[readStr(e.add(idOff).readPointer())]) idxs.push(i);
                } catch (e2) {}
            }
            if (rmMi && !rmMi.isNull()) {
                for (var r = idxs.length - 1; r >= 0; r--) {
                    var ib = Memory.alloc(4); ib.writeS32(idxs[r]);
                    if (invokeOk(rmMi, mapList, [ib]).ok) removed++;
                }
            }
        }
        // 2) _localizedTextData (Dict): 遍历删除 key.Id ∈ idSet
        var dictField = fieldOffset(wbCls.cluePage, "_localizedTextData", 0xD0);
        var outer = page.add(dictField).readPointer();
        if (!outer.isNull()) {
            var outerCls = A.ogc(outer);
            var rmD = A.cgm(outerCls, Memory.allocUtf8String("Remove"), 1);
            if (rmD && !rmD.isNull()) {
                // 先收集要删的 key (边遍历边 Remove 会 rehash 使数组失效)
                var toDel = [];
                var ents = outer.add(0x18).readPointer();
                var ecnt = ents.isNull() ? 0 : ents.add(0x18).readS32();
                for (var ei = 0; ei < ecnt; ei++) {
                    try {
                        var en = ents.add(0x20 + ei * 24);
                        var k = en.add(8).readPointer();
                        if (k.isNull()) continue;
                        var kid = readStr(k);
                        if (kid && idSet[kid]) toDel.push(k);
                    } catch (e2) {}
                }
                for (var di = 0; di < toDel.length; di++) invokeOk(rmD, outer, [toDel[di]]);
            }
        }
        // 3) _itemIds (string[]): 重建
        var idsField = fieldOffset(wbCls.cluePage, "_itemIds", 0x98);
        var old = page.add(idsField).readPointer();
        if (!old.isNull()) {
            var keep = [];
            var olen = old.add(0x18).readS32();
            for (var oi = 0; oi < olen; oi++) {
                var s = readStr(old.add(0x20 + oi * 8).readPointer());
                if (s && !idSet[s]) keep.push(s);
            }
            var strCls = getSystemClass("String");
            var narr = A.an(strCls, keep.length);
            for (var ki = 0; ki < keep.length; ki++) narr.add(0x20 + ki * 8).writePointer(makeS(keep[ki]));
            page.add(idsField).writePointer(narr);
        }
        // 4) _state._list (List<IdVersionPair>): 移除 Id ∈ idSet
        removeStateEntries(page, idSet);
        // 5) 清当前选中项 (_currentItemId) → 上方面板不再残留上一剧本的线索
        try {
            var curOff = fieldOffset(wbCls.cluePage, "_currentItemId", 0xA0);
            page.add(curOff).writePointer(makeS(""));
        } catch (e) {}
        if (removed > 0) wblog("清除旧 mod 线索 " + removed + " 条");
    } catch (e) { wblog("clearModCluesFromPage err: " + e); }
}
// 从 _state._list 移除指定 id 的状态 (IdVersionPair.Id @+0x10)
function removeStateEntries(page, idSet) {
    try {
        var stOff = fieldOffset(wbCls.cluePage, "_state", 0x48);
        var st = page.add(stOff).readPointer();
        if (st.isNull()) return;
        var stList = st.add(fieldOffset(wbCls.versionedState, "_list", 0x10)).readPointer();
        if (stList.isNull()) return;
        var slCls = A.ogc(stList);
        var rmMi = A.cgm(slCls, Memory.allocUtf8String("RemoveAt"), 1);
        if (!rmMi || rmMi.isNull()) return;
        var scnt = stList.add(0x18).readS32(), sitems = stList.add(0x10).readPointer();
        var sidxs = [];
        for (var si = 0; si < scnt; si++) {
            try {
                var se = sitems.add(0x20 + si * 8).readPointer();
                if (se.isNull()) continue;
                var sid = readStr(se.add(0x10).readPointer());
                if (sid && idSet[sid]) sidxs.push(si);
            } catch (e2) {}
        }
        for (var sr = sidxs.length - 1; sr >= 0; sr--) {
            var sb = Memory.alloc(4); sb.writeS32(sidxs[sr]);
            invokeOk(rmMi, stList, [sb]);
        }
    } catch (e) { wblog("removeStateEntries err: " + e); }
}
// 强制清空详情面板 (上方面板) 的文本组件: _subjectLabel/_descriptionLabel/_currentItemId
// ClearState 只重置状态, 不会清 UI 文本 → 上方面板残留来自上一会话的 TMP 文本
function clearCluePagePanel(page) {
    try {
        var cleared = 0;
        var sl = page.add(fieldOffset(wbCls.cluePage, "_subjectLabel", 0xB8)).readPointer();
        if (!sl.isNull()) {
            var stMi = A.cgm(wbCls.witchBookItemSubjectLabel, Memory.allocUtf8String("SetText"), 1);
            if (stMi && !stMi.isNull()) { if (invokeOk(stMi, sl, [makeS("")]).ok) cleared++; }
        }
        var dl = page.add(fieldOffset(wbCls.cluePage, "_descriptionLabel", 0xC0)).readPointer();
        if (!dl.isNull()) {
            var txtCls = A.ogc(dl);
            var stMi2 = A.cgm(txtCls, Memory.allocUtf8String("set_text"), 1);
            if (stMi2 && !stMi2.isNull()) { if (invokeOk(stMi2, dl, [makeS("")]).ok) cleared++; }
        }
        // 缩略图: _thumbnail._rawImage.texture = null (清掉残留图)
        try {
            var th = page.add(fieldOffset(wbCls.cluePage, "_thumbnail", 0xC8)).readPointer();
            if (!th.isNull()) {
                var rawImage = th.add(fieldOffset(wbCls.witchBookItemThumbnail, "_rawImage", 0x28)).readPointer();
                if (!rawImage.isNull()) {
                    var rawCls = A.ogc(rawImage);
                    var setTexMi = A.cgm(rawCls, Memory.allocUtf8String("set_texture"), 1);
                    if (setTexMi && !setTexMi.isNull()) { if (invokeOk(setTexMi, rawImage, [ptr(0)]).ok) cleared++; }
                }
            }
        } catch (e) {}
        try { page.add(fieldOffset(wbCls.cluePage, "_currentItemId", 0xA0)).writePointer(makeS("")); } catch (e) {}
        wblog("清空详情面板 (上方面板, " + cleared + " 个组件)");
    } catch (e) { wblog("clearCluePagePanel err: " + e); }
}
// 清空页面 _state (仅保留 keepSet; keepSet=null 清空全部)
function clearPageState(page, keepSet) {
    try {
        var st = page.add(0x48).readPointer();
        if (st.isNull()) return;
        var stList = st.add(fieldOffset(wbCls.versionedState, "_list", 0x10)).readPointer();
        if (stList.isNull()) return;
        var slCls = A.ogc(stList);
        var rmMi = A.cgm(slCls, Memory.allocUtf8String("RemoveAt"), 1);
        if (!rmMi || rmMi.isNull()) return;
        var cnt = stList.add(0x18).readS32(), items = stList.add(0x10).readPointer();
        var idxs = [];
        for (var i = 0; i < cnt; i++) {
            try {
                var e = items.add(0x20 + i * 8).readPointer();
                if (e.isNull()) continue;
                var id = readStr(e.add(0x10).readPointer());
                if (!id || (keepSet && !keepSet[id])) idxs.push(i);
            } catch (e2) {}
        }
        for (var r = idxs.length - 1; r >= 0; r--) {
            var ib = Memory.alloc(4); ib.writeS32(idxs[r]);
            invokeOk(rmMi, stList, [ib]);
        }
        if (idxs.length) wblog("清空 " + A.cgn(A.ogc(page)).readCString() + " 状态 " + idxs.length + " 条");
    } catch (e) { wblog("clearPageState err: " + e); }
}
function currentModSet() {
    var cur = currentModClueIds(), set = {};
    cur.forEach(function (id) { set[id] = 1; });
    return set;
}
// 清空页面详情面板: 按页面类型清对应 TMP 标签 + 缩略图 + _currentItemId
function clearPagePanel(page) {
    try {
        var pageCls = A.ogc(page);
        var clsName = A.cgn(pageCls).readCString();
        var cleared = 0;
        function clearLabel(fn, useSetText) {
            try {
                var f = A.gf(pageCls, Memory.allocUtf8String(fn));
                if (!f || f.isNull()) return;
                var lab = page.add(A.fo(f)).readPointer();
                if (lab.isNull()) return;
                var labCls = A.ogc(lab);
                var mi = useSetText ? A.cgm(labCls, Memory.allocUtf8String("SetText"), 1) : A.cgm(labCls, Memory.allocUtf8String("set_text"), 1);
                if (mi && !mi.isNull()) { if (invokeOk(mi, lab, [makeS("")]).ok) cleared++; }
            } catch (e) {}
        }
        function clearThumb() {
            try {
                var f = A.gf(pageCls, Memory.allocUtf8String("_thumbnail"));
                if (!f || f.isNull()) return;
                var th = page.add(A.fo(f)).readPointer();
                if (th.isNull()) return;
                var raw = th.add(fieldOffset(wbCls.witchBookItemThumbnail, "_rawImage", 0x28)).readPointer();
                if (!raw.isNull()) {
                    var rc = A.ogc(raw);
                    var mi = A.cgm(rc, Memory.allocUtf8String("set_texture"), 1);
                    if (mi && !mi.isNull()) { if (invokeOk(mi, raw, [ptr(0)]).ok) cleared++; }
                }
            } catch (e) {}
        }
        if (clsName === "CluePage") { clearLabel("_subjectLabel", true); clearLabel("_descriptionLabel", false); clearThumb(); }
        else if (clsName === "ProfilePage") { clearLabel("_authorLabel", false); clearLabel("_descriptionLabel", false); clearThumb(); }
        else if (clsName === "RulePage") { clearLabel("_titleNumLabel", false); clearLabel("_subtitleLabel", false); clearLabel("_descriptionLabel", false); }
        else if (clsName === "NotePage") { clearLabel("_titleLabel", false); clearLabel("_descriptionLabel", false); }
        try { page.add(0xA0).writePointer(makeS("")); } catch (e) {}   // _currentItemId (通用基类字段)
        if (cleared) wblog("清空 " + clsName + " 面板 (" + cleared + " 组件)");
    } catch (e) { wblog("clearPagePanel err: " + e); }
}
function findAllPages() {
    var baseCls = findClassAcrossImages("WitchTrials.Views", "WitchBookPageBase");
    if (!baseCls || baseCls.isNull()) return [];
    return findAllObjectOfType(baseCls);
}
// 只清面板 (视觉残留) — 打开图鉴时调用; 不动状态 (mod 合法 @update 的线索要保留)
function clearAllPagePanels() {
    try {
        if (!wbCurrentMod || wbCurrentMod === "__vanilla__") return;
        var pages = findAllPages();
        for (var i = 0; i < pages.length; i++) { try { clearPagePanel(pages[i]); } catch (e) {} }
    } catch (e) { wblog("clearAllPagePanels err: " + e); }
}
// 清状态 + 面板 — 仅 mod 切换/会话重置时调用
// CluePage 保留当前 mod 线索; Profile/Rule/Note/Map 全部清空 (mod 不定义它们, 由 @update 重建)
function clearAllWitchBookPages() {
    try {
        if (!wbCurrentMod || wbCurrentMod === "__vanilla__") return;   // 原版剧情不干预
        var pages = findAllPages();
        for (var i = 0; i < pages.length; i++) {
            try {
                var cn = A.cgn(A.ogc(pages[i])).readCString();
                var keep = (cn === "CluePage") ? currentModSet() : null;
                clearPageState(pages[i], keep);
                clearPagePanel(pages[i]);
            } catch (e) {}
        }
    } catch (e) { wblog("clearAllWitchBookPages err: " + e); }
}
function findWitchBookUi() {
    try { var s = findSvc("WitchBookUi"); if (s) return s; } catch (e) {}
    try {
        if (wbCls && wbCls.witchBookUi && !wbCls.witchBookUi.isNull()) {
            var arr = findAllObjectOfType(wbCls.witchBookUi);
            if (arr.length) return arr[0];
        }
    } catch (e) {}
    return null;
}
// 镜像 @clearBook (ClearWitchBook 命令): 调 WitchBookUi.ClearState(category) 全 5 分类
// 重置页面 _state (ResetToDefault) + 当前选中项 → 上方面板不再残留上一剧本的线索
function clearBookViaVanilla() {
    try {
        var ui = findWitchBookUi();
        if (!ui) { wblog("clearBook: WitchBookUi 未找到"); return; }
        var mi = A.cgm(wbCls.witchBookUi, Memory.allocUtf8String("ClearState"), 1);
        if (!mi || mi.isNull()) { wblog("clearBook: ClearState NOT FOUND"); return; }
        for (var c = 0; c <= 4; c++) {   // Clue=0 Profile=1 Map=2 Rule=3 Note=4
            var cb = Memory.alloc(4); cb.writeS32(c);
            invokeOk(mi, ui, [cb]);
        }
        wblog("clearBook: WitchBookUi.ClearState 全部 5 分类已调用");
    } catch (e) { wblog("clearBook err: " + e); }
}
function tryInjectWitchBook() {
    try {
        // mod 切换检测: 换剧本/回标题后重新开始 → 清掉上一 mod 注入的线索 + 重置状态
        if (wbCurrentMod !== wbPrevMod) {
            var allIds = Object.keys(wbData.clues);
            if (allIds.length) {
                var idSet = {};
                allIds.forEach(function (id) { idSet[id] = 1; });
                var pages = findAllObjectOfType(wbCls.cluePage);
                if (pages.length) {
                    clearBookViaVanilla();                 // 重置状态 + 当前选中项 (清残留显示)
                    clearModCluesFromPage(pages[0], idSet); // 移除证物目录数据 (map/dict/itemIds)
                    clearAllWitchBookPages();              // 清各页面状态 + 面板 (含 Profile/Rule/Note)
                }
            }
            wbData.states = {}; wbData.pendingStates = {};
            wbPrevMod = wbCurrentMod;
            wblog("mod 切换 → 状态重置, 注入范围: " + (wbCurrentMod ? "'" + wbCurrentMod + "'" : "无"));
        }
        injectCluePage();
        // 顺带注册纹理 (全局 manager + CluePage 上的 loader)
        registerTexturesInto(null);
        var pages2 = findAllObjectOfType(wbCls.cluePage);
        if (pages2.length) registerTexturesInto(pages2[0].add(fieldOffset(wbCls.cluePage, "_addressableAssetLoader", 0x50)).readPointer());
    } catch (e) { wblog("tryInjectWitchBook err: " + e); }
}
// @update 拦截
function onWitchBookUpdate(args) {
    try {
        var cat = args[1].toInt32(), id = readStr(args[2]), ver = args[3].toInt32();
        if (cat !== 0) return;   // WitchBookCategory.Clue = 0
        if (!id || !isCurrentModClue(id)) { wblog(">>> @update 忽略: id='" + id + "' (非当前 mod 线索)"); return; }
        if (wbData.states[id] === ver) return;
        wbData.states[id] = ver;
        wblog(">>> @update 拦截: category=Clue id='" + id + "' version=" + ver);
        tryInjectWitchBook();
    } catch (e) { wblog("onWitchBookUpdate err: " + e); }
}
// 显示层: 预填 CluePage._localizedTextData (IReadOnlyDictionary<IdVersionPair, IReadOnlyDictionary<LocaleKind, LocalizedTexts>>)
// 键用与 VersionedItem._idVersionPair 同一 IdVersionPair 实例 → 原版 RefreshPageContent/SetupItemButton
// 查 _localizedTextData[map.IdVersionPair] 命中, 不再 KeyNotFoundException。
function getFirstDictValue(dict) {
    try {
        var ents = dict.add(0x18).readPointer();
        if (ents.isNull()) return null;
        var cnt = ents.add(0x18).readS32();
        for (var i = 0; i < cnt; i++) {
            try {
                var v = ents.add(0x20 + i * 24 + 16).readPointer();
                if (v && !v.isNull()) return v;
            } catch (e) {}
        }
    } catch (e) {}
    return null;
}
function registerLocalizedDict(page, b) {
    try {
        var dictField = fieldOffset(wbCls.cluePage, "_localizedTextData", 0xD0);
        var outer = page.add(dictField).readPointer();
        if (outer.isNull()) { wblog("_localizedTextData 为 null, 跳过预填 '" + b.id + "'"); return; }
        var outerCls = A.ogc(outer);
        // 从现有值偷内层字典的具体实现类 (不能用泛型参数: 那是 IReadOnlyDictionary 接口, object_new 会崩)
        var sample = getFirstDictValue(outer);
        if (!sample) { wblog("_localizedTextData 无现有值, 无法确定内层字典类, 跳过 '" + b.id + "'"); return; }
        var innerCls = A.ogc(sample);
        var innerName = A.cgn(innerCls).readCString();
        var addInner = A.cgm(innerCls, Memory.allocUtf8String("Add"), 2);
        if (!addInner || addInner.isNull()) { wblog("内层字典无 Add (" + innerName + "), 跳过 '" + b.id + "'"); return; }
        var vrec = wbData.clues[b.id].versions[String(b.ver)];
        if (!vrec) return;
        var tags = unionLocaleKeys(vrec.name, vrec.desc);
        if (!tags.length) return;
        var inner = A.on(innerCls);
        if (!invokeOk(A.cgm(innerCls, Memory.allocUtf8String(".ctor"), 0), inner, []).ok) { wblog("内层字典 ctor 失败 '" + b.id + "'"); return; }
        // LocalizedTexts: 优先嵌套类; 失败则从外层字典泛型参数深层推导
        // outer: Dictionary<IdVersionPair, IReadOnlyDictionary<LocaleKind, CluePage.LocalizedTexts>>
        //   arg[1] = IReadOnlyDictionary<LocaleKind, LocalizedTexts> → 其 arg[1] = LocalizedTexts
        var ltsCls = wbCls.localizedTexts;
        if (!ltsCls || ltsCls.isNull()) {
            try {
                var ifaceCls = getGenericArgClass(outerCls, 1);
                if (!ifaceCls.isNull()) ltsCls = getGenericArgClass(ifaceCls, 1);
            } catch (e) {}
        }
        var ltsCtor = (ltsCls && !ltsCls.isNull()) ? A.cgm(ltsCls, Memory.allocUtf8String(".ctor"), 2) : null;
        if (!ltsCls || ltsCls.isNull() || !ltsCtor || ltsCtor.isNull()) { wblog("CluePage.LocalizedTexts 类/ctor 未找到, 跳过 '" + b.id + "'"); return; }
        for (var t = 0; t < tags.length; t++) {
            var lts = A.on(ltsCls);
            var lv = Memory.alloc(4); lv.writeS32(localeValue(tags[t]));
            if (ltsCtor && !ltsCtor.isNull())
                invokeOk(ltsCtor, lts, [makeS(resolveLocale(vrec.name, tags[t])), makeS(resolveLocale(vrec.desc, tags[t]))]);
            if (addInner && !addInner.isNull())
                invokeOk(addInner, inner, [lv, lts]);
        }
        var addOuter = A.cgm(outerCls, Memory.allocUtf8String("Add"), 2);
        if (addOuter && !addOuter.isNull()) invokeOk(addOuter, outer, [b.ivp, inner]);
        wblog("_localizedTextData 预填 '" + b.id + "' v" + b.ver + " (" + innerName + ", " + tags.length + " 语言)");
    } catch (e) { wblog("registerLocalizedDict err '" + b.id + "': " + e); }
}
// 解析 WitchBook 相关类
function resolveWitchBookClasses() {
    var m = {};
    m.clueData = findClassAcrossImages("WitchTrials.Models", "ClueData");
    m.clueDataItem = findClassAcrossImages("WitchTrials.Models", "ClueDataItem");
    m.idVersionPair = findClassAcrossImages("WitchTrials.Models", "IdVersionPair");
    m.versionedState = findClassAcrossImages("WitchTrials.Models", "VersionedState");
    m.localizedText = findClassAcrossImages("GigaCreation.Essentials.Localization", "LocalizedText");
    m.witchBookScreen = findClassAcrossImages("WitchTrials.Views", "WitchBookScreen");
    m.witchBookUi = findClassAcrossImages("WitchTrials.Views", "WitchBookUi");
    m.cluePage = findClassAcrossImages("WitchTrials.Views", "CluePage");
    m.witchBookItemThumbnail = findClassAcrossImages("WitchTrials.Views", "WitchBookItemThumbnail");
    m.witchBookItemSubjectLabel = findClassAcrossImages("WitchTrials.Views", "WitchBookItemSubjectLabel");
    m.witchBookItemButton = findClassAcrossImages("WitchTrials.Views", "WitchBookItemButton");
    m.spawnableClue = findClassAcrossImages("WitchTrials.Views", "SpawnableClue");
    m.texture2d = findClassAcrossImages("UnityEngine", "Texture2D");
    m.imageConversion = findClassAcrossImages("UnityEngine", "ImageConversion");
    m.localizedTexts = findNestedClass(m.cluePage, "LocalizedTexts");
    return m;
}
function setupWitchBookHooks() {
    try {
        loadWitchBookData();
        if (Object.keys(wbData.clues).length === 0) { wblog("无 mod 线索, 跳过"); return; }
        wbCls = resolveWitchBookClasses();
        if (!wbCls.clueData || wbCls.clueData.isNull() || !wbCls.cluePage || wbCls.cluePage.isNull() ||
            !wbCls.witchBookScreen || wbCls.witchBookScreen.isNull() || !wbCls.versionedState || wbCls.versionedState.isNull()) {
            wblog("类解析失败 (clueData/cluePage/screen/versionedState)"); return;
        }
        // @update 入口
        ["WitchBookUi", "WitchBookScreen"].forEach(function (cn) {
            try {
                var cls = wbCls[cn === "WitchBookUi" ? "witchBookUi" : "witchBookScreen"];
                if (!cls || cls.isNull()) return;
                var uvMi = A.cgm(cls, Memory.allocUtf8String("UpdateVersion"), 3);
                if (uvMi && !uvMi.isNull()) Interceptor.attach(uvMi.readPointer(), { onEnter: onWitchBookUpdate });
            } catch (e) {}
        });
        // WitchBook 打开/翻页重建 → 强制重注入
        ["BeginToPresent", "InitializePages"].forEach(function (mn) {
            try {
                var mi = A.cgm(wbCls.witchBookScreen, Memory.allocUtf8String(mn), 0);
                if (mi && !mi.isNull()) Interceptor.attach(mi.readPointer(), { onEnter: function () {
                    wblog(">>> WitchBook " + mn + " 触发");
                    tryInjectWitchBook();   // 内部处理 mod 切换清理 (状态+面板) + 注入
                }});
            } catch (e) {}
        });
        // @spawn "Clue" → SpawnableClue.SetSpawnParameters 后注册纹理 (spawn 可能早于图鉴打开)
        try {
            var ssMi = A.cgm(wbCls.spawnableClue, Memory.allocUtf8String("SetSpawnParameters"), 2);
            if (ssMi && !ssMi.isNull()) {
                Interceptor.attach(ssMi.readPointer(), {
                    onEnter: function (a) { this._self = a[0]; },
                    onLeave: function () {
                        try {
                            var cid = readStr(this._self.add(0x80).readPointer());  // _clueId @0x80
                            if (cid && wbData.clues[cid]) {
                                wblog(">>> SpawnableClue mod 线索: '" + cid + "', 注册纹理");
                                registerTexturesInto(null);   // 用全局 AddressablesManager
                            }
                        } catch (e) {}
                    }
                });
            }
        } catch (e) {}
        // 剧本加载 → 识别当前 mod (匹配 Enter 路径), 用于按 mod 注入线索
        try {
            var slCls2 = findClassAcrossImages("Naninovel", "ScriptLoader");
            if (slCls2 && !slCls2.isNull()) {
                var loadMi3 = A.cgm(slCls2, Memory.allocUtf8String("Load"), 2);
                if (loadMi3 && !loadMi3.isNull()) {
                    Interceptor.attach(loadMi3.readPointer(), { onEnter: function (a) {
                        try { detectCurrentMod(readStr(a[1])); } catch (e) {}
                    }});
                }
            }
        } catch (e) {}
        wblog("hooks 就绪");
    } catch (e) { wblog("setupWitchBookHooks err: " + e); }
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
        A.an  = E.il2cpp_array_new ? new NativeFunction(E.il2cpp_array_new, 'pointer', ['pointer', 'uint64']) : null;
        A.anSpec = E.il2cpp_array_new_specific ? new NativeFunction(E.il2cpp_array_new_specific, 'pointer', ['pointer', 'uint64']) : null;
        if (!A.cgt || !A.cft || !A.tgo) console.log("[v3] !! 类型 API 缺失 (cgt/cft/tgo), converters 填充将失败");
        if (!A.an) console.log("[v3] !! il2cpp_array_new 缺失, 数组创建将失败");

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

        // Movie 支持钩子 (URL 流式)
        setupMovieHooks();

        // WitchBook 线索支持
        setupWitchBookHooks();

        // Hook TitleUi.Activate → 重定向 + 注册菜单
        var tc = A.cfn(cs, Memory.allocUtf8String("WitchTrials.Views"), Memory.allocUtf8String("TitleUi"));
        if (tc && !tc.isNull()) {
            var actMi = A.cgm(tc, Memory.allocUtf8String("Activate"), 0);
            if (actMi && !actMi.isNull()) {
                Interceptor.attach(actMi.readPointer(), {
                    onEnter: function () {},
                    onLeave: function () {
                        console.log("[v3] TitleUi.Activate 触发");
                        // 回到标题 → 重置 WitchBook 会话 (防止上一 mod 的线索/状态被继承)
                        try { if (typeof wbData !== "undefined") resetWitchBookSession(); } catch (e) {}
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
                        // WitchBook 纹理尽早注册 (Title 后场景加载即有)
                        try { if (wbCls) registerTexturesInto(null); } catch (e3) {}
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
