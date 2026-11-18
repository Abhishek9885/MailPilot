import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { apiEnvironment } from "./environment.js";

export function createDatabaseClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export const prisma = createDatabaseClient(apiEnvironment.DATABASE_URL);

export async function checkDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
