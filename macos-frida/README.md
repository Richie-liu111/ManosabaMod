# ManosabaMod macOS 移植 (Frida)

把 `魔法少女の魔女审判` 的 Windows MOD 加载器 (BepInEx + Il2CppInterop + Harmony)
移植到 **macOS (Apple Silicon)**,用 **Frida** 直接注入 IL2CPP 运行时,不依赖 BepInEx。

## 状态 (2026-08-01)

| 功能 | 状态 |
|------|------|
| 自定义 mod 菜单 (标题画面) | ✅ |
| mod 剧本加载 (`.nani`, 经 provider 管线) | ✅ |
| 本地化文档 (`.txt`) | ✅ |
| voice / audio (`.wav`) | ✅ |
| WitchBook 线索 | ⏳ (Addressables 系统, 需 AddClue) |
| 背景 / 立绘 | ⏳ |

## 运行

```bash
./run_mod.sh          # 自动找游戏 + 注入 (Ctrl+C 停止)
./run_mod.sh <mod根目录>
```

前提:
- 游戏在 `manosaba_game_mac/` (自动向上查找)
- `python3` + `frida` (`pip install frida-tools`)
- macOS Apple Silicon (arm64)

## 架构

```
Frida 注入 → Steam 绕过 (dlopen hook)
→ il2cpp_thread_attach(domain) 解锁 il2cpp_runtime_invoke
→ 菜单: Script.FromText + AddLoadedResource (缓存)
→ provider 管线 (镜像 Windows AddModLoader):
    ScriptLoader / TextManager / voiceLoader / audioLoader
    各挂 LocalResourceProvider(MOD_ROOT) + converter
→ 游戏 @goto 驱动加载
```

## 关键技术发现

1. **thread_attach 是万能钥匙** — `il2cpp_runtime_invoke` 在未 attach 的 Frida 线程上会崩。
2. **`AddConverter<T>` 是 FSG 泛型方法** — `runtime_invoke` 对泛型方法定义报
   `ExecutionEngineException | Invalid call to method`。**绕开方案**: 从实例化泛型类的
   genericInst 挖出 `List<IConverter>` 类,用 inflated 泛型方法直接填充 converters 字典
   (`il2cpp_class_get_method_from_name` 在实例化类上返回 `is_inflated=1` 的可调方法)。
3. **Windows RVA 不跨平台** — 动态解析,不用 dump.cs 的 VA。
4. **裸调 `ScriptLoader.Load` 会 SIGSEGV** — 必须让游戏自己的 @goto 驱动。
5. Windows/macOS 同一 Unity (metadata v31),差异在调用时序,不在"是否编译"。

## 文件

| 文件 | 作用 |
|------|------|
| `manosabamod_v3.js` | 主 Frida 脚本 (Steam 绕过 + 菜单 + provider 注入 + 诊断 hook) |
| `run_mod.sh` | 启动脚本 |
| `run_probe2.py` / `run_v3test.py` | 探针 / v3 测试 runner |
| `probe_eee.js` / `probe_fsg.js` / `probe_conv*.js` / `probe_reps.js` | 诊断探针 |
| `ARCHIVE_2026-08-01.md` | 完整移植归档 (技术细节 / 布局 / 复现) |
