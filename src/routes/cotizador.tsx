import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/cotizador")({
  component: () => <Navigate to="/purchases" search={{ tab: "new" }} />,
});
