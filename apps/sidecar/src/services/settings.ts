import { AppSettings } from "@agentdesk/shared";
import type { Db } from "../db/client";
import { Collection } from "../db/collection";

type SettingsDoc = AppSettings & { id: string };

export class SettingsService {
  private readonly store: Collection<SettingsDoc>;

  constructor(db: Db) {
    this.store = new Collection<SettingsDoc>(db, "settings");
  }

  get(): AppSettings {
    const { id: _id, ...rest } = this.store.get("app") ?? { id: "app" };
    return AppSettings.parse(rest);
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const next = AppSettings.parse({ ...this.get(), ...patch });
    this.store.put({ id: "app", ...next });
    return next;
  }
}
