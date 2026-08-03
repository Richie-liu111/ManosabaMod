// ============ WitchBook 数据域: 分类表 / 数据加载 / 版本项构建 / 本地化工具 ============
import { A, dbg, fieldOffset, findClassAcrossImages, getGenericArgClass, invokeOk, makeS, wblog } from "../utils.js";
import { fileExists, readJSONFile } from "../io.js";
import { setWbReady, wbData, wbCurrentMod, wbReady, wbCls } from "./state.js";
import { registerLocalizedDict } from "./pages.js";

export var wbCats = {
  clue:    { name:"clue",    idx:0, field:"Clues",     page:"CluePage",    data:"ClueData",    item:"ClueDataItem",    texDir:"Clues",    locOff:0xD0, locKind:"lts",
             addr: function(id){ return buildClueTextureAddress(id); },
             parseItem: function(it){ return { name: it.Name||{}, desc: it.Description||{} }; } },
  profile: { name:"profile", idx:1, field:"Profiles",  page:"ProfilePage", data:"ProfileData", item:"ProfileDataItem", texDir:"Profiles", locOff:0xE8, locKind:"str",
             addr: function(id){ return buildProfileTextureAddress(id); },
             parseItem: function(it){ return { desc: it.Description||{} }; } },
  rule:    { name:"rule",    idx:3, field:"Rules",     page:"RulePage",    data:"RuleData",    item:"RuleDataItem",    texDir:null,       locOff:0xE8, locKind:"lts",
             addr: null,
             parseItem: function(it){ return { numbering: (it.Numbering||""), subtitle: it.Subtitle||{}, desc: it.Description||{} }; } },
  note:    { name:"note",    idx:4, field:"Notes",     page:"NotePage",    data:"NoteData",    item:"NoteDataItem",    texDir:null,       locOff:0xC8, locKind:"lts",
             addr: null,
             parseItem: function(it){ return { title: it.Title||{}, desc: it.Description||{} }; } }
};
export function wbCatByIdx(idx) {
    var names = Object.keys(wbCats);
    for (var i = 0; i < names.length; i++) if (wbCats[names[i]].idx === idx) return wbCats[names[i]];
    return null;
}
export function wbCatByName(nm) { return wbCats[nm]; }
// 当前 mod 某分类的 id 列表 (无 mod 时不注入)
export function currentModIds(cat) {
    if (!wbCurrentMod || wbCurrentMod === "__vanilla__") return [];
    var out = [], keys = Object.keys(wbData[cat.name]);
    for (var i = 0; i < keys.length; i++) if (wbData[cat.name][keys[i]].key === wbCurrentMod) out.push(keys[i]);
    return out;
}
export function isCurrentModItem(cat, id) { return !!wbCurrentMod && wbData[cat.name][id] && wbData[cat.name][id].key === wbCurrentMod; }
export function currentModSet(cat) {
    var cur = currentModIds(cat), set = {};
    cur.forEach(function (id) { set[id] = 1; });
    return set;
}

// 加载所有 mod 的 Clues/Profiles/Rules/Notes + Characters 数据 (info.json) + 纹理路径
export function loadWitchBookData() {
    if (wbReady || typeof modList === "undefined" || !modList) return;
    var root = (typeof MOD_ROOT !== "undefined") ? MOD_ROOT : "";
    wblog("MOD_ROOT=" + root + ", modList=" + modList.length + " 个");
    for (var mi = 0; mi < modList.length; mi++) {
        var key = modList[mi].key;
        var info = readJSONFile(root + "/" + key + "/info.json");
        if (!info) { wblog("  " + key + ": info.json 读取/解析失败"); continue; }
        // 角色数据 (Profile 关联 + 立绘注册: Characters 完整角色 / SimpleCharacters 简单角色)
        if (info.Characters) {
            for (var ch = 0; ch < info.Characters.length; ch++) {
                var cc = info.Characters[ch];
                if (!cc.Id || wbData.characters[cc.Id]) continue;
                wbData.characters[cc.Id] = { key: key, name: cc.Name||{}, familyName: cc.FamilyName||{}, color: cc.Color||"", age: cc.Age||"", height: cc.Height||"", weight: cc.Weight||"" };
            }
        }
        if (info.SimpleCharacters) {
            for (var sc = 0; sc < info.SimpleCharacters.length; sc++) {
                var scc = info.SimpleCharacters[sc];
                if (!scc.Id || wbData.characters[scc.Id]) continue;
                wbData.characters[scc.Id] = { key: key, name: {}, familyName: {}, color: "", age: "", height: "", weight: "", simple: true, displayName: scc.DisplayName||{} };
            }
        }
        // 各分类
        var catNames = Object.keys(wbCats);
        for (var cn = 0; cn < catNames.length; cn++) {
            var cat = wbCats[catNames[cn]];
            if (!cat || !cat.name) { wblog("  cat 配置异常: key=" + catNames[cn]); continue; }
            if (!wbData[cat.name]) { wblog("  wbData 缺分类 '" + cat.name + "', wbData 键=" + Object.keys(wbData).join(",")); return; }
            var groups = info[cat.field];
            if (!groups) continue;
            var texDir = cat.texDir ? (root + "/" + key + "/WitchBook/" + cat.texDir) : null;
            for (var g = 0; g < groups.length; g++) {
                var grp = groups[g];
                if (!grp.Id || !grp.Items || !grp.Items.length) continue;
                if (wbData[cat.name][grp.Id]) { wblog("重复 " + cat.name + " ID '" + grp.Id + "' 跳过 (首个 mod 优先)"); continue; }
                var rec = { key: key, versions: {}, path: null };
                for (var v = 0; v < grp.Items.length; v++) {
                    var it = grp.Items[v];
                    rec.versions[String(it.Version)] = cat.parseItem(it);
                }
                if (texDir) {
                    var tp = texDir + "/" + grp.Id + ".png";
                    try { if (fileExists(tp)) rec.path = tp; } catch (e) {}
                    if (!rec.path) { try { var tp2 = texDir + "/" + grp.Id + ".jpg"; if (fileExists(tp2)) rec.path = tp2; } catch (e) {} }
                    if (rec.path) wbData.texPaths[grp.Id] = rec.path;
                }
                wbData[cat.name][grp.Id] = rec;
            }
        }
    }
    setWbReady(true);
    var summary = [];
    var cn2 = Object.keys(wbCats);
    for (var i = 0; i < cn2.length; i++) summary.push(wbCats[cn2[i]].name + "=" + Object.keys(wbData[wbCats[cn2[i]].name]).length);
    wblog("数据加载: " + summary.join(", ") + ", 角色=" + Object.keys(wbData.characters).length + ", 图片=" + Object.keys(wbData.texPaths).length);
}
// 镜像 WitchBookDataHelper.BuildClueTextureAddress: '1-1' → General/WitchBook/Clue_..._001
export function buildClueTextureAddress(id) {
    var parts = id.split("-"), out = "General/WitchBook/Clue";
    for (var i = 0; i < parts.length; i++) {
        var p = parts[i]; while (p.length < 3) p = "0" + p;
        out += "_" + p;
    }
    return out;
}
// 镜像 WitchBookDataHelper.BuildProfileTextureAddress: → General/WitchBook/Profile_<id 原样>
export function buildProfileTextureAddress(id) {
    return "General/WitchBook/Profile_" + id;
}
export function localeValue(tag) { // ja=0 en-US=1 zh-Hans=2 zh-Hant=3 ko=4 fr=5 es=6
    switch (tag) {
        case "ja": return 0; case "en-US": return 1; case "zh-Hans": return 2;
        case "zh-Hant": return 3; case "ko": return 4; case "fr": return 5; case "es": return 6;
    } return 2;
}
export function resolveLocale(locObj, tag) { return locObj && locObj[tag] ? locObj[tag] : ""; }
export function unionLocaleKeys(a, b) {
    var seen = {};
    (a ? Object.keys(a) : []).concat(b ? Object.keys(b) : []).forEach(function (k) { seen[k] = 1; });
    return Object.keys(seen);
}
// 取语言对象的最佳文本 (优先 zh-Hans → ja → 任意)
export function pickLocaleText(locObj) {
    if (!locObj) return "";
    if (locObj["zh-Hans"]) return locObj["zh-Hans"];
    if (locObj["ja"]) return locObj["ja"];
    var keys = Object.keys(locObj);
    return keys.length ? locObj[keys[0]] : "";
}

// 构建 LocalizedText[] (每个语言一条)
export function buildLocalizedTextArray(locObj) {
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
export function makeIdVersionPair(id, ver) {
    var ivp = A.on(wbCls.idVersionPair);
    var ctorMi = A.cgm(wbCls.idVersionPair, Memory.allocUtf8String(".ctor"), 2);
    var vbuf = Memory.alloc(4); vbuf.writeS32(ver);
    if (ctorMi && !ctorMi.isNull()) invokeOk(ctorMi, ivp, [makeS(id), vbuf]);
    return ivp;
}
// 构建 VersionedItem<TItem> — 按分类构造对应数据项 (object_new + 写字段, 绕开泛型 ctor)
// 返回 { vi, ivp }; ivp 用于 _localizedTextData 键匹配 (get_IdVersionPair 缓存命中)
export function buildVersionedItemFor(cat, vItemCls, id, ver, rec) {
    try {
        var vrec = rec.versions[String(ver)];
        if (!vrec) vrec = rec.versions[Object.keys(rec.versions)[0]];
        var itemCls = wbCls.items[cat.name];
        var item = A.on(itemCls);
        if (cat.name === "clue") {
            var nameArr = buildLocalizedTextArray(vrec.name);
            var descArr = buildLocalizedTextArray(vrec.desc);
            var mi = A.cgm(itemCls, Memory.allocUtf8String(".ctor"), 2);
            if (mi && !mi.isNull()) invokeOk(mi, item, [nameArr, descArr]);
            else { item.add(0x10).writePointer(nameArr); item.add(0x18).writePointer(descArr); }
        } else if (cat.name === "profile") {
            var descArr2 = buildLocalizedTextArray(vrec.desc);
            var mi2 = A.cgm(itemCls, Memory.allocUtf8String(".ctor"), 1);
            if (mi2 && !mi2.isNull()) invokeOk(mi2, item, [descArr2]);
            else item.add(0x10).writePointer(descArr2);
        } else if (cat.name === "rule") {
            var numS = makeS(vrec.numbering || "");
            var subArr = buildLocalizedTextArray(vrec.subtitle);
            var descArr3 = buildLocalizedTextArray(vrec.desc);
            var mi3 = A.cgm(itemCls, Memory.allocUtf8String(".ctor"), 3);
            if (mi3 && !mi3.isNull()) invokeOk(mi3, item, [numS, subArr, descArr3]);
            else { item.add(0x10).writePointer(numS); item.add(0x18).writePointer(subArr); item.add(0x20).writePointer(descArr3); }
        } else if (cat.name === "note") {
            var titleArr = buildLocalizedTextArray(vrec.title);
            var descArr4 = buildLocalizedTextArray(vrec.desc);
            var mi4 = A.cgm(itemCls, Memory.allocUtf8String(".ctor"), 2);
            if (mi4 && !mi4.isNull()) invokeOk(mi4, item, [titleArr, descArr4]);
            else { item.add(0x10).writePointer(titleArr); item.add(0x18).writePointer(descArr4); }
        }
        var vi = A.on(vItemCls);
        vi.add(fieldOffset(vItemCls, "_id", 0x10)).writePointer(makeS(id));
        vi.add(fieldOffset(vItemCls, "_version", 0x18)).writeS32(ver);
        vi.add(fieldOffset(vItemCls, "_item", 0x20)).writePointer(item);
        var ivp = makeIdVersionPair(id, ver);
        vi.add(fieldOffset(vItemCls, "_idVersionPair", 0x28)).writePointer(ivp);
        return { vi: vi, ivp: ivp, id: id, ver: ver, cat: cat };
    } catch (e) { wblog("buildVersionedItemFor err '" + id + "': " + e); return null; }
}
// 向 List<VersionedItem<...>> 注入某分类某条目的所有版本; page 给定则预填 _localizedTextData
export function injectVersions(list, addMi, vItemCls, cat, id, rec, page) {
    var keys = Object.keys(rec.versions), added = 0;
    for (var i = 0; i < keys.length; i++) {
        var b = buildVersionedItemFor(cat, vItemCls, id, parseInt(keys[i], 10), rec);
        if (!b || !b.vi || b.vi.isNull()) continue;
        if (!invokeOk(addMi, list, [b.vi]).ok) { wblog("List.Add 失败 '" + id + " v" + keys[i] + "'"); continue; }
        added++;
        if (page) registerLocalizedDict(page, b);
    }
    return added;
}
