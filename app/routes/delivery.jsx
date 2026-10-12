import { randomUUID } from 'node:crypto';
import { useEffect, useState } from 'react';
import { data, Form, Link, redirect, useActionData, useLoaderData, useNavigation, useRouteError } from 'react-router';
import db from '../db.server.js';
import { unauthenticated } from '../shopify.server.js';
import { deliveryForm, mobileLogin, mobileLogout, mobileSession, PRIVATE_HEADERS, requireCsrf } from '../lib/delivery-access.server.js';
import { DeliveryError } from '../lib/delivery-core.server.js';
import { RECEIPT_STATEMENT } from '../lib/delivery-shared.js';
import { noteView, signDeliveryNote } from '../lib/delivery-notes.server.js';
import { sendDeliveryEmail } from '../lib/delivery-email.server.js';
import { DeliveryShell, DeliverySummary, SignaturePad, SignedReceipt, Status } from '../components/DeliveryUI.jsx';
import styles from '../styles/deliveries.css?url';
export const links = () => [{ rel: 'stylesheet', href: styles }];
export const headers = () => ({ ...PRIVATE_HEADERS, 'Content-Security-Policy': "frame-ancestors 'none'" });
export const meta = () => [{ title: 'My deliveries | Marina Yacht Wear' }, { name: 'robots', content: 'noindex,nofollow' }];
export async function loader({ request }) {
  const url = new URL(request.url);
  const session = await mobileSession(db, request);
  if (!session) return data({ signedIn: false, access: url.searchParams.get('access') || '' }, { headers: PRIVATE_HEADERS });
  const rep = session.representative;
  const id = url.searchParams.get('note');
  if (id) {
    const note = await db.deliveryNote.findFirst({ where: { id, shop: rep.shop, representativeId: rep.id } });
    if (!note) throw new Response('Delivery note not found.', { status: 404, headers: PRIVATE_HEADERS });
    return data({ signedIn: true, name: rep.name, csrf: session.csrf, note: noteView(note), signatureKey: randomUUID() }, { headers: PRIVATE_HEADERS });
  }
  const page = Math.max(0, Math.min(1000, Number(url.searchParams.get('page')) || 0));
  const q = (url.searchParams.get('q') || '').slice(0, 120);
  const notes = await db.deliveryNote.findMany({ where: { shop: rep.shop, representativeId: rep.id, status: { not: 'VOID' }, ...(q ? { searchText: { contains: q.toLowerCase() } } : {}) }, orderBy: { createdAt: 'desc' }, take: 31, skip: Math.floor(page) * 30, select: { id: true, snapshot: true, status: true, emailState: true } });
  return data({ signedIn: true, name: rep.name, csrf: session.csrf, notes: notes.slice(0, 30), hasNext: notes.length > 30, page: Math.floor(page), q }, { headers: PRIVATE_HEADERS });
}
export async function action({ request }) {
  try {
    const form = await deliveryForm(request);
    if (form.get('intent') === 'login') {
      const cookie = await mobileLogin(db, form.get('access'), form.get('pin'));
      return redirect('/delivery', { headers: { ...PRIVATE_HEADERS, 'Set-Cookie': cookie } });
    }
    const session = await mobileSession(db, request);
    requireCsrf(session, form.get('csrf'));
    if (form.get('intent') === 'logout') return redirect('/delivery', { headers: { ...PRIVATE_HEADERS, 'Set-Cookie': await mobileLogout(db, session) } });
    if (form.get('intent') !== 'sign') throw new DeliveryError('Unknown action.');
    let strokes;
    try { strokes = JSON.parse(form.get('strokes') || '[]'); } catch { throw new DeliveryError('Invalid signature. Please sign again.'); }
    const { admin } = await unauthenticated.admin(session.representative.shop);
    const note = await signDeliveryNote(db, admin, session, form.get('noteId'), { signatureKey: form.get('signatureKey'), revision: form.get('revision'), name: form.get('name'), role: form.get('role'), reservations: form.get('reservations'), agreed: form.get('agreed'), sendEmail: form.get('sendEmail'), emailTo: form.get('emailTo'), strokes });
    try { await sendDeliveryEmail(db, session.representative.shop, note.id); } catch { /* The signed document remains committed even if email is unavailable. */ }
    return redirect(`/delivery?note=${encodeURIComponent(note.id)}`, { headers: PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof Response) throw error;
    return data({ error: error instanceof DeliveryError ? error.message : 'Unable to confirm the result. Reload this delivery note before trying again. A signature may already have been recorded.' }, { status: error instanceof DeliveryError ? error.status : 500, headers: PRIVATE_HEADERS });
  }
}
export default function MobileDeliveries() {
  const view = useLoaderData(), result = useActionData(), navigation = useNavigation();
  const [online, setOnline] = useState(true);
  const busy = navigation.state !== 'idle';
  useEffect(() => { const update = () => setOnline(navigator.onLine); update(); window.addEventListener('online', update); window.addEventListener('offline', update); return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); }; }, []);
  return <DeliveryShell mobile>{!view.signedIn ? <section className="delivery-card delivery-login"><p className="delivery-eyebrow">REPRESENTATIVE ACCESS</p><h1>Your deliveries, on board.</h1><p className="delivery-muted">Use the private access link and eight-digit code provided by your office.</p>{result?.error && <div role="alert" className="delivery-alert error">{result.error}</div>}<Form method="post"><input type="hidden" name="intent" value="login" />{view.access ? <input name="access" type="hidden" value={view.access} /> : <label>Private access token<input name="access" defaultValue="" required autoComplete="off" maxLength={64} /></label>}<label>Access code<input name="pin" inputMode="numeric" type="password" pattern="[0-9]{8}" minLength={8} maxLength={8} autoComplete="current-password" required /></label><p><button className="delivery-button delivery-submit" disabled={busy || !online}>{busy ? 'Signing in...' : 'Open my deliveries'}</button></p></Form></section> : <><div className="delivery-toolbar"><div><p className="delivery-eyebrow">{view.name}</p><h1>{view.note ? 'Delivery receipt' : 'My deliveries'}</h1></div><Form method="post"><input type="hidden" name="intent" value="logout" /><input type="hidden" name="csrf" value={view.csrf} /><button className="delivery-button secondary compact" disabled={busy}>Sign out</button></Form></div>{!online && <div role="alert" className="delivery-alert">You are offline. An internet connection is required to record a signature. Do not close this page until the signed receipt appears.</div>}{result?.error && <div role="alert" className="delivery-alert error">{result.error}</div>}{view.note ? <><Link to="/delivery">Back to my deliveries</Link><div className="delivery-toolbar"><Status value={view.note.status} />{view.note.status === 'SIGNED' && <a className="delivery-button" href={`/delivery/pdf?note=${view.note.id}`} download>Download signed PDF</a>}</div><DeliverySummary snapshot={view.note.snapshot} />{view.note.status === 'SIGNED' ? <><SignedReceipt receipt={view.note.receipt} /><div className="delivery-card"><Status value={view.note.emailState} /><p className="delivery-muted">The signed PDF is archived. Email status refers to provider acceptance, not confirmation that the recipient has read it.</p>{view.note.emailError && <p>{view.note.emailError}</p>}</div></> : view.note.status === 'VOID' ? <div className="delivery-alert">This unsigned delivery note has been cancelled. Contact the office for its replacement.</div> : <section className="delivery-card"><p className="delivery-eyebrow">HAND THE DEVICE TO THE RECIPIENT</p><h2>Check the items, then sign.</h2><p>Only the quantities shown under <strong>Delivered now</strong> are covered by this signature. If they are incorrect, stop and ask the office to replace this unsigned note.</p><Form method="post"><input type="hidden" name="intent" value="sign" /><input type="hidden" name="csrf" value={view.csrf} /><input type="hidden" name="noteId" value={view.note.id} /><input type="hidden" name="revision" value={view.note.revision} /><input type="hidden" name="signatureKey" value={view.signatureKey} /><div className="delivery-fields"><label>Recipient full name *<input name="name" maxLength={120} autoComplete="off" required /></label><label>Role / position *<input name="role" maxLength={120} placeholder="e.g. Chief Stewardess" autoComplete="off" required /></label></div><label>Reservations or comments<textarea name="reservations" maxLength={2000} placeholder="Record shortages, damage or other observations here." /></label><SignaturePad /><label className="delivery-check"><input type="checkbox" name="agreed" value="yes" required /><span>{RECEIPT_STATEMENT}</span></label><label>Send a copy to<input name="emailTo" type="email" maxLength={254} defaultValue={view.note.emailTo} autoComplete="off" /></label><label className="delivery-check"><input type="checkbox" name="sendEmail" value="yes" defaultChecked={Boolean(view.note.emailTo)} /><span>Email the signed PDF to the address above. Please verify this address before confirming.</span></label><button className="delivery-button delivery-submit" disabled={busy || !online}>{busy ? 'Verifying and recording receipt...' : 'Confirm receipt & save signature'}</button><p className="delivery-bottom-note">The order will be checked against Shopify before recording. A signed note cannot be edited. This action does not confirm payment.</p></Form></section>}</> : <><Form method="get" className="delivery-search"><label>Find a delivery<input name="q" defaultValue={view.q} placeholder="Yacht, customer or order number" /></label><button className="delivery-button secondary">Search</button></Form><div className="delivery-list">{view.notes.map(note => <Link key={note.id} to={`/delivery?note=${note.id}`}><div className="delivery-card-heading"><div><p className="delivery-eyebrow">{note.snapshot.orderName} | {note.snapshot.documentNumber}</p><h3>{note.snapshot.yachtName || note.snapshot.customerName}</h3><small>{note.snapshot.totalQuantity} units | {note.snapshot.scheduledDate || 'Date not scheduled'}</small></div><Status value={note.status} /></div></Link>)}</div>{!view.notes.length && <div className="delivery-card delivery-empty">No deliveries found. The office can assign a delivery note to you from Shopify.</div>}<div className="delivery-actions">{view.page > 0 && <Link className="delivery-button secondary" to={`/delivery?page=${view.page - 1}&q=${encodeURIComponent(view.q)}`}>Previous</Link>}{view.hasNext && <Link className="delivery-button secondary" to={`/delivery?page=${view.page + 1}&q=${encodeURIComponent(view.q)}`}>Next</Link>}</div></>}</>}</DeliveryShell>;
}
export function ErrorBoundary() {
  const error = useRouteError();
  return <DeliveryShell mobile><div className="delivery-alert error"><h1>Unable to open this delivery</h1><p>{error?.status === 404 ? 'This delivery is not available to your account.' : 'Please reconnect and reload the page. Do not assume a signature was saved until the signed receipt appears.'}</p><a href="/delivery">Return to my deliveries</a></div></DeliveryShell>;
}
