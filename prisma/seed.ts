import { createDatabaseClient } from "../apps/api/src/database.js";
import { assertSafeDevelopmentSeedTarget } from "../apps/api/src/database-safety.js";

async function seedDevelopmentDatabase(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the development seed.");
  }

  assertSafeDevelopmentSeedTarget(databaseUrl, process.env.NODE_ENV);
  const database = createDatabaseClient(databaseUrl);

  try {
    await database.user.upsert({
      where: { emailNormalized: "demo.user@mailpilot.invalid" },
      create: { emailNormalized: "demo.user@mailpilot.invalid" },
      update: { status: "active" }
    });
    console.info("Development seed completed.");
  } finally {
    await database.$disconnect();
  }
}

seedDevelopmentDatabase().catch(() => {
  console.error("Development seed failed. Check the local database configuration.");
  process.exitCode = 1;
});
