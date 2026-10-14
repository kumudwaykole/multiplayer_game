-- AlterTable
ALTER TABLE "guest_sessions" ADD COLUMN     "avatar" INTEGER[] DEFAULT ARRAY[0, 0, 0]::INTEGER[];
