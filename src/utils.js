/**
 * 通用工具函数
 */

const Long = require('long');

// ============ 类型转换 ============
function toLong(val) {
    return Long.fromNumber(val);
}

function toNum(val) {
    if (Long.isLong(val)) return val.toNumber();
    return val || 0;
}

// ============ 时间相关 ============
function now() {
    return new Date().toLocaleTimeString();
}

/**
 * 将时间戳归一化为秒级
 * 大于 1e12 认为是毫秒级，转换为秒级
 */
function toTimeSec(val) {
    const n = toNum(val);
    if (n <= 0) return 0;
    if (n > 1e12) return Math.floor(n / 1000);
    return n;
}

// ============ 异步工具 ============
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ============ 每用户时间同步工厂 ============

function createTimeSync() {
    let serverTimeMs = 0;
    let localTimeAtSync = 0;
    return {
        getServerTimeSec() {
            if (!serverTimeMs) return Math.floor(Date.now() / 1000);
            const elapsed = Date.now() - localTimeAtSync;
            return Math.floor((serverTimeMs + elapsed) / 1000);
        },
        syncServerTime(ms) {
            serverTimeMs = ms;
            localTimeAtSync = Date.now();
        },
    };
}

// ============ 每用户日志工厂 ============

function createLogger(prefix) {
    let pfx = prefix;
    return {
        log(tag, msg) {
            const p = pfx ? `[${pfx}] ` : '';
            console.log(`[${now()}] ${p}[${tag}] ${msg}`);
        },
        logWarn(tag, msg) {
            const p = pfx ? `[${pfx}] ` : '';
            console.log(`[${now()}] ${p}[${tag}] ⚠ ${msg}`);
        },
        setPrefix(newPrefix) {
            pfx = newPrefix;
        },
    };
}

module.exports = {
    toLong, toNum, now,
    toTimeSec, sleep,
    createTimeSync, createLogger,
};
