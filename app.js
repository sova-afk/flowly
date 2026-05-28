(function() {
  'use strict';

  const DB_NAME = 'flowly';
  const STORE_NAME = 'periods';
  let dbCache = [];
  let dbReady = false;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function initDB() {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const all = await new Promise(res => {
      const r = store.getAll();
      r.onsuccess = () => res(r.result);
    });

    // migrate from localStorage if empty
    if (all.length === 0) {
      try {
        const legacy = JSON.parse(localStorage.getItem('flowly_periods'));
        if (legacy && legacy.length) {
          const tx2 = db.transaction(STORE_NAME, 'readwrite');
          for (const p of legacy) tx2.objectStore(STORE_NAME).put(p);
          await new Promise(res => { tx2.oncomplete = res; });
          all.push(...legacy);
        }
      } catch {}
      localStorage.removeItem('flowly_periods');
    }

    dbCache = all;
    dbReady = true;
    db.close();
  }

  function getPeriods() {
    return dbCache;
  }

  function savePeriods(periods) {
    dbCache = periods;
    openDB().then(db => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      for (const p of periods) store.put(p);
      tx.oncomplete = () => db.close();
    }).catch(() => {});
  }

  function addPeriod(startDate, endDate, notes) {
    const periods = getPeriods();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    periods.push({ id, startDate, endDate, notes: notes || '' });
    periods.sort((a, b) => b.startDate.localeCompare(a.startDate));
    savePeriods(periods);
    return periods;
  }

  function deletePeriod(id) {
    let periods = getPeriods();
    periods = periods.filter(p => p.id !== id);
    savePeriods(periods);
    return periods;
  }

  function updatePeriod(id, startDate, endDate, notes) {
    let periods = getPeriods();
    const idx = periods.findIndex(p => p.id === id);
    if (idx === -1) return periods;
    periods[idx] = { ...periods[idx], startDate, endDate, notes: notes || '' };
    periods.sort((a, b) => b.startDate.localeCompare(a.startDate));
    savePeriods(periods);
    return periods;
  }

  // ---- Date helpers ----
  function parseDate(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function formatDisplay(dateStr) {
    const d = parseDate(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function daysBetween(a, b) {
    const da = parseDate(a);
    const db = parseDate(b);
    return Math.round((db - da) / (1000 * 60 * 60 * 24));
  }
  function addDays(dateStr, n) {
    const d = parseDate(dateStr);
    d.setDate(d.getDate() + n);
    return formatDate(d);
  }

  // ---- Predictions ----
  function getPredictions(periods) {
    const sorted = [...periods].sort((a, b) => a.startDate.localeCompare(b.startDate));
    const result = { nextStart: null, rangeStart: null, rangeEnd: null, avgCycle: null, avgPeriod: null };

    if (sorted.length === 0) return result;

    const periodLengths = sorted.map(p => daysBetween(p.startDate, p.endDate) + 1);
    result.avgPeriod = Math.round(periodLengths.reduce((a, b) => a + b, 0) / periodLengths.length);

    const cycleLengths = [];
    for (let i = 1; i < sorted.length; i++) {
      cycleLengths.push(daysBetween(sorted[i - 1].startDate, sorted[i].startDate));
    }

    if (cycleLengths.length === 0) {
      result.avgCycle = 28;
      result.nextStart = addDays(sorted[0].startDate, 28);
      result.rangeStart = addDays(sorted[0].startDate, 26);
      result.rangeEnd = addDays(sorted[0].startDate, 30);
      return result;
    }

    const recent = cycleLengths.slice(-6);
    result.avgCycle = Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);

    const lastStart = sorted[sorted.length - 1].startDate;
    result.nextStart = addDays(lastStart, result.avgCycle);
    const variance = Math.max(1, Math.round(result.avgCycle * 0.1));
    result.rangeStart = addDays(lastStart, result.avgCycle - variance);
    result.rangeEnd = addDays(lastStart, result.avgCycle + variance);

    return result;
  }

  function getPeriodDateSet(periods) {
    const set = new Set();
    periods.forEach(p => {
      const start = parseDate(p.startDate);
      const end = parseDate(p.endDate);
      let cur = new Date(start);
      while (cur <= end) {
        set.add(formatDate(cur));
        cur.setDate(cur.getDate() + 1);
      }
    });
    return set;
  }

  function getPredictedDateSet(pred) {
    if (!pred.nextStart) return new Set();
    const set = new Set();
    const start = parseDate(pred.rangeStart);
    const end = parseDate(pred.rangeEnd);
    let cur = new Date(start);
    while (cur <= end) {
      set.add(formatDate(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return set;
  }

  // ---- Tab switching ----
  let currentTab = 'calendar';

  function switchTab(tabId) {
    currentTab = tabId;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-' + tabId).classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.tab-btn[data-tab="${tabId}"]`).classList.add('active');

    if (tabId === 'calendar') renderCalendar();
    if (tabId === 'stats') renderStats();
    if (tabId === 'history') renderList();
  }

  // ---- Calendar ----
  let viewDate = new Date();
  let editingId = null;

  function renderCalendar() {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();

    document.getElementById('month-label').textContent =
      viewDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    const periods = getPeriods();
    const periodSet = getPeriodDateSet(periods);
    const pred = getPredictions(periods);
    const predSet = getPredictedDateSet(pred);

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrev = new Date(year, month, 0).getDate();
    const today = new Date();

    const startOffset = firstDay === 0 ? 6 : firstDay - 1;

    const grid = document.getElementById('cal-grid');
    while (grid.children.length > 7) {
      grid.removeChild(grid.lastChild);
    }

    const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

    for (let i = 0; i < totalCells; i++) {
      let day, dateStr, isOther = false, cls = 'day';
      if (i < startOffset) {
        day = daysInPrev - startOffset + i + 1;
        dateStr = formatDate(new Date(year, month - 1, day));
        isOther = true;
      } else if (i >= startOffset + daysInMonth) {
        day = i - startOffset - daysInMonth + 1;
        dateStr = formatDate(new Date(year, month + 1, day));
        isOther = true;
      } else {
        day = i - startOffset + 1;
        dateStr = formatDate(new Date(year, month, day));
      }

      if (isOther) cls += ' other-month';
      if (dateStr === formatDate(today)) cls += ' today';
      if (periodSet.has(dateStr)) cls += ' period';
      else if (predSet.has(dateStr)) cls += ' predicted';

      const el = document.createElement('div');
      el.className = cls;
      el.textContent = day;
      el.dataset.date = dateStr;
      el.addEventListener('click', () => {
        document.getElementById('start-date').value = dateStr;
        document.getElementById('end-date').value = dateStr;
        switchTab('log');
      });
      grid.appendChild(el);
    }
  }

  // ---- Stats ----
  function renderStats() {
    const periods = getPeriods();
    const pred = getPredictions(periods);

    document.getElementById('stat-avg-cycle').textContent =
      pred.avgCycle ? pred.avgCycle + 'd' : '--';
    document.getElementById('stat-avg-period').textContent =
      pred.avgPeriod ? pred.avgPeriod + 'd' : '--';
    document.getElementById('stat-logged').textContent = periods.length;
    document.getElementById('stat-predicted-cycle').textContent =
      pred.avgCycle ? pred.avgCycle + 'd' : '--';

    const block = document.getElementById('next-period-block');
    if (periods.length === 0) {
      renderEmptyStats();
      return;
    }
    if (pred.nextStart) {
      const today = new Date();
      const daysUntil = daysBetween(formatDate(today), pred.nextStart);
      let daysText = '';
      if (daysUntil > 0) daysText = `(${daysUntil} day${daysUntil !== 1 ? 's' : ''} away)`;
      else if (daysUntil === 0) daysText = '(expected today)';
      else daysText = `(${Math.abs(daysUntil)} day${Math.abs(daysUntil) !== 1 ? 's' : ''} ago)`;

      block.innerHTML = `
        <div class="next-period-block">
          <div class="value">Next period ~ ${formatDisplay(pred.nextStart)}</div>
          <div class="sub">Expected range: ${formatDisplay(pred.rangeStart)} – ${formatDisplay(pred.rangeEnd)} ${daysText}</div>
        </div>
      `;
    } else {
      block.innerHTML = '';
    }
  }

  // ---- History list ----
  function renderList() {
    const periods = getPeriods();
    const container = document.getElementById('periods-list');

    if (periods.length === 0) {
      container.innerHTML = '<div class="empty-state">No periods logged yet.<br>Head to the <strong>Log</strong> tab to add your first entry.<br>Once you have data, you\'ll see it listed here with the option to edit or delete.</div>';
      return;
    }

    container.innerHTML = periods.map(p => {
      const periodLen = daysBetween(p.startDate, p.endDate) + 1;
      return `
        <div class="period-entry">
          <div>
            <div class="dates">
              <strong>${formatDisplay(p.startDate)}</strong> – ${formatDisplay(p.endDate)}
              <span style="color:var(--text-muted);font-size:0.75rem;"> (${periodLen}d)</span>
            </div>
            ${p.notes ? `<div class="notes">${escapeHtml(p.notes)}</div>` : ''}
          </div>
          <div style="display:flex;gap:4px;">
            <button class="del-btn" data-edit-id="${p.id}" title="Edit" aria-label="Edit">
              <svg viewBox="0 0 24 24"><path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
            </button>
            <button class="del-btn" data-del-id="${p.id}" title="Delete" aria-label="Delete">
              <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
            </button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('[data-del-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm('Delete this period entry?')) {
          deletePeriod(btn.dataset.delId);
          refreshAll();
          showToast('Period deleted');
        }
      });
    });

    container.querySelectorAll('[data-edit-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const allPeriods = getPeriods();
        const p = allPeriods.find(x => x.id === btn.dataset.editId);
        if (!p) return;
        editingId = p.id;
        document.getElementById('start-date').value = p.startDate;
        document.getElementById('end-date').value = p.endDate;
        document.getElementById('notes').value = p.notes;
        document.getElementById('save-btn').textContent = 'Update';
        document.getElementById('cancel-edit').style.display = 'inline-block';
        switchTab('log');
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---- Form ----
  function setupForm() {
    const form = document.getElementById('period-form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const start = document.getElementById('start-date').value;
      const end = document.getElementById('end-date').value;
      const notes = document.getElementById('notes').value;

      if (!start || !end) return;
      if (end < start) {
        showToast('End date must be after start date');
        return;
      }

      if (editingId) {
        updatePeriod(editingId, start, end, notes);
        showToast('Period updated');
        cancelEdit();
      } else {
        addPeriod(start, end, notes);
        showToast('Period saved');
      }

      form.reset();
      const today = formatDate(new Date());
      document.getElementById('start-date').value = today;
      document.getElementById('end-date').value = today;
      refreshAll();
    });

    document.getElementById('cancel-edit').addEventListener('click', cancelEdit);

    const today = formatDate(new Date());
    document.getElementById('start-date').value = today;
    document.getElementById('end-date').value = today;
  }

  function cancelEdit() {
    editingId = null;
    document.getElementById('save-btn').textContent = 'Save';
    document.getElementById('cancel-edit').style.display = 'none';
    document.getElementById('period-form').reset();
    const today = formatDate(new Date());
    document.getElementById('start-date').value = today;
    document.getElementById('end-date').value = today;
  }

  // ---- Calendar nav ----
  function setupNav() {
    document.getElementById('prev-month').addEventListener('click', () => {
      viewDate.setMonth(viewDate.getMonth() - 1);
      renderCalendar();
    });
    document.getElementById('next-month').addEventListener('click', () => {
      viewDate.setMonth(viewDate.getMonth() + 1);
      renderCalendar();
    });
  }

  // ---- Data page ----
  function setupDataPage() {
    document.getElementById('copy-data').addEventListener('click', () => {
      const data = getPeriods();
      const json = JSON.stringify(data, null, 2);
      navigator.clipboard.writeText(json).then(() => {
        showToast('Copied to clipboard (' + data.length + ' entries)');
      }).catch(() => {
        fallbackCopy(json);
      });
    });

    document.getElementById('download-data').addEventListener('click', () => {
      const data = getPeriods();
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'flowly-backup-' + formatDate(new Date()) + '.json';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Downloaded ' + data.length + ' entries');
    });

    document.getElementById('import-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        document.getElementById('import-text').value = ev.target.result;
        showToast('File loaded — click Import to apply');
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    document.getElementById('import-btn').addEventListener('click', () => {
      const text = document.getElementById('import-text').value.trim();
      if (!text) {
        showToast('Paste some JSON data first');
        return;
      }
      try {
        const data = JSON.parse(text);
        if (!Array.isArray(data)) throw new Error('Not an array');
        for (const item of data) {
          if (!item.id || !item.startDate || !item.endDate) {
            throw new Error('Invalid entry format');
          }
        }
        if (data.length === 0) {
          showToast('No entries found in that data');
          return;
        }
        if (!confirm('This will replace ALL current data with ' + data.length + ' entries. Continue?')) return;
        savePeriods(data);
        document.getElementById('import-text').value = '';
        refreshAll();
        showToast('Imported ' + data.length + ' entries');
      } catch (err) {
        showToast('Invalid JSON: ' + err.message);
      }
    });
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast('Copied to clipboard');
    } catch {
      showToast('Could not copy. Try downloading instead.');
    }
    document.body.removeChild(ta);
  }

  // ---- Toast ----
  let toastTimer = null;
  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
  }

  // ---- Refresh ----
  function refreshAll() {
    if (currentTab === 'calendar') renderCalendar();
    if (currentTab === 'stats') renderStats();
    if (currentTab === 'history') renderList();
  }

  // ---- Intro ----
  function setupIntro() {
    const seen = localStorage.getItem('flowly_intro_seen');
    if (seen) return;

    const overlay = document.getElementById('intro-overlay');
    overlay.classList.add('show');

    document.getElementById('intro-skip').addEventListener('click', () => {
      overlay.classList.remove('show');
      localStorage.setItem('flowly_intro_seen', '1');
    });

    document.getElementById('intro-start').addEventListener('click', () => {
      overlay.classList.remove('show');
      localStorage.setItem('flowly_intro_seen', '1');
      startTutorial();
    });
  }

  // ---- Tutorial ----
  const tutorialSteps = [
    { tab: 'calendar', title: 'Calendar', desc: 'View your cycle at a glance. Pink cells mark logged periods, light pink marks predictions. The dot shows today. Tap a date to jump straight to the Log tab.' },
    { tab: 'log', title: 'Log', desc: 'Record a period by picking a start and end date. Add optional notes for symptoms or mood, then hit Save.' },
    { tab: 'stats', title: 'Statistics', desc: 'See your averages and predictions. Flowly calculates your typical cycle and period length, and estimates when your next period will start.' },
    { tab: 'history', title: 'History', desc: 'Browse all your past entries in one place. Edit or delete any period whenever you need to.' },
    { tab: 'data', title: 'Your Data', desc: 'Export your data as JSON or import a backup. Everything stays on this device — no accounts, no servers, no cloud.' },
  ];

  let tutorialIdx = -1;

  function startTutorial() {
    const el = document.getElementById('tutorial');
    tutorialIdx = 0;
    renderTutorialStep();
    el.classList.add('show');

    document.getElementById('tutorial-next').onclick = () => {
      if (tutorialIdx >= tutorialSteps.length - 1) {
        endTutorial();
        return;
      }
      tutorialIdx++;
      renderTutorialStep();
    };

    document.getElementById('tutorial-back').onclick = () => {
      if (tutorialIdx > 0) {
        tutorialIdx--;
        renderTutorialStep();
      }
    };

    document.getElementById('tutorial-skip').onclick = () => {
      endTutorial();
    };
  }

  function endTutorial() {
    document.getElementById('tutorial').classList.remove('show');
    document.querySelectorAll('.tab-btn.tutorial-highlight').forEach(b => b.classList.remove('tutorial-highlight'));
    tutorialIdx = -1;
  }

  function renderTutorialStep() {
    const step = tutorialSteps[tutorialIdx];
    if (!step) return;

    document.getElementById('tutorial-step').textContent = `${tutorialIdx + 1} / ${tutorialSteps.length}`;
    document.getElementById('tutorial-title').textContent = step.title;
    document.getElementById('tutorial-desc').textContent = step.desc;

    document.querySelectorAll('.tab-btn.tutorial-highlight').forEach(b => b.classList.remove('tutorial-highlight'));
    const tabBtn = document.querySelector(`.tab-btn[data-tab="${step.tab}"]`);
    if (tabBtn) tabBtn.classList.add('tutorial-highlight');

    const dotsEl = document.getElementById('tutorial-dots');
    dotsEl.innerHTML = tutorialSteps.map((_, i) =>
      `<span class="tutorial-dot${i === tutorialIdx ? ' active' : ''}"></span>`
    ).join('');

    document.getElementById('tutorial-next').textContent =
      tutorialIdx < tutorialSteps.length - 1 ? 'Next' : 'Done';
    document.getElementById('tutorial-back').style.display =
      tutorialIdx > 0 ? 'inline-block' : 'none';

    switchTab(step.tab);
  }

  // ---- Developer settings ----
  let devHoldTimer = null;

  function setupDeveloper() {
    const panel = document.getElementById('dev-panel');
    const dataTab = document.getElementById('tab-data');

    function startHold(e) {
      if (devHoldTimer) return;
      dataTab.classList.add('activating');
      devHoldTimer = setTimeout(() => {
        dataTab.classList.remove('activating');
        devHoldTimer = null;
        panel.classList.toggle('open');
        updateDevPanel();
      }, 2000);
    }

    function cancelHold() {
      if (!devHoldTimer) return;
      clearTimeout(devHoldTimer);
      devHoldTimer = null;
      dataTab.classList.remove('activating');
    }

    dataTab.addEventListener('mousedown', startHold);
    dataTab.addEventListener('touchstart', startHold);
    dataTab.addEventListener('mouseup', cancelHold);
    dataTab.addEventListener('touchend', cancelHold);
    dataTab.addEventListener('mouseleave', cancelHold);
    dataTab.addEventListener('touchcancel', cancelHold);

    document.getElementById('dev-reset-intro').addEventListener('click', () => {
      localStorage.removeItem('flowly_intro_seen');
      updateDevPanel();
      showToast('Intro flag reset — will show on next load');
    });

    document.getElementById('dev-clear-data').addEventListener('click', () => {
      if (!confirm('Delete ALL period data? This cannot be undone.')) return;
      savePeriods([]);
      refreshAll();
      updateDevPanel();
      showToast('All period data cleared');
    });

    document.getElementById('dev-factory-reset').addEventListener('click', () => {
      if (!confirm('This will erase EVERYTHING — all period data, preferences, and flags. Are you sure?')) return;
      if (!confirm('Really? There is no undo.')) return;
      localStorage.clear();
      refreshAll();
      updateDevPanel();
      showToast('Factory reset complete');
    });
  }

  function updateDevPanel() {
    const seen = localStorage.getItem('flowly_intro_seen');
    document.getElementById('dev-intro-status').textContent = seen ? 'true' : 'false';
    const data = getPeriods();
    document.getElementById('dev-data-count').textContent = data.length + ' entries';
  }

  // ---- Empty states ----
  function renderEmptyStats() {
    const block = document.getElementById('next-period-block');
    block.innerHTML = `
      <div class="next-period-block" style="background:var(--bg);">
        <div style="font-size:0.85rem;color:var(--text-muted);line-height:1.6;">
          Start logging periods to see predictions and statistics here.<br>
          Flowly will calculate your average cycle length,
          average period length, and predict your next period.
        </div>
      </div>
    `;
  }

  // ---- Init ----
  async function init() {
    await initDB();

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    setupNav();
    setupForm();
    setupDataPage();
    setupDeveloper();
    setupIntro();
    switchTab('calendar');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
