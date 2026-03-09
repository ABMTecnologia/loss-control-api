import "dotenv/config";
import { PrismaClient, UserRole } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
  const adminEmail = (process.env.ADMIN_BOOTSTRAP_EMAIL ?? "gerencial@abm-tecnologia.com").trim().toLowerCase();
  const adminName = process.env.ADMIN_BOOTSTRAP_NAME ?? "Administrador ABM";

  const company = await prisma.company.create({ data: { name: "Loss Control (Teste)" } });

  await prisma.user.create({
    data: {
      companyId: company.id,
      name: adminName,
      email: adminEmail,
      password: null,
      role: UserRole.SUPER_ADMIN,
    },
  });

  console.log("Seed OK");
}

main().finally(async () => prisma.$disconnect());
