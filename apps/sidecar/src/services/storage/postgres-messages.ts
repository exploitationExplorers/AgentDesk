import type { ChatMessage } from "@agentdesk/shared";
import type { PostgresUnitOfWork } from "../../db/postgres";
import type { MessageRepository } from "../conversation-store";

export const RUNNER_MESSAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS business_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,created_at TEXT NOT NULL,data JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS business_messages_conversation ON business_messages(conversation_id,created_at,id);
`;
export class PostgresMessages implements MessageRepository {
  constructor(private readonly db: PostgresUnitOfWork) {}
  async list(conversationId: string) {
    return (
      await this.db.query<{ data: ChatMessage }>(
        "SELECT data FROM business_messages WHERE conversation_id=$1 ORDER BY created_at,id",
        [conversationId],
      )
    ).rows.map((row) => row.data);
  }
  async insert(message: ChatMessage) {
    return this.db.transaction(async () => {
      await this.db.lock("task-state-transition");
      await this.db.query("INSERT INTO business_messages VALUES($1,$2,$3,$4)", [
        message.id,
        message.conversationId,
        message.createdAt,
        JSON.stringify(message),
      ]);
    });
  }
  async deleteProgress(conversationId: string) {
    await this.db.query(
      "UPDATE business_messages SET data=data-'display' WHERE conversation_id=$1",
      [conversationId],
    );
  }
}
