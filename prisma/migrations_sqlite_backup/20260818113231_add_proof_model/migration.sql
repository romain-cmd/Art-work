-- CreateTable
CREATE TABLE "Proof" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personalizationId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'en_attente',
    "commentaireClient" TEXT,
    "token" TEXT NOT NULL,
    "envoyeLe" DATETIME,
    "reponduLe" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Proof_personalizationId_fkey" FOREIGN KEY ("personalizationId") REFERENCES "Personalization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Proof_token_key" ON "Proof"("token");
