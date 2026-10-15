/** Nested string dictionary for locale packs. */
export type LocalePack = { [key: string]: string | LocalePack };

export type LocaleMeta = {
  code: string;
  updatedAt: string;
};

export const APP_LANGUAGE = "en" as const;
