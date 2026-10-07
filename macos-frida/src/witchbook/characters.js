// ============ WitchBook 角色域: 立绘 provider 注册 + CharacterData/AuthorData 注入 + Profile 姓名覆写 ============
// 镜像 Windows AddRichCharacter/AddSimpleCharacter + TryInjectCharacterData + TryInjectAuthorData + ProfilePageRefreshContent_Patch
import { A, dbg, error, fieldOffset, findClassAcrossImages, findFirstObjectOfType, findSvc, invoke, invokeBool, invokeOk, listContainsId, makeLocalResourceProvider, makeS, populateConvertersDict, readStr, swallowed, swallowedWarn, warn, wblog } from "../utils.js";
import { wbCls, wbCurrentMod, wbData } from "./state.js";
import { buildLocalizedTextArray, localeValue, pickLocaleText, resolveLocale, unionLocaleKeys } from "./data.js";
import { getCurrentLocale, syncLocaleFromEngine } from "../locale.js";

// ===== 立绘 (Characters) 注册 — 镜像 Windows AddRichCharacter/AddSimpleCharacter + providersMap =====
// 从 metaMap.metas[] 偷一个原版 CharacterMetadata 的 Loader.ProviderTypes 类 (List<string>)
function stealListStringClass(metaMap) {
    try {
        var metas = metaMap.add(0x18).readPointer();   // ActorMetadataMap<T>.metas @0x18
        if (metas.isNull()) return ptr(0);
        var cnt = metas.add(0x18).readS32();
        for (var i = 0; i < cnt; i++) {
            var m = metas.add(0x20 + i * 8).readPointer();
            if (m.isNull()) continue;
            var loader = m.add(0x18).readPointer();    // ActorMetadata.Loader @0x18
            if (loader.isNull()) continue;
            var pt = loader.add(0x18).readPointer();   // ResourceLoaderConfiguration.ProviderTypes @0x18
            if (pt.isNull()) continue;
            return A.ogc(pt);
        }
    } catch (e) { swallowed("witchbook/characters.js:stealListStringClass", e); }
    return ptr(0);
}
// 立绘 provider: ① providersMap.Add(prefix, LRP(Texture2D)) ② CharacterManagerExtended 注册 ActorMetadata
export function addCharacterProviders(root, prefix) {
    try {
        logSpriteAqn();
        // ① ResourceProviderManager.providersMap.Add(prefix, lrp) — 角色 sprite 提供者
        var rpm = findSvc("ResourceProviderManager");
        if (rpm) {
            var rpmCls = A.ogc(rpm);
            var pm = rpm.add(fieldOffset(rpmCls, "providersMap", 0x20)).readPointer();
            if (!pm.isNull()) {
                var lrp = makeLocalResourceProvider(root);
                var texFn = function () { return findClassAcrossImages("UnityEngine", "Texture2D"); };
                if (!lrp.isNull() && populateConvertersDict(lrp, "JpgOrPngToTextureConverter", texFn, "providersMap/" + prefix)) {
                    var pmCls = A.ogc(pm);
                    // 先查是否已存在 (TitleUi 可能多次触发 → 重复 Add 抛 ArgumentException)
                    var containsMi = A.cgm(pmCls, Memory.allocUtf8String("ContainsKey"), 1);
                    var already = false;
                    if (containsMi && !containsMi.isNull()) {
                        // ContainsKey 返回 bool → il2cpp_runtime_invoke 返回的是装箱 Boolean 对象指针,
                        // 值在 +0x10。旧写法 r.ret.toInt32() === 1 永远不成立 → 守卫失效 → 重复 Add 抛
                        // ArgumentException (modlog2 实证: characters.js:53)。
                        already = invokeBool(containsMi, pm, [makeS(prefix)]);
                    }
                    if (!already) {
                        var addMi = A.cgm(pmCls, Memory.allocUtf8String("Add"), 2);
                        if (addMi && !addMi.isNull() && invokeOk(addMi, pm, [makeS(prefix), lrp]).ok)
                            dbg("[v3] providersMap.Add('" + prefix + "') 成功");
                        else
                            dbg("[v3] providersMap.Add('" + prefix + "') 失败/已存在");
                    }
                }
            }
        }
        // ② 注册 ActorMetadata — 用基础 CharacterManager (Configuration=CharactersConfiguration, 有 MetadataMap)
        var cm = findSvc("CharacterManager", true);
        if (!cm) cm = findSvc("CharacterManagerExtended");
        if (!cm) { dbg("[v3] addCharacterProviders: CharacterManager NOT FOUND"); return; }
        var cfg = null;
        // 扫描候选 Configuration 偏移 (ActorManager.Configuration 在对象内某处)
        var cfgCands = [0x10, 0x18, 0x20, 0x28, 0x30, 0x38, 0x40, 0x48, 0x50, 0x58, 0x60, 0x68, 0x70, 0x78, 0x80];
        for (var ci = 0; ci < cfgCands.length; ci++) {
            try {
                var cand = cm.add(cfgCands[ci]).readPointer();
                if (cand.isNull()) continue;
                var gmm = A.cgm(A.ogc(cand), Memory.allocUtf8String("get_MetadataMap"), 0);
                if (gmm && !gmm.isNull()) { cfg = cand; dbg("[v3] Configuration @0x" + cfgCands[ci].toString(16) + " = " + A.cgn(A.ogc(cand)).readCString()); break; }
            } catch (e) { swallowed("witchbook/characters.js:texFn", e); }
        }
        if (!cfg || cfg.isNull()) { dbg("[v3] CharacterManager.Configuration 未找到 (get_MetadataMap)"); return; }
        var gmmMi = A.cgm(A.ogc(cfg), Memory.allocUtf8String("get_MetadataMap"), 0);
        var metaMap = invoke(gmmMi, cfg, []);
        if (metaMap.isNull()) { dbg("[v3] MetadataMap 为 null"); return; }
        var addRecMi = A.cgm(A.ogc(metaMap), Memory.allocUtf8String("AddRecord"), 2);
        var containsIdMi = A.cgm(A.ogc(metaMap), Memory.allocUtf8String("ContainsId"), 1);
        var metaCls = findClassAcrossImages("Naninovel", "CharacterMetadata");
        var loaderCls = findClassAcrossImages("Naninovel", "ResourceLoaderConfiguration");
        var listStrCls = stealListStringClass(metaMap);
        if (!addRecMi || addRecMi.isNull() || metaCls.isNull() || loaderCls.isNull() || listStrCls.isNull()) {
            dbg("[v3] 立绘注册类解析失败 (AddRecord/meta/loader/List<string>)"); return;
        }
        var metaCtor = A.cgm(metaCls, Memory.allocUtf8String(".ctor"), 0);
        var loaderCtor = A.cgm(loaderCls, Memory.allocUtf8String(".ctor"), 0);
        var implStr = "Naninovel.SpriteCharacter, Elringus.Naninovel.Runtime, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null";   // 完整 AQN (IL2CPP Type.GetType 需全名)
        var ids = Object.keys(wbData.characters), added = 0, skipped = 0;
        for (var i = 0; i < ids.length; i++) {
            var cc = wbData.characters[ids[i]];
            if (cc.key !== prefix) continue;
            // 已存在则跳过 — 两层含义: ① TitleUi 可能多次触发 ② 该 ID 已被原版或其它 mod 占用。
            //   ② 是上游 ModResourceLoader.AddRichCharacter 的核心守卫: 声明原版角色 ID 的 mod
            //   (如某 mod 声明了原版角色 id 想改名) 必须整体跳过, 否则 AddRecord
            //   会把原版 LayeredCharacter 记录换成 SpriteCharacter + PathPrefix=<mod>/Characters,
            //   之后原版剧本 @char <原版角色>.<组合外观> 全部 "Failed to load" (2026-09-25 实证)。
            // ContainsId 返回 bool → 走装箱读取, 不能用 r.ret.toInt32() (永远 ≠ 1, 守卫失效)。
            if (containsIdMi && !containsIdMi.isNull() && invokeBool(containsIdMi, metaMap, [makeS(ids[i])])) {
                skipped++;
                continue;
            }
            try {
                var meta = A.on(metaCls);
                if (metaCtor && !metaCtor.isNull()) invokeOk(metaCtor, meta, []);
                // Loader: ResourceLoaderConfiguration{PathPrefix=prefix/Characters, ProviderTypes=[prefix]}
                var loader = A.on(loaderCls);
                if (loaderCtor && !loaderCtor.isNull()) invokeOk(loaderCtor, loader, []);
                loader.add(0x10).writePointer(makeS(prefix + "/Characters"));   // PathPrefix
                loader.add(0x18).writePointer(makeListString(listStrCls, [prefix]));  // ProviderTypes
                meta.add(0x18).writePointer(loader);    // Loader
                meta.add(0x10).writePointer(makeS(implStr));  // Implementation
                meta.add(0x30).writeFloat(0.5); meta.add(0x34).writeFloat(0.695);  // Pivot
                meta.add(0x38).writeFloat(100);         // PixelsPerUnit (0 → 立绘不可见)
                // DisplayName @0x78 ('​' 前缀强制用角色名)
                var disp = cc.simple ? pickLocaleText(cc.displayName) : (pickLocaleText(cc.familyName) + pickLocaleText(cc.name));
                if (!disp) disp = ids[i];
                meta.add(0x78).writePointer(makeS("​" + disp));
                // 颜色 (Characters 完整角色才有)
                if (cc.color && !cc.simple) {
                    var rgba = hexColorFloats(cc.color);
                    meta.add(0x80).writeU8(1);   // UseCharacterColor
                    for (var f = 0; f < 4; f++) meta.add(0x84 + f * 4).writeFloat(rgba[f]);   // NameColor
                    for (var f2 = 0; f2 < 4; f2++) meta.add(0x94 + f2 * 4).writeFloat(1.0);    // MessageColor (white)
                }
                if (invokeOk(addRecMi, metaMap, [makeS(ids[i]), meta]).ok) added++;
            } catch (e) { dbg("[v3] 角色注册 err '" + ids[i] + "': " + e); }
        }
        var summary = "addCharacterProviders: mod '" + prefix + "' 新注册 " + added + " 个角色" +
            (skipped ? ", 跳过 " + skipped + " 个已存在 ID (原版/其它 mod 占用, 改名无效)" : "");
        if (skipped) wblog(summary); else dbg("[v3] " + summary);   // 无冲突时保持静默 (原为 dbg)
    } catch (e) { dbg("[v3] addCharacterProviders err: " + e); }
}
// "#ffd1d9" → [r,g,b,a] float (Unity Color 顺序)
function hexColorFloats(hex) {
    var h = (hex || "").replace(/^#/, "");
    if (h.length < 6) return [1, 1, 1, 1];
    var r = parseInt(h.substr(0, 2), 16) / 255, g = parseInt(h.substr(2, 2), 16) / 255, b = parseInt(h.substr(4, 2), 16) / 255;
    return [r, g, b, 1];
}
// 立绘 provider: ① providersMap.Add(prefix, LRP(Texture2D)) ② CharacterManager 注册 ActorMetadata
var wbAqnLogged = false;
function logSpriteAqn() {
    if (wbAqnLogged) return;
    wbAqnLogged = true;
    try {
        var scCls = findClassAcrossImages("Naninovel", "SpriteCharacter");
        if (!scCls || scCls.isNull()) { dbg("[v3] SpriteCharacter 类未找到"); return; }
        var typeObj = A.tgo(A.cgt(scCls));
        var typeCls = A.ogc(typeObj);
        var aqnMi = A.cgm(typeCls, Memory.allocUtf8String("get_AssemblyQualifiedName"), 0);
        if (aqnMi && !aqnMi.isNull()) {
            var s = invoke(aqnMi, typeObj, []);
            dbg("[v3] SpriteCharacter AQN = '" + readStr(s) + "'");
        } else {
            dbg("[v3] get_AssemblyQualifiedName NOT FOUND, typeCls=" + A.cgn(typeCls).readCString());
        }
    } catch (e) { dbg("[v3] logSpriteAqn err: " + e); }
}
function makeListString(cls, elems) {
    try {
        if (!cls || cls.isNull()) return ptr(0);
        var list = A.on(cls);
        var ctorMi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 0);
        if (ctorMi && !ctorMi.isNull()) invokeOk(ctorMi, list, []);
        var addMi = A.cgm(cls, Memory.allocUtf8String("Add"), 1);
        for (var i = 0; i < elems.length; i++) if (addMi && !addMi.isNull()) invokeOk(addMi, list, [makeS(elems[i])]);
        return list;
    } catch (e) { return ptr(0); }
}

// 1.5) 注入 CharacterData._items (新角色基本数据, 供 Profile 显示角色名; 镜像 Windows TryInjectCharacterData)
// 返回: 本次写入条数; -1 = 目标类/实例/容器未就位 (资产还没加载, 调用方可以稍后重试); 0 = 无需注入或已存在。
export function injectCharacterData() {
    try {
        if (Object.keys(wbData.characters).length === 0) return 0;
        if (!wbCls.characterData || wbCls.characterData.isNull()) { warn("CharacterData 类未解析"); return -1; }
        var inst = findFirstObjectOfType(wbCls.characterData);
        if (!inst) { warn("CharacterData 实例未找到 (可能未加载)"); return -1; }
        var items = inst.add(fieldOffset(wbCls.characterData, "_items", 0x18)).readPointer();
        if (items.isNull()) return -1;
        var listCls = A.ogc(items);
        var addMi = A.cgm(listCls, Memory.allocUtf8String("Add"), 1);
        if (!addMi || addMi.isNull()) return -1;
        var itemCls = wbCls.characterDataItem;
        var ctorMi = A.cgm(itemCls, Memory.allocUtf8String(".ctor"), 6);
        var ids = Object.keys(wbData.characters), added = 0;
        for (var i = 0; i < ids.length; i++) {
            var cc = wbData.characters[ids[i]];
            if (cc.key !== wbCurrentMod) continue;   // 只注入当前 mod 的角色
            if (listContainsId(items, ids[i], 0x10)) continue;   // CharacterDataItem._id @0x10
            var item = A.on(itemCls);
            var nameArr = buildLocalizedTextArray(cc.name);
            var famArr = buildLocalizedTextArray(cc.familyName);
            if (ctorMi && !ctorMi.isNull()) {
                var r = invokeOk(ctorMi, item, [makeS(ids[i]), nameArr, famArr, makeS(cc.age), makeS(cc.height), makeS(cc.weight)]);
                if (!r.ok) { warn("CharacterDataItem.ctor 失败 '" + ids[i] + "'"); continue; }
            } else {
                item.add(0x10).writePointer(makeS(ids[i]));
                item.add(0x18).writePointer(nameArr);
                item.add(0x20).writePointer(famArr);
                item.add(0x28).writePointer(makeS(cc.age));
                item.add(0x30).writePointer(makeS(cc.height));
                item.add(0x38).writePointer(makeS(cc.weight));
            }
            if (invokeOk(addMi, items, [item]).ok) added++;
        }
        if (added) wblog("CharacterData 注入 " + added + " 个角色");
        return added;
    } catch (e) { error("injectCharacterData err: " + e); return -1; }
}
// ProfilePage.RefreshPageContent onLeave: 覆写 mod 新角色的姓名标签 (_authorLabel @0xB8)
// 镜像 Windows ProfilePageRefreshContent_Patch: 原版对不在角色系统中的 id 显示 ID,
// 我们直接设置 _authorLabel.text = 格式化富文本 (BuildFullName 同款字号/颜色)
// 语言: 用 locale.js 跟踪的当前语言 (HandleLocaleChanged 实参, 实证可靠),
// 不再硬编码 zh-Hans → 切日语后档案姓名应随语言切换 (本地化显示名 vs 注册名)。
export function hookProfileName() {
    try {
        var cls = wbCls.pages.profile;
        if (!cls || cls.isNull()) return;
        var mi = A.cgm(cls, Memory.allocUtf8String("RefreshPageContent"), 1);
        if (!mi || mi.isNull()) { warn("ProfilePage.RefreshPageContent NOT FOUND"); return; }
        Interceptor.attach(mi.readPointer(), {
            onEnter: function (a) {
                try {
                    this._self = a[0];
                    var map = a[1];
                    this._pid = map ? readStr(map.add(0x10).readPointer()) : null;   // VersionedItem._id
                } catch (e) { this._pid = null; }
            },
            onLeave: function () {
                try {
                    var id = this._pid;
                    if (!id || !wbData.characters[id]) return;
                    var cc = wbData.characters[id];
                    if (cc.key !== wbCurrentMod) return;
                    var label = this._self.add(fieldOffset(wbCls.pages.profile, "_authorLabel", 0xB8)).readPointer();
                    if (label.isNull()) return;
                    var labCls = A.ogc(label);
                    var setTxt = A.cgm(labCls, Memory.allocUtf8String("set_text"), 1);
                    if (!setTxt || setTxt.isNull()) return;
                    try { syncLocaleFromEngine(); } catch (e) { swallowedWarn("witchbook/characters.js:hookProfileName.onLeave", e); }   // 兜底: 主动查一次 LocalizationManager (启动即目标语言)
                    var loc = getCurrentLocale();   // 跟随当前语言 (ja → 该语言下的显示名)
                    var tpl = buildAuthorTemplate(cc, loc);
                    if (!tpl) tpl = buildAuthorTemplate(cc, "zh-Hans");
                    if (!tpl) tpl = buildAuthorTemplate(cc, "ja");
                    if (tpl) invokeOk(setTxt, label, [makeS(tpl)]);
                } catch (e) { swallowedWarn("witchbook/characters.js:hookProfileName.onLeave#2", e); }
            }
        });
        wblog("ProfilePage 姓名覆写 hook 就绪");
    } catch (e) { error("hookProfileName err: " + e); }
}
// 生成 AuthorData 模板 (镜像 Windows AuthorTaggedTextGenerator.BuildFullName: 姓首字大号带色 + 名首字次大号)
export function buildAuthorTemplate(cc, localeTag) {
    try {
        var family = resolveLocale(cc.familyName, localeTag) || "";
        var given = resolveLocale(cc.name, localeTag) || "";
        var color = (cc.color || "#ffffff").replace(/^#/, "");
        function part(text, initialSize, bodySize, withColor) {
            if (!text) return "";
            var initial = text.charAt(0);
            var body = text.length > 1 ? text.slice(1) : "";
            var s = "";
            if (withColor && color) s += "<color=#" + color + ">";
            s += "<size=" + initialSize + ">" + initial + "</size>";
            if (withColor && color) s += "</color>";
            if (body) s += "<space=4><voffset=-2><size=" + bodySize + ">" + body + "</size></voffset>";
            return s;
        }
        if (family && given) return part(family, 136, 73, true) + "<space=4>" + part(given, 118, 75, false);
        if (family) return part(family, 136, 73, true);
        if (given) return part(given, 118, 75, true);
        return "";
    } catch (e) { return ""; }
}
// 1.6) 注入 AuthorData._items (发言人名模板, 供 Profile 显示角色名; 镜像 Windows TryInjectAuthorData)
// 返回约定同 injectCharacterData (>=0 条数 / -1 目标未就位)。
export function injectAuthorData() {
    try {
        if (Object.keys(wbData.characters).length === 0) return 0;
        if (!wbCls.authorData || wbCls.authorData.isNull()) { warn("AuthorData 类未解析"); return -1; }
        var inst = findFirstObjectOfType(wbCls.authorData);
        if (!inst) { warn("AuthorData 实例未找到 (可能未加载)"); return -1; }
        var items = inst.add(fieldOffset(wbCls.authorData, "_items", 0x18)).readPointer();
        if (items.isNull()) return -1;
        var listCls = A.ogc(items);
        var addMi = A.cgm(listCls, Memory.allocUtf8String("Add"), 1);
        if (!addMi || addMi.isNull()) return -1;
        var itemCls = wbCls.authorDataItem;
        var ctorMi = A.cgm(itemCls, Memory.allocUtf8String(".ctor"), 2);
        var ltsCtor = A.cgm(wbCls.localizedText, Memory.allocUtf8String(".ctor"), 2);
        var ids = Object.keys(wbData.characters), added = 0;
        for (var i = 0; i < ids.length; i++) {
            var cc = wbData.characters[ids[i]];
            if (cc.key !== wbCurrentMod) continue;
            if (listContainsId(items, ids[i], 0x10)) continue;   // AuthorDataItem._id @0x10
            var tags = unionLocaleKeys(cc.name, cc.familyName);
            var arr = A.an(wbCls.localizedText, tags.length);
            for (var t = 0; t < tags.length; t++) {
                var lt = A.on(wbCls.localizedText);
                var lv = Memory.alloc(4); lv.writeS32(localeValue(tags[t]));
                if (ltsCtor && !ltsCtor.isNull()) invokeOk(ltsCtor, lt, [lv, makeS(buildAuthorTemplate(cc, tags[t]))]);
                arr.add(0x20 + t * 8).writePointer(lt);
            }
            var item = A.on(itemCls);
            if (ctorMi && !ctorMi.isNull()) {
                if (!invokeOk(ctorMi, item, [makeS(ids[i]), arr]).ok) { warn("AuthorDataItem.ctor 失败 '" + ids[i] + "'"); continue; }
            } else { item.add(0x10).writePointer(makeS(ids[i])); item.add(0x18).writePointer(arr); }
            if (invokeOk(addMi, items, [item]).ok) added++;
        }
        if (added) wblog("AuthorData 注入 " + added + " 个角色模板");
        return added;
    } catch (e) { error("injectAuthorData err: " + e); return -1; }
}

// 按名字在**整个类继承链**上找字段 (A.gf 不查基类, see utils.js:384)。
// 找不到返回 null —— 调用方必须当"功能不可用"处理, 绝不能猜偏移瞎读。
export function findFieldAnywhere(cls, name) {
    try {
        var up = cls;
        for (var d = 0; d < 12 && up && !up.isNull(); d++) {
            var f = A.gf(up, Memory.allocUtf8String(name));
            if (f && !f.isNull()) {
                var on = "?";
                try { on = A.cgn(up).readCString(); } catch (e2) { swallowed("witchbook/characters.js:findFieldAnywhere", e2); }
                return { off: A.fo(f), on: on, depth: d };
            }
            up = A.cgp(up);
        }
    } catch (e) { swallowed("witchbook/characters.js:findFieldAnywhere", e); }
    return null;
}
// 1.7) backlog (历史回放) 作者名覆写 —— 镜像 Windows LogAuthorFormat_Patch。
// 为什么不能靠数据注入救它 (2026-10-07 实测, 见 ROADMAP 差距 7):
//   backlog 面板 (WitchTrialsLogUi) 的 AuthorTextBuilder 在**游戏启动时**就把 _nameData/_authorData
//   定型了 —— 它 23:05:49.136 已是"未命中", 而最早一次成功注入是 23:05:49.134; 且 mod 要等剧本加载
//   才知道是谁 (试过挂在 ScriptLoader.Load 上"提早注入", 结果比首次注入还晚 9ms)。
//   → 注入永远追不上启动时就建好的 builder。所以在原版渲染完之后覆写标签文本 (与 hookProfileName 同法)。
export function hookLogAuthorName() {
    try {
        var cls = findClassAcrossImages("WitchTrials.Views", "WitchTrialsLogMessageUi");
        if (!cls || cls.isNull()) { warn("WitchTrialsLogMessageUi 类未解析 (backlog 姓名覆写跳过)"); return; }
        var mi = A.cgm(cls, Memory.allocUtf8String("ModifyAuthorPanel"), 1);
        if (!mi || mi.isNull()) { warn("WitchTrialsLogMessageUi.ModifyAuthorPanel NOT FOUND (backlog 姓名覆写跳过)"); return; }
        var fId = findFieldAnywhere(cls, "_authorId");
        var fLabel = findFieldAnywhere(cls, "_authorLabel");
        wblog("backlog 姓名覆写: _authorId=" + (fId ? "0x" + fId.off.toString(16) + " (声明于 " + fId.on + ")" : "未找到") +
              ", _authorLabel=" + (fLabel ? "0x" + fLabel.off.toString(16) + " (声明于 " + fLabel.on + ")" : "未找到"));
        if (!fId || !fLabel) { warn("backlog 姓名覆写: 字段没找全 → 本次不生效 (见上一行, 不要猜偏移)"); return; }
        Interceptor.attach(mi.readPointer(), {
            onEnter: function (a) { try { this._self = a[0]; } catch (e) { this._self = null; } },
            onLeave: function () {
                try {
                    if (!this._self) return;
                    var id = readStr(this._self.add(fId.off).readPointer());
                    if (!id || !wbData.characters[id]) return;
                    var cc = wbData.characters[id];
                    if (cc.key !== wbCurrentMod) return;              // 只管当前 mod 的完整角色 (simple 角色走原版 DisplayName)
                    var label = this._self.add(fLabel.off).readPointer();
                    if (label.isNull()) return;
                    var setTxt = A.cgm(A.ogc(label), Memory.allocUtf8String("set_text"), 1);
                    if (!setTxt || setTxt.isNull()) return;
                    try { syncLocaleFromEngine(); } catch (eL) { swallowedWarn("witchbook/characters.js:hookLogAuthorName.locale", eL); }
                    var tpl = buildAuthorTemplate(cc, getCurrentLocale());
                    if (!tpl) tpl = buildAuthorTemplate(cc, "zh-Hans");
                    if (!tpl) tpl = buildAuthorTemplate(cc, "ja");
                    if (tpl) invokeOk(setTxt, label, [makeS(tpl)]);
                } catch (e) { swallowedWarn("witchbook/characters.js:hookLogAuthorName.onLeave", e); }
            }
        });
        wblog("backlog 作者名覆写 hook 就绪");
    } catch (e) { error("hookLogAuthorName err: " + e); }
}