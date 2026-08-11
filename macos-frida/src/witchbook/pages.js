// ============ WitchBook 页面注入域: 注入 Page._loadedDataItemMap + _itemIds + _state + 本地化字典预填 ============
import { A, ensureItemIdsString, fieldIsStringArray, fieldOffset, findAllObjectOfType, getGenericArgClass, getSystemClass, invokeOk, listContainsId, makeS, readStr, wblog, dbg, error, warn } from "../utils.js";
import { wbCls, wbData, wbOverrides } from "./state.js";
import { currentModIds, injectVersions, localeValue, resolveLocale, unionLocaleKeys } from "./data.js";
import { clearModItemsFromPage, isVanillaId } from "./session.js";

// 2) 注入 Page._loadedDataItemMap + _itemIds + _state
export function injectPage(cat) {
    try {
        var pageCls = wbCls.pages[cat.name];
        var pages = findAllObjectOfType(pageCls);
        if (!pages.length) {
            var st = Object.keys(wbData.states[cat.name] || {});
            for (var i = 0; i < st.length; i++) wbData.pendingStates[cat.name][st[i]] = wbData.states[cat.name][st[i]];
            return false;
        }
        var page = pages[0];
        var mapOff = fieldOffset(pageCls, "_loadedDataItemMap", 0x88);
        var mapList = page.add(mapOff).readPointer();
        if (!mapList.isNull()) {
            var listCls = A.ogc(mapList);
            var vItemCls = getGenericArgClass(listCls, 0);
            var addMi = A.cgm(listCls, Memory.allocUtf8String("Add"), 1);
            if (!vItemCls.isNull() && addMi && !addMi.isNull()) {
                var idOff2 = fieldOffset(vItemCls, "_id", 0x10);
                var ids = currentModIds(cat), added = 0;
                for (var i = 0; i < ids.length; i++) {
                    var id = ids[i];
                    // override: mod 定义的原版同 id → 移除原版条目再注入 mod 版 (镜像 Windows)
                    if (isVanillaId(cat, id)) {
                        var oSet = {}; oSet[id] = 1;
                        clearModItemsFromPage(page, pageCls, oSet);
                        wbOverrides[cat.name][id] = true;
                        wblog(cat.name + " override '" + id + "' → 移除原版, 注入 mod 版");
                    }
                    if (listContainsId(mapList, id, idOff2)) continue;
                    added += injectVersions(mapList, addMi, vItemCls, cat, id, wbData[cat.name][id], page);
                }
                if (added > 0) wblog(cat.name + "Page._loadedDataItemMap 注入 " + added + " 条 (total=" + mapList.add(0x18).readS32() + ")");
            }
        }
        ensureItemIdsString(page, pageCls);   // macOS: Graphic[]/Canvas[] → String[] (游戏 Contains 才不炸)
        appendItemIds(page, cat);
        applyStates(page, cat);
        return true;
    } catch (e) { error("injectPage err(" + cat.name + "): " + e); return false; }
}
// 向 _itemIds (string[]) 追加纯新 mod ID (原版 UpdateVersion 检查 Contains)
export function appendItemIds(page, cat) {
    try {
        var pageCls = wbCls.pages[cat.name];
        // macOS 守卫: _itemIds 运行时可能是 Graphic[]/Canvas[] (泛型共享实例化差异), 非 String[] 绝不写入
        if (!fieldIsStringArray(page, pageCls, "_itemIds")) { warn(cat.name + "Page._itemIds 非 String[] (macOS 泛型共享), 跳过追加"); return; }
        var idsField = fieldOffset(pageCls, "_itemIds", 0x98);
        var old = page.add(idsField).readPointer();
        var newIds = [];
        if (!old.isNull()) {
            var oldLen = old.add(0x18).readS32();
            for (var i = 0; i < oldLen; i++) {
                var s = readStr(old.add(0x20 + i * 8).readPointer());
                if (s) newIds.push(s);
            }
        }
        var keys = currentModIds(cat), appended = 0;
        for (var i = 0; i < keys.length; i++) {
            if (newIds.indexOf(keys[i]) === -1) { newIds.push(keys[i]); appended++; }
        }
        if (!appended) return;
        var strCls = getSystemClass("String");
        var arr = A.an(strCls, newIds.length);
        for (var i = 0; i < newIds.length; i++) arr.add(0x20 + i * 8).writePointer(makeS(newIds[i]));
        page.add(idsField).writePointer(arr);
        wblog(cat.name + "Page._itemIds: +" + appended + " 纯新 ID, 共 " + newIds.length);
    } catch (e) { error("appendItemIds err: " + e); }
}
// 3) 状态: _state.SetVersion (各 State 都是 VersionedState 子类, 同步方法可 runtime_invoke)
export function applyStates(page, cat) {
    try {
        var pageCls = wbCls.pages[cat.name];
        var stateOff = fieldOffset(pageCls, "_state", 0x48);
        var state = page.add(stateOff).readPointer();
        if (state.isNull()) return;
        var setMi = A.cgm(wbCls.versionedState, Memory.allocUtf8String("SetVersion"), 2);
        if (!setMi || setMi.isNull()) return;
        var stMap = wbData.states[cat.name] || {};
        var ids = Object.keys(stMap), applied = 0;
        for (var i = 0; i < ids.length; i++) {
            var vbuf = Memory.alloc(4); vbuf.writeS32(stMap[ids[i]]);
            if (invokeOk(setMi, state, [makeS(ids[i]), vbuf]).ok) applied++;
        }
        var pend = wbData.pendingStates[cat.name] || {};
        var pkeys = Object.keys(pend);
        for (var i = 0; i < pkeys.length; i++) {
            var vbuf2 = Memory.alloc(4); vbuf2.writeS32(pend[pkeys[i]]);
            if (invokeOk(setMi, state, [makeS(pkeys[i]), vbuf2]).ok) { applied++; stMap[pkeys[i]] = pend[pkeys[i]]; }
        }
        wbData.pendingStates[cat.name] = {};
        wblog(cat.name + "Page 状态应用 " + applied + " 条");
    } catch (e) { error("applyStates err: " + e); }
}

// 显示层: 预填 CluePage._localizedTextData (IReadOnlyDictionary<IdVersionPair, IReadOnlyDictionary<LocaleKind, LocalizedTexts>>)
// 键用与 VersionedItem._idVersionPair 同一 IdVersionPair 实例 → 原版 RefreshPageContent/SetupItemButton
// 查 _localizedTextData[map.IdVersionPair] 命中, 不再 KeyNotFoundException。
export function getFirstDictValue(dict) {
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
export function registerLocalizedDict(page, b) {
    var cat = b.cat;
    var pageCls = wbCls.pages[cat.name];
    try {
        var dictField = fieldOffset(pageCls, "_localizedTextData", cat.locOff);
        var outer = page.add(dictField).readPointer();
        if (outer.isNull()) { warn(cat.name + "._localizedTextData 为 null, 跳过 '" + b.id + "'"); return; }
        var outerCls = A.ogc(outer);
        // 从现有值偷内层字典的具体实现类 (不能用泛型参数: 那是 IReadOnlyDictionary 接口, object_new 会崩)
        var sample = getFirstDictValue(outer);
        if (!sample) { warn(cat.name + "._localizedTextData 无现有值, 跳过 '" + b.id + "'"); return; }
        var innerCls = A.ogc(sample);
        var innerName = A.cgn(innerCls).readCString();
        var addInner = A.cgm(innerCls, Memory.allocUtf8String("Add"), 2);
        if (!addInner || addInner.isNull()) { warn("内层字典无 Add (" + innerName + "), 跳过 '" + b.id + "'"); return; }
        var vrec = wbData[cat.name][b.id].versions[String(b.ver)];
        if (!vrec) return;
        var inner = A.on(innerCls);
        if (!invokeOk(A.cgm(innerCls, Memory.allocUtf8String(".ctor"), 0), inner, []).ok) { warn("内层字典 ctor 失败 '" + b.id + "'"); return; }
        if (cat.locKind === "str") {
            // Profile: Dictionary<LocaleKind, string> — 值 = 描述字符串
            var descTags = unionLocaleKeys(vrec.desc);
            for (var t2 = 0; t2 < descTags.length; t2++) {
                var lv2 = Memory.alloc(4); lv2.writeS32(localeValue(descTags[t2]));
                invokeOk(addInner, inner, [lv2, makeS(resolveLocale(vrec.desc, descTags[t2]))]);
            }
        } else {
            // Clue/Rule/Note: Dictionary<LocaleKind, Xxx.LocalizedTexts> — 值 = 二元组
            var ltsCls = wbCls.lts[cat.name];
            if (!ltsCls || ltsCls.isNull()) {
                try { var ifaceCls = getGenericArgClass(outerCls, 1); if (!ifaceCls.isNull()) ltsCls = getGenericArgClass(ifaceCls, 1); } catch (e) {}
            }
            var ltsCtor = (ltsCls && !ltsCls.isNull()) ? A.cgm(ltsCls, Memory.allocUtf8String(".ctor"), 2) : null;
            if (!ltsCls || ltsCls.isNull() || !ltsCtor || ltsCtor.isNull()) { warn(cat.name + ".LocalizedTexts 类/ctor 未找到, 跳过 '" + b.id + "'"); return; }
            var f1 = null, f2 = null;
            if (cat.name === "clue") { f1 = vrec.name; f2 = vrec.desc; }         // (Name, Description)
            else if (cat.name === "rule") { f1 = vrec.subtitle; f2 = vrec.desc; } // (Subtitle, Description)
            else if (cat.name === "note") { f1 = vrec.title; f2 = vrec.desc; }   // (Title, Description)
            var tags = unionLocaleKeys(f1, f2);
            for (var t = 0; t < tags.length; t++) {
                var lts = A.on(ltsCls);
                var lv = Memory.alloc(4); lv.writeS32(localeValue(tags[t]));
                invokeOk(ltsCtor, lts, [makeS(resolveLocale(f1, tags[t])), makeS(resolveLocale(f2, tags[t]))]);
                invokeOk(addInner, inner, [lv, lts]);
            }
        }
        var addOuter = A.cgm(outerCls, Memory.allocUtf8String("Add"), 2);
        if (addOuter && !addOuter.isNull()) invokeOk(addOuter, outer, [b.ivp, inner]);
        // Rule 额外: _numberings 字典 (IdVersionPair → string)
        if (cat.name === "rule") {
            try {
                var numField = fieldOffset(pageCls, "_numberings", 0xE0);
                var numDict = page.add(numField).readPointer();
                if (!numDict.isNull()) {
                    var numCls = A.ogc(numDict);
                    var addNum = A.cgm(numCls, Memory.allocUtf8String("Add"), 2);
                    if (addNum && !addNum.isNull()) invokeOk(addNum, numDict, [b.ivp, makeS(vrec.numbering || "")]);
                }
            } catch (e) {}
        }
        dbg(cat.name + "._localizedTextData 预填 '" + b.id + "' v" + b.ver + " (" + innerName + ")");
    } catch (e) { error("registerLocalizedDict err '" + b.id + "': " + e); }
}
