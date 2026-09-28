#!/usr/bin/env node
// ============ swallowed 节流/留痕逻辑的单元测试 (纯 node, 不需要游戏) ============
// 为什么能这样测: src/log.js 顶层没有任何 Frida 调用 (_fd 在 initLog 前是 -1),
// 所以可以在 node 里直接 import 它, 把 console.log 截下来断言输出。
// 用法: node test-tools/swallow-test.mjs    (退出码 0=通过, 1=不通过)
globalThis.MOD_DEBUG = true;

const { swallowed, swallowedWarn, swallowedStats } = await import("../src/log.js");

const out = [];
const orig = console.log;
const grab = (fn) => { console.log = (s) => out.push(String(s)); try { fn(); } finally { console.log = orig; } };

grab(() => {
    for (let i = 0; i < 5; i++) swallowed("a.js:fn", new Error("boom" + i));   // tag 相同 → 节流
    swallowedWarn("b.js:crit", new Error("crit"));
    swallowedWarn("b.js:crit", new Error("crit"));
});

const dbg = out.filter((l) => l.includes("[DEBUG]"));
const warn = out.filter((l) => l.includes("[WARN]"));
const stats = swallowedStats();

const checks = [
    ["前 3 条 DEBUG 各打一行", dbg.length === 4, `实际 ${dbg.length} 行 (期望 4 = 前3条 + 1条"后续静默")`],
    ["第 4 条是静默提示", dbg.length === 4 && dbg[3].includes("后续静默"), dbg[3] || "(无)"],
    ["WARN 级不受 DEBUG 开关影响, 各打一行", warn.length === 2, `实际 ${warn.length} 行`],
    ["WARN 文案带 tag", warn[0] && warn[0].includes("catch: b.js:crit"), warn[0] || "(无)"],
    ["stats 计数是真实次数 (不是打印次数)", stats.includes("a.js:fn=5") && stats.includes("b.js:crit=2"), stats.join(" ")],
];

let ok = true;
for (const [name, pass, detail] of checks) {
    console.log((pass ? "  ✓ " : "  ✗ ") + name + (pass ? "" : "  → " + detail));
    if (!pass) ok = false;
}
console.log(`[swallow-test] ${ok ? "PASS ✓" : "FAIL ✗"}`);
process.exit(ok ? 0 : 1);
