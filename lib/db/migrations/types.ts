import type Database from "better-sqlite3";

export type Migration = {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
};
