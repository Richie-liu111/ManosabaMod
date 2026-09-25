// ============ WitchBook 页面注入域: 注入 Page._loadedDataItemMap + _itemIds + _state + 本地化字典预填 ============
import { A, ensureItemIdsString, fieldIsStringArray, fieldOffset, findAllObjectOfType, findAllObjectOfTypeAll, getGenericArgClass, getSystemClass, invokeBool, invokeOk, listContainsId, makeS, readStr, wblog, dbg, error, warn } from "../utils.js";
import { fileExists } from "../io.js";
import { wbCls, wbData, wbOverrides } from "./state.js";
import { currentModIds, fullLocaleTags, injectVersions, isCurrentModItem, localeValue, pickLocaleText, resolveLocale, wbCats } from "./data.js";
import { clearModItemsFromPage, dictHasIdVer, isVanillaId, readDataItemsIndex } from "./session.js";
import { healStateKeys } from "./dictheal.js";   // 循环引用安全: 只在函数内调用

// 旗标文件 <MOD_ROOT>/.wb_no_override 存在 → 跳过"原版同 id 覆写" (= 上游 AddRichCharacter 语义)。
// 用于 A/B 定位覆写机制是否与崩溃相关; 缓存在首次调用时读一次 (旗标只在启动前有意义)。
var _wbNoOverride = null;
function wbNoOverride() {
    if (_wbNoOverride === null) {
        try {
            _wbNoOverride = (typeof MOD_ROOT !== "undefined" && MOD_ROOT) ? fileExists(MOD_ROOT + "/.wb_no_override") : false;
        } catch (e) { _wbNoOverride = false; }
        if (_wbNoOverride) wblog("WB_NO_OVERRIDE 生效: 跳过原版同 id 覆写 (改名失效)");
    }
    return _wbNoOverride;
}
// VersionedItem<TImage> 的 _id / _idVersionPair 偏移 (按类缓存; 类在会话内不变)
var _viOffCache = {};
function viOffsets(vItemCls) {
    var k = vItemCls.toString(), o = _viOffCache[k];
    if (!o) {
        o = { id: fieldOffset(vItemCls, "_id", 0x10), ivp: fieldOffset(vItemCls, "_idVersionPair", 0x28) };
        _viOffCache[k] = o;
    }
    return o;
}
// 在 _loadedDataItemMap 里找第一个 _id === id 的条目 (返回 VersionedItem 指针; 未命中返回 null)
function findMapEntryPtr(mapList, id, off) {
    try {
        var cnt = mapList.add(0x18).readS32(), arr = mapList.add(0x10).readPointer();
        if (arr.isNull() || cnt < 0 || cnt > 100000) return null;
        for (var i = 0; i < cnt; i++) {
            var e = arr.add(0x20 + i * 8).readPointer();
            if (e.isNull()) continue;
            if (readStr(e.add(off.id).readPointer()) === id) return e;
        }
    } catch (e) {}
    return null;
}
// 覆写换血的幂等判定: 页面 map 里该 id 的那条, 是不是我们上一轮换血注入的那一个?
// 用地址身份而不是版本号 —— mod 覆写的版本号可能与原版完全相同, 版本号区分不了"原版残留"与"我们注入的"。
// 三重身份 (条目地址 + 条目持有的 IdVersionPair 地址 + 页面实例地址) 同时被复用才可能误判, 实际不可能。
// 命中即证明: 原版条目已让位 + 我们的条目在位 → 本轮无需再删再添 (B3)。
function isOverrideInPlace(cat, id, page, mapList, off) {
    var rec = wbOverrides[cat.name][id];
    if (!rec || rec.page !== page.toString()) return false;
    var e = findMapEntryPtr(mapList, id, off);
    if (!e) return false;
    return e.toString() === rec.e && e.add(off.ivp).readPointer().toString() === rec.ivp;
}
// 记账 (地址只做身份比较, 不解引用; 条目由 map 持有 → 只要还命中就必然存活)
function markOverrideInPlace(cat, id, page, mapList, off) {
    var e = findMapEntryPtr(mapList, id, off);
    if (e) wbOverrides[cat.name][id] = { page: page.toString(), e: e.toString(), ivp: e.add(off.ivp).readPointer().toString() };
}
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
                var off2 = viOffsets(vItemCls);
                var idOff2 = off2.id;
                var ids = currentModIds(cat), added = 0, overrideIds = [];
                var oSet = {}, pending = [];
                // 原版 id 判定一次建索引 (否则每条 id 都扫一遍 Data._items: profile 100 条 × 104 = 上万次读)
                var vanillaIdx = readDataItemsIndex(cat);
                // 第一趟: 分类。① 上一轮换血的结果仍在位 → 整条跳过 (幂等, 见 isOverrideInPlace)
                //          ② 原版同 id → 收进 oSet 待换血  ③ 其余 → 待注入
                for (var i = 0; i < ids.length; i++) {
                    var id = ids[i];
                    if (isOverrideInPlace(cat, id, page, mapList, off2)) continue;
                    // override: mod 定义的原版同 id → 移除原版条目再注入 mod 版 (镜像 Windows)
                    if (isVanillaId(cat, id, vanillaIdx)) {
                        // WB_NO_OVERRIDE (旗标文件 <MOD_ROOT>/.wb_no_override): 跳过覆写, 等价上游
                        // ModResourceLoader.AddRichCharacter 的 ContainsId→return (mod 的改名失效, 原版数据不动)。
                        // 用途: A/B 判断覆写机制是否为崩溃触发点; 也是可发布的规避方案。
                        if (wbNoOverride()) { dbg("[WitchBook] WB_NO_OVERRIDE: 跳过原版同 id 覆写 '" + id + "'"); continue; }
                        oSet[id] = 1; overrideIds.push(id);
                    }
                    pending.push(id);
                }
                // 换血合批: clearModItemsFromPage 本就按 id 集合做一趟 (map/dict/_itemIds/_state),
                // 那就传集合调一次, 而不是逐 id 各跑一趟 (旧实现 profile 15 条覆写 = 15 趟 × 每次注入)。
                if (overrideIds.length) clearModItemsFromPage(page, pageCls, oSet);
                // 第二趟: 注入 (原版同 id 的条目此时已让位; 其余 id 由 contains 门控)
                for (var j = 0; j < pending.length; j++) {
                    var pid = pending[j];
                    if (listContainsId(mapList, pid, idOff2)) continue;
                    var n = injectVersions(mapList, addMi, vItemCls, cat, pid, wbData[cat.name][pid], page);
                    if (n > 0 && oSet[pid]) markOverrideInPlace(cat, pid, page, mapList, off2);
                    added += n;
                }
                // 聚合日志 (替代每条 override 一行): 仅 1 条 INFO 覆盖整页 override 情况
                if (overrideIds.length) wblog(cat.name + " override " + overrideIds.length + " 条: " + overrideIds.join(","));
                if (added > 0) wblog(cat.name + "Page._loadedDataItemMap 注入 " + added + " 条 (total=" + mapList.add(0x18).readS32() + ")");
            }
        }
        ensureItemIdsString(page, pageCls);   // macOS: Graphic[]/Canvas[] → String[] (游戏 Contains 才不炸)
        appendItemIds(page, cat);
        applyStates(page, cat);
        ensureStateEntriesDict(page, cat);
        return true;
    } catch (e) { error("injectPage err(" + cat.name + "): " + e); return false; }
}
// 字典自愈 (每次注入末尾): 游戏 LoadDataAsync 会在我们注入之后重建页面, 我们写进 _localizedTextData
// 的条目会随之丢失 → 游戏查 _localizedTextData[map.IdVersionPair] 时 KeyNotFoundException
// (index.js 文件头记的"无预填 → KeyNotFound"是同一个坑)。
// 这里只核对"会被渲染的条目"—— 即 _state 里已设过版本的 id (通常十几条) —— 缺键就补:
// 开销可忽略, 而漏补的后果是整个图鉴打不开。渲染前的兜底还有 RefreshPageContent hook (见下)。
var _lastDictCnt = {};   // catName -> 上次注入后看到的字典条目数 (用于观察游戏是否重建过字典)
export function ensureStateEntriesDict(page, cat) {
    try {
        var pageCls = wbCls.pages[cat.name];
        var outer = page.add(fieldOffset(pageCls, "_localizedTextData", cat.locOff)).readPointer();
        if (outer.isNull()) return 0;
        // 观察点: 字典条目数比上次注入后还少 ⇒ 游戏在我们注入之后重建过它 (取证的直接证据)
        try {
            var cnt = outer.add(0x20).readS32();
            var prev = _lastDictCnt[cat.name];
            if (prev !== undefined && cnt < prev) wblog(cat.name + "._localizedTextData 由 " + prev + " 条降到 " + cnt + " 条 (游戏重建过)");
            _lastDictCnt[cat.name] = cnt;
        } catch (e0) {}
        var stMap = wbData.states[cat.name] || {};
        if (!Object.keys(stMap).length) return 0;
        // 核对"页面即将渲染的键"(_state 里的每条): mod 条目用 mod 文本, 原版条目从游戏 Data 重建。
        // 旧实现只补 mod 条目 (非 mod 直接 continue) —— 原版键缺了不管, 那正是 2026-09-25 图鉴打不开的原因。
        var fixedN = healStateKeys(page, cat);
        if (fixedN) wblog(cat.name + "._localizedTextData 补填 " + fixedN + " 条 (游戏重建过字典)");
        return fixedN;
    } catch (e) { error("ensureStateEntriesDict err: " + e); return 0; }
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
        // 条目数 vs 唯一数: 同一 id 的多个版本在 _itemIds 里各占一条 (游戏自身也是按 map 条目记的),
        // 所以"有重复"本身不代表有重复按钮。打出来是为了下次运行时能直接核对 (A4)。
        var uniq = {};
        for (var u = 0; u < newIds.length; u++) uniq[newIds[u]] = 1;
        wblog(cat.name + "Page._itemIds: +" + appended + " 纯新 ID, 共 " + newIds.length + " (唯一 " + Object.keys(uniq).length + ")");
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
        // 顺带回报 _state._list 的条目数 (B2 待确认项: SetVersion 是否真的写进了 _list。
        // 源码结构: VersionedState 只有 _list 一个存储字段 (List<IdVersionPair>, 各分类 State 无额外字段),
        // 所以"应用 N 条但 _list 恒为 0"只可能是读到别的实例/时机, 这条日志可以一次性判定。)
        var listN = -1;
        try {
            var stList2 = state.add(fieldOffset(wbCls.versionedState, "_list", 0x10)).readPointer();
            if (!stList2.isNull()) listN = stList2.add(0x18).readS32();
        } catch (e2) {}
        wblog(cat.name + "Page 状态应用 " + applied + " 条 (_state._list=" + listN + ")");
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
                var en = ents.add(0x20 + i * 24);
                if (en.readS32() < 0) continue;      // 已删除残留 (hashCode=-1): 它的 value 指针可能是旧对象, 不能拿
                var v = en.add(16).readPointer();
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
        // 诊断: 打字典大小 + 类名, 验证 ivp 字段值
        try {
            // Dictionary 在 0x20 偏移处直接有 count 字段, 绕过 get_Count 的 boxed Int32 调用
            var cnt = -1;
            try { cnt = outer.add(0x20).readS32(); } catch (e) {}
            var ivpId = "?", ivpVer = -1;
            try { ivpId = readStr(b.ivp.add(0x10).readPointer()); } catch (e) {}
            try { ivpVer = b.ivp.add(0x18).readS32(); } catch (e) {}
            var outerClsName = A.cgn(outerCls).readCString();
            dbg("[WitchBook] " + cat.name + " registerDict '" + b.id + "' 进入: dict size=" + cnt + " cls=" + outerClsName + " ivp.Id='" + ivpId + "' ivp.Ver=" + ivpVer);
        } catch (e) {}
        // 重要: 切语言后 RefreshPageContent 会重复触发, 但游戏只会重新读取 _localizedTextData[ivp][locale]
        // 如果只是 ContainsKey=true 就跳过, inner dict 里仍是旧 locale 集 (如只有 zh-Hans),
        // 切到日文后游戏查 inner[ja] → KeyNotFoundException.
        // 解决: 用 indexer set_Item (Add-or-Replace) 替换整个 inner dict, 保证 inner 包含所有 locale.
        var existedOuter = false;
        var ckOuter = A.cgm(outerCls, Memory.allocUtf8String("ContainsKey"), 1);
        if (ckOuter && !ckOuter.isNull()) {
            existedOuter = invokeBool(ckOuter, outer, [b.ivp]);
        }
        dbg("[WitchBook] " + cat.name + " registerDict '" + b.id + "' ContainsKey=" + existedOuter + (existedOuter ? " → 将用 set_Item 替换 inner" : " → 将用 Add 新增"));
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
            // 补全全部游戏语言: 缺的语言回退到已有文本 (pickLocaleText), 防游戏按当前语言查询时 KeyNotFoundException
            var descTags = fullLocaleTags(vrec.desc);
            for (var t2 = 0; t2 < descTags.length; t2++) {
                var lv2 = Memory.alloc(4); lv2.writeS32(localeValue(descTags[t2]));
                invokeOk(addInner, inner, [lv2, makeS(resolveLocale(vrec.desc, descTags[t2]) || pickLocaleText(vrec.desc))]);
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
            // 诊断: 看 vrec 里 name/desc 实际包含的 locale keys
            var f1Keys = f1 ? Object.keys(f1) : [];
            var f2Keys = f2 ? Object.keys(f2) : [];
            dbg("[WitchBook] " + cat.name + " registerDict '" + b.id + "' vrec.name keys=[" + f1Keys.join(",") + "] vrec.desc keys=[" + f2Keys.join(",") + "]");
            // 补全全部游戏语言: vrec 缺的语言用已有文本回退 (pickLocaleText), 防游戏按当前语言查询 KeyNotFoundException
            var tags = fullLocaleTags(f1, f2);
            for (var t = 0; t < tags.length; t++) {
                var lts = A.on(ltsCls);
                var lv = Memory.alloc(4); lv.writeS32(localeValue(tags[t]));
                invokeOk(ltsCtor, lts, [makeS(resolveLocale(f1, tags[t]) || pickLocaleText(f1)), makeS(resolveLocale(f2, tags[t]) || pickLocaleText(f2))]);
                invokeOk(addInner, inner, [lv, lts]);
            }
            dbg("[WitchBook] " + cat.name + " registerDict '" + b.id + "' inner 填 " + tags.length + " locales: " + tags.join(","));
        }
        // 用 indexer set_Item (Add-or-Replace) 替换 inner dict, 保证 inner 包含所有 locale
        // 修: 切语言后 ContainsKey=true 但 inner 仍只有旧 locale 集 → 游戏查新 locale 时 KeyNotFoundException
        var setOuter = A.cgm(outerCls, Memory.allocUtf8String("set_Item"), 2);
        if (setOuter && !setOuter.isNull()) {
            var setR = invokeOk(setOuter, outer, [b.ivp, inner]);
            if (!setR.ok) {
                dbg("[WitchBook] " + cat.name + " registerDict '" + b.id + "' set_Item 失败: " + setR.ex);
            }
        } else {
            // fallback: 不存在则 Add, 已存在则先 Remove 再 Add
            if (existedOuter) {
                var rmOuter = A.cgm(outerCls, Memory.allocUtf8String("Remove"), 1);
                if (rmOuter && !rmOuter.isNull()) invokeOk(rmOuter, outer, [b.ivp]);
            }
            var addOuter = A.cgm(outerCls, Memory.allocUtf8String("Add"), 2);
            if (addOuter && !addOuter.isNull()) {
                var addR = invokeOk(addOuter, outer, [b.ivp, inner]);
                if (!addR.ok) {
                    dbg("[WitchBook] " + cat.name + " registerDict '" + b.id + "' Add 外层失败: " + addR.ex);
                }
            } else {
                dbg("[WitchBook] " + cat.name + " registerDict '" + b.id + "' set_Item/Add 外层方法均未找到");
            }
        }
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
// Hook RefreshPageContent onEnter: 在游戏读 _localizedTextData[map.IdVersionPair] 之前
// 重新预填该 mod 条目. 修 InitializePages→LoadDataAsync 异步重建 map 时清掉注入的问题
// (日志实证: InitializePages onEnter 注入后 800ms 才出现 KeyNotFoundException).
// 仅对当前 mod 的条目执行 (其他条目原版字典已有数据, 不动).
var _refreshHookedPages = {};
export function hookRefreshLocalized() {
    try {
        var catNames = ["clue", "rule", "note", "profile"];  // profile 的字典值是 string, 由 registerLocalizedDict 的 locKind==="str" 分支处理
        for (var i = 0; i < catNames.length; i++) {
            var cat = wbCats[catNames[i]];
            var pageCls = wbCls.pages[cat.name];
            if (!pageCls || pageCls.isNull()) continue;
            if (_refreshHookedPages[cat.name]) continue;
            var mi = A.cgm(pageCls, Memory.allocUtf8String("RefreshPageContent"), 1);
            if (!mi || mi.isNull()) { warn(cat.name + ".RefreshPageContent 未找到"); continue; }
            _refreshHookedPages[cat.name] = 1;
            (function (catN) {
                Interceptor.attach(mi.readPointer(), {
                    onEnter: function (a) {
                        try {
                            var map = a[1];
                            if (!map || map.isNull()) return;
                            var id = readStr(map.add(0x10).readPointer());  // VersionedItem._id
                            if (!id) { dbg("[WitchBook] " + catN + ".RefreshPageContent: map._id 为空"); return; }
                            var isMod = isCurrentModItem(wbCats[catN], id);
                            dbg("[WitchBook] " + catN + ".RefreshPageContent onEnter id='" + id + "' isMod=" + isMod);
                            if (!isMod) return;
                            var ver = map.add(0x18).readS32();  // VersionedItem._version
                            var ivp = map.add(0x28).readPointer();  // VersionedItem._idVersionPair
                            if (ivp.isNull()) { dbg("[WitchBook] " + catN + ".RefreshPageContent: ivp=null, id=" + id); return; }
                            var b = { cat: wbCats[catN], id: id, ver: ver, ivp: ivp };
                            registerLocalizedDict(a[0], b);
                        } catch (e) { dbg("[WitchBook] RefreshPageContent refill err: " + e); }
                    }
                });
            })(cat.name);
            wblog("hook " + cat.name + ".RefreshPageContent onEnter (refill _localizedTextData)");
        }
    } catch (e) { error("hookRefreshLocalized err: " + e); }
}