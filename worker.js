import { parseQuery } from './parser.js';

let tables = {};
let plan = null;
let executor = null;
let previewState = {};
let labelMap = {};
let lastAst = null;
let scanProgress = {};
// Every executed step is recorded so the UI can move backwards and forwards through the run.
let history = [];
let cursor = -1;
let produced = [];

self.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'setTables') {
    tables = message.tables || {};
    self.postMessage({ type: 'status', text: 'Tables updated' });
  }
  if (message.type === 'build') {
    try {
      const ast = parseQuery(message.query);
      const nextPlan = buildPlan(ast);
      const nextLabels = buildLabelMap(nextPlan);
      clearRun();
      executor = buildExecutor(ast, tables, nextLabels);
      lastAst = ast;
      plan = nextPlan;
      labelMap = nextLabels;
      self.postMessage({ type: 'plan', plan });
    } catch (err) {
      plan = null;
      executor = null;
      lastAst = null;
      self.postMessage({ type: 'plan', error: err.message });
    }
  }
  if (message.type === 'resetExec') {
    clearRun();
    if (plan && lastAst) {
      try {
        executor = buildExecutor(lastAst, tables, labelMap);
      } catch (err) {
        executor = null;
        self.postMessage({ type: 'error', error: err.message });
        return;
      }
    }
    self.postMessage({ type: 'reset' });
  }
  if (message.type === 'step') {
    if (!executor) {
      self.postMessage({ type: 'status', text: 'Build a plan first' });
      return;
    }
    // Replaying a step we already executed (after going back) just re-sends the recording.
    if (cursor + 1 < history.length) {
      cursor += 1;
      self.postMessage(history[cursor]);
      return;
    }
    const last = history[history.length - 1];
    if (last && last.done) {
      self.postMessage(last);
      return;
    }
    try {
      const result = executor.step();
      produced = produced.concat(result.rows);
      history.push({
        type: 'stepResult',
        stepIndex: history.length,
        results: produced,
        active: [...trace],
        note: lastNote,
        previews: { ...previewState },
        done: result.done,
        scanProgress: { ...scanProgress }
      });
      cursor = history.length - 1;
      self.postMessage(history[cursor]);
    } catch (err) {
      self.postMessage({ type: 'error', error: err.message });
    }
  }
  if (message.type === 'back') {
    if (cursor < 0) return;
    cursor -= 1;
    self.postMessage(cursor < 0 ? { type: 'reset', back: true } : history[cursor]);
  }
});

function clearRun() {
  previewState = {};
  scanProgress = {};
  history = [];
  cursor = -1;
  produced = [];
}

// Assigns each scan its display name and its own colour index (nth scan in the plan).
// Aliases come only from the query itself, so what the plan shows is what rows are keyed by.
function assignScanStyles(node, counter = { next: 0 }) {
  if (!node) return;
  if (node.op === 'scan') {
    node.displayName = node.alias !== node.table ? `${node.table} AS ${node.alias}` : node.table;
    node.colorIndex = counter.next;
    counter.next += 1;
    return;
  }
  (node.children || []).forEach((child) => assignScanStyles(child, counter));
}

function buildPlan(ast) {
  let idCounter = 1;
  function walk(node) {
    const id = idCounter++;
    node.id = id;
    if (node.type === 'scan') {
      return { id, op: 'scan', symbol: 'scan', detail: node.table, table: node.table, alias: node.alias || node.table, children: [] };
    }
    if (node.type === 'select') {
      return { id, op: 'select', symbol: 'σ', detail: conditionToString(node.predicate), children: [walk(node.input)] };
    }
    if (node.type === 'correlatedExists') {
      node.loopId = idCounter++;
      const nestedLoop = {
        id: node.loopId,
        op: 'nestedLoop',
        symbol: '↻',
        detail: 'for each outer row',
        children: [walk(node.subquery)]
      };
      return {
        id,
        op: node.negated ? 'not exists' : 'dependent join',
        symbol: '⋈',
        detail: conditionToString(node.predicate),
        children: [walk(node.input), nestedLoop]
      };
    }
    if (node.type === 'project') {
      return { id, op: 'project', symbol: 'π', detail: node.columns.join(', '), children: [walk(node.input)] };
    }
    if (node.type === 'limit') {
      return { id, op: 'limit', symbol: 'τ', detail: String(node.count), children: [walk(node.input)] };
    }
    if (node.type === 'join') {
      return {
        id,
        op: 'join',
        symbol: '⋈',
        detail: conditionToString(node.predicate),
        children: [walk(node.left), walk(node.right)]
      };
    }
    if (node.type === 'union') {
      return {
        id,
        op: 'union',
        symbol: '∪',
        detail: '',
        children: [walk(node.left), walk(node.right)]
      };
    }
    if (node.type === 'cross') {
      return {
        id,
        op: 'cross',
        symbol: '×',
        detail: '',
        children: [walk(node.left), walk(node.right)]
      };
    }
    throw new Error(`Unknown node type ${node.type}`);
  }
  const plan = walk(ast);
  assignScanStyles(plan);
  return plan;
}

function buildLabelMap(planNode) {
  const map = {};
  function walk(node) {
    const label = node.displayName || node.detail || node.op;
    map[node.id] = `${node.symbol || node.op.toUpperCase()} ${label}`.trim();
    if (node.children) node.children.forEach(walk);
  }
  walk(planNode);
  return map;
}

// ---------------------------------------------------------------------------
// Execution engine: the classic iterator ("Volcano") model, written with
// generators so every unit of work is one visible step.
//
// Each operator has pull(): it asks its children for rows and returns one row,
// or null at end-of-input. Whenever an operator does something worth showing
// (read a row, test a predicate, compare a join pair, ...) it records what it
// did with mark() and then `yield`s. The driver advances the pipeline one yield
// at a time, so one Step == one such action.
// ---------------------------------------------------------------------------

let trace = new Set();
let lastNote = '';

function mark(op, text) {
  trace.add(op.id);
  lastNote = text;
}

function rowText(row) {
  return `(${Object.values(row).join(', ')})`;
}

function buildOperator(node, tableData, labels) {
  const child = (input) => buildOperator(input, tableData, labels);
  switch (node.type) {
    case 'scan':
      return new ScanOp(node, tableData, labels);
    case 'select':
      return new SelectOp(node, child(node.input), labels);
    case 'correlatedExists':
      return new CorrelatedExistsOp(node, child(node.input), tableData, labels);
    case 'project':
      return new ProjectOp(node, child(node.input), labels);
    case 'limit':
      return new LimitOp(node, child(node.input), labels);
    case 'join':
      return new JoinOp(node, child(node.left), child(node.right), labels);
    case 'union':
      return new UnionOp(node, child(node.left), child(node.right), labels);
    case 'cross':
      return new CrossOp(node, child(node.left), child(node.right), labels);
    default:
      throw new Error(`Unknown node type ${node.type}`);
  }
}

function buildExecutor(ast, tableData, labels) {
  const root = buildOperator(ast, tableData, labels);
  let gen = null;
  let finished = false;

  // The root asks for one row at a time; each row it receives is a query result.
  function* pullRoot() {
    const row = yield* root.pull();
    if (row !== null) {
      mark(root, `Result row ${rowText(row)} leaves the root operator`);
      yield { output: row };
    }
    return row;
  }

  return {
    // Advances to the next visible action. Returns any result row produced by it.
    step() {
      trace = new Set();
      lastNote = '';
      if (finished) return { rows: [], done: true };
      for (;;) {
        if (!gen) gen = pullRoot();
        const next = gen.next();
        if (!next.done) {
          const output = next.value && next.value.output;
          return { rows: output ? [output] : [], done: false };
        }
        gen = null;
        if (next.value === null) {
          finished = true;
          mark(root, 'Root operator returned end-of-input: query finished');
          return { rows: [], done: true };
        }
      }
    }
  };
}

class ScanOp {
  constructor(node, tableData, labels) {
    this.id = node.id;
    this.tableName = node.table;
    this.alias = node.alias || node.table;
    const table = tableData[node.table];
    if (!table) {
      const known = Object.keys(tableData);
      throw new Error(`Unknown table '${node.table}'. ${known.length ? `Loaded tables: ${known.join(', ')}.` : 'No tables are loaded.'}`);
    }
    this.columns = table.columns;
    this.rows = table.rows;
    this.index = 0;
    this.labels = labels;
  }

  *pull() {
    if (this.index >= this.rows.length) {
      updateScanProgress(this.id, this.tableName, this.rows.length - 1, true);
      mark(this, `scan ${this.alias}: no rows left, returns end-of-input`);
      yield;
      return null;
    }
    const position = this.index;
    this.index += 1;
    const source = this.rows[position];
    // Rows are keyed "alias.column" so every column is unambiguous downstream.
    const row = {};
    this.columns.forEach((col) => {
      row[`${this.alias}.${col}`] = source[col];
    });
    Object.defineProperty(row, '__rowIndex', { value: position, enumerable: false });
    updateScanProgress(this.id, this.tableName, position);
    pushPreview(this.labels, this.id, row);
    mark(this, `scan ${this.alias}: reads row ${position + 1} of ${this.rows.length} ${rowText(row)}`);
    yield;
    return row;
  }

  getScanInfos() {
    return [{ id: this.id, table: this.tableName, alias: this.alias }];
  }
}

class SelectOp {
  constructor(node, child, labels) {
    this.id = node.id;
    this.child = child;
    this.predicate = node.predicate;
    this.labels = labels;
  }

  *pull() {
    for (;;) {
      const row = yield* this.child.pull();
      if (row === null) return null;
      const passed = Boolean(evaluatePredicate(this.predicate, row));
      recordTest(this.labels, this.id, row, passed);
      mark(this, `${this.labels[this.id]}: tests ${rowText(row)} → ${passed ? 'accepted, passed to the next operator' : 'discarded, pulls the next row'}`);
      yield;
      if (passed) return row;
    }
  }

  getScanInfos() {
    return this.child.getScanInfos();
  }
}

class ProjectOp {
  constructor(node, child, labels) {
    this.id = node.id;
    this.child = child;
    this.columns = node.columns;
    this.labels = labels;
  }

  *pull() {
    const row = yield* this.child.pull();
    if (row === null) return null;
    let projected = row;
    if (!(this.columns.length === 1 && this.columns[0] === '*')) {
      projected = {};
      this.columns.forEach((col) => {
        projected[col] = resolveColumn(col, row);
      });
      if (row.__rowIndex !== undefined) {
        Object.defineProperty(projected, '__rowIndex', { value: row.__rowIndex, enumerable: false });
      }
    }
    pushPreview(this.labels, this.id, projected);
    mark(this, `${this.labels[this.id]}: keeps only ${this.columns.join(', ')} → ${rowText(projected)}`);
    yield;
    return projected;
  }

  getScanInfos() {
    return this.child.getScanInfos();
  }
}

class LimitOp {
  constructor(node, child, labels) {
    this.id = node.id;
    this.child = child;
    this.count = node.count;
    this.remaining = node.count;
    this.labels = labels;
  }

  *pull() {
    if (this.remaining <= 0) {
      mark(this, `τ ${this.count}: limit reached, stops pulling from its input`);
      yield;
      return null;
    }
    const row = yield* this.child.pull();
    if (row === null) return null;
    this.remaining -= 1;
    pushPreview(this.labels, this.id, row);
    mark(this, `τ ${this.count}: passes ${rowText(row)} (${this.remaining} left)`);
    yield;
    return row;
  }

  getScanInfos() {
    return this.child.getScanInfos();
  }
}

// Nested-loop join: the right input is read once into memory, then for every
// left row each right row is compared in turn. Cross product is the same loop
// without a predicate.
class NestedLoopOp {
  constructor(node, left, right, labels) {
    this.id = node.id;
    this.left = left;
    this.right = right;
    this.predicate = node.predicate || null;
    this.labels = labels;
    this.rightRows = null;
    this.leftRow = null;
    this.leftCount = 0;
    this.rightIndex = 0;
    this.leftScan = (left.getScanInfos && left.getScanInfos()[0]) || null;
    this.rightScan = (right.getScanInfos && right.getScanInfos()[0]) || null;
    assertDistinctAliases(left, right);
  }

  *pull() {
    if (this.rightRows === null) {
      const rows = [];
      for (let row = yield* this.right.pull(); row !== null; row = yield* this.right.pull()) {
        rows.push(row);
      }
      this.rightRows = rows;
      mark(this, `${this.labels[this.id]}: right input read into memory (${rows.length} rows); nested loop begins`);
      yield;
    }
    for (;;) {
      if (this.leftRow === null) {
        this.leftRow = yield* this.left.pull();
        if (this.leftRow === null) return null;
        this.leftCount += 1;
        this.rightIndex = 0;
      }
      while (this.rightIndex < this.rightRows.length) {
        const rightRow = this.rightRows[this.rightIndex];
        const position = this.rightIndex;
        this.rightIndex += 1;
        if (this.leftScan && this.leftRow.__rowIndex !== undefined) {
          updateScanProgress(this.leftScan.id, this.leftScan.table, this.leftRow.__rowIndex);
        }
        if (this.rightScan && rightRow.__rowIndex !== undefined) {
          updateScanProgress(this.rightScan.id, this.rightScan.table, rightRow.__rowIndex);
        }
        const joined = { ...this.leftRow, ...rightRow };
        const matched = this.predicate ? Boolean(evaluatePredicate(this.predicate, joined)) : true;
        recordTest(this.labels, this.id, joined, matched);
        mark(this, `${this.labels[this.id]}: left row ${this.leftCount} ${rowText(this.leftRow)} × right row ${position + 1} ${rowText(rightRow)} → ${matched ? 'match, output' : 'no match'}`);
        yield;
        if (matched) return joined;
      }
      this.leftRow = null;
    }
  }

  getScanInfos() {
    return [...(this.left.getScanInfos ? this.left.getScanInfos() : []), ...(this.right.getScanInfos ? this.right.getScanInfos() : [])];
  }
}

class JoinOp extends NestedLoopOp {}
class CrossOp extends NestedLoopOp {}

// Correlated EXISTS / NOT EXISTS: the subquery is re-run from scratch for every
// outer row, stopping as soon as it finds a row that satisfies the predicate.
class CorrelatedExistsOp {
  constructor(node, child, tableData, labels) {
    this.id = node.id;
    this.loopId = node.loopId;
    this.child = child;
    this.subquery = node.subquery;
    this.predicate = node.predicate;
    this.negated = node.negated;
    this.tableData = tableData;
    this.labels = labels;
    this.outerCount = 0;
  }

  *pull() {
    const name = this.negated ? 'NOT EXISTS' : 'EXISTS';
    for (;;) {
      const outer = yield* this.child.pull();
      if (outer === null) return null;
      this.outerCount += 1;
      mark(this, `${name}: outer row ${this.outerCount} ${rowText(outer)} → re-runs the subquery from the start`);
      trace.add(this.loopId);
      yield;

      const inner = buildOperator(this.subquery, this.tableData, this.labels);
      let found = false;
      for (let row = yield* inner.pull(); row !== null; row = yield* inner.pull()) {
        const matched = Boolean(evaluatePredicate(this.predicate, row, outer));
        recordTest(this.labels, this.loopId, { ...outer, ...row }, matched);
        mark(this, `subquery: inner row ${rowText(row)} vs outer ${rowText(outer)} → ${matched ? 'predicate true, stops searching' : 'predicate false'}`);
        trace.add(this.loopId);
        yield;
        if (matched) {
          found = true;
          break;
        }
      }

      const keep = found !== this.negated;
      recordTest(this.labels, this.id, outer, keep);
      mark(this, `${name}: subquery ${found ? 'found a match' : 'found no match'} → outer row ${rowText(outer)} ${keep ? 'accepted' : 'discarded'}`);
      yield;
      if (keep) return outer;
    }
  }

  getScanInfos() {
    return this.child.getScanInfos ? this.child.getScanInfos() : [];
  }
}

class UnionOp {
  constructor(node, left, right, labels) {
    this.id = node.id;
    this.left = left;
    this.right = right;
    this.labels = labels;
    this.seen = new Set();
    this.columns = null;
    this.leftDone = false;
  }

  *pull() {
    for (;;) {
      const source = this.leftDone ? this.right : this.left;
      const row = yield* source.pull();
      if (row === null) {
        if (this.leftDone) return null;
        this.leftDone = true;
        continue;
      }
      const normalized = this.normalizeRow(row);
      const key = JSON.stringify(Object.values(normalized));
      const duplicate = this.seen.has(key);
      this.seen.add(key);
      if (!duplicate) pushPreview(this.labels, this.id, normalized);
      mark(this, `∪ ${this.leftDone ? 'right' : 'left'} input: ${rowText(normalized)} → ${duplicate ? 'duplicate, dropped' : 'new row, output'}`);
      yield;
      if (!duplicate) return normalized;
    }
  }

  // Union is positional: the first input names the columns, later rows are matched by position.
  normalizeRow(row) {
    const values = Object.values(row);
    if (!this.columns) this.columns = shortNames(Object.keys(row));
    if (values.length !== this.columns.length) {
      throw new Error(`Union inputs must have the same number of columns (${this.columns.length} vs ${values.length}).`);
    }
    const normalized = {};
    this.columns.forEach((col, i) => {
      normalized[col] = values[i];
    });
    return normalized;
  }

  getScanInfos() {
    return [...(this.left.getScanInfos ? this.left.getScanInfos() : []), ...(this.right.getScanInfos ? this.right.getScanInfos() : [])];
  }
}

// Previews show the last few rows an operator produced.
function pushPreview(labels, id, row) {
  const previous = previewState[id] && previewState[id].op !== 'test' ? previewState[id].rows : [];
  previewState[id] = { label: labels[id] || `Node ${id}`, rows: [...previous, row].slice(-5) };
}

// Operators that test one row at a time (filters, join pairs) show the latest verdict.
function recordTest(labels, id, row, passed) {
  previewState[id] = { label: labels[id] || `Node ${id}`, rows: passed ? [row] : [], op: 'test', last: { row, passed } };
}

function updateScanProgress(id, table, index, done = false) {
  if (index === undefined || index === null) return;
  const prev = scanProgress[id] || {};
  let nextDone = done || prev.done;
  if (prev.index !== undefined && index < prev.index) {
    nextDone = done;
  }
  scanProgress[id] = { table, index, done: nextDone };
}

// Looks a column up in one row: exact "alias.col" match, else a unique ".col" suffix match.
function lookupColumn(row, name) {
  if (Object.prototype.hasOwnProperty.call(row, name)) return { found: true, value: row[name] };
  const suffix = `.${name}`;
  let hit = null;
  for (const key of Object.keys(row)) {
    if (key.endsWith(suffix)) {
      if (hit !== null) throw new Error(`Column '${name}' is ambiguous (${hit}, ${key}). Qualify it with a table name.`);
      hit = key;
    }
  }
  return hit === null ? { found: false } : { found: true, value: row[hit] };
}

// outerRow is the enclosing query's current row, visible only inside a correlated subquery.
function resolveColumn(name, row, outerRow) {
  let found = lookupColumn(row, name);
  if (!found.found && outerRow) found = lookupColumn(outerRow, name);
  if (!found.found) {
    const available = Object.keys(outerRow ? { ...outerRow, ...row } : row).join(', ');
    throw new Error(`Unknown column '${name}'. Available: ${available || 'none'}.`);
  }
  return found.value;
}

// Drops the "alias." prefix from names that stay unique without it.
function shortNames(keys) {
  const bare = keys.map((key) => key.slice(key.lastIndexOf('.') + 1));
  return keys.map((key, i) => (bare.filter((b) => b === bare[i]).length === 1 ? bare[i] : key));
}

function assertDistinctAliases(left, right) {
  const leftAliases = new Set((left.getScanInfos ? left.getScanInfos() : []).map((scan) => scan.alias));
  const clash = (right.getScanInfos ? right.getScanInfos() : []).find((scan) => leftAliases.has(scan.alias));
  if (clash) {
    throw new Error(`'${clash.alias}' appears on both sides. Give each copy its own alias, e.g. SELECT ... FROM ${clash.table} a JOIN ${clash.table} b ON ...`);
  }
}

function evaluatePredicate(node, row, outerRow) {
  if (!node) return true;
  if (node.type === 'literal') return node.value;
  if (node.type === 'column') return resolveColumn(node.name, row, outerRow);
  if (node.type === 'binary') {
    const left = evaluatePredicate(node.left, row, outerRow);
    const right = evaluatePredicate(node.right, row, outerRow);
    switch (node.op) {
      case '=':
        return left === right;
      case '!=':
        return left !== right;
      case '<':
        return left < right;
      case '>':
        return left > right;
      case '<=':
        return left <= right;
      case '>=':
        return left >= right;
      default:
        return false;
    }
  }
  if (node.type === 'logic') {
    const left = Boolean(evaluatePredicate(node.left, row, outerRow));
    if (node.op === 'and') {
      return left && Boolean(evaluatePredicate(node.right, row, outerRow));
    }
    if (node.op === 'or') {
      return left || Boolean(evaluatePredicate(node.right, row, outerRow));
    }
  }
  return false;
}

function conditionToString(node) {
  if (!node) return '';
  if (node.type === 'literal') return JSON.stringify(node.value);
  if (node.type === 'column') return node.name;
  if (node.type === 'binary') {
    return `${conditionToString(node.left)} ${node.op} ${conditionToString(node.right)}`;
  }
  if (node.type === 'logic') {
    return `${conditionToString(node.left)} ${node.op.toUpperCase()} ${conditionToString(node.right)}`;
  }
  return '';
}
