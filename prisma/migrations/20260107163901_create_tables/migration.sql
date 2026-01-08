-- CreateTable
CREATE TABLE "account" (
    "phone_number" TEXT NOT NULL,
    "name" TEXT,
    "situacao" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("phone_number")
);

-- CreateTable
CREATE TABLE "contact" (
    "phone_number" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "account_phone" TEXT NOT NULL,

    CONSTRAINT "contact_pkey" PRIMARY KEY ("phone_number")
);

-- CreateTable
CREATE TABLE "conversa" (
    "id" TEXT NOT NULL,
    "phone_number_accounts" TEXT NOT NULL,
    "phone_number_contacts" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" TEXT NOT NULL,
    "conversa_id" TEXT NOT NULL,
    "type" TEXT,
    "phone" TEXT,
    "status" TEXT,
    "is_sent" BOOLEAN,
    "whatsapp_message_id" TEXT NOT NULL,
    "remote_jid" TEXT NOT NULL,
    "from_me" BOOLEAN NOT NULL,
    "direct_message" BOOLEAN NOT NULL DEFAULT false,
    "timestamp_original" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "raw_json" JSONB,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_temp" (
    "session" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_temp_pkey" PRIMARY KEY ("session")
);

-- CreateTable
CREATE TABLE "WaAuthCreds" (
    "sessionId" TEXT NOT NULL,
    "creds" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaAuthCreds_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "WaAuthKey" (
    "id" BIGSERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "value" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaAuthKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversa_phone_number_accounts_phone_number_contacts_key" ON "conversa"("phone_number_accounts", "phone_number_contacts");

-- CreateIndex
CREATE INDEX "message_conversa_id_idx" ON "message"("conversa_id");

-- CreateIndex
CREATE INDEX "message_remote_jid_timestamp_original_idx" ON "message"("remote_jid", "timestamp_original");

-- CreateIndex
CREATE UNIQUE INDEX "message_conversa_id_whatsapp_message_id_key" ON "message"("conversa_id", "whatsapp_message_id");

-- CreateIndex
CREATE INDEX "WaAuthKey_sessionId_category_keyId_idx" ON "WaAuthKey"("sessionId", "category", "keyId");

-- CreateIndex
CREATE UNIQUE INDEX "WaAuthKey_sessionId_category_keyId_key" ON "WaAuthKey"("sessionId", "category", "keyId");

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_account_phone_fkey" FOREIGN KEY ("account_phone") REFERENCES "account"("phone_number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversa" ADD CONSTRAINT "conversa_phone_number_accounts_fkey" FOREIGN KEY ("phone_number_accounts") REFERENCES "account"("phone_number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversa" ADD CONSTRAINT "conversa_phone_number_contacts_fkey" FOREIGN KEY ("phone_number_contacts") REFERENCES "contact"("phone_number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_conversa_id_fkey" FOREIGN KEY ("conversa_id") REFERENCES "conversa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
