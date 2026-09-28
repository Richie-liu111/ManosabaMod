// ============ 页面字典补全 (WitchBook 5 个页面的 _localizedTextData) ============
// 背景 (2026-09-25 图鉴打不开的根因, 已实证):
//   页面字典 `_localizedTextData` 是 `Dictionary<IdVersionPair, …>`, 而 IdVersionPair 的**实际匹配是
//   按实例**的 (identity 哈希): 我们自己 new 一个"值相等"的 IdVersionPair 去当键, 游戏的查询**查不到**。
//   两个后果:
//     ① 整页重建 (restorePageFromData) 时用新建的包装对象替换原版条目 → 游戏拿 map.IdVersionPair 查字典
//        必然 MISS → KeyNotFoundException → 一打开图鉴就抛 (实证 id='10-1' version=2)。
//     ② 我们所有"键在不在"的判定基于值相等 → 全部误报"存在" → 每一层自愈都静默跳过。
//   修法见 session.js: buildVanillaItem 侧沿用字典里的键实例 + writeLocalizedDictEntry 内部优先复用
//   字典已有的键实例。本模块只保留"缺了就补"的那一条主干 (补时同样复用键实例, 所以补得上)。
// 顺带记录的第二个坑: .NET Dictionary 的 Remove 只把 Entry.hashCode 置 -1, **键的指针留在数组里**
//   → 只看键会把这些"已删除残留"当成存在 (dictHasIdVer 已按 hashCode >= 0 判定存活)。
import { A, dbg, error, fieldOffset, findAllObjectOfType, findClassAcrossImages, getGenericArgClass, invokeBool, readStr, swallowed, swallowedWarn, warn, wblog } from "../utils.js";
import { wbCls, wbData } from "./state.js";
import { isCurrentModItem, makeIdVersionPair, wbCats } from "./data.js";
import { dictHasIdVer, readDataItemsIndex, writeLocalizedDictEntry } from "./session.js";
import { registerLocalizedDict } from "./pages.js";   // 循环引用安全: 只在函数内调用

// MapPage 的分类描述 (locKind="str" → 字典值是字符串; MapDataItem._buttonText @0x10 = LocalizedText[])
var MAP_SPEC = { name: "map", page: "MapPage", data: "MapData", locOff: 0xC0, locKind: "str", mapOnly: true };
// 页面规格: 受管 4 分类 (wbCats) + Map (mod 不提供 Map 数据, 但它的字典同为 IdVersionPair 键)
function pageSpecs() {
    var out = [];
    var names = Object.keys(wbCats);
    for (var i = 0; i < names.length; i++) {
        var cat = wbCats[names[i]];
        out.push({ cat: cat, key: cat.name, pageCls: wbCls.pages[cat.name], locOff: cat.locOff, dataCls: wbCls.datas[cat.name] });
    }
    try {
        if (wbCls.mapPage === undefined) wbCls.mapPage = findClassAcrossImages("WitchTrials.Views", MAP_SPEC.page);
        if (wbCls.mapData === undefined) wbCls.mapData = findClassAcrossImages("WitchTrials.Models", MAP_SPEC.data);
        if (wbCls.mapPage && !wbCls.mapPage.isNull()) {
            out.push({ cat: MAP_SPEC, key: "map", pageCls: wbCls.mapPage, locOff: MAP_SPEC.locOff, dataCls: wbCls.mapData, mapOnly: true });
        }
    } catch (e) { swallowed("witchbook/dictheal.js:pageSpecs", e); }
    return out;
}
// 从分类的 Data 资产取 (id, ver) 的 item; 版本对不上时退回该 id 的第一条并告警 (数据不一致)
var _approxWarned = {};
function pickDataItem(dataCls, cat, id, ver) {
    var idx = readDataItemsIndex(cat, dataCls);
    if (!idx) return null;
    var exact = idx.byVer[id + "@" + ver];
    if (exact && !exact.isNull()) return exact;
    var first = idx.first[id];
    if (first && !first.isNull()) {
        var k = cat.name + "/" + id;
        if (!_approxWarned[k]) { _approxWarned[k] = 1; warn(cat.name + " '" + id + "' 数据里没有 v" + ver + ", 退回第一条 (版本号对不上)"); }
        return first;
    }
    return null;
}
// 补一个键: mod 条目用 mod 文本 (与注入同一来源), 原版条目从游戏自己的 Data 重建该条 item 的本地化文本
export function healDictKey(dict, spec, id, ver, ivp) {
    try {
        if (!dict || dict.isNull() || !id) return false;
        if (dictHasIdVer(dict, id, ver)) return false;
        var pages = spec.pageCls ? findAllObjectOfType(spec.pageCls) : [];
        var page = pages.length ? pages[0] : null;
        if (!page) return false;
        if (!spec.mapOnly && isCurrentModItem(spec.cat, id)) {
            var cur = page.add(fieldOffset(spec.pageCls, "_localizedTextData", spec.locOff)).readPointer();
            if (cur.equals(dict)) {
                wblog("[WitchBook] " + spec.key + " 字典缺键 → 用 mod 文本补: '" + id + "' v" + ver);
                registerLocalizedDict(page, { cat: spec.cat, id: id, ver: ver, ivp: ivp && !ivp.isNull() ? ivp : makeIdVersionPair(id, ver) });
                return true;
            }
        }
        // 原版条目 (或 Map / 非本页面的字典): 从 Data 取回该条 item 重建
        var item = pickDataItem(spec.dataCls, spec.cat, id, ver);
        if (!item || item.isNull()) { warn(spec.key + " 字典缺键 '" + id + "' v" + ver + " 且数据里没有这条 (数据本身对不上)"); return false; }
        wblog("[WitchBook] " + spec.key + " 字典缺键 → 从 " + spec.cat.name + " 数据重建: '" + id + "' v" + ver);
        var usedKey = writeLocalizedDictEntry(page, spec.pageCls, spec.cat, id, ver, item,
            ivp && !ivp.isNull() ? ivp : makeIdVersionPair(id, ver), dict);
        // 端到端核对: 用"实际写进去的那个键实例"问一次字典 —— 匹配是按实例的, 值相等不算数
        try {
            var ck = A.cgm(A.ogc(dict), Memory.allocUtf8String("ContainsKey"), 1);
            if (ck && !ck.isNull() && usedKey && !usedKey.isNull()) {
                dbg("[WitchBook] " + spec.key + " 补后核对 ContainsKey=" + invokeBool(ck, dict, [usedKey]));
            }
        } catch (e4) { swallowedWarn("witchbook/dictheal.js:healDictKey", e4); }
        return true;
    } catch (e) { error("healDictKey(" + spec.key + ") err: " + e); return false; }
}
// 每次注入末尾: 把该页 `_state` 里"将要渲染的键"逐个核对, 缺就补 (mod 条目用 mod 文本, 原版从 Data 重建)。
// **真相源必须是页面自己的 `_state._list`, 不是我们的 wbData.states** —— 2026-09-28 实测抓到的分叉:
//   Twilight 的 Main.nani 有 `@update "Hiro" Category:"Profile" Version:0`, 而 'Hiro' 被 data.js 的
//   "首个 mod 优先"判给了先加载的 mod (Gapless) → 我们按规矩忽略这条 @update (它"不是当前 mod 的条目"),
//   但**游戏照旧把它写进 _state**。只信 wbData.states 就永远不 heal 它 → 字典缺这个键,
//   而 `_state` 里它一直在 (哨兵连续 5 轮报 FAIL)。与 7.10 同源: 判定要问游戏, 不要问我们自己的记录。
export function healStateKeys(page, cat) {
    try {
        var spec = null, specs = pageSpecs();
        for (var i = 0; i < specs.length; i++) if (specs[i].key === cat.name) { spec = specs[i]; break; }
        if (!spec || !spec.pageCls || spec.pageCls.isNull()) return 0;
        var dict = page.add(fieldOffset(spec.pageCls, "_localizedTextData", spec.locOff)).readPointer();
        if (dict.isNull()) return 0;
        var n = 0, done = {};
        // ① 页面真实 _state._list (含游戏自己写进去的、非本 mod 的键)
        try {
            var st = page.add(fieldOffset(spec.pageCls, "_state", 0x48)).readPointer();
            if (!st.isNull()) {
                var lst = st.add(fieldOffset(wbCls.versionedState, "_list", 0x10)).readPointer();
                if (!lst.isNull()) {
                    var cnt = lst.add(0x18).readS32(), arr = lst.add(0x10).readPointer();
                    if (!arr.isNull() && cnt > 0 && cnt <= 5000) {
                        for (var r = 0; r < cnt; r++) {
                            var se = arr.add(0x20 + r * 8).readPointer();
                            if (se.isNull()) continue;
                            var sid = readStr(se.add(0x10).readPointer()), sver = se.add(0x18).readS32();
                            if (!sid) continue;
                            done[sid + "@" + sver] = 1;
                            if (healDictKey(dict, spec, sid, sver, null)) n++;
                        }
                    }
                }
            }
        } catch (e1) { swallowed("witchbook/dictheal.js:healStateKeys", e1); }
        // ② 我们的记录 (兜底: 游戏还没写进 _state, 或 _state 读失败)
        var stMap = (wbData.states || {})[cat.name] || {};
        for (var id in stMap) if (!done[id + "@" + (stMap[id] | 0)]) { if (healDictKey(dict, spec, id, stMap[id] | 0, null)) n++; }
        return n;
    } catch (e) { error("healStateKeys err: " + e); return 0; }
}
