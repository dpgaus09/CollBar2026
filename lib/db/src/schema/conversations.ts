import {
  pgTable,
  bigserial,
  bigint,
  text,
  jsonb,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

// A saved "Ask CollBar" thread. One row per conversation, owned by a user.
// The thread's turns live in `messages` (ordered by created_at).
export const conversationsTable = pgTable(
  "conversations",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    userId: bigint("user_id", { mode: "bigint" })
      .notNull()
      .references(() => usersTable.id),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    // Listing a user's conversations newest-first is the hot path.
    index("conversations_user_updated_idx").on(t.userId, t.updatedAt),
  ],
);

// A single turn in a conversation. `role` distinguishes the user's question
// from the assistant's prose answer; `results` carries the grounded result
// cards that accompany an assistant answer (null for user turns).
export const messagesTable = pgTable(
  "messages",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    conversationId: bigint("conversation_id", { mode: "bigint" })
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    results: jsonb("results"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("messages_conversation_created_idx").on(
      t.conversationId,
      t.createdAt,
    ),
    check("messages_role_check", sql`${t.role} IN ('user','assistant')`),
  ],
);

export type Conversation = typeof conversationsTable.$inferSelect;
export type Message = typeof messagesTable.$inferSelect;
