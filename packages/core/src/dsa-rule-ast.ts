/**
 * Day 19 Fintech DSA — Safe Expression Tree (AST) Evaluator for Data-Driven Risk Rules
 *
 * Allows risk analysts (or schema-validated LLM rule compilers) to deploy complex
 * nested fraud rules as JSON ASTs without ever executing untrusted code via `eval()`.
 *
 * Time Complexity: O(K) where K is the number of nodes in the expression tree.
 */

export type RuleComparisonOp = "GT" | "GTE" | "LT" | "LTE" | "EQ" | "NEQ" | "IN";

export type RiskRuleAstNode =
  | {
      type: "AND" | "OR";
      children: RiskRuleAstNode[];
    }
  | {
      type: "NOT";
      child: RiskRuleAstNode;
    }
  | {
      type: "CMP";
      field: string;
      op: RuleComparisonOp;
      value: number | string | boolean | Array<number | string>;
    };

const ALLOWED_OPS = new Set<RuleComparisonOp>(["GT", "GTE", "LT", "LTE", "EQ", "NEQ", "IN"]);

export function validateRiskRuleAst(
  node: RiskRuleAstNode,
  allowedFields?: Set<string>,
  depth = 0
): void {
  if (depth > 12) {
    throw new Error("Risk rule AST exceeds maximum nesting depth (12)");
  }
  if (!node || typeof node !== "object") {
    throw new Error("Invalid AST node");
  }

  if (node.type === "AND" || node.type === "OR") {
    if (!Array.isArray(node.children) || node.children.length === 0) {
      throw new Error(`${node.type} node must have at least one child`);
    }
    for (const child of node.children) {
      validateRiskRuleAst(child, allowedFields, depth + 1);
    }
    return;
  }

  if (node.type === "NOT") {
    validateRiskRuleAst(node.child, allowedFields, depth + 1);
    return;
  }

  if (node.type === "CMP") {
    if (!node.field || typeof node.field !== "string") {
      throw new Error("CMP node missing valid field name");
    }
    if (allowedFields && !allowedFields.has(node.field)) {
      throw new Error(`Disallowed risk feature field "${node.field}"`);
    }
    if (!ALLOWED_OPS.has(node.op)) {
      throw new Error(`Unsupported comparison operator "${String(node.op)}"`);
    }
    if (node.op === "IN" && !Array.isArray(node.value)) {
      throw new Error(`IN operator requires an array value for field "${node.field}"`);
    }
    return;
  }

  throw new Error(`Unknown AST node type "${String((node as { type?: unknown }).type)}"`);
}

export function evaluateRiskRuleAst(
  node: RiskRuleAstNode,
  features: Record<string, number | string | boolean>
): boolean {
  if (node.type === "AND") {
    for (const child of node.children) {
      if (!evaluateRiskRuleAst(child, features)) {
        return false; // Short-circuit
      }
    }
    return true;
  }

  if (node.type === "OR") {
    for (const child of node.children) {
      if (evaluateRiskRuleAst(child, features)) {
        return true; // Short-circuit
      }
    }
    return false;
  }

  if (node.type === "NOT") {
    return !evaluateRiskRuleAst(node.child, features);
  }

  if (node.type !== "CMP") {
    return false;
  }

  const actual = features[node.field];
  if (actual === undefined) {
    return false;
  }

  switch (node.op) {
    case "GT":
      return typeof actual === "number" && typeof node.value === "number" && actual > node.value;
    case "GTE":
      return typeof actual === "number" && typeof node.value === "number" && actual >= node.value;
    case "LT":
      return typeof actual === "number" && typeof node.value === "number" && actual < node.value;
    case "LTE":
      return typeof actual === "number" && typeof node.value === "number" && actual <= node.value;
    case "EQ":
      return actual === node.value;
    case "NEQ":
      return actual !== node.value;
    case "IN":
      return Array.isArray(node.value) && node.value.includes(actual as never);
  }
}
