import { defineRule, type ESTree } from "@oxlint/plugins";

const ELEMENTS = new Set(["SettingsRow", "SettingsSection"]);
const PROPS = new Set(["title", "description"]);

const MESSAGE = (element: string, prop: string) =>
  `${element} ${prop} draws text the settings search never sees. Add the row to the settings search index and spread \`searchableSetting(id)\`, or \`settingCopy(id)\` for a row drawn more than once.`;

type Node = ESTree.Node | ESTree.JSXElement["children"][number] | null | undefined;

const isWords = (text: string) => /\p{L}/u.test(text);

// Text written into the attribute itself; calls and identifiers read it from elsewhere.
const hasStaticText = (node: Node): boolean => {
  if (!node) return false;
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" && isWords(node.value);
    case "TemplateLiteral":
      return (
        node.quasis.some((quasi) => isWords(quasi.value.cooked ?? "")) ||
        node.expressions.some(hasStaticText)
      );
    case "JSXText":
      return isWords(node.value);
    case "JSXExpressionContainer":
      return node.expression.type !== "JSXEmptyExpression" && hasStaticText(node.expression);
    case "JSXElement":
    case "JSXFragment":
      return node.children.some(hasStaticText);
    case "ConditionalExpression":
      return hasStaticText(node.consequent) || hasStaticText(node.alternate);
    case "LogicalExpression":
    case "BinaryExpression":
      return hasStaticText(node.left) || hasStaticText(node.right);
    default:
      return false;
  }
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Settings rows and sections read their title and description from the settings search index, so search finds every row by the text it draws.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || !ELEMENTS.has(node.name.name)) return;
        for (const attribute of node.attributes) {
          if (attribute.type !== "JSXAttribute" || attribute.name.type !== "JSXIdentifier") {
            continue;
          }
          if (!PROPS.has(attribute.name.name) || !hasStaticText(attribute.value)) continue;
          context.report({
            node: attribute,
            message: MESSAGE(node.name.name, attribute.name.name),
          });
        }
      },
    };
  },
});
