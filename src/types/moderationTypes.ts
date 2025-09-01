export type ModerationResult = {
  flagged?: boolean;
  categories?: Record<string, boolean>;
  category_scores?: Record<string, number>;
};

export type ModerationResponse = {
  results?: ModerationResult[];
};
