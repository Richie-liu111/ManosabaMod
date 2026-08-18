// ============ WitchBook 会话隔离域: mod 切换检测 / 整页重建 / 状态清理 / 面板默认值 ============
// 镜像 Windows ModClueLoader + ModWitchBookPatch: mod 切换/回标题时从原版基座重建, 防残留继承
import { A, ensureItemIdsString, fieldIsStringArray, fieldOffset, findAllObjectOfType, findFirstObjectOfType, findSvc, getGenericArgClass, getSystemClass, invoke, invokeOk, listContainsId, makeS, readStr, wblog, error, warn } from "../utils.js";
import { wbCats, currentModSet, localeValue, makeIdVersionPair, unionLocaleKeys } from "./data.js";
import { initCatStateMaps, setWbCurrentMod, setWbDefaultsCaptured, setWbPrevMod, wbCls, wbCurrentMod, wbData, wbDefaultsCaptured, wbPageDefaults, wbVanillaMap } from "./state.js";
import { getFirstDictValue } from "./pages.js";
import { tryInjectWitchBook } from "./index.js";

// 从 ScriptLoader.Load 的路径识别当前 mod (匹配 modList 的 Enter; 原版默认路径 → __vanilla__)
// mod 变化时立即清理上一 mod 的残留 (页面若存在) 并注入当前 mod 目录
export function detectCurrentMod(path) {
    if (!path) return;
    var next = null;
    if (typeof modList !== "undefined" && modList) {
        for (var i = 0; i < modList.length; i++) {
            if (path === modList[i].Enter) { next = modList[i].key; break; }
        }
    }
    if (!next && path === "Act01_Chapter01/Act01_Chapter01_Adv01") next = "__vanilla__";
    if (next === null || next === wbCurrentMod) return;
    setWbCurrentMod(next);
    wblog("当前 mod: '" + wbCurrentMod + "' (Enter=" + path + ")");
    try { if (wbCls && wbCls.pages) tryInjectWitchBook(); } catch (e) {}
}
export function resetWitchBookSession() {
    setWbCurrentMod(null); setWbPrevMod(null);
    wbData.states = {}; wbData.pendingStates = {}; wbData.texCache = {};
    initCatStateMaps();
    // 整页重建 (回原版基座) + 重置状态/面板 (防止残留继承)
    try {
        if (wbCls && wbCls.pages) {
            rebuildAllPages();
            clearBookViaVanilla();
            clearAllWitchBookPages();
        }
    } catch (e) {}
    wblog("会话重置 (回标题)");
}
// ===== Override 处理: mod 定义的原版同 id 条目应覆盖原版显示 (镜像 Windows modXxxOverrideIds) =====
// 检测 id 是否为原版 (存在于 Data._items, 而非仅 mod 注入)
export function isVanillaId(cat, id) {
    try {
        var dataCls = wbCls.datas[cat.name];
        if (!dataCls || dataCls.isNull()) return false;
        var inst = findFirstObjectOfType(dataCls);
        if (!inst) return false;
        var items = inst.add(fieldOffset(dataCls, "_items", 0x18)).readPointer();
        if (items.isNull()) return false;
        var listCls = A.ogc(items);
        var vItemCls = getGenericArgClass(listCls, 0);
        var idOff = fieldOffset(vItemCls, "_id", 0x10);
        return listContainsId(items, id, idOff);
    } catch (e) { return false; }
}
// 把 vanilla Data 里 id∈ids 的条目恢复到页面 (map + _localizedTextData + _itemIds)
// 重建 _itemIds (string[]) — 从当前 map 内容提取全部 id
export function rebuildItemIdsFromMap(page, pageCls, mapList, vItemCls, idOff) {
    try {
        var ids = [];
        var cnt = mapList.add(0x18).readS32(), arr = mapList.add(0x10).readPointer();
        for (var i = 0; i < cnt; i++) {
            var e = arr.add(0x20 + i * 8).readPointer();
            if (e.isNull()) continue;
            var id = readStr(e.add(idOff).readPointer());
            if (id && ids.indexOf(id) === -1) ids.push(id);
        }
        // macOS 守卫: 先修复泛型共享实例化差异 (Graphic[]/Canvas[] → String[]), 再写
        ensureItemIdsString(page, pageCls);
        var strCls = getSystemClass("String");
        var narr = A.an(strCls, ids.length);
        for (var i = 0; i < ids.length; i++) narr.add(0x20 + i * 8).writePointer(makeS(ids[i]));
        page.add(fieldOffset(pageCls, "_itemIds", 0x98)).writePointer(narr);
    } catch (e) {}
}
// 字典是否已有 (id, version) 条目 (IdVersionPair: Id@0x10, Version@0x18)
export function dictHasIdVer(dict, id, ver) {
    try {
        var ents = dict.add(0x18).readPointer();
        if (ents.isNull()) return false;
        var cnt = ents.add(0x18).readS32();
        for (var i = 0; i < cnt; i++) {
            try {
                var en = ents.add(0x20 + i * 24);
                var k = en.add(8).readPointer();
                if (k.isNull()) continue;
                if (readStr(k.add(0x10).readPointer()) === id && k.add(0x18).readS32() === ver) return true;
            } catch (e2) {}
        }
    } catch (e) {}
    return false;
}
// 整页重建: 清空页面 _loadedDataItemMap, 从捕获的原版快照重添全部条目,
// 重建 _itemIds, 并为缺 dict 项的条目补建。mod 切换/回标题时调用 → 每次会话从原版基座开始。
export function restorePageFromData(page, pageCls, cat) {
    try {
        var snap = wbVanillaMap[cat.name];
        var ptrs = snap ? snap.items : null;
        if (!ptrs || !ptrs.length) { warn(cat.name + " 整页重建跳过 (快照未捕获)"); return; }
        var mapList = page.add(fieldOffset(pageCls, "_loadedDataItemMap", 0x88)).readPointer();
        if (mapList.isNull()) return;
        var mapListCls = A.ogc(mapList);
        var clMi = A.cgm(mapListCls, Memory.allocUtf8String("Clear"), 0);
        if (clMi && !clMi.isNull()) invokeOk(clMi, mapList, []);
        var addMi = A.cgm(mapListCls, Memory.allocUtf8String("Add"), 1);
        var added = 0;
        for (var i = 0; i < ptrs.length; i++) {
            if (addMi && !addMi.isNull()) { if (invokeOk(addMi, mapList, [ptrs[i]]).ok) added++; }
        }
        // 从 map 的 vItemCls 取字段偏移
        var vItemCls = getGenericArgClass(A.ogc(mapList), 0);
        var idOff = fieldOffset(vItemCls, "_id", 0x10);
        var verOff = fieldOffset(vItemCls, "_version", 0x18);
        rebuildItemIdsFromMap(page, pageCls, mapList, vItemCls, idOff);
        // 补 dict: 检查每个 map 条目是否有 dict 项 (override 移除过的 id 需重建)
        try {
            var outer = page.add(fieldOffset(pageCls, "_localizedTextData", cat.locOff)).readPointer();
            if (!outer.isNull()) {
                var mc = mapList.add(0x18).readS32(), marr = mapList.add(0x10).readPointer();
                for (var j = 0; j < mc; j++) {
                    var mvi = marr.add(0x20 + j * 8).readPointer();
                    if (mvi.isNull()) continue;
                    var mid = readStr(mvi.add(idOff).readPointer());
                    if (!mid) continue;
                    if (!dictHasIdVer(outer, mid, mvi.add(verOff).readS32())) restoreVanillaDict(page, pageCls, cat, mvi, vItemCls);
                }
            }
        } catch (e2) {}
        wblog(cat.name + " 整页重建: " + added + " 条 (原版基座)");
    } catch (e) { error("restorePageFromData err: " + e); }
}
// 对所有分类页面做整页重建 (mod 切换/回标题时调用)
export function rebuildAllPages() {
    try {
        var pages = findAllPages();
        if (!pages.length) return;
        var cats = Object.keys(wbCats);
        for (var ci = 0; ci < cats.length; ci++) {
            var cat = wbCats[cats[ci]];
            for (var pi = 0; pi < pages.length; pi++) {
                try {
                    var pc = A.ogc(pages[pi]);
                    if (A.cgn(pc).readCString() !== cat.page) continue;
                    restorePageFromData(pages[pi], pc, cat);
                } catch (e) {}
            }
        }
    } catch (e) { error("rebuildAllPages err: " + e); }
}
// 为恢复的原版条目构建 _localizedTextData 字典项
export function restoreVanillaDict(page, pageCls, cat, vi, vItemCls) {
    try {
        var id = readStr(vi.add(fieldOffset(vItemCls, "_id", 0x10)).readPointer());
        var ver = vi.add(fieldOffset(vItemCls, "_version", 0x18)).readS32();
        var item = vi.add(fieldOffset(vItemCls, "_item", 0x20)).readPointer();
        var ivp = vi.add(fieldOffset(vItemCls, "_idVersionPair", 0x28)).readPointer();
        if (ivp.isNull()) ivp = makeIdVersionPair(id, ver);
        var outer = page.add(fieldOffset(pageCls, "_localizedTextData", cat.locOff)).readPointer();
        if (outer.isNull()) return;
        var outerCls = A.ogc(outer);
        var sample = getFirstDictValue(outer);
        if (!sample) return;
        var innerCls = A.ogc(sample);
        var addInner = A.cgm(innerCls, Memory.allocUtf8String("Add"), 2);
        var inner = A.on(innerCls);
        if (!invokeOk(A.cgm(innerCls, Memory.allocUtf8String(".ctor"), 0), inner, []).ok) return;
        // 读 DataItem 的 LocalizedText[] 字段
        var lts = readLocalizedArray(item, cat.name === "clue" ? 0x10 : cat.name === "profile" ? 0x10 : cat.name === "rule" ? 0x18 : 0x10);
        if (cat.name === "profile") {
            // Dictionary<LocaleKind, string>
            var keys = Object.keys(lts);
            for (var i = 0; i < keys.length; i++) {
                var lv = Memory.alloc(4); lv.writeS32(localeValue(keys[i]));
                invokeOk(addInner, inner, [lv, makeS(lts[keys[i]])]);
            }
        } else {
            var lts2 = readLocalizedArray(item, cat.name === "rule" ? 0x20 : 0x18);
            var ltsCls = wbCls.lts[cat.name];
            var ltsCtor = (ltsCls && !ltsCls.isNull()) ? A.cgm(ltsCls, Memory.allocUtf8String(".ctor"), 2) : null;
            var keys2 = unionLocaleKeys(lts, lts2);
            for (var i = 0; i < keys2.length; i++) {
                var lt = A.on(ltsCls);
                var lv2 = Memory.alloc(4); lv2.writeS32(localeValue(keys2[i]));
                if (ltsCtor && !ltsCtor.isNull()) invokeOk(ltsCtor, lt, [makeS(lts[keys2[i]] || ""), makeS(lts2[keys2[i]] || "")]);
                invokeOk(addInner, inner, [lv2, lt]);
            }
        }
        var addOuter = A.cgm(outerCls, Memory.allocUtf8String("Add"), 2);
        if (addOuter && !addOuter.isNull()) invokeOk(addOuter, outer, [ivp, inner]);
    } catch (e) { error("restoreVanillaDict err: " + e); }
}
// 读 LocalizedText[] (LocalizedText: _locale@0x10 int, _text@0x18 string) → {localeTag: text}
export function readLocalizedArray(arrPtr, off) {
    var out = {};
    try {
        if (!arrPtr || arrPtr.isNull()) return out;
        var arr = arrPtr.add(off).readPointer();
        if (arr.isNull()) return out;
        var len = arr.add(0x18).readS32();
        for (var i = 0; i < len; i++) {
            var lt = arr.add(0x20 + i * 8).readPointer();
            if (lt.isNull()) continue;
            var loc = lt.add(0x10).readS32();
            var text = readStr(lt.add(0x18).readPointer()) || "";
            var tag = "zh-Hans";
            switch (loc) { case 0: tag = "ja"; break; case 1: tag = "en-US"; break; case 2: tag = "zh-Hans"; break; case 3: tag = "zh-Hant"; break; case 4: tag = "ko"; break; case 5: tag = "fr"; break; case 6: tag = "es"; break; }
            out[tag] = text;
        }
    } catch (e) {}
    return out;
}
// 从页面结构中移除指定 id 的条目 (mod 切换时清理旧 mod 数据; pageCls 区分各分类页面)
export function clearModItemsFromPage(page, pageCls, idSet) {
    try {
        var removed = 0;
        // 1) _loadedDataItemMap (List): 收集要移除的索引, 倒序 RemoveAt
        var mapOff = fieldOffset(pageCls, "_loadedDataItemMap", 0x88);
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
        var dictField = fieldOffset(pageCls, "_localizedTextData", 0xD0);
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
        // 3) _itemIds: 重建 (先修复泛型共享实例化差异, 再按 idSet 过滤)
        if (ensureItemIdsString(page, pageCls)) {
            var idsField = fieldOffset(pageCls, "_itemIds", 0x98);
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
        }
        // 4) _state._list (List<IdVersionPair>): 移除 Id ∈ idSet
        removeStateEntries(page, pageCls, idSet);
        // 5) 清当前选中项 (_currentItemId) → 上方面板不再残留
        try {
            var curOff = fieldOffset(pageCls, "_currentItemId", 0xA0);
            page.add(curOff).writePointer(makeS(""));
        } catch (e) {}
        if (removed > 0) wblog("清除旧 mod 条目 " + removed + " 条");
    } catch (e) { error("clearModItemsFromPage err: " + e); }
}
// 从 _state._list 移除指定 id 的状态 (IdVersionPair.Id @+0x10)
export function removeStateEntries(page, pageCls, idSet) {
    try {
        var stOff = fieldOffset(pageCls, "_state", 0x48);
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
    } catch (e) { error("removeStateEntries err: " + e); }
}
// 清空页面 _state (仅保留 keepSet; keepSet=null 清空全部)
export function clearPageState(page, keepSet) {
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
    } catch (e) { error("clearPageState err: " + e); }
}
// 面板默认值捕获/恢复: 页面首次出现(未被 mod 触碰)时读取原版默认文本+默认图,
// 清空时恢复 → 空图鉴显示原版默认态 (占位图+默认文字), 而不是纯白空白
export function capturePageDefaults(page) {
    try {
        var cls = A.ogc(page);
        var key = cls.toString();
        if (wbPageDefaults[key]) return;
        var pageCls = cls, clsName = A.cgn(pageCls).readCString();
        var d = { labels: {}, defaultTex: ptr(0) };
        var labelFields = (clsName === "CluePage") ? ["_subjectLabel", "_descriptionLabel"] :
                          (clsName === "ProfilePage") ? ["_authorLabel", "_descriptionLabel"] :
                          (clsName === "RulePage") ? ["_titleNumLabel", "_subtitleLabel", "_descriptionLabel"] :
                          (clsName === "NotePage") ? ["_titleLabel", "_descriptionLabel"] : [];
        labelFields.forEach(function (fn) {
            try {
                var f = A.gf(pageCls, Memory.allocUtf8String(fn));
                if (!f || f.isNull()) return;
                var lab = page.add(A.fo(f)).readPointer();
                if (lab.isNull()) return;
                // WitchBookItemSubjectLabel 内部是 _label (TMP_Text)
                var tmp = lab;
                if (fn === "_subjectLabel") {
                    var lf = A.gf(wbCls.witchBookItemSubjectLabel, Memory.allocUtf8String("_label"));
                    if (lf && !lf.isNull()) tmp = lab.add(A.fo(lf)).readPointer();
                    if (tmp.isNull()) tmp = lab;
                }
                var labCls = A.ogc(tmp);
                var gt = A.cgm(labCls, Memory.allocUtf8String("get_text"), 0);
                if (gt && !gt.isNull()) {
                    var t = invoke(gt, tmp, []);
                    d.labels[fn] = readStr(t) || "";
                }
            } catch (e) {}
        });
        // 缩略图默认纹理 (_defaultTexture)
        try {
            var thf = A.gf(pageCls, Memory.allocUtf8String("_thumbnail"));
            if (thf && !thf.isNull()) {
                var th = page.add(A.fo(thf)).readPointer();
                if (!th.isNull()) {
                    var dtf = A.gf(wbCls.witchBookItemThumbnail, Memory.allocUtf8String("_defaultTexture"));
                    if (dtf && !dtf.isNull()) d.defaultTex = th.add(A.fo(dtf)).readPointer();
                }
            }
        } catch (e) {}
        wbPageDefaults[key] = d;
        wblog("已捕获 " + clsName + " 面板默认值 (" + Object.keys(d.labels).length + " 标签)");
    } catch (e) { error("capturePageDefaults err: " + e); }
}
export function restorePageDefaults(page) {
    try {
        var cls = A.ogc(page);
        var d = wbPageDefaults[cls.toString()];
        if (!d) return;
        var pageCls = cls, clsName = A.cgn(pageCls).readCString();
        var labels = Object.keys(d.labels);
        labels.forEach(function (fn) {
            try {
                var f = A.gf(pageCls, Memory.allocUtf8String(fn));
                if (!f || f.isNull()) return;
                var lab = page.add(A.fo(f)).readPointer();
                if (lab.isNull()) return;
                var tmp = lab;
                if (fn === "_subjectLabel") {
                    var lf = A.gf(wbCls.witchBookItemSubjectLabel, Memory.allocUtf8String("_label"));
                    if (lf && !lf.isNull()) tmp = lab.add(A.fo(lf)).readPointer();
                    if (tmp.isNull()) tmp = lab;
                }
                var labCls = A.ogc(tmp);
                var mi = A.cgm(labCls, Memory.allocUtf8String("set_text"), 1);
                if (mi && !mi.isNull()) invokeOk(mi, tmp, [makeS(d.labels[fn])]);
            } catch (e) {}
        });
        try {
            var thf = A.gf(pageCls, Memory.allocUtf8String("_thumbnail"));
            if (thf && !thf.isNull()) {
                var th = page.add(A.fo(thf)).readPointer();
                if (!th.isNull() && d.defaultTex && !d.defaultTex.isNull()) {
                    var raw = th.add(fieldOffset(wbCls.witchBookItemThumbnail, "_rawImage", 0x28)).readPointer();
                    if (!raw.isNull()) {
                        var rc = A.ogc(raw);
                        var mi = A.cgm(rc, Memory.allocUtf8String("set_texture"), 1);
                        if (mi && !mi.isNull()) invokeOk(mi, raw, [d.defaultTex]);
                    }
                }
            }
        } catch (e) {}
        try { page.add(0xA0).writePointer(makeS("")); } catch (e) {}   // _currentItemId 不恢复, 始终清空
        wblog("已恢复 " + clsName + " 面板默认值");
    } catch (e) { error("restorePageDefaults err: " + e); }
}
export function findAllPages() {
    // 用具体页面类遍历 (基类 WitchBookPageBase 有泛型/非泛型两个, FindObjectsOfType 不稳定)
    var out = [];
    if (!wbCls || !wbCls.pages) return out;
    var pn = Object.keys(wbCls.pages);
    for (var i = 0; i < pn.length; i++) {
        var cls = wbCls.pages[pn[i]];
        if (!cls || cls.isNull()) continue;
        var pages = findAllObjectOfType(cls);
        for (var j = 0; j < pages.length; j++) out.push(pages[j]);
    }
    // 首次见到页面即捕获默认值 + 原版 map 基座 (此时未被 mod 触碰, 处于原版默认态)
    if (!wbDefaultsCaptured && out.length) {
        for (var k = 0; k < out.length; k++) { try { capturePageDefaults(out[k]); } catch (e) {} }
        setWbDefaultsCaptured(true);
    }
    // 捕获原版 _loadedDataItemMap 快照 (整页重建的基座; 不依赖 Data 加载时机)
    // 按页面实例捕获: 页面重建(新实例)时重新捕获
    for (var c = 0; c < out.length; c++) {
        try {
            var ccls = A.ogc(out[c]);
            var ccn = A.cgn(ccls).readCString();
            for (var cc = 0; cc < Object.keys(wbCats).length; cc++) {
                var ccat = wbCats[Object.keys(wbCats)[cc]];
                if (ccat.page !== ccn) continue;
                if (wbVanillaMap[ccat.name] && wbVanillaMap[ccat.name].page === out[c].toString()) break;
                var mlist = out[c].add(fieldOffset(ccls, "_loadedDataItemMap", 0x88)).readPointer();
                if (mlist.isNull()) break;
                var mcnt = mlist.add(0x18).readS32(), marr = mlist.add(0x10).readPointer();
                var ptrs = [];
                for (var mi = 0; mi < mcnt; mi++) { var e = marr.add(0x20 + mi * 8).readPointer(); if (e && !e.isNull()) ptrs.push(e); }
                wbVanillaMap[ccat.name] = { page: out[c].toString(), items: ptrs };
                wblog(ccat.name + " 捕获原版基座 " + ptrs.length + " 条");
            }
        } catch (e) {}
    }
    return out;
}
// 清状态 + 恢复原版默认面板 — 仅 mod 切换/会话重置时调用
// 各页面按其分类保留当前 mod 的条目; 其余 (原版/他 mod) 清空; 面板恢复原版默认
export function clearAllWitchBookPages() {
    try {
        if (!wbCurrentMod || wbCurrentMod === "__vanilla__") return;   // 原版剧情不干预
        var pages = findAllPages();
        for (var i = 0; i < pages.length; i++) {
            try {
                var cn = A.cgn(A.ogc(pages[i])).readCString();
                var cat = null;
                var cn2 = Object.keys(wbCats);
                for (var j = 0; j < cn2.length; j++) { if (wbCats[cn2[j]].page === cn) { cat = wbCats[cn2[j]]; break; } }
                var keep = cat ? currentModSet(cat) : null;
                clearPageState(pages[i], keep);
                restorePageDefaults(pages[i]);
            } catch (e) {}
        }
    } catch (e) { error("clearAllWitchBookPages err: " + e); }
}
export function findWitchBookUi() {
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
export function clearBookViaVanilla() {
    try {
        var ui = findWitchBookUi();
        if (!ui) { warn("clearBook: WitchBookUi 未找到"); return; }
        var mi = A.cgm(wbCls.witchBookUi, Memory.allocUtf8String("ClearState"), 1);
        if (!mi || mi.isNull()) { warn("clearBook: ClearState NOT FOUND"); return; }
        for (var c = 0; c <= 4; c++) {   // Clue=0 Profile=1 Map=2 Rule=3 Note=4
            var cb = Memory.alloc(4); cb.writeS32(c);
            invokeOk(mi, ui, [cb]);
        }
        wblog("clearBook: WitchBookUi.ClearState 全部 5 分类已调用");
    } catch (e) { error("clearBook err: " + e); }
}
// 挂钩游戏 @clearBook (ClearWitchBook 命令) 的完整语义:
// 游戏侧 ClearState 只重置页面 _state (已获得版本), mod 的 wbData.states 不清 → 图鉴下次打开
// applyStates (tryInjectWitchBook → injectPage) 会把自定义条目重新 SetVersion 点亮 → 清不掉。
// 佐证: 原版 10-1 (同在 map) 能清掉 → 列表受 _state 门控, 自定义条目是"被 mod 复活"才残留。
// 挂钩 WitchBookUi/WitchBookScreen.ClearState(category) onLeave:
//   ① 清 wbData.states/pendingStates[分类] → applyStates 无可复活
//   ② restorePageDefaults 复位该页面原版默认面板 (标签/缩略图/_currentItemId) → 上方面板不再冻结旧文本
// 幂等 (WitchBookUi 内部会调 WitchBookScreen, 双 hook 各触发一次无害)。
var _clearStateHooked = false;
export function hookClearState() {
    try {
        if (_clearStateHooked) return;
        _clearStateHooked = true;
        var idxName = { 0: "clue", 1: "profile", 3: "rule", 4: "note" };
        var handle = function (catIdx) {
            try {
                var catName = idxName[catIdx];
                if (!catName) return;
                if (wbData.states[catName]) wbData.states[catName] = {};
                if (wbData.pendingStates[catName]) wbData.pendingStates[catName] = {};
                var cat = wbCats[catName];
                var pages = findAllPages();
                for (var i = 0; i < pages.length; i++) {
                    try {
                        var pc = A.ogc(pages[i]);
                        if (A.cgn(pc).readCString() !== cat.page) continue;
                        restorePageDefaults(pages[i]);
                    } catch (e2) {}
                }
                wblog("ClearState 挂钩: '" + catName + "' 状态已清 + 面板复位");
            } catch (e) { error("clearStateHook err: " + e); }
        };
        ["witchBookUi", "witchBookScreen"].forEach(function (field) {
            try {
                var cls = wbCls[field];
                if (!cls || cls.isNull()) return;
                var mi = A.cgm(cls, Memory.allocUtf8String("ClearState"), 1);
                if (!mi || mi.isNull()) return;
                Interceptor.attach(mi.readPointer(), {
                    onEnter: function (args) { this._cat = args[1].toInt32(); },
                    onLeave: function () { try { handle(this._cat); } catch (e) {} }
                });
                wblog("hook " + A.cgn(cls).readCString() + ".ClearState(category)");
            } catch (e) {}
        });
    } catch (e) { error("hookClearState err: " + e); }
}
