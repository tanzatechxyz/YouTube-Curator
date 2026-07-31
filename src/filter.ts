import { getSetting, type AppDatabase } from "./db.js";

export interface VideoCandidate {
  videoId: string;
  channelId: string;
  channelTitle: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
}

export interface FilterRule {
  id: number;
  name: string;
  action: "accept" | "reject";
  field: "title" | "description" | "channel" | "duration";
  operator:
    | "contains"
    | "not_contains"
    | "equals"
    | "regex"
    | "less_than"
    | "at_most"
    | "at_least"
    | "greater_than";
  value: string;
  playlistIds: string[];
}

export interface FilterDecision {
  outcome: "accept" | "reject";
  reason: string;
  playlistIds: string[];
  ruleId?: number;
}

function textFieldValue(rule: FilterRule, video: VideoCandidate): string {
  switch (rule.field) {
    case "title":
      return video.title;
    case "description":
      return video.description;
    case "channel":
      return video.channelTitle;
    case "duration":
      return "";
  }
}

function matches(rule: FilterRule, video: VideoCandidate): boolean {
  if (rule.field === "duration") {
    if (video.durationSeconds === undefined) {
      return false;
    }
    const thresholdSeconds = Math.round(Number.parseFloat(rule.value) * 60);
    if (!Number.isFinite(thresholdSeconds)) {
      return false;
    }
    switch (rule.operator) {
      case "less_than":
        return video.durationSeconds < thresholdSeconds;
      case "at_most":
        return video.durationSeconds <= thresholdSeconds;
      case "equals":
        return video.durationSeconds === thresholdSeconds;
      case "at_least":
        return video.durationSeconds >= thresholdSeconds;
      case "greater_than":
        return video.durationSeconds > thresholdSeconds;
      default:
        return false;
    }
  }

  const candidate = textFieldValue(rule, video);
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
    default:
      return false;
  }
}

function describe(rule: FilterRule): string {
  if (rule.field === "duration") {
    const operators: Partial<Record<FilterRule["operator"], string>> = {
      less_than: "is shorter than",
      at_most: "is at most",
      equals: "is exactly",
      at_least: "is at least",
      greater_than: "is longer than",
    };
    const operator = operators[rule.operator] ?? rule.operator;
    return `Rule “${rule.name}”: duration ${operator} ${rule.value} minutes`;
  }
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
