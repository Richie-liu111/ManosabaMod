// ============ Movie 支持 (URL 流式, 镜像 Windows ModMovieLoader) ============
// run_mod.sh 注入 movieMap = { 视频名: 绝对路径 }
// 原理: @movie 命令是 IPreloadable, 剧本加载时 ScriptPlaylist.LoadResources
//   → PlayMovie.PreloadResources → MoviePlayer.HoldResources(name) → get_UrlStreaming。
//   get_UrlStreaming 默认 false → 走 videoLoader 加载 VideoClip → 无 provider 即失败,
//   导致整个 goto 中止 (黑屏)。修法: 对 mod 视频强制 UrlStreaming=true (跳过 VideoClip),
//   BuildStreamUrl 返回本地绝对路径, VideoPlayer 直接播放文件。
import { A, dbg, findClassAcrossImages, makeS, readStr } from "./utils.js";

var modMovies = (typeof movieMap !== "undefined" && movieMap) ? movieMap : {};
var pendingMovieName = null;
var playingMovieName = null;
var movieHooksReady = false;
export function isModMovie(nm) { return !!nm && !!modMovies[nm]; }
export function setupMovieHooks() {
    try {
        if (movieHooksReady) return;
        if (Object.keys(modMovies).length === 0) { dbg("[v3] setupMovieHooks: 无 mod 视频, 跳过"); return; }
        var mpCls = findClassAcrossImages("Naninovel", "MoviePlayer");
        if (!mpCls || mpCls.isNull()) { dbg("[v3] setupMovieHooks: MoviePlayer 类未找到"); return; }
        var urlMi = A.cgm(mpCls, Memory.allocUtf8String("get_UrlStreaming"), 0);
        var buildMi = A.cgm(mpCls, Memory.allocUtf8String("BuildStreamUrl"), 1);
        var holdMi = A.cgm(mpCls, Memory.allocUtf8String("HoldResources"), 2);
        if (!urlMi || urlMi.isNull() || !buildMi || buildMi.isNull() || !holdMi || holdMi.isNull()) {
            dbg("[v3] setupMovieHooks: 方法未找到 (get_UrlStreaming/BuildStreamUrl/HoldResources)"); return;
        }
        var pnField = A.gf(mpCls, Memory.allocUtf8String("playedMovieName"));
        var pnOff = (pnField && !pnField.isNull()) ? A.fo(pnField) : 0x68;

        // 播放阶段: Play(name) 入口捕获名字 (get_UrlStreaming 在 Play 内被调用)
        var playMi = A.cgm(mpCls, Memory.allocUtf8String("Play"), 2);
        if (playMi && !playMi.isNull()) {
            Interceptor.attach(playMi.readPointer(), {
                onEnter: function (a) {
                    try {
                        playingMovieName = null;
                        var nm = readStr(a[1]);
                        dbg("[v3] Movie Play: '" + nm + "' mod=" + isModMovie(nm));
                        if (isModMovie(nm)) playingMovieName = nm;
                    } catch (e) {}
                }
            });
        }
        // 预加载阶段: HoldResources(name) 入口捕获名字 → get_UrlStreaming 消费
        Interceptor.attach(holdMi.readPointer(), {
            onEnter: function (a) {
                try {
                    pendingMovieName = null;
                    var nm = readStr(a[1]);
                    if (isModMovie(nm)) pendingMovieName = nm;
                } catch (e) {}
            }
        });
        // 流式判定: mod 视频强制 true (跳过 VideoClip 加载, 预加载不再失败)
        Interceptor.attach(urlMi.readPointer(), {
            onEnter: function () { this._self = this.context.x0; },
            onLeave: function (ret) {
                try {
                    if (ret && !ret.isNull() && ret.toInt32() === 1) return;
                    if (pendingMovieName) { // 预加载阶段
                        var p = modMovies[pendingMovieName];
                        pendingMovieName = null;
                        if (p) { ret.replace(ptr(1)); dbg("[v3] Movie preload override: 流式跳过 VideoClip '" + p + "'"); }
                        return;
                    }
                    if (playingMovieName && isModMovie(playingMovieName)) { // 播放阶段 (Play 入口已捕获)
                        ret.replace(ptr(1)); return;
                    }
                    // 兜底: 读 playedMovieName 字段
                    var cur = readStr(this._self.add(pnOff));
                    if (isModMovie(cur)) ret.replace(ptr(1));
                } catch (e) {}
            }
        });
        // BuildStreamUrl: mod 视频 → 本地绝对路径 (VideoPlayer 认绝对路径)
        Interceptor.attach(buildMi.readPointer(), {
            onEnter: function (a) { this._nm = readStr(a[1]); },
            onLeave: function (ret) {
                try {
                    var p = modMovies[this._nm];
                    if (p) { ret.replace(makeS(p)); dbg("[v3] Movie URL -> " + p); }
                } catch (e) {}
            }
        });
        movieHooksReady = true;
        dbg("[v3] Movie hooks 就绪, mod 视频数=" + Object.keys(modMovies).length);
    } catch (e) { dbg("[v3] setupMovieHooks err: " + e); }
}
