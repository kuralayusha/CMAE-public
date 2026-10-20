import { getDb } from "../lib/db/client";

getDb();
console.log("SQLite migrations applied (schema_migrations + app tables).");
