CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OWNER_OUTBOUND', 'BOT_OUTBOUND', 'IGNORED');
CREATE TYPE "MessageKind" AS ENUM ('TEXT', 'CAPTION', 'STICKER', 'REACTION', 'SERVICE', 'UNSUPPORTED');
CREATE TYPE "MessageStatus" AS ENUM ('RECEIVED', 'SENT', 'EDITED', 'DELETED', 'FAILED');
CREATE TYPE "AccessRuleKind" AS ENUM ('ALLOW', 'DENY');
CREATE TYPE "ProcessedUpdateStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "ReplyJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'CANCELED');
CREATE TYPE "UnsupportedAttachmentPolicy" AS ENUM ('SKIP', 'NEUTRAL');
CREATE TYPE "AiProviderKind" AS ENUM ('OPENAI', 'GEMINI');

CREATE TABLE "BusinessConnection" (
    "id" TEXT NOT NULL,
    "ownerTelegramId" BIGINT NOT NULL,
    "ownerChatId" BIGINT NOT NULL,
    "ownerUsername" TEXT,
    "ownerFirstName" TEXT,
    "ownerLastName" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "canReply" BOOLEAN NOT NULL DEFAULT false,
    "rights" JSONB NOT NULL DEFAULT '{}',
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Chat" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "businessConnectionId" TEXT NOT NULL,
    "telegramChatId" BIGINT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'private',
    "username" TEXT,
    "title" TEXT,
    "peerTelegramId" BIGINT,
    "peerUsername" TEXT,
    "peerFirstName" TEXT,
    "peerLastName" TEXT,
    "manualMode" BOOLEAN NOT NULL DEFAULT false,
    "customStyle" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Message" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "chatId" UUID NOT NULL,
    "telegramMessageId" BIGINT NOT NULL,
    "lastUpdateId" BIGINT,
    "senderTelegramId" BIGINT,
    "direction" "MessageDirection" NOT NULL,
    "kind" "MessageKind" NOT NULL,
    "text" TEXT,
    "isFromBot" BOOLEAN NOT NULL DEFAULT false,
    "isOffline" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "status" "MessageStatus" NOT NULL DEFAULT 'RECEIVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GlobalSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "allowlistOnly" BOOLEAN NOT NULL DEFAULT false,
    "globalStyle" TEXT NOT NULL DEFAULT 'Отвечай дружелюбно, спокойно и естественно.',
    "minDelayMs" INTEGER NOT NULL DEFAULT 2000,
    "maxDelayMs" INTEGER NOT NULL DEFAULT 5000,
    "debounceMs" INTEGER NOT NULL DEFAULT 1200,
    "maxReplyChars" INTEGER NOT NULL DEFAULT 1000,
    "historyLimit" INTEGER NOT NULL DEFAULT 30,
    "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
    "scheduleStartMinute" INTEGER NOT NULL DEFAULT 480,
    "scheduleEndMinute" INTEGER NOT NULL DEFAULT 1380,
    "scheduleDays" TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Kyiv',
    "ignoreOneWord" BOOLEAN NOT NULL DEFAULT false,
    "ignoreReactions" BOOLEAN NOT NULL DEFAULT true,
    "ignoreStickers" BOOLEAN NOT NULL DEFAULT true,
    "ignoreServiceMessages" BOOLEAN NOT NULL DEFAULT true,
    "unsupportedAttachmentPolicy" "UnsupportedAttachmentPolicy" NOT NULL DEFAULT 'SKIP',
    "unsupportedAttachmentReply" TEXT NOT NULL DEFAULT 'Получил сообщение. Напишите, пожалуйста, текстом.',
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 15,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GlobalSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccessRule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "businessConnectionId" TEXT NOT NULL,
    "telegramChatId" BIGINT NOT NULL,
    "kind" "AccessRuleKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccessRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProcessedUpdate" (
    "updateId" BIGINT NOT NULL,
    "updateType" TEXT NOT NULL,
    "status" "ProcessedUpdateStatus" NOT NULL DEFAULT 'PROCESSING',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    CONSTRAINT "ProcessedUpdate_pkey" PRIMARY KEY ("updateId")
);

CREATE TABLE "ReplyJob" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "chatId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" "ReplyJobStatus" NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "sourceMessageId" BIGINT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReplyJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsageRecord" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "chatId" UUID NOT NULL,
    "provider" "AiProviderKind" NOT NULL,
    "model" TEXT NOT NULL,
    "responseId" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BusinessConnection_isEnabled_canReply_idx" ON "BusinessConnection"("isEnabled", "canReply");
CREATE UNIQUE INDEX "Chat_businessConnectionId_telegramChatId_key" ON "Chat"("businessConnectionId", "telegramChatId");
CREATE INDEX "Chat_telegramChatId_idx" ON "Chat"("telegramChatId");
CREATE INDEX "Chat_businessConnectionId_manualMode_idx" ON "Chat"("businessConnectionId", "manualMode");
CREATE UNIQUE INDEX "Message_chatId_telegramMessageId_key" ON "Message"("chatId", "telegramMessageId");
CREATE INDEX "Message_chatId_sentAt_idx" ON "Message"("chatId", "sentAt" DESC);
CREATE INDEX "Message_chatId_direction_deletedAt_idx" ON "Message"("chatId", "direction", "deletedAt");
CREATE UNIQUE INDEX "AccessRule_businessConnectionId_telegramChatId_kind_key" ON "AccessRule"("businessConnectionId", "telegramChatId", "kind");
CREATE INDEX "AccessRule_businessConnectionId_kind_idx" ON "AccessRule"("businessConnectionId", "kind");
CREATE UNIQUE INDEX "ReplyJob_chatId_key" ON "ReplyJob"("chatId");
CREATE INDEX "ReplyJob_status_dueAt_idx" ON "ReplyJob"("status", "dueAt");
CREATE INDEX "UsageRecord_chatId_createdAt_idx" ON "UsageRecord"("chatId", "createdAt" DESC);
CREATE INDEX "UsageRecord_provider_model_createdAt_idx" ON "UsageRecord"("provider", "model", "createdAt");

ALTER TABLE "Chat" ADD CONSTRAINT "Chat_businessConnectionId_fkey" FOREIGN KEY ("businessConnectionId") REFERENCES "BusinessConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessRule" ADD CONSTRAINT "AccessRule_businessConnectionId_fkey" FOREIGN KEY ("businessConnectionId") REFERENCES "BusinessConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReplyJob" ADD CONSTRAINT "ReplyJob_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
