// Driver evaluation. Scripted expressions are parsed by a small, sandboxed
// arithmetic expression evaluator (no access to globals), supporting the
// common math functions and the variables defined on the driver.
import type { DocumentData, Driver, ObjectData } from '../data/types';
import { getValue } from '../data/rna';
import { Matrix4, Vector3, Quaternion, Euler } from 'three';
import { localMatrix } from '../eval/transform';

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  exp: Math.exp,
  log: (x, b) => (b ? Math.log(x) / Math.log(b) : Math.log(x)),
  radians: (x) => (x * Math.PI) / 180,
  degrees: (x) => (x * 180) / Math.PI,
  clamp: (x, a = 0, b = 1) => Math.max(a, Math.min(b, x)),
  lerp: (a, b, t) => a + (b - a) * t,
  int: Math.trunc,
  float: (x) => x,
  bool: (x) => (x ? 1 : 0),
  noise: (x) => Math.sin(x * 12.9898) * 0.5,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, True: 1, False: 0 };

type Node =
  | { t: 'num'; v: number }
  | { t: 'var'; n: string }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; f: string; args: Node[] }
  | { t: 'cond'; c: Node; a: Node; b: Node };

const cache = new Map<string, Node>();

export function parseExpression(src: string): Node {
  const hit = cache.get(src);
  if (hit) return hit;
  const toks = src.match(/\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+|[A-Za-z_][A-Za-z_0-9.]*|\*\*|==|!=|<=|>=|and|or|not|[-+*/%(),<>]/g) ?? [];
  let i = 0;
  const peek = () => toks[i],
    next = () => toks[i++];
  const expect = (t: string) => {
    if (next() !== t) throw new Error(`Expected ${t}`);
  };
  const ternary = (): Node => {
    const a = orExpr();
    if (peek() === 'if') {
      next();
      const c = orExpr();
      expect('else');
      const b = ternary();
      return { t: 'cond', c, a, b };
    }
    return a;
  };
  const orExpr = (): Node => {
    let a = andExpr();
    while (peek() === 'or') {
      next();
      a = { t: 'bin', op: 'or', a, b: andExpr() };
    }
    return a;
  };
  const andExpr = (): Node => {
    let a = notExpr();
    while (peek() === 'and') {
      next();
      a = { t: 'bin', op: 'and', a, b: notExpr() };
    }
    return a;
  };
  const notExpr = (): Node => (peek() === 'not' ? (next(), { t: 'un', op: 'not', a: notExpr() }) : cmp());
  const cmp = (): Node => {
    let a = sum();
    while (['<', '>', '<=', '>=', '==', '!='].includes(peek())) {
      const op = next();
      a = { t: 'bin', op, a, b: sum() };
    }
    return a;
  };
  const sum = (): Node => {
    let a = prod();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      a = { t: 'bin', op, a, b: prod() };
    }
    return a;
  };
  const prod = (): Node => {
    let a = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next();
      a = { t: 'bin', op, a, b: unary() };
    }
    return a;
  };
  const unary = (): Node => {
    if (peek() === '-') {
      next();
      return { t: 'un', op: '-', a: unary() };
    }
    if (peek() === '+') {
      next();
      return unary();
    }
    return power();
  };
  const power = (): Node => {
    const a = atom();
    if (peek() === '**') {
      next();
      return { t: 'bin', op: '**', a, b: unary() };
    }
    return a;
  };
  const atom = (): Node => {
    const tok = next();
    if (tok === undefined) throw new Error('Unexpected end of expression');
    if (tok === '(') {
      const e = ternary();
      expect(')');
      return e;
    }
    if (/^[\d.]/.test(tok)) return { t: 'num', v: parseFloat(tok) };
    if (/^[A-Za-z_]/.test(tok)) {
      const name = tok.replace(/^math\./, '');
      if (peek() === '(') {
        next();
        const args: Node[] = [];
        if (peek() !== ')') {
          args.push(ternary());
          while (peek() === ',') {
            next();
            args.push(ternary());
          }
        }
        expect(')');
        if (!FUNCS[name]) throw new Error(`Unknown function ${name}`);
        return { t: 'call', f: name, args };
      }
      return { t: 'var', n: name };
    }
    throw new Error(`Unexpected ${tok}`);
  };
  const node = ternary();
  if (i < toks.length) throw new Error(`Unexpected ${toks[i]}`);
  cache.set(src, node);
  return node;
}

export function evalExpression(node: Node, vars: Record<string, number>): number {
  switch (node.t) {
    case 'num':
      return node.v;
    case 'var':
      if (node.n in vars) return vars[node.n];
      if (node.n in CONSTS) return CONSTS[node.n];
      throw new Error(`Unknown variable ${node.n}`);
    case 'un':
      return node.op === '-' ? -evalExpression(node.a, vars) : evalExpression(node.a, vars) ? 0 : 1;
    case 'cond':
      return evalExpression(node.c, vars) ? evalExpression(node.a, vars) : evalExpression(node.b, vars);
    case 'call':
      return FUNCS[node.f](...node.args.map((a) => evalExpression(a, vars)));
    case 'bin': {
      const a = evalExpression(node.a, vars);
      if (node.op === 'and') return a ? evalExpression(node.b, vars) : a;
      if (node.op === 'or') return a ? a : evalExpression(node.b, vars);
      const b = evalExpression(node.b, vars);
      switch (node.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '%':
          return ((a % b) + b) % b;
        case '**':
          return a ** b;
        case '<':
          return +(a < b);
        case '>':
          return +(a > b);
        case '<=':
          return +(a <= b);
        case '>=':
          return +(a >= b);
        case '==':
          return +(a === b);
        case '!=':
          return +(a !== b);
      }
    }
  }
  return 0;
}

function transformValue(ob: ObjectData, type: string): number {
  const m = localMatrix(ob, new Matrix4());
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  m.decompose(p, q, s);
  const e = new Euler().setFromQuaternion(q, 'ZYX');
  switch (type) {
    case 'LOC_X':
      return p.x;
    case 'LOC_Y':
      return p.y;
    case 'LOC_Z':
      return p.z;
    case 'ROT_X':
      return e.x;
    case 'ROT_Y':
      return e.y;
    case 'ROT_Z':
      return e.z;
    case 'SCALE_X':
      return s.x;
    case 'SCALE_Y':
      return s.y;
    case 'SCALE_Z':
      return s.z;
  }
  return 0;
}

export function evaluateDriver(doc: DocumentData, owner: ObjectData, drv: Driver, frame: number): number {
  const vars: Record<string, number> = { frame };
  for (const v of drv.variables) {
    const t0 = v.targets[0];
    const target = t0?.id ? doc.objects[t0.id] : owner;
    let value = 0;
    if (v.type === 'SINGLE_PROP' && target) {
      const path = t0.data_path;
      const m = /^(.*)\[(\d+)\]$/.exec(path);
      const raw = m ? getValue(doc, target, m[1], Number(m[2])) : getValue(doc, target, path);
      value = typeof raw === 'number' ? raw : typeof raw === 'boolean' ? +raw : 0;
    } else if (v.type === 'TRANSFORMS' && target) value = transformValue(target, t0.transform_type ?? 'LOC_X');
    else if (v.type === 'LOC_DIFF') {
      const a = v.targets[0]?.id ? doc.objects[v.targets[0].id!] : undefined,
        b = v.targets[1]?.id ? doc.objects[v.targets[1].id!] : undefined;
      if (a && b) value = Math.hypot(a.location[0] - b.location[0], a.location[1] - b.location[1], a.location[2] - b.location[2]);
    } else if (v.type === 'ROTATION_DIFF') {
      // angle between the two objects' (local) orientations
      const a = v.targets[0]?.id ? doc.objects[v.targets[0].id!] : undefined,
        b = v.targets[1]?.id ? doc.objects[v.targets[1].id!] : undefined;
      if (a && b) {
        const qa = new Quaternion(),
          qb = new Quaternion();
        localMatrix(a, new Matrix4()).decompose(new Vector3(), qa, new Vector3());
        localMatrix(b, new Matrix4()).decompose(new Vector3(), qb, new Vector3());
        value = 2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb))));
      }
    }
    vars[v.name] = value;
  }
  const values = drv.variables.map((v) => vars[v.name]);
  switch (drv.type) {
    case 'AVERAGE':
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    case 'SUM':
      return values.reduce((a, b) => a + b, 0);
    case 'MIN':
      return values.length ? Math.min(...values) : 0;
    case 'MAX':
      return values.length ? Math.max(...values) : 0;
    case 'SCRIPTED':
      return evalExpression(parseExpression(drv.expression), vars);
  }
  return 0;
}
