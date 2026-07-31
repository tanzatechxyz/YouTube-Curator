import { getSetting, type AppDatabase } from "./db.js";
import {
  getRuleField,
  getRuleOperator,
  type RuleField,
  type RuleOperator,
} from "./rule-fields.js";

export type VideoMetadataValue = string | number | boolean | string[] | null;
export type VideoMetadata = Record<string, VideoMetadataValue>;

export interface VideoCandidate {
  videoId: string;
  channelId: string;
  channelTitle: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  metadata?: VideoMetadata;
}

export interface FilterRule {
  id: number;
  name: string;
  action: "accept" | "reject";
  field: RuleField;
  operator: RuleOperator;
  value: string;
  playlistIds: string[];
}

export interface FilterDecision {
  outcome: "accept" | "reject";
  reason: string;
  playlistIds: string[];
  ruleId?: number;
}

function candidateValue(
  field: RuleField,
  video: VideoCandidate,
): VideoMetadataValue | undefined {
  switch (field) {
    case "video_id":
      return video.videoId;
    case "channel_id":
      return video.channelId;
    case "channel":
      return video.channelTitle;
    case "title":
      return video.title;
    case "description":
      return video.description;
    case "published_at":
      return video.publishedAt;
    case "thumbnail_url":
      return video.thumbnailUrl;
    case "duration":
      return video.durationSeconds === undefined
        ? undefined
        : video.durationSeconds / 60;
    default:
      return video.metadata?.[field];
  }
}

function isEmpty(value: VideoMetadataValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function textValues(value: VideoMetadataValue): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return [String(value)];
}

function matchesText(
  operator: RuleOperator,
  expected: string,
  actual: VideoMetadataValue,
): boolean {
  const values = textValues(actual);
  const right = expected.toLocaleLowerCase();
  switch (operator) {
    case "contains":
      return values.some((value) => value.toLocaleLowerCase().includes(right));
    case "not_contains":
      return values.every((value) => !value.toLocaleLowerCase().includes(right));
    case "equals":
      return values.some((value) => value.toLocaleLowerCase() === right);
    case "not_equals":
      return values.every((value) => value.toLocaleLowerCase() !== right);
    case "regex":
      try {
        const expression = new RegExp(expected, "i");
        return values.some((value) => expression.test(value));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function matchesNumber(
  operator: RuleOperator,
  expected: string,
  actual: VideoMetadataValue,
): boolean {
  const left = typeof actual === "number" ? actual : Number(actual);
  const right = Number(expected);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return false;
  }
  switch (operator) {
    case "less_than":
      return left < right;
    case "at_most":
      return left <= right;
    case "equals":
      return left === right;
    case "not_equals":
      return left !== right;
    case "at_least":
      return left >= right;
    case "greater_than":
      return left > right;
    default:
      return false;
  }
}

function utcDate(value: string): string | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString().slice(0, 10)
    : undefined;
}

function matchesDate(
  operator: RuleOperator,
  expected: string,
  actual: VideoMetadataValue,
): boolean {
  const left = utcDate(String(actual));
  const right = utcDate(expected);
  if (!left || !right) {
    return false;
  }
  switch (operator) {
    case "before":
      return left < right;
    case "on_or_before":
      return left <= right;
    case "equals":
      return left === right;
    case "not_equals":
      return left !== right;
    case "on_or_after":
      return left >= right;
    case "after":
      return left > right;
    default:
      return false;
  }
}

function matches(rule: FilterRule, video: VideoCandidate): boolean {
  const field = getRuleField(rule.field);
  if (!field) {
    return false;
  }
  const actual = candidateValue(rule.field, video);
  if (rule.operator === "is_empty") {
    return isEmpty(actual);
  }
  if (rule.operator === "is_not_empty") {
    return !isEmpty(actual);
  }
  if (isEmpty(actual)) {
    return false;
  }
  const populated = actual as VideoMetadataValue;

  if (field.kind === "number") {
    return matchesNumber(rule.operator, rule.value, populated);
  }
  if (field.kind === "date") {
    return matchesDate(rule.operator, rule.value, populated);
  }
  return matchesText(rule.operator, rule.value, populated);
}

function describe(rule: FilterRule): string {
  const field = getRuleField(rule.field);
  const operator = getRuleOperator(rule.operator);
  const fieldLabel = field?.label ?? rule.field;
  const operatorLabel = operator?.label ?? rule.operator;
  if (rule.operator === "is_empty" || rule.operator === "is_not_empty") {
    return `Rule “${rule.name}”: ${fieldLabel} ${operatorLabel}`;
  }
  const choiceLabel = field?.choices?.find(
    (choice) => choice.value === rule.value,
  )?.label;
  const value = choiceLabel ?? rule.value;
  const suffix = field?.unit ? ` ${field.unit}` : "";
  const formatted =
    field?.kind === "number" ? `${value}${suffix}` : `“${value}”${suffix}`;
  return `Rule “${rule.name}”: ${fieldLabel} ${operatorLabel} ${formatted}`;
}

export function evaluateRules(
  rules: FilterRule[],
  defaultOutcome: "accept" | "reject",
  video: VideoCandidate,
  defaultPlaylistIds: string[] = [],
): FilterDecision {
  for (const rule of rules) {
    if (matches(rule, video)) {
      return {
        outcome: rule.action,
        reason: describe(rule),
        playlistIds: rule.action === "accept" ? rule.playlistIds : [],
        ruleId: rule.id,
      };
    }
  }
  return {
    outcome: defaultOutcome,
    reason: `No rule matched; default outcome is ${defaultOutcome}`,
    playlistIds: defaultOutcome === "accept" ? defaultPlaylistIds : [],
  };
}

function parsePlaylistIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function evaluateVideo(
  database: AppDatabase,
  video: VideoCandidate,
): FilterDecision {
  const rules = database
    .prepare(
      `SELECT id, name, action, field, operator, value, playlist_ids_json
       FROM rules WHERE enabled = 1 ORDER BY priority, id`,
    )
    .all() as Array<Omit<FilterRule, "playlistIds"> & {
    playlist_ids_json: string;
  }>;
  const configuredDefault = getSetting(database, "default_outcome");
  const defaultOutcome =
    configuredDefault === "accept" ? "accept" : "reject";
  return evaluateRules(
    rules.map((rule) => ({
      ...rule,
      playlistIds: parsePlaylistIds(rule.playlist_ids_json),
    })),
    defaultOutcome,
    video,
    parsePlaylistIds(
      getSetting(database, "selected_playlists_json") ?? "[]",
    ),
  );
}
