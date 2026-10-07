#!/usr/bin/env node
// ============ 空 catch 审计 / 治理 (步骤 2.1) ============
// 背景 (2026-09-25 最贵的一课): 排查"图鉴打不开"时, 有 4 处**诊断代码自己静默失败**
//   (钩子被 mod-only 过滤掉 / 方法名写错 / 函数在这个版本不存在), 于是"看不到输出"
//   被误读成"游戏没抛异常", 白跑好几轮。根因不是某一次的补丁, 而是**223 处 `catch {}` 全无痕迹**。
// 本工具把"空 catch"逐个找出来, 给它留一行痕:
//   catch (e) {}                        →  catch (e) { swallowed("<文件>:<函数>", e); }        (dbg 级, 节流)
//   catch (e) { // 说明 }               →  注释保留, 其后插入 swallowed(...)
// 之后由人工把**关键路径**(字典/状态/注入/资源加载)的少数几处改成 `swallowedWarn` (warn 级, 默认可见)。
//
// 用法:
//   node tools/catch-audit.mjs               # 干跑: 列出每一处 + 归属函数 + 建议 tag (不改文件)
//   node tools/catch-audit.mjs --apply       # 实际改写
//   node tools/catch-audit.mjs --json        # 机器可读输出
//
// 刻意**跳过**的位置 (改了会出事或没意义):
//   · log.js 的崩溃上下文 (crashLine / installCrashHandler / Fallback) — 那里禁 console/RPC, 会死锁
//   · 整行被注释掉的死代码里的 `catch (e) {}` — 改了不起作用只添噪 (这类死代码本身应尽早删)
//   · probe_textlocalizer.js (已无调用点的死文件, 删不删由用户定)
//
// 文件级"有意静默"声明 (2026-10-07 新增): 有些文件的空 catch 是**设计如此** (例: 日志函数自己
//   的 catch 不能再调日志, 会递归死锁; 探针把读失败以 -1 呈现在输出里, 再打 WARN 只刷屏)。
//   这类在文件里写一行机器可读的声明, 理由随代码走:
//       // catch-audit: intentional-silence <一句话理由>
//   效果: 该文件的空 catch 仍**列在报告里** (标 [已声明静默]), 但不计入"待处理", 不影响退出码。
//   为什么不用中央白名单: 白名单会被悄悄加长而没人看理由; 声明写在文件里, 改代码的人必然看见。
//
// 退出码: 存在**未声明**的空 catch → 1 (可接进 CI/构建前检查); 全清或全已声明 → 0。
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO, "src");
const SKIP_FILES = new Set(["probe_textlocalizer.js", "log.js"]);   // log.js 全手工 (它自己实现 swallowed; 且多数空 catch 在崩溃上下文)
// 崩溃上下文函数: 其中一切日志都会死锁 (见 log.js 顶部注释)
const NO_LOG_FUNCS = new Set(["crashLine", "installCrashHandler", "installCrashHandlerFallback"]);

function walk(dir, out = []) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (p.endsWith(".js")) out.push(p);
    }
    return out;
}

// 空 catch: 体内只有空白, 或只有 // 注释
const RE_EMPTY = /catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{\s*\}/g;
const RE_COMMENT_ONLY = /catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{\s*(\/\/[^\n]*?)\s*\}/g;
// 文件级"有意静默"声明 (见文件头说明)
const RE_OPT_OUT = /\/\/\s*catch-audit:\s*intentional-silence\b[ \t]*([^\n]*)/;

const FN_PATTERNS = [
    /(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,               // function name(
    /([A-Za-z_$][\w$]*)\s*:\s*function\s*\(/g,                          // obj: function(
    /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*function\s*\(/g,      // var name = function(
    /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,  // 箭头
];
// 只认"带名字的声明/赋值"; `x: function`(钩子的 onEnter/onLeave) 单列, 用它的**外层函数**做 tag 更有信息量
const DECLARED_FN_PATTERNS = FN_PATTERNS.slice(0, 1).concat(FN_PATTERNS.slice(2));
const PROP_FN_PATTERN = FN_PATTERNS[1];

function lastMatch(src, patterns, upto) {
    let best = null, bestIdx = -1;
    for (const re of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src)) !== null) {
            if (m.index >= upto) break;
            if (m.index > bestIdx) { bestIdx = m.index; best = { name: m[1], idx: m.index }; }
        }
    }
    return best;
}

function enclosingFn(src, upto) {
    const any = lastMatch(src, FN_PATTERNS, upto);
    if (!any) return "(顶层)";
    // onEnter/onLeave 这类钩子回调: 再往外找一层具名函数 → "chHookRl.onEnter", 比裸 "onEnter#7" 好认
    if (any.name === "onEnter" || any.name === "onLeave") {
        const outer = lastMatch(src, DECLARED_FN_PATTERNS, any.idx);
        if (outer) return `${outer.name}.${any.name}`;
    }
    return any.name;
}

function lineOf(src, idx) {
    return src.slice(0, idx).split("\n").length;
}

/** 该匹配是否位于注释行内 (行首可有空白, 然后是 // 或 *) */
function inCommentLine(src, idx) {
    const start = src.lastIndexOf("\n", idx - 1) + 1;
    const line = src.slice(start, idx);
    return /^\s*(\/\/|\*|\/\*)/.test(line);
}

function collect(file) {
    const src = readFileSync(file, "utf8");
    const rel = relative(REPO, file).replace(/^src\//, "");
    const sites = [];
    for (const [re, hasComment] of [[RE_EMPTY, false], [RE_COMMENT_ONLY, true]]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src)) !== null) {
            if (inCommentLine(src, m.index)) continue;
            sites.push({ file, rel, src, idx: m.index, end: m.index + m[0].length, len: m[0].length,
                         v: m[1], comment: hasComment ? m[2] : null, fn: enclosingFn(src, m.index),
                         line: lineOf(src, m.index) });
        }
    }
    // 文件级"有意静默"声明: 打上标记, 报告里仍然列出 (可见), 但不计入待处理
    const optOut = RE_OPT_OUT.exec(src);
    const declReason = optOut ? (optOut[1].trim() || "(未写理由)") : null;
    for (const s of sites) { s.declared = !!optOut; s.declReason = declReason; }
    return sites.sort((a, b) => a.idx - b.idx);
}

function plan(sites) {
    // 同一文件内同名 tag 加序号, 便于精确定位 (节流仍按 tag 聚合)
    const seen = {};
    for (const s of sites) {
        const base = `${s.rel}:${s.fn}`;
        seen[base] = (seen[base] || 0) + 1;
        s.tag = seen[base] > 1 ? `${base}#${seen[base]}` : base;
        s.noLog = NO_LOG_FUNCS.has(s.fn);
        // 不参与"待处理"的两种: 崩溃上下文(打了会死锁) / 文件已声明有意静默
        s.skip = s.noLog || s.declared;
    }
    return sites;
}

/** 把 name 补进 `import { ... } from "<...>/utils.js"` (保持字母序); 返回是否改动了 src */
function ensureImport(src, name) {
    const re = /import\s*\{([^}]*)\}\s*from\s*"([^"]*utils\.js)";/;
    const m = re.exec(src);
    if (!m) return { src, ok: false, why: "没有 utils.js 的具名导入" };
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    if (names.includes(name)) return { src, ok: true, why: "已存在" };
    names.push(name);
    names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const rebuilt = `import { ${names.join(", ")} } from "${m[2]}";`;
    return { src: src.slice(0, m.index) + rebuilt + src.slice(m.index + m[0].length), ok: true, why: "已补入" };
}

function apply(sites) {
    const byFile = new Map();
    for (const s of sites) {
        if (s.skip) continue;
        if (!byFile.has(s.file)) byFile.set(s.file, []);
        byFile.get(s.file).push(s);
    }
    let changed = 0;
    for (const [file, list] of byFile) {
        let src = readFileSync(file, "utf8");
        // 从后往前替换, 避免偏移失效
        for (const s of [...list].sort((a, b) => b.idx - a.idx)) {
            const hit = src.slice(s.idx, s.idx + s.len);
            if (hit !== s.src.slice(s.idx, s.idx + s.len)) {
                console.log(`  ! 跳过 (文件已变): ${s.rel}:${s.line}`);
                continue;
            }
            const body = s.comment
                ? `catch (${s.v}) { ${s.comment} swallowed("${s.tag}", ${s.v}); }`
                : `catch (${s.v}) { swallowed("${s.tag}", ${s.v}); }`;
            src = src.slice(0, s.idx) + body + src.slice(s.idx + s.len);
            changed++;
        }
        const imp = ensureImport(src, "swallowed");
        if (!imp.ok) console.log(`  ! ${list[0].rel}: ${imp.why} —— swallowed 可能未定义, 需手工处理`);
        else if (imp.why !== "已存在") console.log(`  · ${list[0].rel}: 导入 ${imp.why}`);
        writeFileSync(file, imp.src);
    }
    return changed;
}

/** 关键路径升级: swallowed → swallowedWarn (WARN 级, 默认可见)。
 *  判据: 这里吞掉异常, 就会**静默产生**我们已经踩过的那类 bug (字典键丢了→图鉴打不开 /
 *  元数据没还原→角色被覆写)。校验类的热读 (dictHasIdVer 等) 保持 dbg —— 它们抛异常不等于结论错。 */
const WARN_TAGS = [
    "witchbook/session.js:restorePageFromData", "witchbook/session.js:clearModItemsFromPage",
    "witchbook/session.js:removeStateEntries", "witchbook/session.js:clearPageState",
    "witchbook/session.js:rebuildAllPages", "witchbook/session.js:clearAllWitchBookPages",
    "witchbook/session.js:restorePageDefaults",
    // 键实例扫描: 抛异常 → 回退到"重建的键"→ 正是图鉴打不开那条链, 必须可见
    "witchbook/session.js:dictFindKeyInstance", "witchbook/session.js:dictHasIdVer",
    "witchbook/pages.js:registerLocalizedDict", "witchbook/pages.js:applyStates",
    "witchbook/pages.js:ensureStateEntriesDict", "witchbook/pages.js:getFirstDictValue",
    "witchbook/dictheal.js:healDictKey",
    "witchbook/characters.js:hookProfileName.onLeave",   // 原版角色元数据还原 (2026-09-25 坑 #1)
    "witchbook/textures.js:dictContainsKey",
    "utils.js:invokeBool",
];

function upgradeWarn() {
    let n = 0;
    for (const f of walk(SRC)) {
        if (f.endsWith("log.js")) continue;                   // log.js 手工
        let src = readFileSync(f, "utf8");
        const before = src;
        for (const tag of WARN_TAGS) {
            const re = new RegExp(`swallowed\\("${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(#[0-9]+)?"`, "g");
            src = src.replace(re, (m0) => { n++; return m0.replace("swallowed(", "swallowedWarn("); });
        }
        if (src === before) continue;
        const imp = ensureImport(src, "swallowedWarn");
        if (!imp.ok) console.log(`  ! ${f}: ${imp.why} —— swallowedWarn 可能未定义`);
        writeFileSync(f, imp.src);
    }
    console.log(`[catch-audit] ✓ 已把 ${n} 处升级为 swallowedWarn (WARN 级, 默认可见)`);
}

const files = walk(SRC).filter((f) => !SKIP_FILES.has(f.split("/").pop()));
let all = [];
for (const f of files) all.push(...collect(f));
all = plan(all);

const applyMode = process.argv.includes("--apply");
const jsonMode = process.argv.includes("--json");

const pending = all.filter((s) => !s.skip);        // 需要处理的 (未声明且非崩溃上下文)

if (jsonMode) {
    console.log(JSON.stringify(all.map((s) => ({ file: s.rel, line: s.line, fn: s.fn, tag: s.tag,
                                                 noLog: s.noLog, declared: !!s.declared, reason: s.declReason || null })), null, 2));
} else {
    let cur = null;
    for (const s of all) {
        if (s.rel !== cur) { cur = s.rel; console.log(`\n--- ${cur}`); }
        const mark = s.noLog ? "[崩溃上下文,跳过]"
                   : s.declared ? `[已声明静默: ${s.declReason}]`
                   : s.tag;
        console.log(`  ${String(s.line).padStart(4)}  ${mark}${s.comment ? "   // " + s.comment.slice(2).trim() : ""}`);
    }
    const nDecl = all.filter((s) => s.declared).length;
    const nNoLog = all.filter((s) => s.noLog).length;
    console.log(`\n合计 ${all.length} 处空 catch (崩溃上下文 ${nNoLog} / 已声明静默 ${nDecl} / **待处理 ${pending.length}**)`);
    if (pending.length) {
        console.log(`[catch-audit] FAIL ✗ 有 ${pending.length} 处未处理 —— 补 swallowed(...) 或用 ` +
                    `\`// catch-audit: intentional-silence <理由>\` 声明 (见文件头)`);
    } else {
        console.log("[catch-audit] PASS ✓ 没有未处理的空 catch");
    }
}

if (applyMode) {
    const n = apply(all);
    console.log(`[catch-audit] ✓ 已改写 ${n} 处 (注: 还需确认各文件已从 utils.js 导入 swallowed)`);
    upgradeWarn();
    process.exitCode = 0;                 // --apply 是"修"模式: 已就地补上, 不因修复前的问题报错
} else {
    // 退出码 (2026-10-07 补): 以前恒 0, 所以放进 check 链也永远绿。
    // 只有**未声明**的空 catch 才算失败; 崩溃上下文与已声明静默不阻塞。
    process.exitCode = pending.length ? 1 : 0;
}
