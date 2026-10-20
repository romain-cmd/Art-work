import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import Artwork from "../../app/routes/app.personnalisation.jsx";
import Production from "../../app/routes/app.kanban.jsx";
import Review from "../../app/routes/proof-review.jsx";

const loader = async ({ request }) => (await fetch(`/test/data?path=${encodeURIComponent(new URL(request.url).pathname + new URL(request.url).search)}`)).json();
const action = async ({ request }) => (await fetch(`/test/action?path=${encodeURIComponent(new URL(request.url).pathname)}`, { method: "POST", body: await request.formData() })).json();
const router = createBrowserRouter([
  { path: "/app/personnalisation", Component: Artwork, loader, action },
  { path: "/app/kanban", Component: Production, loader, action },
  { path: "/proof-review", Component: Review, loader, action },
]);
createRoot(document.getElementById("root")).render(<RouterProvider router={router}/>);
