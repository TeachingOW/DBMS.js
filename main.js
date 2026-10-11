const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

const fileInput = document.getElementById('fileInput');
const loadSample = document.getElementById('loadSample');
const tablesList = document.getElementById('tablesList');
const queryInput = document.getElementById('queryInput');
const buildPlan = document.getElementById('buildPlan');
const exampleSelect = document.getElementById('exampleSelect');
const resetExec = document.getElementById('resetExec');
const stepExec = document.getElementById('stepExec');
const runExec = document.getElementById('runExec');
const delayInput = document.getElementById('delayInput');
const eventNow = document.getElementById('eventNow');
const eventLog = document.getElementById('eventLog');
const planTree = document.getElementById('planTree');
const previews = document.getElementById('previews');
const errorBox = document.getElementById('errorBox');
const status = document.getElementById('status');
const resultsSoFar = document.getElementById('resultsSoFar');
const animateStep = document.getElementById('animateStep');
const animationStatus = document.getElementById('animationStatus');
const resultsStatus = document.getElementById('resultsStatus');

let currentPlan = null;
let runTimer = null;
let lastPreviews = {};
let animationTimer = null;
let accumulatedRows = [];
let scanNodes = [];
let scanProgress = {};
let scanTablesInitialized = false;
let builtPlan = null;
const nodeEls = new Map();

const tables = new Map();
let stepCount = 0;

function getDelay() {
  const value = Number(delayInput.value);
  return Number.isFinite(value) ? Math.min(3000, Math.max(50, value)) : 400;
}

function clearEventLog() {
  stepCount = 0;
  eventLog.innerHTML = '';
  eventNow.textContent = 'Press Step to execute the first action.';
}

function logEvent(note) {
  if (!note) return;
  stepCount += 1;
  eventNow.textContent = `Step ${stepCount}: ${note}`;
  const item = document.createElement('li');
  item.value = stepCount;
  item.textContent = note;
  eventLog.prepend(item);
  while (eventLog.children.length > 40) eventLog.lastChild.remove();
}

function setStatus(text) {
  status.textContent = text;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
}

function clearError() {
  errorBox.textContent = '';
  errorBox.classList.add('hidden');
}

function renderTables() {
  tablesList.innerHTML = '';
  if (tables.size === 0) {
    tablesList.innerHTML = '<div class="hint">No tables loaded yet.</div>';
    return;
  }
  for (const [name, table] of tables.entries()) {
    const card = document.createElement('div');
    card.className = 'table-card';
    const title = document.createElement('h4');
    title.textContent = name;
    const size = document.createElement('div');
    size.textContent = `${table.rows.length} rows · ${table.columns.length} columns`;
    const cols = document.createElement('div');
    cols.className = 'hint';
    cols.textContent = `${table.columns.slice(0, 6).join(', ')}${table.columns.length > 6 ? '…' : ''}`;
    card.append(title, size, cols);
    tablesList.appendChild(card);
  }
  if (scanNodes.length > 0 && scanTablesInitialized) {
    renderScanTables();
  }
}

function planNodeText(node) {
  if (node.displayName) return node.displayName;
  if (node.op === 'scan') return node.detail || 'scan';
  if (node.op === 'nestedLoop') return 'nested loop: re-run subquery per outer row';
  if (node.op === 'dependent join') return `EXISTS ${node.detail ? `(${node.detail})` : ''}`.trim();
  if (node.op === 'not exists') return `NOT EXISTS ${node.detail ? `(${node.detail})` : ''}`.trim();
  return node.detail || node.op;
}

// Builds the plan DOM once per plan; later steps only update classes and live data in place.
function buildPlanDom(plan) {
  planTree.innerHTML = '';
  nodeEls.clear();
  const palette = ['#f7b267', '#7ec8ff', '#95d5b2', '#f7a6c1'];
  const buildNode = (node) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'tree-node';
    wrapper.dataset.colorIndex = String(node.colorIndex ?? 0);
    wrapper.style.setProperty('--plan-color', palette[(node.colorIndex ?? 0) % palette.length]);

    const label = document.createElement('div');
    label.className = 'label';
    const symbol = document.createElement('span');
    symbol.className = 'plan-symbol';
    symbol.textContent = node.symbol || node.op.toUpperCase();
    const detail = document.createElement('span');
    detail.className = 'plan-detail';
    detail.textContent = planNodeText(node);
    label.append(symbol, detail);
    wrapper.appendChild(label);

    let live = null;
    if (node.op === 'scan') {
      const slot = document.createElement('div');
      slot.className = 'scan-slot';
      slot.dataset.scanId = String(node.id);
      wrapper.appendChild(slot);
    } else {
      live = document.createElement('div');
      live.className = 'node-live';
      wrapper.appendChild(live);
    }
    nodeEls.set(node.id, { wrapper, live });

    if (node.children && node.children.length) {
      const children = document.createElement('div');
      children.className = 'tree-children' + (node.children.length > 1 ? ' branched' : '');
      node.children.forEach((child) => children.appendChild(buildNode(child)));
      wrapper.appendChild(children);
    }
    return wrapper;
  };
  planTree.appendChild(buildNode(plan));
}

// Shows the latest tuple an operator handled, coloured by accept / discard for tests.
function renderLive(container, preview) {
  container.innerHTML = '';
  if (!preview) {
    container.classList.remove('has-data');
    return;
  }
  container.classList.add('has-data');
  const holder = document.createElement('div');
  holder.className = 'table';
  container.appendChild(holder);
  if (preview.op === 'test') {
    renderSelectPreview(holder, preview);
  } else {
    renderTable(holder, preview.rows.slice(-1));
  }
}

function renderPlan(plan, active = []) {
  if (!plan) {
    builtPlan = null;
    nodeEls.clear();
    planTree.innerHTML = '<div class="hint">Build a plan to see the tree.</div>';
    return;
  }
  if (plan !== builtPlan) {
    buildPlanDom(plan);
    builtPlan = plan;
  }
  const activeSet = new Set(active);
  nodeEls.forEach(({ wrapper, live }, id) => {
    wrapper.classList.remove('active');
    if (activeSet.has(id)) {
      void wrapper.offsetWidth; // restart the pulse animation on consecutive steps
      wrapper.classList.add('active');
    }
    if (live) renderLive(live, lastPreviews[id]);
  });
}

// Row keys are "alias.column"; show the short name unless that would be ambiguous.
function displayNames(keys) {
  const bare = keys.map((key) => key.slice(key.lastIndexOf('.') + 1));
  return keys.map((key, i) => (bare.filter((b) => b === bare[i]).length === 1 ? bare[i] : key));
}

function renderTable(container, rows, options = {}) {
  if (!rows || rows.length === 0) {
    container.innerHTML = '<div class="hint">EOF</div>';
    return;
  }
  const columns = Object.keys(rows[0]);
  const names = displayNames(columns);
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  names.forEach((name) => {
    const th = document.createElement('th');
    th.textContent = name;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const highlightIndex = options.highlightIndex ?? null;
  const highlightClass = options.highlightClass ?? '';
  rows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    if (idx === highlightIndex) {
      tr.classList.add('row-highlight');
      if (highlightClass) tr.classList.add(highlightClass);
    }
    columns.forEach((col) => {
      const td = document.createElement('td');
      td.textContent = row[col];
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.innerHTML = '';
  container.appendChild(table);
}

function renderSelectPreview(container, preview) {
  const last = preview.last;
  if (!last || !last.row) {
    container.innerHTML = '<div class="hint">No rows evaluated yet.</div>';
    return;
  }
  const columns = Object.keys(last.row || {});
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const statusTh = document.createElement('th');
  statusTh.textContent = 'Status';
  headRow.appendChild(statusTh);
  displayNames(columns).forEach((name) => {
    const th = document.createElement('th');
    th.textContent = name;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const tr = document.createElement('tr');
  tr.classList.add(last.passed ? 'row-pass' : 'row-discard');
  const statusTd = document.createElement('td');
  statusTd.textContent = last.passed ? 'accept' : 'discard';
  tr.appendChild(statusTd);
  columns.forEach((col) => {
    const td = document.createElement('td');
    td.textContent = last.row[col];
    tr.appendChild(td);
  });
  tbody.appendChild(tr);
  table.appendChild(tbody);
  container.innerHTML = '';
  container.appendChild(table);
}

function renderPreviews(previewMap) {
  previews.innerHTML = '';
  const entries = Object.entries(previewMap).filter(([, preview]) => !/^scan\b/i.test(preview.label));
  if (entries.length === 0) {
    previews.innerHTML = '<div class="hint">Run a step to see intermediate results.</div>';
    return;
  }
  entries.forEach(([id, preview]) => {
    const card = document.createElement('div');
    card.className = 'preview-card';
    const title = document.createElement('h4');
    title.textContent = `${preview.label}`;
    card.appendChild(title);
    if (preview.op === 'test' && preview.last) {
      const meta = document.createElement('div');
      meta.className = 'preview-meta';
      meta.textContent = preview.last.passed ? 'Accepted tuple' : 'Discarded tuple';
      card.appendChild(meta);
    }
    const container = document.createElement('div');
    container.className = 'table';
    card.appendChild(container);
    if (preview.op === 'test') {
      renderSelectPreview(container, preview);
    } else {
      renderTable(container, preview.rows);
    }
    previews.appendChild(card);
  });
}

function collectScanNodes(plan) {
  const nodes = [];
  const walk = (node) => {
    if (node.op === 'scan') {
      nodes.push({
        id: node.id,
        table: node.detail,
        label: node.displayName || node.detail,
        colorIndex: node.colorIndex ?? 0
      });
    }
    (node.children || []).forEach(walk);
  };
  if (plan) walk(plan);
  return nodes;
}

function renderScanTables() {
  scanTablesInitialized = false;
  scanNodes.forEach((scan, idx) => {
    const slot = planTree.querySelector(`.scan-slot[data-scan-id="${scan.id}"]`);
    if (!slot) return;
    slot.innerHTML = '';
    const table = tables.get(scan.table);
    const colorIndex = (scan.colorIndex ?? idx) % 4;
    slot.dataset.highlightClass = `scan-hl-${colorIndex}`;
    const container = document.createElement('div');
    container.className = 'table';
    slot.appendChild(container);
    if (!table) {
      container.innerHTML = '<div class="hint">Table not loaded.</div>';
    } else {
      const displayRows = table.rows.map((row) => {
        const normalized = {};
        table.columns.forEach((col) => {
          normalized[col] = row[col];
        });
        return normalized;
      });
      renderTable(container, displayRows, { highlightIndex: null, highlightClass: `scan-hl-${colorIndex}` });
    }
    const footer = document.createElement('div');
    footer.className = 'scan-end';
    footer.textContent = 'End of scan';
    footer.dataset.scanEnd = 'true';
    slot.appendChild(footer);
  });
  scanTablesInitialized = scanNodes.length > 0;
  updateScanHighlights();
}

function updateScanHighlights() {
  if (!scanTablesInitialized) return;
  scanNodes.forEach((scan) => {
    const slot = planTree.querySelector(`.scan-slot[data-scan-id="${scan.id}"]`);
    if (!slot) return;
    const progress = scanProgress[scan.id];
    const scanEnd = slot.querySelector('[data-scan-end="true"]');
    if (scanEnd) scanEnd.classList.toggle('active', Boolean(progress && progress.done));
    const container = slot.querySelector('.table');
    const tbody = container && container.querySelector('tbody');
    if (!tbody) return;
    const highlightClass = slot.dataset.highlightClass || '';
    tbody.querySelectorAll('tr.row-highlight').forEach((row) => {
      row.classList.remove('row-highlight');
      if (highlightClass) row.classList.remove(highlightClass);
    });
    if (!progress || progress.table !== scan.table || progress.done) return;
    const target = tbody.querySelectorAll('tr')[progress.index];
    if (!target) return;
    target.classList.add('row-highlight');
    if (highlightClass) target.classList.add(highlightClass);
    container.scrollTop = Math.max(0, target.offsetTop - container.clientHeight / 2);
  });
}

function setResultsStatus(text) {
  resultsStatus.textContent = text;
}

function renderResultsSoFar(rows) {
  if (!rows || rows.length === 0) {
    resultsSoFar.innerHTML = '<div class="hint">No results yet.</div>';
    return;
  }
  renderTable(resultsSoFar, rows);
}

function stopAnimation() {
  if (animationTimer) {
    clearInterval(animationTimer);
    animationTimer = null;
  }
}

if (exampleSelect) {
  exampleSelect.addEventListener('change', () => {
    const example = exampleSelect.value;
    if (!example) return;
    queryInput.value = example;
    queryInput.focus();
  });
}

async function parseFiles(fileList) {
  for (const file of fileList) {
    const text = await file.text();
    const name = file.name.replace(/\.csv$/i, '');
    const table = parseCsv(text, name);
    tables.set(name, table);
  }
  renderTables();
  syncTablesToWorker();
}

function parseCsv(text, tableName) {
  const rows = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { name: tableName, columns: [], rows: [] };
  }
  const headers = splitCsvLine(lines[0]);
  for (let i = 1; i < lines.length; i += 1) {
    const values = splitCsvLine(lines[i]);
    const row = {};
    headers.forEach((header, idx) => {
      const value = values[idx] ?? '';
      row[header] = parseValue(value);
    });
    rows.push(row);
  }
  return { name: tableName, columns: headers, rows };
}

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseValue(value) {
  if (value === '') return '';
  const num = Number(value);
  if (!Number.isNaN(num) && value.match(/^-?\d+(\.\d+)?$/)) {
    return num;
  }
  return value;
}

function syncTablesToWorker() {
  const payload = {};
  tables.forEach((table, name) => {
    payload[name] = table;
  });
  worker.postMessage({ type: 'setTables', tables: payload });
}

function loadSampleData() {
  const usersCsv = `id,name,age,city\n1,Ava,34,Denver\n2,Noah,28,Austin\n3,Mia,41,Denver\n4,Liam,22,Miami`;
  const usersAltCsv = `id,name,age,city\n5,Olivia,30,Seattle\n6,Ethan,25,Denver\n3,Mia,41,Denver\n7,Lucas,29,Boston`;
  const ordersCsv = `id,user_id,total\n101,1,120.5\n102,2,75\n103,1,60\n104,3,250`;
  tables.clear();
  tables.set('users', parseCsv(usersCsv, 'users'));
  tables.set('users_alt', parseCsv(usersAltCsv, 'users_alt'));
  tables.set('orders', parseCsv(ordersCsv, 'orders'));
  renderTables();
  syncTablesToWorker();
  queryInput.value = 'project[users.id,users.name,orders.total](select[city = "Denver"](join[users.id = orders.user_id](users, orders)))';
}

function stopRunLoop() {
  if (runTimer) {
    clearInterval(runTimer);
    runTimer = null;
  }
}

fileInput.addEventListener('change', (event) => {
  if (!event.target.files.length) return;
  parseFiles(event.target.files).catch((err) => showError(err.message));
});

loadSample.addEventListener('click', () => {
  loadSampleData();
});

buildPlan.addEventListener('click', () => {
  clearError();
  stopRunLoop();
  stopAnimation();
  animationStatus.textContent = '';
  const query = queryInput.value.trim();
  if (!query) {
    showError('Please enter a query.');
    return;
  }
  accumulatedRows = [];
  renderResultsSoFar([]);
  setResultsStatus('Input not yet consumed.');
  scanProgress = {};
  clearEventLog();
  worker.postMessage({ type: 'build', query });
  setStatus('Building plan…');
});

resetExec.addEventListener('click', () => {
  stopRunLoop();
  stopAnimation();
  animationStatus.textContent = '';
  animateStep.textContent = 'Animate Step-by-Step';
  scanProgress = {};
  clearEventLog();
  worker.postMessage({ type: 'resetExec' });
});

stepExec.addEventListener('click', () => {
  stopRunLoop();
  stopAnimation();
  animationStatus.textContent = '';
  animateStep.textContent = 'Animate Step-by-Step';
  worker.postMessage({ type: 'step' });
});

runExec.addEventListener('click', () => {
  if (runTimer) {
    stopRunLoop();
    runExec.textContent = 'Run';
    return;
  }
  stopAnimation();
  animationStatus.textContent = '';
  animateStep.textContent = 'Animate Step-by-Step';
  runExec.textContent = 'Pause';
  runTimer = setInterval(() => {
    worker.postMessage({ type: 'step' });
  }, getDelay());
});

animateStep.addEventListener('click', () => {
  if (animationTimer) {
    stopAnimation();
    animationStatus.textContent = 'Paused';
    animateStep.textContent = 'Animate Step-by-Step';
    return;
  }
  stopRunLoop();
  accumulatedRows = [];
  renderResultsSoFar([]);
  setResultsStatus('Input not yet consumed.');
  scanProgress = {};
  animationStatus.textContent = 'Animating every action...';
  animateStep.textContent = 'Pause Animation';
  worker.postMessage({ type: 'resetExec' });
  setTimeout(() => {
    animationTimer = setInterval(() => {
      worker.postMessage({ type: 'step' });
    }, getDelay());
  }, 300);
});

worker.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'plan') {
    if (message.error) {
      showError(message.error);
      setStatus('Error');
      return;
    }
    clearError();
    currentPlan = message.plan;
    lastPreviews = {};
    renderPlan(currentPlan, []);
    scanNodes = collectScanNodes(currentPlan);
    scanProgress = {};
    renderScanTables();
    lastPreviews = {};
    renderPreviews(lastPreviews);
    accumulatedRows = [];
    renderResultsSoFar([]);
    setResultsStatus('Input not yet consumed.');
    setStatus('Plan ready');
  }
  if (message.type === 'reset') {
    lastPreviews = {};
    renderPreviews(lastPreviews);
    renderPlan(currentPlan, []);
    clearEventLog();
    scanProgress = {};
    updateScanHighlights();
    accumulatedRows = [];
    renderResultsSoFar([]);
    setResultsStatus('Input not yet consumed.');
    setStatus('Reset');
    runExec.textContent = 'Run';
    stopRunLoop();
  }
  if (message.type === 'stepResult') {
    logEvent(message.note);
    if (message.previews) {
      lastPreviews = message.previews;
      renderPreviews(lastPreviews);
    }
    renderPlan(currentPlan, message.active ?? []);
    if (message.scanProgress) {
      scanProgress = message.scanProgress;
      updateScanHighlights();
    }
    if (message.batch && message.batch.length > 0) {
      accumulatedRows = accumulatedRows.concat(message.batch);
      renderResultsSoFar(accumulatedRows);
    }
    if (message.done) {
      setResultsStatus('Input exhausted.');
    } else if (accumulatedRows.length > 0) {
      setResultsStatus(`Input available. ${accumulatedRows.length} rows so far.`);
    }
    setStatus(message.done ? 'Done' : 'Running');
    if (message.done) {
      runExec.textContent = 'Run';
      stopRunLoop();
      if (animationTimer) {
        stopAnimation();
        animationStatus.textContent = 'Done';
        animateStep.textContent = 'Animate Step-by-Step';
      }
    }
  }
  if (message.type === 'error') {
    stopRunLoop();
    stopAnimation();
    runExec.textContent = 'Run';
    animateStep.textContent = 'Animate Step-by-Step';
    animationStatus.textContent = '';
    showError(message.error);
    setStatus('Error');
  }
  if (message.type === 'status') {
    setStatus(message.text);
  }
});
