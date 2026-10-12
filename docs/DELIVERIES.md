# Deliveries and signed delivery notes

This English-language module is independent of artwork cases. It reads real Shopify orders, not draft orders, and records the exact quantities received. It does not alter payment, fulfillment, inventory or delivery statuses in Shopify.

## Office workflow

1. Open **Art-Work Soft > Deliveries > Representatives**. Create the representative's access. Copy the private link and eight-digit code immediately and send them separately to that representative. Neither value can be recovered in plaintext from the database. Regenerating access invalidates previous links and sessions.
2. Choose **Create delivery note**, search for a Shopify order and select it. Choose the representative, date, packages and quantities physically being delivered. Quantities intentionally start at zero. Prices are never included.
3. Create the note. It appears in the representative's mobile portal. Unsigned notes reserve their quantities; subsequent notes cannot allocate those quantities again. An order can have multiple signed notes.
4. To change an unsigned note, cancel it with a reason and prepare a replacement from the latest order. The original remains in the activity history. A signed note cannot be changed or cancelled.
5. Open a signed note to download the exact stored PDF, inspect its recipient and reservations, check email status or retry a pending email.

## Representative workflow

Open the private link in Safari or Chrome on a phone or tablet and enter the code. The 12-hour session can only view and sign notes assigned to that representative. Search by yacht, customer or order number. Hand the device to the recipient only after opening the correct delivery note. The recipient reviews the items, records their name, role and reservations, signs with a finger/stylus, confirms the statement and checks the email address before saving.

An internet connection is required. The interface never treats a local drawing as proof of successful server storage. After a connection problem, reload the note and check whether it is already signed before retrying. The server uses an idempotency key to prevent duplicate signature commits.

## Data and safety

- Only `read_orders` is needed for existing integration. Protected customer data must be available to the application. Shopify's standard order-history limits still apply; older orders require approved `read_all_orders`. No additional order-writing permission is silently requested.
- Orders are read directly when searched/prepared and re-read immediately before signing. Pagination is explicit. Relevant order edits, cancellation and quantity changes block stale signatures. The source fingerprint ignores timestamps alone, but includes quantities, products, recipient details and address.
- The module does not import historical receipts or equate Shopify fulfillment with physical receipt. Historical deliveries outside this module must be reconciled before preparing quantities. Remaining quantities are not a global transport-management ledger.
- PostgreSQL advisory locks serialize allocations/signatures per order. A database transaction stores the final receipt, signed PDF and event together. Shopify itself is outside that database transaction; there is necessarily a small cross-system verification interval, not an atomic lock on Shopify order editing.
- Signed notes, evidence and PDF bytes have database-level immutability triggers. Corrections require a separate administrative record, not replacement of the signed document. The PDF is generated once, kept in private PostgreSQL storage and checked by SHA-256 on download. No signatures or PDFs are uploaded to Shopify Files or public object storage.
- Touch paths are validated numeric vectors, not uploaded executable SVG/HTML. PINs use salted scrypt, links/session tokens are stored as SHA-256 hashes, sessions use a Secure/HttpOnly cookie, forms enforce origin/CSRF checks, attempts are throttled, and access is revocable. Office actions require Shopify authentication.
- Captured signatures are ordinary evidence of receipt, not a qualified electronic-signature service or verified identity. Names and roles are declared by the recipient. Do not claim qualified signature or certified timestamping.
- Personal data, access tokens, signatures and PDF content must not be logged. Configure database backups, staff permissions, retention and a controlled privacy-request procedure before broad rollout. Immutability in the app is not an exemption from applicable deletion/retention obligations. The database is private storage, not a WORM-certified archive.

## Email behavior

The existing `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are used. The customer address is explicitly reviewed at signature. A successful signature is retained even if email fails. `SENT` means provider acceptance, not mailbox delivery or reading. Provider requests reuse a stable idempotency key and stored PDF. Interrupted attempts older than 20 hours stop for manual provider review rather than risking duplicate sends after Resend's 24-hour idempotency window. Pending emails can be retried from the office interface. There is no unattended email worker in this first version; a process crash may require that explicit retry.

## Installation and verification

Run `npm install`, `npx prisma generate`, `npx prisma migrate deploy`, `npm run test:deliveries` and `npm run build` in a non-production environment first. The additive migration does not rewrite artwork tables. Run integration tests only against a disposable database with `DELIVERY_TEST_DATABASE=1`. Test receipts contain fictional examples and cannot be deleted by ordinary application queries once signed, by design.

Required existing environment variables: `DATABASE_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`. `SHOPIFY_APP_URL` must match the production HTTPS origin exactly for form verification. Access links use this origin.

For rollout, verify a partial delivery, a changed Shopify order, an interrupted submission, a signed PDF, an actual test email to an authorized internal recipient and representative access revocation. Test on the actual iPhone/tablet. No native iOS application, offline capture, GPS tracking, photo upload, route optimization, qualified signature, automated fulfillment update or order-page extension is included in this version.

## Source references

- https://shopify.dev/docs/api/admin-graphql/2026-07/objects/LineItem
- https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders
- https://shopify.dev/docs/api/usage/access-scopes
- https://resend.com/docs/api-reference/emails/send-email
- https://resend.com/docs/dashboard/emails/idempotency-keys
- https://pdfmake.github.io/docs/0.1/getting-started/server-side/
