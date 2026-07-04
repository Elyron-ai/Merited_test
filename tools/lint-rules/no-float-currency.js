// XC-2: money is integer pence, rates are integer basis points — a float
// never touches a monetary value (BUILD-SPEC §0; CLAUDE.md house rule).
// The rule flags MONEY POSITIONS, not all decimals (0.5 as a pacing delay
// is fine; 20.5 as bps is a bug):
//
//  1. a non-integer numeric literal passed to `pence(...)`;
//  2. a non-integer numeric literal as the value of a property whose key
//     looks monetary (`*_pence`, `*_bps`, `*_x100`, `amount`);
//  3. a non-integer numeric literal initialising / assigned to a variable
//     with a monetary name;
//  4. `parseFloat` / `Number.parseFloat` ANYWHERE in one of those money
//     positions — parsing user input through a float is exactly how 20.5
//     bps crosses the wire (the control plane's intField exists for this).
//
// Test files are exempt: negative fixtures MUST write illegal payloads
// (`Money.parse({amount: 84.5})` throwing is the point of the test). The
// rule guards production code, where a float in a money position is always
// a bug.

const MONEY_NAME = /(_pence|_bps|_x100)$|^amount$/;

const isTestFile = (filename) =>
  /\.(test|spec)\.[jt]sx?$/.test(filename) ||
  /[\\/](test|tests|__tests__|contract-tests)[\\/]/.test(filename);

const keyName = (key) => {
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
};

const isNonIntegerLiteral = (node) =>
  node.type === 'Literal' && typeof node.value === 'number' && !Number.isInteger(node.value);

const isParseFloat = (node) => {
  if (node.type !== 'CallExpression') return false;
  const { callee } = node;
  if (callee.type === 'Identifier' && callee.name === 'parseFloat') return true;
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'Number' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'parseFloat'
  );
};

// A float can hide one level down (unary minus, `?? 0`, ternary arms) —
// unwrap the cheap wrappers before judging.
const unwrap = (node) => {
  if (!node) return [];
  if (node.type === 'UnaryExpression') return unwrap(node.argument);
  if (node.type === 'ConditionalExpression') return [...unwrap(node.consequent), ...unwrap(node.alternate)];
  if (node.type === 'LogicalExpression') return [...unwrap(node.left), ...unwrap(node.right)];
  return [node];
};

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'money is integer pence and rates are integer bps — floats never touch a monetary value (XC-2, BUILD-SPEC §0)',
    },
    messages: {
      floatMoney:
        "non-integer number in a money position ('{{context}}') — money is integer pence, rates integer bps; floats never touch a monetary value",
      parseFloatMoney:
        "parseFloat feeding a money position ('{{context}}') — parse to an integer instead (whole pence / whole bps); floats never touch a monetary value",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (isTestFile(filename)) return {};

    const check = (valueNode, positionName) => {
      for (const node of unwrap(valueNode)) {
        if (isNonIntegerLiteral(node)) {
          context.report({ node, messageId: 'floatMoney', data: { context: positionName } });
        } else if (isParseFloat(node)) {
          context.report({ node, messageId: 'parseFloatMoney', data: { context: positionName } });
        }
      }
    };

    return {
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'pence') {
          for (const argument of node.arguments) check(argument, 'pence()');
        }
      },
      Property(node) {
        const name = keyName(node.key);
        if (name && MONEY_NAME.test(name)) check(node.value, name);
      },
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && MONEY_NAME.test(node.id.name)) {
          check(node.init, node.id.name);
        }
      },
      AssignmentExpression(node) {
        const target =
          node.left.type === 'Identifier'
            ? node.left.name
            : node.left.type === 'MemberExpression' && node.left.property.type === 'Identifier'
              ? node.left.property.name
              : null;
        if (target && MONEY_NAME.test(target)) check(node.right, target);
      },
    };
  },
};
