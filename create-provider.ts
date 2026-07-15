import { env } from "../config/env.js";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";

export class SettingsService {
  public constructor(private readonly database: PrismaClient) {}

  public get() {
    return this.database.globalSettings.upsert({
      where: { id: "global" },
      create: {
        id: "global",
        timezone: env.DEFAULT_TIMEZONE,
      },
      update: {},
    });
  }

  public async update(data: Prisma.GlobalSettingsUpdateInput) {
    await this.get();
    return this.database.globalSettings.update({
      where: { id: "global" },
      data,
    });
  }
}
