-- ============================================================
-- ShakTranslate - Supabase Schema
-- Run this in: Supabase Dashboard -> SQL Editor -> New Query
-- ============================================================

-- CONVERSATIONS table
CREATE TABLE IF NOT EXISTS public.conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT NOT NULL UNIQUE,
  host_user_id    TEXT,
  guest_user_id   TEXT,
  host_lang       TEXT,
  guest_lang      TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS conversations_host_user_idx  ON public.conversations (host_user_id);
CREATE INDEX IF NOT EXISTS conversations_guest_user_idx ON public.conversations (guest_user_id);
CREATE INDEX IF NOT EXISTS conversations_session_idx    ON public.conversations (session_id);

-- MESSAGES table
CREATE TABLE IF NOT EXISTS public.messages (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id          UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_user_id           TEXT,
  role                     TEXT,
  original_text            TEXT DEFAULT '',
  translated_text          TEXT DEFAULT '',
  original_audio_url       TEXT,
  translated_audio_url     TEXT,
  original_audio_offset_ms INT DEFAULT 0,
  sent_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx ON public.messages (conversation_id);
CREATE INDEX IF NOT EXISTS messages_sender_idx       ON public.messages (sender_user_id);
CREATE INDEX IF NOT EXISTS messages_sent_at_idx      ON public.messages (sent_at);

-- Disable RLS so service role key can read/write freely
ALTER TABLE public.conversations DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages      DISABLE ROW LEVEL SECURITY;
