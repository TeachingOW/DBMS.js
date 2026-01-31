const greekMap = {
  'σ': 'select',
  'π': 'project',
  'τ': 'limit'
};

function isWhitespace(char) {
  return /\s/.test(char);
}

function isIdentStart(char) {
  return /[A-Za-z_]/.test(char);
}

function isIdentPart(char) {
  return /[A-Za-z0-9_\.]/.test(char);
}

export function parseQuery(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Empty query.');
  }
  if (/^select\s+/i.test(trimmed)) {
    const ast = parseSQLToRA(trimmed);
    if (!ast) {
      throw new Error('Could not parse SQL. Expected SELECT ... FROM ...');
    }
    return ast;
  }
  return parseRA(trimmed);
}

function parseRA(input) {
  let index = 0;

  function skipWhitespace() {
    while (index < input.length && isWhitespace(input[index])) {
      index += 1;
    }
  }

  function peek() {
    skipWhitespace();
    return input[index];
  }

  function readIdentifier() {
    skipWhitespace();
    const char = input[index];
    if (greekMap[char]) {
      index += 1;
      return greekMap[char];
    }
    if (!isIdentStart(char)) {
      return null;
    }
    let start = index;
    index += 1;
    while (index < input.length && isIdentPart(input[index])) {
      index += 1;
    }
    return input.slice(start, index);
  }

  function expect(char) {
    skipWhitespace();
    if (input[index] !== char) {
      throw new Error(`Expected '${char}' at position ${index + 1}.`);
    }
    index += 1;
  }

  function readBracketContent() {
    skipWhitespace();
    expect('[');
    let depth = 1;
    let start = index;
    while (index < input.length) {
      const char = input[index];
      if (char === '[') {
        depth += 1;
      } else if (char === ']') {
        depth -= 1;
        if (depth === 0) {
          const content = input.slice(start, index);
          index += 1;
          return content.trim();
        }
      }
      index += 1;
    }
    throw new Error('Unclosed [ in query.');
  }

  function parseExpr() {
    skipWhitespace();
    if (peek() === '(') {
      expect('(');
      const inner = parseExpr();
      expect(')');
      return inner;
    }

    const ident = readIdentifier();
    if (!ident) {
      throw new Error(`Expected identifier at position ${index + 1}.`);
    }
    const lower = ident.toLowerCase();

    if (lower === 'select' || lower === 'project' || lower === 'limit') {
      const args = readBracketContent();
      expect('(');
      const inputNode = parseExpr();
      expect(')');
      if (lower === 'select') {
        return { type: 'select', predicate: parseCondition(args), input: inputNode };
      }
      if (lower === 'project') {
        const columns = args
          .split(',')
          .map((col) => col.trim())
          .filter((col) => col.length > 0);
        return { type: 'project', columns, input: inputNode };
      }
      if (lower === 'limit') {
        const count = Number(args.trim());
        if (!Number.isFinite(count)) {
          throw new Error('Limit expects a number.');
        }
        return { type: 'limit', count, input: inputNode };
      }
    }

    if (lower === 'join') {
      const args = readBracketContent();
      expect('(');
      const left = parseExpr();
      skipWhitespace();
      expect(',');
      const right = parseExpr();
      expect(')');
      return { type: 'join', predicate: parseCondition(args), left, right };
    }

    if (lower === 'cross' || lower === 'product') {
      expect('(');
      const left = parseExpr();
      skipWhitespace();
      expect(',');
      const right = parseExpr();
      expect(')');
      return { type: 'cross', left, right };
    }

    if (lower === 'scan') {
      expect('(');
      const tableName = readIdentifier();
      if (!tableName) {
        throw new Error('Scan expects a table name.');
      }
      expect(')');
      return { type: 'scan', table: tableName };
    }

    return { type: 'scan', table: ident };
  }

  const ast = parseExpr();
  skipWhitespace();
  if (index < input.length) {
    throw new Error(`Unexpected input at position ${index + 1}.`);
  }
  return ast;
}

function parseSQLToRA(sql) {
  const cleaned = sql.trim().replace(/;$/, '');
  const match = cleaned.match(
    /^select\s+(.+?)\s+from\s+([a-zA-Z0-9_.]+)(?:\s+join\s+([a-zA-Z0-9_.]+)\s+on\s+(.+?))?(?:\s+where\s+(.+?))?(?:\s+limit\s+(\d+))?$/i
  );
  if (!match) return null;
  const [, colsRaw, tableA, tableB, joinCond, whereCond, limitRaw] = match;
  let node = { type: 'scan', table: tableA };
  if (tableB) {
    node = {
      type: 'join',
      predicate: parseCondition(joinCond),
      left: { type: 'scan', table: tableA },
      right: { type: 'scan', table: tableB }
    };
  }
  if (whereCond) {
    node = { type: 'select', predicate: parseCondition(whereCond), input: node };
  }
  const cols = colsRaw.trim();
  if (cols !== '*') {
    const columns = cols.split(',').map((col) => col.trim());
    node = { type: 'project', columns, input: node };
  }
  if (limitRaw) {
    node = { type: 'limit', count: Number(limitRaw), input: node };
  }
  return node;
}

function tokenizeCondition(input) {
  const tokens = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (isWhitespace(char)) {
      index += 1;
      continue;
    }
    if (char === '(' || char === ')') {
      tokens.push({ type: char, value: char });
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      index += 1;
      while (index < input.length && input[index] !== quote) {
        if (input[index] === '\\' && index + 1 < input.length) {
          value += input[index + 1];
          index += 2;
        } else {
          value += input[index];
          index += 1;
        }
      }
      if (input[index] !== quote) {
        throw new Error('Unclosed string in condition.');
      }
      index += 1;
      tokens.push({ type: 'string', value });
      continue;
    }
    const twoChar = input.slice(index, index + 2);
    if (['<=', '>=', '!='].includes(twoChar)) {
      tokens.push({ type: 'op', value: twoChar });
      index += 2;
      continue;
    }
    if (['=', '<', '>'].includes(char)) {
      tokens.push({ type: 'op', value: char });
      index += 1;
      continue;
    }
    if (isIdentStart(char)) {
      let start = index;
      index += 1;
      while (index < input.length && isIdentPart(input[index])) {
        index += 1;
      }
      const value = input.slice(start, index);
      const upper = value.toUpperCase();
      if (upper === 'AND' || upper === 'OR') {
        tokens.push({ type: 'logic', value: upper.toLowerCase() });
      } else {
        tokens.push({ type: 'ident', value });
      }
      continue;
    }
    if (/[-0-9.]/.test(char)) {
      let start = index;
      index += 1;
      while (index < input.length && /[0-9.]/.test(input[index])) {
        index += 1;
      }
      const raw = input.slice(start, index);
      const num = Number(raw);
      if (Number.isNaN(num)) {
        throw new Error(`Invalid number '${raw}'.`);
      }
      tokens.push({ type: 'number', value: num });
      continue;
    }
    throw new Error(`Unexpected character '${char}' in condition.`);
  }
  return tokens;
}

function parseCondition(input) {
  const tokens = tokenizeCondition(input);
  let index = 0;

  function peek() {
    return tokens[index];
  }

  function consume() {
    const token = tokens[index];
    index += 1;
    return token;
  }

  function parsePrimary() {
    const token = peek();
    if (!token) {
      throw new Error('Unexpected end of condition.');
    }
    if (token.type === '(') {
      consume();
      const expr = parseOr();
      if (!peek() || peek().type !== ')') {
        throw new Error('Expected ) in condition.');
      }
      consume();
      return expr;
    }
    if (token.type === 'ident') {
      consume();
      return { type: 'column', name: token.value };
    }
    if (token.type === 'number') {
      consume();
      return { type: 'literal', value: token.value };
    }
    if (token.type === 'string') {
      consume();
      return { type: 'literal', value: token.value };
    }
    throw new Error(`Unexpected token '${token.value}'.`);
  }

  function parseComparison() {
    const left = parsePrimary();
    const token = peek();
    if (token && token.type === 'op') {
      consume();
      const right = parsePrimary();
      return { type: 'binary', op: token.value, left, right };
    }
    return left;
  }

  function parseAnd() {
    let expr = parseComparison();
    while (peek() && peek().type === 'logic' && peek().value === 'and') {
      consume();
      const right = parseComparison();
      expr = { type: 'logic', op: 'and', left: expr, right };
    }
    return expr;
  }

  function parseOr() {
    let expr = parseAnd();
    while (peek() && peek().type === 'logic' && peek().value === 'or') {
      consume();
      const right = parseAnd();
      expr = { type: 'logic', op: 'or', left: expr, right };
    }
    return expr;
  }

  const expr = parseOr();
  if (index < tokens.length) {
    throw new Error('Unexpected tokens in condition.');
  }
  return expr;
}
