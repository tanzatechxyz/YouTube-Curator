import { getSetting, type AppDatabase } from "./db.js";

export interface VideoCandidate {
  videoId: string;
  channelId: string;
  channelTitle: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl?: string;
}

export interface FilterRule {
  id: number;
  name: string;
  action: "accept" | "reject";
  field: "title" | "description" | "channel";
  operator: "contains" | "not_contains" | "equals" | "regex";
  value: string;
}

export interface FilterDecision {
  outcome: "accept" | "reject";
  reason: string;
  ruleId?: number;
}

function fieldValue(rule: FilterRule, video: VideoCandidate): string {
  switch (rule.field) {
    case "title":
      return video.title;
    case "description":
      return video.description;
    case "channel":
      return video.channelTitle;
  }
}

function matches(rule: FilterRule, video: VideoCandidate): boolean {
  const candidate = fieldValue(rule, video);
  const left = candidate.toLocaleLowerCase();
  const right = rule.value.toLocaleLowerCase();
  switch (rule.operator) {
    case "contains":
      return left.includes(right);
    case "not_contains":
      return !left.includes(right);
    case "equals":
      return left === right;
    case "regex":
      return new RegExp(rule.value, "i").test(candidate);
  }
}

function describe(rule: FilterRule): string {
  const field = rule.field === "channel" ? "channel name" : rule.field;
  const operator =
    rule.operator === "not_contains"
      ? "does not contain"
      : rule.operator === "regex"
        ? "matches regex"
        : rule.operator;
  return `Rule “${rule.name}”: ${field} ${operator} “${rule.value}”`;
}

export function evaluateRules(
  rules: FilterRule[],
  defaultOutcome: "accept" | "reject",
  video: VideoCandidate,
): FilterDecision {
  for (const rule of rules) {
    if (matches(rule, video)) {
      return {
        outcome: rule.action,
        reason: describe(rule),
        ruleId: rule.id,
      };
    }
  }
  return {
    outcome: defaultOutcome,
    reason: `No rule matched; default outcome is ${defaultOutcome}`,
  };
}

export function evaluateVideo(
  database: AppDatabase,
  video: VideoCandidate,
): FilterDecision {
  const rules = database
    .prepare(
      `SELECT id, name, action, field, operator, value
       FROM rules WHERE enabled = 1 ORDER BY priority, id`,
    )
    .all() as FilterRule[];
  const configuredDefault = getSetting(database, "default_outcome");
  const defaultOutcome =
    configuredDefault === "accept" ? "accept" : "reject";
  return evaluateRules(rules, defaultOutcome, video);
}
