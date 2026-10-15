/** Nested string dictionary for locale packs. */
export type LocalePack = { [key: string]: string | LocalePack };

export type LocaleMeta = {
  code: string;
  updatedAt: string;
  /** Fingerprint of shipped en.json when this pack was built — mismatch ⇒ retranslate. */
  enSourceHash?: string;
};

export const APP_LANGUAGE = "en" as const;
