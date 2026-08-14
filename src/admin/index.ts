import { getAdminCredentials, isAdminEnabled } from "./auth";
import { startAdminServer } from "./server";

export function startAdminServerIfEnabled(): void {
  if (!isAdminEnabled()) {
    return;
  }

  const credentials = getAdminCredentials();
  if (!credentials) {
    console.error("ADMIN_ENABLED=true, but ADMIN_USERNAME/ADMIN_PASSWORD is missing; admin ui was not started");
    return;
  }

  startAdminServer(credentials);
}
