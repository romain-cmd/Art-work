/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from "react";
export function DeliveryShell({ children, mobile = false }) {
  return (
    <main className={`delivery-app${mobile ? " mobile" : ""}`}>
      <header className="delivery-brand">
        <div className="brand-mark">MYW</div>
        <div>
          <strong>MARINA YACHT WEAR</strong>
          <span>Deliveries & proof of receipt</span>
        </div>
      </header>
      {children}
    </main>
  );
}
export function Status({ value }) {
  const labels = {
    READY: "Ready for delivery",
    SIGNED: "Signed",
    VOID: "Cancelled",
    PENDING: "Email pending",
    SENDING: "Email processing",
    SENT: "Email accepted",
    FAILED: "Email needs attention",
    MANUAL_REVIEW: "Email requires manual review",
    NOT_REQUESTED: "Email not requested",
  };
  return (
    <span className={`delivery-status ${value.toLowerCase()}`}>
      {labels[value] || value}
    </span>
  );
}
export function DeliverySummary({ snapshot }) {
  return (
    <section className="delivery-card">
      <div className="delivery-card-heading">
        <div>
          <p className="delivery-eyebrow">DELIVERY NOTE</p>
          <h2>{snapshot.documentNumber}</h2>
        </div>
        <strong>{snapshot.orderName}</strong>
      </div>
      <div className="delivery-columns">
        <div>
          <h3>{snapshot.yachtName || snapshot.customerName}</h3>
          {snapshot.address.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
        <dl>
          <div>
            <dt>Representative</dt>
            <dd>{snapshot.representative.name}</dd>
          </div>
          <div>
            <dt>Scheduled date</dt>
            <dd>{snapshot.scheduledDate || "Not scheduled"}</dd>
          </div>
          <div>
            <dt>Packages</dt>
            <dd>{snapshot.packages || "Not specified"}</dd>
          </div>
        </dl>
      </div>
      <div className="delivery-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Item / variant</th>
              <th>Ordered</th>
              <th>Previously signed</th>
              <th>Delivered now</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.items.map((i) => (
              <tr key={i.lineItemId}>
                <td>
                  <strong>{i.title}</strong>
                  <small>
                    {i.variantTitle}
                    {i.sku ? ` | SKU: ${i.sku}` : ""}
                  </small>
                </td>
                <td>{i.ordered}</td>
                <td>{i.alreadySigned}</td>
                <td>
                  <strong>{i.quantity}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="delivery-total">
        Total delivered on this note{" "}
        <strong>{snapshot.totalQuantity} units</strong>
      </p>
      <p className="delivery-muted">
        Previously signed quantities refer only to notes recorded in this
        application.
      </p>
      {snapshot.instructions && (
        <div className="delivery-callout">
          <strong>Delivery instructions</strong>
          <p>{snapshot.instructions}</p>
        </div>
      )}
    </section>
  );
}
export function SignaturePad() {
  const svg = useRef(null);
  const active = useRef(null);
  const dialog = useRef(null);
  const openButton = useRef(null);
  const draftRef = useRef([]);
  const [draft, setDraft] = useState([]);
  const [saved, setSaved] = useState([]);
  const [open, setOpen] = useState(false);

  function redraw() {
    setDraft(draftRef.current.map((stroke) => [...stroke]));
  }
  function showPad() {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    draftRef.current = saved.map((stroke) => [...stroke]);
    redraw();
    setOpen(true);
  }
  function closePad() {
    active.current = null;
    setOpen(false);
    openButton.current?.focus();
  }
  function confirmPad() {
    const points = draftRef.current.flat();
    const span = (axis) =>
      Math.max(...points.map((p) => p[axis])) -
      Math.min(...points.map((p) => p[axis]));
    if (points.length < 6 || span(0) + span(1) < 0.04) return;
    setSaved(draftRef.current.map((stroke) => [...stroke]));
    closePad();
  }
  useEffect(() => {
    if (!open) return;
    const oldBodyOverflow = document.body.style.overflow;
    const oldHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    dialog.current?.focus();
    const escape = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePad();
      }
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = oldBodyOverflow;
      document.documentElement.style.overflow = oldHtmlOverflow;
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  function point(event) {
    const rect = svg.current.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    ].map((n) => Math.round(n * 10000) / 10000);
  }
  function start(event) {
    if (
      event.isPrimary === false ||
      event.button !== 0 ||
      active.current !== null ||
      draftRef.current.length >= 100
    ) return;
    event.preventDefault();
    active.current = event.pointerId;
    svg.current.setPointerCapture(event.pointerId);
    draftRef.current.push([point(event)]);
    redraw();
  }
  function move(event) {
    if (active.current !== event.pointerId) return;
    event.preventDefault();
    if (draftRef.current.reduce((sum, stroke) => sum + stroke.length, 0) >= 6000)
      return;
    draftRef.current.at(-1).push(point(event));
    redraw();
  }
  function end(event) {
    if (active.current !== event.pointerId) return;
    if (event.type === "pointercancel" || draftRef.current.at(-1).length < 2)
      draftRef.current.pop();
    active.current = null;
    redraw();
  }
  const valid = (() => {
    const points = draft.flat();
    if (points.length < 6) return false;
    const span = (axis) =>
      Math.max(...points.map((p) => p[axis])) -
      Math.min(...points.map((p) => p[axis]));
    return span(0) + span(1) >= 0.04;
  })();
  const drawPaths = (strokes) =>
    strokes.map((stroke, i) => (
      <path
        key={i}
        d={stroke
          .map((p, n) => `${n ? "L" : "M"}${p[0] * 800} ${p[1] * 300}`)
          .join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ));
  return (
    <div className="signature-field">
      <label id="signature-label">
        Recipient signature <span aria-hidden="true">*</span>
      </label>
      <button
        ref={openButton}
        type="button"
        className="delivery-signature-trigger"
        onClick={showPad}
        aria-describedby="signature-label"
      >
        {saved.length ? (
          <svg viewBox="0 0 800 300" preserveAspectRatio="xMidYMid meet"
            className="delivery-signature-preview" aria-label="Saved signature">
            {drawPaths(saved)}
          </svg>
        ) : (
          <span className="delivery-signature-placeholder">
            Tap here to sign in full screen
          </span>
        )}
        <span className="delivery-signature-action">
          {saved.length ? "Edit signature" : "Open signature pad"}
        </span>
      </button>
      <input id="signature-input" type="hidden" name="strokes"
        value={JSON.stringify(saved)} />
      {open && (
        <div className="delivery-signature-overlay" role="presentation">
          <section
            ref={dialog}
            className="delivery-signature-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="signature-dialog-title"
            tabIndex={-1}
          >
            <header className="delivery-signature-header">
              <div>
                <h2 id="signature-dialog-title">Sign for delivery</h2>
                <p>Use your finger or stylus in the white area below.</p>
              </div>
              <button type="button" className="delivery-button secondary compact"
                onClick={closePad}>Cancel</button>
            </header>
            <div className="delivery-signature-canvas">
              <svg ref={svg} viewBox="0 0 800 300" preserveAspectRatio="none"
                role="img" aria-label="Draw your signature here"
                className="signature-pad delivery-signature-fullpad"
                onPointerDown={start} onPointerMove={move}
                onPointerUp={end} onPointerCancel={end}>
                {drawPaths(draft)}
              </svg>
            </div>
            <footer className="delivery-signature-footer">
              <button type="button" className="delivery-button secondary"
                onClick={() => {
                  draftRef.current = [];
                  active.current = null;
                  redraw();
                }}>Clear</button>
              <button type="button" className="delivery-button secondary"
                onClick={closePad}>Cancel</button>
              <button type="button" className="delivery-button"
                disabled={!valid} onClick={confirmPad}>
                Confirm signature
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
export function SignedReceipt({ receipt }) {
  return (
    <section className="delivery-card">
      <p className="delivery-eyebrow">RECEIPT RECORDED</p>
      <h2>Thank you, {receipt.name}</h2>
      <p>
        {receipt.role} |{" "}
        {receipt.signedAt.replace("T", " ").replace("Z", " UTC")}
      </p>
      <div className="delivery-callout">
        <strong>Reservations</strong>
        <p>{receipt.reservations || "No reservations recorded."}</p>
      </div>
      <p>{receipt.statement}</p>
      <svg
        viewBox="0 0 800 300"
        role="img"
        aria-label="Recorded recipient signature"
        className="recorded-signature"
      >
        {receipt.strokes.map((s, i) => (
          <path
            key={i}
            d={s
              .map((p, n) => `${n ? "L" : "M"}${p[0] * 800} ${p[1] * 300}`)
              .join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        ))}
      </svg>
    </section>
  );
}
