-- VIBE+ — Economy schema (PostgreSQL)
-- ملاحظة: الجداول دي مكمّلة للجداول الأساسية users / blocks / fraud_flags

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  external_id   TEXT UNIQUE,
  birth_date    DATE,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id BIGINT NOT NULL REFERENCES users(id),
  blocked_id BIGINT NOT NULL REFERENCES users(id),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS fraud_flags (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id),
  related_user_id BIGINT,
  reason         TEXT NOT NULL,
  ref_id         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id),
  coins      BIGINT NOT NULL DEFAULT 0 CHECK (coins >= 0),
  diamonds   BIGINT NOT NULL DEFAULT 0 CHECK (diamonds >= 0),   -- متاح للسحب
  pending_diamonds BIGINT NOT NULL DEFAULT 0 CHECK (pending_diamonds >= 0), -- محجوز فترة أمان
  frozen     BOOLEAN NOT NULL DEFAULT FALSE,                    -- تجميد عند الاشتباه
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- سجل ثابت: ممنوع UPDATE/DELETE عليه
CREATE TABLE IF NOT EXISTS ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  asset           TEXT   NOT NULL CHECK (asset IN ('coin','diamond')),
  amount          BIGINT NOT NULL CHECK (amount <> 0),          -- موجب = إضافة، سالب = خصم
  balance_after   BIGINT NOT NULL CHECK (balance_after >= 0),
  type            TEXT   NOT NULL,   -- purchase | gift_sent | gift_received | refund | payout | adjustment | task_reward
  ref_type        TEXT,
  ref_id          TEXT,
  idempotency_key TEXT   NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, asset, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_ledger_user_time ON ledger_entries (user_id, created_at DESC);

CREATE RULE ledger_no_update AS ON UPDATE TO ledger_entries DO INSTEAD NOTHING;
CREATE RULE ledger_no_delete AS ON DELETE TO ledger_entries DO INSTEAD NOTHING;

-- الباقات (السيرفر هو المرجع)
CREATE TABLE IF NOT EXISTS coin_products (
  product_id  TEXT PRIMARY KEY,          -- نفس ID في Google Play Console
  coins       BIGINT NOT NULL CHECK (coins > 0),
  bonus_coins BIGINT NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS purchases (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id),
  product_id     TEXT   NOT NULL REFERENCES coin_products(product_id),
  purchase_token TEXT   NOT NULL UNIQUE,     -- يمنع استخدام نفس الإيصال مرتين
  order_id       TEXT,
  coins_granted  BIGINT NOT NULL,
  status         TEXT   NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','refunded')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gifts (
  id            SMALLSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  price_coins   BIGINT NOT NULL CHECK (price_coins > 0),
  creator_share_bps INT NOT NULL DEFAULT 5000 CHECK (creator_share_bps BETWEEN 0 AND 10000), -- 5000 = 50%
  animation_url TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS gift_transactions (
  id              BIGSERIAL PRIMARY KEY,
  sender_id       BIGINT NOT NULL REFERENCES users(id),
  receiver_id     BIGINT NOT NULL REFERENCES users(id),
  gift_id         SMALLINT NOT NULL REFERENCES gifts(id),
  quantity        INT NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  coins_spent     BIGINT NOT NULL,
  diamonds_earned BIGINT NOT NULL,
  video_id        BIGINT,
  live_id         BIGINT,
  idempotency_key TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sender_id, idempotency_key),
  CHECK (sender_id <> receiver_id)
);

-- فترة حجز الماس (حماية من الـ chargeback والاحتيال)
CREATE TABLE IF NOT EXISTS diamond_holds (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  amount       BIGINT NOT NULL CHECK (amount > 0),
  release_at   TIMESTAMPTZ NOT NULL,
  released     BOOLEAN NOT NULL DEFAULT FALSE,
  gift_tx_id   BIGINT REFERENCES gift_transactions(id)
);
CREATE INDEX IF NOT EXISTS idx_holds_release ON diamond_holds (release_at) WHERE NOT released;

CREATE TABLE IF NOT EXISTS payouts (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  diamonds    BIGINT NOT NULL CHECK (diamonds > 0),
  amount_egp  NUMERIC(12,2) NOT NULL,
  method      TEXT NOT NULL CHECK (method IN ('vodafone_cash','instapay')),
  account_ref TEXT NOT NULL,                  -- يتخزن مشفّر
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','rejected')),
  reviewed_by BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS spending_limits (
  user_id       BIGINT PRIMARY KEY REFERENCES users(id),
  daily_limit   BIGINT,        -- بالكوين، NULL = بدون حد
  monthly_limit BIGINT
);
