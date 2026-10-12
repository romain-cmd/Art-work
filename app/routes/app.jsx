import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};
export default function App() {
  const { apiKey } = useLoaderData();
  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app/personnalisation">Artworks</s-link>
        <s-link href="/app/kanban">Production</s-link>
        <s-link href="/app/deliveries">Deliveries</s-link>
        <s-link href="/app/reglages">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}
export function ErrorBoundary() { return boundary.error(useRouteError()); }
export const headers = (headersArgs) => boundary.headers(headersArgs);
