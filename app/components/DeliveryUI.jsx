/* eslint-disable react/prop-types */
import { useRef, useState } from "react";
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
  const svg = useRef(null),
    paths = useRef([]),
    active = useRef(null);
  const [strokes, setStrokes] = useState([]);
  function point(event) {
    const rect = svg.current.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    ].map((n) => Math.round(n * 10000) / 10000);
  }
  function refresh() {
    setStrokes(paths.current.map((stroke) => [...stroke]));
  }
  function start(event) {
    if (
      event.isPrimary === false ||
      event.button !== 0 ||
      active.current !== null ||
      paths.current.length >= 100
    )
      return;
    event.preventDefault();
    active.current = event.pointerId;
    svg.current.setPointerCapture(event.pointerId);
    paths.current.push([point(event)]);
    refresh();
  }
  function move(event) {
    if (
      active.current !== event.pointerId ||
      paths.current.reduce((sum, p) => sum + p.length, 0) >= 6000
    )
      return;
    event.preventDefault();
    paths.current.at(-1).push(point(event));
    refresh();
  }
  function end(event) {
    if (active.current !== event.pointerId) return;
    if (event.type === "pointercancel" || paths.current.at(-1).length < 2)
      paths.current.pop();
    active.current = null;
    refresh();
  }
  return (
    <div className="signature-field">
      <div className="delivery-card-heading">
        <label htmlFor="signature-input">
          Recipient signature <span aria-hidden="true">*</span>
        </label>
        <button
          type="button"
          className="delivery-button secondary compact"
          onClick={() => {
            paths.current = [];
            active.current = null;
            refresh();
          }}
        >
          Clear signature
        </button>
      </div>
      <p id="signature-help" className="delivery-muted">
        Sign with your finger, a stylus or a mouse inside the area below.
      </p>
      <svg
        ref={svg}
        viewBox="0 0 800 300"
        preserveAspectRatio="none"
        role="img"
        aria-label="Handwritten signature area"
        aria-describedby="signature-help"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        className="signature-pad"
      >
        {strokes.map((s, i) => (
          <path
            key={i}
            d={s
              .map((p, n) => `${n ? "L" : "M"}${p[0] * 800} ${p[1] * 300}`)
              .join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
      <input
        id="signature-input"
        type="hidden"
        name="strokes"
        value={JSON.stringify(strokes)}
      />
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
