# Live protocol regression fixtures

Source: read-only requests to Kiro's official portal and Stripe on 2026-09-07.

- `management-link.json` preserves the actual `/p/session?secret=...` URL shape. All query values are replaced.
- `management-denied.json` preserves the generic authorization error returned by the official management endpoint. It contains no account data.
- `stripe-subscriptions.json` is an allowlisted projection of a real response. Account/customer/payment fields are omitted; subscription/item IDs, paid-price ID, timestamps, and non-zero amounts are replaced. Public product names and the shared Free price are retained.
- `stripe-page-excerpt.html` is a reconstructed minimal excerpt from observed credential markers, not a full captured page. Both session ID and key are synthetic.

These fixtures never contain usable credentials, customer names, contact details, card information, or live management links. No subscription update request was made to create them.
