import type { PrismaClient } from "../generated/prisma/client.js";
import { AccessRuleKind } from "../generated/prisma/enums.js";

export class AccessService {
  public constructor(private readonly database: PrismaClient) {}

  public async getRules(
    businessConnectionId: string,
    telegramChatId: bigint,
  ): Promise<{ allowed: boolean; denied: boolean }> {
    const rules = await this.database.accessRule.findMany({
      where: { businessConnectionId, telegramChatId },
      select: { kind: true },
    });
    return {
      allowed: rules.some((rule) => rule.kind === AccessRuleKind.ALLOW),
      denied: rules.some((rule) => rule.kind === AccessRuleKind.DENY),
    };
  }

  public async setRule(
    businessConnectionId: string,
    telegramChatId: bigint,
    kind: "ALLOW" | "DENY",
  ): Promise<void> {
    const opposite =
      kind === AccessRuleKind.ALLOW ? AccessRuleKind.DENY : AccessRuleKind.ALLOW;
    await this.database.$transaction([
      this.database.accessRule.deleteMany({
        where: { businessConnectionId, telegramChatId, kind: opposite },
      }),
      this.database.accessRule.upsert({
        where: {
          businessConnectionId_telegramChatId_kind: {
            businessConnectionId,
            telegramChatId,
            kind,
          },
        },
        create: { businessConnectionId, telegramChatId, kind },
        update: {},
      }),
    ]);
  }
}
