# ADR 014 — General ledger core (mechanics only)

- **Status:** Proposed (implemented in `apps/api`). This implements the *mechanics* of double-entry accounting. The policy decisions in ADR 005 (costing) and ADR 006 (functional currency, posting model) stay open and need qualified accounting sign-off.
- **Date:** 2026-10-19

## Decisions
1. **No seeded chart.** Accounts, fiscal periods, exchange rates and the FX rounding account are configuration owned by finance, per legal entity. Account types are asset, liability, equity, revenue and expense. Header accounts group children (same type) and cannot be posted to; accounts can be restricted to one currency; archiving stops new postings but keeps history.
2. **Journals are drafted, then posted by someone else.** A draft must already balance in its transaction currency. Posting needs `accounting.post`, cannot be done by the drafter (also a database CHECK), and runs in one transaction.
3. **Posting does five things atomically:** finds the fiscal period for the posting date (must exist and be open; the period row is locked `FOR SHARE` so a concurrent close waits); fixes the exchange rate; computes functional-currency amounts per line, rounded half-up; balances any functional rounding difference through the entity's FX rounding account (the difference may not exceed one minor unit per line, and posting fails if no rounding account is configured); and assigns the next `JE-` number. Numbers are given at posting, not at drafting, so posted numbers have no gaps and deleting drafts cannot create one.
4. **Posted journals are permanent**, enforced by triggers: lines cannot be inserted, changed or deleted once the entry is posted; the entry cannot change except to record its reversal once; nothing can be deleted or truncated. The API offers no edit or delete for posted entries.
5. **Corrections are reversals.** A reversal is a draft with debits and credits swapped, copying the original's exchange rate and locked to it, dated on or after the original. Someone else must post it, and a journal can be reversed once. Reversing at the original rate keeps the accounts netting to zero.
6. **Exchange rates are effective-dated, sourced, and maker-checker.** A rate is entered as pending and only an approved rate by a different person is used. A journal in a foreign currency cannot post without an approved rate on or before its posting date; the latest such rate is used. Rejected rates free their date.
7. **Periods.** Periods per entity cannot overlap (database exclusion constraint). A period cannot be closed while draft journals are dated inside it. Reopening needs a separate permission, a recorded reason, and a different person from whoever closed it. Closed periods reject postings.
8. **Reports** come from posted journals only, in the entity's functional currency: a trial balance (with the accounting-equation check) and an account ledger with running balance. Both are computed on demand.

## Not built / limitations
- **No automatic postings.** POS sales, receipts, returns, goods receipts and adjustments do not create journals. Which accounts they hit, and any inventory valuation or cost of sales, depend on ADR 005/006. Until then stock quantities and money are tracked in separate systems.
- Single legal entity per journal. No intercompany, consolidation, or translation of foreign operations.
- No year-end closing entries or retained-earnings rollover, no revaluation of foreign-currency balances, no realized/unrealized FX handling beyond rounding.
- No receivables/payables subledgers, bank reconciliation, payment allocation, tax ledgers, fixed assets, accruals, budgets or recurring journals.
- No financial statement layouts (balance sheet, income statement, cash flow). The trial balance is the only report.
- Reports are computed on demand from lines; period balance snapshots will be needed at volume.
- Approval is binary (drafter vs poster). There are no value thresholds, multi-step chains or attachments.
- Draft journals block closing a period; the lock on the period exists as a second line of defense.
