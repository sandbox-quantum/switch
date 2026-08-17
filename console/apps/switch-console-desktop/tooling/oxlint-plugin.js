const TOOLING_IMPORT_MESSAGE = '@tooling imports are only allowed in test files.';

const RAW_ERROR_TEXT_MESSAGE =
  'Do not turn a caught error into display text by hand. Use describeFailure (title + description) or failureText from @renderer/lib/errors/describe-failure, so the user reads a sentence and the raw detail is moved rather than deleted.';

/** `String(x)`. */
function isStringCall(node) {
  return (
    node?.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'String'
  );
}

/** `x.message`, for any `x`. */
function isMessageAccess(node) {
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.property?.type === 'Identifier' &&
    node.property.name === 'message'
  );
}

/** `x instanceof Error`. */
function isInstanceofError(node) {
  return (
    node?.type === 'BinaryExpression' &&
    node.operator === 'instanceof' &&
    node.right?.type === 'Identifier' &&
    node.right.name === 'Error'
  );
}

/**
 * The idiom this bans is `e instanceof Error ? e.message : String(e)`.
 *
 * It appeared 114 times across the app and is the mechanism behind almost every
 * finding in the CHOO-2060 audit: it produces a string that is either a raw
 * exception or `[object Object]`, and every call site then rendered it straight
 * at the user. Banning the shape rather than the rendering keeps the rule
 * unambiguous — there is no legitimate reason to build display text this way in
 * the renderer now that the shared boundary exists.
 */
function isRawErrorStringification(node) {
  if (!isInstanceofError(node.test)) return false;
  const branches = [node.consequent, node.alternate];
  return (
    branches.some((branch) => isMessageAccess(branch)) &&
    branches.some((branch) => isStringCall(branch) || branch?.type === 'Literal')
  );
}

function isToolingImport(value) {
  return value === '@tooling' || value.startsWith('@tooling/');
}

function checkSource(context, node) {
  const source = node.source?.value;
  if (typeof source !== 'string' || !isToolingImport(source)) return;

  context.report({
    node,
    messageId: 'restricted',
  });
}

export default {
  meta: {
    name: 'switch-console',
  },
  rules: {
    'no-tooling-imports': {
      meta: {
        type: 'problem',
        messages: {
          restricted: TOOLING_IMPORT_MESSAGE,
        },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            checkSource(context, node);
          },
          ExportNamedDeclaration(node) {
            checkSource(context, node);
          },
          ExportAllDeclaration(node) {
            checkSource(context, node);
          },
        };
      },
    },
    'no-raw-error-text': {
      meta: {
        type: 'problem',
        messages: {
          rawErrorText: RAW_ERROR_TEXT_MESSAGE,
        },
      },
      create(context) {
        return {
          ConditionalExpression(node) {
            if (!isRawErrorStringification(node)) return;
            context.report({ node, messageId: 'rawErrorText' });
          },
        };
      },
    },
  },
};
