// ==UserScript==
// @name         workbuddy 查看今日积分使用量
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Tampermonkey 菜单新增【查看今日积分使用量】按钮，支持 workbuddy.cn（按 credit 求和）与 www.trae.cn/dashboard（按 credits_float 求和），弹窗展示今日积分使用总量、近24小时/近7天用量柱状图与明细（明细默认折叠）
// @author       You
// @match        https://www.workbuddy.cn/profile/*
// @match        https://www.trae.cn/dashboard
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // ===== 站点识别 =====
    const HOST = location.hostname;
    const SITE = HOST.includes('workbuddy') ? 'workbuddy' : (HOST.includes('trae') ? 'trae' : null);

    // 若 trae 站点自动获取不到 JWT，可在此手动粘贴当前浏览器中的裸 JWT（eyJ...，脚本会自动补上 "Cloud-IDE-JWT " 前缀）
    const MANUAL_TRAE_JWT = null;

    const MODAL_ID = 'wbp-usage-modal';
    const BODY_ID = 'wbp-usage-body';

    // ========== 工具函数 ==========
    const pad = (n) => String(n).padStart(2, '0');

    function formatDate(d) {
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    // 数字展示：最多 4 位小数，去掉多余的 0
    function formatNum(v) {
        const n = Number(v);
        if (isNaN(n)) return String(v);
        return String(parseFloat(n.toFixed(4)));
    }

    function toNumber(v) {
        const n = Number(v);
        return isNaN(n) ? 0 : n;
    }

    // 对 rows 中指定字段求和
    function sumField(rows, key) {
        return rows.reduce((acc, r) => acc + toNumber(r[key]), 0);
    }

    // 解析 "YYYY-MM-DD HH:mm:ss"（本地时区）为毫秒时间戳
    function parseDateTimeStr(s) {
        if (!s) return 0;
        const t = new Date(String(s).replace(' ', 'T')).getTime();
        return isNaN(t) ? 0 : t;
    }

    // 毫秒时间戳 → "YYYY-MM-DD HH:mm:ss"
    function fmtDateTime(ms) {
        const d = new Date(ms);
        return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ========== 通用请求 ==========
    function checkBizCode(json) {
        if (typeof json === 'object' && json !== null && 'code' in json) {
            const code = String(json.code).toLowerCase();
            if (!['0', '200', 'success'].includes(code) && (json.msg || json.message)) {
                throw new Error(`接口返回错误：${json.msg || json.message}（code=${json.code}）`);
            }
        }
    }

    // XHR 请求（页面同源上下文，携带 Cookie 与自定义请求头）
    function postJson(url, payload, extraHeaders) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', url, true);
            xhr.timeout = 30000;
            xhr.withCredentials = true;

            const headers = Object.assign({
                'Accept': 'application/json, text/plain, */*',
                'Content-Type': 'application/json',
            }, extraHeaders);
            for (const k of Object.keys(headers)) {
                xhr.setRequestHeader(k, headers[k]);
            }

            xhr.onreadystatechange = () => {
                if (xhr.readyState !== 4) return;
                if (xhr.status < 200 || xhr.status >= 300) {
                    reject(new Error(`接口请求失败：HTTP ${xhr.status} ${xhr.statusText || ''}`));
                    return;
                }
                let json;
                try {
                    json = JSON.parse(xhr.responseText);
                } catch (e) {
                    reject(new Error('接口返回内容不是有效的 JSON'));
                    return;
                }
                checkBizCode(json);
                resolve(json);
            };
            xhr.onerror = () => reject(new Error('网络请求失败'));
            xhr.ontimeout = () => reject(new Error('接口请求超时（30s）'));

            try {
                xhr.send(JSON.stringify(payload));
            } catch (e) {
                reject(new Error(`网络请求失败：${e && e.message ? e.message : e}`));
            }
        });
    }

    // ========== workbuddy 适配 ==========
    // 接口固定返回：{ code, msg, requestId, data: { total: 请求记录条数, data: [ { requestId, credit, model, ... } ] } }
    // data.total 是「请求记录条数」，不是积分值；真正的单次消耗在每条记录的 credit 字段。
    // 拉取时间范围 [startStr, endStr]（"YYYY-MM-DD HH:mm:ss"）内的全部记录
    async function fetchWorkbuddy(startStr, endStr) {
        const PAGE_SIZE = 100;
        const MAX_PAGES = 30;
        const API = 'https://www.workbuddy.cn/billing/meter/get-user-request-usage';

        let firstJson = null;
        let allRecords = [];
        let recordTotal = null;
        let pages = 0;

        for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
            const json = await postJson(API,
                { startTime: startStr, endTime: endStr, pageNum, pageSize: PAGE_SIZE },
                { 'x-client-platform': 'web' });
            if (!firstJson) firstJson = json;

            const node = (json && typeof json === 'object') ? json.data : null;
            if (!node || typeof node !== 'object' || Array.isArray(node)) {
                throw new Error('接口返回结构与预期不一致（缺少 data 对象），请把接口返回贴给开发者核对。');
            }
            const current = Array.isArray(node.data) ? node.data : [];
            if (recordTotal === null && typeof node.total === 'number') recordTotal = node.total;

            allRecords = allRecords.concat(current);
            pages++;

            if (current.length === 0) break;
            if (recordTotal !== null && allRecords.length >= recordTotal) break;
        }
        if (!firstJson) throw new Error('接口未返回数据');

        return {
            site: 'workbuddy',
            json: firstJson,
            rows: allRecords.map(r => ({
                ts: parseDateTimeStr(r.requestTime),
                time: r.requestTime,
                model: r.model,
                credit: r.credit
            })),
            recordTotal,
            pages
        };
    }

    // ========== trae 适配 ==========
    // 接口固定返回：{ total: 会话条数, user_usage_group_by_sessions: [ { credits_float, cost_money_float, model_name, usage_time, ... } ] }
    // total 是「会话条数」，不是积分值；真正的消耗在每条会话的 credits_float 字段。
    function fmtEpoch(sec) {
        const d = new Date(sec * 1000);
        return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    // 从页面 localStorage 扫描 Cloud-IDE-JWT 凭证（示例 token 有有效期，不能硬编码，需动态获取）
    function findTraeToken() {
        const jwtRe = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

        // 1) 全量扫描 localStorage：值包含 Cloud-IDE-JWT 或本身就是 JWT 字符串的键
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i) || '';
                const val = localStorage.getItem(key);
                if (typeof val !== 'string' || !val) continue;
                if (/cloud-ide-jwt/i.test(key) || val.indexOf('Cloud-IDE-JWT') >= 0) {
                    const m = val.match(/Cloud-IDE-JWT\s+(eyJ[\w-]+\.[\w-]+\.[\w-]+)/) || val.match(jwtRe);
                    if (m) return 'Cloud-IDE-JWT ' + (m[1] || m[0]);
                }
            }
        } catch (e) { /* 部分页面可能限制访问，忽略 */ }

        // 2) 常见键名兜底
        const knownKeys = ['token', 'jwt', 'access_token', 'user_token', 'cloud_ide_jwt', 'user_jwt', 'Cloud-IDE-Token'];
        for (const key of knownKeys) {
            try {
                const val = localStorage.getItem(key);
                if (!val) continue;
                const m = val.match(/Cloud-IDE-JWT\s+(eyJ[\w-]+\.[\w-]+\.[\w-]+)/) || val.match(jwtRe);
                if (m) return 'Cloud-IDE-JWT ' + (m[1] || m[0]);
            } catch (e) { /* 忽略 */ }
        }

        return null;
    }

    // 拉取时间范围 [startSec, endSec]（Unix 秒）内的全部会话
    async function fetchTrae(startSec, endSec) {
        let token = findTraeToken() || MANUAL_TRAE_JWT;
        if (!token) {
            throw new Error('未能从页面获取 Cloud-IDE-JWT 登录凭证。请确认已登录 www.trae.cn，或将当前凭证填入脚本顶部 MANUAL_TRAE_JWT 常量。');
        }
        // findTraeToken 返回裸 JWT，请求头需要 "Cloud-IDE-JWT " 前缀；若已带前缀则原样使用
        const authorization = /^Cloud-IDE-JWT\s/i.test(token) ? token : 'Cloud-IDE-JWT ' + token;

        const PAGE_SIZE = 20; // TRAE 只能请求20个
        const MAX_PAGES = 30;
        const API = 'https://api.trae.cn/trae/api/v1/pay/query_user_usage_group_by_session';

        let firstJson = null;
        let allSessions = [];
        let recordTotal = null;
        let pages = 0;

        for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
            const json = await postJson(API,
                { start_time: startSec, end_time: endSec, page_size: PAGE_SIZE, page_num: pageNum, usage_type: [7] },
                { 'Authorization': authorization });
            if (!firstJson) firstJson = json;

            const current = Array.isArray(json.user_usage_group_by_sessions) ? json.user_usage_group_by_sessions : [];
            if (recordTotal === null && typeof json.total === 'number') recordTotal = json.total;

            allSessions = allSessions.concat(current);
            pages++;

            if (current.length === 0) break;
            if (recordTotal !== null && allSessions.length >= recordTotal) break;
        }
        if (!firstJson || !('user_usage_group_by_sessions' in firstJson)) {
            throw new Error('接口返回结构与预期不一致（缺少 user_usage_group_by_sessions 数组），请把接口返回贴给开发者核对。');
        }

        return {
            site: 'trae',
            json: firstJson,
            rows: allSessions.map(s => ({
                ts: (s.usage_time || 0) * 1000,
                time: s.usage_time ? fmtEpoch(s.usage_time) : '—',
                model: s.model_name || s.mode || '—',
                credit: s.credits_float,
                cost: s.cost_money_float
            })),
            recordTotal,
            pages
        };
    }

    // ========== 用量分桶与柱状图 ==========
    // 最近24小时：按小时分桶（从当前整点往前推 24 个整点小时，最后一桶为进行中的当前小时）
    function buildHourlyBuckets(rows, nowMs) {
        const hourStart = Math.floor(nowMs / 3600000) * 3600000;
        const first = hourStart - 23 * 3600000;
        const buckets = Array.from({ length: 24 }, (_, i) => {
            const d = new Date(first + i * 3600000);
            return {
                label: d.getHours() === 0 ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : `${pad(d.getHours())}:00`,
                title: `${formatDate(d)} ${pad(d.getHours())}:00 ~ ${pad(d.getHours())}:59`,
                isDayStart: d.getHours() === 0,
                value: 0
            };
        });
        for (const r of rows) {
            if (!r.ts || r.ts < first) continue;
            const idx = Math.min(23, Math.max(0, Math.floor((r.ts - first) / 3600000)));
            buckets[idx].value += toNumber(r.credit);
        }
        return buckets;
    }

    // 最近7天（含今日）：按自然日分桶
    function buildDailyBuckets(rows, todayStart) {
        const weekStart = todayStart - 6 * 86400000;
        const wd = ['日', '一', '二', '三', '四', '五', '六'];
        const buckets = Array.from({ length: 7 }, (_, i) => {
            const d = new Date(weekStart + i * 86400000);
            return {
                label: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
                title: `${formatDate(d)}（周${wd[d.getDay()]}）`,
                isDayStart: false,
                value: 0
            };
        });
        for (const r of rows) {
            if (!r.ts || r.ts < weekStart) continue;
            const idx = Math.min(6, Math.max(0, Math.floor((r.ts - weekStart) / 86400000)));
            buckets[idx].value += toNumber(r.credit);
        }
        return buckets;
    }

    // 纵轴最大值向上取整到 1/2/2.5/5×10^k 的"好看"数值
    function niceCeil(v) {
        if (v <= 0) return 1;
        const base = Math.pow(10, Math.floor(Math.log10(v)));
        for (const m of [1, 2, 2.5, 5, 10]) {
            if (v <= m * base + 1e-9) return m * base;
        }
        return 10 * base;
    }

    function fmtAxis(v) {
        if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
        if (v >= 100) return String(Math.round(v));
        return String(parseFloat(v.toFixed(1)));
    }

    // 纯 SVG 柱状图：一个柱子 = 一个时间段的积分使用总和，悬停柱子可查看精确值
    function buildBarChartSvg(buckets, opts) {
        const W = 480, H = 160;
        const padL = 40, padR = 6, padT = 12, padB = 20;
        const plotW = W - padL - padR;
        const plotH = H - padT - padB;
        const n = buckets.length;
        const niceMax = niceCeil(buckets.reduce((m, b) => Math.max(m, b.value), 0));
        const gap = n > 10 ? 2 : 10;
        const barW = (plotW - gap * (n - 1)) / n;

        // 横轴标签：每隔 labelEvery 个柱子标一次；日期交界处强制显示日期标签
        const labelIdx = new Set();
        for (let i = 0; i < n; i += (opts.labelEvery || 1)) labelIdx.add(i);
        buckets.forEach((b, i) => {
            if (b.isDayStart) {
                labelIdx.delete(i - 1);
                labelIdx.delete(i + 1);
                labelIdx.add(i);
            }
        });

        let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">`;
        [0, 0.5, 1].forEach(frac => {
            const y = padT + plotH - plotH * frac;
            s += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1" />`;
            s += `<text x="${padL - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#9ca3af">${escapeHtml(fmtAxis(niceMax * frac))}</text>`;
        });
        buckets.forEach((b, i) => {
            const x = padL + i * (barW + gap);
            const barH = b.value > 0 ? Math.max((b.value / niceMax) * plotH, 1) : 0;
            const y = padT + plotH - barH;
            s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="${Math.min(2, barW / 3).toFixed(1)}" fill="${opts.color}"><title>${escapeHtml(b.title || b.label)}：${formatNum(b.value)} 积分</title></rect>`;
            if (labelIdx.has(i)) {
                s += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="#6b7280">${escapeHtml(b.label)}</text>`;
            }
        });
        s += '</svg>';
        return s;
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
        #${MODAL_ID} .wbp-raw-toggle,
        #${MODAL_ID} .wbp-collapse-toggle {
            margin-top: 14px;
            background: #f9fafb;
            border: 1px solid #e5e7eb;
            color: #4b5563;
            font-size: 13px;
            padding: 6px 12px;
            border-radius: 8px;
            cursor: pointer;
        }
        #${MODAL_ID} .wbp-raw-toggle:hover,
        #${MODAL_ID} .wbp-collapse-toggle:hover { background: #f3f4f6; }
        #${MODAL_ID} .wbp-chart { margin: 0 0 6px; }
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

    function buildHtml({ json, date, rows, allRows, recordTotal, pages, site, hourly, daily }) {
        const isTrae = site === 'trae';
        const itemName = isTrae ? '会话' : '请求记录';
        const fieldName = isTrae ? 'credits_float' : 'credit';

        // rows = 今日记录，总量按今日求和
        const totalValue = sumField(rows, 'credit');
        let totalSource = `今日 ${rows.length} 条${itemName}的 ${fieldName} 字段求和`;
        if (pages > 1) totalSource += `（近7天数据分 ${pages} 页拉取）`;

        let html = `
            <div class="wbp-total">
                <div class="wbp-total-label">今日（${date}）积分使用总量（${isTrae ? 'Trae' : 'workbuddy'}）</div>
                <div class="wbp-total-value">${formatNum(totalValue)}</div>
                <div class="wbp-total-source">${totalSource}</div>`;

        if (isTrae) {
            const cost = sumField(rows, 'cost');
            if (cost > 0) html += `<div class="wbp-total-source">折合金额：$${formatNum(cost)}</div>`;
        }
        html += `</div>`;

        if (recordTotal !== null) {
            if (allRows.length < recordTotal) {
                html += `<div class="wbp-error">⚠️ 分页未取满：接口返回近7天共 ${recordTotal} 条${itemName}，实际只拉到 ${allRows.length} 条，图表与总量可能不完整。</div>`;
            } else {
                html += `<div class="wbp-stats">📌 近7天窗口共 ${recordTotal} 条${itemName}（今日 ${rows.length} 条），已全量拉取。</div>`;
            }
        }

        html += `<div class="wbp-section-title">📊 最近 24 小时 · 每小时积分用量</div>`;
        html += `<div class="wbp-chart">${buildBarChartSvg(hourly, { labelEvery: 4, color: '#3b82f6' })}</div>`;
        html += `<div class="wbp-section-title">📊 最近 7 天 · 每天积分用量</div>`;
        html += `<div class="wbp-chart">${buildBarChartSvg(daily, { labelEvery: 1, color: '#8b5cf6' })}</div>`;

        // 明细表（默认折叠）
        const CAP = 300;
        const shown = rows.slice(0, CAP);
        html += `<div class="wbp-section-title">📋 ${itemName}明细（今日共 ${rows.length} 条${rows.length > CAP ? `，仅显示前 ${CAP} 条` : ''}）</div>`;
        html += `<button class="wbp-collapse-toggle">⬇ 展开明细表格</button><div style="display:none">`;
        html += '<table><thead><tr><th>时间</th><th>模型</th><th>积分</th>' + (isTrae ? '<th>金额</th>' : '') + '</tr></thead><tbody>' +
            shown.map(r => {
                const t = (r.time !== undefined && r.time !== null) ? r.time : '—';
                const m = (r.model !== undefined && r.model !== null) ? r.model : '—';
                const c = (r.credit !== undefined && r.credit !== null) ? formatNum(r.credit) : '—';
                const co = (isTrae && r.cost !== undefined && r.cost !== null) ? `$${formatNum(r.cost)}` : '';
                return `<tr><td>${escapeHtml(String(t))}</td><td>${escapeHtml(String(m))}</td><td>${c}</td>` + (isTrae ? `<td>${co}</td>` : '') + `</tr>`;
            }).join('') +
            '</tbody></table>';
        html += `</div>`;

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

    // 明细表折叠开关（默认隐藏，点击展开）
    function bindCollapses(root) {
        root.querySelectorAll('.wbp-collapse-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const wrap = btn.nextElementSibling;
                if (!wrap) return;
                const show = wrap.style.display === 'none';
                wrap.style.display = show ? 'block' : 'none';
                btn.textContent = show ? '⬆ 收起明细表格' : '⬇ 展开明细表格';
            });
        });
    }

    function buildErrorHtml(msg) {
        let tip = '';
        if (/401|403|未登录|登录/.test(msg)) {
            tip = '<div style="color:#b45309;margin-top:8px;">提示：可能未登录或登录已过期，请先登录后重试。</div>';
        }
        return `<div class="wbp-error">❌ ${escapeHtml(msg)}</div>${tip}`;
    }

    async function doQuery(bodyEl) {
        try {
            const nowMs = Date.now();
            const d0 = new Date(); d0.setHours(0, 0, 0, 0);
            const todayStart = d0.getTime();
            const weekStart = todayStart - 6 * 86400000; // 近7天（含今日）
            const date = formatDate(new Date());

            // 一次拉取近7天全量数据：今日总量、24小时/7天图表共用
            let data;
            if (SITE === 'trae') {
                data = await fetchTrae(Math.floor(weekStart / 1000), Math.floor((todayStart + 86399999) / 1000));
            } else {
                data = await fetchWorkbuddy(fmtDateTime(weekStart), `${date} 23:59:59`);
            }

            const todayRows = data.rows.filter(r => r.ts >= todayStart);
            const hourly = buildHourlyBuckets(data.rows, nowMs);
            const daily = buildDailyBuckets(data.rows, todayStart);

            bodyEl.innerHTML = buildHtml({
                json: data.json,
                date,
                rows: todayRows,
                allRows: data.rows,
                recordTotal: data.recordTotal,
                pages: data.pages,
                site: data.site,
                hourly,
                daily
            });
            bindRawToggle(bodyEl);
            bindCollapses(bodyEl);
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
                    <div class="wbp-loading">⏳ 正在查询近7天积分使用数据…</div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelector('.wbp-close').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        doQuery(document.getElementById(BODY_ID));
    }

    // ========== 注册 Tampermonkey 菜单按钮 ==========
    if (SITE) {
        GM_registerMenuCommand('🔍 查看今日积分使用量', openModal);
    }
})();