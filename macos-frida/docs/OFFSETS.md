# 内存偏移速查表 (macOS / IL2CPP)

**为什么有这张表 (2026-09-28)**: 代码里散着 344 处 `.add(0x..)` 和 66 处硬编码 fallback,
排查时每次都要重新 grep 确认"这个 0x48 是什么"。这里汇总**已在代码里生效/已验证过**的那批 ——
不改代码, 只做索引。改游戏版本后若布局变了, `fieldOffset` 的"回退体检"会报警 (见 `src/utils.js`
的 `fieldOffsetProbe`), 报的字段名可以直接来这张表对照。

约定: 偏移都是**相对对象起始** (IL2CPP 的 field offset 已含基类部分)。

## 一、容器布局 (.NET / mono 侧, 与游戏无关, 极稳)

| 结构 | 偏移 | 含义 |
|---|---|---|
| `Dictionary<K,V>` | +0x10 | `_buckets` |
| | +0x18 | `_entries` (Entry[] 数组对象) |
| | +0x20 | `_count` (int) |
| Entry (stride **24**) | +0 | `hashCode` (int; **`-1` = 已删除的死槽**) |
| | +4 | `next` (int) |
| | +8 | `key` (指针) |
| | +16 | `value` (指针) |
| Array (SZARRAY) | +0x18 | length (int) |
| | +0x20 | 数据区起点 |
| `List<T>` | +0x10 | `_items` (T[]) |
| | +0x18 | `_size` (int) |
| | +0x1C | `_version` (int) |
| 装箱 `bool` | +0x10 | 值 (1 字节)。**`il2cpp_runtime_invoke` 对 bool 返回的是装箱对象**, 指针永不为 null |
| `System.String` | +0x10 | 字符数据 (UTF-16) |
| `System.Exception` | +0x10 | `_className` (String*) |
| | +0x18 | `_message` (String*) |
| | +0x40 | `_stackTraceString` (String*) |

> 判定"字典里某个键还在不在": 只扫 key 指针会被死槽骗 —— 必须先用 `hashCode >= 0` 过滤
> (见 `session.js:dictHasIdVer` / `dictFindKeyInstance`, 以及那里的"按实例匹配"长注释)。

## 二、游戏类型字段 (按类)

### 图鉴 (WitchBook)

| 类 | 字段 | 偏移 | 出处 |
|---|---|---|---|
| `WitchBookPageBase<TItem,TState>` | `_state` | 0x48 | session / pages / selftest |
| | `_addressableAssetLoader` | 0x50 | index / textures |
| | `_loadedDataItemMap` | 0x88 | session / pages / selftest |
| | `_displayableItemMaps` | 0x90 | pages |
| | `_itemIds` | 0x98 | session / pages / index / selftest |
| | `_currentItemId` | 0xA0 | session |
| | `_localizedTextData` | **每页不同** ↓ | |
| `CluePage` | `_localizedTextData` | 0xD0 | session |
| `NotePage` | `_localizedTextData` | 0xC8 | session |
| `ProfilePage` | `_localizedTextData` | 0xE8 | session |
| `RulePage` | `_localizedTextData` | 0xE8 | session |
| | `_numberings` | 0xE0 | pages |
| `MapPage` | `_localizedTextData` | 0xC0 | selftest (Map 分类尚未启用) |
| `MapDataItem` | `_buttonText` (LocalizedText[]) | 0x10 | data |
| `MapData` | `_items` | 0x18 | data |
| `WitchBookItemThumbnail` | `_rawImage` | 0x28 | session |
| | `_defaultTexture` | 0x38 | session (Awake/Reset 里设, 无 SerializeField) |
| `VersionedState` | `_list` | 0x10 | session / pages / selftest |
| `IdVersionPair` | `Id` (String*) | 0x10 | session |
| | `Version` (int32) | 0x18 | session |
| `VersionedItem` | `_id` | 0x10 | data / pages / session |
| | `_version` | 0x18 | data / session |
| | `_item` | 0x20 | data / session |
| | `_idVersionPair` | 0x28 | data / pages / session |
| 角色档案页 | `_authorLabel` | 0xB8 | characters |

### 其他

| 类 | 字段 | 偏移 | 出处 |
|---|---|---|---|
| `LocalizationManager` 等 | `<SelectedLocale>k__BackingField` | 0x20 | locale |
| `ResourceLoader` 相关 | `Implementation` / `PathPrefix` | 0x10 | choice |
| | `Loader` / `ProviderTypes` | 0x18 | choice |
| | `ProvisionSources` / `providersMap` | 0x20 | choice / characters |
| | `Resources` | 0x28 | choice |
| | `WaitHideOnChoice` | 0x30 | choice |
| Addressables 加载器 | `_loadedAssets` | 0x18 | textures |

## 三、怎么用这张表 & 怎么维护

1. **写新代码**: 优先 `fieldOffset(cls, "字段名", 0xNN)` —— 动态查成功就用真实偏移, 失败才回退。
2. **回退了但偏移错了**: `fieldOffsetProbe` 会沿基类链核对该字段的真实偏移, 不一致就 `[WARN]` 报警
   (每个类+字段只体检一次, 不刷屏)。报警文案里的字段名拿到本表对照。
3. **新确认的偏移**: 顺手补进本表 (尤其"每页不同的 `_localizedTextData`"那种特例)。
4. 未列出的一律以代码为准 —— 本表是索引, 不是真相源。
