import { parseQuery } from './parser.js';

let tables = {};
let plan = null;
let executor = null;
let previewState = {};
let labelMap = {};
let lastAst = null;

self.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'setTables') {
    tables = message.tables || {};
    self.postMessage({ type: 'status', text: 'Tables updated' });
  }
  if (message.type === 'build') {
    try {
      const ast = parseQuery(message.query);
      lastAst = ast;
      plan = buildPlan(ast);
      labelMap = buildLabelMap(plan);
      executor = buildExecutor(ast, tables, labelMap, previewState);
      previewState = {};
      self.postMessage({ type: 'plan', plan });
    } catch (err) {
      self.postMessage({ type: 'plan', error: err.message });
    }
  }
  if (message.type === 'resetExec') {
    if (plan && lastAst) {
      executor = buildExecutor(lastAst, tables, labelMap, previewState);
    }
    previewState = {};
    self.postMessage({ type: 'reset' });
  }
  if (message.type === 'step') {
    if (!executor) {
      self.postMessage({ type: 'status', text: 'Build a plan first' });
      return;
    }
    const batchSize = message.batchSize || 50;
    const trace = [];
    const result = executor.nextBatch(batchSize, trace);
    self.postMessage({
      type: 'stepResult',
      batch: result.rows,
      active: trace,
      previews: previewState,
      done: result.done
    });
  }
});

function buildPlan(ast) {
  let idCounter = 1;
  function walk(node) {
    const id = idCounter++;
    node.id = id;
    if (node.type === 'scan') {
      return { id, op: 'scan', detail: node.table, children: [] };
    }
    if (node.type === 'select') {
      return { id, op: 'select', detail: conditionToString(node.predicate), children: [walk(node.input)] };
    }
    if (node.type === 'project') {
      return { id, op: 'project', detail: node.columns.join(', '), children: [walk(node.input)] };
    }
    if (node.type === 'limit') {
      return { id, op: 'limit', detail: String(node.count), children: [walk(node.input)] };
    }
    if (node.type === 'join') {
      return {
        id,
        op: 'join',
        detail: conditionToString(node.predicate),
        children: [walk(node.left), walk(node.right)]
      };
    }
    throw new Error(`Unknown node type ${node.type}`);
  }
  return walk(ast);
}

function buildLabelMap(planNode) {
  const map = {};
  function walk(node) {
    map[node.id] = `${node.op.toUpperCase()} ${node.detail ?? ''}`.trim();
    (node.children || []).forEach(walk);
  }
  walk(planNode);
  return map;
}

function buildExecutor(ast, tableData, labels) {
  const state = {
    ast,
    root: null
  };

  function build(node) {
    if (node.type === 'scan') {
      return new ScanOp(node, tableData, labels);
    }
    if (node.type === 'select') {
      return new SelectOp(node, build(node.input), labels);
    }
    if (node.type === 'project') {
      return new ProjectOp(node, build(node.input), labels);
    }
    if (node.type === 'limit') {
      return new LimitOp(node, build(node.input), labels);
    }
    if (node.type === 'join') {
      return new JoinOp(node, build(node.left), build(node.right), labels);
    }
    throw new Error(`Unknown node type ${node.type}`);
  }

  state.root = build(ast);
  state.nextBatch = (batchSize, trace) => state.root.nextBatch(batchSize, trace);
  return state;
}

class ScanOp {
  constructor(node, tableData, labels) {
    this.id = node.id;
    this.tableName = node.table;
    this.rows = tableData[node.table]?.rows || [];
    this.index = 0;
    this.labels = labels;
  }

  nextBatch(batchSize, trace) {
    trace.push(this.id);
    if (this.index >= this.rows.length) {
      return { rows: [], done: true };
    }
    const slice = this.rows.slice(this.index, this.index + batchSize);
    this.index += batchSize;
    updatePreview(this.labels, this.id, slice);
    return { rows: slice, done: this.index >= this.rows.length };
  }
}

class SelectOp {
  constructor(node, child, labels) {
    this.id = node.id;
    this.child = child;
    this.predicate = node.predicate;
    this.labels = labels;
  }

  nextBatch(batchSize, trace) {
    trace.push(this.id);
    const rows = [];
    let done = false;
    while (rows.length < batchSize && !done) {
      const result = this.child.nextBatch(batchSize, trace);
      done = result.done;
      for (const row of result.rows) {
        if (evaluatePredicate(this.predicate, row)) {
          rows.push(row);
          if (rows.length >= batchSize) break;
        }
      }
      if (result.rows.length === 0 && done) {
        break;
      }
    }
    updatePreview(this.labels, this.id, rows);
    return { rows, done };
  }
}

class ProjectOp {
  constructor(node, child, labels) {
    this.id = node.id;
    this.child = child;
    this.columns = node.columns;
    this.labels = labels;
  }

  nextBatch(batchSize, trace) {
    trace.push(this.id);
    const result = this.child.nextBatch(batchSize, trace);
    const rows = result.rows.map((row) => {
      const projected = {};
      this.columns.forEach((col) => {
        projected[col] = row[col];
      });
      return projected;
    });
    updatePreview(this.labels, this.id, rows);
    return { rows, done: result.done };
  }
}

class LimitOp {
  constructor(node, child, labels) {
    this.id = node.id;
    this.child = child;
    this.remaining = node.count;
    this.labels = labels;
  }

  nextBatch(batchSize, trace) {
    trace.push(this.id);
    if (this.remaining <= 0) {
      return { rows: [], done: true };
    }
    const result = this.child.nextBatch(batchSize, trace);
    const rows = result.rows.slice(0, this.remaining);
    this.remaining -= rows.length;
    const done = result.done || this.remaining <= 0;
    updatePreview(this.labels, this.id, rows);
    return { rows, done };
  }
}

class JoinOp {
  constructor(node, left, right, labels) {
    this.id = node.id;
    this.left = left;
    this.right = right;
    this.predicate = node.predicate;
    this.labels = labels;
    this.rightLoaded = false;
    this.rightRows = [];
    this.leftBatch = [];
    this.leftIndex = 0;
    this.rightIndex = 0;
    this.leftDone = false;
  }

  loadRight(batchSize, trace) {
    if (this.rightLoaded) return;
    let done = false;
    while (!done) {
      const result = this.right.nextBatch(batchSize, trace);
      this.rightRows.push(...result.rows);
      done = result.done;
    }
    this.rightLoaded = true;
  }

  nextBatch(batchSize, trace) {
    trace.push(this.id);
    this.loadRight(batchSize, trace);
    const output = [];

    while (output.length < batchSize) {
      if (this.leftIndex >= this.leftBatch.length) {
        if (this.leftDone) {
          updatePreview(this.labels, this.id, output);
          return { rows: output, done: true };
        }
        const result = this.left.nextBatch(batchSize, trace);
        this.leftBatch = result.rows;
        this.leftIndex = 0;
        this.rightIndex = 0;
        this.leftDone = result.done;
        if (this.leftBatch.length === 0 && this.leftDone) {
          updatePreview(this.labels, this.id, output);
          return { rows: output, done: true };
        }
      }

      const leftRow = this.leftBatch[this.leftIndex];
      while (this.rightIndex < this.rightRows.length) {
        const rightRow = this.rightRows[this.rightIndex];
        this.rightIndex += 1;
        const joined = { ...leftRow, ...rightRow };
        if (evaluatePredicate(this.predicate, joined)) {
          output.push(joined);
          if (output.length >= batchSize) break;
        }
      }
      if (this.rightIndex >= this.rightRows.length) {
        this.leftIndex += 1;
        this.rightIndex = 0;
      }
      if (this.leftIndex >= this.leftBatch.length && this.leftDone && this.rightIndex === 0) {
        break;
      }
    }
    updatePreview(this.labels, this.id, output);
    const done = this.leftDone && this.leftIndex >= this.leftBatch.length;
    return { rows: output, done };
  }
}

function updatePreview(labels, id, rows) {
  if (!rows) return;
  previewState[id] = {
    label: labels[id] || `Node ${id}`,
    rows: rows.slice(0, 5)
  };
}

function evaluatePredicate(node, row) {
  if (!node) return true;
  if (node.type === 'literal') return node.value;
  if (node.type === 'column') return row[node.name];
  if (node.type === 'binary') {
    const left = evaluatePredicate(node.left, row);
    const right = evaluatePredicate(node.right, row);
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
    const left = Boolean(evaluatePredicate(node.left, row));
    if (node.op === 'and') {
      return left && Boolean(evaluatePredicate(node.right, row));
    }
    if (node.op === 'or') {
      return left || Boolean(evaluatePredicate(node.right, row));
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
