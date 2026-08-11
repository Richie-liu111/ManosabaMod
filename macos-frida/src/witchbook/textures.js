// ============ WitchBook 纹理域: PNG → Texture2D → AddressablesManager._loadedAssets ============
// 缩略图 + @spawn ClueItem 共用; 镜像 Windows ModTextureHelper
import { A, fieldOffset, findAllObjectOfType, findClassAcrossImages, getSystemClass, invokeOk, makeS, nv, readStr, wblog, dbg, error, warn } from "../utils.js";
import { fileReadBytes } from "../io.js";
import { wbCls, wbData } from "./state.js";
import { currentModIds, wbCats } from "./data.js";

// 4) 纹理: 读 PNG → Texture2D → 注册进 AddressablesManager._loadedAssets (缩略图 + @spawn 共用)
export function loadModTexture(id) {
    if (wbData.texCache[id]) return wbData.texCache[id];
    var path = wbData.texPaths[id];
    if (!path) return null;
    try {
        var fb = fileReadBytes(path);
        if (!fb || fb.size <= 0) { warn("读取纹理失败 '" + id + "'"); return null; }
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
        if (!liMi || liMi.isNull()) { warn("ImageConversion.LoadImage NOT FOUND"); return null; }
        var r = invokeOk(liMi, ptr(0), [tex, barr]);   // 静态
        if (!r.ok) { warn("LoadImage 失败 '" + id + "'"); return null; }
        wbData.texCache[id] = tex;
        dbg("纹理加载 '" + id + "' -> " + tex);
        return tex;
    } catch (e) { error("loadModTexture err '" + id + "': " + e); return null; }
}
export function findAddressablesManager() {
    // 1) 各页面 _addressableAssetLoader (同一 AddressablesManager 单例)
    try {
        if (wbCls && wbCls.pages) {
            var pn = Object.keys(wbCls.pages);
            for (var pi = 0; pi < pn.length; pi++) {
                var pageCls = wbCls.pages[pn[pi]];
                if (!pageCls || pageCls.isNull()) continue;
                var pages = findAllObjectOfType(pageCls);
                if (pages.length) {
                    var m = pages[0].add(fieldOffset(pageCls, "_addressableAssetLoader", 0x50)).readPointer();
                    if (m && !m.isNull()) return m;
                }
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
export function registerTexturesInto(managerPtr) {
    try {
        // 未指定时用全局 AddressablesManager 服务 (镜像 Windows ServiceLocator.Get<IAddressablesManager>)
        if (!managerPtr || managerPtr.isNull()) managerPtr = findAddressablesManager();
        if (!managerPtr || managerPtr.isNull()) { warn("AddressablesManager 未找到"); return; }
        var mgrCls = A.ogc(managerPtr);
        var dict = managerPtr.add(fieldOffset(mgrCls, "_loadedAssets", 0x18)).readPointer();
        if (dict.isNull()) { warn("AddressablesManager._loadedAssets 为 null"); return; }
        var dictCls = A.ogc(dict);
        var addMi = A.cgm(dictCls, Memory.allocUtf8String("Add"), 2);
        if (!addMi || addMi.isNull()) { warn("Dict.Add NOT FOUND"); return; }
        // 收集当前 mod 所有带纹理的条目 (clue/profile)
        var texIds = [], catNames = Object.keys(wbCats);
        for (var ci = 0; ci < catNames.length; ci++) {
            var cat = wbCats[catNames[ci]];
            if (!cat.texDir || !cat.addr) continue;
            currentModIds(cat).forEach(function (id) { if (wbData.texPaths[id]) texIds.push(id); });
        }
        var count = 0;
        for (var i = 0; i < texIds.length; i++) {
            var tex = loadModTexture(texIds[i]);
            if (!tex) continue;
            var cat2 = null, id2 = texIds[i];
            for (var ci2 = 0; ci2 < catNames.length; ci2++) {
                var c2 = wbCats[catNames[ci2]];
                if (wbData[c2.name][id2]) { cat2 = c2; break; }
            }
            if (!cat2 || !cat2.addr) continue;
            var addr = cat2.addr(id2);
            if (dictContainsKey(dict, addr)) continue;
            if (invokeOk(addMi, dict, [makeS(addr), tex]).ok) count++;
        }
        if (count > 0) wblog("Addressables 注册 " + count + " 张纹理");
    } catch (e) { error("registerTexturesInto err: " + e); }
}
export function dictContainsKey(dict, key) {
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
