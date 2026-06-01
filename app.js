(function() {
  'use strict';

  const DB_NAME = 'flowly';
  const STORE_NAME = 'periods';
  const APP_VERSION = '2.0.0';
  let dbCache = [];
  let dbReady = false;

  const ENTRY_DEFAULTS = {
    cramps: 0, flow: 0, mood: '', pain: 0,
    headaches: false, bloating: false,
    temperature: null, cervicalMucus: '',
    medications: '', tags: []
  };

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

    dbCache = all.map(p => ({ ...ENTRY_DEFAULTS, ...p }));
    dbReady = true;
    db.close();
  }

  function getPeriods() { return dbCache; }

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

  function addPeriod(startDate, endDate, extra) {
    const periods = getPeriods();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    periods.push({ id, startDate, endDate, notes: extra.notes || '', ...ENTRY_DEFAULTS, ...extra });
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

  function updatePeriod(id, startDate, endDate, extra) {
    let periods = getPeriods();
    const idx = periods.findIndex(p => p.id === id);
    if (idx === -1) return periods;
    periods[idx] = { ...periods[idx], startDate, endDate, notes: extra.notes || '', ...extra };
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

    const healthMode = localStorage.getItem('flowly_health_mode') || 'normal';
    let variance;
    if (healthMode === 'perimenopause') {
      variance = Math.max(3, Math.round(result.avgCycle * 0.2));
    } else {
      variance = Math.max(1, Math.round(result.avgCycle * 0.1));
    }

    result.nextStart = addDays(lastStart, result.avgCycle);
    result.rangeStart = addDays(lastStart, result.avgCycle - variance);
    result.rangeEnd = addDays(lastStart, result.avgCycle + variance);

    result.cycleLengths = cycleLengths;
    result.periodLengths = periodLengths;

    return result;
  }

  // ---- Health mode check ----
  function isHealthModePaused() {
    const mode = localStorage.getItem('flowly_health_mode') || 'normal';
    return mode === 'pregnancy' || mode === 'postpartum';
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

  function getFuturePredictionSets(periods) {
    const pred = getPredictions(periods);
    const loggedSet = getPeriodDateSet(periods);
    const predPeriodSet = new Set();
    const ovulationSet = new Set();
    const numCycles = 3;
    const avgCycle = pred.avgCycle || 28;
    const avgPeriod = pred.avgPeriod || 5;

    if (isHealthModePaused()) return { predPeriodSet, ovulationSet };

    let cycleStart = pred.nextStart;
    for (let c = 0; c < numCycles; c++) {
      if (!cycleStart) break;
      for (let d = 0; d < avgPeriod; d++) {
        const date = addDays(cycleStart, d);
        if (!loggedSet.has(date)) predPeriodSet.add(date);
      }
      const ovDay = addDays(cycleStart, avgCycle - 14);
      for (let d = -1; d <= 1; d++) ovulationSet.add(addDays(ovDay, d));
      cycleStart = addDays(cycleStart, avgCycle);
    }

    return { predPeriodSet, ovulationSet };
  }

  const phaseOrder = ['menstrual', 'follicular', 'ovulation', 'luteal'];

  const phaseData = {
    menstrual: {
      label: 'You are in the Menstrual Phase',
      desc: 'Your period has started. The body is shedding the uterine lining, which typically lasts 3\u20137 days.',
      mood: 'You may feel tired, low on energy, or more emotional than usual. Rest when you need to and prioritise comfort.',
      tip: 'Drink plenty of water to stay hydrated and help reduce bloating.'
    },
    follicular: {
      label: 'You are in the Follicular Phase',
      desc: 'Energy is rising as oestrogen levels increase. This phase lasts from the end of your period until ovulation.',
      mood: 'A great time for new beginnings, social activities, and creative projects. Your mood and confidence are lifting.',
      tip: 'Stay hydrated \u2014 drinking water helps keep energy levels steady.'
    },
    ovulation: {
      label: 'You are in the Ovulatory Phase',
      desc: 'The body releases an egg. This is your fertile window and typically lasts 24\u201348 hours.',
      mood: 'Confidence and energy are at their peak. You may feel more outgoing, sociable, and vibrant.',
      tip: 'Drink water throughout the day to support your body at this peak energy time.'
    },
    luteal: {
      label: 'You are in the Luteal Phase',
      desc: 'The body prepares for a potential pregnancy as progesterone rises. This phase lasts from ovulation until your next period.',
      mood: 'You might feel more introspective, irritable, or tired. Focus on self-care, relaxation, and gentle movement.',
      tip: 'Stay hydrated \u2014 water can help with bloating and keep your energy up.'
    }
  };

  function getNextPhaseKey(current) {
    const idx = phaseOrder.indexOf(current);
    if (idx === -1 || idx === phaseOrder.length - 1) return phaseOrder[0];
    return phaseOrder[idx + 1];
  }

  function getCurrentPhase(periods, pred) {
    const today = formatDate(new Date());

    for (const p of periods) {
      if (today >= p.startDate && today <= p.endDate) {
        return { phase: 'menstrual', nextPhase: getNextPhaseKey('menstrual') };
      }
    }
    if (pred.rangeStart && today >= pred.rangeStart && today <= pred.rangeEnd) {
      return { phase: 'menstrual', nextPhase: getNextPhaseKey('menstrual') };
    }

    const sorted = [...periods].sort((a, b) => b.startDate.localeCompare(a.startDate));
    let lastStart = null;
    if (sorted.length > 0 && sorted[0].startDate <= today) {
      lastStart = sorted[0].startDate;
    } else if (pred.nextStart && pred.nextStart <= today) {
      lastStart = pred.nextStart;
    }
    if (!lastStart) return null;

    const cycleDay = daysBetween(lastStart, today) + 1;
    const avgCycle = pred.avgCycle || 28;
    const avgPeriod = pred.avgPeriod || 5;
    const ovulationDay = avgCycle - 14;

    let phase;
    if (cycleDay <= avgPeriod) phase = 'menstrual';
    else if (cycleDay <= ovulationDay) phase = 'follicular';
    else if (cycleDay <= ovulationDay + 2) phase = 'ovulation';
    else phase = 'luteal';
    return { phase, nextPhase: getNextPhaseKey(phase) };
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
    if (tabId === 'log') renderLogCalendar();
    if (tabId === 'history') renderList();
    if (tabId === 'data') renderDataPage();
  }

  // ---- Tab Swipe ----
  const TAB_ORDER = ['calendar', 'log', 'history', 'data'];
  let swipeStartX = 0, swipeStartY = 0, swiping = false, swipePageX = 0;

  function setupSwipe() {
    document.querySelectorAll('.page').forEach(page => {
      page.addEventListener('touchstart', onSwipeStart, { passive: true });
      page.addEventListener('touchmove', onSwipeMove, { passive: true });
      page.addEventListener('touchend', onSwipeEnd, { passive: true });
    });
  }

  function onSwipeStart(e) {
    const target = e.target;
    if (target.closest('button') || target.closest('input') || target.closest('textarea') || target.closest('select') || target.closest('.cal-grid') || target.closest('.tab-bar')) {
      swiping = false;
      return;
    }
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
    swipePageX = 0;
    swiping = true;
  }

  function onSwipeMove(e) {
    if (!swiping) return;
    const dx = e.touches[0].clientX - swipeStartX;
    const dy = e.touches[0].clientY - swipeStartY;
    if (Math.abs(dx) < 20 || Math.abs(dx) < Math.abs(dy)) return;
    e.preventDefault();
    swipePageX = dx;
    const page = e.currentTarget;
    page.style.transition = 'none';
    page.style.transform = `translateX(${dx * 0.3}px)`;
    page.style.opacity = Math.max(0.4, 1 - Math.abs(dx) / 600);
  }

  function onSwipeEnd(e) {
    if (!swiping) return;
    swiping = false;
    const page = e.currentTarget;
    page.style.transition = '';
    page.style.transform = '';
    page.style.opacity = '';
    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;
    const dx = endX - swipeStartX;
    const dy = endY - swipeStartY;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const currentIdx = TAB_ORDER.indexOf(currentTab);
    if (currentIdx === -1) return;
    if (dx < 0 && currentIdx < TAB_ORDER.length - 1) {
      switchTab(TAB_ORDER[currentIdx + 1]);
    } else if (dx > 0 && currentIdx > 0) {
      switchTab(TAB_ORDER[currentIdx - 1]);
    }
  }

  // ---- Phase Popup ----
  function setupPhasePopup() {
    document.addEventListener('click', e => {
      if (e.target.id === 'phase-info-btn') {
        const body = document.getElementById('phase-popup-body');
        body.innerHTML = phaseOrder.map(key => {
          const d = phaseData[key];
          return `
            <div class="phase-popup-item">
              <div class="phase-popup-name">${d.label.replace('You are in the ', '')}</div>
              <div class="phase-popup-desc">${d.desc}</div>
              <div class="phase-popup-mood">${d.mood}</div>
            </div>
          `;
        }).join('');
        document.getElementById('phase-popup').classList.add('show');
      }
    });
    document.getElementById('phase-popup-close').addEventListener('click', () => {
      document.getElementById('phase-popup').classList.remove('show');
    });
  }

  // ---- Calendar ----
  let viewDate = new Date();
  let editingId = null;
  let dragStart = null;
  let dragEnd = null;
  let isDragging = false;

  function getGrid() { return document.getElementById('cal-grid'); }

  function renderCalendar() {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();

    const userName = localStorage.getItem('flowly_user_name');
    const healthMode = localStorage.getItem('flowly_health_mode') || '';
    let heading = userName ? `Welcome back, ${userName}` : 'Your Period Calendar';
    if (healthMode === 'pregnancy') heading += ' \u{1F476}';
    else if (healthMode === 'postpartum') heading += ' \u{1F37C}';
    document.getElementById('cal-heading').textContent = heading;

    document.getElementById('month-label').textContent =
      viewDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    const periods = getPeriods();
    const periodSet = getPeriodDateSet(periods);
    const pred = getPredictions(periods);
    const future = getFuturePredictionSets(periods);
    const phase = getCurrentPhase(periods, pred);

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrev = new Date(year, month, 0).getDate();
    const today = new Date();

    const startOffset = firstDay === 0 ? 6 : firstDay - 1;

    const grid = getGrid();
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
      else if (future.predPeriodSet.has(dateStr)) cls += ' predicted';
      if (future.ovulationSet.has(dateStr)) cls += ' ovulation';

      const el = document.createElement('div');
      el.className = cls;
      el.textContent = day;
      el.dataset.date = dateStr;
      grid.appendChild(el);
    }

    const healthModePaused = isHealthModePaused();

    // Phase info
    const phaseEl = document.getElementById('phase-info');
    if (phase && periods.length > 0 && !healthModePaused) {
      const data = phaseData[phase.phase];
      const nextData = phaseData[phase.nextPhase];
      phaseEl.style.display = '';
      phaseEl.className = 'card phase-card';
      phaseEl.innerHTML = `
        <div class="phase-name">${data.label}</div>
        <div class="phase-body">${data.desc}</div>
        <div class="phase-body mood">${data.mood}</div>
        <div class="phase-tip">${data.tip}</div>
        <div class="phase-next">Next: ${nextData.label.replace('You are in the ', '')}</div>
        <button class="phase-info-btn" id="phase-info-btn">Learn more about all phases</button>
      `;
    } else if (healthModePaused) {
      const modeLabel = { pregnancy: 'Pregnancy', postpartum: 'Postpartum' }[healthMode] || 'Paused';
      phaseEl.style.display = '';
      phaseEl.className = 'card phase-card';
      phaseEl.innerHTML = `
        <div class="phase-name">${modeLabel} Mode Active</div>
        <div class="phase-body">Cycle predictions are paused while you track in ${modeLabel.toLowerCase()} mode. You can change this in the <strong>Data</strong> tab.</div>
      `;
    } else {
      phaseEl.style.display = 'none';
    }

    // Calendar stats
    const statsEl = document.getElementById('calendar-stats');
    if (periods.length > 0) {
      statsEl.style.display = '';
      const today = formatDate(new Date());
      let nextBlock = '';
      if (pred.nextStart && !healthModePaused) {
        const daysUntil = daysBetween(today, pred.nextStart);
        let daysText = '';
        if (daysUntil > 0) daysText = `(${daysUntil} day${daysUntil !== 1 ? 's' : ''} away)`;
        else if (daysUntil === 0) daysText = '(expected today)';
        else daysText = `(${Math.abs(daysUntil)} day${Math.abs(daysUntil) !== 1 ? 's' : ''} ago)`;
        nextBlock = `
          <div class="cal-stat-next">Next period ~ ${formatDisplay(pred.nextStart)} ${daysText}</div>
        `;
      }
      statsEl.innerHTML = `
        <div class="cal-stats-grid">
          <div class="cal-stat"><span class="cal-stat-val">${pred.avgCycle ? pred.avgCycle + 'd' : '--'}</span><span class="cal-stat-lbl">Avg Cycle</span></div>
          <div class="cal-stat"><span class="cal-stat-val">${pred.avgPeriod ? pred.avgPeriod + 'd' : '--'}</span><span class="cal-stat-lbl">Avg Period</span></div>
          <div class="cal-stat"><span class="cal-stat-val">${periods.length}</span><span class="cal-stat-lbl">Logged</span></div>
        </div>
        ${nextBlock}
      `;
    } else {
      statsEl.style.display = 'none';
    }
  }

  function onGridPointerDown(e) {
    const cell = e.target.closest('.day');
    if (!cell) return;
    e.preventDefault();
    const dateStr = cell.dataset.date;
    dragStart = dateStr;
    dragEnd = dateStr;
    isDragging = true;
    cell.classList.add('selecting');
    getGrid().setPointerCapture(e.pointerId);
    getGrid().addEventListener('pointermove', onGridPointerMove);
    getGrid().addEventListener('pointerup', onGridPointerUp);
    getGrid().addEventListener('pointercancel', onGridPointerCancel);
  }

  function onGridPointerMove(e) {
    if (!isDragging) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest('.day');
    if (!cell) return;
    const dateStr = cell.dataset.date;
    if (dateStr !== dragEnd) {
      dragEnd = dateStr;
      updateDragSelection();
    }
  }

  function onGridPointerUp() {
    if (!isDragging) return;
    const start = dragStart < dragEnd ? dragStart : dragEnd;
    const end = dragStart < dragEnd ? dragEnd : dragStart;
    document.getElementById('start-date').value = start;
    document.getElementById('end-date').value = end;
    cleanupDrag();
    switchTab('log');
  }

  function onGridPointerCancel() { cleanupDrag(); }

  function updateDragSelection() {
    getGrid().querySelectorAll('.day.selecting').forEach(el => el.classList.remove('selecting'));
    if (!dragStart || !dragEnd) return;
    const start = dragStart < dragEnd ? dragStart : dragEnd;
    const end = dragStart < dragEnd ? dragEnd : dragStart;
    getGrid().querySelectorAll('.day').forEach(el => {
      if (el.dataset.date >= start && el.dataset.date <= end) {
        el.classList.add('selecting');
      }
    });
  }

  function cleanupDrag() {
    isDragging = false;
    dragStart = null;
    dragEnd = null;
    const grid = getGrid();
    grid.querySelectorAll('.day.selecting').forEach(el => el.classList.remove('selecting'));
    grid.removeEventListener('pointermove', onGridPointerMove);
    grid.removeEventListener('pointerup', onGridPointerUp);
    grid.removeEventListener('pointercancel', onGridPointerCancel);
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
      const symParts = [];
      if (p.cramps > 0) symParts.push(['cramps', ['None','Mild','Moderate','Severe'][p.cramps]]);
      if (p.flow > 0) symParts.push(['flow', ['Light','Medium','Heavy','Very Heavy'][p.flow]]);
      if (p.pain > 0) symParts.push(['pain', p.pain]);
      if (p.headaches) symParts.push(['headaches']);
      if (p.bloating) symParts.push(['bloating']);
      if (p.mood) symParts.push(['mood', p.mood]);
      const symHtml = symParts.length > 0
        ? '<div class="symptoms-summary">' + symParts.map(s => `<span class="sym-badge">${s[1] ? s[0] + ': ' + s[1] : s[0]}</span>`).join('') + '</div>'
        : '';
      const tagsHtml = p.tags && p.tags.length > 0
        ? '<div class="symptoms-summary">' + p.tags.map(t => `<span class="sym-badge" style="background:var(--tag-bg);color:var(--tag-color);">${escapeHtml(t)}</span>`).join('') + '</div>'
        : '';

      return `
        <div class="period-entry">
          <div>
            <div class="dates">
              <strong>${formatDisplay(p.startDate)}</strong> – ${formatDisplay(p.endDate)}
              <span style="color:var(--text-muted);font-size:0.75rem;"> (${periodLen}d)</span>
            </div>
            ${p.notes ? `<div class="notes">${escapeHtml(p.notes)}</div>` : ''}
            ${symHtml}
            ${tagsHtml}
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
        populateEditForm(p);
      });
    });
  }

  function populateEditForm(p) {
    editingId = p.id;
    document.getElementById('start-date').value = p.startDate;
    document.getElementById('end-date').value = p.endDate;
    document.getElementById('notes').value = p.notes;
    document.getElementById('save-btn').textContent = 'Update';
    document.getElementById('cancel-edit').style.display = 'inline-block';

    setBtnGroupValue('cramps-group', p.cramps);
    setBtnGroupValue('flow-group', p.flow);
    document.getElementById('mood-select').value = p.mood || '';
    document.getElementById('pain-slider').value = p.pain || 0;
    document.getElementById('pain-value').textContent = p.pain || 0;
    document.getElementById('symptom-headaches').checked = p.headaches || false;
    document.getElementById('symptom-bloating').checked = p.bloating || false;
    document.getElementById('temperature').value = p.temperature || '';
    document.getElementById('cervical-mucus').value = p.cervicalMucus || '';
    document.getElementById('medications').value = p.medications || '';
    renderTagsSelector(p.tags || []);
    switchTab('log');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---- Log Calendar Preview ----
  let logCalView = null;

  function renderLogCalendar() {
    const start = document.getElementById('start-date').value;
    const end = document.getElementById('end-date').value;
    const container = document.getElementById('log-cal-preview');

    if (!start || !end) { container.classList.remove('show'); return; }

    if (!logCalView) logCalView = parseDate(start);

    const rangeStart = start;
    const rangeEnd = end;
    const today = formatDate(new Date());
    const year = logCalView.getFullYear();
    const month = logCalView.getMonth();

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startOffset = firstDay === 0 ? 6 : firstDay - 1;

    let html = '<div class="log-cal-nav">';
    html += `<button class="log-cal-arrow" id="log-cal-prev">\u2039</button>`;
    html += `<span class="log-cal-month">${logCalView.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>`;
    html += `<button class="log-cal-arrow" id="log-cal-next">\u203A</button>`;
    html += '</div><div class="log-cal-grid">';
    html += '<span class="lc-day-name">M</span><span class="lc-day-name">T</span><span class="lc-day-name">W</span><span class="lc-day-name">T</span><span class="lc-day-name">F</span><span class="lc-day-name">S</span><span class="lc-day-name">S</span>';

    for (let i = 0; i < startOffset; i++) {
      html += '<span class="lc-day"></span>';
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = formatDate(new Date(year, month, d));
      let cls = 'lc-day';
      if (dateStr === today) cls += ' today';
      if (dateStr >= rangeStart && dateStr <= rangeEnd) {
        cls += ' in-range';
        if (dateStr === rangeStart && dateStr === rangeEnd) cls += ' range-single';
        else if (dateStr === rangeStart) cls += ' range-start';
        else if (dateStr === rangeEnd) cls += ' range-end';
      }
      html += `<span class="${cls}">${d}</span>`;
    }

    html += '</div>';
    container.innerHTML = html;
    container.classList.add('show');

    document.getElementById('log-cal-prev').addEventListener('click', () => {
      logCalView.setMonth(logCalView.getMonth() - 1);
      renderLogCalendar();
    });
    document.getElementById('log-cal-next').addEventListener('click', () => {
      logCalView.setMonth(logCalView.getMonth() + 1);
      renderLogCalendar();
    });
  }

  // ---- Button group helpers ----
  function getBtnGroupValue(groupId) {
    const active = document.querySelector(`#${groupId} .btn-option.active`);
    return active ? parseInt(active.dataset.value) : 0;
  }

  function setBtnGroupValue(groupId, value) {
    document.querySelectorAll(`#${groupId} .btn-option`).forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === String(value));
    });
  }

  function setupBtnGroups() {
    document.querySelectorAll('.btn-group').forEach(group => {
      group.addEventListener('click', e => {
        const btn = e.target.closest('.btn-option');
        if (!btn) return;
        group.querySelectorAll('.btn-option').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  // ---- Tags selector in form ----
  let selectedTags = [];

  function renderTagsSelector(selected) {
    selectedTags = selected || [];
    const container = document.getElementById('tags-selector');
    const customTags = getCustomTags();
    if (customTags.length === 0) {
      container.innerHTML = '<span class="tag-chip empty-tags">Add tags in the Data tab</span>';
      return;
    }
    container.innerHTML = customTags.map(t => `
      <span class="tag-chip${selectedTags.includes(t) ? ' selected' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>
    `).join('');
    container.querySelectorAll('.tag-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const tag = chip.dataset.tag;
        const idx = selectedTags.indexOf(tag);
        if (idx === -1) selectedTags.push(tag);
        else selectedTags.splice(idx, 1);
        renderTagsSelector(selectedTags);
      });
    });
  }

  // ---- Form ----
  function setupForm() {
    document.getElementById('start-date').addEventListener('change', renderLogCalendar);
    document.getElementById('end-date').addEventListener('change', renderLogCalendar);

    document.getElementById('pain-slider').addEventListener('input', () => {
      const val = document.getElementById('pain-slider').value;
      document.getElementById('pain-value').textContent = val;
    });

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

      const extra = {
        notes,
        cramps: getBtnGroupValue('cramps-group'),
        flow: getBtnGroupValue('flow-group'),
        mood: document.getElementById('mood-select').value,
        pain: parseInt(document.getElementById('pain-slider').value),
        headaches: document.getElementById('symptom-headaches').checked,
        bloating: document.getElementById('symptom-bloating').checked,
        temperature: document.getElementById('temperature').value ? parseFloat(document.getElementById('temperature').value) : null,
        cervicalMucus: document.getElementById('cervical-mucus').value,
        medications: document.getElementById('medications').value,
        tags: [...selectedTags]
      };

      if (editingId) {
        updatePeriod(editingId, start, end, extra);
        showToast('Period updated');
        cancelEdit();
      } else {
        addPeriod(start, end, extra);
        showToast('Period saved');
      }

      form.reset();
      const today = formatDate(new Date());
      document.getElementById('start-date').value = today;
      document.getElementById('end-date').value = today;
      setBtnGroupValue('cramps-group', 0);
      setBtnGroupValue('flow-group', 0);
      renderTagsSelector([]);
      refreshAll();
      renderLogCalendar();
    });

    document.getElementById('cancel-edit').addEventListener('click', cancelEdit);

    const today = formatDate(new Date());
    document.getElementById('start-date').value = today;
    document.getElementById('end-date').value = today;
    renderLogCalendar();
  }

  function cancelEdit() {
    editingId = null;
    document.getElementById('save-btn').textContent = 'Save';
    document.getElementById('cancel-edit').style.display = 'none';
    document.getElementById('period-form').reset();
    const today = formatDate(new Date());
    document.getElementById('start-date').value = today;
    document.getElementById('end-date').value = today;
    setBtnGroupValue('cramps-group', 0);
    setBtnGroupValue('flow-group', 0);
    renderTagsSelector([]);
    renderLogCalendar();
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

  // ---- Dark mode ----
  function setupDarkMode() {
    const saved = localStorage.getItem('flowly_dark_mode');
    if (saved === 'true') {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.getElementById('dark-mode-toggle').checked = true;
    }
    document.getElementById('dark-mode-toggle').addEventListener('change', function() {
      if (this.checked) {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('flowly_dark_mode', 'true');
      } else {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('flowly_dark_mode', 'false');
      }
    });
  }

  // ---- PIN Lock ----
  function setupPIN() {
    const pinHash = localStorage.getItem('flowly_pin_hash');
    const overlay = document.getElementById('pin-overlay');
    const input = document.getElementById('pin-unlock-input');
    const error = document.getElementById('pin-error');
    const unlockBtn = document.getElementById('pin-unlock-btn');

    if (pinHash) {
      overlay.classList.add('show');
      setTimeout(() => input.focus(), 300);
      input.addEventListener('keydown', function handler(e) {
        if (e.key === 'Enter') tryUnlock();
      });
      unlockBtn.addEventListener('click', tryUnlock);
    }

    function tryUnlock() {
      const val = input.value.trim();
      if (!val) return;
      if (hashPIN(val) === pinHash) {
        overlay.classList.remove('show');
        input.value = '';
        error.style.display = 'none';
      } else {
        error.style.display = 'block';
        input.value = '';
        input.focus();
      }
    }

    updatePINSection();
  }

  function hashPIN(pin) {
    let hash = 0;
    for (let i = 0; i < pin.length; i++) {
      const char = pin.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return 'h' + Math.abs(hash).toString(36);
  }

  function updatePINSection() {
    const pinHash = localStorage.getItem('flowly_pin_hash');
    const setup = document.getElementById('pin-setup');
    const change = document.getElementById('pin-change');
    const status = document.getElementById('pin-status');

    if (pinHash) {
      setup.style.display = 'none';
      change.style.display = 'block';
      status.textContent = 'PIN is set.';
    } else {
      setup.style.display = 'block';
      change.style.display = 'none';
      status.textContent = 'No PIN set.';
    }
  }

  function setupPINHandlers() {
    document.getElementById('pin-set-btn').addEventListener('click', () => {
      const pin = document.getElementById('pin-input').value.trim();
      if (!pin || pin.length < 3) {
        showToast('PIN must be at least 3 digits');
        return;
      }
      localStorage.setItem('flowly_pin_hash', hashPIN(pin));
      document.getElementById('pin-input').value = '';
      updatePINSection();
      showToast('PIN set');
    });

    document.getElementById('pin-change-btn').addEventListener('click', () => {
      const old = document.getElementById('pin-old-input').value.trim();
      const next = document.getElementById('pin-new-input').value.trim();
      if (hashPIN(old) !== localStorage.getItem('flowly_pin_hash')) {
        showToast('Current PIN is incorrect');
        return;
      }
      if (!next || next.length < 3) {
        showToast('New PIN must be at least 3 digits');
        return;
      }
      localStorage.setItem('flowly_pin_hash', hashPIN(next));
      document.getElementById('pin-old-input').value = '';
      document.getElementById('pin-new-input').value = '';
      showToast('PIN changed');
    });

    document.getElementById('pin-remove-btn').addEventListener('click', () => {
      const old = document.getElementById('pin-old-input').value.trim();
      if (hashPIN(old) !== localStorage.getItem('flowly_pin_hash')) {
        showToast('Current PIN is incorrect');
        return;
      }
      if (!confirm('Remove PIN lock?')) return;
      localStorage.removeItem('flowly_pin_hash');
      document.getElementById('pin-old-input').value = '';
      document.getElementById('pin-new-input').value = '';
      updatePINSection();
      showToast('PIN removed');
    });
  }

  // ---- Health mode ----
  function setupHealthMode() {
    const saved = localStorage.getItem('flowly_health_mode') || 'normal';
    document.querySelector(`input[name="health-mode"][value="${saved}"]`).checked = true;
    toggleHealthFields(saved);

    document.querySelectorAll('input[name="health-mode"]').forEach(radio => {
      radio.addEventListener('change', () => {
        if (radio.checked) {
          const mode = radio.value;
          localStorage.setItem('flowly_health_mode', mode);
          toggleHealthFields(mode);
          showToast('Health mode: ' + mode.charAt(0).toUpperCase() + mode.slice(1));
          refreshAll();
        }
      });
    });

    // Load saved pregnancy data
    const pregData = JSON.parse(localStorage.getItem('flowly_pregnancy_data') || '{}');
    if (pregData.dueDate) document.getElementById('pregnancy-due-date').value = pregData.dueDate;
    if (pregData.weeks) document.getElementById('pregnancy-weeks').value = pregData.weeks;

    const ppData = JSON.parse(localStorage.getItem('flowly_postpartum_data') || '{}');
    if (ppData.birthDate) document.getElementById('postpartum-birth-date').value = ppData.birthDate;

    document.getElementById('pregnancy-save').addEventListener('click', () => {
      const dueDate = document.getElementById('pregnancy-due-date').value;
      const weeks = document.getElementById('pregnancy-weeks').value;
      localStorage.setItem('flowly_pregnancy_data', JSON.stringify({ dueDate, weeks: weeks ? parseInt(weeks) : null }));
      showToast('Pregnancy data saved');
    });

    document.getElementById('postpartum-save').addEventListener('click', () => {
      const birthDate = document.getElementById('postpartum-birth-date').value;
      localStorage.setItem('flowly_postpartum_data', JSON.stringify({ birthDate }));
      showToast('Postpartum data saved');
    });
  }

  function toggleHealthFields(mode) {
    document.getElementById('pregnancy-fields').style.display = mode === 'pregnancy' ? 'block' : 'none';
    document.getElementById('postpartum-fields').style.display = mode === 'postpartum' ? 'block' : 'none';
    document.getElementById('perimenopause-fields').style.display = mode === 'perimenopause' ? 'block' : 'none';
  }

  // ---- Custom tags ----
  function getCustomTags() {
    try {
      return JSON.parse(localStorage.getItem('flowly_custom_tags') || '[]');
    } catch { return []; }
  }

  function saveCustomTags(tags) {
    localStorage.setItem('flowly_custom_tags', JSON.stringify(tags));
  }

  function renderCustomTagsList() {
    const container = document.getElementById('custom-tags-list');
    const tags = getCustomTags();
    if (tags.length === 0) {
      container.innerHTML = '<span style="font-size:0.78rem;color:var(--text-muted);">No custom tags yet.</span>';
      return;
    }
    container.innerHTML = tags.map(t => `
      <span class="custom-tag-item">${escapeHtml(t)} <button class="tag-remove" data-tag="${escapeHtml(t)}">&times;</button></span>
    `).join('');
    container.querySelectorAll('.tag-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const tag = btn.dataset.tag;
        let tags = getCustomTags();
        tags = tags.filter(t => t !== tag);
        saveCustomTags(tags);
        renderCustomTagsList();
        renderTagsSelector(selectedTags);
        showToast('Tag removed');
      });
    });
  }

  function setupCustomTags() {
    renderCustomTagsList();
    document.getElementById('add-tag-btn').addEventListener('click', () => {
      const input = document.getElementById('new-tag-input');
      const tag = input.value.trim();
      if (!tag) { showToast('Enter a tag name'); return; }
      let tags = getCustomTags();
      if (tags.includes(tag)) { showToast('Tag already exists'); return; }
      tags.push(tag);
      saveCustomTags(tags);
      input.value = '';
      renderCustomTagsList();
      renderTagsSelector(selectedTags);
      showToast('Tag added');
    });
    document.getElementById('new-tag-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('add-tag-btn').click();
    });
  }

  // ---- Statistics ----
  function computeStats(periods) {
    if (periods.length === 0) return null;
    const sorted = [...periods].sort((a, b) => a.startDate.localeCompare(b.startDate));
    const periodLengths = sorted.map(p => daysBetween(p.startDate, p.endDate) + 1);
    const cycleLengths = [];
    for (let i = 1; i < sorted.length; i++) {
      cycleLengths.push(daysBetween(sorted[i - 1].startDate, sorted[i].startDate));
    }

    const avgPeriod = Math.round(periodLengths.reduce((a, b) => a + b, 0) / periodLengths.length);
    const minPeriod = Math.min(...periodLengths);
    const maxPeriod = Math.max(...periodLengths);

    let avgCycle = null, minCycle = null, maxCycle = null, mostCommonCycle = null;
    if (cycleLengths.length > 0) {
      avgCycle = Math.round(cycleLengths.reduce((a, b) => a + b, 0) / cycleLengths.length);
      minCycle = Math.min(...cycleLengths);
      maxCycle = Math.max(...cycleLengths);
      const freq = {};
      cycleLengths.forEach(c => { freq[c] = (freq[c] || 0) + 1; });
      mostCommonCycle = parseInt(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
    }

    return { total: periods.length, avgPeriod, minPeriod, maxPeriod, avgCycle, minCycle, maxCycle, mostCommonCycle, cycleLengths, periodLengths };
  }

  function renderStatistics(periods) {
    const container = document.getElementById('stats-display');
    const stats = computeStats(periods);
    if (!stats) {
      container.innerHTML = '<p style="font-size:0.82rem;color:var(--text-muted);">Log some periods to see your cycle statistics and trends.</p>';
      return;
    }

    container.innerHTML = `
      <div class="stats-grid">
        <div class="stat-box"><span class="stat-value">${stats.total}</span><span class="stat-label">Total Periods</span></div>
        <div class="stat-box"><span class="stat-value">${stats.avgCycle !== null ? stats.avgCycle + 'd' : '--'}</span><span class="stat-label">Avg Cycle</span><span class="stat-sub">${stats.minCycle !== null ? 'Min: ' + stats.minCycle + 'd / Max: ' + stats.maxCycle + 'd' : ''}</span></div>
        <div class="stat-box"><span class="stat-value">${stats.avgPeriod + 'd'}</span><span class="stat-label">Avg Period</span><span class="stat-sub">Min: ${stats.minPeriod}d / Max: ${stats.maxPeriod}d</span></div>
        <div class="stat-box"><span class="stat-value">${stats.mostCommonCycle !== null ? stats.mostCommonCycle + 'd' : '--'}</span><span class="stat-label">Most Common Cycle</span></div>
      </div>
    `;
  }

  // ---- Charts ----
  function renderCharts(periods) {
    const container = document.getElementById('chart-container');
    const stats = computeStats(periods);
    if (!stats || stats.cycleLengths.length < 1) {
      container.innerHTML = '';
      return;
    }

    const CHART_W = 280, CHART_H = 120, BAR_W = 20, GAP = 4;
    let html = '';

    // Cycle length chart
    const cyclesToShow = stats.cycleLengths.slice(-12);
    const maxCycle = Math.max(...cyclesToShow, 35);
    html += '<div class="chart-container"><div class="chart-title">Cycle Length Trend (last ' + cyclesToShow.length + ')</div>';
    html += '<svg viewBox="0 0 ' + CHART_W + ' ' + CHART_H + '" class="chart-svg">';
    cyclesToShow.forEach((cl, i) => {
      const x = 10 + i * (BAR_W + GAP);
      const barH = Math.max(4, (cl / maxCycle) * (CHART_H - 30));
      const y = CHART_H - 10 - barH;
      html += `<rect class="chart-bar-rect" x="${x}" y="${y}" width="${BAR_W}" height="${barH}" rx="2" data-value="${cl}d"/>`;
      html += `<text class="chart-value-label" x="${x + BAR_W / 2}" y="${CHART_H - 2}">${cl}</text>`;
    });
    html += '</svg></div>';

    // Period length chart
    const periodsToShow = stats.periodLengths.slice(-12);
    const maxPeriod = Math.max(...periodsToShow, 5);
    html += '<div class="chart-container"><div class="chart-title">Period Length Trend (last ' + periodsToShow.length + ')</div>';
    html += '<svg viewBox="0 0 ' + CHART_W + ' ' + CHART_H + '" class="chart-svg">';
    periodsToShow.forEach((pl, i) => {
      const x = 10 + i * (BAR_W + GAP);
      const barH = Math.max(4, (pl / maxPeriod) * (CHART_H - 30));
      const y = CHART_H - 10 - barH;
      html += `<rect class="chart-bar-rect" x="${x}" y="${y}" width="${BAR_W}" height="${barH}" rx="2" data-value="${pl}d"/>`;
      html += `<text class="chart-value-label" x="${x + BAR_W / 2}" y="${CHART_H - 2}">${pl}</text>`;
    });
    html += '</svg></div>';

    container.innerHTML = html;
  }

  // ---- Symptom insights ----
  function renderSymptomInsights(periods) {
    const container = document.getElementById('symptom-insights');
    const withSymptoms = periods.filter(p => p.cramps > 0 || p.pain > 0 || p.headaches || p.bloating || p.mood);

    if (withSymptoms.length === 0) {
      container.innerHTML = '<p style="font-size:0.82rem;color:var(--text-muted);">Log periods with symptoms to see patterns and insights here.</p>';
      return;
    }

    const insights = [];

    const totalWithSym = withSymptoms.length;
    const crampCount = withSymptoms.filter(p => p.cramps > 0).length;
    if (crampCount > 0) {
      const pct = Math.round(crampCount / totalWithSym * 100);
      const avgCramp = Math.round(withSymptoms.filter(p => p.cramps > 0).reduce((s, p) => s + p.cramps, 0) / crampCount);
      insights.push(`Cramps reported in <strong>${pct}%</strong> of logged periods (avg severity: ${['','Mild','Moderate','Severe'][avgCramp]}).`);
    }

    const headacheCount = withSymptoms.filter(p => p.headaches).length;
    if (headacheCount > 0) {
      const pct = Math.round(headacheCount / totalWithSym * 100);
      insights.push(`Headaches reported in <strong>${pct}%</strong> of logged periods.`);
    }

    const bloatCount = withSymptoms.filter(p => p.bloating).length;
    if (bloatCount > 0) {
      const pct = Math.round(bloatCount / totalWithSym * 100);
      insights.push(`Bloating reported in <strong>${pct}%</strong> of logged periods.`);
    }

    const moods = withSymptoms.filter(p => p.mood).map(p => p.mood);
    if (moods.length > 0) {
      const freq = {};
      moods.forEach(m => { freq[m] = (freq[m] || 0) + 1; });
      const topMood = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
      const moodPct = Math.round(freq[topMood] / moods.length * 100);
      insights.push(`Most common mood: <strong>${topMood}</strong> (${moodPct}% of logged moods).`);
    }

    const painLevels = withSymptoms.filter(p => p.pain > 0).map(p => p.pain);
    if (painLevels.length > 0) {
      const avgPain = (painLevels.reduce((a, b) => a + b, 0) / painLevels.length).toFixed(1);
      insights.push(`Average pain level: <strong>${avgPain}/10</strong> across ${painLevels.length} entries.`);
    }

    if (insights.length === 0) {
      container.innerHTML = '<p style="font-size:0.82rem;color:var(--text-muted);">Log more symptoms to generate insights.</p>';
      return;
    }

    container.innerHTML = insights.map(text =>
      `<div class="insight-card"><div class="insight-body">${text}</div></div>`
    ).join('');
  }

  // ---- Reminders ----
  function setupReminders() {
    const saved = localStorage.getItem('flowly_reminders_enabled') === 'true';
    document.getElementById('reminders-toggle').checked = saved;
    document.getElementById('reminder-days-row').style.display = saved ? 'flex' : 'none';

    const savedDays = localStorage.getItem('flowly_reminder_days') || '3';
    document.getElementById('reminder-days').value = savedDays;

    document.getElementById('reminders-toggle').addEventListener('change', function() {
      localStorage.setItem('flowly_reminders_enabled', this.checked ? 'true' : 'false');
      document.getElementById('reminder-days-row').style.display = this.checked ? 'flex' : 'none';
      if (this.checked) requestNotificationPermission();
    });

    document.getElementById('reminder-days').addEventListener('change', function() {
      localStorage.setItem('flowly_reminder_days', this.value);
    });
  }

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function checkReminder() {
    const enabled = localStorage.getItem('flowly_reminders_enabled') === 'true';
    if (!enabled) return;
    const daysBefore = parseInt(localStorage.getItem('flowly_reminder_days') || '3');
    if (isHealthModePaused()) return;

    const periods = getPeriods();
    const pred = getPredictions(periods);
    if (!pred.nextStart) return;

    const today = formatDate(new Date());
    const daysUntil = daysBetween(today, pred.nextStart);

    if (daysUntil >= 0 && daysUntil <= daysBefore) {
      const msg = `Your period is expected ${daysUntil === 0 ? 'today' : 'in ' + daysUntil + ' days'} (around ${formatDisplay(pred.nextStart)}).`;
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Flowly Reminder', { body: msg, icon: 'icon-192.png' });
      }
      showToast(msg);
    }
  }

  // ---- Data retention ----
  function setupDataRetention() {
    const saved = localStorage.getItem('flowly_retention_months') || '0';
    document.getElementById('retention-select').value = saved;

    if (saved !== '0') {
      const count = applyRetention(parseInt(saved), true);
      if (count > 0) {
        refreshAll();
        showToast(`Auto-removed ${count} old entr${count === 1 ? 'y' : 'ies'}`);
      }
    }

    document.getElementById('retention-apply-btn').addEventListener('click', () => {
      const months = parseInt(document.getElementById('retention-select').value);
      localStorage.setItem('flowly_retention_months', String(months));
      if (months === 0) {
        document.getElementById('retention-status').textContent = 'All data kept indefinitely.';
        showToast('Retention: keep forever');
        return;
      }
      const count = applyRetention(months);
      document.getElementById('retention-status').textContent = `Removed ${count} entr${count === 1 ? 'y' : 'ies'} older than ${months} months.`;
      refreshAll();
      showToast(`Retention applied: removed ${count} entr${count === 1 ? 'y' : 'ies'}`);
    });
  }

  function applyRetention(months, silent) {
    if (months <= 0) return 0;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffStr = formatDate(cutoff);
    let periods = getPeriods();
    const before = periods.length;
    periods = periods.filter(p => p.startDate >= cutoffStr);
    if (periods.length !== before) {
      savePeriods(periods);
    }
    const removed = before - periods.length;
    if (!silent && removed > 0) {
      document.getElementById('retention-status').textContent = `Removed ${removed} entr${removed === 1 ? 'y' : 'ies'} older than ${months} months.`;
    } else if (!silent) {
      document.getElementById('retention-status').textContent = `No entries older than ${months} months found.`;
    }
    return removed;
  }

  // ---- Export: CSV ----
  function exportCSV() {
    const periods = getPeriods();
    if (periods.length === 0) { showToast('No data to export'); return; }
    const headers = ['id','startDate','endDate','notes','cramps','flow','mood','pain','headaches','bloating','temperature','cervicalMucus','medications','tags'];
    const rows = periods.map(p => {
      const tags = (p.tags || []).join(';');
      return [p.id, p.startDate, p.endDate, '"' + (p.notes || '').replace(/"/g, '""') + '"', p.cramps, p.flow, p.mood, p.pain, p.headaches, p.bloating, p.temperature || '', p.cervicalMucus, '"' + (p.medications || '').replace(/"/g, '""') + '"', '"' + tags + '"'].join(',');
    });
    const csv = '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
    downloadBlob(csv, 'flowly-export.csv', 'text/csv;charset=utf-8');
    showToast('Downloaded CSV (' + periods.length + ' entries)');
  }

  // ---- Export: iCal ----
  function exportICal() {
    const periods = getPeriods();
    if (periods.length === 0) { showToast('No data to export'); return; }

    const pred = getPredictions(periods);
    let lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Flowly//Period Tracker//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Flowly Periods'
    ];

    periods.forEach(p => {
      const start = p.startDate.replace(/-/g, '');
      const end = addDays(p.endDate, 1).replace(/-/g, '');
      const now = formatDate(new Date()).replace(/-/g, '');
      const uid = p.id + '@flowly';
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + uid);
      lines.push('DTSTART;VALUE=DATE:' + start);
      lines.push('DTEND;VALUE=DATE:' + end);
      lines.push('SUMMARY:Period');
      if (p.notes) lines.push('DESCRIPTION:' + p.notes.replace(/\n/g, '\\n'));
      lines.push('DTSTAMP:' + now + 'T000000Z');
      lines.push('END:VEVENT');
    });

    if (pred.nextStart && !isHealthModePaused()) {
      // Add predicted periods
      const numCycles = 3;
      const avgCycle = pred.avgCycle || 28;
      const avgPeriod = pred.avgPeriod || 5;
      let cycleStart = pred.nextStart;
      for (let c = 0; c < numCycles; c++) {
        if (!cycleStart) break;
        const start = cycleStart.replace(/-/g, '');
        const endDate = addDays(cycleStart, avgPeriod);
        const end = endDate.replace(/-/g, '');
        const uid = 'pred-' + c + '-' + start + '@flowly';
        const now = formatDate(new Date()).replace(/-/g, '');
        lines.push('BEGIN:VEVENT');
        lines.push('UID:' + uid);
        lines.push('DTSTART;VALUE=DATE:' + start);
        lines.push('DTEND;VALUE=DATE:' + end);
        lines.push('SUMMARY:Predicted Period');
        lines.push('DTSTAMP:' + now + 'T000000Z');
        lines.push('END:VEVENT');
        cycleStart = addDays(cycleStart, avgCycle);
      }
    }

    lines.push('END:VCALENDAR');
    const ics = lines.join('\r\n');
    downloadBlob(ics, 'flowly-calendar.ics', 'text/calendar;charset=utf-8');
    showToast('Downloaded iCal (' + periods.length + ' events)');
  }

  function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- Data page ----
  function renderDataPage() {
    const periods = getPeriods();
    renderStatistics(periods);
    renderCharts(periods);
    renderSymptomInsights(periods);
    renderCustomTagsList();
    updatePINSection();
  }

  // ---- Setup data page handlers ----
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
      downloadBlob(json, 'flowly-backup-' + formatDate(new Date()) + '.json', 'application/json');
      showToast('Downloaded ' + data.length + ' entries');
    });

    document.getElementById('download-csv').addEventListener('click', exportCSV);
    document.getElementById('download-ical').addEventListener('click', exportICal);

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
        const cleaned = data.map(p => ({ ...ENTRY_DEFAULTS, ...p }));
        savePeriods(cleaned);
        document.getElementById('import-text').value = '';
        refreshAll();
        renderDataPage();
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

  // ---- PWA Install ----
  let installPrompt = null;
  let installPromptConsumed = false;

  function setupInstall() {
    const section = document.getElementById('install-section');
    const btn = document.getElementById('install-btn');
    const btnText = document.getElementById('install-btn-text');
    const iosHint = document.getElementById('ios-install-hint');
    const androidHint = document.getElementById('android-install-hint');
    const successMsg = document.getElementById('install-success');
    const desc = document.getElementById('install-desc');

    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches;

    // Already installed as PWA
    if (isStandalone) {
      desc.textContent = 'Flowly is already installed on your device.';
      btn.style.display = 'none';
      return;
    }

    // iOS — always show instructions
    if (isIOS) {
      btn.style.display = 'none';
      iosHint.style.display = '';
      return;
    }

    // Listen for the beforeinstallprompt event
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installPrompt = e;
      installPromptConsumed = false;
      btn.style.display = '';
      androidHint.style.display = 'none';
      btnText.textContent = 'Install App';
      btn.disabled = false;
    });

    function showAndroidInstructions() {
      btnText.textContent = 'Installation Instructions';
      androidHint.style.display = '';
      desc.textContent = 'Add Flowly to your home screen for a faster, offline-ready experience.';
    }

    btn.addEventListener('click', async () => {
      // If we have a live beforeinstallprompt, use it
      if (installPrompt && !installPromptConsumed) {
        installPrompt.prompt();
        const result = await installPrompt.userChoice;
        if (result.outcome === 'accepted') {
          successMsg.style.display = '';
          btn.style.display = 'none';
          androidHint.style.display = 'none';
          iosHint.style.display = 'none';
          desc.textContent = 'Flowly has been installed.';
          showToast('App installed!');
          installPromptConsumed = true;
          return;
        }
      }
      // Prompt consumed, dismissed, or never fired — show instructions
      installPromptConsumed = true;
      showAndroidInstructions();
    });

    // Some browsers fire beforeinstallprompt late; check periodically
    let checkCount = 0;
    const checkInterval = setInterval(() => {
      checkCount++;
      if (installPrompt && !installPromptConsumed) {
        clearInterval(checkInterval);
        return;
      }
      if (checkCount >= 10) { // ~10 seconds
        clearInterval(checkInterval);
        if (!installPrompt || installPromptConsumed) {
          showAndroidInstructions();
        }
      }
    }, 1000);

    // Also listen for the app installed event
    window.addEventListener('appinstalled', () => {
      successMsg.style.display = '';
      btn.style.display = 'none';
      androidHint.style.display = 'none';
      iosHint.style.display = 'none';
      desc.textContent = 'Flowly has been installed.';
      installPromptConsumed = true;
    });
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
    if (currentTab === 'history') renderList();
  }

  // ---- Name Prompt ----
  function setupNamePrompt() {
    return new Promise(resolve => {
      const name = localStorage.getItem('flowly_user_name');
      if (name) { resolve(); return; }

      const overlay = document.getElementById('name-overlay');
      const input = document.getElementById('name-input');
      const heading = document.getElementById('name-heading');
      const introSeen = localStorage.getItem('flowly_intro_seen');

      heading.textContent = introSeen ? "Hey, I didn't catch your name" : "What should I call you?";
      overlay.classList.add('show');
      setTimeout(() => input.focus(), 300);

      function saveName() {
        const val = input.value.trim();
        if (!val) { input.focus(); return; }
        const capped = val.replace(/\b\w/g, c => c.toUpperCase());
        localStorage.setItem('flowly_user_name', capped);
        overlay.classList.remove('show');
        resolve();
      }

      document.getElementById('name-continue').addEventListener('click', saveName);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') saveName(); });
    });
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
    { tab: 'log', title: 'Log', desc: 'Record a period by picking a start and end date. Add optional notes, symptoms, temperature, medications, and tags then hit Save.' },
    { tab: 'history', title: 'History', desc: 'Browse all your past entries in one place. Edit or delete any period whenever you need to.' },
    { tab: 'data', title: 'Your Data', desc: 'Export your data as JSON, CSV, or iCal. Import backups. Customise the app with dark mode, PIN lock, health modes, reminders, and more.' },
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
    dataTab.addEventListener('contextmenu', e => e.preventDefault());

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
      savePeriods([]);
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

  // ---- Update Check ----
  function checkForUpdate() {
    const lastCheck = localStorage.getItem('flowly_update_check');
    const now = Date.now();
    if (lastCheck && now - Number(lastCheck) < 86400000) return;
    localStorage.setItem('flowly_update_check', String(now));

    fetch('https://api.github.com/repos/sova-afk/flowly/releases/latest')
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => {
        const latest = (data.tag_name || '').replace(/^v/i, '');
        if (!latest || latest === APP_VERSION) return;
        document.getElementById('update-version').textContent = latest;
        document.getElementById('update-popup').classList.add('show');
      })
      .catch(() => {});
  }

  // ---- Init ----
  async function init() {
    await initDB();

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    getGrid().addEventListener('pointerdown', onGridPointerDown);
    setupNav();
    setupSwipe();
    setupBtnGroups();
    setupForm();
    setupDataPage();
    setupDeveloper();
    setupInstall();
    setupPhasePopup();
    setupDarkMode();
    setupPIN();
    setupPINHandlers();
    setupHealthMode();
    setupReminders();
    setupDataRetention();
    setupCustomTags();

    document.getElementById('update-dismiss').addEventListener('click', () => {
      document.getElementById('update-popup').classList.remove('show');
    });
    document.getElementById('update-go').addEventListener('click', () => {
      window.open('https://github.com/sova-afk/flowly/', '_blank');
      document.getElementById('update-popup').classList.remove('show');
    });
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js');
    }
    await setupNamePrompt();
    setupIntro();
    switchTab('calendar');
    setTimeout(checkForUpdate, 2000);
    setTimeout(checkReminder, 3000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
