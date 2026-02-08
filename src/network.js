/**
 * WebSocket 网络层 - 连接/消息编解码/登录/心跳
 */

const WebSocket = require('ws');
const { CONFIG } = require('./config');
const { types } = require('./proto');
const { toLong, toNum, syncServerTime, log, logWarn } = require('./utils');

// ============ 内部状态 ============
let ws = null;
let clientSeq = 1;
let serverSeq = 0;
let heartbeatTimer = null;
let pendingCallbacks = new Map();

// ============ 用户状态 (登录后设置) ============
const userState = {
    gid: 0,
    name: '',
    level: 0,
    gold: 0,
};

function getUserState() { return userState; }

// ============ 消息编解码 ============
function encodeMsg(serviceName, methodName, bodyBytes) {
    const msg = types.GateMessage.create({
        meta: {
            service_name: serviceName,
            method_name: methodName,
            message_type: 1,
            client_seq: toLong(clientSeq),
            server_seq: toLong(serverSeq),
        },
        body: bodyBytes || Buffer.alloc(0),
    });
    const encoded = types.GateMessage.encode(msg).finish();
    clientSeq++;
    return encoded;
}

function sendMsg(serviceName, methodName, bodyBytes, callback) {
    if (!ws || ws.readyState !== 1) {
        log('WS', '连接未打开');
        return false;
    }
    const seq = clientSeq;
    const encoded = encodeMsg(serviceName, methodName, bodyBytes);
    if (callback) pendingCallbacks.set(seq, callback);
    ws.send(encoded);
    return true;
}

/** Promise 版发送 */
function sendMsgAsync(serviceName, methodName, bodyBytes, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const seq = clientSeq;
        const timer = setTimeout(() => {
            pendingCallbacks.delete(seq);
            reject(new Error(`请求超时: ${methodName}`));
        }, timeout);

        sendMsg(serviceName, methodName, bodyBytes, (err, body, meta) => {
            clearTimeout(timer);
            if (err) reject(err);
            else resolve({ body, meta });
        });
    });
}

// ============ 消息处理 ============
function handleMessage(data) {
    try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const msg = types.GateMessage.decode(buf);
        const meta = msg.meta;
        if (!meta) return;

        if (meta.server_seq) {
            const seq = toNum(meta.server_seq);
            if (seq > serverSeq) serverSeq = seq;
        }

        const msgType = meta.message_type;

        // Notify
        if (msgType === 3) {
            handleNotify(msg);
            return;
        }

        // Response
        if (msgType === 2) {
            const errorCode = toNum(meta.error_code);
            const clientSeqVal = toNum(meta.client_seq);

            const cb = pendingCallbacks.get(clientSeqVal);
            if (cb) {
                pendingCallbacks.delete(clientSeqVal);
                if (errorCode !== 0) {
                    cb(new Error(`${meta.service_name}.${meta.method_name} 错误: code=${errorCode} ${meta.error_message || ''}`));
                } else {
                    cb(null, msg.body, meta);
                }
                return;
            }

            if (errorCode !== 0) {
                logWarn('错误', `${meta.service_name}.${meta.method_name} code=${errorCode} ${meta.error_message || ''}`);
            }
        }
    } catch (err) {
        logWarn('解码', err.message);
    }
}

function handleNotify(msg) {
    if (!msg.body || msg.body.length === 0) return;
    try {
        const event = types.EventMessage.decode(msg.body);
        const type = event.message_type || '';
        if (type.includes('Kickout')) {
            log('推送', `被踢下线! ${type}`);
        }
    } catch (e) { }
}

// ============ 登录 ============
function sendLogin(onLoginSuccess) {
    const body = types.LoginRequest.encode(types.LoginRequest.create({
        sharer_id: toLong(0),
        sharer_open_id: '',
        device_info: {
            client_version: CONFIG.clientVersion,
            sys_software: 'iOS 26.2.1',
            network: 'wifi',
            memory: '7672',
            device_id: 'iPhone X<iPhone18,3>',
        },
        share_cfg_id: toLong(0),
        scene_id: '1256',
        report_data: {
            callback: '', cd_extend_info: '', click_id: '', clue_token: '',
            minigame_channel: 'other', minigame_platid: 2, req_id: '', trackid: '',
        },
    })).finish();

    sendMsg('gamepb.userpb.UserService', 'Login', body, (err, bodyBytes, meta) => {
        if (err) {
            log('登录', `失败: ${err.message}`);
            return;
        }
        try {
            const reply = types.LoginReply.decode(bodyBytes);
            if (reply.basic) {
                userState.gid = toNum(reply.basic.gid);
                userState.name = reply.basic.name || '未知';
                userState.level = toNum(reply.basic.level);
                userState.gold = toNum(reply.basic.gold);

                console.log('');
                console.log('========== 登录成功 ==========');
                console.log(`  GID:    ${userState.gid}`);
                console.log(`  昵称:   ${userState.name}`);
                console.log(`  等级:   ${userState.level}`);
                console.log(`  金币:   ${userState.gold}`);
                if (reply.time_now_millis) {
                    syncServerTime(toNum(reply.time_now_millis));
                    console.log(`  时间:   ${new Date(toNum(reply.time_now_millis)).toLocaleString()}`);
                }
                console.log('===============================');
                console.log('');
            }

            startHeartbeat();
            if (onLoginSuccess) onLoginSuccess();
        } catch (e) {
            log('登录', `解码失败: ${e.message}`);
        }
    });
}

// ============ 心跳 ============
function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
        if (!userState.gid) return;
        const body = types.HeartbeatRequest.encode(types.HeartbeatRequest.create({
            gid: toLong(userState.gid),
            client_version: CONFIG.clientVersion,
        })).finish();
        sendMsg('gamepb.userpb.UserService', 'Heartbeat', body, (err, replyBody) => {
            if (err || !replyBody) return;
            try {
                const reply = types.HeartbeatReply.decode(replyBody);
                if (reply.server_time) syncServerTime(toNum(reply.server_time));
            } catch (e) { }
        });
    }, CONFIG.heartbeatInterval);
    log('心跳', `已启动 (${CONFIG.heartbeatInterval / 1000}s)`);
}

// ============ WebSocket 连接 ============
function connect(code, onLoginSuccess) {
    const url = `${CONFIG.serverUrl}?platform=${CONFIG.platform}&os=${CONFIG.os}&ver=${CONFIG.clientVersion}&code=${code}&openID=`;
    log('WS', `正在连接...`);

    ws = new WebSocket(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
            'Origin': 'https://gate-obt.nqf.qq.com',
        },
    });

    ws.binaryType = 'arraybuffer';

    ws.on('open', () => {
        log('WS', '连接成功');
        sendLogin(onLoginSuccess);
    });

    ws.on('message', (data) => {
        let buf;
        if (Buffer.isBuffer(data)) {
            buf = data;
        } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
            buf = Buffer.from(data);
        } else {
            buf = Buffer.from(data);
        }
        handleMessage(buf);
    });

    ws.on('close', (code, reason) => {
        log('WS', `连接关闭 (code=${code})`);
        cleanup();
    });

    ws.on('error', (err) => {
        logWarn('WS', `错误: ${err.message}`);
    });
}

function cleanup() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    pendingCallbacks.clear();
}

function getWs() { return ws; }

module.exports = {
    connect, cleanup, getWs,
    sendMsg, sendMsgAsync,
    getUserState,
};
