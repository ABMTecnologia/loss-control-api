-- CreateIndex
CREATE INDEX "Goal_companyId_categoryId_periodStart_periodEnd_idx" ON "Goal"("companyId", "categoryId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "Goal_companyId_sectorId_periodStart_periodEnd_idx" ON "Goal"("companyId", "sectorId", "periodStart", "periodEnd");

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_sectorId_fkey" FOREIGN KEY ("sectorId") REFERENCES "Sector"("id") ON DELETE SET NULL ON UPDATE CASCADE;
