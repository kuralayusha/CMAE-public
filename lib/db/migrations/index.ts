import { migration001Baseline } from "./001_baseline";
import { migration002Revision } from "./002_revision";
import type { Migration } from "./types";

export const MIGRATIONS: Migration[] = [
  migration001Baseline,
  migration002Revision,
];
