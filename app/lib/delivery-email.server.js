import { Resend } from "resend";
import { deliveryDocument } from "./delivery-notes.server.js";
async function sendWithResend(payload, options) {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL)
    throw new Error("Email service is not configured.");
  const result = await new Resend(process.env.RESEND_API_KEY).emails.send(
    payload,
    options,
  );
  if (result.error)
    throw new Error("Email provider did not confirm acceptance.");
  if (!result.data?.id)
    throw new Error("Email provider returned no message identifier.");
  return result.data.id;
}
export async function sendDeliveryEmail(db, shop, id, send = sendWithResend) {
  const note = await db.deliveryNote.findFirst({
    where: { id, shop, status: "SIGNED" },
  });
  if (
    !note ||
    ["SENT", "NOT_REQUESTED", "MANUAL_REVIEW"].includes(note.emailState)
  )
    return;
  const now = new Date();
  // Resend idempotency expires after 24 hours. Stop automatic retries earlier.
  if (
    note.emailFirstAttemptAt &&
    now - note.emailFirstAttemptAt > 20 * 3600000
  ) {
    await db.deliveryNote.updateMany({
      where: { id, emailState: { not: "SENT" } },
      data: {
        emailState: "MANUAL_REVIEW",
        emailError:
          "Check the email provider before resending. The safe retry window has ended.",
      },
    });
    return;
  }
  const claim = await db.deliveryNote.updateMany({
    where: {
      id,
      shop,
      emailState: { in: ["PENDING", "FAILED", "SENDING"] },
      OR: [
        { emailLockAt: null },
        { emailLockAt: { lt: new Date(now.getTime() - 5 * 60000) } },
      ],
    },
    data: {
      emailState: "SENDING",
      emailLockAt: now,
      emailFirstAttemptAt: note.emailFirstAttemptAt || now,
      emailError: null,
    },
  });
  if (!claim.count) return;
  try {
    const document = await deliveryDocument(db, shop, id);
    const officeEmail = process.env.DELIVERY_NOTIFICATION_EMAIL || "romain@marinayachtwear.com";
    const recipients = [...new Set([officeEmail, note.emailTo].filter(Boolean))];
    const emailId = await send(
      {
        from: note.emailFrom,
        to: recipients,
        subject: `Your signed delivery note ${note.snapshot.documentNumber} | Marina Yacht Wear`,
        text: `Hello ${note.receipt.name},\n\nPlease find attached your signed delivery note for order ${note.orderName}.\n\nThis document confirms the items and quantities received, together with any recorded reservations. It is not a payment receipt.\n\nThank you,\nMarina Yacht Wear`,
        attachments: [{ filename: document.filename, content: document.pdf }],
      },
      { idempotencyKey: `myw-delivery-${id}` },
    );
    await db.$transaction(async (tx) => {
      const marked = await tx.deliveryNote.updateMany({
        where: { id, emailState: "SENDING", emailLockAt: now },
        data: {
          emailState: "SENT",
          emailSentAt: new Date(),
          emailId,
          emailLockAt: null,
          emailError: null,
        },
      });
      if (marked.count)
        await tx.deliveryEvent.create({
          data: {
            noteId: id,
            actor: "System",
            kind: "EMAIL_ACCEPTED",
            details: { emailId },
          },
        });
    });
  } catch {
    await db.deliveryNote.updateMany({
      where: { id, emailState: "SENDING", emailLockAt: now },
      data: {
        emailState: "FAILED",
        emailLockAt: null,
        emailError:
          "Email not confirmed. The signed PDF is safely archived. The office can retry within the safe retry window.",
      },
    });
  }
}
