import "dotenv/config";
import { PrismaClient, UserRole } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
  const company = await prisma.company.create({ data: { name: "Loss Control (Teste)" } });

  await prisma.user.create({
    data: {
      companyId: company.id,
      name: "Rodrigo",
      email: "r.monteiro.developer@gmail.com",
      password: "TEMP_CHANGE_ME",
      role: UserRole.COMPANY_ADMIN,
    },
  });

  console.log("Seed OK");
}

main().finally(async () => prisma.$disconnect());