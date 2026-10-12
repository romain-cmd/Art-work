import { randomUUID } from "node:crypto";
import { useEffect, useRef } from "react";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
} from "react-router";
import db from "../db.server.js";
import { authenticate } from "../shopify.server.js";
import {
  createRepresentative,
  deliveryForm,
  PRIVATE_HEADERS,
  updateRepresentative,
} from "../lib/delivery-access.server.js";
import {
  availableItems,
  DeliveryError,
  orderHash,
  text,
} from "../lib/delivery-core.server.js";
import {
  createDeliveryNote,
  deliveryDocument,
  noteView,
  voidDeliveryNote,
} from "../lib/delivery-notes.server.js";
import { sendDeliveryEmail } from "../lib/delivery-email.server.js";
import {
  loadDeliveryOrder,
  searchDeliveryOrders,
} from "../lib/delivery-shopify.server.js";
import {
  DeliveryShell,
  DeliverySummary,
  SignedReceipt,
  Status,
} from "../components/DeliveryUI.jsx";
import styles from "../styles/deliveries.css?url";
export const links = () => [{ rel: "stylesheet", href: styles }];
export const headers = () => PRIVATE_HEADERS;
export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url),
    shop = session.shop;
  const view = url.searchParams.get("view") || "notes";
  const reps = await db.deliveryRepresentative.findMany({
    where: { shop },
    select: { id: true, name: true, email: true, isActive: true },
    orderBy: { name: "asc" },
    take: 200,
  });
  const result = { view, reps, shop, createKey: randomUUID() };
  const noteId = url.searchParams.get("note"),
    orderId = url.searchParams.get("order");
  if (noteId) {
    const note = await db.deliveryNote.findFirst({
      where: { id: noteId, shop },
      include: { events: { orderBy: { createdAt: "desc" }, take: 30 } },
    });
    if (!note) throw new Response("Delivery note not found.", { status: 404 });
    result.note = noteView(note);
  } else if (orderId) {
    const order = await loadDeliveryOrder(admin, orderId);
    const notes = await db.deliveryNote.findMany({
      where: { shop, orderId, status: { in: ["READY", "SIGNED"] } },
    });
    result.order = order;
    result.sourceHash = orderHash(order);
    result.items = availableItems(order, notes);
  } else if (view === "orders") {
    result.q = text(url.searchParams.get("q"), 200);
    result.orders = await searchDeliveryOrders(
      admin,
      result.q,
      url.searchParams.get("after"),
    );
  } else if (view === "notes") {
    const page = Math.floor(
      Math.max(0, Math.min(1000, Number(url.searchParams.get("page")) || 0)),
    );
    result.q = text(url.searchParams.get("q"), 120);
    result.page = page;
    const notes = await db.deliveryNote.findMany({
      where: {
        shop,
        ...(result.q
          ? { searchText: { contains: result.q.toLowerCase() } }
          : {}),
      },
      select: { id: true, snapshot: true, status: true, emailState: true },
      orderBy: { createdAt: "desc" },
      take: 51,
      skip: page * 50,
    });
    result.notes = notes.slice(0, 50);
    result.hasNext = notes.length > 50;
  }
  return data(result, { headers: PRIVATE_HEADERS });
}
export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  try {
    const form = await deliveryForm(request),
      intent = form.get("intent");
    if (intent === "representative")
      return data(
        {
          credentials: await createRepresentative(db, shop, {
            name: form.get("name"),
            email: form.get("email"),
          }),
        },
        { headers: PRIVATE_HEADERS },
      );
    if (intent === "rotate" || intent === "disable")
      return data(
        {
          credentials: await updateRepresentative(
            db,
            shop,
            form.get("representativeId"),
            intent === "rotate",
          ),
          message:
            intent === "rotate"
              ? "New access details created. Previous links and sessions are revoked."
              : "Representative access revoked.",
        },
        { headers: PRIVATE_HEADERS },
      );
    if (intent === "create") {
      const quantities = Object.fromEntries(
        [...form.entries()]
          .filter(([key]) => key.startsWith("quantity:"))
          .map(([key, value]) => [key.slice(9), value]),
      );
      const note = await createDeliveryNote(
        db,
        admin,
        shop,
        "Shopify administrator",
        {
          createKey: form.get("createKey"),
          sourceHash: form.get("sourceHash"),
          orderId: form.get("orderId"),
          representativeId: form.get("representativeId"),
          yachtName: form.get("yachtName"),
          packages: form.get("packages"),
          scheduledDate: form.get("scheduledDate"),
          instructions: form.get("instructions"),
          quantities,
        },
      );
      return redirect(`/app/deliveries?note=${note.id}`);
    }
    if (intent === "void") {
      await voidDeliveryNote(
        db,
        shop,
        form.get("noteId"),
        "Shopify administrator",
        form.get("reason"),
      );
      return redirect(
        `/app/deliveries?note=${encodeURIComponent(form.get("noteId"))}`,
      );
    }
    if (intent === "download") {
      const file = await deliveryDocument(db, shop, form.get("noteId"));
      return data(
        { filename: file.filename, pdfBase64: file.pdf.toString("base64") },
        { headers: PRIVATE_HEADERS },
      );
    }
    if (intent === "retryEmail") {
      await sendDeliveryEmail(db, shop, form.get("noteId"));
      return data(
        { message: "Email status refreshed. Check the result below." },
        { headers: PRIVATE_HEADERS },
      );
    }
    throw new DeliveryError("Unknown action.");
  } catch (error) {
    if (error instanceof Response) throw error;
    return data(
      {
        error:
          error instanceof DeliveryError
            ? error.message
            : "The action could not be confirmed. Reload the page before trying again.",
      },
      {
        status: error instanceof DeliveryError ? error.status : 500,
        headers: PRIVATE_HEADERS,
      },
    );
  }
}
export default function Deliveries() {
  const view = useLoaderData(),
    result = useActionData(),
    navigation = useNavigation(),
    download = useFetcher();
  const lastDownload = useRef(null),
    busy = navigation.state !== "idle";
  useEffect(() => {
    if (!download.data?.pdfBase64 || lastDownload.current === download.data)
      return;
    lastDownload.current = download.data;
    const bytes = Uint8Array.from(atob(download.data.pdfBase64), (c) =>
      c.charCodeAt(0),
    );
    const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/pdf" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = download.data.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, [download.data]);
  return (
    <DeliveryShell>
      <div className="delivery-toolbar">
        <div>
          <p className="delivery-eyebrow">OPERATIONS</p>
          <h1>Deliveries</h1>
          <p className="delivery-muted">
            Prepare the goods. Record receipt. Keep the signed proof.
          </p>
        </div>
        <div className="delivery-actions">
          <Link className="delivery-button secondary" to="/app/deliveries">
            Delivery notes
          </Link>
          <Link
            className="delivery-button secondary"
            to="/app/deliveries?view=team"
          >
            Representatives
          </Link>
          <Link className="delivery-button" to="/app/deliveries?view=orders">
            Create delivery note
          </Link>
        </div>
      </div>
      {result?.error && (
        <div role="alert" className="delivery-alert error">
          {result.error}
        </div>
      )}
      {result?.message && (
        <div role="status" className="delivery-alert success">
          {result.message}
        </div>
      )}
      {download.data?.error && (
        <div role="alert" className="delivery-alert error">
          {download.data.error}
        </div>
      )}
      {result?.credentials && (
        <section className="delivery-card">
          <h2>Private representative access</h2>
          <p>
            Copy these details now. The code is not stored in readable form and
            will not be shown again. Send the link and the code separately,
            directly to the representative.
          </p>
          <label>
            Mobile access link
            <input
              readOnly
              value={result.credentials.link}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <label>
            Eight-digit access code
            <input
              readOnly
              value={result.credentials.pin}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <p className="delivery-muted">
            Access is limited to this representative's assigned delivery notes.
            Regenerating access revokes previous links and signed-in sessions.
          </p>
        </section>
      )}
      {view.note ? (
        <>
          <div className="delivery-toolbar">
            <Status value={view.note.status} />
            <div className="delivery-actions">
              <a
                className="delivery-button secondary"
                target="_top"
                href={`https://${view.shop}/admin/orders/${view.note.snapshot.orderId.split("/").pop()}`}
              >
                Open Shopify order
              </a>
              {view.note.status === "SIGNED" && (
                <download.Form method="post">
                  <input type="hidden" name="intent" value="download" />
                  <input type="hidden" name="noteId" value={view.note.id} />
                  <button
                    className="delivery-button"
                    disabled={download.state !== "idle"}
                  >
                    {download.state !== "idle"
                      ? "Preparing PDF..."
                      : "Download signed PDF"}
                  </button>
                </download.Form>
              )}
            </div>
          </div>
          <DeliverySummary snapshot={view.note.snapshot} />
          {view.note.receipt && <SignedReceipt receipt={view.note.receipt} />}
          {view.note.status === "SIGNED" && (
            <section className="delivery-card">
              <div className="delivery-card-heading">
                <h2>Customer copy</h2>
                <Status value={view.note.emailState} />
              </div>
              <p>{view.note.emailTo || "No email copy requested."}</p>
              {view.note.emailError && (
                <div className="delivery-alert">{view.note.emailError}</div>
              )}
              {["PENDING", "SENDING", "FAILED"].includes(
                view.note.emailState,
              ) && (
                <Form method="post">
                  <input type="hidden" name="intent" value="retryEmail" />
                  <input type="hidden" name="noteId" value={view.note.id} />
                  <button className="delivery-button secondary" disabled={busy}>
                    Retry pending email
                  </button>
                </Form>
              )}
              <p className="delivery-muted">
                Email accepted means the provider accepted the message, not that
                it was read. An interrupted attempt older than the safe retry
                window requires a provider check before any manual resend.
              </p>
              <p>
                <strong>Evidence SHA-256</strong>
                <br />
                <code>{view.note.proofHash}</code>
              </p>
            </section>
          )}
          {view.note.status === "READY" && (
            <section className="delivery-card">
              <h2>Ready for {view.note.snapshot.representative.name}</h2>
              <p>
                This note is now available in the representative's mobile
                portal. The recipient must review the quantities before signing.
              </p>
              <div className="delivery-callout">
                A note is a fixed preparation snapshot. If the Shopify order or
                the actual delivery changes, cancel this unsigned note and
                prepare a replacement. Signed documents are never rewritten.
              </div>
              <details>
                <summary>Cancel this unsigned note</summary>
                <Form method="post">
                  <input type="hidden" name="intent" value="void" />
                  <input type="hidden" name="noteId" value={view.note.id} />
                  <label>
                    Reason
                    <textarea name="reason" maxLength={500} required />
                  </label>
                  <p>
                    <button className="delivery-button danger" disabled={busy}>
                      Cancel unsigned note
                    </button>
                  </p>
                </Form>
              </details>
            </section>
          )}
          <section className="delivery-card">
            <h2>Activity</h2>
            {view.note.events.map((event, i) => (
              <p key={i}>
                <strong>{event.kind.replaceAll("_", " ")}</strong> |{" "}
                {event.actor}
                <small>
                  {new Date(event.createdAt)
                    .toISOString()
                    .replace("T", " ")
                    .replace("Z", " UTC")}
                  {event.details?.reason ? ` | ${event.details.reason}` : ""}
                </small>
              </p>
            ))}
          </section>
        </>
      ) : view.order ? (
        <section className="delivery-card">
          <p className="delivery-eyebrow">NEW DELIVERY NOTE</p>
          <h2>
            {view.order.name} |{" "}
            {view.order.yachtName || view.order.customerName}
          </h2>
          <p>
            Set the quantities physically being handed over. Items on other
            unsigned notes are reserved and cannot be allocated twice.
          </p>
          {view.order.cancelledAt && (
            <div className="delivery-alert error">
              This order has been cancelled in Shopify.
            </div>
          )}
          {!view.reps.some((r) => r.isActive) && (
            <div className="delivery-alert">
              Create a representative in the Representatives tab before
              preparing a delivery.
            </div>
          )}
          <Form method="post">
            <input type="hidden" name="intent" value="create" />
            <input type="hidden" name="createKey" value={view.createKey} />
            <input type="hidden" name="orderId" value={view.order.id} />
            <input type="hidden" name="sourceHash" value={view.sourceHash} />
            <div className="delivery-fields">
              <label>
                Yacht / company
                <input
                  name="yachtName"
                  maxLength={200}
                  defaultValue={view.order.yachtName}
                />
              </label>
              <label>
                Assigned representative *
                <select name="representativeId" required defaultValue="">
                  <option value="" disabled>
                    Select a representative
                  </option>
                  {view.reps
                    .filter((r) => r.isActive)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Scheduled delivery date
                <input type="date" name="scheduledDate" />
              </label>
              <label>
                Number of packages
                <input
                  type="number"
                  name="packages"
                  min={0}
                  max={9999}
                  defaultValue={0}
                />
              </label>
            </div>
            <div className="delivery-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Item / variant</th>
                    <th>Ordered</th>
                    <th>Signed</th>
                    <th>Reserved</th>
                    <th>Deliver now</th>
                  </tr>
                </thead>
                <tbody>
                  {view.items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <strong>{i.title}</strong>
                        <small>
                          {i.variantTitle}
                          {i.sku ? ` | ${i.sku}` : ""}
                        </small>
                      </td>
                      <td>{i.quantity}</td>
                      <td>{i.signed}</td>
                      <td>{i.reserved}</td>
                      <td>
                        <input
                          aria-label={`Quantity to deliver: ${i.title} ${i.variantTitle}`}
                          name={`quantity:${i.id}`}
                          type="number"
                          min={0}
                          max={i.available}
                          step={1}
                          defaultValue={0}
                          disabled={!i.available}
                        />
                        <small>{i.available} available</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="delivery-muted">
              Quantities start at zero to prevent accidentally including items
              that are not being delivered. Historical deliveries outside this
              module are not automatically deducted.
            </p>
            <label>
              Delivery instructions
              <textarea name="instructions" maxLength={1000} />
            </label>
            <p>
              <button
                className="delivery-button"
                disabled={
                  busy ||
                  Boolean(view.order.cancelledAt) ||
                  !view.reps.some((r) => r.isActive)
                }
              >
                {busy ? "Checking Shopify..." : "Create & assign delivery note"}
              </button>
            </p>
          </Form>
        </section>
      ) : view.view === "team" ? (
        <>
          <section className="delivery-card">
            <h2>Add a representative</h2>
            <Form method="post">
              <input type="hidden" name="intent" value="representative" />
              <div className="delivery-fields">
                <label>
                  Full name *<input name="name" maxLength={120} required />
                </label>
                <label>
                  Work email
                  <input name="email" type="email" maxLength={254} />
                </label>
              </div>
              <button className="delivery-button" disabled={busy}>
                Create private mobile access
              </button>
            </Form>
          </section>
          <section className="delivery-card">
            <h2>Representative access</h2>
            <p className="delivery-muted">
              Mobile sessions expire after 12 hours. Disabling access
              immediately revokes active sessions.
            </p>
            {view.reps.map((rep) => (
              <div className="delivery-toolbar" key={rep.id}>
                <div>
                  <strong>{rep.name}</strong>
                  <small>
                    {rep.email || ""} | {rep.isActive ? "Active" : "Disabled"}
                  </small>
                </div>
                <div className="delivery-actions">
                  <Form method="post">
                    <input type="hidden" name="intent" value="rotate" />
                    <input
                      type="hidden"
                      name="representativeId"
                      value={rep.id}
                    />
                    <button
                      className="delivery-button secondary"
                      disabled={busy}
                    >
                      Regenerate access
                    </button>
                  </Form>
                  {rep.isActive && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="disable" />
                      <input
                        type="hidden"
                        name="representativeId"
                        value={rep.id}
                      />
                      <button
                        className="delivery-button danger"
                        disabled={busy}
                      >
                        Disable access
                      </button>
                    </Form>
                  )}
                </div>
              </div>
            ))}
          </section>
        </>
      ) : view.orders ? (
        <>
          <section className="delivery-card">
            <h2>Select a Shopify order</h2>
            <Form method="get" className="delivery-search">
              <input type="hidden" name="view" value="orders" />
              <label>
                Search orders
                <input
                  name="q"
                  defaultValue={view.q}
                  placeholder="Order number, customer or email"
                  maxLength={200}
                />
              </label>
              <button className="delivery-button secondary">Search</button>
            </Form>
            <p className="delivery-muted">
              Orders are loaded directly from Shopify. Older orders may require
              additional read_all_orders approval.
            </p>
            <div className="delivery-list">
              {view.orders.nodes.map((order) => (
                <Link
                  key={order.id}
                  to={`/app/deliveries?order=${encodeURIComponent(order.id)}`}
                >
                  <div className="delivery-card-heading">
                    <div>
                      <strong>{order.name}</strong>
                      <h3>
                        {order.shippingAddress?.company ||
                          order.shippingAddress?.name ||
                          "Customer"}
                      </h3>
                    </div>
                    <small>
                      {order.displayFulfillmentStatus.replaceAll("_", " ")}
                    </small>
                  </div>
                </Link>
              ))}
            </div>
            {!view.orders.nodes.length && <p>No matching orders found.</p>}
            {view.orders.pageInfo.hasNextPage && (
              <Link
                className="delivery-button secondary"
                to={`/app/deliveries?view=orders&q=${encodeURIComponent(view.q)}&after=${encodeURIComponent(view.orders.pageInfo.endCursor)}`}
              >
                Next orders
              </Link>
            )}
          </section>
        </>
      ) : (
        <>
          <Form method="get" className="delivery-search">
            <label>
              Find a delivery note
              <input
                name="q"
                defaultValue={view.q}
                maxLength={120}
                placeholder="Yacht, customer or order number"
              />
            </label>
            <button className="delivery-button secondary">Search</button>
          </Form>
          <div className="delivery-list">
            {view.notes?.map((note) => (
              <Link key={note.id} to={`/app/deliveries?note=${note.id}`}>
                <div className="delivery-card-heading">
                  <div>
                    <p className="delivery-eyebrow">
                      {note.snapshot.documentNumber} | {note.snapshot.orderName}
                    </p>
                    <h3>
                      {note.snapshot.yachtName || note.snapshot.customerName}
                    </h3>
                    <small>
                      {note.snapshot.representative.name} |{" "}
                      {note.snapshot.totalQuantity} units |{" "}
                      {note.snapshot.scheduledDate || "Not scheduled"}
                    </small>
                  </div>
                  <div>
                    <Status value={note.status} />
                    {note.status === "SIGNED" && (
                      <p>
                        <Status value={note.emailState} />
                      </p>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
          {!view.notes?.length && (
            <div className="delivery-card delivery-empty">
              <h2>No delivery notes yet</h2>
              <p>
                Create representative access, then choose a Shopify order to
                prepare your first delivery.
              </p>
            </div>
          )}
          <div className="delivery-actions">
            {view.page > 0 && (
              <Link
                className="delivery-button secondary"
                to={`/app/deliveries?page=${view.page - 1}&q=${encodeURIComponent(view.q)}`}
              >
                Previous
              </Link>
            )}
            {view.hasNext && (
              <Link
                className="delivery-button secondary"
                to={`/app/deliveries?page=${view.page + 1}&q=${encodeURIComponent(view.q)}`}
              >
                Next
              </Link>
            )}
          </div>
        </>
      )}
      <p className="delivery-bottom-note">
        This module records proof of receipt. It does not mark Shopify orders as
        paid or create, cancel or duplicate fulfillments.
      </p>
    </DeliveryShell>
  );
}
