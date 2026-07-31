export type RuleFieldKind =
  | "text"
  | "list"
  | "number"
  | "boolean"
  | "enum"
  | "date";

export type RuleOperator =
  | "contains"
  | "not_contains"
  | "equals"
  | "not_equals"
  | "regex"
  | "less_than"
  | "at_most"
  | "at_least"
  | "greater_than"
  | "before"
  | "on_or_before"
  | "on_or_after"
  | "after"
  | "is_empty"
  | "is_not_empty";

export interface RuleChoice {
  value: string;
  label: string;
}

export interface RuleFieldDefinition {
  key: string;
  label: string;
  group: string;
  kind: RuleFieldKind;
  help: string;
  placeholder?: string;
  unit?: string;
  min?: number;
  max?: number;
  choices?: readonly RuleChoice[];
}

export interface RuleOperatorDefinition {
  key: RuleOperator;
  label: string;
}

const BOOLEAN_CHOICES = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
] as const;

export const RULE_FIELD_GROUPS = [
  "Identity and publishing",
  "Content details",
  "Engagement",
  "Visibility and rights",
  "Topics and recording",
  "Live streams",
] as const;

export const RULE_FIELDS = [
  {
    key: "channel",
    label: "Channel name",
    group: "Identity and publishing",
    kind: "text",
    help: "The publishing channel's display name.",
    placeholder: "e.g. Practical Engineering",
  },
  {
    key: "channel_id",
    label: "Channel ID",
    group: "Identity and publishing",
    kind: "text",
    help: "The stable YouTube channel ID, which is safer than a name after renames.",
    placeholder: "e.g. UC...",
  },
  {
    key: "video_id",
    label: "Video ID",
    group: "Identity and publishing",
    kind: "text",
    help: "The video's stable YouTube ID.",
    placeholder: "e.g. dQw4w9WgXcQ",
  },
  {
    key: "title",
    label: "Title",
    group: "Identity and publishing",
    kind: "text",
    help: "The video's title when it was discovered.",
    placeholder: "Text or regular expression",
  },
  {
    key: "description",
    label: "Description",
    group: "Identity and publishing",
    kind: "text",
    help: "The video's full description when it was discovered.",
    placeholder: "Text or regular expression",
  },
  {
    key: "tags",
    label: "Tags",
    group: "Identity and publishing",
    kind: "list",
    help: "Matches any keyword tag returned by YouTube.",
    placeholder: "e.g. tutorial",
  },
  {
    key: "category_id",
    label: "Category ID",
    group: "Identity and publishing",
    kind: "text",
    help: "The numeric YouTube video-category ID.",
    placeholder: "e.g. 27",
  },
  {
    key: "default_language",
    label: "Default metadata language",
    group: "Identity and publishing",
    kind: "text",
    help: "The BCP-47 language code for the title and description.",
    placeholder: "e.g. en or en-AU",
  },
  {
    key: "default_audio_language",
    label: "Default audio language",
    group: "Identity and publishing",
    kind: "text",
    help: "The BCP-47 language code for the default audio track.",
    placeholder: "e.g. en or ja",
  },
  {
    key: "published_at",
    label: "Published date (UTC)",
    group: "Identity and publishing",
    kind: "date",
    help: "The UTC calendar date on which YouTube says the video was published.",
  },
  {
    key: "thumbnail_url",
    label: "Thumbnail URL",
    group: "Identity and publishing",
    kind: "text",
    help: "The best thumbnail URL returned for the video.",
    placeholder: "URL text or regular expression",
  },
  {
    key: "duration",
    label: "Duration",
    group: "Content details",
    kind: "number",
    help: "Video length in minutes; decimals such as 12.5 are supported.",
    placeholder: "e.g. 20",
    unit: "minutes",
    min: 0,
  },
  {
    key: "content_type",
    label: "Content type",
    group: "Content details",
    kind: "enum",
    help:
      "YouTube does not expose an exact Shorts flag or public source aspect ratio. Curator treats videos up to 3 minutes long as Short candidates.",
    choices: [
      {
        value: "short_candidate",
        label: "Short candidate (3 minutes or less)",
      },
      {
        value: "standard_video",
        label: "Standard video (more than 3 minutes)",
      },
    ],
  },
  {
    key: "definition",
    label: "Definition",
    group: "Content details",
    kind: "enum",
    help: "Whether YouTube reports an HD or SD version.",
    choices: [
      { value: "hd", label: "HD" },
      { value: "sd", label: "SD" },
    ],
  },
  {
    key: "dimension",
    label: "Dimension",
    group: "Content details",
    kind: "enum",
    help: "Whether the video is two- or three-dimensional.",
    choices: [
      { value: "2d", label: "2D" },
      { value: "3d", label: "3D" },
    ],
  },
  {
    key: "captions",
    label: "Captions available",
    group: "Content details",
    kind: "boolean",
    help: "Whether YouTube reports captions for the video.",
    choices: BOOLEAN_CHOICES,
  },
  {
    key: "licensed_content",
    label: "Licensed content",
    group: "Content details",
    kind: "boolean",
    help: "Whether YouTube marks the video as licensed content.",
    choices: BOOLEAN_CHOICES,
  },
  {
    key: "projection",
    label: "Projection format",
    group: "Content details",
    kind: "enum",
    help: "The standard or 360-degree projection format.",
    choices: [
      { value: "rectangular", label: "Standard (rectangular)" },
      { value: "360", label: "360°" },
    ],
  },
  {
    key: "allowed_regions",
    label: "Allowed regions",
    group: "Content details",
    kind: "list",
    help: "Matches any ISO country code in YouTube's allowed-region list.",
    placeholder: "e.g. AU",
  },
  {
    key: "blocked_regions",
    label: "Blocked regions",
    group: "Content details",
    kind: "list",
    help: "Matches any ISO country code in YouTube's blocked-region list.",
    placeholder: "e.g. US",
  },
  {
    key: "country_access_allowed",
    label: "Country access allowed by default",
    group: "Content details",
    kind: "boolean",
    help: "The legacy country-access policy's default value, when returned.",
    choices: BOOLEAN_CHOICES,
  },
  {
    key: "country_access_exceptions",
    label: "Country access exceptions",
    group: "Content details",
    kind: "list",
    help: "Country codes that are exceptions to the legacy access policy.",
    placeholder: "e.g. DE",
  },
  {
    key: "content_rating",
    label: "Content ratings",
    group: "Content details",
    kind: "list",
    help: "Matches rating names or values returned by any national rating scheme.",
    placeholder: "e.g. mpaaRating=pg13",
  },
  {
    key: "has_custom_thumbnail",
    label: "Custom thumbnail",
    group: "Content details",
    kind: "boolean",
    help: "Uploader-only metadata; normally empty for other channels.",
    choices: BOOLEAN_CHOICES,
  },
  {
    key: "view_count",
    label: "View count",
    group: "Engagement",
    kind: "number",
    help: "The view-count snapshot taken when the video was discovered.",
    placeholder: "e.g. 10000",
    min: 0,
  },
  {
    key: "like_count",
    label: "Like count",
    group: "Engagement",
    kind: "number",
    help: "The like-count snapshot, when public.",
    placeholder: "e.g. 500",
    min: 0,
  },
  {
    key: "dislike_count",
    label: "Dislike count",
    group: "Engagement",
    kind: "number",
    help: "Owner-only metadata; normally empty for subscribed channels.",
    placeholder: "e.g. 10",
    min: 0,
  },
  {
    key: "favorite_count",
    label: "Favorite count",
    group: "Engagement",
    kind: "number",
    help: "YouTube's favorite count, typically zero on modern videos.",
    placeholder: "e.g. 0",
    min: 0,
  },
  {
    key: "comment_count",
    label: "Comment count",
    group: "Engagement",
    kind: "number",
    help: "The comment-count snapshot, when comments are enabled.",
    placeholder: "e.g. 100",
    min: 0,
  },
  {
    key: "live_status",
    label: "Live broadcast status",
    group: "Visibility and rights",
    kind: "enum",
    help: "Whether the video is a normal upload, upcoming, or currently live.",
    choices: [
      { value: "none", label: "Not upcoming or live" },
      { value: "upcoming", label: "Upcoming" },
      { value: "live", label: "Live now" },
    ],
  },
  {
    key: "upload_status",
    label: "Upload status",
    group: "Visibility and rights",
    kind: "enum",
    help: "YouTube's processing state for the uploaded video.",
    choices: [
      { value: "deleted", label: "Deleted" },
      { value: "failed", label: "Failed" },
      { value: "processed", label: "Processed" },
      { value: "rejected", label: "Rejected" },
      { value: "uploaded", label: "Uploaded / processing" },
    ],
  },
  {
    key: "privacy_status",
    label: "Privacy status",
    group: "Visibility and rights",
    kind: "enum",
    help: "Whether the video is public, unlisted, or private.",
    choices: [
      { value: "public", label: "Public" },
      { value: "unlisted", label: "Unlisted" },
      { value: "private", label: "Private" },
    ],
  },
  {
    key: "license",
    label: "License",
    group: "Visibility and rights",
    kind: "enum",
    help: "The standard YouTube or Creative Commons license.",
    choices: [
      { value: "youtube", label: "Standard YouTube license" },
      { value: "creativeCommon", label: "Creative Commons" },
    ],
  },
  {
    key: "embeddable",
    label: "Embeddable",
    group: "Visibility and rights",
    kind: "boolean",
    help: "Whether the video can be embedded on another website.",
    choices: BOOLEAN_CHOICES,
  },
  {
    key: "public_stats_viewable",
    label: "Public statistics viewable",
    group: "Visibility and rights",
    kind: "boolean",
    help: "Whether extended watch-page statistics are public.",
    choices: BOOLEAN_CHOICES,
  },
  {
    key: "made_for_kids",
    label: "Made for kids",
    group: "Visibility and rights",
    kind: "boolean",
    help: "YouTube's made-for-kids classification.",
    choices: BOOLEAN_CHOICES,
  },
  {
    key: "self_declared_made_for_kids",
    label: "Uploader declared made for kids",
    group: "Visibility and rights",
    kind: "boolean",
    help: "Uploader-only self-declared made-for-kids metadata.",
    choices: BOOLEAN_CHOICES,
  },
  {
    key: "contains_synthetic_media",
    label: "Contains altered or synthetic media",
    group: "Visibility and rights",
    kind: "boolean",
    help: "Whether YouTube reports altered or synthetic media.",
    choices: BOOLEAN_CHOICES,
  },
  {
    key: "paid_product_placement",
    label: "Paid product placement",
    group: "Visibility and rights",
    kind: "boolean",
    help: "Owner-only paid-promotion metadata; normally empty for other channels.",
    choices: BOOLEAN_CHOICES,
  },
  {
    key: "scheduled_publish_at",
    label: "Scheduled publish date (UTC)",
    group: "Visibility and rights",
    kind: "date",
    help: "The scheduled publication date, when a private scheduled video exposes it.",
  },
  {
    key: "failure_reason",
    label: "Upload failure reason",
    group: "Visibility and rights",
    kind: "text",
    help: "The API failure reason for a failed upload, when visible.",
    placeholder: "Reason text",
  },
  {
    key: "rejection_reason",
    label: "Upload rejection reason",
    group: "Visibility and rights",
    kind: "text",
    help: "The API rejection reason for a rejected upload, when visible.",
    placeholder: "Reason text",
  },
  {
    key: "topic_ids",
    label: "Primary topic IDs",
    group: "Topics and recording",
    kind: "list",
    help: "Matches any primary Freebase topic ID returned by YouTube.",
    placeholder: "e.g. /m/04rlf",
  },
  {
    key: "relevant_topic_ids",
    label: "Relevant topic IDs",
    group: "Topics and recording",
    kind: "list",
    help: "Matches any related Freebase topic ID returned by YouTube.",
    placeholder: "e.g. /m/04rlf",
  },
  {
    key: "topic_categories",
    label: "Topic categories",
    group: "Topics and recording",
    kind: "list",
    help: "Matches any topic-category Wikipedia URL returned by YouTube.",
    placeholder: "e.g. Technology",
  },
  {
    key: "recording_date",
    label: "Recording date (UTC)",
    group: "Topics and recording",
    kind: "date",
    help: "The date the uploader says the video was recorded.",
  },
  {
    key: "recording_location",
    label: "Recording location description",
    group: "Topics and recording",
    kind: "text",
    help: "The uploader-provided recording-location description.",
    placeholder: "e.g. Melbourne",
  },
  {
    key: "location_latitude",
    label: "Recording latitude",
    group: "Topics and recording",
    kind: "number",
    help: "The uploader-provided recording latitude in degrees.",
    placeholder: "e.g. -37.8136",
    min: -90,
    max: 90,
  },
  {
    key: "location_longitude",
    label: "Recording longitude",
    group: "Topics and recording",
    kind: "number",
    help: "The uploader-provided recording longitude in degrees.",
    placeholder: "e.g. 144.9631",
    min: -180,
    max: 180,
  },
  {
    key: "location_altitude",
    label: "Recording altitude",
    group: "Topics and recording",
    kind: "number",
    help: "The uploader-provided recording altitude in metres.",
    placeholder: "e.g. 31",
    unit: "metres",
  },
  {
    key: "scheduled_start_at",
    label: "Scheduled live start date (UTC)",
    group: "Live streams",
    kind: "date",
    help: "The scheduled start date for a live broadcast.",
  },
  {
    key: "scheduled_end_at",
    label: "Scheduled live end date (UTC)",
    group: "Live streams",
    kind: "date",
    help: "The scheduled end date for a live broadcast, when set.",
  },
  {
    key: "actual_start_at",
    label: "Actual live start date (UTC)",
    group: "Live streams",
    kind: "date",
    help: "The actual start date for a live broadcast.",
  },
  {
    key: "actual_end_at",
    label: "Actual live end date (UTC)",
    group: "Live streams",
    kind: "date",
    help: "The actual end date for a completed live broadcast.",
  },
  {
    key: "concurrent_viewers",
    label: "Concurrent viewers",
    group: "Live streams",
    kind: "number",
    help: "The concurrent-viewer snapshot for a live broadcast, when visible.",
    placeholder: "e.g. 1000",
    min: 0,
  },
  {
    key: "active_live_chat_id",
    label: "Active live-chat ID",
    group: "Live streams",
    kind: "text",
    help: "The live-chat ID while a broadcast has an active chat.",
    placeholder: "Live-chat ID",
  },
] as const satisfies readonly RuleFieldDefinition[];

export type RuleField = (typeof RULE_FIELDS)[number]["key"];

export const RULE_OPERATORS: readonly RuleOperatorDefinition[] = [
  { key: "contains", label: "contains" },
  { key: "not_contains", label: "does not contain" },
  { key: "equals", label: "equals" },
  { key: "not_equals", label: "does not equal" },
  { key: "regex", label: "matches regular expression" },
  { key: "less_than", label: "is less than" },
  { key: "at_most", label: "is at most" },
  { key: "at_least", label: "is at least" },
  { key: "greater_than", label: "is greater than" },
  { key: "before", label: "is before" },
  { key: "on_or_before", label: "is on or before" },
  { key: "on_or_after", label: "is on or after" },
  { key: "after", label: "is after" },
  { key: "is_empty", label: "is unavailable / empty" },
  { key: "is_not_empty", label: "is available / not empty" },
] as const;

const OPERATORS_BY_KIND: Record<RuleFieldKind, readonly RuleOperator[]> = {
  text: [
    "contains",
    "not_contains",
    "equals",
    "not_equals",
    "regex",
    "is_empty",
    "is_not_empty",
  ],
  list: [
    "contains",
    "not_contains",
    "equals",
    "not_equals",
    "regex",
    "is_empty",
    "is_not_empty",
  ],
  number: [
    "less_than",
    "at_most",
    "equals",
    "not_equals",
    "at_least",
    "greater_than",
    "is_empty",
    "is_not_empty",
  ],
  boolean: ["equals", "is_empty", "is_not_empty"],
  enum: ["equals", "not_equals", "is_empty", "is_not_empty"],
  date: [
    "before",
    "on_or_before",
    "equals",
    "not_equals",
    "on_or_after",
    "after",
    "is_empty",
    "is_not_empty",
  ],
};

const FIELD_MAP = new Map<string, RuleFieldDefinition>(
  RULE_FIELDS.map((field) => [field.key, field]),
);

const OPERATOR_MAP = new Map<RuleOperator, RuleOperatorDefinition>(
  RULE_OPERATORS.map((operator) => [operator.key, operator]),
);

export function getRuleField(value: string): RuleFieldDefinition | undefined {
  return FIELD_MAP.get(value);
}

export function getRuleOperator(
  value: string,
): RuleOperatorDefinition | undefined {
  return OPERATOR_MAP.get(value as RuleOperator);
}

export function operatorsForKind(
  kind: RuleFieldKind,
): readonly RuleOperator[] {
  return OPERATORS_BY_KIND[kind];
}

export function operatorNeedsValue(operator: RuleOperator): boolean {
  return operator !== "is_empty" && operator !== "is_not_empty";
}
