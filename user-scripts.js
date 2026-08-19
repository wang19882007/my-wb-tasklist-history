// ==UserScript==
// @name         gs-btn-brand 计数器（任务去重，定时3小时，显示增减）
// @namespace    http://tampermonkey.net/
// @version      2.6
// @description  统计 .gs-btn-brand 数量并记录任务详情，items相同不重复记录，每3小时定时执行，展示新增（绿色）与减少（🗑️删除线），数量列显示差值，支持单条删除与一键清空历史记录
// @author       You
// @match        https://www.workbuddy.cn/profile/growth-center
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    // ========== 配置项 ==========
    const STORAGE_KEY = 'gs_btn_brand_history';
    const INTERVAL_MS = 3 * 60 * 60 * 1000; // 3小时
    // 测试展示开关（true 时在查看历史时对最新记录添加测试任务以演示新增/删除样式，不影响存储）
    const ENABLE_TEST_DISPLAY = false;

    // ========== 注入弹窗样式 ==========
    GM_addStyle(`
        #gs-history-modal {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.6);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        #gs-history-modal.active {
            display: flex;
        }
        #gs-history-modal .modal-box {
            background: #fff;
            border-radius: 12px;
            padding: 24px 30px 30px 30px;
            width: 933px;
            max-width: 90vw;
            min-width: 320px;
            max-height: 80vh;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            display: flex;
            flex-direction: column;
        }
        @media (max-width: 1000px) {
            #gs-history-modal .modal-box {
                width: 90vw;
                min-width: unset;
            }
        }
        #gs-history-modal .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #e5e7eb;
            padding-bottom: 12px;
            margin-bottom: 16px;
        }
        #gs-history-modal .modal-header h2 {
            margin: 0;
            font-size: 18px;
            font-weight: 600;
            color: #1f2937;
        }
        #gs-history-modal .modal-header .close-btn {
            background: none;
            border: none;
            font-size: 24px;
            cursor: pointer;
            color: #9ca3af;
            padding: 0 4px;
            line-height: 1;
        }
        #gs-history-modal .modal-header .close-btn:hover {
            color: #374151;
        }
        #gs-history-modal .header-actions {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        #gs-history-modal .clear-all-btn {
            background: #fef2f2;
            color: #dc2626;
            border: 1px solid #fecaca;
            border-radius: 6px;
            padding: 5px 12px;
            font-size: 13px;
            cursor: pointer;
            transition: background 0.15s;
        }
        #gs-history-modal .clear-all-btn:hover {
            background: #fee2e2;
        }
        #gs-history-modal .row-delete-btn {
            background: none;
            border: 1px solid transparent;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            padding: 4px 8px;
            color: #9ca3af;
            transition: all 0.15s;
        }
        #gs-history-modal .row-delete-btn:hover {
            background: #fee2e2;
            color: #dc2626;
            border-color: #fecaca;
        }
        #gs-history-modal .modal-body {
            overflow-y: auto;
            flex: 1;
        }
        #gs-history-modal table {
            width: 100%;
            table-layout: fixed;
            border-collapse: collapse;
            font-size: 14px;
        }
        #gs-history-modal th:nth-child(1),
        #gs-history-modal td:nth-child(1) { width: 5%; }
        #gs-history-modal th:nth-child(2),
        #gs-history-modal td:nth-child(2) { width: 17%; }
        #gs-history-modal th:nth-child(3),
        #gs-history-modal td:nth-child(3) { width: 12%; }
        #gs-history-modal th:nth-child(4),
        #gs-history-modal td:nth-child(4) { width: 60%; }
        #gs-history-modal th:nth-child(5),
        #gs-history-modal td:nth-child(5) { width: 6%; }

        #gs-history-modal th {
            background: #f3f4f6;
            text-align: left;
            padding: 10px 12px;
            font-weight: 600;
            color: #374151;
            border-bottom: 2px solid #e5e7eb;
            position: sticky;
            top: 0;
            z-index: 2;
        }
        #gs-history-modal td {
            padding: 10px 12px;
            border-bottom: 1px solid #f3f4f6;
            color: #1f2937;
            word-break: break-word;
        }
        #gs-history-modal tr:hover td {
            background: #f9fafb;
        }
        #gs-history-modal .empty-state {
            text-align: center;
            padding: 40px 0;
            color: #9ca3af;
            font-size: 15px;
        }
        #gs-history-modal .badge-count {
            display: inline-block;
            background: #e0f2fe;
            color: #0369a1;
            font-weight: 600;
            padding: 2px 10px;
            border-radius: 12px;
            font-size: 13px;
        }
        /* 数量差值徽章 */
        #gs-history-modal .diff-badge {
            display: inline-block;
            font-size: 12px;
            font-weight: 600;
            padding: 1px 8px;
            border-radius: 10px;
            margin-left: 4px;
        }
        #gs-history-modal .diff-badge.positive {
            background: #dcfce7;
            color: #16a34a;
        }
        #gs-history-modal .diff-badge.negative {
            background: #f3f4f6;
            color: #4b5563;
        }
        #gs-history-modal .footer-info {
            margin-top: 14px;
            padding-top: 12px;
            border-top: 1px solid #e5e7eb;
            font-size: 13px;
            color: #6b7280;
            text-align: right;
        }
        .detail-toggle {
            color: #3b82f6;
            cursor: pointer;
            font-size: 12px;
            margin-left: 6px;
            background: none;
            border: none;
            text-decoration: underline;
        }
        .detail-toggle:hover { color: #2563eb; }

        .task-detail-popup {
            display: none;
            background: #f9fafb;
            border-radius: 6px;
            padding: 8px 10px;
            margin-top: 4px;
            font-size: 12px;
            color: #4b5563;
            line-height: 1.5;
            max-width: 100%;
            width: 100%;
            box-sizing: border-box;
            word-break: break-word;
        }
        .task-detail-popup.active { display: block; }
        .task-detail-popup .item {
            border-bottom: 1px dashed #e5e7eb;
            padding: 4px 0;
        }
        .task-detail-popup .item:last-child { border-bottom: none; }
        .task-detail-popup .item strong { color: #1f2937; }
        /* 新增任务：绿色 */
        .task-detail-popup .item.is-new {
            color: #16a34a;
            font-weight: 500;
        }
        .task-detail-popup .item.is-new strong {
            color: #15803d;
        }
        /* 被删除任务：删除线 + 灰色背景 + 垃圾桶 */
        .task-detail-popup .item.is-removed {
            text-decoration: line-through;
            background: #e5e7eb;
            color: #6b7280;
            padding: 2px 6px;
            border-radius: 4px;
            margin: 2px 0;
            border-bottom: none;
        }
        .task-detail-popup .removed-section {
            margin-top: 8px;
            padding-top: 6px;
            border-top: 1px dashed #d1d5db;
        }
        .task-detail-popup .removed-label {
            font-size: 12px;
            color: #6b7280;
            margin-bottom: 4px;
        }
    `);

    // ========== 工具函数 ==========
    function getCurrentTime() {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }

    // ========== 存储操作 ==========
    function saveHistory(items) {
        let history = GM_getValue(STORAGE_KEY, []);
        if (!Array.isArray(history)) history = [];

        const last = history.length > 0 ? history[history.length - 1] : null;
        let shouldSave = true;

        if (last && last.items) {
            const currentStr = JSON.stringify(items);
            const lastStr = JSON.stringify(last.items);
            if (currentStr === lastStr) {
                shouldSave = false;
                console.log('[gs-btn-brand] 任务列表与上次相同，跳过保存。');
            }
        }

        if (!shouldSave) return;

        history.push({
            timestamp: getCurrentTime(),
            items: items
        });

        GM_setValue(STORAGE_KEY, history);
        console.log(`[gs-btn-brand] 已记录 ${items.length} 个任务：`, items);
    }

    function getHistory() {
        const data = GM_getValue(STORAGE_KEY, []);
        return Array.isArray(data) ? data : [];
    }

    // ========== 删除历史记录 ==========
    function deleteRecord(index) {
        const history = getHistory();
        if (index < 0 || index >= history.length) return;
        const record = history[index];
        const time = record.timestamp || '未知时间';
        const count = (record.items || []).length;
        if (!confirm(`确定删除这条记录吗？\n\n时间：${time}\n任务数：${count}\n\n删除后不可恢复。`)) return;
        history.splice(index, 1);
        GM_setValue(STORAGE_KEY, history);
        console.log(`[gs-btn-brand] 已删除记录：${time}（${count} 个任务）`);
        refreshModalContent();
    }

    function clearAllHistory() {
        const history = getHistory();
        if (history.length === 0) return;
        if (!confirm(`确定要清空全部 ${history.length} 条历史记录吗？\n\n删除后不可恢复！`)) return;
        GM_setValue(STORAGE_KEY, []);
        console.log('[gs-btn-brand] 已清空全部历史记录。');
        refreshModalContent();
    }

    // ========== 收集任务信息 ==========
    function collectTaskDetails() {
        const buttons = document.querySelectorAll('.gs-btn-brand, .gs-btn-dark');
        const items = [];
        buttons.forEach(btn => {
            let row = btn.closest('.gs-task-row');
            if (!row) {
                console.warn('[gs-btn-brand] 按钮未找到父级 .gs-task-row，跳过该按钮');
                return;
            }
            const titleEl = row.querySelector('.gs-task-title');
            const descEl = row.querySelector('.gs-task-desc');
            const title = titleEl ? titleEl.textContent.trim() : '';
            const desc = descEl ? descEl.textContent.trim() : '';
            items.push({ title, desc });
        });
        return items;
    }

    // ========== 计算两个任务列表的差异 ==========
    function getDiffCount(currentItems, prevItems) {
        if (!prevItems || prevItems.length === 0) return { added: 0, removed: 0 };
        const currentSet = new Set(currentItems.map(it => `${it.title}||${it.desc}`));
        const prevSet = new Set(prevItems.map(it => `${it.title}||${it.desc}`));
        let added = 0, removed = 0;
        currentItems.forEach(it => {
            const key = `${it.title}||${it.desc}`;
            if (!prevSet.has(key)) added++;
        });
        prevItems.forEach(it => {
            const key = `${it.title}||${it.desc}`;
            if (!currentSet.has(key)) removed++;
        });
        return { added, removed };
    }

    // ========== 生成任务详情 HTML（含新增与减少高亮） ==========
    function buildItemsHtml(items, prevItems) {
        if (!items) items = [];
        if (!prevItems) prevItems = [];

        const currentSet = new Set(items.map(it => `${it.title}||${it.desc}`));
        const prevSet = new Set(prevItems.map(it => `${it.title}||${it.desc}`));
        const hasPrev = prevItems.length > 0;

        // --- 当前任务列表 ---
        let currentHtml = '';
        if (items.length > 0) {
            currentHtml = items.map((t, i) => {
                const key = `${t.title}||${t.desc}`;
                const isNew = hasPrev && !prevSet.has(key);
                const star = isNew ? '⭐ ' : '';
                const className = isNew ? 'item is-new' : 'item';
                return `<div class="${className}">${star}<strong>${i+1}.</strong> ${t.title || '无标题'} — ${t.desc || '无描述'}</div>`;
            }).join('');
        } else {
            currentHtml = '<div style="color:#9ca3af;font-size:12px;">当前无任务</div>';
        }

        // --- 减少的任务（上一条有，当前没有） ---
        let removedHtml = '';
        if (hasPrev) {
            const removed = prevItems.filter(it => !currentSet.has(`${it.title}||${it.desc}`));
            if (removed.length > 0) {
                removedHtml = `
                    <div class="removed-section">
                        <div class="removed-label">⬇ 已移除的任务（相对上一条）</div>
                        ${removed.map((t, i) => `
                            <div class="item is-removed">
                                🗑️ <strong>${i+1}.</strong> ${t.title || '无标题'} — ${t.desc || '无描述'}
                            </div>
                        `).join('')}
                    </div>
                `;
            }
        }

        return currentHtml + removedHtml;
    }

    // ========== 模态框 UI ==========
    function renderModal() {
        const existing = document.getElementById('gs-history-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'gs-history-modal';
        modal.innerHTML = `
            <div class="modal-box">
                <div class="modal-header">
                    <h2>📊 gs-btn-brand 计数历史</h2>
                    <div class="header-actions">
                        <button class="clear-all-btn" id="gs-modal-clear-all">🗑️ 清空全部</button>
                        <button class="close-btn" id="gs-modal-close">✕</button>
                    </div>
                </div>
                <div class="modal-body" id="gs-modal-body">
                    <div class="empty-state">加载中...</div>
                </div>
                <div class="footer-info" id="gs-modal-footer"></div>
            </div>
        `;
        document.body.appendChild(modal);

        const closeBtn = document.getElementById('gs-modal-close');
        const modalOverlay = document.getElementById('gs-history-modal');
        const clearAllBtn = document.getElementById('gs-modal-clear-all');
        closeBtn.addEventListener('click', () => modalOverlay.classList.remove('active'));
        clearAllBtn.addEventListener('click', clearAllHistory);
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) modalOverlay.classList.remove('active');
        });

        refreshModalContent();
        modal.classList.add('active');
    }

    function refreshModalContent() {
        const body = document.getElementById('gs-modal-body');
        const footer = document.getElementById('gs-modal-footer');
        if (!body) return;

        const history = getHistory();

        // 无记录时隐藏"清空全部"按钮
        const clearAllBtn = document.getElementById('gs-modal-clear-all');
        if (clearAllBtn) clearAllBtn.style.display = history.length > 0 ? '' : 'none';

        if (history.length === 0) {
            body.innerHTML = `<div class="empty-state">📭 暂无任何记录，请先访问目标页面触发统计。</div>`;
            footer.textContent = '';
            return;
        }

        // 反转以便最新在前
        const reversed = [...history].reverse();

        let tableHtml = `
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>时间</th>
                        <th>数量</th>
                        <th>任务详情</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>
        `;

        reversed.forEach((item, index) => {
            // 原始 items
            let currentItems = item.items ? [...item.items] : [];
            let prevItems = [];
            if (index < reversed.length - 1) {
                const prevRecord = reversed[index + 1];
                prevItems = prevRecord.items ? [...prevRecord.items] : [];
            }

            // ---- 测试展示：仅在最新记录（index===0）且启用测试时，添加演示任务 ----
            if (ENABLE_TEST_DISPLAY && index === 0) {
                // 添加一个"新增"测试任务（当前有，上一条没有）
                const newTest = {
                    title: '【测试】新增任务',
                    desc: '演示新增样式（绿色）'
                };
                const newKey = `${newTest.title}||${newTest.desc}`;
                const prevSet = new Set(prevItems.map(it => `${it.title}||${it.desc}`));
                if (!prevSet.has(newKey)) {
                    currentItems.push(newTest);
                } else {
                    newTest.title = '【测试】新增任务 (演示)';
                    currentItems.push(newTest);
                }

                // 添加一个"被删除"测试任务（上一条有，当前没有）
                const removedTest = {
                    title: '【测试】被删除任务',
                    desc: '演示删除样式（🗑️）'
                };
                const removedKey = `${removedTest.title}||${removedTest.desc}`;
                const currentSet = new Set(currentItems.map(it => `${it.title}||${it.desc}`));
                if (!currentSet.has(removedKey)) {
                    const prevSet2 = new Set(prevItems.map(it => `${it.title}||${it.desc}`));
                    if (!prevSet2.has(removedKey)) {
                        prevItems.push(removedTest);
                    }
                } else {
                    const removedTest2 = {
                        title: '【测试】被删除任务 (演示)',
                        desc: '演示删除样式'
                    };
                    const key2 = `${removedTest2.title}||${removedTest2.desc}`;
                    const curSet2 = new Set(currentItems.map(it => `${it.title}||${it.desc}`));
                    if (!curSet2.has(key2)) {
                        prevItems.push(removedTest2);
                    }
                }
            }

            // 计算差值
            const diff = getDiffCount(currentItems, prevItems);
            const count = currentItems.length;
            let countDisplay = `<span class="badge-count">${count}</span>`;
            if (diff.added > 0) {
                countDisplay += ` <span class="diff-badge positive">+${diff.added}</span>`;
            }
            if (diff.removed > 0) {
                countDisplay += ` <span class="diff-badge negative">-${diff.removed}</span>`;
            }

            // 构建详情 HTML
            let detailHtml = '';
            if (currentItems.length > 0 || (item.items && item.items.length > 0)) {
                const id = `detail-${Date.now()}-${index}`;
                const itemsHtml = buildItemsHtml(currentItems, prevItems);
                detailHtml = `
                    <button class="detail-toggle" data-target="${id}">📋 展开</button>
                    <div class="task-detail-popup" id="${id}">
                        ${itemsHtml}
                    </div>
                `;
            } else {
                detailHtml = '<span style="color:#9ca3af;font-size:12px;">无详情</span>';
            }

            // 序号从最早记录开始：总条数 - 当前索引
            const serialNumber = reversed.length - index;
            // 该行对应原始 history 数组的下标（展示为倒序，最新在前）
            const originalIndex = history.length - 1 - index;

            tableHtml += `
                <tr>
                    <td>${serialNumber}</td>
                    <td>${item.timestamp || '未知'}</td>
                    <td>${countDisplay}</td>
                    <td style="position:relative;">${detailHtml}</td>
                    <td><button class="row-delete-btn" data-index="${originalIndex}" title="删除此条记录">🗑️</button></td>
                </tr>
            `;
        });

        tableHtml += `</tbody></table>`;
        body.innerHTML = tableHtml;

        // 绑定展开/收起事件
        document.querySelectorAll('.detail-toggle').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                const targetId = this.dataset.target;
                const popup = document.getElementById(targetId);
                if (popup) {
                    popup.classList.toggle('active');
                    this.textContent = popup.classList.contains('active') ? '📋 收起' : '📋 展开';
                }
            });
        });

        // 绑定单条删除事件
        document.querySelectorAll('#gs-modal-body .row-delete-btn').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                deleteRecord(parseInt(this.dataset.index, 10));
            });
        });

        const totalCount = history.reduce((sum, record) => {
            const items = record.items || [];
            return sum + items.length;
        }, 0);
        footer.textContent = `共 ${history.length} 条记录 · 累计统计到 ${totalCount} 个任务`;
    }

    // ========== 注册 Tampermonkey 菜单按钮 ==========
    GM_registerMenuCommand('📊 查看 gs-btn-brand 历史记录', function() {
        const existing = document.getElementById('gs-history-modal');
        if (existing) {
            if (existing.classList.contains('active')) {
                refreshModalContent();
            } else {
                refreshModalContent();
                existing.classList.add('active');
            }
        } else {
            renderModal();
        }
    });

    // ========== 主逻辑 ==========
    function main() {
        const items = collectTaskDetails();
        saveHistory(items);
    }

    // ========== 初始执行与定时循环 ==========
    setTimeout(() => {
        main();
    }, 10000);

    setInterval(main, INTERVAL_MS);

})();