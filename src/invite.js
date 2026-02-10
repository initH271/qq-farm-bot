/**
 * 邀请码处理模块（工厂模式）
 * 读取 share.txt 并通过 ReportArkClick 申请好友
 * 注意：此功能仅在微信环境下有效（CONFIG.platform === 'wx'）
 */

const fs = require('fs');
const path = require('path');
const { types } = require('./proto');
const { toLong, sleep } = require('./utils');
const { CONFIG } = require('./config');

const INVITE_REQUEST_DELAY = 2000;

/**
 * 创建邀请处理实例
 * @param {Object} deps
 * @param {Object} deps.network - { sendMsgAsync }
 * @param {Object} deps.logger  - { log, logWarn }
 */
function createInvite(deps) {
    const { network, logger } = deps;
    const { sendMsgAsync } = network;
    const { log, logWarn } = logger;

    function parseShareLink(link) {
        const result = { uid: null, openid: null, shareSource: null, docId: null };
        const queryStr = link.startsWith('?') ? link.slice(1) : link;
        const params = new URLSearchParams(queryStr);
        result.uid = params.get('uid');
        result.openid = params.get('openid');
        result.shareSource = params.get('share_source');
        result.docId = params.get('doc_id');
        return result;
    }

    function readShareFile() {
        const shareFilePath = path.join(__dirname, '..', 'share.txt');

        if (!fs.existsSync(shareFilePath)) {
            return [];
        }

        try {
            const content = fs.readFileSync(shareFilePath, 'utf8');
            const lines = content.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0 && line.includes('openid='));

            const invites = [];
            const seenUids = new Set();

            for (const line of lines) {
                const parsed = parseShareLink(line);
                if (parsed.openid && parsed.uid) {
                    if (!seenUids.has(parsed.uid)) {
                        seenUids.add(parsed.uid);
                        invites.push(parsed);
                    }
                }
            }

            return invites;
        } catch (e) {
            logWarn('邀请', `读取 share.txt 失败: ${e.message}`);
            return [];
        }
    }

    async function sendReportArkClick(sharerId, sharerOpenId, shareSource) {
        const body = types.ReportArkClickRequest.encode(types.ReportArkClickRequest.create({
            sharer_id: toLong(sharerId),
            sharer_open_id: sharerOpenId,
            share_cfg_id: toLong(shareSource || 0),
            scene_id: '1256',
        })).finish();

        const { body: replyBody } = await sendMsgAsync('gamepb.userpb.UserService', 'ReportArkClick', body);
        return types.ReportArkClickReply.decode(replyBody);
    }

    async function processInviteCodes() {
        if (CONFIG.platform !== 'wx') {
            log('邀请', '当前为 QQ 环境，跳过邀请码处理（仅微信支持）');
            return;
        }

        const invites = readShareFile();
        if (invites.length === 0) {
            return;
        }

        log('邀请', `读取到 ${invites.length} 个邀请码（已去重），开始逐个处理...`);

        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < invites.length; i++) {
            const invite = invites[i];

            try {
                await sendReportArkClick(invite.uid, invite.openid, invite.shareSource);
                successCount++;
                log('邀请', `[${i + 1}/${invites.length}] 已向 uid=${invite.uid} 发送好友申请`);
            } catch (e) {
                failCount++;
                logWarn('邀请', `[${i + 1}/${invites.length}] 向 uid=${invite.uid} 发送申请失败: ${e.message}`);
            }

            if (i < invites.length - 1) {
                await sleep(INVITE_REQUEST_DELAY);
            }
        }

        log('邀请', `处理完成: 成功 ${successCount}, 失败 ${failCount}`);
        clearShareFile();
    }

    function clearShareFile() {
        const shareFilePath = path.join(__dirname, '..', 'share.txt');
        try {
            fs.writeFileSync(shareFilePath, '', 'utf8');
            log('邀请', '已清空 share.txt');
        } catch (e) {
            // 静默失败
        }
    }

    return {
        parseShareLink,
        readShareFile,
        sendReportArkClick,
        processInviteCodes,
        clearShareFile,
    };
}

module.exports = { createInvite };
