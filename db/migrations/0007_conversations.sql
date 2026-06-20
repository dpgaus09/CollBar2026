-- Persisted "Ask CollBar" conversations.
-- Stores each user's assistant threads so they survive refresh / re-login.

CREATE TABLE IF NOT EXISTS conversations (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id),
  title       text NOT NULL,
  created_at  timestamptz DEFAULT NOW(),
  updated_at  timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
  ON conversations (user_id, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id              bigserial PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL,
  content         text NOT NULL,
  results         jsonb,
  created_at      timestamptz DEFAULT NOW(),
  CONSTRAINT messages_role_check CHECK (role IN ('user','assistant'))
);

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON messages (conversation_id, created_at);
