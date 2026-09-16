// ==UserScript==
// @name         workbuddy 查看今日积分使用量
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Tampermonkey 菜单新增【查看今日积分使用量】按钮，点击后分页拉取今日全部请求记录，按固定结构解析并对每条 credit 求和，弹窗展示今日积分使用总量与明细
// @author       You
// @match        https://www.workbuddy.cn/profile/*
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const API_URL = 'https://www.workbuddy.cn/billing/meter/get-user-request-usage';
    const MODAL_ID = 'wbp-usage-modal';
    const BODY_ID = 'wbp-usage-body';

    // ========== 工具函数 ==========
    const pad = (n) => String(n).padStart(2, '0');

    function formatDate(d) {
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    // 今日 00:00:00 ~ 23:59:59
    function todayRange() {
        const now = new Date();
        const date = formatDate(now);
        return {
            date,
            start: `${date} 00:00:00`,
            end: `${date} 23:59:59`
        };
    }

    // 数字展示：最多 4 位小数，去掉多余的 0
    function formatNum(v) {
        const n = Number(v);
        if (isNaN(n)) return String(v);
        return String(parseFloat(n.toFixed(4)));
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ========== 响应解析（按已知固定结构，不做字段猜测） ==========
    // 接口返回固定为：
    // { code, msg, requestId, data: { total: 请求记录条数, data: [ { requestId, credit, model, client, requestTime, inputTrunc, input, agentPurpose } ] } }
    // 其中 data.total 是「请求记录条数」，不是积分值；真正的单次消耗在每条记录的 credit 字段。
    function parseUsagePayload(json) {
        const node = (json && typeof json === 'object') ? json.data : null;
        if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
        return {
            recordTotal: typeof node.total === 'number' ? node.total : null,
            records: Array.isArray(node.data) ? node.data : []
        };
    }

    // 对逐条 credit 求和 = 今日积分使用总量
    function sumCredit(records) {
        let sum = 0;
        for (const r of records) {
            if (!r || typeof r !== 'object' || !('credit' in r)) continue;
            const n = typeof r.credit === 'number' ? r.credit : parseFloat(r.credit);
            if (!isNaN(n)) sum += n;
        }
        return sum;
    }

    // ========== 请求接口 ==========
    async function requestPage(body) {
        let resp;
        try {
            resp = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'accept': 'application/json, text/plain, */*',
                    'content-type': 'application/json',
                    'cache-control': 'no-cache',
                    'pragma': 'no-cache',
                    'priority': 'u=1, i',
                    'x-client-platform': 'web'
                },
                referrer: `${location.origin}/profile/plans-usage`,
                body,
                mode: 'cors',
                credentials: 'include'
            });
        } catch (e) {
            throw new Error(`网络请求失败：${e && e.message ? e.message : e}`);
        }

        if (!resp.ok) {
            throw new Error(`接口请求失败：HTTP ${resp.status} ${resp.statusText}`);
        }

        let json;
        try {
            json = await resp.json();
        } catch (e) {
            throw new Error('接口返回内容不是有效的 JSON');
        }

        // 业务状态码校验（成功时 code=0，失败时携带 msg/message）
        if (typeof json === 'object' && json !== null && 'code' in json) {
            const code = String(json.code).toLowerCase();
            if (!['0', '200', 'success'].includes(code) && (json.msg || json.message)) {
                throw new Error(`接口返回错误：${json.msg || json.message}（code=${json.code}）`);
            }
        }

        return json;
    }

    // 分页拉取今日全部请求记录
    async function fetchUsage() {
        const { start, end } = todayRange();
        const PAGE_SIZE = 100;
        const MAX_PAGES = 30;

        let firstJson = null;
        let allRecords = [];
        let recordTotal = null;
        let pages = 0;

        for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
            const body = JSON.stringify({ startTime: start, endTime: end, pageNum, pageSize: PAGE_SIZE });
            const json = await requestPage(body);
            if (!firstJson) firstJson = json;

            const parsed = parseUsagePayload(json);
            const current = parsed ? parsed.records : [];
            if (parsed && recordTotal === null) recordTotal = parsed.recordTotal;

            allRecords = allRecords.concat(current);
            pages++;

            // 停止条件：本页为空 / 已取满记录条数 / 达到页数上限
            if (current.length === 0) break;
            if (recordTotal !== null && allRecords.length >= recordTotal) break;
        }

        return { json: firstJson, allRecords, recordTotal, pages };
    }

    // ========== 弹窗 UI ==========
    GM_addStyle(`
        #${MODAL_ID} {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(17, 24, 39, 0.6);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 2147483647;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
        }
        #${MODAL_ID} .wbp-box {
            background: #fff;
            border-radius: 14px;
            width: 520px;
            max-width: 92vw;
            max-height: 82vh;
            box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        #${MODAL_ID} .wbp-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 16px 20px;
            border-bottom: 1px solid #eef0f3;
        }
        #${MODAL_ID} .wbp-header h2 {
            margin: 0;
            font-size: 16px;
            color: #111827;
        }
        #${MODAL_ID} .wbp-close {
            background: none;
            border: none;
            font-size: 22px;
            color: #9ca3af;
            cursor: pointer;
            line-height: 1;
        }
        #${MODAL_ID} .wbp-close:hover { color: #374151; }
        #${MODAL_ID} .wbp-body {
            padding: 20px;
            overflow-y: auto;
            font-size: 14px;
            color: #1f2937;
        }
        #${MODAL_ID} .wbp-loading {
            text-align: center;
            color: #9ca3af;
            padding: 30px 0;
        }
        #${MODAL_ID} .wbp-error {
            background: #fef2f2;
            border: 1px solid #fecaca;
            color: #b91c1c;
            padding: 12px 14px;
            border-radius: 10px;
            line-height: 1.6;
        }
        #${MODAL_ID} .wbp-total {
            text-align: center;
            padding: 16px 0 18px;
            border-bottom: 1px dashed #e5e7eb;
            margin-bottom: 14px;
        }
        #${MODAL_ID} .wbp-total-label {
            font-size: 13px;
            color: #6b7280;
            margin-bottom: 8px;
        }
        #${MODAL_ID} .wbp-total-value {
            font-size: 40px;
            font-weight: 700;
            color: #2563eb;
            line-height: 1;
        }
        #${MODAL_ID} .wbp-total-source {
            margin-top: 8px;
            font-size: 12px;
            color: #9ca3af;
        }
        #${MODAL_ID} .wbp-section-title {
            font-size: 13px;
            font-weight: 600;
            color: #374151;
            margin: 12px 0 8px;
        }
        #${MODAL_ID} .wbp-stats {
            font-size: 12px;
            color: #6b7280;
            background: #f9fafb;
            border: 1px solid #eef0f3;
            border-radius: 8px;
            padding: 8px 12px;
            margin: 4px 0 10px;
            line-height: 1.6;
        }
        #${MODAL_ID} table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
        }
        #${MODAL_ID} th {
            text-align: left;
            background: #f3f4f6;
            color: #4b5563;
            font-weight: 600;
            padding: 7px 10px;
            border-bottom: 1px solid #e5e7eb;
        }
        #${MODAL_ID} td {
            padding: 7px 10px;
            border-bottom: 1px solid #f3f4f6;
            color: #1f2937;
            word-break: break-all;
        }
        #${MODAL_ID} tr:last-child td { border-bottom: none; }
        #${MODAL_ID} .wbp-raw-toggle {
            margin-top: 14px;
            background: #f9fafb;
            border: 1px solid #e5e7eb;
            color: #4b5563;
            font-size: 13px;
            padding: 6px 12px;
            border-radius: 8px;
            cursor: pointer;
        }
        #${MODAL_ID} .wbp-raw-toggle:hover { background: #f3f4f6; }
        #${MODAL_ID} pre {
            display: none;
            margin-top: 10px;
            background: #111827;
            color: #e5e7eb;
            font-size: 12px;
            line-height: 1.5;
            padding: 12px;
            border-radius: 8px;
            overflow: auto;
            max-height: 260px;
            white-space: pre-wrap;
            word-break: break-all;
        }
        #${MODAL_ID} pre.open { display: block; }
    `);

    function buildHtml({ json, date, allRecords, recordTotal, pages }) {
        // 固定结构：data.data 为今日请求明细，逐条 credit 求和 = 积分使用总量
        const totalValue = sumCredit(allRecords);
        let totalSource = `按 ${allRecords.length} 条记录的 credit 字段求和`;
        if (pages > 1) totalSource += `，共 ${pages} 页`;

        let html = `
            <div class="wbp-total">
                <div class="wbp-total-label">今日（${date}）积分使用总量</div>
                <div class="wbp-total-value">${formatNum(totalValue)}</div>
                <div class="wbp-total-source">${totalSource}</div>
            </div>`;

        if (recordTotal !== null) {
            if (allRecords.length < recordTotal) {
                html += `<div class="wbp-error">⚠️ 分页未取满：接口返回 ${recordTotal} 条记录，实际只拉到 ${allRecords.length} 条，下方总量可能不完整。请调大 MAX_PAGES 后重试。</div>`;
            } else {
                html += `<div class="wbp-stats">📌 接口 data.total 为「请求记录条数」：今日共 ${recordTotal} 条请求记录，已全量拉取。</div>`;
            }
        }

        const CAP = 300;
        const shown = allRecords.slice(0, CAP);
        html += `<div class="wbp-section-title">📋 请求记录明细（共 ${allRecords.length} 条${allRecords.length > CAP ? `，仅显示前 ${CAP} 条` : ''}）</div>`;
        html += '<table><thead><tr><th>时间</th><th>模型</th><th>积分</th></tr></thead><tbody>' +
            shown.map(r => {
                const t = (r.requestTime !== undefined && r.requestTime !== null) ? r.requestTime : '—';
                const m = (r.model !== undefined && r.model !== null) ? r.model : '—';
                const c = (r.credit !== undefined && r.credit !== null) ? formatNum(r.credit) : '—';
                return `<tr><td>${escapeHtml(String(t))}</td><td>${escapeHtml(String(m))}</td><td>${c}</td></tr>`;
            }).join('') +
            '</tbody></table>';

        html += `<button class="wbp-raw-toggle">⬇ 查看原始返回（第 1 页）</button><pre>${escapeHtml(JSON.stringify(json, null, 2))}</pre>`;
        return html;
    }

    function bindRawToggle(root) {
        const btn = root.querySelector('.wbp-raw-toggle');
        if (!btn) return;
        btn.addEventListener('click', () => {
            const pre = root.querySelector('pre');
            const open = pre.classList.toggle('open');
            btn.textContent = open ? '⬆ 收起原始返回' : '⬇ 查看原始返回（第 1 页）';
        });
    }

    function buildErrorHtml(msg) {
        let tip = '';
        if (/401|403|未登录|登录/.test(msg)) {
            tip = '<div style="color:#b45309;margin-top:8px;">提示：可能未登录或登录已过期，请先登录 workbuddy 后重试。</div>';
        }
        return `<div class="wbp-error">❌ ${escapeHtml(msg)}</div>${tip}`;
    }

    async function doQuery(bodyEl) {
        const { date } = todayRange();
        try {
            const { json, allRecords, recordTotal, pages } = await fetchUsage();
            if (!parseUsagePayload(json)) {
                throw new Error('接口返回结构与预期不一致（缺少 data.data 请求明细数组），请把接口返回贴给开发者核对。');
            }
            bodyEl.innerHTML = buildHtml({ json, date, allRecords, recordTotal, pages });
            bindRawToggle(bodyEl);
        } catch (e) {
            console.error('[查看今日积分使用量]', e);
            bodyEl.innerHTML = buildErrorHtml(e.message || String(e));
        }
    }

    function openModal() {
        const existing = document.getElementById(MODAL_ID);
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = MODAL_ID;
        modal.innerHTML = `
            <div class="wbp-box">
                <div class="wbp-header">
                    <h2>📅 今日积分使用量</h2>
                    <button class="wbp-close" title="关闭">✕</button>
                </div>
                <div class="wbp-body" id="${BODY_ID}">
                    <div class="wbp-loading">⏳ 正在查询今日积分使用量…</div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelector('.wbp-close').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        doQuery(document.getElementById(BODY_ID));
    }

    // ========== 注册 Tampermonkey 菜单按钮 ==========
    GM_registerMenuCommand('🔍 查看今日积分使用量', openModal);
})();