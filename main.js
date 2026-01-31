const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

const fileInput = document.getElementById('fileInput');
const loadSample = document.getElementById('loadSample');
const tablesList = document.getElementById('tablesList');
const queryInput = document.getElementById('queryInput');
const buildPlan = document.getElementById('buildPlan');
const resetExec = document.getElementById('resetExec');
const stepExec = document.getElementById('stepExec');
const runExec = document.getElementById('runExec');
const batchSizeInput = document.getElementById('batchSize');
const planTree = document.getElementById('planTree');
const previews = document.getElementById('previews');
const errorBox = document.getElementById('errorBox');
const status = document.getElementById('status');
const resultsSoFar = document.getElementById('resultsSoFar');
const animateStep = document.getElementById('animateStep');
const animationStatus = document.getElementById('animationStatus');
const resultsStatus = document.getElementById('resultsStatus');
const scanTables = document.getElementById('scanTables');

let currentPlan = null;
let runTimer = null;
let lastPreviews = {};
let animationTimer = null;
let accumulatedRows = [];
let scanNodes = [];
let scanProgress = {};
let scanTablesInitialized = false;

const tables = new Map();
const fixedBatchSize = 1;

batchSizeInput.value = String(fixedBatchSize);
batchSizeInput.disabled = true;
batchSizeInput.title = 'Batch size fixed to 1';

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
    card.innerHTML = `
      <h4>${name}</h4>
      <div>${table.rows.length} rows · ${table.columns.length} columns</div>
      <div class="hint">${table.columns.slice(0, 6).join(', ')}${table.columns.length > 6 ? '…' : ''}</div>
    `;
    tablesList.appendChild(card);
  }
  if (scanNodes.length > 0 && scanTablesInitialized) {
    renderScanTables();
  }
}

function renderPlan(plan, active = []) {
  planTree.innerHTML = '';
  if (!plan) {
    planTree.innerHTML = '<div class="hint">Build a plan to see the tree.</div>';
    return;
  }
  const activeSet = new Set(active);
  const buildNode = (node) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'tree-node' + (activeSet.has(node.id) ? ' active' : '');
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = `${node.op.toUpperCase()} ${node.detail ?? ''}`.trim();
    wrapper.appendChild(label);
    if (node.children && node.children.length) {
      node.children.forEach((child) => {
        wrapper.appendChild(buildNode(child));
      });
    }
    return wrapper;
  };
  planTree.appendChild(buildNode(plan));
}

function renderTable(container, rows, options = {}) {
  if (!rows || rows.length === 0) {
    container.innerHTML = '<div class="hint">EOF</div>';
    return;
  }
  const columns = Object.keys(rows[0]);
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  columns.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col;
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
  columns.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col;
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
  const entries = Object.entries(previewMap).filter(([, preview]) => !preview.label.startsWith('SCAN '));
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
    if (preview.op === 'select' && preview.last) {
      const meta = document.createElement('div');
      meta.className = 'preview-meta';
      meta.textContent = preview.last.passed ? 'Accepted tuple' : 'Discarded tuple';
      card.appendChild(meta);
    }
    const container = document.createElement('div');
    container.className = 'table';
    card.appendChild(container);
    if (preview.op === 'select') {
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
      nodes.push({ id: node.id, table: node.detail });
    }
    (node.children || []).forEach(walk);
  };
  if (plan) walk(plan);
  return nodes;
}

function renderScanTables() {
  scanTables.innerHTML = '';
  if (scanNodes.length === 0) {
    scanTables.innerHTML = '<div class="hint">No scans in plan.</div>';
    scanTablesInitialized = false;
    return;
  }
  scanNodes.forEach((scan, idx) => {
    const table = tables.get(scan.table);
    const card = document.createElement('div');
    card.className = 'scan-card';
    card.dataset.scanId = String(scan.id);
    card.dataset.highlightClass = `scan-hl-${idx % 4}`;
    const title = document.createElement('h4');
    title.textContent = `SCAN ${scan.table}`;
    card.appendChild(title);
    const container = document.createElement('div');
    container.className = 'table';
    card.appendChild(container);
    if (!table) {
      container.innerHTML = '<div class="hint">Table not loaded.</div>';
    } else {
      renderTable(container, table.rows, {
        highlightIndex: null,
        highlightClass: `scan-hl-${idx % 4}`
      });
    }
    const footer = document.createElement('div');
    footer.className = 'scan-end';
    footer.textContent = 'End of scan';
    footer.dataset.scanEnd = 'true';
    card.appendChild(footer);
    scanTables.appendChild(card);
  });
  scanTablesInitialized = true;
  updateScanHighlights();
}

function updateScanHighlights() {
  if (!scanTablesInitialized) return;
  scanNodes.forEach((scan) => {
    const card = scanTables.querySelector(`[data-scan-id="${scan.id}"]`);
    if (!card) return;
    const progress = scanProgress[scan.id];
    const scanEnd = card.querySelector('[data-scan-end="true"]');
    if (scanEnd) {
      scanEnd.classList.toggle('active', Boolean(progress && progress.done));
    }
    const container = card.querySelector('.table');
    if (!container) return;
    const table = container.querySelector('table');
    if (!table) return;
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    const highlightClass = card.dataset.highlightClass || '';
    tbody.querySelectorAll('tr.row-highlight').forEach((row) => {
      row.classList.remove('row-highlight');
      if (highlightClass) row.classList.remove(highlightClass);
    });
    if (!progress || progress.table !== scan.table) return;
    const rows = tbody.querySelectorAll('tr');
    const target = rows[progress.index];
    if (!target) return;
    target.classList.add('row-highlight');
    if (highlightClass) target.classList.add(highlightClass);
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
  const columns = Object.keys(rows[0]);
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  columns.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    columns.forEach((col) => {
      const td = document.createElement('td');
      td.textContent = row[col];
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  resultsSoFar.innerHTML = '';
  resultsSoFar.appendChild(table);
}

function stopAnimation() {
  if (animationTimer) {
    clearInterval(animationTimer);
    animationTimer = null;
  }
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
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
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
      row[`${tableName}.${header}`] = parseValue(value);
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
  const ordersCsv = `id,user_id,total\n101,1,120.5\n102,2,75\n103,1,60\n104,3,250`;
  tables.clear();
  tables.set('users', parseCsv(usersCsv, 'users'));
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
  worker.postMessage({ type: 'build', query });
  setStatus('Building plan…');
});

resetExec.addEventListener('click', () => {
  stopRunLoop();
  stopAnimation();
  animationStatus.textContent = '';
  animateStep.textContent = 'Animate Step-by-Step';
  scanProgress = {};
  worker.postMessage({ type: 'resetExec' });
});

stepExec.addEventListener('click', () => {
  stopRunLoop();
  stopAnimation();
  animationStatus.textContent = '';
  animateStep.textContent = 'Animate Step-by-Step';
  worker.postMessage({ type: 'step', batchSize: fixedBatchSize });
});

runExec.addEventListener('click', () => {
  const batchSize = fixedBatchSize;
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
    worker.postMessage({ type: 'step', batchSize });
  }, 300);
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
  animationStatus.textContent = 'Running row-by-row...';
  animateStep.textContent = 'Pause Animation';
  worker.postMessage({ type: 'resetExec' });
  setTimeout(() => {
    animationTimer = setInterval(() => {
      worker.postMessage({ type: 'step', batchSize: fixedBatchSize });
    }, 500);
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
    renderPlan(currentPlan, message.active ?? []);
    if (message.previews) {
      lastPreviews = message.previews;
      renderPreviews(lastPreviews);
    }
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
  if (message.type === 'status') {
    setStatus(message.text);
  }
});
