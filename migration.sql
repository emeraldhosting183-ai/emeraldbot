generator client {
  provider            = "prisma-client"
  output              = "../src/generated/prisma"
  runtime             = "nodejs"
  moduleFormat        = "esm"
  generatedFileExtension = "ts"
  importFileExtension = "ts"
}

datasource db {
  provider = "postgresql"
}

enum MessageDirection {
  INBOUND
  OWNER_OUTBOUND
  BOT_OUTBOUND
  IGNORED
}

enum MessageKind {
  TEXT
  CAPTION
  STICKER
  REACTION
  SERVICE
  UNSUPPORTED
}

enum MessageStatus {
  RECEIVED
  SENT
  EDITED
  DELETED
  FAILED
}

enum AccessRuleKind {
  ALLOW
  DENY
}

enum ProcessedUpdateStatus {
  PROCESSING
  COMPLETED
  FAILED
}

enum ReplyJobStatus {
  PENDING
  PROCESSING
  COMPLETED
  CANCELED
}

enum UnsupportedAttachmentPolicy {
  SKIP
  NEUTRAL
}

enum AiProviderKind {
  OPENAI
  GEMINI
}

model BusinessConnection {
  id                  String   @id
  ownerTelegramId     BigInt
  ownerChatId         BigInt
  ownerUsername       String?
  ownerFirstName      String?
  ownerLastName       String?
  connectedAt         DateTime
  isEnabled           Boolean  @default(false)
  canReply            Boolean  @default(false)
  rights              Json     @default("{}")
  lastCheckedAt       DateTime @default(now())
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  chats               Chat[]
  accessRules         AccessRule[]

  @@index([isEnabled, canReply])
}

model Chat {
  id                    String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  businessConnectionId  String
  telegramChatId        BigInt
  type                  String   @default("private")
  username              String?
  title                 String?
  peerTelegramId        BigInt?
  peerUsername          String?
  peerFirstName         String?
  peerLastName          String?
  manualMode            Boolean  @default(false)
  customStyle           String?  @db.Text
  lastInboundAt         DateTime?
  lastOutboundAt        DateTime?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  businessConnection    BusinessConnection @relation(fields: [businessConnectionId], references: [id], onDelete: Cascade)
  messages              Message[]
  replyJob              ReplyJob?
  usageRecords          UsageRecord[]

  @@unique([businessConnectionId, telegramChatId])
  @@index([telegramChatId])
  @@index([businessConnectionId, manualMode])
}

model Message {
  id                  String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  chatId              String           @db.Uuid
  telegramMessageId   BigInt
  lastUpdateId        BigInt?
  senderTelegramId    BigInt?
  direction           MessageDirection
  kind                MessageKind
  text                String?          @db.Text
  isFromBot           Boolean          @default(false)
  isOffline           Boolean          @default(false)
  sentAt              DateTime
  editedAt            DateTime?
  deletedAt           DateTime?
  status              MessageStatus    @default(RECEIVED)
  createdAt           DateTime         @default(now())
  updatedAt           DateTime         @updatedAt

  chat                Chat             @relation(fields: [chatId], references: [id], onDelete: Cascade)

  @@unique([chatId, telegramMessageId])
  @@index([chatId, sentAt(sort: Desc)])
  @@index([chatId, direction, deletedAt])
}

model GlobalSettings {
  id                          String                      @id @default("global")
  autoReplyEnabled            Boolean                     @default(true)
  allowlistOnly               Boolean                     @default(false)
  globalStyle                 String                      @default("Отвечай дружелюбно, спокойно и естественно.") @db.Text
  minDelayMs                  Int                         @default(2000)
  maxDelayMs                  Int                         @default(5000)
  debounceMs                  Int                         @default(1200)
  maxReplyChars               Int                         @default(1000)
  historyLimit                Int                         @default(30)
  scheduleEnabled             Boolean                     @default(false)
  scheduleStartMinute         Int                         @default(480)
  scheduleEndMinute           Int                         @default(1380)
  scheduleDays                String                      @default("0,1,2,3,4,5,6")
  timezone                    String                      @default("Europe/Kyiv")
  ignoreOneWord               Boolean                     @default(false)
  ignoreReactions             Boolean                     @default(true)
  ignoreStickers              Boolean                     @default(true)
  ignoreServiceMessages       Boolean                     @default(true)
  unsupportedAttachmentPolicy UnsupportedAttachmentPolicy @default(SKIP)
  unsupportedAttachmentReply  String                      @default("Получил сообщение. Напишите, пожалуйста, текстом.") @db.Text
  cooldownSeconds             Int                         @default(15)
  createdAt                   DateTime                    @default(now())
  updatedAt                   DateTime                    @updatedAt
}

model AccessRule {
  id                    String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  businessConnectionId  String
  telegramChatId        BigInt
  kind                  AccessRuleKind
  createdAt             DateTime        @default(now())

  businessConnection    BusinessConnection @relation(fields: [businessConnectionId], references: [id], onDelete: Cascade)

  @@unique([businessConnectionId, telegramChatId, kind])
  @@index([businessConnectionId, kind])
}

model ProcessedUpdate {
  updateId       BigInt                @id
  updateType     String
  status         ProcessedUpdateStatus @default(PROCESSING)
  attempt        Int                   @default(1)
  claimedAt      DateTime              @default(now())
  processedAt    DateTime?
  errorCode      String?
}

model ReplyJob {
  id              String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  chatId          String         @unique @db.Uuid
  revision        Int            @default(1)
  status          ReplyJobStatus @default(PENDING)
  dueAt           DateTime
  sourceMessageId BigInt?
  attempt         Int            @default(0)
  lockedAt        DateTime?
  leaseOwner      String?
  lastErrorCode   String?
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt

  chat            Chat           @relation(fields: [chatId], references: [id], onDelete: Cascade)

  @@index([status, dueAt])
}

model UsageRecord {
  id                  String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  chatId              String         @db.Uuid
  provider            AiProviderKind
  model               String
  responseId          String?
  inputTokens         Int            @default(0)
  outputTokens        Int            @default(0)
  totalTokens         Int            @default(0)
  estimatedCostUsd    Decimal        @default(0) @db.Decimal(18, 8)
  latencyMs           Int
  createdAt           DateTime       @default(now())

  chat                Chat           @relation(fields: [chatId], references: [id], onDelete: Cascade)

  @@index([chatId, createdAt(sort: Desc)])
  @@index([provider, model, createdAt])
}
