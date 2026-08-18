// ============ WitchBook 组装域: 类解析 / hook 挂载 / 注入编排 ============
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
import { A, dbg, ensureItemIdsString, fieldOffset, findClassAcrossImages, findNestedClass, invokeOk, makeS, readStr, wblog, error, warn } from "../utils.js";
import { initCatStateMaps, setWbCls, setWbPrevMod, wbCls, wbCurrentMod, wbData, wbPrevMod } from "./state.js";
import { isCurrentModItem, loadWitchBookData, wbCatByIdx, wbCats } from "./data.js";
import { clearAllWitchBookPages, clearBookViaVanilla, detectCurrentMod, findAllPages, hookClearState, rebuildAllPages } from "./session.js";
import { injectPage, hookRefreshLocalized } from "./pages.js";
import { registerTexturesInto } from "./textures.js";
import { hookProfileName } from "./characters.js";

export function resolveWitchBookClasses() {
    var m = {};
    m.pages = {}; m.datas = {}; m.items = {}; m.lts = {};
    var catNames = Object.keys(wbCats);
    for (var i = 0; i < catNames.length; i++) {
        var cat = wbCats[catNames[i]];
        var pageCls = findClassAcrossImages("WitchTrials.Views", cat.page);
        m.pages[cat.name] = pageCls;
        m.datas[cat.name] = findClassAcrossImages("WitchTrials.Models", cat.data);
        m.items[cat.name] = findClassAcrossImages("WitchTrials.Models", cat.item);
        m.lts[cat.name] = (cat.name === "profile") ? ptr(0) : findNestedClass(pageCls, "LocalizedTexts");
    }
    m.idVersionPair = findClassAcrossImages("WitchTrials.Models", "IdVersionPair");
    m.versionedState = findClassAcrossImages("WitchTrials.Models", "VersionedState");
    m.localizedText = findClassAcrossImages("GigaCreation.Essentials.Localization", "LocalizedText");
    m.witchBookScreen = findClassAcrossImages("WitchTrials.Views", "WitchBookScreen");
    m.witchBookUi = findClassAcrossImages("WitchTrials.Views", "WitchBookUi");
    m.witchBookItemThumbnail = findClassAcrossImages("WitchTrials.Views", "WitchBookItemThumbnail");
    m.witchBookItemSubjectLabel = findClassAcrossImages("WitchTrials.Views", "WitchBookItemSubjectLabel");
    m.witchBookItemButton = findClassAcrossImages("WitchTrials.Views", "WitchBookItemButton");
    m.spawnableClue = findClassAcrossImages("WitchTrials.Views", "SpawnableClue");
    m.texture2d = findClassAcrossImages("UnityEngine", "Texture2D");
    m.imageConversion = findClassAcrossImages("UnityEngine", "ImageConversion");
    m.characterData = findClassAcrossImages("WitchTrials.Models", "CharacterData");
    m.characterDataItem = findClassAcrossImages("WitchTrials.Models", "CharacterDataItem");
    m.authorData = findClassAcrossImages("WitchTrials.Models", "AuthorData");
    m.authorDataItem = findClassAcrossImages("WitchTrials.Models", "AuthorDataItem");
    return m;
}
export function setupWitchBookHooks() {
    try {
        loadWitchBookData();
        var total = 0, catNames = Object.keys(wbCats);
        for (var i = 0; i < catNames.length; i++) total += Object.keys(wbData[wbCats[catNames[i]].name]).length;
        if (total === 0) { warn("无 mod WitchBook 数据, 跳过"); return; }
        setWbCls(resolveWitchBookClasses());
        if (!wbCls.pages.clue || wbCls.pages.clue.isNull() ||
            !wbCls.witchBookScreen || wbCls.witchBookScreen.isNull() || !wbCls.versionedState || wbCls.versionedState.isNull()) {
            error("类解析失败 (pages/screen/versionedState)"); return;
        }
        // @update 入口
        ["WitchBookUi", "WitchBookScreen"].forEach(function (cn) {
            try {
                var cls = wbCls[cn === "WitchBookUi" ? "witchBookUi" : "witchBookScreen"];
                if (!cls || cls.isNull()) return;
                var uvMi = A.cgm(cls, Memory.allocUtf8String("UpdateVersion"), 3);
                // NO_UPDATE_HOOK=1 (A/B 隔离): 跳过 @update hook — 审判加载时逐事件 hook 延迟是崩溃竞态嫌疑
                if (uvMi && !uvMi.isNull() && typeof NO_UPDATE_HOOK === 'undefined') Interceptor.attach(uvMi.readPointer(), { onEnter: onWitchBookUpdate });
            } catch (e) {}
        });
        // macOS 泛型共享根治: 游戏自身 WitchBookPageBase.UpdateVersion 里 _itemIds.Contains(id)
        // 在 Graphic[]/Canvas[] 上抛 MAE → 崩/黑屏 (原版 macOS bug, 加载器写入只是放大器)。
        // onEnter 先把字段换回 String[] → 游戏原逻辑 (Contains 门 + SetVersion) 正常工作。
        try {
            var uvCands = [];
            var uvBase = findClassAcrossImages("WitchTrials.Views", "WitchBookPageBase");
            if (uvBase && !uvBase.isNull()) uvCands.push(uvBase);
            var uvKeys = Object.keys(wbCls.pages);
            for (var uvi = 0; uvi < uvKeys.length; uvi++) uvCands.push(wbCls.pages[uvKeys[uvi]]);
            var uvSeen = {};
            for (var uvi2 = 0; uvi2 < uvCands.length; uvi2++) {
                try {
                    var uvc = uvCands[uvi2];
                    if (!uvc || uvc.isNull()) continue;
                    for (var uvn = 1; uvn <= 3; uvn++) {
                        var uvMi2 = A.cgm(uvc, Memory.allocUtf8String("UpdateVersion"), uvn);
                        if (!uvMi2 || uvMi2.isNull()) continue;
                        var uvP = uvMi2.readPointer();
                        if (!uvP || uvP.isNull() || uvSeen[uvP.toString()]) continue;
                        uvSeen[uvP.toString()] = 1;
                        Interceptor.attach(uvP, { onEnter: function (a) { try { ensureItemIdsString(a[0], A.ogc(a[0])); } catch (e) {} } });
                        wblog("page UpdateVersion hook (" + A.cgn(uvc).readCString() + " " + uvn + " 参) @" + uvP);
                    }
                } catch (e) {}
            }
        } catch (e) { error("page UpdateVersion hook err: " + e); }
        // Profile 姓名覆写 (mod 新角色显示格式化名字而非 ID)
        hookProfileName();
        // @clearBook (ClearWitchBook 命令) → ClearState: 清 wbData.states + 复位面板
        // 修: 剧本内 @clearBook 后自定义证物无法清除 (applyStates 复活) + 上方面板冻结残留
        hookClearState();
        // RefreshPageContent onEnter: 重新预填 _localizedTextData
        // 修 InitializePages→LoadDataAsync 异步重建 map 时清掉注入导致 KeyNotFoundException
        hookRefreshLocalized();
        // WitchBook 打开/翻页重建 → 强制重注入
        ["BeginToPresent", "InitializePages"].forEach(function (mn) {
            try {
                var mi = A.cgm(wbCls.witchBookScreen, Memory.allocUtf8String(mn), 0);
                if (mi && !mi.isNull()) Interceptor.attach(mi.readPointer(), { onEnter: function () {
                    dbg(">>> WitchBook " + mn + " 触发");
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
                            if (cid && wbData.clue[cid]) {
                                dbg(">>> SpawnableClue mod 线索: '" + cid + "', 注册纹理");
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
    } catch (e) { error("setupWitchBookHooks err: " + e + " | " + (e && e.stack ? e.stack.split("\n").slice(0,3).join(" | ") : "")); }
}
export function tryInjectWitchBook() {
    try {
        // mod 切换检测: 换剧本/回标题后重新开始 → 整页重建回原版基座 + 重置状态
        if (wbCurrentMod !== wbPrevMod) {
            rebuildAllPages();                  // 整页重建: 清 map, 从 Data 重添全部原版条目
            clearBookViaVanilla();              // 重置状态 + 当前选中项 (清残留显示)
            clearAllWitchBookPages();           // 清各页面状态 + 恢复原版默认面板
            wbData.states = {}; wbData.pendingStates = {};
            initCatStateMaps();
            setWbPrevMod(wbCurrentMod);
            wblog("mod 切换 → 整页重建 + 状态重置, 注入范围: " + (wbCurrentMod ? "'" + wbCurrentMod + "'" : "无"));
        }
        initCatStateMaps();
        // 注入所有分类 (只注入页面, 不注入 Data._items —— Data 是缓存的 ScriptableObject,
        // 注入会跨会话残留: 页面 LoadDataAsync 从 Data 重建 map 时把上次的 mod 条目带回来
        // → listContains=true → 跳过注入 → 无预填 → KeyNotFound。页面注入每次重新做, 自愈。)
        var cn2 = Object.keys(wbCats);
        for (var i = 0; i < cn2.length; i++) {
            injectPage(wbCats[cn2[i]]);
        }
        // 新角色 (Profile 显示名: CharacterData 基本数据 + AuthorData 名称模板)
        // injectCharacterData();   // 临时禁用: 角色档案数据注入可能破坏场景 (5 个 ArgumentException)
        // injectAuthorData();
        // 纹理 (全局 manager + 页面 loader)
        registerTexturesInto(null);
        var pages2 = findAllPages();
        if (pages2.length) registerTexturesInto(pages2[0].add(fieldOffset(A.ogc(pages2[0]), "_addressableAssetLoader", 0x50)).readPointer());
        wblog("tryInjectWitchBook 完成");
    } catch (e) { error("tryInjectWitchBook err: " + e); }
}
// MAE 诊断: 打印页面关键字段的运行时类型 (仅第一次 @update 时; 原版基座污染检查)
// 背景: 崩溃 = WitchBookPageBase.UpdateVersion 内 Enumerable.Contains(source=Graphic[], value=string)
//       → 需确认 _itemIds 等字段在 @update 时刻的运行时类型
var _pageTypesDumped = false;
function dumpPageFieldTypes() {
    if (_pageTypesDumped) return;
    _pageTypesDumped = true;
    try {
        var pages = findAllPages();
        var fields = ["_itemIds", "_loadedDataItemMap", "_items", "_localizedTextData"];
        for (var i = 0; i < pages.length; i++) {
            try {
                var pc = A.ogc(pages[i]);
                var pcn = A.cgn(pc).readCString();
                var parts = [];
                for (var fi = 0; fi < fields.length; fi++) {
                    try {
                        var f = A.gf(pc, Memory.allocUtf8String(fields[fi]));
                        if (!f || f.isNull()) { parts.push(fields[fi] + "=未找到"); continue; }
                        var off = A.fo(f);
                        var v = pages[i].add(off).readPointer();
                        var vcn = (!v || v.isNull()) ? "null" : A.cgn(A.ogc(v)).readCString();
                        parts.push(fields[fi] + "@0x" + off.toString(16) + "=" + vcn);
                    } catch (e2) { parts.push(fields[fi] + "=err"); }
                }
                dbg("  [页面] " + pcn + " " + parts.join(" "));
            } catch (e3) {}
        }
    } catch (e) { error("dumpPageFieldTypes err: " + e); }
}
// @update 拦截: 按 WitchBookCategory 路由 (Clue=0 Profile=1 Map=2 Rule=3 Note=4)
export function onWitchBookUpdate(args) {
    try {
        var idx = args[1].toInt32(), id = readStr(args[2]), ver = args[3].toInt32();
        var cat = wbCatByIdx(idx);
        if (!cat || idx === 2) return;   // Map 分类暂不处理
        dumpPageFieldTypes();            // MAE 诊断: @update 时刻页面字段类型
        if (!id || !isCurrentModItem(cat, id)) { dbg(">>> @update 忽略: category=" + (cat?cat.name:idx) + " id='" + id + "' (非当前 mod 条目)"); return; }
        if (!wbData.states[cat.name]) wbData.states[cat.name] = {};
        if (wbData.states[cat.name][id] === ver) return;
        wbData.states[cat.name][id] = ver;
        wblog(">>> @update 拦截: category=" + cat.name + " id='" + id + "' version=" + ver);
        tryInjectWitchBook();
        dbg(">>> onWitchBookUpdate 返回");
    } catch (e) { error("onWitchBookUpdate err: " + e); }
}