/**
 * QQ经典农场 挂机脚本 - 入口文件 (多用户版)
 *
 * 模块结构:
 *   src/config.js   - 配置常量与枚举
 *   src/utils.js    - 通用工具函数与工厂
 *   src/proto.js    - Protobuf 加载与类型管理
 *   src/network.js  - WebSocket 连接/消息编解码/登录/心跳
 *   src/farm.js     - 自己农场操作与巡田循环
 *   src/friend.js   - 好友农场操作与巡查循环
 *   src/session.js  - 用户会话编排器
 *   src/decode.js   - PB解码/验证工具模式
 */

const { CONFIG } = require('./src/config');
const { loadProto } = require('./src/proto');
const { createSession } = require('./src/session');
const { verifyMode, decodeMode } = require('./src/decode');
const { sleep } = require('./src/utils');

// ============ 帮助信息 ============
function showHelp() {
    console.log(`
QQ经典农场 挂机脚本 (多用户版)
================================

用法:
  bun client.js --code <登录code>
  bun client.js --codes <code1,code2,code3>
  bun client.js --verify
  bun client.js --decode <数据> [--hex] [--gate] [--type <消息类型>]

参数:
  --code              单用户模式: 一个登录code
  --codes             多用户模式: 逗号分隔的多个code
  --interval          自己农场巡查间隔秒数, 默认30秒, 最低10秒
  --friend-interval   好友农场巡查间隔秒数, 默认60秒(1分钟), 最低60秒
  --verify            验证proto定义
  --decode            解码PB数据 (运行 --decode 无参数查看详细帮助)

环境变量 (.env):
  FARM_CODE           单用户模式 (向后兼容)
  FARM_CODES          多用户模式 (逗号分隔)
  FARM_INTERVAL       自己农场巡查间隔秒数
  FRIEND_INTERVAL     好友农场巡查间隔秒数

功能:
  - 自动收获成熟作物 → 购买种子 → 种植
  - 自动除草、除虫、浇水
  - 自动铲除枯死作物
  - 自动巡查好友农场: 帮忙浇水/除草/除虫 + 偷菜
  - 心跳保活
  - 多用户并行挂机
`);
}

// ============ 参数解析 ============
function parseArgs(args) {
    let codes = [];

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--code' && args[i + 1]) {
            codes.push(args[++i]);
        }
        if (args[i] === '--codes' && args[i + 1]) {
            codes.push(...args[++i].split(',').map(s => s.trim()).filter(Boolean));
        }
        if (args[i] === '--interval' && args[i + 1]) {
            const sec = parseInt(args[++i]);
            CONFIG.farmCheckInterval = Math.max(sec, 10) * 1000;
        }
        if (args[i] === '--friend-interval' && args[i + 1]) {
            const sec = parseInt(args[++i]);
            CONFIG.friendCheckInterval = Math.max(sec, 60) * 1000;
        }
    }

    // 环境变量回退
    if (codes.length === 0 && process.env.FARM_CODES) {
        codes = process.env.FARM_CODES.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (codes.length === 0 && process.env.FARM_CODE) {
        codes.push(process.env.FARM_CODE);
    }

    // interval 也支持环境变量
    if (process.env.FARM_INTERVAL && CONFIG.farmCheckInterval === 30000) {
        const sec = parseInt(process.env.FARM_INTERVAL);
        if (!isNaN(sec)) CONFIG.farmCheckInterval = Math.max(sec, 10) * 1000;
    }
    if (process.env.FRIEND_INTERVAL && CONFIG.friendCheckInterval === 60000) {
        const sec = parseInt(process.env.FRIEND_INTERVAL);
        if (!isNaN(sec)) CONFIG.friendCheckInterval = Math.max(sec, 60) * 1000;
    }

    return [...new Set(codes)];
}

// ============ 主函数 ============
async function main() {
    const args = process.argv.slice(2);

    // 加载 proto 定义
    await loadProto();

    // 验证模式
    if (args.includes('--verify')) {
        await verifyMode();
        return;
    }

    // 解码模式
    if (args.includes('--decode')) {
        await decodeMode(args);
        return;
    }

    // 正常挂机模式
    const codes = parseArgs(args);
    if (codes.length === 0) {
        showHelp();
        process.exit(1);
    }

    console.log(`\n[启动] 共 ${codes.length} 个用户`);
    console.log(`[配置] 农场检查间隔: ${CONFIG.farmCheckInterval / 1000}秒`);
    console.log(`[配置] 好友检查间隔: ${CONFIG.friendCheckInterval / 1000}秒\n`);

    // 为每个 code 创建独立 session
    const sessions = codes.map((code, idx) => {
        const label = codes.length === 1 ? '' : `U${idx + 1}`;
        return createSession(code, label);
    });

    // 逐个启动，间隔 2 秒错开连接
    for (let i = 0; i < sessions.length; i++) {
        sessions[i].start();
        if (i < sessions.length - 1) {
            await sleep(2000);
        }
    }

    // 退出处理
    process.on('SIGINT', () => {
        console.log('\n[退出] 正在关闭所有会话...');
        for (const session of sessions) {
            session.stop();
        }
        process.exit(0);
    });
}

main().catch(err => {
    console.error('启动失败:', err);
    process.exit(1);
});
