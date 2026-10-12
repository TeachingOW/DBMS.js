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
const planTree = document.getElementById('planTree');
const errorBox = document.getElementById('errorBox');
const status = document.getElementById('status');
const backExec = document.getElementById('backExec');

let currentPlan = null;
let runTimer = null;
let lastPreviews = {};
let accumulatedRows = [];
let scanNodes = [];
let scanProgress = {};
let scanTablesInitialized = false;
let builtPlan = null;
const nodeEls = new Map();
const edgeEls = new Map();
const SVG_NS = 'http://www.w3.org/2000/svg';
let treeInner = null;
let treeEdges = null;

const tables = new Map();
function getDelay() {
  const value = Number(delayInput.value);
  return Number.isFinite(value) ? Math.min(3000, Math.max(50, value)) : 400;
}

const IDLE_TEXT = 'Press Step to execute the first action.';

function setStepText(text) {
  eventNow.textContent = text;
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

const OP_NAMES = {
  select: 'selection',
  project: 'projection',
  join: 'join',
  cross: 'cross product',
  union: 'union',
  limit: 'limit',
  'dependent join': 'semi-join',
  'not exists': 'anti-join',
  nestedLoop: 'nested loop'
};

function planNodeText(node) {
  if (node.displayName) return node.displayName;
  if (node.op === 'scan') return node.detail || 'scan';
  if (node.op === 'nestedLoop') return 'for each outer row';
  if (node.op === 'dependent join') return `EXISTS ${node.detail ? `(${node.detail})` : ''}`.trim();
  if (node.op === 'not exists') return `NOT EXISTS ${node.detail ? `(${node.detail})` : ''}`.trim();
  return node.detail || node.op;
}

// Builds the plan DOM once per plan; later steps only update classes and live data in place.
function buildPlanDom(plan) {
  planTree.innerHTML = '';
  nodeEls.clear();
  edgeEls.clear();
  const palette = ['#f7b267', '#7ec8ff', '#95d5b2', '#f7a6c1', '#c3a6ff', '#ffd966'];
  const buildNode = (node, parent = null) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'tree-node';
    wrapper.dataset.colorIndex = String(node.colorIndex ?? 0);
    wrapper.style.setProperty('--plan-color', palette[(node.colorIndex ?? 0) % palette.length]);

    const label = document.createElement('div');
    label.className = 'label';
    const symbol = document.createElement('span');
    symbol.className = node.op === 'scan' ? 'plan-symbol scan-word' : node.op === 'result' ? 'plan-symbol result-word' : 'plan-symbol operator';
    symbol.textContent = node.symbol || node.op.toUpperCase();
    symbol.title = OP_NAMES[node.op] || node.op;
    const detail = document.createElement('span');
    detail.className = 'plan-detail';
    detail.textContent = node.op === 'result' ? 'rows so far' : planNodeText(node);
    if (node.op === 'scan') {
      const badge = document.createElement('span');
      badge.className = 'scan-badge';
      badge.textContent = `S${(node.colorIndex ?? 0) + 1}`;
      label.append(badge);
    }
    label.append(symbol);
    if (OP_NAMES[node.op]) {
      const name = document.createElement('span');
      name.className = 'plan-opname';
      name.textContent = OP_NAMES[node.op];
      label.append(name);
    }
    label.append(detail);
    // Row layout: [label | tuples beside it].
    const row = document.createElement('div');
    row.className = 'node-row';
    row.append(label);
    wrapper.appendChild(row);

    let live = null;
    if (node.op === 'scan') {
      const slot = document.createElement('div');
      slot.className = 'scan-slot';
      slot.dataset.scanId = String(node.id);
      wrapper.appendChild(slot);
    } else {
      live = document.createElement('div');
      live.className = node.op === 'result' ? 'node-live result-live' : 'node-live';
      row.appendChild(live);
    }
    nodeEls.set(node.id, { wrapper, live, node, parent, label, parentId: parent ? parent.id : null });

    if (node.children && node.children.length) {
      const children = document.createElement('div');
      children.className = 'tree-children' + (node.children.length > 1 ? ' branched' : '');
      node.children.forEach((child) => children.appendChild(buildNode(child, node)));
      wrapper.appendChild(children);
    }
    return wrapper;
  };
  // The query result is the top of the tree: rows leaving the root land here.
  const resultNode = { id: 0, op: 'result', symbol: 'RESULT', detail: '', children: [plan] };
  treeInner = document.createElement('div');
  treeInner.className = 'tree-inner';
  treeEdges = document.createElementNS(SVG_NS, 'svg');
  treeEdges.setAttribute('class', 'tree-edges');
  treeInner.append(treeEdges, buildNode(resultNode));
  planTree.appendChild(treeInner);
  nodeEls.forEach(({ live, node, parent }) => {
    if (live) reserveLiveSize(live, node, parent);
  });
  drawEdges();
}

const TEST_OPS = new Set(['select', 'join', 'cross', 'dependent join', 'not exists', 'nestedLoop']);

// Qualified column names of the rows a plan node produces (mirrors what the worker emits).
function planColumns(node, parent = null) {
  const child = (i) => planColumns(node.children[i], node);
  switch (node.op) {
    case 'scan': {
      const table = tables.get(node.table);
      return table ? table.columns.map((col) => `${node.alias || node.table}.${col}`) : [];
    }
    case 'project': {
      const written = node.detail.split(',').map((col) => col.trim());
      return written.length === 1 && written[0] === '*' ? child(0) : written;
    }
    case 'join':
    case 'cross':
      return [...child(0), ...child(1)];
    case 'nestedLoop': {
      const outer = parent && parent.children[0] ? planColumns(parent.children[0], parent) : [];
      return [...outer, ...child(0)];
    }
    case 'dependent join':
    case 'not exists':
    case 'result':
    case 'select':
    case 'limit':
    case 'union':
      return child(0);
    default:
      return [];
  }
}

// Gives each live area a fixed size taken from its column headers, so showing different
// tuples never changes the layout of the plan.
function reserveLiveSize(live, node, parent) {
  const headers = displayNames(planColumns(node, parent));
  if (TEST_OPS.has(node.op)) headers.unshift('Status');
  const holder = document.createElement('div');
  holder.className = 'table';
  holder.style.visibility = 'hidden';
  const table = document.createElement('table');
  const head = document.createElement('tr');
  const row = document.createElement('tr');
  (headers.length ? headers : ['']).forEach((name) => {
    const th = document.createElement('th');
    th.textContent = name;
    head.appendChild(th);
    const td = document.createElement('td');
    td.textContent = '\u00a0';
    row.appendChild(td);
  });
  table.append(head, row);
  holder.appendChild(table);
  live.appendChild(holder);
  const width = holder.offsetWidth;
  const height = holder.offsetHeight;
  live.removeChild(holder);
  live.style.width = `${Math.max(150, Math.ceil(width * 1.2) + 12)}px`;
  live.style.height = node.op === 'result' ? '176px' : `${height + 2}px`;
}

// Shows the latest tuple an operator handled, coloured by accept / discard for tests.
function renderLive(container, preview) {
  container.innerHTML = '';
  if (!preview) return;
  const holder = document.createElement('div');
  holder.className = 'table';
  container.appendChild(holder);
  if (preview.op === 'test') {
    renderSelectPreview(holder, preview);
  } else {
    renderTable(holder, preview.rows.slice(-1));
  }
}

function offsetWithin(el, root) {
  let x = 0;
  let y = 0;
  for (let e = el; e && e !== root; e = e.offsetParent) {
    x += e.offsetLeft;
    y += e.offsetTop;
  }
  return { x, y };
}

// Draws an elbow connector from the top of each child to the bottom of its parent,
// with an arrowhead showing that tuples flow upwards.
function drawEdges() {
  if (!treeInner || !treeEdges) return;
  treeEdges.innerHTML = '<defs><marker id="edge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 1 L10 5 L0 9 z" fill="context-stroke"/></marker></defs>';
  edgeEls.clear();
  nodeEls.forEach((entry, id) => {
    if (entry.parentId === null) return;
    const parent = nodeEls.get(entry.parentId);
    if (!parent) return;
    const from = offsetWithin(entry.label, treeInner);
    const to = offsetWithin(parent.label, treeInner);
    const x2 = from.x + entry.label.offsetWidth / 2;
    const y2 = from.y;
    const x1 = to.x + parent.label.offsetWidth / 2;
    const y1 = to.y + parent.label.offsetHeight;
    const mid = y1 + (y2 - y1) / 2 + 4;
    const dx = x1 - x2;
    const r = Math.min(10, Math.abs(dx) / 2, (y2 - y1) / 4);
    const dir = dx > 0 ? 1 : -1;
    const d = Math.abs(dx) < 1
      ? `M ${x2} ${y2} V ${y1}`
      : `M ${x2} ${y2} V ${mid + r} Q ${x2} ${mid} ${x2 + dir * r} ${mid} H ${x1 - dir * r} Q ${x1} ${mid} ${x1} ${mid - r} V ${y1}`;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'tree-edge');
    path.setAttribute('d', d);
    path.setAttribute('marker-end', 'url(#edge-arrow)');
    treeEdges.appendChild(path);
    edgeEls.set(id, path);
  });
  edgeEls.forEach((path, id) => path.classList.toggle('active', activeEdges.has(id)));
}

let activeEdges = new Set();
let edgeFrame = null;
function scheduleEdges() {
  if (edgeFrame) return;
  edgeFrame = requestAnimationFrame(() => {
    edgeFrame = null;
    drawEdges();
  });
}
new ResizeObserver(scheduleEdges).observe(planTree);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleEdges);
window.addEventListener('resize', scheduleEdges);

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
  activeEdges = activeSet;
  edgeEls.forEach((path, id) => path.classList.toggle('active', activeSet.has(id)));
  nodeEls.forEach(({ wrapper, live }, id) => {
    wrapper.classList.remove('active');
    if (activeSet.has(id)) {
      void wrapper.offsetWidth; // restart the pulse animation on consecutive steps
      wrapper.classList.add('active');
    }
    if (live && id !== 0) renderLive(live, lastPreviews[id]);
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

// Leading column that shows a coloured pointer on the row this scan is currently reading.
function addMarkerColumn(container) {
  const table = container.querySelector('table');
  if (!table) return;
  table.querySelector('thead tr').prepend(document.createElement('th'));
  table.querySelectorAll('tbody tr').forEach((tr) => {
    const td = document.createElement('td');
    td.className = 'scan-marker';
    td.textContent = '▶';
    tr.prepend(td);
  });
}

function renderScanTables() {
  scanTablesInitialized = false;
  scanNodes.forEach((scan, idx) => {
    const slot = planTree.querySelector(`.scan-slot[data-scan-id="${scan.id}"]`);
    if (!slot) return;
    slot.innerHTML = '';
    const table = tables.get(scan.table);
    const colorIndex = (scan.colorIndex ?? idx) % 6;
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
      addMarkerColumn(container);
    }
    const footer = document.createElement('div');
    footer.className = 'scan-end';
    footer.textContent = 'End of scan';
    footer.dataset.scanEnd = 'true';
    slot.appendChild(footer);
  });
  scanTablesInitialized = scanNodes.length > 0;
  updateScanHighlights();
  drawEdges();
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
    tbody.querySelectorAll('.scan-marker.on').forEach((td) => td.classList.remove('on'));
    if (!progress || progress.table !== scan.table || progress.done) return;
    const target = tbody.querySelectorAll('tr')[progress.index];
    if (!target) return;
    target.classList.add('row-highlight');
    if (highlightClass) target.classList.add(highlightClass);
    const marker = target.querySelector('.scan-marker');
    if (marker) marker.classList.add('on');
    container.scrollTop = Math.max(0, target.offsetTop - container.clientHeight / 2);
  });
}

// Rows that have left the root operator, shown in the Result node at the top of the plan.
function renderResultsSoFar(rows) {
  const entry = nodeEls.get(0);
  if (!entry || !entry.live) return;
  const live = entry.live;
  live.innerHTML = '';
  if (!rows || rows.length === 0) return;
  const holder = document.createElement('div');
  holder.className = 'table';
  live.appendChild(holder);
  renderTable(holder, rows);
  holder.scrollTop = holder.scrollHeight;
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
  runExec.textContent = 'Run';
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
  const query = queryInput.value.trim();
  if (!query) {
    showError('Please enter a query.');
    return;
  }
  accumulatedRows = [];
  scanProgress = {};
  worker.postMessage({ type: 'build', query });
  setStatus('Building plan…');
});

resetExec.addEventListener('click', () => {
  stopRunLoop();
  worker.postMessage({ type: 'resetExec' });
});

backExec.addEventListener('click', () => {
  stopRunLoop();
  worker.postMessage({ type: 'back' });
});

stepExec.addEventListener('click', () => {
  stopRunLoop();
  worker.postMessage({ type: 'step' });
});

runExec.addEventListener('click', () => {
  if (runTimer) {
    stopRunLoop();
    return;
  }
  runExec.textContent = 'Pause';
  runTimer = setInterval(() => {
    worker.postMessage({ type: 'step' });
  }, getDelay());
});

// Puts the page back to "nothing executed yet" for the current plan.
function showInitialState() {
  lastPreviews = {};
  scanProgress = {};
  accumulatedRows = [];
  renderPlan(currentPlan, []);
  updateScanHighlights();
  renderResultsSoFar([]);
  setStepText(IDLE_TEXT);
}

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
    renderScanTables();
    showInitialState();
    setStatus('Plan ready');
  }
  if (message.type === 'reset') {
    showInitialState();
    setStatus(message.back ? 'Plan ready' : 'Reset');
    stopRunLoop();
  }
  if (message.type === 'stepResult') {
    lastPreviews = message.previews || {};
    scanProgress = message.scanProgress || {};
    accumulatedRows = message.results || [];
    renderPlan(currentPlan, message.active ?? []);
    updateScanHighlights();
    renderResultsSoFar(accumulatedRows);
    setStepText(`Step ${message.stepIndex + 1}: ${message.note}`);
    setStatus(message.done ? 'Done' : 'Running');
    if (message.done) stopRunLoop();
  }
  if (message.type === 'error') {
    stopRunLoop();
    showError(message.error);
    setStatus('Error');
  }
  if (message.type === 'status') {
    setStatus(message.text);
  }
});
