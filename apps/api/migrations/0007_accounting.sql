-- General ledger core: chart of accounts, fiscal periods, approved exchange rates and
-- double-entry journals. The chart, rates and rounding account are configuration that
-- finance owns; no accounts are seeded and nothing posts automatically from POS or
-- procurement until posting policy (ADR 005/006) is decided.

CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');

CREATE TABLE accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  code            text NOT NULL CHECK (code ~ '^[0-9A-Za-z.-]{1,20}$'),
  name            text NOT NULL,
  type            account_type NOT NULL,
  parent_id       uuid REFERENCES accounts(id),
  is_postable     boolean NOT NULL DEFAULT true,       -- false = header/group account
  currency        char(3) REFERENCES currencies(code), -- when set, only this transaction currency may post here
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, code),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TABLE accounting_settings (
  legal_entity_id       uuid PRIMARY KEY REFERENCES legal_entities(id),
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  fx_rounding_account_id uuid REFERENCES accounts(id)
);

CREATE TABLE fiscal_periods (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  name            text NOT NULL,
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_by       uuid REFERENCES users(id),
  closed_at       timestamptz,
  reopened_by     uuid REFERENCES users(id),
  reopened_at     timestamptz,
  reopen_reason   text,
  CHECK (end_date >= start_date),
  UNIQUE (legal_entity_id, name),
  EXCLUDE USING gist (legal_entity_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
);

-- Effective-dated rates with a source and maker-checker approval. 1 unit of from_currency = rate units of to_currency.
CREATE TABLE exchange_rates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  from_currency   char(3) NOT NULL REFERENCES currencies(code),
  to_currency     char(3) NOT NULL REFERENCES currencies(code),
  rate            numeric(20, 10) NOT NULL CHECK (rate > 0),
  effective_date  date NOT NULL,
  source          text NOT NULL CHECK (length(btrim(source)) >= 2),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_by      uuid NOT NULL REFERENCES users(id),
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (from_currency <> to_currency),
  CHECK (decided_by IS NULL OR decided_by <> created_by)
);
CREATE UNIQUE INDEX exchange_rates_live_idx ON exchange_rates (organization_id, from_currency, to_currency, effective_date) WHERE status <> 'rejected';

CREATE TABLE journal_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id     uuid NOT NULL REFERENCES legal_entities(id),
  journal_number      text,                                  -- assigned at posting, so posted numbers have no gaps
  posting_date        date NOT NULL,
  period_id           uuid REFERENCES fiscal_periods(id),
  description         text NOT NULL CHECK (length(btrim(description)) >= 3),
  source_type         text NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'reversal')),
  currency            char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate       numeric(20, 10),                       -- transaction -> functional, fixed at posting
  rate_id             uuid REFERENCES exchange_rates(id),
  rate_locked         boolean NOT NULL DEFAULT false,        -- reversals keep the original rate
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted')),
  created_by          uuid NOT NULL REFERENCES users(id),
  posted_by           uuid REFERENCES users(id),
  posted_at           timestamptz,
  reverses_entry_id   uuid UNIQUE REFERENCES journal_entries(id),
  reversed_by_entry_id uuid REFERENCES journal_entries(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, journal_number),
  CHECK (posted_by IS NULL OR posted_by <> created_by),
  CHECK (status = 'draft' OR (journal_number IS NOT NULL AND posted_by IS NOT NULL AND period_id IS NOT NULL AND exchange_rate IS NOT NULL))
);
CREATE INDEX journal_entries_entity_date_idx ON journal_entries (legal_entity_id, posting_date) WHERE status = 'posted';

CREATE TABLE journal_lines (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id                uuid NOT NULL REFERENCES journal_entries(id),
  line_no                 int NOT NULL,
  account_id              uuid NOT NULL REFERENCES accounts(id),
  debit_minor             bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),    -- transaction currency
  credit_minor            bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  functional_debit_minor  bigint CHECK (functional_debit_minor >= 0),            -- filled at posting
  functional_credit_minor bigint CHECK (functional_credit_minor >= 0),
  description             text,
  location_id             uuid REFERENCES locations(id),                         -- reporting dimension
  is_fx_rounding          boolean NOT NULL DEFAULT false,
  UNIQUE (entry_id, line_no),
  CHECK (
    (NOT is_fx_rounding AND ((debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0)))
    OR (is_fx_rounding AND debit_minor = 0 AND credit_minor = 0)
  )
);
CREATE INDEX journal_lines_account_idx ON journal_lines (account_id);

-- Posted journals are permanent. A correction is a reversal plus a new entry.
CREATE FUNCTION journal_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM journal_entries WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);
  IF s = 'posted' THEN
    RAISE EXCEPTION 'posted journal lines are immutable; post a reversal instead';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER journal_lines_immutable BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_guard();

CREATE FUNCTION journal_entries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN RAISE EXCEPTION 'posted journals cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'posted' THEN
    -- the only change allowed to a posted entry is linking its reversal, once
    IF OLD.reversed_by_entry_id IS NOT NULL
       OR (to_jsonb(NEW) - 'reversed_by_entry_id') IS DISTINCT FROM (to_jsonb(OLD) - 'reversed_by_entry_id') THEN
      RAISE EXCEPTION 'posted journals are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_guard();

CREATE FUNCTION journal_truncate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'journals cannot be truncated';
END;
$$;
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries FOR EACH STATEMENT EXECUTE FUNCTION journal_truncate_guard();
CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON journal_lines FOR EACH STATEMENT EXECUTE FUNCTION journal_truncate_guard();
