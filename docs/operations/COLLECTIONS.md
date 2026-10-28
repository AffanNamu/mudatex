# Chasing overdue trade balances

For the accounts team and whoever approves trade accounts. Wholesale buyers order on account and pay later; this is how
Mudatex keeps track of who is late and nudges them, without anyone having to remember.

## What happens by itself
Once a day (and any time the worker runs) Mudatex looks at every unpaid order on account:

| When | What the business gets |
|---|---|
| 3 days before the due date | A friendly reminder with the amount and our bank details |
| 1 day late | "We have not yet received…" |
| 7 days late | A firmer reminder |
| 14 days late | A last reminder, asking for payment or a date |
| 30 days late (changeable per business) | The trade account is **put on hold** and the business is told |

Each invoice gets each reminder **once**. If the email service is down the reminder is simply tried again on the next round,
and if email is not set up at all nothing is sent (but holds still happen). Emails are written in the customer's language
(English, French or Hausa) with the same amounts and order numbers.

## The hold
- A business on hold has **no trade prices and cannot order on account**; it can still shop at normal prices and pay by
  bank transfer or card.
- The hold is lifted **automatically** as soon as nothing is overdue by the hold limit any more, which in practice means as
  soon as the late order is paid.
- Each business has its own limit, set where you approve it (Trade accounts → *Hold when overdue (days)*). **0 turns the
  automatic hold off** for that business (for example a trusted long-standing customer).
- A hold that a person set ("Put on hold" with a note) is never lifted by the system, and the system never touches it.
- If you approve a business again while it is still late, the automatic rule is back in charge and may hold it again at the
  next round. To keep a late-paying business trading on purpose, set its hold limit to 0.
- Every automatic hold and release is in the audit log, with no person's name on it.

## The Collections page (staff with trade-account rights)
- Totals by currency and by age: not yet due, 1–30, 31–60 and over 60 days late.
- Every business that owes something: held ones first, then the most late. *Orders* shows each unpaid order, how late it is
  and the last reminder it had.
- **Remind** sends one email listing everything the business owes, at once. It can be sent at most once a day per business.
- Payments are recorded on the order in *Online orders* as before; the page updates.

## Setting it up
Nothing extra: it uses the same email service as order emails (`RESEND_API_KEY`, `MAIL_FROM`) and runs with the daily job
on Vercel (or hourly if you run the worker). Until email is set up the page and the holds still work.
