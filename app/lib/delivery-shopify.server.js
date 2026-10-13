import { DeliveryError, normalizeOrder } from "./delivery-core.server.js";
const ORDER = `#graphql
query DeliveryOrder($id: ID!, $after: String) {
  order(id: $id) {
    id name updatedAt cancelledAt email
    customAttributes { key value }
    shippingAddress { name company address1 address2 city zip province country }
    lineItems(first: 100, after: $after) {
      nodes { id title variantTitle sku currentQuantity requiresShipping }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
export async function loadDeliveryOrder(admin, id) {
  if (!/^gid:\/\/shopify\/Order\/\d+$/.test(id || ""))
    throw new DeliveryError("Select a valid Shopify order.");
  let after = null,
    order = null;
  for (let page = 0; page < 20; page++) {
    const response = await admin.graphql(ORDER, { variables: { id, after } });
    const json = await response.json();
    if (json.errors?.length)
      throw new DeliveryError(
        "Shopify could not provide the order. Check order and customer-data permissions, then retry.",
        502,
      );
    const current = json.data?.order;
    if (!current)
      throw new DeliveryError(
        "Order unavailable. Older orders may require read_all_orders permission.",
        404,
      );
    if (!order) order = { ...current, lineItems: { nodes: [] } };
    if (order.updatedAt !== current.updatedAt)
      throw new DeliveryError(
        "The order changed while loading. Please retry.",
        409,
      );
    order.lineItems.nodes.push(...current.lineItems.nodes);
    if (!current.lineItems.pageInfo.hasNextPage) return normalizeOrder(order);
    after = current.lineItems.pageInfo.endCursor;
  }
  throw new DeliveryError(
    "This order is too large to process safely. Contact the office.",
    422,
  );
}
export async function searchDeliveryOrders(admin, query = "", after = null) {
  const response = await admin.graphql(
    `#graphql
    query DeliveryOrders($query: String, $after: String) {
      orders(first: 30, sortKey: UPDATED_AT, reverse: true, query: $query, after: $after) {
        nodes { id name createdAt displayFulfillmentStatus shippingAddress { name company } }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { variables: { query: query.slice(0, 200) || null, after } },
  );
  const json = await response.json();
  if (json.errors?.length)
    throw new DeliveryError(
      "Unable to load Shopify orders. Check app permissions and retry.",
      502,
    );
  return json.data.orders;
}
