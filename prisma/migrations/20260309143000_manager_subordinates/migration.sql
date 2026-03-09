-- AlterTable
ALTER TABLE "User" ADD COLUMN "managedById" TEXT;

-- AlterTable
ALTER TABLE "Invite" ADD COLUMN "invitedById" TEXT;

-- CreateIndex
CREATE INDEX "User_managedById_idx" ON "User"("managedById");

-- CreateIndex
CREATE INDEX "Invite_invitedById_idx" ON "Invite"("invitedById");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_managedById_fkey" FOREIGN KEY ("managedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
