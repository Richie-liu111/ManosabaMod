// ============ 自检 (仅在 MOD_SELFTEST=1 时装载/挂钩; 平时完全不介入) ============
// 目的: 把"人工点图鉴 + 肉眼看日志"变成"跑一次就给出 PASS/FAIL 的断言"。
// 背景 (2026-09-25): 那次"图鉴打不开"排查了十几轮, 每次都要人重启游戏、点图鉴、贴日志;
//   而真正的判据(字典键能不能查到)其实可以机器判。这个模块就是把那个判据固化下来。
// 断言项:
//   A. **字典不变式**(最重要): 每页 × _state 里每个 (id, version) → 取字典里"游戏自己的键实例",
//      调游戏的 ContainsKey → 必须 true。这正是"IdVersionPair 按实例匹配"那个坑的永久哨兵。
//   B. KeyNotFoundException 计数必须为 0 —— ThrowHelper 钩子**只在自检态**挂。
//   C. 页面统计 (map 条数 / _itemIds 唯一数 / _state 条数) —— 给人核对, 机器不判。
// 输出: 每轮 `[SELFTEST] PASS/FAIL <名称>` + 收尾 `[SELFTEST] SUMMARY pass=N fail=M knf=K`
// 宿主 `test-tools/regression.py` 就是 grep 这些行来判断成败。
import { A, error, fieldOffset, findAllObjectOfTypeAll, findClassAcrossImages, invokeBool, readStr, swallowed, swallowedStats, warn, wblog } from "../utils.js";
import { wbCls } from "./state.js";
import { makeIdVersionPair, wbCats } from "./data.js";
import { dictFindKeyInstance, dictHasIdVer } from "./session.js";

var _stats = { pass: 0, fail: 0, note: 0, knf: 0, rounds: 0, hooked: false };

// 扫描 `_loadedDataItemMap` 的每个活条目 → { id, ver, 游戏查字典时用的那个 IdVersionPair 实例 }
// 为什么是它: 2026-09-25 的 KNF 根因是"字典里有键, 但游戏手里的实例不是它" —— 只有拿**这个实例**
// 去问 ContainsKey 才能发现; 拿 id/ver 去问 (或拿字典自己的键实例) 永远为真, 查不出问题。
function scanMapLookups(page, pageCls) {
    var out = [];
    try {
        var ml = page.add(fieldOffset(pageCls, "_loadedDataItemMap", 0x88)).readPointer();
        if (ml.isNull()) return out;
        var ents = ml.add(0x18).readPointer();
        if (ents.isNull()) return out;
        var cap = ents.add(0x18).readS32();
        if (cap < 0 || cap > 20000) return out;
        for (var i = 0; i < cap; i++) {
            try {
                var e = ents.add(0x20 + i * 24);
                if (e.readS32() < 0) continue;                 // 死槽 (已 Remove)
                var k = e.add(8).readPointer(), v = e.add(16).readPointer();
                if (k.isNull() || v.isNull()) continue;
                // 只有值是 VersionedItem 时, +0x28 才是 `_idVersionPair`。别的页 (如 Map 的
                // MapDataItem) 值类型不同 → 退回用条目自己的键 (那是游戏自己插进去的, 必然在字典里),
                // 避免把"读错字段拿到的垃圾指针"报成 FAIL。
                var lookup = k, vcn = "";
                try { vcn = A.cgn(A.ogc(v)).readCString() || ""; } catch (e4) {}
                if (vcn.indexOf("VersionedItem") >= 0) lookup = v.add(0x28).readPointer();
                out.push({ id: readStr(k.add(0x10).readPointer()), ver: k.add(0x18).readS32(), lookup: lookup });
            } catch (e2) {}
        }
    } catch (e3) {}
    return out;
}

export function selftestEnabled() {
    try { return typeof MOD_SELFTEST !== "undefined" && !!MOD_SELFTEST; } catch (e) { return false; }
}
// 负对照 (MOD_SELFTEST_BREAK=1): A1 故意改用"值相等但**实例不同**"的 IdVersionPair 去问字典。
// 这正是 2026-09-25 那个坑的本质 (游戏按实例匹配, 我们却拿等价实例查) → 哨兵**必须**报 FAIL。
// 用途: 证明哨兵不是"永远绿"的摆设 (回归脚本的 --self-proof 断言的就是这条)。
export function selfProofEnabled() {
    try { return typeof MOD_SELFTEST_BREAK !== "undefined" && !!MOD_SELFTEST_BREAK; } catch (e) { return false; }
}

// ===== B. KNF 计数 (只统计, 不修; 自检态才挂钩) =====
export function setupSelftest() {
    if (!selftestEnabled() || _stats.hooked) return 0;
    _stats.hooked = true;
    try {
        var cls = findClassAcrossImages("System", "ThrowHelper") || findClassAcrossImages("System.Collections.Generic", "ThrowHelper");
        var mi = cls && !cls.isNull() ? A.cgm(cls, Memory.allocUtf8String("GetKeyNotFoundException"), 1) : null;
        if (mi && !mi.isNull()) {
            Interceptor.attach(mi.readPointer(), {
                onEnter: function (a) {
                    try {
                        // 静态方法 → 第一个形参在 a[0]; 两个槽位都试并按类名校验 (上次按实例方法读 a[1] 静默白跑一轮)
                        var k = null;
                        for (var i = 0; i < 2 && !k; i++) {
                            var p = a[i];
                            if (!p || p.isNull()) continue;
                            try { if (A.cgn(A.ogc(p)).readCString() === "IdVersionPair") k = p; } catch (e1) { swallowed("witchbook/selftest.js:setupSelftest.onEnter", e1); }
                        }
                        _stats.knf++;
                        if (k) {
                            var id = readStr(k.add(0x10).readPointer()), ver = k.add(0x18).readS32();
                            wblog("[SELFTEST] FAIL KeyNotFoundException: id='" + id + "' v" + ver);
                        } else {
                            wblog("[SELFTEST] FAIL KeyNotFoundException (参数非 IdVersionPair)");
                        }
                    } catch (e) { error("[SELFTEST] KNF 计数 err: " + e); }
                }
            });
            wblog("[SELFTEST] 已启用 (MOD_SELFTEST=1) — KNF 计数 + 字典不变式断言");
        } else {
            warn("[SELFTEST] ThrowHelper.GetKeyNotFoundException 未找到, KNF 计数不可用");
        }
        return 1;
    } catch (e) { error("[SELFTEST] setup err: " + e); return 0; }
}

// ===== A + C. 每轮断言与统计 =====
export function runSelftest(round) {
    if (!selftestEnabled()) return;
    try {
        _stats.rounds++;
        // 受管 4 分类 + Map (Map 的字典同为 IdVersionPair 键, 同样要查)
        var specs = [];
        var names = Object.keys(wbCats);
        for (var i = 0; i < names.length; i++) {
            var cat = wbCats[names[i]];
            specs.push({ key: cat.name, pageCls: wbCls.pages[cat.name], locOff: cat.locOff });
        }
        if (wbCls.mapPage === undefined) { try { wbCls.mapPage = findClassAcrossImages("WitchTrials.Views", "MapPage"); } catch (e0) { wbCls.mapPage = null; } }
        if (wbCls.mapPage && !wbCls.mapPage.isNull()) specs.push({ key: "map", pageCls: wbCls.mapPage, locOff: 0xC0 });

        for (var s = 0; s < specs.length; s++) {
            var sp = specs[s];
            if (!sp.pageCls || sp.pageCls.isNull()) continue;
            var pages = findAllObjectOfTypeAll(sp.pageCls);
            if (!pages.length) { wblog("[SELFTEST] FAIL " + sp.key + ": 页面实例不存在"); _stats.fail++; continue; }
            try {
                var page = pages[0];
                var dict = page.add(fieldOffset(sp.pageCls, "_localizedTextData", sp.locOff)).readPointer();
                if (dict.isNull()) { wblog("[SELFTEST] FAIL " + sp.key + ": _localizedTextData 为 null"); _stats.fail++; continue; }
                var ck = A.cgm(A.ogc(dict), Memory.allocUtf8String("ContainsKey"), 1);
                // —— A1. **渲染键的判据** (2026-09-25 那个坑的直接防线) ——
                // 游戏查字典用的是 map 条目自己的 IdVersionPair 实例 (`VersionedItem._idVersionPair`@0x28),
                // 不是"值相等的另一个实例"。所以这里必须拿**那个实例**去问 ContainsKey —— 只查
                // "字典自己有没有这个 (id,ver)" 是查不出那次 bug 的 (字典里有, 但游戏手里的实例不在里面)。
                var look = scanMapLookups(page, sp.pageCls);
                var inMap = {}, mapN = look.length, badMap = 0;
                var selfproof = selfProofEnabled();     // 负对照: 换等价实例去问
                for (var li = 0; li < look.length; li++) {
                    var L = look[li];
                    if (L.id) inMap[L.id] = 1;
                    var probe = L.lookup;
                    if (selfproof) { try { probe = makeIdVersionPair(L.id, L.ver); } catch (e5) { probe = L.lookup; } }
                    var ok = false;
                    if (probe && !probe.isNull() && ck && !ck.isNull()) {
                        try { ok = invokeBool(ck, dict, [probe]); } catch (e2) { swallowed("witchbook/selftest.js:runSelftest#2", e2); }
                    }
                    if (ok) _stats.pass++;
                    else {
                        _stats.fail++; badMap++;
                        wblog("[SELFTEST] FAIL " + (selfproof ? "负对照 " : "") + sp.key + " 渲染键查不到: '" + L.id + "' v" + L.ver +
                            (L.lookup && !L.lookup.isNull() ? " (map 条目的 ivp 实例不在字典里)" : " (map 条目 ivp=null)"));
                    }
                }
                // —— A2. `_state` 里的键: 字典里得有活条目 ——
                // 分级: 同时在 map 里 (会被渲染) → FAIL; 只在 state 里 (渲染不走它) → NOTE (记录, 不判)。
                // 为什么分级: 游戏自己的 `@update` 会写入**非本 mod** 的键 (2026-09-28 实测: Twilight 的
                // `@update "Hiro"` 被"首个 mod 优先"判给了别的 mod), 那种键渲染根本不碰 → 不算致命。
                var stList = null;
                try {
                    var st = page.add(fieldOffset(sp.pageCls, "_state", 0x48)).readPointer();
                    if (!st.isNull()) stList = st.add(fieldOffset(wbCls.versionedState, "_list", 0x10)).readPointer();
                } catch (e1) { swallowed("witchbook/selftest.js:runSelftest", e1); }
                var stateN = 0, badKeys = 0, notes = 0;
                if (stList && !stList.isNull()) {
                    var sc = stList.add(0x18).readS32(), sa = stList.add(0x10).readPointer();
                    if (sa.isNull() || sc < 0 || sc > 5000) sc = 0;
                    for (var r = 0; r < sc; r++) {
                        var se = sa.add(0x20 + r * 8).readPointer();
                        if (se.isNull()) continue;
                        var id = readStr(se.add(0x10).readPointer()), ver = se.add(0x18).readS32();
                        if (!id) continue;
                        stateN++;
                        if (dictHasIdVer(dict, id, ver)) { _stats.pass++; continue; }
                        if (inMap[id]) { _stats.fail++; badKeys++; wblog("[SELFTEST] FAIL 字典缺键 " + sp.key + " '" + id + "' v" + ver + " (且在渲染集合里)"); }
                        else { _stats.note++; notes++; wblog("[SELFTEST] NOTE 状态有键但字典无 (不在渲染集合, 暂无害): " + sp.key + " '" + id + "' v" + ver); }
                    }
                }
                // —— C. 统计 (不判) ——
                var idsN = 0, idsUniq = 0;
                try {
                    var arr = page.add(fieldOffset(sp.pageCls, "_itemIds", 0x98)).readPointer();
                    if (!arr.isNull()) {
                        var len = arr.add(0x18).readS32(), seen = {};
                        for (var q = 0; q < len && q < 5000; q++) {
                            var str = readStr(arr.add(0x20 + q * 8).readPointer());
                            if (!str) continue;
                            idsN++; seen[str] = 1;
                        }
                        idsUniq = Object.keys(seen).length;
                    }
                } catch (e3) { swallowed("witchbook/selftest.js:runSelftest#3", e3); }
                wblog("[SELFTEST] stats " + sp.key + ": map=" + mapN + " _itemIds=" + idsN + "(唯一 " + idsUniq + ") _state=" + stateN +
                    (badMap ? " 渲染缺=" + badMap : "") + (badKeys ? " 缺键=" + badKeys : "") + (notes ? " 仅状态=" + notes : ""));
            } catch (e4) { error("[SELFTEST] " + sp.key + " 断言 err: " + e4); _stats.fail++; }
        }
        wblog("[SELFTEST] SUMMARY round=" + _stats.rounds + " pass=" + _stats.pass + " fail=" + _stats.fail + " note=" + _stats.note + " knf=" + _stats.knf +
            (round ? " (" + round + ")" : ""));
        // 被吞掉的异常 (步骤 2.1): 自检态顺手报一次, 让"静默失败"在回归里也可见
        try {
            var sw = swallowedStats();
            if (sw.length) wblog("[SELFTEST] swallowed " + sw.join(" "));
        } catch (e5) { swallowed("witchbook/selftest.js:runSelftest", e5); }
    } catch (e) { error("[SELFTEST] run err: " + e); }
}
