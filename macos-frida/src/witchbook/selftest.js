// ============ 自检 (仅在 MOD_SELFTEST=1 时装载/挂钩; 平时完全不介入) ============
// 目的: 把"人工点图鉴 + 肉眼看日志"变成"跑一次就给出 PASS/FAIL 的断言"。
// 背景 (2026-09-25): 那次"图鉴打不开"排查了十几轮, 每次都要人重启游戏、点图鉴、贴日志;
//   而真正的判据(字典键能不能查到)其实可以机器判。这个模块就是把那个判据固化下来。
// 断言项:
//   A. **字典不变式**(最重要): 每页 × _state 里每个 (id, version) → 取字典里"游戏自己的键实例",
//      调游戏的 ContainsKey → 必须 true。这正是"IdVersionPair 按实例匹配"那个坑的永久哨兵。
//   B. KeyNotFoundException 计数必须为 0 —— ThrowHelper 钩子**只在自检态**挂。
//   C. 页面统计 (map 条数 / _itemIds 唯一数 / _state 条数) —— 给人核对, 机器不判。
// 输出: 每轮 `[SELFTEST] PASS/FAIL <名称>` + 收尾
//       `[SELFTEST] SUMMARY round=R pass=N fail=M note=X knf=K asserted=A roundAsserted=a specsMissing=S`
// 宿主 `test-tools/regression.py` 解析 SUMMARY 的 pass/fail/asserted 判成败 (不再只 grep "FAIL" 子串)。
// 判定要点 (2026-10-07 补): **asserted=0 或 pass=0 一律算失败** —— 见下面 D 段。
import { A, error, fieldOffset, findAllObjectOfType, findAllObjectOfTypeAll, findClassAcrossImages, invokeBool, invokeOk, readStr, swallowed, swallowedStats, warn, wblog } from "../utils.js";
import { wbCls } from "./state.js";
import { makeIdVersionPair, wbCats } from "./data.js";
import { dictFindKeyInstance, dictHasIdVer } from "./session.js";

var _stats = { pass: 0, fail: 0, note: 0, knf: 0, rounds: 0, hooked: false, asserted: 0 };
// 本轮**真正执行**的断言数 (每轮清零)。为什么要它 (2026-10-07): 以前只统计 pass/fail, 于是
// "一条断言都没跑" 和 "全都通过了" 在日志里长得一模一样 —— 宿主 grep 不到 FAIL 就判绿 (假绿)。
// 有了它, "本轮断言数为 0" 本身就能被下面判成 FAIL, 而不是悄悄通过。
var _roundAsserted = 0;
// 本轮"页面类根本没找到"的分类数 (计入 fail, 单独留一个计数便于日志里一眼看出是缺类而非断言不过)
var _specMissing = 0;
// 一轮里至少要执行多少条断言才算"真跑过"。低于它 = 页面/容器没探到 (读取失效或实例选错),
// 属于机器可判的失败, 不该算通过。可用 MOD_SELFTEST_MIN 覆盖 (调试用; 0 = 关掉这道门槛)。
var _MIN_ASSERTED = 1;
try { var _mv = (typeof MOD_SELFTEST_MIN !== "undefined") ? parseInt(MOD_SELFTEST_MIN, 10) : NaN; if (!isNaN(_mv) && _mv >= 0) _MIN_ASSERTED = _mv; } catch (e0) { swallowed("witchbook/selftest.js:MIN_ASSERTED", e0); }

// 扫描 `_loadedDataItemMap` 的每个活条目 → { id, ver, 游戏查字典时用的那个 IdVersionPair 实例 }
// 为什么是它: 2026-09-25 的 KNF 根因是"字典里有键, 但游戏手里的实例不是它" —— 只有拿**这个实例**
// 去问 ContainsKey 才能发现; 拿 id/ver 去问 (或拿字典自己的键实例) 永远为真, 查不出问题。
// 容器探测 (不再猜布局): `_loadedDataItemMap` 在 session.js 里是按 **List** 用的
// (RemoveAt / _items@0x10 / _size@0x18), 而早期实现按 Dictionary 布局读 (+0x18→entries→24 字节),
// 把 _size 当指针用 → 被守卫拦成 0 条, 还误判"旧日志里的 map=155 是垃圾数" (其实是 _size)。
// 教训: **猜内存布局不如问游戏自己要** —— 这里用 get_Count/get_Item 访问器, 顺带把类名与
// 两个候选偏移的原始值打进日志, 下次谁再改都不用猜。
function probeMap(page, pageCls) {
    var out = { cls: "?", count: -1, raw18: null, raw20: null, items: [], bail: null, miss: 0 };
    try {
        var m = page.add(fieldOffset(pageCls, "_loadedDataItemMap", 0x88)).readPointer();
        if (m.isNull()) return out;
        var mc = A.ogc(m);
        try { out.cls = A.cgn(mc).readCString() || "?"; } catch (e0) { swallowed("witchbook/selftest.js:probeMap.cls", e0); }
        try { out.raw18 = m.add(0x18).readS32(); } catch (e1) { swallowed("witchbook/selftest.js:probeMap.raw18", e1); }
        try { out.raw20 = m.add(0x20).readS32(); } catch (e2) { swallowed("witchbook/selftest.js:probeMap.raw20", e2); }
        var cMi = A.cgm(mc, Memory.allocUtf8String("get_Count"), 0);
        if (cMi && !cMi.isNull()) {
            var r = invokeOk(cMi, m, []);
            if (r.ok && !r.ret.isNull()) out.count = r.ret.add(0x10).readS32();     // 装箱 int32
        }
        // 提前返回必须**带原因** (2026-10-07): 以前这里直接 return, 调用方只能看到 count 与空 items,
        // 分不清"这页本来就是空的"和"读取整个失效了" —— 后者会被静默当成功。bail 把区别留下来。
        if (out.count < 0) { out.bail = "get_Count 失败或容器为 null"; return out; }
        if (out.count > 20000) { out.bail = "get_Count 越界(" + out.count + ")"; return out; }
        if (out.count === 0) { out.bail = "空容器(0 条)"; return out; }
        var itMi = A.cgm(mc, Memory.allocUtf8String("get_Item"), 1);
        if (itMi && !itMi.isNull()) {
            for (var i = 0; i < out.count && i < 4000; i++) {
                try {
                    var ib = Memory.alloc(4); ib.writeS32(i);
                    var r2 = invokeOk(itMi, m, [ib]);
                    if (!r2.ok || r2.ret.isNull()) { out.miss++; continue; }
                    var ivp = r2.ret.add(0x28).readPointer();       // VersionedItem._idVersionPair (游戏查字典用的实例)
                    if (ivp.isNull()) { out.miss++; continue; }
                    out.items.push({ id: readStr(ivp.add(0x10).readPointer()), ver: ivp.add(0x18).readS32(), lookup: ivp });
                } catch (e3) { out.miss++; swallowed("witchbook/selftest.js:probeMap.getItem", e3); }
            }
        } else {
            out.bail = "找不到 get_Item 访问器";
        }
    } catch (e) { swallowed("witchbook/selftest.js:probeMap", e); }
    return out;
}
// 选页面实例: 图鉴页有**多个实例** (图鉴页 vs 出示证物页, 且含 inactive) ——
// 注入用的是 findAllObjectOfType (只 active), 自检若用 findAllObjectOfTypeAll[0] 可能选到
// `_loadedDataItemMap` 为空的那个 → A1 一条都没探到, 却报"全部通过/没反应" (2026-09-28 实测)。
// 这里按"哪个实例的 map 有货"来选, 并把每个实例的条数打进日志。
function pickPage(pageCls) {
    var active = findAllObjectOfType(pageCls), all = findAllObjectOfTypeAll(pageCls);
    var seen = {}, cands = [];
    active.forEach(function (p) { var k = p.toString(); if (!seen[k]) { seen[k] = 1; cands.push({ p: p, tag: "A" }); } });
    all.forEach(function (p) { var k = p.toString(); if (!seen[k]) { seen[k] = 1; cands.push({ p: p, tag: "i" }); } });
    var best = null, bestN = -1, counts = [];
    for (var i = 0; i < cands.length; i++) {
        var n = -1;
        try { n = probeMap(cands[i].p, pageCls).count; } catch (e) { swallowed("witchbook/selftest.js:pickPage", e); }
        counts.push(cands[i].tag + n);                        // A=active, i=inactive
        if (n > bestN) { bestN = n; best = cands[i].p; }
    }
    return { page: best, n: cands.length, activeN: active.length, counts: counts, mapN: bestN };
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

// ===== 键语义探针 (一次性) =====
// `IdVersionPair` 同时实现 IEquatable 与 IEqualityComparer (dump 实证), 所以字典**可能**是值语义 ——
// 这与 7.10 写的"按实例匹配"矛盾。到底哪种, 问游戏最直接: 拿"值相等的新实例"和"版本+1"分别去问
// 真实字典 + 直接调它的 Equals。一次性打印, 用来给文档定案。
var _semProbed = false, _breakAnnounced = false, _instLogged = {};
function probeKeySemantics(page, pageCls, locOff, dict, ck, specKey) {
    if (_semProbed) return;
    try {
        var ivpCls = findClassAcrossImages("WitchTrials.Models", "IdVersionPair");
        if (!ivpCls || ivpCls.isNull()) return;
        var look = probeMap(page, pageCls).items;
        var id, ver, real;
        if (look.length) { id = look[0].id; ver = look[0].ver; real = look[0].lookup; }
        else {
            // map 扫不到 (实例选错/为空) 也要给答案: 直接取字典里第一个**活**条目当基准
            var ents = dict.add(0x18).readPointer();
            if (ents.isNull()) return;
            var cap = ents.add(0x18).readS32();
            if (cap < 0 || cap > 20000) return;
            for (var i = 0; i < cap && !real; i++) {
                var en = ents.add(0x20 + i * 24);
                if (en.readS32() < 0) continue;
                var kk = en.add(8).readPointer();
                if (kk.isNull()) continue;
                real = kk; id = readStr(kk.add(0x10).readPointer()); ver = kk.add(0x18).readS32();
            }
            if (!real || !id) return;
        }
        var L = { id: id, ver: ver, lookup: real };
        _semProbed = true;
        var a = makeIdVersionPair(L.id, L.ver), b = makeIdVersionPair(L.id, L.ver), c = makeIdVersionPair(L.id, L.ver + 1);
        var eqMi = A.cgm(ivpCls, Memory.allocUtf8String("Equals"), 1);          // Equals(IdVersionPair other)
        var eqSelf = false, eqEquiv = false;
        try { if (eqMi && !eqMi.isNull()) { eqSelf = invokeBool(eqMi, a, [a]); eqEquiv = invokeBool(eqMi, a, [b]); } } catch (e1) { swallowed("witchbook/selftest.js:probeKeySemantics.Equals", e1); }
        var ckEq = false, ckV1 = false, ckReal = false;
        try {
            if (ck && !ck.isNull()) {
                ckReal = invokeBool(ck, dict, [L.lookup]);   // 游戏自己那个实例 (基准)
                ckEq = invokeBool(ck, dict, [a]);            // 值相等的新实例
                ckV1 = invokeBool(ck, dict, [c]);            // 版本+1
            }
        } catch (e2) { swallowed("witchbook/selftest.js:probeKeySemantics.ContainsKey", e2); }
        wblog("[SELFTEST] 键语义 " + specKey + " ('" + L.id + "' v" + L.ver + "): Equals(自己)=" + eqSelf +
            " Equals(等价新实例)=" + eqEquiv + " | 字典 ContainsKey(游戏实例)=" + ckReal +
            " (等价新实例)=" + ckEq + " (版本+1)=" + ckV1 +
            "  ⇒ " + (ckEq ? "**值语义** (按 Id+Version 匹配)" : "**实例语义** (identity)"));
    } catch (e) { swallowed("witchbook/selftest.js:probeKeySemantics", e); }
}

// ===== A + C. 每轮断言与统计 =====
export function runSelftest(round) {
    if (!selftestEnabled()) return;
    try {
        _stats.rounds++;
        _roundAsserted = 0;         // 本轮断言计数清零 (见文件头 _roundAsserted 说明)
        _specMissing = 0;           // 同上: 这两个都是**每轮**的, 跟 _stats 里的累计量区分开
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
            // 页面类找不到 = 真回归 (版本更新/类名变更), 不是"跳过" (2026-10-07 改: 原来静默 continue)
            if (!sp.pageCls || sp.pageCls.isNull()) {
                _stats.fail++; _specMissing++;
                wblog("[SELFTEST] FAIL " + sp.key + ": 页面类未找到 (findClassAcrossImages 未命中) —— 该分类本轮 0 断言");
                continue;
            }
            var pk = pickPage(sp.pageCls);
            if (!pk.page) { wblog("[SELFTEST] FAIL " + sp.key + ": 页面实例不存在"); _stats.fail++; continue; }
            try {
                var page = pk.page;
                if (!_instLogged[sp.key]) {
                    _instLogged[sp.key] = 1;
                    wblog("[SELFTEST] 页面实例 " + sp.key + ": 共 " + pk.n + " 个 (active " + pk.activeN + "), 各实例 map 条数=[" +
                        pk.counts.join(" ") + "] → 采用 " + pk.mapN + " 条那个");
                }
                var dict = page.add(fieldOffset(sp.pageCls, "_localizedTextData", sp.locOff)).readPointer();
                if (dict.isNull()) { wblog("[SELFTEST] FAIL " + sp.key + ": _localizedTextData 为 null"); _stats.fail++; continue; }
                var ck = A.cgm(A.ogc(dict), Memory.allocUtf8String("ContainsKey"), 1);
                // —— A1. **渲染键的判据** (2026-09-25 那个坑的直接防线) ——
                // 游戏查字典用的是 map 条目自己的 IdVersionPair 实例 (`VersionedItem._idVersionPair`@0x28),
                // 不是"值相等的另一个实例"。所以这里必须拿**那个实例**去问 ContainsKey —— 只查
                // "字典自己有没有这个 (id,ver)" 是查不出那次 bug 的 (字典里有, 但游戏手里的实例不在里面)。
                var mp = probeMap(page, sp.pageCls);
                var look = mp.items, mapN = mp.count, badMap = 0, inMap = {};
                // 取不到条目必须分开定性 (2026-10-07): "这页本来就是空的" 和 "读取整个失效" 以前都是
                // 静默/同一个 NOTE → 后者能被当成通过。现在: 有货取不出 / 容器读失败 = FAIL (0 断言),
                // 只有"确实是 0 条"才算 NOTE。
                if (!look.length) {
                    if (mapN > 0) {
                        _stats.fail++;
                        wblog("[SELFTEST] FAIL " + sp.key + ": map 有 " + mapN + " 条却一条都取不出来 (" + mp.cls +
                            " raw18=" + mp.raw18 + " raw20=" + mp.raw20 + " miss=" + mp.miss + ") —— 读取失效, 该分类本轮 0 断言");
                    } else if (mapN < 0) {
                        _stats.fail++;
                        wblog("[SELFTEST] FAIL " + sp.key + ": 容器读取失败 (" + (mp.bail || "未知原因") + ", cls=" + mp.cls +
                            " raw18=" + mp.raw18 + " raw20=" + mp.raw20 + ") —— 该分类本轮 0 断言");
                    } else {
                        _stats.note++;
                        wblog("[SELFTEST] NOTE " + sp.key + ": 容器为空 (0 条), 该分类本轮 0 断言");
                    }
                }
                var selfproof = selfProofEnabled();     // 负对照: 换成不匹配的键去问 (见下)
                if (selfproof && !_breakAnnounced) { _breakAnnounced = true; wblog("[SELFTEST] 负对照模式 (MOD_SELFTEST_BREAK=1): 每分类第一条改用版本+1 的键 → 必须报 FAIL (其余条目照常真查)"); }
                for (var li = 0; li < look.length; li++) {
                    var L = look[li];
                    if (L.id) inMap[L.id] = 1;
                    var probe = L.lookup;
                    // 负对照用"版本+1"而不是"等价新实例": 后者在**值语义**字典里会命中 (2026-09-28 实测),
                    // 那样负对照就永远绿了。版本+1 在两种语义下都必然不匹配 → 断言才有确定性。
                    if (selfproof && li === 0) { try { probe = makeIdVersionPair(L.id, L.ver + 1); } catch (e5) { probe = L.lookup; } }
                    var ok = false;
                    if (probe && !probe.isNull() && ck && !ck.isNull()) {
                        try { ok = invokeBool(ck, dict, [probe]); } catch (e2) { swallowed("witchbook/selftest.js:runSelftest#2", e2); }
                    }
                    _stats.asserted++; _roundAsserted++;
                    if (ok) _stats.pass++;
                    else {
                        _stats.fail++; badMap++;
                        wblog("[SELFTEST] FAIL " + (selfproof ? "负对照 " : "") + sp.key + " 渲染键查不到: '" + L.id + "' v" + L.ver +
                            (L.lookup && !L.lookup.isNull() ? " (map 条目的 ivp 实例不在字典里)" : " (map 条目 ivp=null)"));
                    }
                }
                probeKeySemantics(page, sp.pageCls, sp.locOff, dict, ck, sp.key);
                // —— A2. `_state` 里的键: 字典里得有活条目 ——
                // 分级: 同时在 map 里 (会被渲染) → FAIL; 只在 state 里 (渲染不走它) → NOTE (记录, 不判)。
                // 为什么分级: 游戏自己的 `@update` 会写入**非本 mod** 的键 (实测: 某 mod 的
                // `@update` 目标的条目被"首个 mod 优先"判给了别的 mod), 那种键渲染根本不碰 → 不算致命。
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
                        _stats.asserted++; _roundAsserted++;
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
                wblog("[SELFTEST] stats " + sp.key + ": map=" + mapN + "(" + mp.cls + ")/取到" + look.length + " 实例=" + pk.n + " _itemIds=" + idsN + "(唯一 " + idsUniq + ") _state=" + stateN +
                    (badMap ? " 渲染缺=" + badMap : "") + (badKeys ? " 缺键=" + badKeys : "") + (notes ? " 仅状态=" + notes : ""));
            } catch (e4) { error("[SELFTEST] " + sp.key + " 断言 err: " + e4); _stats.fail++; }
        }
        // —— D. 本轮"真的跑过断言了吗" (2026-10-07 新增) ——
        // 以前 pass/fail 全 0 与"全部通过"在日志里长得一样, 宿主只 grep FAIL 就会把"一条都没跑"判成绿。
        // 门槛判定必须在 SUMMARY 之前, 这样 SUMMARY 里的 fail 已经包含它。
        if (_roundAsserted < _MIN_ASSERTED) {
            _stats.fail++;
            wblog("[SELFTEST] FAIL 本轮断言数不足: roundAsserted=" + _roundAsserted + " < 门槛 " + _MIN_ASSERTED +
                " (未找到页面类 " + _specMissing + " 个) —— 没真跑过断言, 不算通过 (调试可设 MOD_SELFTEST_MIN=0 关掉)");
        }
        wblog("[SELFTEST] SUMMARY round=" + _stats.rounds + " pass=" + _stats.pass + " fail=" + _stats.fail +
            " note=" + _stats.note + " knf=" + _stats.knf + " asserted=" + _stats.asserted +
            " roundAsserted=" + _roundAsserted + " specsMissing=" + _specMissing +
            (round ? " (" + round + ")" : ""));
        // 被吞掉的异常 (步骤 2.1): 自检态顺手报一次, 让"静默失败"在回归里也可见
        try {
            var sw = swallowedStats();
            if (sw.length) wblog("[SELFTEST] swallowed " + sw.join(" "));
        } catch (e5) { swallowed("witchbook/selftest.js:runSelftest", e5); }
    } catch (e) { error("[SELFTEST] run err: " + e); }
}
