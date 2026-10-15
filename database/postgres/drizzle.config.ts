import { defineConfig } from "drizzle-kit";
import * as dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  schema: "./drizzle/schema.ts",   // Path to your schema file
  out: "./drizzle/migrations",     // Migrations go inside migrations folder
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.PROJECT_DATABASE_URL!,
  },
});
