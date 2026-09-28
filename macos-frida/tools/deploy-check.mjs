#!/usr/bin/env node
// ============ 产线一致性检查: repo 里的 dist 产物 vs 游戏目录里的 dist ============
// 用途 (2026-09-25 教训): 排查时容易"测的不是刚构建的那个包" —— 先核对 md5 再下结论。
// 用法: node tools/deploy-check.mjs           (自动找游戏目录)
//       GAME_DIR=/path/to/manosaba_game node tools/deploy-check.mjs
//       node tools/deploy-check.mjs /path/to/manosaba_game
// 退出码: 0 = 一致; 1 = 不一致或找不到; 2 = 用法/路径问题
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_BUNDLE = join(REPO, "dist", "manosabamod.js");

function findGameDir() {
    const arg = process.argv[2] || process.env.GAME_DIR;
    if (arg) return existsSync(arg) ? arg : null;
    // 先找真正在跑的生产目录 (Steam), 再退回仓库附近的测试目录 manosaba_game_mac/
    const steam = join(homedir(), "Library", "Application Support", "Steam", "steamapps", "common", "manosaba_game");
    if (existsSync(join(steam, "manosaba.app"))) return steam;
    let d = REPO;
    while (d !== "/") {
        const c = join(d, "manosaba_game_mac");
        if (existsSync(join(c, "manosaba.app"))) return c;
        d = dirname(d);
    }
    return null;
}

function md5(p) {
    return createHash("md5").update(readFileSync(p)).digest("hex");
}

if (!existsSync(REPO_BUNDLE)) {
    console.error(`[deploy-check] repo 产物不存在: ${REPO_BUNDLE}\n  先跑 npm run build`);
    process.exit(2);
}
const gameDir = findGameDir();
if (!gameDir) {
    console.error("[deploy-check] 找不到游戏目录; 用 GAME_DIR=<dir> 或第一个参数指定");
    process.exit(2);
}
const prod = join(gameDir, "dist", "manosabamod.js");
if (!existsSync(prod)) {
    console.error(`[deploy-check] 游戏目录里没有 dist/manosabamod.js: ${prod}`);
    process.exit(2);
}
const a = md5(REPO_BUNDLE), b = md5(prod);
const size = (p) => statSync(p).size;
console.log(`[deploy-check] repo  : ${a}  ${size(REPO_BUNDLE)} B  ${REPO_BUNDLE}`);
console.log(`[deploy-check] 产线  : ${b}  ${size(prod)} B  ${prod}`);
if (a === b) {
    console.log("[deploy-check] ✓ 一致 (你测的就是刚构建的那个包)");
    process.exit(0);
}
console.log("[deploy-check] ✗ 不一致 —— 先确认要测哪个包, 再把该产物 cp 到游戏目录 (不要凭印象下结论)");
process.exit(1);
