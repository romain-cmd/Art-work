# Deliveries module

## Implementation contract

This module extends the existing Shopify app. All new customer-facing and representative-facing screens, delivery notes, email messages, validation messages and status labels must be in English. Existing artwork workflows must remain independent and unchanged.

### Required workflow

1. Select a Shopify order, regardless of whether it contains artwork.
2. Choose the actual quantities for this delivery. Several delivery notes may belong to one order.
3. Record the yacht, representative, scheduled date and package count.
4. Review the final item list on a phone or tablet, enter the receiver's name, role and reservations, then capture a touch signature.
5. Recheck the order and delivery quantities on the server before accepting the signature.
6. Store the signed document and its content snapshot privately, with a server timestamp and a cryptographic digest.
7. Download the signed PDF and explicitly send a copy to the verified recipient email.

### Safety boundaries

- Creating or signing a delivery note must not mark an order paid or create duplicate Shopify fulfillments.
- A signed note must never be modified by subsequent Shopify order edits.
- Cancelled orders and removed/refunded quantities require review before signing.
- Authorize every read and write for the correct shop; do not publish signatures or PDFs to Shopify Files.
- Mobile access, where provided, must be scoped, expiring and revocable. No permanent public signing URLs.
- A signature must cover the item list and the receiver's stated reservations.
- Reject empty signatures, invalid quantities, stale revisions and concurrent duplicate submissions.
- Never display a success state before the server confirms durable storage.
- Application receipt totals and Shopify fulfillment totals are separate concepts; existing deliveries outside this module must not be silently counted twice.

### Initial rollout

Development takes place on feature/delivery-notes-en. Build, migration, authorization and delivery-quantity checks must pass before production rollout. A real authenticated Shopify order, a physical phone/tablet and configured email delivery are required for final acceptance testing. No production readiness is implied by this specification alone.
